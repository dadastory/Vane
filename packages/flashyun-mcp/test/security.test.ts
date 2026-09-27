import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicAddress, assertPublicURL, validatePublicURL } from '../src/security.js';

test('outbound policy rejects local and metadata destinations', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1']) {
    assert.throws(() => assertPublicAddress(address));
  }
  assert.doesNotThrow(() => assertPublicAddress('1.1.1.1'));
});

test('outbound policy accepts only public http and https URLs', () => {
  assert.throws(() => assertPublicURL(new URL('file:///etc/passwd')));
  assert.throws(() => assertPublicURL(new URL('http://localhost/private')));
  assert.doesNotThrow(() => assertPublicURL(new URL('https://example.com/page')));
});

test('outbound policy validates public DNS before a result can be projected', async () => {
  await assert.rejects(validatePublicURL('http://localhost.example.invalid/result'));
});
