import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { requestThroughProxy, resolveProxyChain } from './proxy.js';
import { solveTurnstileToken } from './turnstile.js';
import { detectImage } from './tencent.js';

const voiceMap = {
  alloy: 'cove', ash: 'fathom', coral: 'vale', echo: 'ember', fable: 'breeze',
  onyx: 'orbit', nova: 'maple', sage: 'glimmer', shimmer: 'juniper',
};
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const DEFAULT_SEC_CH_UA = '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"';
const DEFAULT_CLIENT_VERSION = 'prod-a194cd50d4416d3c0b47c740f206b12ce60f5887';
const DEFAULT_CLIENT_BUILD = '6708908';

/** Accepts signed media URLs only from ChatGPT-owned delivery hosts before fetching them without credentials. */
function signedMediaUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const trusted = host === 'chatgpt.com' || host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com') || host.endsWith('.oaistatic.com');
  if (url.protocol !== 'https:' || !trusted) throw Object.assign(new Error('ChatGPT returned an unsupported media download host'), { status: 502 });
  return url;
}

/** Joins an internal ChatGPT endpoint to the configured backend base URL. */
function baseUrl(path) {
  return `${config.upstream.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/** Builds authenticated protocol headers from a stored account and its persistent device ID. */
function initialHeaders(account, accept = 'application/json') {
  const cookies = new Map(account.cookies || []);
  cookies.set('oai-did', account.device_id);
  return {
    Authorization: `Bearer ${account.token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'OAI-Device-ID': account.device_id,
    Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Priority: 'u=1, i',
    'Sec-Ch-Ua': DEFAULT_SEC_CH_UA,
    'Sec-Ch-Ua-Arch': '"x86"',
    'Sec-Ch-Ua-Bitness': '"64"',
    'Sec-Ch-Ua-Full-Version': '"143.0.3650.96"',
    'Sec-Ch-Ua-Full-Version-List': '"Microsoft Edge";v="143.0.3650.96", "Chromium";v="143.0.7499.147", "Not A(Brand";v="24.0.0.0"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Model': '""',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Ch-Ua-Platform-Version': '"19.0.0"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'OAI-Session-Id': account.session_id || randomUUID(),
    'OAI-Language': 'zh-CN',
    'OAI-Client-Version': DEFAULT_CLIENT_VERSION,
    'OAI-Client-Build-Number': DEFAULT_CLIENT_BUILD,
  };
}

/** Keeps same-host cookies from upstream responses for the lifetime of this account request. */
function rememberCookies(account, response) {
  account.cookies ||= new Map();
  const values = response.headers['set-cookie'] || [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const [pair, ...attributes] = value.split(';');
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const cookie = pair.slice(separator + 1).trim();
    const maxAge = attributes.map((part) => part.trim()).find((part) => /^max-age=/i.test(part));
    if (maxAge && Number(maxAge.slice(maxAge.indexOf('=') + 1)) <= 0) account.cookies.delete(name);
    else account.cookies.set(name, cookie);
  }
}

/** Sends one buffered HTTP request through the selected chain and returns its complete response bytes. */
async function requestUpstream(account, chain, path, { method = 'GET', body, headers = {}, accept } = {}) {
  const targetPath = `${new URL(config.upstream).pathname.replace(/\/$/, '')}${path}`;
  const response = await requestThroughProxy(baseUrl(path), {
    method,
    headers: {
      ...initialHeaders(account, accept),
      'X-OpenAI-Target-Path': targetPath,
      'X-OpenAI-Target-Route': targetPath,
      ...headers,
    },
    body,
  }, chain);
  rememberCookies(account, response);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Object.assign(new Error(`ChatGPT upstream returned HTTP ${response.statusCode}`), { status: 502, upstreamStatus: response.statusCode });
  }
  return { response, bytes };
}

const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js';
const SCREEN_RESOLUTIONS = [[1920, 1080], [1440, 900], [2560, 1440], [3840, 2160]];
const DOCUMENT_KEYS = ['__reactContainer$fzelfjyxej8', '_reactListening5dehydibo78', 'location'];
const CORES = [8, 16, 24, 32];
const NAVIGATOR_KEYS = [
  'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
  'storage−[object StorageManager]', 'locks−[object LockManager]', 'appCodeName−Mozilla',
  'permissions−[object Permissions]', 'share−function share() { [native code] }', 'webdriver−false',
  'managed−[object NavigatorManagedData]', 'canShare−function canShare() { [native code] }',
  'vendor−Google Inc.', 'mediaDevices−[object MediaDevices]', 'vibrate−function vibrate() { [native code] }',
  'storageBuckets−[object StorageBucketManager]', 'mediaCapabilities−[object MediaCapabilities]',
  'cookieEnabled−true', 'virtualKeyboard−[object VirtualKeyboard]', 'product−Gecko',
  'presentation−[object Presentation]', 'onLine−true', 'mimeTypes−[object MimeTypeArray]',
  'credentials−[object CredentialsContainer]', 'serviceWorker−[object ServiceWorkerContainer]',
  'keyboard−[object Keyboard]', 'gpu−[object GPU]', 'doNotTrack', 'serial−[object Serial]',
  'pdfViewerEnabled−true', 'language−zh-CN', 'geolocation−[object Geolocation]',
  'userAgentData−[object NavigatorUAData]', 'getUserMedia−function getUserMedia() { [native code] }',
  'sendBeacon−function sendBeacon() { [native code] }', 'hardwareConcurrency−32',
  'windowControlsOverlay−[object WindowControlsOverlay]',
];
const WINDOW_KEYS = [
  '0', 'window', 'self', 'document', 'name', 'location', 'customElements', 'history', 'navigation',
  'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'visualViewport', 'screenX', 'screenY',
  'outerWidth', 'outerHeight', 'devicePixelRatio', 'screen', 'chrome', 'navigator', 'onresize',
  'performance', 'crypto', 'indexedDB', 'sessionStorage', 'localStorage', 'scheduler', 'alert',
  'atob', 'btoa', 'fetch', 'matchMedia', 'postMessage', 'queueMicrotask', 'requestAnimationFrame',
  'setInterval', 'setTimeout', 'caches', '__NEXT_DATA__', '__BUILD_MANIFEST', '__NEXT_PRELOADREADY',
];

/** Extracts PoW script references from the HTTP homepage without starting a browser. */
function parsePowResources(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
  const dataBuild = html.match(/<html[^>]*data-build="([^"]*)"/i)?.[1]
    || scripts.map((src) => src.match(/c\/[^/]*\/_/)?.[0]).find(Boolean)
    || '';
  return { scripts: scripts.length ? scripts : [DEFAULT_POW_SCRIPT], dataBuild };
}

/** Builds the legacy browser-signal array used by ChatGPT2API for Sentinel and PoW. */
function buildPowConfig(userAgent, scripts, dataBuild) {
  const choose = (values) => values[Math.floor(Math.random() * values.length)];
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Etc/GMT+5', weekday: 'short', month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const legacyTime = `${parts.weekday} ${parts.month} ${parts.day} ${parts.year} ${parts.hour}:${parts.minute}:${parts.second} GMT-0500 (Eastern Standard Time)`;
  return [
    choose(SCREEN_RESOLUTIONS).reduce((sum, value) => sum + value, 0), legacyTime, 4294705152, 1,
    userAgent, choose(scripts), dataBuild, 'en-US', 'en-US,es-US,en,es', Math.random(),
    choose(NAVIGATOR_KEYS), choose(DOCUMENT_KEYS), choose(WINDOW_KEYS), performance.now(), randomUUID(), '',
    choose(CORES), performance.timeOrigin, 0, 0, 0, 0, 0, 0, 0,
  ];
}

/** Serializes the requirements signal in the legacy format used by the reference image flow. */
function requirementsToken(config) {
  return `gAAAAAC${Buffer.from(JSON.stringify(config)).toString('base64')}`;
}

/** Solves Sentinel SHA3-512 proof-of-work using the same legacy payload as the reference image flow. */
function proofToken(userAgent, scripts, dataBuild, seed, difficulty) {
  const targetHex = String(difficulty || '');
  if (targetHex.length % 2 || !/^[\da-f]*$/i.test(targetHex)) {
    throw Object.assign(new Error('Unsupported Sentinel proof difficulty'), { status: 503 });
  }
  const target = Buffer.from(targetHex, 'hex');
  const diffLength = targetHex.length / 2;
  const signal = buildPowConfig(userAgent, scripts, dataBuild);
  for (let nonce = 0; nonce < 500000; nonce += 1) {
    signal[3] = nonce;
    signal[9] = nonce >> 1;
    const encoded = Buffer.from(JSON.stringify(signal)).toString('base64');
    const digest = createHash('sha3-512').update(String(seed || '')).update(encoded).digest();
    if (Buffer.compare(digest.subarray(0, diffLength), target.subarray(0, diffLength)) <= 0) return `gAAAAAB${encoded}`;
  }
  throw Object.assign(new Error('Sentinel proof-of-work could not be solved'), { status: 503 });
}

/** Reads the site homepage through the configured chain to obtain current PoW script references. */
async function loadPowResources(account, chain) {
  const home = `${new URL(config.upstream).origin}/`;
  const response = await requestThroughProxy(home, {
    method: 'GET', headers: {
      ...initialHeaders(account, 'text/html,*/*;q=0.8'),
      'X-OpenAI-Target-Path': '/',
      'X-OpenAI-Target-Route': '/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  }, chain);
  rememberCookies(account, response);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Object.assign(new Error(`ChatGPT homepage returned HTTP ${response.statusCode}`), { status: 502, upstreamStatus: response.statusCode });
  }
  return parsePowResources(Buffer.concat(chunks).toString('utf8'));
}

/** Performs Sentinel prepare/proof/Turnstile/finalize for one media operation. */
async function sentinel(account, chain) {
  account.session_id = randomUUID();
  const userAgent = initialHeaders(account)['User-Agent'];
  const powResources = await loadPowResources(account, chain);
  const signal = buildPowConfig(userAgent, powResources.scripts, powResources.dataBuild);
  const p = requirementsToken(signal);
  const { bytes: preparedBytes } = await requestUpstream(account, chain, '/sentinel/chat-requirements/prepare', {
    method: 'POST', body: JSON.stringify({ p }),
  });
  const prepared = JSON.parse(preparedBytes.toString('utf8'));
  if (prepared.force_login) throw Object.assign(new Error('ChatGPT access token was rejected or expired'), { status: 502, upstreamStatus: 401 });
  if (!prepared.prepare_token) throw Object.assign(new Error('Sentinel prepare response did not include prepare_token'), { status: 502 });
  if (prepared.arkose?.required) throw Object.assign(new Error('ChatGPT requires Arkose verification'), { status: 502 });
  let turnstile = '';
  if (prepared.turnstile?.required) {
    const solution = solveTurnstileToken(prepared.turnstile.dx, p);
    turnstile = solution.token || '';
  }
  const proof = prepared.proofofwork?.required
    ? proofToken(userAgent, powResources.scripts, powResources.dataBuild,
      prepared.proofofwork.seed, prepared.proofofwork.difficulty)
    : '';
  const payload = { prepare_token: prepared.prepare_token, proof_token: proof, turnstile_token: turnstile };
  const { bytes: finalizedBytes } = await requestUpstream(account, chain, '/sentinel/chat-requirements/finalize', {
    method: 'POST', body: JSON.stringify(payload),
  });
  const finalized = JSON.parse(finalizedBytes.toString('utf8'));
  if (!finalized.token) throw Object.assign(new Error('Sentinel finalize response did not include token'), { status: 502 });
  return {
    'OpenAI-Sentinel-Chat-Requirements-Token': finalized.token,
    ...(proof ? { 'OpenAI-Sentinel-Proof-Token': proof } : {}),
    ...(turnstile ? { 'OpenAI-Sentinel-Turnstile-Token': turnstile } : {}),
    ...(finalized.so_token ? { 'OpenAI-Sentinel-SO-Token': finalized.so_token } : {}),
  };
}

/** Builds the minimal conversation payload shared by speech synthesis and image generation requests. */
function conversationPayload(prompt, model = 'auto', hints = []) {
  const now = new Date();
  return {
    action: 'next',
    messages: [{
      id: randomUUID(),
      author: { role: 'user' },
      content: { content_type: 'text', parts: [prompt] },
      metadata: { timestamp_: now.toISOString() },
    }],
    parent_message_id: 'client-created-root',
    model,
    timezone_offset_min: -now.getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversation_mode: { kind: 'primary_assistant' },
    system_hints: hints,
    supports_buffering: true,
    supported_encodings: ['v1'],
  };
}

/** Parses data lines from a fully buffered ChatGPT SSE response, ignoring malformed or terminal events. */
function parseSse(bytes) {
  return bytes.toString('utf8').split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('data:')) return [];
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

/** Parses a JSON media request and reports malformed input as HTTP 400 rather than an upstream failure. */
function parseJsonBody(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}

/** Visits nested JSON objects recursively to locate event fields whose structure varies upstream. */
function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) Array.isArray(child) ? child.forEach((item) => walk(item, visit)) : walk(child, visit);
}

/** Combines account authentication and Sentinel headers for conversation endpoints. */
function conversationHeaders(account, sentinelToken, accept = 'text/event-stream') {
  return { ...initialHeaders(account, accept), ...sentinelToken };
}

/** Collects image pointers and directly usable image results from nested conversation data. */
function collectImageResults(value, results = []) {
  walk(value, (item) => {
    if (typeof item.asset_pointer === 'string') {
      const pointer = item.asset_pointer;
      if (pointer.startsWith('file-service://')) results.push({ kind: 'file', id: pointer.slice('file-service://'.length) });
      else if (pointer.startsWith('sediment://')) results.push({ kind: 'sediment', id: pointer.slice('sediment://'.length) });
    }
    if (typeof item.url === 'string' && /^https?:/.test(item.url)) results.push({ url: item.url });
    if (typeof item.b64_json === 'string') results.push({ b64_json: item.b64_json });
  });
  return [...new Map(results.filter((item) => item.id || item.url || item.b64_json)
    .map((item) => [item.id ? `${item.kind}:${item.id}` : item.url || item.b64_json, item])).values()];
}

// Refusal phrases follow the MIT-licensed chatgpt2api research implementation's keyword list.
const CONTENT_POLICY_KEYWORDS = [
  '内容政策', '防护限制', '违反', 'moderation', 'policy', 'blocked',
  '不能生成', '无法生成', '不能帮助', '无法帮助', '裸体', '裸露', '色情', '性内容', '未成年', '抱歉，我不能',
];

/** Finds assistant/tool text and emits a caller error only when no image result exists. */
function throwIfContentPolicyRefusal(value, hasImage) {
  if (hasImage) return;
  const texts = [];
  walk(value, (item) => {
    const message = item.message || (item.author ? item : null);
    if (!['assistant', 'tool'].includes(message?.author?.role)) return;
    const visitText = (part) => {
      if (typeof part === 'string') texts.push(part);
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') texts.push(part.text);
        Object.values(part).forEach(visitText);
      }
    };
    visitText(message.content);
  });
  const text = texts.find((entry) => CONTENT_POLICY_KEYWORDS.some((keyword) => entry.toLowerCase().includes(keyword.toLowerCase())));
  if (text) throw Object.assign(new Error(`Image generation was refused by ChatGPT content policy: ${text.slice(0, 200)}`), {
    status: 400, type: 'invalid_request_error', code: 'content_policy_violation',
  });
}

/** Waits for the asynchronous image task to publish at least one result pointer. */
async function pollImageResults(account, chain, conversationId, initialResults) {
  const deadline = Date.now() + 120_000;
  const results = [...initialResults];
  let polls = 0;
  let lastSummary = { topLevelKeys: [], messages: [], pointerSchemes: [] };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, polls === 0 ? 3_000 : 2_000));
    const { bytes } = await requestUpstream(account, chain, `/conversation/${encodeURIComponent(conversationId)}`);
    polls += 1;
    const snapshot = JSON.parse(bytes.toString('utf8'));
    const found = collectImageResults(snapshot);
    const messageShapes = [];
    const pointerSchemes = new Set();
    walk(snapshot, (item) => {
      if (item.message) {
        const message = item.message;
        messageShapes.push({ role: message.author?.role || '', contentType: message.content?.content_type || '' });
      }
      if (typeof item.asset_pointer === 'string') pointerSchemes.add(item.asset_pointer.split(':', 1)[0]);
    });
    lastSummary = {
      topLevelKeys: Object.keys(snapshot).slice(0, 30),
      messages: messageShapes.slice(0, 30),
      pointerSchemes: [...pointerSchemes],
    };
    for (const item of found) {
      const key = item.id ? `${item.kind}:${item.id}` : item.url || item.b64_json;
      if (!results.some((existing) => (existing.id ? `${existing.kind}:${existing.id}` : existing.url || existing.b64_json) === key)) results.push(item);
    }
    if (found.length) return { results, polls };
    throwIfContentPolicyRefusal(snapshot, results.length > 0);
  }
  throw Object.assign(new Error(`Image generation timed out while polling conversation (${polls} polls); structure=${JSON.stringify(lastSummary)}`), { status: 502 });
}

/** Posts one conversation event and returns parsed SSE data objects; response streaming is buffered for parsing. */
async function conversation(account, chain, payload, sentinelToken, path = '/conversation', extraHeaders = {}) {
  const { bytes } = await requestUpstream(account, chain, path, {
    method: 'POST', body: JSON.stringify(payload),
    headers: { ...conversationHeaders(account, sentinelToken), ...extraHeaders }, accept: 'text/event-stream',
  });
  return parseSse(bytes);
}

/** Runs Sentinel, image prepare, conversation generation, and file resolution for a single image. */
async function generateOneImage(account, chain, prompt, references = []) {
  const token = await sentinel(account, chain);
  const now = new Date();
  const prepareBody = {
    action: 'next', parent_message_id: 'client-created-root', model: 'auto',
    client_prepare_state: 'success', client_prepare_dispatch: 'debounced',
    client_prepare_source: 'composer_editor_state', timezone_offset_min: -now.getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversation_mode: { kind: 'primary_assistant' }, system_hints: ['picture_v2'],
    partial_query: { id: randomUUID(), author: { role: 'user' }, content: { content_type: 'text', parts: [prompt] } },
  };
  const { bytes: prepareBytes } = await requestUpstream(account, chain, '/f/conversation/prepare', {
    method: 'POST', body: JSON.stringify(prepareBody), headers: token,
  });
  const conduitToken = JSON.parse(prepareBytes.toString('utf8')).conduit_token;
  if (!conduitToken) throw Object.assign(new Error('Image prepare response did not include conduit_token'), { status: 502 });
  const payload = {
    ...conversationPayload(prompt, 'auto', ['picture_v2']),
    client_prepare_state: 'sent', enable_message_followups: true,
    timezone_offset_min: prepareBody.timezone_offset_min, timezone: prepareBody.timezone,
  };
  if (references.length) {
    attachImageReferences(payload.messages[0], prompt, references);
  }
  const events = await conversation(account, chain, payload, token, '/f/conversation', { 'OpenAI-Conduit-Token': conduitToken });
  let data = [];
  let conversationId = '';
  walk(events, (value) => {
    if (typeof value.conversation_id === 'string') conversationId ||= value.conversation_id;
    data.push(...collectImageResults(value));
  });
  const unique = [...new Map(data.map((item) => [item.id ? `${item.kind}:${item.id}` : item.url || item.b64_json, item])).values()];
  throwIfContentPolicyRefusal(events, unique.length > 0);
  if (conversationId && !unique.some((item) => item.url || item.b64_json)) {
    const polled = await pollImageResults(account, chain, conversationId, unique);
    data = polled.results;
  } else data = unique;
  const results = [];
  for (const image of data) {
    if (image.id && image.kind === 'file') {
      const { bytes } = await requestUpstream(account, chain, `/files/download/${encodeURIComponent(image.id)}`);
      let fileInfo;
      try { fileInfo = JSON.parse(bytes.toString('utf8')); } catch { fileInfo = null; }
      if (fileInfo?.download_url || fileInfo?.url) results.push({ url: fileInfo.download_url || fileInfo.url, revised_prompt: prompt });
    } else if (image.id && image.kind === 'sediment') {
      const path = `/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(image.id)}/download`;
      const { bytes } = await requestUpstream(account, chain, path);
      let fileInfo;
      try { fileInfo = JSON.parse(bytes.toString('utf8')); } catch { fileInfo = null; }
      if (fileInfo?.download_url || fileInfo?.url) results.push({ url: fileInfo.download_url || fileInfo.url, revised_prompt: prompt });
    } else results.push({ ...image, revised_prompt: prompt });
  }
  if (!results.length) throw Object.assign(new Error('No image result was found in the ChatGPT conversation'), { status: 502 });
  return results;
}

const commonImageRatios = [
  { width: 1, height: 1 }, { width: 4, height: 3 }, { width: 3, height: 4 },
  { width: 3, height: 2 }, { width: 2, height: 3 }, { width: 16, height: 9 },
  { width: 9, height: 16 }, { width: 21, height: 9 }, { width: 9, height: 21 },
];

/** Computes a stable natural logarithm for positive integers that may exceed Number's range. */
function logPositiveInteger(value) {
  const digits = value.toString();
  const significantDigits = digits.slice(0, 15);
  return Math.log(Number(significantDigits)) + (digits.length - significantDigits.length) * Math.LN10;
}

/** Reduces a positive integer pair before ratio comparison. */
function greatestCommonDivisor(left, right) {
  while (right) [left, right] = [right, left % right];
  return left;
}

/** Parses validated size input once for both prompt guidance and SR's optional pixel target. */
export function parseImageSize(value) {
  if (value === undefined || value === '' || value === 'auto') return { instruction: '', pixelTarget: null };
  if (typeof value !== 'string') {
    throw Object.assign(new Error('size must be auto, WxH, or W:H'), { status: 400, type: 'invalid_request_error' });
  }
  const dimensions = value.match(/^(\d+)[xX](\d+)$/);
  const ratio = value.match(/^(\d+):(\d+)$/);
  const match = dimensions || ratio;
  if (!match) throw Object.assign(new Error('size must be auto, WxH, or W:H'), { status: 400, type: 'invalid_request_error' });
  const width = BigInt(match[1]);
  const height = BigInt(match[2]);
  if (width < 1n || height < 1n || (dimensions && (width > 8192n || height > 8192n))) {
    throw Object.assign(new Error('size must be auto, WxH, or W:H'), { status: 400, type: 'invalid_request_error' });
  }
  const pixelTarget = dimensions ? { width: Number(width), height: Number(height) } : null;
  const divisor = greatestCommonDivisor(width, height);
  const logRatio = logPositiveInteger(width / divisor) - logPositiveInteger(height / divisor);
  const closest = commonImageRatios.reduce((best, candidate) => {
    const distance = Math.abs(logRatio - Math.log(candidate.width / candidate.height));
    return distance < best.distance ? { ...candidate, distance } : best;
  }, { ...commonImageRatios[0], distance: Infinity });
  const label = closest.width === closest.height ? '正方形'
    : closest.width > closest.height ? '横版' : '竖版';
  return { instruction: `图片比例为${label} ${closest.width}:${closest.height}（宽:高）。`, pixelTarget };
}

/** Maps supported quality aliases to a single low, medium, or high image instruction. */
function parseImageQuality(value) {
  if (value === undefined || value === '') return '';
  const quality = typeof value === 'string' ? value.toLowerCase() : '';
  if (quality === 'auto') return '';
  const level = { low: '低', medium: '中', high: '高', standard: '中', hd: '高' }[quality];
  if (!level) {
    throw Object.assign(new Error('quality must be auto, low, medium, high, standard, or hd'), { status: 400, type: 'invalid_request_error' });
  }
  return `画面细节质量：${level}。`;
}

/**
 * Implements OpenAI-shaped image generation with 1-4 sequential upstream image jobs.
 * Size and quality become prompt instructions only; generated pixel dimensions and quality tiers are not guaranteed.
 */
/** Replaces a text message with ChatGPT multimodal pointers and matching attachment metadata. */
export function attachImageReferences(message, prompt, references) {
  message.content = { content_type: 'multimodal_text', parts: [
    ...references.map(({ fileId, width, height, sizeBytes }) => ({ content_type: 'image_asset_pointer', asset_pointer: `file-service://${fileId}`, width, height, size_bytes: sizeBytes })),
    prompt,
  ] };
  message.metadata.attachments = references.map(({ fileId, mimeType, name, sizeBytes, width, height }) => ({
    id: fileId, mimeType, name, size: sizeBytes, width, height,
  }));
  return message;
}

/** Performs ChatGPT's initialize, trusted blob PUT, and uploaded-confirmation sequence. */
export async function uploadReference(account, chain, reference, dependencies = {}) {
  const upstreamRequest = dependencies.requestUpstream || requestUpstream;
  const transport = dependencies.requestThroughProxy || requestThroughProxy;
  const { bytes } = await upstreamRequest(account, chain, '/files', {
    method: 'POST', body: JSON.stringify({ file_name: reference.name, file_size: reference.bytes.length, use_case: 'multimodal', width: reference.width, height: reference.height }),
  });
  const { upload_url: uploadUrl, file_id: fileId } = JSON.parse(bytes.toString('utf8'));
  let url;
  try { url = new URL(uploadUrl); } catch {}
  const host = url?.hostname.toLowerCase() || '';
  if (url?.protocol !== 'https:' || !(host.endsWith('.blob.core.windows.net') || host.endsWith('.oaiusercontent.com'))) {
    throw Object.assign(new Error('ChatGPT returned an unsupported image upload host'), { status: 502, type: 'upstream_error' });
  }
  if (typeof fileId !== 'string' || !fileId) throw Object.assign(new Error('ChatGPT upload response did not include file_id'), { status: 502, type: 'upstream_error' });
  const put = await transport(url, { method: 'PUT', body: reference.bytes, headers: {
    'Content-Type': reference.mimeType, 'Content-Length': String(reference.bytes.length),
    'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2020-04-08', Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/', 'User-Agent': DEFAULT_USER_AGENT,
  } }, chain);
  for await (const _chunk of put) {}
  if (put.statusCode < 200 || put.statusCode >= 300) throw Object.assign(new Error(`Image upload returned HTTP ${put.statusCode}`), { status: 502, type: 'upstream_error' });
  await upstreamRequest(account, chain, `/files/${encodeURIComponent(fileId)}/uploaded`, { method: 'POST', body: '{}' });
  return { fileId, mimeType: reference.mimeType, name: reference.name, sizeBytes: reference.bytes.length, width: reference.width, height: reference.height };
}

/** Parses OpenAI-compatible JSON or multipart edit references and validates their real image bytes. */
export function parseImageEditInput(body, contentType) {
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const parts = parseMultipart(body, contentType);
    if (parts.some((part) => part.name === 'mask')) throw Object.assign(new Error('mask is not supported'), { status: 400, type: 'invalid_request_error' });
    const fields = Object.fromEntries(parts.filter((part) => part.filename === undefined).map((part) => [part.name, part.value]));
    const files = parts.filter((part) => ['image', 'image[]'].includes(part.name) && part.filename !== undefined);
    return validateImageReferences(fields, files.map((part) => ({ bytes: part.value, name: part.filename || 'image', claimedMimeType: part.contentType })));
  }
  const payload = parseJsonBody(body);
  if (Object.hasOwn(payload, 'mask')) throw Object.assign(new Error('mask is not supported'), { status: 400, type: 'invalid_request_error' });
  const values = payload.images ?? payload.image;
  const entries = Array.isArray(values) ? values : values === undefined ? [] : [values];
  const files = entries.map((entry) => {
    const value = typeof entry === 'string' ? entry : entry?.image_url;
    if (typeof value !== 'string' || /^https?:\/\//i.test(value)) throw Object.assign(new Error('image_url must be a data: URL or base64'), { status: 400, type: 'invalid_request_error' });
    const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i);
    if (value.startsWith('data:') && !match) throw Object.assign(new Error('image_url must be a data: URL or base64'), { status: 400, type: 'invalid_request_error' });
    const bytes = Buffer.from(match ? match[2] : value, 'base64');
    return { bytes, name: 'image', claimedMimeType: match?.[1] };
  });
  return validateImageReferences(payload, files);
}

function validateImageReferences(payload, files) {
  if (files.length < 1 || files.length > 4) throw Object.assign(new Error('images must contain between 1 and 4 files'), { status: 400, type: 'invalid_request_error' });
  const references = files.map((file) => {
    if (file.bytes.length > 20 * 1024 * 1024) throw Object.assign(new Error('Each image must be 20 MB or smaller'), { status: 400, type: 'invalid_request_error' });
    let image;
    try { image = detectImage(file.bytes); } catch { throw Object.assign(new Error('Image must contain PNG, JPEG, or WebP bytes'), { status: 400, type: 'invalid_request_error' }); }
    return { ...file, mimeType: image.contentType, width: image.width, height: image.height };
  });
  return { payload, references };
}

/** Generates one to four images, uploading optional references once before all output jobs. */
export async function generateImages(account, chain, body, references = [], dependencies = {}) {
  const uploader = dependencies.uploadReference || uploadReference;
  const generator = dependencies.generateOneImage || generateOneImage;
  const model = body.model === undefined || body.model === '' ? 'gpt-image-2' : body.model;
  if (typeof model !== 'string' || !/^gpt-image-[a-z0-9._-]+$/i.test(model)) {
    throw Object.assign(new Error('model must be a gpt-image-* model'), { status: 400, type: 'invalid_request_error' });
  }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('prompt is required'), { status: 400 });
  const instructions = [parseImageSize(body.size).instruction, parseImageQuality(body.quality)].filter(Boolean).join('');
  const upstreamPrompt = instructions ? `${prompt}\n\n${instructions}` : prompt;
  const count = Number(body.n ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw Object.assign(new Error('n must be between 1 and 4'), { status: 400 });
  if (body.response_format && !['url', 'b64_json'].includes(body.response_format)) {
    throw Object.assign(new Error('response_format must be url or b64_json'), { status: 400 });
  }
  if (references.length) {
    const uploaded = [];
    for (const reference of references) uploaded.push(await uploader(account, chain, reference));
    references = uploaded;
  }
  const results = [];
  for (let i = 0; i < count; i += 1) results.push(...await generator(account, chain, upstreamPrompt, references));
  for (const item of results) item.revised_prompt = prompt;
  const data = results.slice(0, count);
  if (!data.length) throw Object.assign(new Error('No image result was found in the ChatGPT conversation'), { status: 502 });
  if ((body.response_format || 'b64_json') === 'b64_json') {
    for (const item of data) {
      if (!item.b64_json && item.url) {
        const imageUrl = signedMediaUrl(item.url);
        const sameOrigin = imageUrl.hostname === 'chatgpt.com' || imageUrl.hostname.endsWith('.chatgpt.com');
        const headers = sameOrigin
          ? { ...initialHeaders(account, 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'), Referer: 'https://chatgpt.com/' }
          : { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'User-Agent': DEFAULT_USER_AGENT, Referer: 'https://chatgpt.com/' };
        const imageResponse = await requestThroughProxy(imageUrl, { method: 'GET', headers, timeout: 180_000 }, chain);
        if (imageResponse.statusCode < 200 || imageResponse.statusCode >= 300) throw Object.assign(new Error(`Image download from ${imageUrl.hostname} returned HTTP ${imageResponse.statusCode}`), { status: 502 });
        const chunks = [];
        try {
          for await (const chunk of imageResponse) chunks.push(chunk);
        } catch (error) {
          throw Object.assign(new Error(`Image download from ${imageUrl.hostname} failed (${error.code || error.message})`), { status: 502 });
        }
        item.b64_json = Buffer.concat(chunks).toString('base64');
      }
    }
  }
  return { created: Math.floor(Date.now() / 1000), data };
}

/** Parses a bounded multipart request without converting uploaded audio bytes to text. */
function parseMultipart(buffer, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw Object.assign(new Error('Multipart boundary is missing'), { status: 400 });
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;
  while ((start = buffer.indexOf(marker, start)) >= 0) {
    start += marker.length;
    if (buffer.subarray(start, start + 2).toString() === '--') break;
    if (buffer.subarray(start, start + 2).toString() === '\r\n') start += 2;
    const next = buffer.indexOf(marker, start);
    if (next < 0) break;
    let part = buffer.subarray(start, next);
    if (part.subarray(-2).toString() === '\r\n') part = part.subarray(0, -2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('latin1');
      const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
      const name = disposition.match(/name="([^"]+)"/)?.[1];
      const filename = disposition.match(/filename="([^"]*)"/)?.[1];
      const content = part.subarray(headerEnd + 4);
      if (name) parts.push({ name, filename, contentType: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || 'application/octet-stream', value: filename === undefined ? content.toString('utf8') : content });
    }
    start = next;
  }
  return parts;
}

/** Reads only the requested size so ordinary URL responses avoid downloading image bytes. */
export function getImageRequestSize(body, contentType) {
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return parseJsonBody(body).size;
  return parseMultipart(body, contentType).find((part) => part.name === 'size')?.value;
}

/** Forces post-processing output to base64 while preserving multipart image bytes and form fields. */
export function prepareImagePostprocessBody(body, contentType) {
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    let payload;
    try { payload = parseJsonBody(body); }
    catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400, type: 'invalid_request_error' }); }
    const outputFormat = payload.response_format || 'b64_json';
    if (!['url', 'b64_json'].includes(outputFormat)) throw Object.assign(new Error('response_format must be url or b64_json'), { status: 400, type: 'invalid_request_error' });
    return { body: Buffer.from(JSON.stringify({ ...payload, response_format: 'b64_json' })), outputFormat, size: payload.size };
  }
  const parts = parseMultipart(body, contentType);
  const format = parts.find((part) => part.name === 'response_format')?.value || 'b64_json';
  if (!['url', 'b64_json'].includes(format)) throw Object.assign(new Error('response_format must be url or b64_json'), { status: 400, type: 'invalid_request_error' });
  const fields = Object.fromEntries(parts.filter((part) => part.filename === undefined).map((part) => [part.name, part.value]));
  const files = parts.filter((part) => part.filename !== undefined);
  const boundary = `----media-gateway-${randomUUID()}`;
  const chunks = [];
  for (const [name, value] of Object.entries({ ...fields, response_format: 'b64_json' })) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`), file.value, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}`, outputFormat: format, size: fields.size };
}

/** Creates a fresh multipart payload for the upstream transcription endpoint. */
function multipart(fields, file, filename, mimeType) {
  const boundary = `----media-gateway-${randomUUID()}`;
  const safeFilename = String(filename).replace(/[\r\n"\\/]/g, '_').slice(0, 150) || 'audio.bin';
  const safeMimeType = /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${safeMimeType}\r\n\r\n`));
  chunks.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

/** Forwards an audio file to ChatGPT transcription; translations omit the language hint and return upstream text. */
async function transcribe(account, chain, body, contentType, translate) {
  const parts = parseMultipart(body, contentType);
  const part = parts.find((item) => item.name === 'file' && item.filename !== undefined);
  if (!part?.value?.length) throw Object.assign(new Error('multipart field "file" is required'), { status: 400 });
  if (part.value.length > 50 * 1024 * 1024) throw Object.assign(new Error('Audio file must be 50 MB or smaller'), { status: 413 });
  const responseFormat = parts.find((item) => item.name === 'response_format')?.value || 'json';
  if (!['json', 'text', 'verbose_json'].includes(responseFormat)) {
    throw Object.assign(new Error('response_format must be json, text, or verbose_json'), { status: 400 });
  }
  const fields = {
    language: translate ? undefined : parts.find((item) => item.name === 'language')?.value,
    prompt: parts.find((item) => item.name === 'prompt')?.value?.slice(0, 1000),
  };
  const form = multipart(fields, part.value, part.filename || 'audio.bin', part.contentType);
  const { bytes, response } = await requestUpstream(account, chain, '/transcribe', {
    method: 'POST', body: form.body,
    headers: { 'Content-Type': `multipart/form-data; boundary=${form.boundary}`, Accept: 'application/json' },
  });
  const text = bytes.toString('utf8').trim();
  let value;
  if (response.headers['content-type']?.includes('application/json')) {
    try { value = JSON.parse(text); } catch {}
  }
  value ??= { text: text.replace(/^"|"$/g, '') };
  const transcript = typeof value === 'string' ? value : value.text;
  if (typeof transcript !== 'string') throw Object.assign(new Error('ChatGPT returned an invalid transcription response'), { status: 502 });
  if (responseFormat === 'text') return { text: transcript, contentType: 'text/plain; charset=utf-8' };
  if (responseFormat === 'verbose_json') return { json: { task: translate ? 'translate' : 'transcribe', language: parts.find((item) => item.name === 'language')?.value || '', duration: 0, text: transcript, segments: [], words: [] } };
  return { json: { text: transcript } };
}

/** Converts a ChatGPT conversation message to audio via the private synthesize endpoint. */
async function speech(account, chain, body) {
  if (typeof body.input !== 'string' || !body.input.trim()) throw Object.assign(new Error('input is required'), { status: 400 });
  const sentinelToken = await sentinel(account, chain);
  const payload = conversationPayload(body.input, 'auto');
  payload.messages[0].author.role = 'assistant';
  const events = await conversation(account, chain, payload, sentinelToken);
  let messageId = '';
  let conversationId = '';
  walk(events, (value) => {
    if (typeof value.conversation_id === 'string') conversationId ||= value.conversation_id;
    if (value.message?.author?.role === 'assistant' && value.message.id) messageId ||= value.message.id;
    if (value.author?.role === 'assistant' && value.id) messageId ||= value.id;
  });
  if (!messageId || !conversationId) throw Object.assign(new Error('Could not resolve the synthesis message from ChatGPT response'), { status: 502 });
  const voice = voiceMap[body.voice] || 'cove';
  const formatMap = { mp3: 'mp3', opus: 'opus', aac: 'aac', flac: 'aac', wav: 'aac', pcm: 'aac' };
  if (body.response_format && !formatMap[body.response_format]) throw Object.assign(new Error('Unsupported response_format'), { status: 400 });
  const format = formatMap[body.response_format] || 'aac';
  const query = new URLSearchParams({ message_id: messageId, conversation_id: conversationId, voice, format });
  let { bytes, response } = await requestUpstream(account, chain, `/synthesize?${query}` , { accept: 'audio/*,*/*' });
  let downloadUrl = '';
  try { const info = JSON.parse(bytes.toString('utf8')); downloadUrl = info.download_url || info.url || ''; } catch {}
  if (downloadUrl) {
    const upstream = await requestThroughProxy(signedMediaUrl(downloadUrl), { method: 'GET', headers: { Accept: 'audio/*,*/*' } }, chain);
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) throw Object.assign(new Error(`Audio download returned HTTP ${upstream.statusCode}`), { status: 502 });
    const chunks = [];
    for await (const chunk of upstream) chunks.push(chunk);
    bytes = Buffer.concat(chunks);
    response = upstream;
  }
  return { bytes, contentType: response.headers['content-type'] || 'audio/aac' };
}

/** Routes one authenticated OpenAI-shaped request to a ChatGPT protocol operation and its account proxy chain. */
export async function handleMediaRequest({ path, request, body, account, store }) {
  const chain = resolveProxyChain(store, account);
  if (path === '/v1/images/generations' || path === '/v1/images/edits') {
    if (path.endsWith('/edits')) {
      const { payload, references } = parseImageEditInput(body, request.headers['content-type'] || '');
      return { json: await generateImages(account, chain, payload, references), accountId: account.id };
    }
    const payload = parseJsonBody(body);
    return { json: await generateImages(account, chain, payload), accountId: account.id };
  }
  if (path === '/v1/audio/transcriptions' || path === '/v1/audio/translations') {
    const contentType = request.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw Object.assign(new Error('Audio uploads must use multipart/form-data'), { status: 415 });
    return { ...await transcribe(account, chain, body, contentType, path.endsWith('/translations')), accountId: account.id };
  }
  if (path === '/v1/audio/speech') {
    if (!request.headers['content-type']?.includes('application/json')) throw Object.assign(new Error('Speech requests must use application/json'), { status: 415 });
    const payload = parseJsonBody(body);
    return { binary: await speech(account, chain, payload), accountId: account.id };
  }
  throw Object.assign(new Error('Endpoint not found'), { status: 404 });
}
