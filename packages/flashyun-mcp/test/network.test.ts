import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { parseSearchNetwork, searchNetworkHeaders } from '../src/network.js';
import { fetchPublicPage } from '../src/security.js';

test('private network headers admit HTTP/HTTPS, redact neither into MCP output nor model arguments', () => {
  for (const url of ['http://proxy.internal:8080', 'https://proxy.internal:8443']) {
    const value = {
      enabled: true,
      url,
      username: 'u@ser',
      password: 'p:/?#',
      insecureSkipVerify: true,
      revision: '3',
    };
    const network = parseSearchNetwork(Buffer.from(JSON.stringify(value)).toString('base64url'));
    assert.equal(network.password, 'p:/?#');
    assert.equal(network.revision, 3);
    assert.equal(searchNetworkHeaders(network, 'token')['X-FlashYun-Network-Token'], 'token');
  }
  for (const value of [
    { unavailable: true },
    { enabled: true, url: 'socks5://proxy:1080' },
    { enabled: true, url: 'http://user:secret@host' },
    { enabled: true, url: 'https://proxy/path' },
  ]) {
    assert.throws(() =>
      parseSearchNetwork(Buffer.from(JSON.stringify(value)).toString('base64url')),
    );
  }
});
test('native proxy sends auth only to proxy, pins public CONNECT and still blocks private destinations', {
  timeout: 10000,
}, async () => {
  const originalLookup = dnsPromises.lookup;
  mock.method(dnsPromises, 'lookup', async (hostname: string, options: unknown) =>
    hostname === 'evidence.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : originalLookup(hostname, options as never),
  );
  syncBuiltinESMExports();
  const target = createServer((req, res) => {
    assert.equal(req.headers.host, 'evidence.example');
    assert.equal(req.headers['proxy-authorization'], undefined);
    res.setHeader('content-type', 'text/plain');
    res.end('proxied evidence');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const address = target.address();
  assert(address && typeof address === 'object');
  const tunnels: string[] = [];
  const proxy = createServer();
  const sockets = new Set<import('node:net').Socket>();
  proxy.on('connect', (req, socket, head) => {
    sockets.add(socket);
    assert.equal(
      req.headers['proxy-authorization'],
      `Basic ${Buffer.from('name:secret').toString('base64')}`,
    );
    tunnels.push(req.url ?? '');
    const upstream = connect(address.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress === 'object');
  const network = {
    enabled: true,
    url: `http://127.0.0.1:${proxyAddress.port}`,
    username: 'name',
    password: 'secret',
    insecureSkipVerify: false,
    revision: 1,
  };
  try {
    const result = await fetchPublicPage(
      'http://evidence.example/evidence',
      AbortSignal.timeout(5000),
      network,
    );
    assert.equal(result.body, 'proxied evidence');
    assert.deepEqual(tunnels, ['93.184.216.34:80']);
    await assert.rejects(
      fetchPublicPage('http://127.0.0.1/private', AbortSignal.timeout(5000), network),
    );
    assert.equal(tunnels.length, 1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  }
});
