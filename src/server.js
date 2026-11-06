import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { parseProxy, requestThroughProxy, resolveProxyChain, resolveServiceProxyChain } from './proxy.js';
import { getImageRequestSize, handleMediaRequest, parseImageSize, prepareImagePostprocessBody } from './upstream.js';
import { detectImage, processImage } from './tencent.js';
import { resizeToTarget } from './resize.js';
import { Scheduler } from './scheduler.js';

const here = dirname(fileURLToPath(import.meta.url));
const store = new Store(config.dbPath, config.dataKey);
const apiPaths = new Set([
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/audio/speech', '/v1/audio/transcriptions', '/v1/audio/translations',
]);
const scheduler = new Scheduler({ listAccounts: () => store.listAccounts(), settings: () => store.settings(), recover: () => store.recoverCooldownAccounts() });
store.inFlight = (id) => scheduler.inFlight(id);

/** Compares a Bearer credential in constant time after checking token lengths. */
function matchesSecret(header, secret) {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const left = Buffer.from(token);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Writes an uncached JSON response using the gateway error and result envelope conventions. */
function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Buffers one bounded request body; audio files are supported, while oversized uploads fail with 413. */
async function readBody(request, maxBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Parses a JSON request body and turns malformed input into a client error. */
async function readJson(request) {
  const bytes = await readBody(request, 2 * 1024 * 1024);
  try { return bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}

/** Enforces JSON content type for admin mutation endpoints before parsing the body. */
async function requireJson(request) {
  if (!request.headers['content-type']?.includes('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
  return readJson(request);
}

/** Protects every admin API route with the separate ADMIN_KEY. */
function adminAuth(request, response) {
  if (matchesSecret(request.headers.authorization, config.adminKey)) return true;
  sendJson(response, 401, { error: { message: 'Admin authentication required' } });
  return false;
}

/** Protects consumer media routes with API_KEY, independently of admin access. */
function publicAuth(request, response) {
  if (matchesSecret(request.headers.authorization, config.apiKey)) return true;
  sendJson(response, 401, { error: { message: 'Invalid API key' } });
  return false;
}

/** Resolves strict SR/CR path prefixes and rejects prefixed non-image routes. */
function imageProcessingRoute(path) {
  const segments = path.split('/').filter(Boolean);
  const versionIndex = segments.indexOf('v1');
  if (versionIndex < 0) return { path, steps: [] };
  const prefixes = segments.slice(0, versionIndex);
  if (!prefixes.length) return { path, steps: [] };
  if (prefixes.some((prefix) => prefix !== 'SR' && prefix !== 'CR')) {
    throw Object.assign(new Error('Endpoint not found'), { status: 404 });
  }
  if (prefixes.length > 4) throw Object.assign(new Error('At most four image post-processing steps are allowed'), { status: 400 });
  const routePath = `/${segments.slice(versionIndex).join('/')}`;
  if (!['/v1/images/generations', '/v1/images/edits'].includes(routePath)) throw Object.assign(new Error('Endpoint not found'), { status: 404 });
  return { path: routePath, steps: prefixes };
}

/** Removes only old, strictly named generated images from the public files directory. */
async function cleanExpiredFiles() {
  const directory = join(config.dataDir, 'files');
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const cutoff = Date.now() - 60 * 60 * 1000;
  await Promise.all(names.filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/.test(name))
    .map(async (name) => {
      const path = join(directory, name);
      try { if ((await stat(path)).mtimeMs < cutoff) await unlink(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }));
}

/** Saves processed image bytes under an unguessable, self-expiring public filename. */
async function saveProcessedImage(bytes, extension) {
  const directory = join(config.dataDir, 'files');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cleanExpiredFiles();
  const filename = `${randomUUID()}.${extension}`;
  await writeFile(join(directory, filename), bytes, { mode: 0o600, flag: 'wx' });
  return filename;
}

/** Validates proxy labels, schemes, and direct self-links before writing proxy configuration. */
function validateProxyFields(body) {
  if (!body.label?.trim() || !body.url?.trim()) throw Object.assign(new Error('label and url are required'), { status: 400 });
  if (body.url) parseProxy(body.url);
  if (body.nextProxyId === body.id && body.id) throw Object.assign(new Error('A proxy cannot chain to itself'), { status: 400 });
}

/** Checks a candidate's next-hop graph so invalid cycles cannot be stored through the admin API. */
function isProxyLoop(proxies, candidate) {
  const map = new Map(proxies.map((proxy) => [proxy.id, proxy]));
  map.set(candidate.id, candidate);
  const seen = new Set([candidate.id]);
  let next = candidate.nextProxyId;
  while (next) {
    if (seen.has(next)) return true;
    seen.add(next);
    next = map.get(next)?.nextProxyId || null;
  }
  return false;
}

/** Dispatches authenticated admin operations for accounts, proxies, settings, tests, and logs. */
async function adminRoute(request, response, url) {
  if (!adminAuth(request, response)) return;
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/admin/summary' && method === 'GET') {
    return sendJson(response, 200, {
      accounts: store.listAccounts(), proxies: store.listProxies(), settings: store.settings(), logs: store.recentLogs(80), scheduler: scheduler.stats(),
    });
  }
  if (path === '/api/admin/accounts' && method === 'POST') {
    const body = await requireJson(request);
    if (!body.label?.trim() || !body.token?.trim()) return sendJson(response, 400, { error: { message: 'label and token are required' } });
    if (Object.hasOwn(body, 'concurrency') && (!Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 5)) return sendJson(response, 400, { error: { message: 'concurrency must be an integer from 1 to 5' } });
    if (body.proxyId && !store.getProxy(body.proxyId)) return sendJson(response, 400, { error: { message: 'Selected proxy does not exist' } });
    return sendJson(response, 201, { account: store.addAccount(body) });
  }
  const accountPath = path.match(/^\/api\/admin\/accounts\/([\w-]+)$/);
  if (accountPath && method === 'PATCH') {
    const body = await requireJson(request);
    if (Object.hasOwn(body, 'concurrency') && (!Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 5)) return sendJson(response, 400, { error: { message: 'concurrency must be an integer from 1 to 5' } });
    if (body.proxyId && !store.getProxy(body.proxyId)) return sendJson(response, 400, { error: { message: 'Selected proxy does not exist' } });
    const account = store.updateAccount(accountPath[1], body);
    if (account) scheduler.wake();
    return account ? sendJson(response, 200, { account }) : sendJson(response, 404, { error: { message: 'Account not found' } });
  }
  if (accountPath && method === 'DELETE') {
    return store.deleteAccount(accountPath[1])
      ? sendJson(response, 200, { deleted: true })
      : sendJson(response, 404, { error: { message: 'Account not found' } });
  }
  if (path === '/api/admin/proxies' && method === 'POST') {
    const body = await requireJson(request);
    validateProxyFields(body);
    if (body.nextProxyId && !store.getProxy(body.nextProxyId)) return sendJson(response, 400, { error: { message: 'Next proxy does not exist' } });
    const proxy = { ...body, id: randomUUID() };
    if (isProxyLoop(store.listProxies(), proxy)) return sendJson(response, 400, { error: { message: 'Proxy chain contains a cycle' } });
    return sendJson(response, 201, { proxy: store.saveProxy(proxy) });
  }
  const proxyPath = path.match(/^\/api\/admin\/proxies\/([\w-]+)$/);
  if (proxyPath && method === 'PUT') {
    const body = await requireJson(request);
    validateProxyFields(body, true);
    if (!store.getProxy(proxyPath[1])) return sendJson(response, 404, { error: { message: 'Proxy not found' } });
    if (body.nextProxyId && !store.getProxy(body.nextProxyId)) return sendJson(response, 400, { error: { message: 'Next proxy does not exist' } });
    const proxy = { ...store.getProxy(proxyPath[1]), ...body, id: proxyPath[1] };
    if (isProxyLoop(store.listProxies(), proxy)) return sendJson(response, 400, { error: { message: 'Proxy chain contains a cycle' } });
    return sendJson(response, 200, { proxy: store.saveProxy(proxy) });
  }
  if (proxyPath && method === 'DELETE') {
    const settings = store.settings();
    if (settings.defaultProxyId === proxyPath[1] || settings.exitProxyId === proxyPath[1] || settings.tencentProxyId === proxyPath[1]) {
      return sendJson(response, 409, { error: { message: 'Remove this proxy from global settings first' } });
    }
    return store.deleteProxy(proxyPath[1])
      ? sendJson(response, 200, { deleted: true })
      : sendJson(response, 404, { error: { message: 'Proxy not found' } });
  }
  if (path === '/api/admin/settings' && method === 'PUT') {
    const body = await requireJson(request);
    for (const id of [body.defaultProxyId, body.exitProxyId, body.tencentProxyId === 'direct' ? null : body.tencentProxyId]) {
      if (id && !store.getProxy(id)) return sendJson(response, 400, { error: { message: `Proxy ${id} does not exist` } });
    }
    const previous = store.settings();
    const value = store.setSettings(body);
    try { resolveProxyChain(store, null); }
    catch (error) { store.setSettings(previous); return sendJson(response, 400, { error: { message: error.message } }); }
    return sendJson(response, 200, { settings: value });
  }
  if (path === '/api/admin/proxy-test' && method === 'POST') {
    const body = await requireJson(request);
    if (body.target === 'tencent') {
      const route = resolveServiceProxyChain(store, store.settings().tencentProxyId);
      const started = Date.now();
      const upstream = await requestThroughProxy('https://tiia.tencentcloudapi.com/', { method: 'GET', timeout: 15000 }, route);
      upstream.resume();
      return sendJson(response, 200, { status: upstream.statusCode, durationMs: Date.now() - started });
    }
    const proxy = body.proxyId ? store.getProxy(body.proxyId) : null;
    if (body.proxyId && !proxy) return sendJson(response, 404, { error: { message: 'Proxy not found' } });
    const route = proxy ? resolveProxyChain(store, { proxy_id: proxy.id }) : resolveProxyChain(store, null);
    const started = Date.now();
    const upstream = await requestThroughProxy('https://chatgpt.com/cdn-cgi/trace', {
      method: 'GET', headers: { Accept: 'text/plain' }, timeout: 15000,
    }, route);
    const result = await readStream(upstream, 8192);
    return sendJson(response, 200, { status: upstream.statusCode, durationMs: Date.now() - started, response: result.toString('utf8').slice(0, 500) });
  }
  if (path === '/api/admin/logs' && method === 'GET') return sendJson(response, 200, { logs: store.recentLogs(200) });
  return sendJson(response, 404, { error: { message: 'Admin route not found' } });
}

/** Reads a small bounded response for proxy diagnostics, destroying longer bodies once the limit is reached. */
async function readStream(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = chunk.subarray(0, Math.max(0, maxBytes - size));
    chunks.push(part);
    size += part.length;
    if (size >= maxBytes) { stream.destroy(); break; }
  }
  return Buffer.concat(chunks);
}

/** Handles OpenAI-shaped media requests and records metadata without persisting prompts or file contents. */
async function publicRoute(request, response, url) {
  if (!publicAuth(request, response)) return;
  let mediaRoute;
  try { mediaRoute = imageProcessingRoute(url.pathname); }
  catch (error) { return sendJson(response, error.status || 404, { error: { message: error.message } }); }
  if (mediaRoute.steps.length) {
    if (!['/v1/images/generations', '/v1/images/edits'].includes(mediaRoute.path) || request.method !== 'POST') {
      return sendJson(response, 404, { error: { message: 'Endpoint not found' } });
    }
    if (!config.tencentSecretId || !config.tencentSecretKey || !/^.+-\d+$/.test(config.tencentCosBucket)) {
      return sendJson(response, 503, { error: { message: 'Tencent Cloud post-processing is not configured', type: 'unavailable_error' } });
    }
  }
  if (url.pathname === '/v1/models' && request.method === 'GET') {
    return sendJson(response, 200, { object: 'list', data: [
      { id: 'gpt-image-2', object: 'model' }, { id: 'tts-1', object: 'model' }, { id: 'whisper-1', object: 'model' },
    ] });
  }
  if ((!apiPaths.has(url.pathname) && !mediaRoute.steps.length) || request.method !== 'POST') return sendJson(response, 404, { error: { message: 'Endpoint not found' } });
  const started = Date.now();
  let accountId = null;
  let reservation = null;
  try {
    const body = await readBody(request);
    const isImageRoute = ['/v1/images/generations', '/v1/images/edits'].includes(mediaRoute.path);
    const imageContentType = request.headers['content-type'] || '';
    const imageSize = isImageRoute ? getImageRequestSize(body, imageContentType) : undefined;
    const pixelTarget = isImageRoute ? parseImageSize(imageSize).pixelTarget : null;
    const rewritten = isImageRoute && (mediaRoute.steps.length || pixelTarget)
      ? prepareImagePostprocessBody(body, imageContentType) : null;
    let result;
    const attempted = new Set();
    const maxAttempts = store.settings().maxAttempts;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try { reservation = await scheduler.acquire(attempted); }
      catch (error) {
        if (!lastError) throw error;
        lastError.message = `[${attempted.size} accounts tried] ${lastError.message}`;
        throw lastError;
      }
      accountId = reservation.accountId;
      attempted.add(accountId);
      const account = store.getAccount(accountId);
      try {
        if (rewritten) {
          const forcedRequest = { ...request, headers: { ...request.headers, ...(rewritten.contentType ? { 'content-type': rewritten.contentType } : {}) } };
          result = await handleMediaRequest({ path: mediaRoute.path, request: forcedRequest, body: rewritten.body, account, store });
        } else result = await handleMediaRequest({ path: url.pathname, request, body, account, store });
        store.recordAccountSuccess(accountId);
        reservation.release(); reservation = null;
        break;
      } catch (error) {
        lastError = error;
        const accountError = error.upstreamStatus || Number(error.status || 502) >= 500;
        if (!accountError) throw error;
        const settings = store.settings();
        store.recordAccountError(accountId, error.message, settings);
        const status = error.upstreamStatus === 401 ? 502 : Number(error.status || 502);
        store.logRequest({ route: url.pathname, accountId, status, durationMs: Date.now() - started, error: error.message });
        reservation.release(); reservation = null;
        if (attempt + 1 >= maxAttempts || store.listAccounts().every((item) => attempted.has(item.id))) {
          error.message = `[${attempted.size} accounts tried] ${error.message}`;
          throw error;
        }
      }
    }
    if (!result && lastError) throw lastError;
    if (isImageRoute && (mediaRoute.steps.length || pixelTarget)) {
      for (const item of result.json.data) {
        if (!item.b64_json) throw Object.assign(new Error('Generated image did not include image bytes'), { status: 502, type: 'upstream_error' });
        let processed = Buffer.from(item.b64_json, 'base64');
        if (pixelTarget) {
          const resized = await resizeToTarget(processed, pixelTarget);
          processed = resized.bytes;
          item._resized = resized.resized;
        }
        if (mediaRoute.steps.length) processed = await processImage(processed, mediaRoute.steps, store, pixelTarget);
        item.b64_json = processed.toString('base64');
      }
      if (rewritten.outputFormat === 'url') {
        const forwarded = config.trustProxy ? String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
        const protocol = forwarded === 'https' || request.socket.encrypted ? 'https:' : 'http:';
        const origin = new URL(`${protocol}//${request.headers.host || 'localhost'}`).origin;
        for (const item of result.json.data) {
          if (!mediaRoute.steps.length && !item._resized) {
            delete item.b64_json;
            delete item._resized;
            continue;
          }
          const bytes = Buffer.from(item.b64_json, 'base64');
          const image = detectImage(bytes);
          const filename = await saveProcessedImage(bytes, image.extension);
          item.url = `${origin}/files/${filename}`;
          delete item.b64_json;
          delete item._resized;
        }
      } else {
        for (const item of result.json.data) { delete item.url; delete item._resized; }
      }
    }
    store.logRequest({ route: url.pathname, accountId, status: 200, durationMs: Date.now() - started });
    if (result.binary) {
      response.writeHead(200, { 'Content-Type': result.binary.contentType, 'Content-Length': result.binary.bytes.length, 'Cache-Control': 'no-store' });
      return response.end(result.binary.bytes);
    }
    if (result.text !== undefined) {
      response.writeHead(200, { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' });
      return response.end(result.text);
    }
    return sendJson(response, 200, result.json);
  } catch (error) {
    reservation?.release();
    const status = error.upstreamStatus === 401 ? 502 : Number(error.status || 502);
    store.logRequest({ route: url.pathname, accountId, status, durationMs: Date.now() - started, error: error.message });
    return sendJson(response, status, { error: { message: error.message, type: error.type || (error.upstreamStatus ? 'upstream_error' : 'request_error'), ...(error.code ? { code: error.code } : {}) } });
  }
}

const server = createServer(async (request, response) => {
  const started = Date.now();
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/healthz' && request.method === 'GET') return sendJson(response, 200, { ok: true });
    if (url.pathname.startsWith('/files/')) {
      const filename = url.pathname.slice('/files/'.length);
      if (request.method !== 'GET' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/.test(filename)) {
        return sendJson(response, 404, { error: { message: 'File not found' } });
      }
      try {
        const bytes = await readFile(join(config.dataDir, 'files', filename));
        const image = detectImage(bytes);
        response.writeHead(200, { 'Content-Type': image.contentType, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        return response.end(bytes);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return sendJson(response, 404, { error: { message: 'File not found' } });
      }
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(await readFile(join(here, '../public/index.html')));
    }
    if (url.pathname.startsWith('/api/admin/')) return await adminRoute(request, response, url);
    if (url.pathname.startsWith('/v1/') || /^\/(?:[^/]+\/)+v1(?:\/|$)/.test(url.pathname)) return await publicRoute(request, response, url);
    return sendJson(response, 404, { error: { message: 'Not found' } });
  } catch (error) {
    if (response.headersSent) return response.destroy(error);
    const status = Number(error.status || 502);
    sendJson(response, status, { error: { message: error.message || 'Request failed' } });
    if (url.pathname.startsWith('/v1/')) {
      try { store.logRequest({ route: url.pathname, status, durationMs: Date.now() - started, error: error.message }); } catch {}
    }
  }
});

await cleanExpiredFiles();
server.listen(config.port, config.host, () => {
  process.stdout.write(`ChatGPT Media Gateway listening on http://${config.host}:${config.port}\n`);
});
