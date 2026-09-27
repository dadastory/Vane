import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { postConfiguredJSON } from '../src/security.js';

test('configured embedding sends the key only to the administrator endpoint', async () => {
  let receivedKey = '';
  const server = createServer(async (request, response) => {
    receivedKey = request.headers.authorization ?? '';
    assert.equal(request.url, '/v1/embeddings');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server unavailable');
    const result = await postConfiguredJSON(new URL(`http://127.0.0.1:${address.port}/v1/embeddings`), 'private-key', { model: 'local', input: ['query'] });
    assert.equal(receivedKey, 'Bearer private-key');
    assert.deepEqual(result, { data: [{ index: 0, embedding: [1, 0] }] });
  } finally {
    server.close();
  }
});

test('configured embedding does not forward the key across redirects', async () => {
  let redirected = false;
  const destination = createServer((_request, response) => {
    redirected = true;
    response.end();
  });
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const source = createServer((_request, response) => {
    const target = destination.address();
    if (!target || typeof target === 'string') throw new Error('test server unavailable');
    response.writeHead(307, { location: `http://127.0.0.1:${target.port}/v1/embeddings` });
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  try {
    const address = source.address();
    if (!address || typeof address === 'string') throw new Error('test server unavailable');
    await assert.rejects(() => postConfiguredJSON(new URL(`http://127.0.0.1:${address.port}/v1/embeddings`), 'private-key', { model: 'local', input: ['query'] }), /embedding_unavailable/u);
    assert.equal(redirected, false);
  } finally {
    source.close();
    destination.close();
  }
});
