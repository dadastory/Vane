import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRequestConfiguration } from '../src/config.js';

test('MCP accepts only a registered mode and its own service credential', () => {
  const valid = new Headers({ authorization: 'Bearer private-service-token', 'x-flashyun-search-mode': 'balanced' });
  assert.equal(parseRequestConfiguration(valid, 'private-service-token').mode, 'ordinary');
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


test('unbound search is ordinary despite a requested advanced mode', () => {
 const config = parseRequestConfiguration(new Headers({authorization: 'Bearer private-service-token', 'x-flashyun-search-mode':'quality'}), 'private-service-token');
 assert.equal(config.mode, 'ordinary');
});

test('concurrent scoped requests retain their own paired embedding credentials', () => {
 const make = (group: string, key: string) => parseRequestConfiguration(new Headers({
  authorization:'Bearer private-service-token', 'x-flashyun-search-mode':'balanced',
  'x-flashyun-embedding-model':group, 'x-flashyun-embedding-key':key,
 }), 'private-service-token');
 assert.deepEqual(make('scope-a-model', 'scope-a-key'), {mode:'balanced', embedding:{model:'scope-a-model', key:'scope-a-key'}});
 assert.deepEqual(make('scope-b-model', 'scope-b-key'), {mode:'balanced', embedding:{model:'scope-b-model', key:'scope-b-key'}});
 assert.throws(() => parseRequestConfiguration(new Headers({authorization:'Bearer private-service-token', 'x-flashyun-search-mode':'balanced', 'x-flashyun-embedding-model':'scope-a-model'}), 'private-service-token'));
});
