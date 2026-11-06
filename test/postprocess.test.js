import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './helpers/env.js';
import sharp from 'sharp';
import { signCosV5, signTc3 } from '../src/tencent-signing.js';
import { detectImage } from '../src/tencent.js';
import { prepareImagePostprocessBody } from '../src/upstream.js';

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('server did not become healthy');
}

function startMocks() {
  const operations = [];
  const objects = new Map();
  let sourceImage = png(1024, 1536);
  let enhancedImage = sourceImage;
  let failCr = false;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.url === '/') return response.end('<html></html>');
    if (request.url === '/sentinel/chat-requirements/prepare') return response.end(JSON.stringify({ prepare_token: 'prepare' }));
    if (request.url === '/sentinel/chat-requirements/finalize') return response.end(JSON.stringify({ token: 'sentinel' }));
    if (request.url === '/f/conversation/prepare') return response.end(JSON.stringify({ conduit_token: 'conduit' }));
    if (request.url === '/f/conversation') {
      response.setHeader('Content-Type', 'text/event-stream');
      return response.end(`data: ${JSON.stringify({ b64_json: sourceImage.toString('base64') })}\n\ndata: [DONE]\n\n`);
    }
    response.writeHead(404).end();
  });
  const tiia = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    operations.push({ service: 'CR', input: Buffer.from(body.ImageBase64, 'base64') });
    if (failCr) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ Response: { Error: { Code: 'FailedOperation.Mock', Message: 'mock failure' }, RequestId: 'cr-request-id' } }));
    }
      response.end(JSON.stringify({ Response: { EnhancedImage: enhancedImage.toString('base64'), RequestId: 'ok' } }));
  });
  const cos = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'PUT') {
      operations.push({ service: 'SR:PUT', input: Buffer.concat(chunks) });
      objects.set(path, Buffer.concat(chunks));
      return response.writeHead(200).end();
    }
    if (request.method === 'GET') {
      const magnify = Number(new URL(request.url, 'http://localhost').searchParams.get('magnify'));
      const { width, height } = detectImage(objects.get(path));
      operations.push({ service: 'SR:GET', input: objects.get(path), magnify });
      return response.writeHead(200, { 'Content-Type': 'image/png' }).end(png(width * magnify, height * magnify));
    }
    if (request.method === 'DELETE') {
      operations.push({ service: 'SR:DELETE' });
      objects.delete(path);
      return response.writeHead(204).end();
    }
    response.writeHead(404).end();
  });
  return {
    upstream, tiia, cos, operations, objects,
    setFailCr(value) { failCr = value; },
    setImages(source, enhanced = source) { sourceImage = source; enhancedImage = enhanced; },
  };
}

async function fixture(t, { credentials = true } = {}) {
  const mocks = startMocks();
  const upstreamPort = await listen(mocks.upstream);
  const tiiaPort = await listen(mocks.tiia);
  const cosPort = await listen(mocks.cos);
  const appPort = await freePort();
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-postprocess-'));
  const project = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: project,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(appPort),
      ADMIN_KEY: 'admin-test-key', API_KEY: 'client-test-key',
      DATA_ENCRYPTION_KEY: '07'.repeat(32), DATA_DIR: directory,
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      ...(credentials ? {
        TENCENTCLOUD_SECRET_ID: 'test-id', TENCENTCLOUD_SECRET_KEY: 'test-key',
        TENCENT_COS_BUCKET: 'test-123456', TENCENT_REGION: 'ap-guangzhou',
        TENCENT_TIIA_BASE_URL: `http://127.0.0.1:${tiiaPort}`,
        TENCENT_COS_BASE_URL: `http://127.0.0.1:${cosPort}`,
      } : {
        TENCENTCLOUD_SECRET_ID: '', TENCENTCLOUD_SECRET_KEY: '', TENCENT_COS_BUCKET: '',
      }),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
    for (const server of [mocks.upstream, mocks.tiia, mocks.cos]) server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${appPort}`;
  await waitFor(`${base}/healthz`, child);
  const account = await fetch(`${base}/api/admin/accounts`, {
    method: 'POST', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'test', token: 'upstream-token' }),
  });
  assert.equal(account.status, 201);
  return { base, mocks };
}

async function generate(base, path, options = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test image', response_format: 'b64_json', ...options }),
  });
}

test('TC3 signer follows the Tencent Cloud v3 request example inputs', () => {
  const authorization = signTc3({
    secretId: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    service: 'cvm', host: 'cvm.tencentcloudapi.com', action: 'DescribeInstances',
    version: '2017-03-12', region: 'ap-guangzhou', timestamp: 1551113065,
    body: '{"Limit":1,"Offset":0}',
  });
  assert.match(authorization, /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[a-f0-9]{64}$/);
  assert.equal(authorization, 'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=154c3c8aca3855a94e37b5953460012f277dc5993fbc62a3b12074f0b63187c6');
  assert.equal(authorization, signTc3({
    secretId: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    service: 'cvm', host: 'cvm.tencentcloudapi.com', action: 'DescribeInstances',
    version: '2017-03-12', region: 'ap-guangzhou', timestamp: 1551113065,
    body: '{"Limit":1,"Offset":0}',
  }));
});

test('COS v5 signer produces a stable signed processing request', () => {
  const authorization = signCosV5({
    method: 'GET', path: '/cmg-tmp/example.png',
    query: new URLSearchParams([['ci-process', 'AISuperResolution'], ['magnify', '2']]),
    host: 'example-1250000000.cos.ap-guangzhou.myqcloud.com',
    secretId: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    now: new Date('2024-01-01T00:00:00.000Z'),
  });
  assert.equal(authorization, signCosV5({
    method: 'GET', path: '/cmg-tmp/example.png',
    query: new URLSearchParams([['ci-process', 'AISuperResolution'], ['magnify', '2']]),
    host: 'example-1250000000.cos.ap-guangzhou.myqcloud.com',
    secretId: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    now: new Date('2024-01-01T00:00:00.000Z'),
  }));
  // Expected value computed with the official cos-nodejs-sdk-v5@2.15.4 COS.getAuthorization (KeyTime 1704067200;1704070800).
  assert.equal(authorization, 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLE&q-sign-time=1704067200;1704070800&q-key-time=1704067200;1704070800&q-header-list=host&q-url-param-list=ci-process;magnify&q-signature=685338f383297c4c6b421b5c1a2271282ce3bc89');
  assert.match(authorization, /q-header-list=host&q-url-param-list=ci-process;magnify&q-signature=[a-f0-9]{40}$/);
});

test('detectImage reads PNG IHDR and JPEG SOF dimensions', () => {
  assert.deepEqual(detectImage(png(1234, 567)), {
    extension: 'png', contentType: 'image/png', width: 1234, height: 567,
  });
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x40, 0x03, 0x20,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  assert.deepEqual(detectImage(jpeg), {
    extension: 'jpg', contentType: 'image/jpeg', width: 800, height: 576,
  });
});

test('detectImage reads WebP VP8X dimensions', () => {
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
  webp.writeUIntLE(319, 24, 3); webp.writeUIntLE(199, 27, 3);
  assert.deepEqual(detectImage(webp), { extension: 'webp', contentType: 'image/webp', width: 320, height: 200 });
});

test('post-processing response format rewrite preserves multipart references', () => {
  const boundary = 'edit-test';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nfix it\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nurl\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`);
  const rewritten = prepareImagePostprocessBody(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(rewritten.outputFormat, 'url');
  assert.match(rewritten.contentType, /multipart\/form-data; boundary=/);
  assert.match(rewritten.body.toString('latin1'), /name="response_format"\r\n\r\nb64_json/);
  assert.match(rewritten.body.toString('latin1'), /filename="ref.png"/);
  assert.match(rewritten.body.toString('latin1'), /\r\n\r\nabc\r\n/);
});

test('image prefix pipeline runs each operation in order and passes output bytes forward', async (t) => {
  const { base, mocks } = await fixture(t);
  const ordinary = await generate(base, '/v1/images/generations');
  assert.equal(ordinary.status, 200);
  assert.equal(mocks.operations.length, 0);

  assert.equal((await generate(base, '/SR/v1/images/generations', { size: '2048x3072' })).status, 200);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['SR:PUT', 'SR:GET', 'SR:DELETE']);
  assert.deepEqual(mocks.operations[0].input, png(1024, 1536));
  mocks.operations.length = 0;

  assert.equal((await generate(base, '/CR/v1/images/generations')).status, 200);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['CR']);
  assert.deepEqual(mocks.operations[0].input, png(1024, 1536));
  mocks.operations.length = 0;

  assert.equal((await generate(base, '/SR/CR/v1/images/generations', { size: '2048x3072' })).status, 200);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['SR:PUT', 'SR:GET', 'SR:DELETE', 'CR']);
  assert.deepEqual(mocks.operations.at(-1).input, png(2048, 3072));
  mocks.operations.length = 0;

  assert.equal((await generate(base, '/CR/SR/v1/images/generations', { size: '2048x3072' })).status, 200);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['CR', 'SR:PUT', 'SR:GET', 'SR:DELETE']);
  assert.deepEqual(mocks.operations[1].input, png(1024, 1536));
  mocks.operations.length = 0;
  assert.equal((await generate(base, '/CR/v1/images/generations', { n: 2 })).status, 200);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['CR', 'CR']);
  const logs = await fetch(`${base}/api/admin/logs`, { headers: { Authorization: 'Bearer admin-test-key' } });
  const routes = (await logs.json()).logs.map((item) => item.route);
  assert.ok(routes.includes('/SR/CR/v1/images/generations'));
  assert.ok(routes.includes('/CR/SR/v1/images/generations'));
});

test('SR chooses magnification from target and skips native-sized outputs', async (t) => {
  const { base, mocks } = await fixture(t);
  const cases = [
    { size: '1024x1536', source: [1024, 1536], expected: [] },
    { size: '1792x1024', source: [1672, 941], expected: [] },
    { size: '2048x3072', source: [1024, 1536], expected: ['SR:PUT', 'SR:GET', 'SR:DELETE'] },
    { size: '4096x4096', source: [1024, 1024], expected: ['SR:PUT', 'SR:GET', 'SR:DELETE'] },
    { size: undefined, source: [1024, 1536], expected: [] },
    { size: '16:9', source: [1024, 1536], expected: [] },
  ];
  for (const item of cases) {
    mocks.setImages(png(...item.source));
    const options = item.size === undefined ? {} : { size: item.size };
    assert.equal((await generate(base, '/SR/v1/images/generations', options)).status, 200);
    assert.deepEqual(mocks.operations.map((operation) => operation.service), item.expected);
    if (item.expected.length) {
      assert.equal(mocks.operations.find((operation) => operation.service === 'SR:GET').magnify,
        item.size === '4096x4096' ? 4 : 2);
    }
    mocks.operations.length = 0;
  }
});

test('pixel targets downscale near-matching originals before SR/CR and localize resized URLs', async (t) => {
  const { base, mocks } = await fixture(t);
  const image = async (width, height) => sharp({ create: { width, height, channels: 3, background: '#2480c0' } }).png().toBuffer();
  const cases = [
    { width: 1792, height: 1024, size: '1280x720', expected: [1280, 720] },
    { width: 1024, height: 1536, size: '512x768', expected: [512, 768] },
    { width: 1672, height: 941, size: '1280x720', expected: [1280, 720] },
    { width: 1024, height: 1024, size: '800x600', expected: [1024, 1024] },
    { width: 1024, height: 1536, size: '2048x3072', expected: [1024, 1536] },
    { width: 1024, height: 1024, size: '1024x1024', expected: [1024, 1024] },
  ];
  for (const item of cases) {
    mocks.setImages(await image(item.width, item.height));
    const route = item === cases[0] ? '/SR/v1/images/generations' : '/v1/images/generations';
    const response = await generate(base, route, { size: item.size });
    assert.equal(response.status, 200);
    const bytes = Buffer.from((await response.json()).data[0].b64_json, 'base64');
    const dimensions = await sharp(bytes).metadata();
    assert.deepEqual([dimensions.width, dimensions.height], item.expected);
    assert.equal(mocks.operations.some((operation) => operation.service === 'SR:GET'), false);
    mocks.operations.length = 0;
  }

  const source = await image(1792, 1024);
  mocks.setImages(source);
  const ordinary = await generate(base, '/v1/images/generations', { size: '1280x720' });
  const ordinaryMeta = await sharp(Buffer.from((await ordinary.json()).data[0].b64_json, 'base64')).metadata();
  assert.deepEqual([ordinaryMeta.width, ordinaryMeta.height], [1280, 720]);
  mocks.operations.length = 0;
  mocks.setImages(source);
  const cr = await generate(base, '/CR/v1/images/generations', { size: '1280x720' });
  assert.equal(cr.status, 200);
  const crInput = mocks.operations.find((operation) => operation.service === 'CR').input;
  const crInputMeta = await sharp(crInput).metadata();
  assert.deepEqual([crInputMeta.width, crInputMeta.height], [1280, 720]);
  mocks.operations.length = 0;

  const urlResponse = await generate(base, '/v1/images/generations', { size: '1280x720', response_format: 'url' });
  const url = (await urlResponse.json()).data[0].url;
  assert.match(url, /\/files\/[0-9a-f-]+\.png$/);
  const downloaded = await fetch(url);
  const downloadedMeta = await sharp(Buffer.from(await downloaded.arrayBuffer())).metadata();
  assert.deepEqual([downloadedMeta.width, downloadedMeta.height], [1280, 720]);

});

test('repeated SR recomputes target ratio and CR output size drives SR decision', async (t) => {
  const { base, mocks } = await fixture(t);
  mocks.setImages(png(1024, 1024));
  assert.equal((await generate(base, '/SR/SR/v1/images/generations', { size: '2048x2048' })).status, 200);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['SR:PUT', 'SR:GET', 'SR:DELETE']);
  mocks.operations.length = 0;

  mocks.setImages(png(1024, 1536), png(1672, 941));
  assert.equal((await generate(base, '/CR/SR/v1/images/generations', { size: '1792x1024' })).status, 200);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['CR']);
});

test('second-step Tencent error includes step details and SR temporary object is removed', async (t) => {
  const { base, mocks } = await fixture(t);
  mocks.setFailCr(true);
  const response = await generate(base, '/SR/CR/v1/images/generations', { size: '2048x3072' });
  assert.equal(response.status, 502);
  const value = await response.json();
  assert.equal(value.error.type, 'upstream_error');
  assert.match(value.error.message, /CR.*FailedOperation\.Mock.*mock failure.*cr-request-id/);
  assert.deepEqual(mocks.operations.map((item) => item.service), ['SR:PUT', 'SR:GET', 'SR:DELETE', 'CR']);
  assert.equal(mocks.objects.size, 0);
});

test('path limits, strict prefixes, missing credentials, and processed URL files', async (t) => {
  const configured = await fixture(t);
  for (const path of [
    '/SR/CR/SR/CR/SR/v1/images/generations',
    '/CR/CR/CR/CR/SR/v1/images/generations',
  ]) assert.equal((await generate(configured.base, path)).status, 400);
  assert.equal((await generate(configured.base, '/XX/v1/images/generations')).status, 404);
  assert.equal((await generate(configured.base, '/XX/v1')).status, 404);
  assert.equal((await generate(configured.base, '/SR/v1/audio/speech')).status, 404);

  const urlResponse = await generate(configured.base, '/CR/v1/images/generations', { response_format: 'url' });
  const imageUrl = (await urlResponse.json()).data[0].url;
  assert.match(imageUrl, /^http:\/\/127\.0\.0\.1:\d+\/files\/[0-9a-f-]+\.png$/);
  const downloaded = await fetch(imageUrl);
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png(1024, 1536));
  assert.equal((await fetch(`${configured.base}/files/../x`)).status, 404);
  assert.equal((await fetch(`${configured.base}/files/not-a-uuid.png`)).status, 404);

  const unconfigured = await fixture(t, { credentials: false });
  const ordinary = await generate(unconfigured.base, '/v1/images/generations');
  assert.equal(ordinary.status, 200);
  const response = await generate(unconfigured.base, '/SR/v1/images/generations');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.message, 'Tencent Cloud post-processing is not configured');
});
