import net, { isIP } from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';

const schemeMap = new Map([
  ['http:', 'http'], ['https:', 'https'], ['socks5:', 'socks5'], ['socks5h:', 'socks5'],
]);

/** Parses an admin proxy URL without exposing credentials in errors; socks5 resolves locally and socks5h remotely. */
export function parseProxy(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Proxy URL is invalid'); }
  const protocol = schemeMap.get(url.protocol);
  if (!protocol || !url.hostname) throw new Error('Proxy URL scheme must be http, https, socks5, or socks5h');
  return {
    protocol,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    remoteDns: url.protocol === 'socks5h:',
    port: Number(url.port || (protocol === 'https' ? 443 : protocol === 'socks5' ? 1080 : 80)),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

/** Resolves the global egress chain first, then account override or default hops, rejecting loops. */
export function resolveProxyChain(store, account) {
  const settings = store.settings();
  const proxies = new Map(store.listProxies().map((item) => [item.id, item]));
  const route = [];
  const seen = new Set();
  const append = (id) => {
    let current = id;
    while (current) {
      if (seen.has(current)) throw new Error('Proxy chain contains a cycle or duplicate hop');
      const proxy = proxies.get(current);
      if (!proxy) throw new Error(`Proxy ${current} does not exist`);
      seen.add(current);
      parseProxy(proxy.url);
      route.push(proxy);
      current = proxy.nextProxyId;
    }
  };
  append(settings.exitProxyId);
  append(account?.proxy_id || settings.defaultProxyId);
  return route;
}

/** Resolves a service-specific proxy selector, defaulting to global egress when it is unset. */
export function resolveServiceProxyChain(store, settingValue) {
  const settings = store.settings();
  const proxies = new Map(store.listProxies().map((item) => [item.id, item]));
  const route = [];
  const seen = new Set();
  let current = settingValue === undefined || settingValue === null ? settings.exitProxyId : settingValue === 'direct' ? null : settingValue;
  while (current) {
    if (seen.has(current)) throw new Error('Proxy chain contains a cycle or duplicate hop');
    const proxy = proxies.get(current);
    if (!proxy) throw new Error(`Proxy ${current} does not exist`);
    seen.add(current);
    parseProxy(proxy.url);
    route.push(proxy);
    current = proxy.nextProxyId;
  }
  return route;
}

/** Resolves the global egress chain for services using the default routing policy. */
export function resolveExitProxyChain(store) {
  return resolveServiceProxyChain(store, null);
}

/** Resolves on a socket readiness event and removes temporary event listeners on either outcome. */
function onceConnect(socket, event) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onReady = () => { cleanup(); resolve(socket); };
    const cleanup = () => { socket.off('error', onError); socket.off(event, onReady); };
    socket.once('error', onError);
    socket.once(event, onReady);
  });
}

/** Connects to the first hop and negotiates TLS when the proxy URL uses HTTPS. */
async function connectProxy(proxy) {
  const socket = net.connect(proxy.port, proxy.host);
  await onceConnect(socket, 'connect');
  socket.setTimeout(15000, () => socket.destroy(new Error('Proxy handshake timed out')));
  return proxy.protocol === 'https' ? wrapTls(socket, proxy.host) : socket;
}

/** Wraps an already-tunneled socket in TLS for an HTTPS proxy or final HTTPS destination. */
function wrapTls(socket, servername) {
  const secure = tls.connect({ socket, ...(isIP(servername) ? {} : { servername }) });
  secure.setTimeout(15000, () => secure.destroy(new Error('TLS handshake timed out')));
  return onceConnect(secure, 'secureConnect');
}

/** Reads exactly length bytes without consuming later protocol bytes and names a closed handshake stage. */
function readExact(socket, length, stage = 'proxy negotiation') {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('readable', onReadable); socket.off('error', onError); socket.off('end', onEnd); };
    const onError = (error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error(`Proxy closed the connection during ${stage}`)); };
    const onReadable = () => {
      const value = socket.read(length);
      if (value !== null) { cleanup(); resolve(value); }
    };
    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('end', onEnd);
    onReadable();
  });
}

/** Opens an HTTP CONNECT tunnel to the next proxy or final destination using optional Basic proxy auth. */
async function connectHttpProxy(socket, proxy, host, port) {
  const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const auth = proxy.username || proxy.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
    : '';
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}Connection: keep-alive\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (!response.includes('\r\n\r\n')) {
    response = Buffer.concat([response, await readExact(socket, 1, 'HTTP CONNECT response header')]);
    if (response.length > 16384) throw new Error('Proxy CONNECT response is too large');
  }
  const headerEnd = response.indexOf('\r\n\r\n') + 4;
  const statusLine = response.subarray(0, headerEnd).toString('latin1').split('\r\n', 1)[0];
  if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) throw new Error(`Proxy CONNECT failed: ${statusLine}`);
  if (response.length > headerEnd) socket.unshift(response.subarray(headerEnd));
}

/** Negotiates SOCKS5 auth and CONNECT; destination DNS follows socks5 versus socks5h URL semantics. */
async function connectSocks5(socket, proxy, host, port) {
  const peer = `${proxy.host}:${proxy.port}`;
  const hasAuth = proxy.username || proxy.password;
  const methods = hasAuth ? [0, 2] : [0];
  socket.write(Buffer.from([5, methods.length, ...methods]));
  const method = await readExact(socket, 2, `SOCKS5 authentication-method negotiation at ${peer}`);
  if (method[0] !== 5 || method[1] === 255) throw new Error('SOCKS5 proxy rejected authentication methods');
  if (method[1] === 2) {
    const user = Buffer.from(proxy.username);
    const pass = Buffer.from(proxy.password);
    if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 credentials are too long');
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const authReply = await readExact(socket, 2, `SOCKS5 authentication response at ${peer}`);
    if (authReply[1] !== 0) throw new Error('SOCKS5 authentication failed');
  } else if (method[1] !== 0) {
    throw new Error(`SOCKS5 proxy selected unsupported auth method ${method[1]}`);
  }

  let cleanHost = host.replace(/^\[|\]$/g, '');
  if (!proxy.remoteDns && !net.isIP(cleanHost)) cleanHost = (await lookup(cleanHost)).address;
  const address = net.isIP(cleanHost) === 4
    ? Buffer.concat([Buffer.from([1]), Buffer.from(cleanHost.split('.').map(Number))])
    : net.isIP(cleanHost) === 6
      ? Buffer.concat([Buffer.from([4]), ipv6Bytes(cleanHost)])
      : Buffer.concat([Buffer.from([3, Buffer.byteLength(cleanHost)]), Buffer.from(cleanHost)]);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]));
  const reply = await readExact(socket, 4, `SOCKS5 CONNECT response at ${peer}`);
  if (reply[1] !== 0) throw new Error(`SOCKS5 connect failed with code ${reply[1]}`);
  const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await readExact(socket, 1, `SOCKS5 bind address length at ${peer}`))[0];
  await readExact(socket, addressLength + 2, `SOCKS5 bind address at ${peer}`);
}

/** Encodes a normalized IPv6 literal into the 16-byte address form required by SOCKS5. */
function ipv6Bytes(host) {
  const halves = host.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.from(words.flatMap((part) => {
    const value = Number.parseInt(part || '0', 16);
    return [value >> 8, value & 255];
  }));
}

/** Builds nested proxy tunnels in listed order; the caller wraps the final socket in destination TLS if needed. */
async function tunnel(proxies, host, port) {
  if (!proxies.length) return net.connect(port, host);
  let socket = await connectProxy(parseProxy(proxies[0].url));
  try {
    for (let i = 0; i < proxies.length; i += 1) {
      const current = parseProxy(proxies[i].url);
      const next = proxies[i + 1] ? parseProxy(proxies[i + 1].url) : null;
      const targetHost = next?.host || host;
      const targetPort = next?.port || port;
      if (current.protocol === 'socks5') await connectSocks5(socket, current, targetHost, targetPort);
      else await connectHttpProxy(socket, current, targetHost, targetPort);
      if (next?.protocol === 'https') socket = await wrapTls(socket, next.host);
    }
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Creates the protocol-matched HTTP(S) agent with one fresh tunnel per upstream operation. */
function createChainedAgent(proxies, secure) {
  const BaseAgent = secure ? https.Agent : http.Agent;
  return new class extends BaseAgent {
    constructor() {
      super({ keepAlive: false });
      this.proxies = proxies;
      this.secure = secure;
    }

    /** Supplies the preconnected tunnel socket; destination TLS is added after all proxy hops. */
    createConnection(options, callback) {
      tunnel(this.proxies, options.hostname || options.host, Number(options.port || (this.secure ? 443 : 80)))
        .then((socket) => this.secure ? wrapTls(socket, options.servername || options.hostname || options.host) : socket)
        .then((socket) => callback(null, socket), callback);
    }
  }();
}

/** Performs one HTTP/1.1 request over a fresh proxy chain; response bodies remain stream-readable. */
export function requestThroughProxy(url, options, proxyChain) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  if (!secure && target.protocol !== 'http:') throw new Error('Only HTTP and HTTPS targets are supported');
  const agent = createChainedAgent(proxyChain, secure);
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, { ...options, agent }, (response) => {
      response.once('close', () => agent.destroy());
      resolve(response);
    });
    request.once('error', (error) => { agent.destroy(); reject(error); });
    request.setTimeout(options.timeout || 60000, () => request.destroy(new Error('Upstream request timed out')));
    if (options.body) request.write(options.body);
    request.end();
  });
}
