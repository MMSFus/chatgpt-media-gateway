import { createHash, createHmac } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

/** Builds a Tencent Cloud API v3 Authorization header for a JSON POST request. */
export function signTc3({ secretId, secretKey, service, host, action, timestamp, body }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  return `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Builds the COS v5 Authorization value from a fixed request and signing time. */
export function signCosV5({ method, path, query = new URLSearchParams(), host, secretId, secretKey, now = new Date() }) {
  const start = Math.floor(now.getTime() / 1000);
  const end = start + 3600;
  const keyTime = `${start};${end}`;
  const canonicalQuery = [...query.entries()]
    .map(([key, value]) => [key.toLowerCase(), encodeRfc3986(value)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${value}`)
    .join('&');
  const canonicalHeaders = `host=${encodeRfc3986(host.toLowerCase())}`;
  const canonicalRequest = `${method.toLowerCase()}\n${path}\n${canonicalQuery}\n${canonicalHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(canonicalRequest).digest('hex')}\n`;
  const signKey = createHmac('sha1', secretKey).update(keyTime).digest('hex');
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const queryNames = [...query.keys()].map((key) => key.toLowerCase()).sort().join(';');
  return `q-sign-algorithm=sha1&q-ak=${encodeRfc3986(secretId)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=${queryNames}&q-signature=${signature}`;
}
