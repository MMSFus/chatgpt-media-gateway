import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { requestThroughProxy, resolveServiceProxyChain } from './proxy.js';
import { signCosV5, signTc3 } from './tencent-signing.js';

async function readResponse(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function xmlError(body) {
  const source = body.toString('utf8');
  const find = (name) => source.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1]
    ?.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
  return { code: find('Code') || 'COS_HTTP_ERROR', message: find('Message') || source.slice(0, 500) };
}

function tencentFailure(step, code, message, requestId = 'unavailable') {
  const redact = (value) => [config.tencentSecretId, config.tencentSecretKey]
    .filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value));
  const error = new Error(`${step} failed: Tencent Cloud ${redact(code)}: ${redact(message)}; RequestId: ${redact(requestId)}`);
  error.status = 502;
  error.type = 'upstream_error';
  return error;
}

export function detectImage(bytes) {
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { extension: 'webp', contentType: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      return { extension: 'webp', contentType: 'image/webp', width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10) };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { extension: 'webp', contentType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    throw new Error('Image WebP dimensions are missing');
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR') {
      return { extension: 'png', contentType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    throw new Error('Image PNG dimensions are missing');
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // Node has no built-in image header parser, so walk JPEG segments to find a SOF dimension record.
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof && segmentLength >= 7) {
        return { extension: 'jpg', contentType: 'image/jpeg', height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += segmentLength;
    }
    throw new Error('Image JPEG dimensions are missing');
  }
  throw new Error('Image must contain PNG, JPEG, or WebP bytes');
}

export function requireTencentConfiguration() {
  if (!config.tencentSecretId || !config.tencentSecretKey || !/^.+-\d+$/.test(config.tencentCosBucket)) {
    throw Object.assign(new Error('Tencent Cloud post-processing is not configured'), { status: 503, type: 'unavailable_error' });
  }
}

async function enhanceImage(bytes, proxyChain) {
  const step = 'CR';
  const host = new URL(config.tencentTiiaBaseUrl).host;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ ImageBase64: bytes.toString('base64') });
  const authorization = signTc3({
    secretId: config.tencentSecretId, secretKey: config.tencentSecretKey,
    service: 'tiia', host, action: 'EnhanceImage', version: '2019-05-29',
    timestamp, body,
  });
  try {
    const response = await requestThroughProxy(config.tencentTiiaBaseUrl, {
      method: 'POST', timeout: 120000,
      headers: {
        Authorization: authorization, 'Content-Type': 'application/json; charset=utf-8',
        Host: host, 'X-TC-Action': 'EnhanceImage', 'X-TC-Version': '2019-05-29',
        'X-TC-Region': config.tencentRegion, 'X-TC-Timestamp': String(timestamp),
        'Content-Length': String(Buffer.byteLength(body)),
      }, body,
    }, proxyChain);
    const responseBody = await readResponse(response);
    let value;
    try { value = JSON.parse(responseBody.toString('utf8')).Response; } catch {}
    if (response.statusCode < 200 || response.statusCode >= 300 || value?.Error) {
      throw tencentFailure(step, value?.Error?.Code || `HTTP_${response.statusCode}`, value?.Error?.Message || 'Invalid Tencent Cloud response', value?.RequestId);
    }
    if (!value?.EnhancedImage) throw tencentFailure(step, 'INVALID_RESPONSE', 'EnhancedImage is missing', value?.RequestId);
    return Buffer.from(value.EnhancedImage, 'base64');
  } catch (error) {
    if (error.status) throw error;
    throw tencentFailure(step, error.code || 'NETWORK_ERROR', error.message, 'unavailable');
  }
}

function cosEndpoint() {
  const bucket = config.tencentCosBucket;
  const host = `${bucket}.cos.${config.tencentRegion}.myqcloud.com`;
  return new URL(config.tencentCosBaseUrl || `https://${host}`);
}

async function cosRequest({ method, key, query = new URLSearchParams(), body, contentType }, proxyChain) {
  const endpoint = cosEndpoint();
  const path = `/${key.split('/').map(encodeURIComponent).join('/')}`;
  const url = new URL(path, endpoint);
  url.search = query.toString();
  const authorization = signCosV5({
    method, path, query, host: endpoint.host,
    secretId: config.tencentSecretId, secretKey: config.tencentSecretKey,
  });
  const response = await requestThroughProxy(url, {
    method, timeout: 180000,
    headers: {
      Host: endpoint.host, Authorization: authorization,
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...(body ? { 'Content-Length': String(body.length) } : {}),
    }, body,
  }, proxyChain);
  const bytes = await readResponse(response);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const value = xmlError(bytes);
    throw tencentFailure('SR', value.code, value.message, response.headers['x-cos-request-id'] || 'unavailable');
  }
  return { bytes, requestId: response.headers['x-cos-request-id'] || 'unavailable' };
}

async function superResolve(bytes, proxyChain, targetSize) {
  const step = 'SR';
  const { extension, contentType, width, height } = detectImage(bytes);
  if (!targetSize) {
    console.log(`SR decision=skip reason=no-pixel-target before=${width}x${height} after=${width}x${height}`);
    return bytes;
  }
  const ratio = Math.max(targetSize.width / width, targetSize.height / height);
  if (ratio <= 1.25) {
    console.log(`SR decision=skip reason=within-tolerance before=${width}x${height} after=${width}x${height}`);
    return bytes;
  }
  const magnify = ratio <= 2 ? 2 : 4;
  const key = `cmg-tmp/${randomUUID()}.${extension}`;
  let primaryError;
  try {
    await cosRequest({ method: 'PUT', key, body: bytes, contentType }, proxyChain);
    const query = new URLSearchParams([['ci-process', 'AISuperResolution'], ['magnify', String(magnify)]]);
    const result = await cosRequest({ method: 'GET', key, query }, proxyChain);
    const { width: afterWidth, height: afterHeight } = detectImage(result.bytes);
    console.log(`SR decision=magnify=${magnify} before=${width}x${height} after=${afterWidth}x${afterHeight}`);
    return result.bytes;
  } catch (error) {
    primaryError = error.status ? error : tencentFailure(step, error.code || 'NETWORK_ERROR', error.message);
    throw primaryError;
  } finally {
    try { await cosRequest({ method: 'DELETE', key }, proxyChain); }
    catch (error) {
      console.error(`SR temporary object cleanup failed (${error.message})`);
    }
  }
}

/** Applies requested image operations sequentially; each step receives the previous step's bytes. */
export async function processImage(bytes, steps, store, targetSize) {
  requireTencentConfiguration();
  let result = bytes;
  let chain;
  try { chain = resolveServiceProxyChain(store, store.settings().tencentProxyId); }
  catch (error) { throw Object.assign(error, { status: 502, type: 'upstream_error' }); }
  for (const step of steps) {
    result = step === 'SR' ? await superResolve(result, chain, targetSize) : await enhanceImage(result, chain);
    try { detectImage(result); }
    catch (error) { throw tencentFailure(step, 'INVALID_IMAGE', error.message); }
  }
  return result;
}

