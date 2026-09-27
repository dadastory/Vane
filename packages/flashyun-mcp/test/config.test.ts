import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRequestConfiguration } from '../src/config.js';

test('MCP accepts only a registered mode and its own service credential', () => {
  const valid = new Headers({ authorization: 'Bearer private-service-token', 'x-flashyun-search-mode': 'balanced' });
  assert.equal(parseRequestConfiguration(valid, 'private-service-token').mode, 'balanced');
  assert.throws(() => parseRequestConfiguration(new Headers({ authorization: 'Bearer private-service-token', 'x-flashyun-search-mode': 'custom' }), 'private-service-token'));
  assert.throws(() => parseRequestConfiguration(valid, 'different-token'));
});

test('MCP rejects the retired embedding credential headers', () => {
  const headers = new Headers({
    authorization: 'Bearer private-service-token',
    'x-flashyun-search-mode': 'speed',
    'x-flashyun-embedding-context': 'old-context',
  });
  assert.throws(() => parseRequestConfiguration(headers, 'private-service-token'));
});
