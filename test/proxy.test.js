import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { parseProxy, requestThroughProxy, resolveExitProxyChain, resolveProxyChain, resolveServiceProxyChain } from '../src/proxy.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function readSocket(socket, length) {
  return new Promise((resolve, reject) => {
    const onReadable = () => {
      const value = socket.read(length);
      if (value !== null) { cleanup(); resolve(value); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => { socket.off('readable', onReadable); socket.off('error', onError); };
    socket.on('readable', onReadable);
    socket.once('error', onError);
    onReadable();
  });
}

function connectProxy() {
  const targets = [];
  const server = http.createServer();
  server.on('connect', (request, client, head) => {
    const [host, portText] = request.url.split(':');
    const port = Number(portText);
    targets.push(port);
    const upstream = net.connect(port, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
  });
  return { server, targets };
}

test('parseProxy accepts supported schemes and rejects unsupported ones', () => {
  assert.equal(parseProxy('socks5h://user:pass@127.0.0.1:1080').protocol, 'socks5');
  assert.equal(parseProxy('https://proxy.example').port, 443);
  assert.throws(() => parseProxy('ftp://proxy.example'));
});

test('resolveProxyChain uses global egress first, then account override or default and their next hops', () => {
  const items = [
    { id: 'default', url: 'http://127.0.0.1:9001', nextProxyId: null },
    { id: 'account', url: 'http://127.0.0.1:9002', nextProxyId: 'relay' },
    { id: 'relay', url: 'socks5://127.0.0.1:9003', nextProxyId: null },
    { id: 'exit', url: 'https://127.0.0.1:9004', nextProxyId: null },
  ];
  const store = { settings: () => ({ defaultProxyId: 'default', exitProxyId: 'exit' }), listProxies: () => items };
  assert.deepEqual(resolveProxyChain(store, { proxy_id: 'account' }).map((item) => item.id), ['exit', 'account', 'relay']);
  assert.deepEqual(resolveProxyChain(store, null).map((item) => item.id), ['exit', 'default']);
  assert.throws(() => resolveProxyChain({ ...store, listProxies: () => [...items, { id: 'loop', url: 'http://127.0.0.1', nextProxyId: 'loop' }] }, { proxy_id: 'loop' }), /cycle/);
});

test('resolveExitProxyChain excludes account and default proxies', () => {
  const items = [
    { id: 'default', url: 'http://127.0.0.1:9001', nextProxyId: null },
    { id: 'exit', url: 'http://127.0.0.1:9002', nextProxyId: 'relay' },
    { id: 'relay', url: 'socks5://127.0.0.1:9003', nextProxyId: null },
  ];
  const store = { settings: () => ({ defaultProxyId: 'default', exitProxyId: 'exit' }), listProxies: () => items };
  assert.deepEqual(resolveExitProxyChain(store).map((item) => item.id), ['exit', 'relay']);
  assert.deepEqual(resolveExitProxyChain({ ...store, settings: () => ({ defaultProxyId: 'default', exitProxyId: null }) }), []);
});

test('resolveServiceProxyChain supports global fallback, direct, and service-only routes', () => {
  const items = [
    { id: 'exit', url: 'http://127.0.0.1:9001', nextProxyId: 'relay' },
    { id: 'relay', url: 'http://127.0.0.1:9002', nextProxyId: null },
    { id: 'service', url: 'http://127.0.0.1:9003', nextProxyId: 'relay' },
  ];
  const store = { settings: () => ({ exitProxyId: 'exit' }), listProxies: () => items };
  assert.deepEqual(resolveServiceProxyChain(store, undefined).map((item) => item.id), ['exit', 'relay']);
  assert.deepEqual(resolveServiceProxyChain(store, 'direct'), []);
  assert.deepEqual(resolveServiceProxyChain(store, 'service').map((item) => item.id), ['service', 'relay']);
});

test('HTTP requests travel through a two-hop CONNECT chain', async (t) => {
  const target = http.createServer((request, response) => response.end('through-chain'));
  const targetPort = await listen(target);
  const second = connectProxy();
  const secondPort = await listen(second.server);
  const first = connectProxy();
  const firstPort = await listen(first.server);
  t.after(() => { target.close(); first.server.close(); second.server.close(); });

  const response = await requestThroughProxy(`http://127.0.0.1:${targetPort}/health`, {}, [
    { url: `http://127.0.0.1:${firstPort}` },
    { url: `http://127.0.0.1:${secondPort}` },
  ]);
  let body = '';
  for await (const chunk of response) body += chunk;
  assert.equal(body, 'through-chain');
  assert.deepEqual(first.targets, [secondPort]);
  assert.deepEqual(second.targets, [targetPort]);
});

test('HTTPS requests use an HTTPS-compatible agent before starting TLS', async (t) => {
  const target = http.createServer((request, response) => response.end('plain-http'));
  const targetPort = await listen(target);
  t.after(() => target.close());

  await assert.rejects(
    requestThroughProxy(`https://127.0.0.1:${targetPort}/health`, { rejectUnauthorized: false }, []),
    (error) => {
      assert.doesNotMatch(error.message, /Protocol "https:" not supported/);
      return true;
    },
  );
});

test('credentialed SOCKS5 proxies negotiate username/password alongside no-auth', async (t) => {
  const server = net.createServer(async (socket) => {
    try {
      const greeting = await readSocket(socket, 2);
      assert.deepEqual([...await readSocket(socket, greeting[1])], [0, 2]);
      socket.write(Buffer.from([5, 2]));
      const auth = await readSocket(socket, 2);
      const username = await readSocket(socket, auth[1]);
      const passwordLength = (await readSocket(socket, 1))[0];
      const password = await readSocket(socket, passwordLength);
      assert.equal(username.toString(), 'user');
      assert.equal(password.toString(), 'pass');
      socket.write(Buffer.from([1, 0]));

      const request = await readSocket(socket, 5);
      assert.deepEqual([...request.subarray(0, 4)], [5, 1, 0, 3]);
      const host = await readSocket(socket, request[4]);
      const port = await readSocket(socket, 2);
      assert.equal(host.toString(), 'example.com');
      assert.equal(port.readUInt16BE(), 80);
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));

      let body = '';
      socket.on('data', (chunk) => {
        body += chunk.toString();
        if (body.includes('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\npassed');
      });
    } catch (error) {
      socket.destroy(error);
    }
  });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await requestThroughProxy('http://example.com/health', {}, [
    { url: `socks5h://user:pass@127.0.0.1:${port}` },
  ]);
  let body = '';
  for await (const chunk of response) body += chunk;
  assert.equal(body, 'passed');
});
