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
import sharp from 'sharp';

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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

function encodeTurnstileDx(operations, p) {
  const source = Array.from(JSON.stringify(operations));
  const key = Array.from(p);
  const encrypted = source.map((character, index) => String.fromCodePoint(
    character.codePointAt(0) ^ key[index % key.length].codePointAt(0),
  )).join('');
  return Buffer.from(encrypted, 'utf8').toString('base64');
}

test('transcription route authenticates, selects account, forwards audio, and logs result', async (t) => {
  const mockImage = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#2468ac' } }).png().toBuffer();
  const seen = [];
  let forceLogin = false;
  let emptyTurnstile = false;
  let imagePolls = 0;
  let imagePointerScheme = 'file-service';
  let refusalMode = '';
  let inlineImageMode = false;
  let failTranscribeOnce = false;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = { path: request.url, authorization: request.headers.authorization, contentType: request.headers['content-type'], headers: request.headers, body: Buffer.concat(chunks) };
    seen.push(record);
    if (request.url === '/') {
      response.setHeader('Set-Cookie', '__cf_bm=mock-clearance; Path=/; HttpOnly');
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html data-build="c/test/_"><script src="/c/test/_/main.js"></script></html>');
    } else if (request.url === '/transcribe') {
      if (failTranscribeOnce) { failTranscribeOnce = false; response.writeHead(500); return response.end('mock failure'); }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ text: 'recognized words' }));
    } else if (request.url === '/sentinel/chat-requirements/prepare') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (forceLogin) return response.end(JSON.stringify({ force_login: true }));
      const payload = JSON.parse(record.body.toString('utf8'));
      response.end(JSON.stringify({
        prepare_token: 'prepare-token',
        proofofwork: { required: true, seed: 'proof-seed', difficulty: '00' },
        turnstile: { required: true, dx: emptyTurnstile ? encodeTurnstileDx([], payload.p) : encodeTurnstileDx([[2, 30, 'decoy-register-value'], [3, 'challenge-result']], payload.p) },
      }));
    } else if (request.url === '/sentinel/chat-requirements/finalize') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token: 'finalized-sentinel-token', so_token: 'sentinel-so-token' }));
    } else if (request.url === '/conversation' || request.url === '/f/conversation') {
      const isImage = request.url === '/f/conversation';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(isImage
        ? inlineImageMode ? { b64_json: mockImage.toString('base64') }
          : refusalMode === 'sse' ? { message: { author: { role: 'assistant' }, content: { parts: ['抱歉，我不能生成这类图片，因为违反了内容政策'] } } }
          : refusalMode === 'poll' ? { conversation_id: 'image-conversation' }
            : refusalMode === 'image-and-policy' ? { b64_json: 'aW1hZ2U=', message: { author: { role: 'assistant' }, content: { parts: ['policy check passed with image'] } } }
              : { conversation_id: 'image-conversation', asset_pointer: `${imagePointerScheme}://asset-1` }
        : { conversation_id: 'speech-conversation', message: { id: 'speech-message', author: { role: 'assistant' } } })}\n\ndata: [DONE]\n\n`);
    } else if (request.url === '/f/conversation/prepare') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ conduit_token: 'conduit-token' }));
    } else if (request.url === '/conversation/image-conversation') {
      imagePolls += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (refusalMode === 'poll') return response.end(JSON.stringify({ mapping: { refusal: { message: { author: { role: 'tool' }, content: { parts: ['Image blocked by policy'] } } } } }));
      response.end(JSON.stringify(imagePolls < 2 ? { mapping: {} } : {
        mapping: { generated: { message: { author: { role: 'tool' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: `${imagePointerScheme}://asset-1` }] } } } },
      }));
    } else if (request.url === '/files/download/asset-1') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ download_url: 'https://chatgpt.com/media/signed-image.png' }));
    } else if (request.url === '/media/signed-image.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(mockImage);
    } else if (request.url === '/conversation/image-conversation/attachment/asset-1/download') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ download_url: 'https://chatgpt.com/media/sediment-image.png' }));
    } else if (request.url.startsWith('/synthesize?')) {
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.end('audio-stream');
    } else {
      response.writeHead(404);
      response.end('not found');
    }
  });
  const upstreamPort = await listen(upstream);
  const appPort = await freePort();
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-server-'));
  const project = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: project,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(appPort),
      ADMIN_KEY: 'admin-test-key', API_KEY: 'client-test-key',
      DATA_ENCRYPTION_KEY: '07'.repeat(32), DATA_DIR: directory,
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
    upstream.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${appPort}`;
  await waitFor(`${base}/healthz`, child);
  const deniedAdmin = await fetch(`${base}/api/admin/summary`);
  assert.equal(deniedAdmin.status, 401);
  const addResponse = await fetch(`${base}/api/admin/accounts`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'integration', token: 'upstream-access-token', proxyId: '' }),
  });
  assert.equal(addResponse.status, 201);
  const addedAccount = (await addResponse.json()).account;
  assert.equal(addedAccount.concurrency, 1);
  for (const value of [0, 6, 1.5, '2']) {
    const invalidCreate = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'invalid', token: 'invalid-token', concurrency: value }),
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal((await invalidCreate.json()).error.message, 'concurrency must be an integer from 1 to 5');
    const invalidConcurrency = await fetch(`${base}/api/admin/accounts/${addedAccount.id}`, {
      method: 'PATCH', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: value }),
    });
    assert.equal(invalidConcurrency.status, 400);
    assert.equal((await invalidConcurrency.json()).error.message, 'concurrency must be an integer from 1 to 5');
  }
  const concurrencyUpdate = await fetch(`${base}/api/admin/accounts/${addedAccount.id}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ concurrency: 2 }),
  });
  assert.equal((await concurrencyUpdate.json()).account.concurrency, 2);
  const defaultReset = await fetch(`${base}/api/admin/accounts/${addedAccount.id}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'integration updated' }),
  });
  assert.equal((await defaultReset.json()).account.concurrency, 2);
  const summary = await fetch(`${base}/api/admin/summary`, { headers: { Authorization: 'Bearer admin-test-key' } });
  assert.equal(summary.status, 200);
  const summaryBody = await summary.text();
  assert.equal(summaryBody.includes('upstream-access-token'), false);
  assert.equal(summaryBody.includes('accountConcurrency'), false);
  const proxyResponse = await fetch(`${base}/api/admin/proxies`, {
    method: 'POST', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'tencent-only', url: 'http://127.0.0.1:65534' }),
  });
  const proxy = (await proxyResponse.json()).proxy;
  const settingsResponse = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tencentProxyId: proxy.id }),
  });
  assert.equal(settingsResponse.status, 200);
  assert.equal((await settingsResponse.json()).settings.tencentProxyId, proxy.id);
  const blockedDelete = await fetch(`${base}/api/admin/proxies/${proxy.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer admin-test-key' } });
  assert.equal(blockedDelete.status, 409);

  const audio = new FormData();
  audio.append('file', new Blob([Buffer.from([1, 2, 3, 4])], { type: 'audio/mpeg' }), 'sample.mp3');
  audio.append('language', 'zh');
  const response = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: 'Bearer client-test-key' }, body: audio,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'recognized words' });
  const transcribeRequest = seen.find((item) => item.path === '/transcribe');
  assert.equal(transcribeRequest.authorization, 'Bearer upstream-access-token');
  assert.match(transcribeRequest.contentType, /^multipart\/form-data; boundary=/);
  assert.match(transcribeRequest.body.toString('latin1'), /sample\.mp3/);
  assert.match(transcribeRequest.body.toString('latin1'), /name="language"\r\n\r\nzh/);

  const textAudio = new FormData();
  textAudio.append('file', new Blob([Buffer.from([8, 9])], { type: 'audio/mpeg' }), 'words.mp3');
  textAudio.append('response_format', 'text');
  const textResponse = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: 'Bearer client-test-key' }, body: textAudio,
  });
  assert.equal(textResponse.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await textResponse.text(), 'recognized words');

  emptyTurnstile = true;
  const speechResponse = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: 'hello there', voice: 'coral', response_format: 'mp3' }),
  });
  assert.equal(speechResponse.status, 200);
  assert.equal(speechResponse.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await speechResponse.text(), 'audio-stream');
  const speechConversation = seen.find((item) => item.path === '/conversation');
  const speechPayload = JSON.parse(speechConversation.body.toString('utf8'));
  assert.equal(speechPayload.messages[0].author.role, 'assistant');
  assert.equal(speechPayload.messages[0].content.parts[0], 'hello there');
  const speechFinalize = JSON.parse(seen.find((item) => item.path === '/sentinel/chat-requirements/finalize').body.toString('utf8'));
  assert.equal(speechFinalize.turnstile_token, '');
  assert.equal(seen.find((item) => item.path === '/conversation').headers['openai-sentinel-so-token'], 'sentinel-so-token');
  assert.equal(seen.find((item) => item.path === '/conversation').headers['openai-sentinel-turnstile-token'], undefined);
  const synthRequest = seen.find((item) => item.path.startsWith('/synthesize?'));
  assert.match(synthRequest.path, /voice=vale/);
  assert.match(synthRequest.path, /format=mp3/);

  emptyTurnstile = false;
  const imageResponse = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a small red boat', response_format: 'url' }),
  });
  assert.equal(imageResponse.status, 200);
  const imageResult = await imageResponse.json();
  assert.equal(typeof imageResult.created, 'number');
  assert.deepEqual(imageResult.data, [{ url: 'https://chatgpt.com/media/signed-image.png', revised_prompt: 'a small red boat' }]);
  assert.equal(imagePolls, 2, 'poll conversation until the asynchronous image pointer appears');
  assert.ok(seen.some((item) => item.path === '/files/download/asset-1'));

  const imagePromptCases = [
    ['1024x1536', undefined, '图片比例为竖版 2:3（宽:高）。'],
    ['1536x1024', undefined, '图片比例为横版 3:2（宽:高）。'],
    ['1792x1024', undefined, '图片比例为横版 16:9（宽:高）。'],
    ['16:9', undefined, '图片比例为横版 16:9（宽:高）。'],
    ['1000x1001', undefined, '图片比例为正方形 1:1（宽:高）。'],
    ['auto', undefined, ''],
    [undefined, 'HD', '画面细节质量：高。'],
    [undefined, 'standard', '画面细节质量：中。'],
    [undefined, 'auto', ''],
    [undefined, 'AUTO', ''],
    ['1024x1536', 'high', '图片比例为竖版 2:3（宽:高）。画面细节质量：高。'],
  ];
  for (const [size, quality, note] of imagePromptCases) {
    imagePolls = 0;
    inlineImageMode = /^\d+[xX]\d+$/.test(size || '');
    const prompt = 'original prompt';
    const body = { prompt, response_format: 'url' };
    if (size !== undefined) body.size = size;
    if (quality !== undefined) body.quality = quality;
    const generated = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(generated.status, 200, `expected size=${size} quality=${quality} to be accepted`);
    assert.equal((await generated.json()).data[0].revised_prompt, prompt);
    const payloads = seen.filter((item) => item.path === '/f/conversation').map((item) => JSON.parse(item.body.toString('utf8')));
    assert.equal(payloads.at(-1).messages[0].content.parts[0], note ? `${prompt}\n\n${note}` : prompt);
    const prepare = JSON.parse(seen.filter((item) => item.path === '/f/conversation/prepare').at(-1).body.toString('utf8'));
    assert.equal(prepare.partial_query.content.parts[0], note ? `${prompt}\n\n${note}` : prompt);
  }
  inlineImageMode = false;

  imagePolls = 0;
  const multipleImages = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'two outputs', size: '2:3', quality: 'medium', n: 2, response_format: 'url' }),
  });
  assert.equal(multipleImages.status, 200);
  assert.equal((await multipleImages.json()).data.length, 2);
  const lastImagePayloads = seen.filter((item) => item.path === '/f/conversation').slice(-2)
    .map((item) => JSON.parse(item.body.toString('utf8')));
  assert.ok(lastImagePayloads.every((payload) => payload.messages[0].content.parts[0]
    === 'two outputs\n\n图片比例为竖版 2:3（宽:高）。画面细节质量：中。'));

  for (const [field, value, message] of [
    ['size', 'abc', 'size must be auto, WxH, or W:H'],
    ['size', '0x100', 'size must be auto, WxH, or W:H'],
    ['size', '16:0', 'size must be auto, WxH, or W:H'],
    ['size', '10000x1', 'size must be auto, WxH, or W:H'],
    ['quality', 'ultra', 'quality must be auto, low, medium, high, standard, or hd'],
  ]) {
    const upstreamCalls = seen.length;
    const rejected = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'must not reach upstream', [field]: value }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: { message, type: 'invalid_request_error' } });
    assert.equal(seen.length, upstreamCalls, `${field}=${value} must be rejected before any upstream request`);
  }

  const acceptedImageModels = ['gpt-image-2.5', 'gpt-image-2.5-flare', 'GPT-IMAGE-2', '', undefined];
  for (const model of acceptedImageModels) {
    imagePolls = 0;
    const body = { prompt: 'model compatibility', response_format: 'url' };
    if (model !== undefined) body.model = model;
    const accepted = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 200, `expected ${model ?? 'default model'} to be accepted`);
    assert.equal((await accepted.json()).data.length, 1);
    const conversation = seen.filter((item) => item.path === '/f/conversation').at(-1);
    const payload = JSON.parse(conversation.body.toString('utf8'));
    assert.equal(payload.model, 'auto');
    assert.deepEqual(payload.system_hints, ['picture_v2']);
  }

  for (const model of ['dall-e-3', 'gpt-image-', 'gpt-4o', 2]) {
    const upstreamCalls = seen.length;
    const rejected = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'must not reach upstream', response_format: 'url' }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: { message: 'model must be a gpt-image-* model', type: 'invalid_request_error' },
    });
    assert.equal(seen.length, upstreamCalls, `model ${model} must be rejected before any upstream request`);
  }

  imagePointerScheme = 'sediment';
  imagePolls = 0;
  const sedimentResponse = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a green bowl', response_format: 'url' }),
  });
  assert.equal(sedimentResponse.status, 200);
  assert.deepEqual((await sedimentResponse.json()).data, [{ url: 'https://chatgpt.com/media/sediment-image.png', revised_prompt: 'a green bowl' }]);
  assert.ok(seen.some((item) => item.path === '/conversation/image-conversation/attachment/asset-1/download'));

  refusalMode = 'sse';
  const conversationsBeforeRefusal = seen.filter((item) => item.path === '/f/conversation').length;
  const refused = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'refused prompt' }),
  });
  assert.equal(refused.status, 400);
  assert.deepEqual((await refused.json()).error, {
    message: 'Image generation was refused by ChatGPT content policy: 抱歉，我不能生成这类图片，因为违反了内容政策',
    type: 'invalid_request_error',
    code: 'content_policy_violation',
  });
  const refusedSummary = await (await fetch(`${base}/api/admin/summary`, { headers: { Authorization: 'Bearer admin-test-key' } })).json();
  assert.equal(refusedSummary.accounts[0].consecutiveErrors, 0);
  assert.equal(seen.filter((item) => item.path === '/f/conversation').length - conversationsBeforeRefusal, 1);
  refusalMode = 'poll'; imagePolls = 0;
  const pollStarted = Date.now();
  const pollRefused = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'poll refused prompt' }),
  });
  assert.equal(pollRefused.status, 400);
  assert.ok(Date.now() - pollStarted < 10_000);
  assert.equal(imagePolls, 1);
  refusalMode = 'image-and-policy';
  const policyWithImage = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'image is present' }),
  });
  assert.equal(policyWithImage.status, 200);
  assert.equal((await policyWithImage.json()).data[0].b64_json, 'aW1hZ2U=');
  refusalMode = '';

  const turnstileToken = Buffer.from('challenge-result').toString('base64');
  const finalized = JSON.parse(seen.find((item) => item.path === '/sentinel/chat-requirements/finalize'
    && JSON.parse(item.body.toString('utf8')).turnstile_token === turnstileToken).body.toString('utf8'));
  assert.equal(finalized.turnstile_token, turnstileToken);
  assert.match(finalized.proof_token, /^gAAAAAB/);
  const proofSignal = JSON.parse(Buffer.from(finalized.proof_token.slice('gAAAAAB'.length), 'base64').toString('utf8'));
  assert.equal(proofSignal[9], proofSignal[3] >> 1);
  const requirements = seen.find((item) => item.path === '/sentinel/chat-requirements/prepare');
  assert.match(requirements.headers.cookie, /__cf_bm=mock-clearance/);
  const signal = JSON.parse(Buffer.from(JSON.parse(requirements.body.toString('utf8')).p.slice('gAAAAAC'.length), 'base64').toString('utf8'));
  assert.ok(signal[9] > 0 && signal[9] < 1);
  assert.equal(seen.find((item) => item.path === '/f/conversation/prepare').headers['openai-sentinel-chat-requirements-token'], 'finalized-sentinel-token');
  assert.equal(seen.find((item) => item.path === '/f/conversation/prepare').headers['openai-sentinel-turnstile-token'], turnstileToken);
  assert.equal(seen.find((item) => item.path === '/f/conversation').headers['openai-sentinel-turnstile-token'], turnstileToken);
  assert.equal(seen.find((item) => item.path === '/f/conversation').headers['openai-conduit-token'], 'conduit-token');

  const secondAccount = await fetch(`${base}/api/admin/accounts`, {
    method: 'POST', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'retry account', token: 'retry-access-token' }),
  });
  assert.equal(secondAccount.status, 201);
  const accountsBeforeRetry = (await (await fetch(`${base}/api/admin/summary`, { headers: { Authorization: 'Bearer admin-test-key' } })).json()).accounts;
  const retryIds = new Set(accountsBeforeRetry.map((account) => account.id));
  failTranscribeOnce = true;
  const retryAudio = new FormData(); retryAudio.append('file', new Blob(['retry'], { type: 'audio/mpeg' }), 'retry.mp3');
  const retried = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: 'Bearer client-test-key' }, body: retryAudio });
  assert.equal(retried.status, 200, await retried.text());
  const afterRetry = await (await fetch(`${base}/api/admin/summary`, { headers: { Authorization: 'Bearer admin-test-key' } })).json();
  const attemptLogs = afterRetry.logs.filter((log) => log.route === '/v1/audio/transcriptions').slice(0, 2);
  assert.equal(attemptLogs.length, 2);
  assert.equal(attemptLogs[0].status, 200);
  assert.equal(attemptLogs[1].status, 502);
  assert.notEqual(attemptLogs[0].accountId, attemptLogs[1].accountId);
  assert.ok(retryIds.has(attemptLogs[0].accountId) && retryIds.has(attemptLogs[1].accountId));
  const failedAccount = afterRetry.accounts.find((account) => account.id === attemptLogs[1].accountId);
  assert.equal(failedAccount.consecutiveErrors, 1);
  assert.equal(failedAccount.state, 'cooldown');

  await fetch(`${base}/api/admin/settings`, {
    method: 'PUT', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxAttempts: 1 }),
  });
  const enabledAccount = afterRetry.accounts.find((account) => account.id === attemptLogs[0].accountId);
  await fetch(`${base}/api/admin/accounts/${enabledAccount.id}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  failTranscribeOnce = true;
  const noRetryAudio = new FormData(); noRetryAudio.append('file', new Blob(['no-retry'], { type: 'audio/mpeg' }), 'no-retry.mp3');
  const noRetry = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: 'Bearer client-test-key' }, body: noRetryAudio });
  assert.equal(noRetry.status, 502);
  assert.match((await noRetry.json()).error.message, /^\[1 accounts tried\]/);
  for (const account of afterRetry.accounts) {
    await fetch(`${base}/api/admin/accounts/${account.id}`, {
      method: 'PATCH', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  }
  await fetch(`${base}/api/admin/settings`, {
    method: 'PUT', headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxAttempts: 3 }),
  });

  forceLogin = true;
  const expired = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'hello again' }),
  });
  assert.equal(expired.status, 502);
  const updatedSummary = await fetch(`${base}/api/admin/summary`, { headers: { Authorization: 'Bearer admin-test-key' } });
  assert.equal((await updatedSummary.json()).accounts[0].state, 'cooldown');
});
