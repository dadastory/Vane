import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SearchSettingsStore } from '../src/settings.js';

test('settings survive restart, redact the key, and enforce revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashyun-vane-settings-'));
  try {
    const path = join(directory, 'settings.json');
    const key = 'a'.repeat(64);
    const first = new SearchSettingsStore(path, key);
    assert.deepEqual(await first.read(), { mode: 'ordinary', baseUrl: '', model: '', hasApiKey: false, effective: false, revision: 0 });
    const saved = await first.write({ mode: 'advanced', baseUrl: 'https://yibuapi.com/v1', model: 'qwen3-embedding-4b', apiKey: 'private-provider-key', expectedRevision: 0 });
    assert.equal(saved.effective, true);
    assert.equal(saved.hasApiKey, true);
    assert.equal(JSON.stringify(saved).includes('private-provider-key'), false);
    assert.equal((await readFile(path, 'utf8')).includes('private-provider-key'), false);
    const reloaded = new SearchSettingsStore(path, key);
    assert.equal((await reloaded.read()).revision, 1);
    assert.equal((await reloaded.resolve()).apiKey, 'private-provider-key');
    await assert.rejects(() => reloaded.write({ mode: 'ordinary', expectedRevision: 0 }), /settings_conflict/u);
    assert.equal((await reloaded.write({ mode: 'ordinary', expectedRevision: 1 })).effective, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('administrator may configure a private HTTP embedding endpoint without leaking its key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashyun-vane-private-'));
  try {
    const store = new SearchSettingsStore(join(directory, 'settings.json'), 'b'.repeat(64));
    const saved = await store.write({
      mode: 'advanced', baseUrl: 'http://embedding.internal:8088/v1',
      model: 'local-embedding', apiKey: 'private-key', expectedRevision: 0,
    });
    assert.equal(saved.baseUrl, 'http://embedding.internal:8088/v1');
    assert.equal(saved.effective, true);
    assert.equal(JSON.stringify(saved).includes('private-key'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
