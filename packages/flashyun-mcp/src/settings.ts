import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const savedSchema = z.object({
  revision: z.number().int().nonnegative(),
  mode: z.enum(['ordinary', 'advanced']),
  baseUrl: z.string(),
  model: z.string(),
  encryptedKey: z.string(),
}).strict();

export type SearchSettings = {
  mode: 'ordinary' | 'advanced';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  effective: boolean;
  revision: number;
};

export type SettingsWrite = {
  mode: 'ordinary' | 'advanced';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  expectedRevision: number;
};

const writeSchema = z.object({
  mode: z.enum(['ordinary', 'advanced']),
  baseUrl: z.string().max(2048).optional(),
  model: z.string().max(256).optional(),
  apiKey: z.string().max(8192).optional(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

type Saved = z.infer<typeof savedSchema>;

const empty = (): Saved => ({ revision: 0, mode: 'ordinary', baseUrl: '', model: '', encryptedKey: '' });

function validBaseURL(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('settings_invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('settings_invalid');
  }
  return url.toString().replace(/\/$/u, '');
}

export class SearchSettingsStore {
  private readonly key: Buffer;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string, encryptionKey: string) {
    const key = /^[a-f\d]{64}$/iu.test(encryptionKey)
      ? Buffer.from(encryptionKey, 'hex') : Buffer.from(encryptionKey, 'base64url');
    if (key.length !== 32) throw new Error('vane_settings_key_invalid');
    this.key = key;
  }

  private async load(): Promise<Saved> {
    try {
      return savedSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return empty();
      throw new Error('settings_unavailable');
    }
  }

  private public(saved: Saved): SearchSettings {
    const hasApiKey = Boolean(saved.encryptedKey);
    return {
      mode: saved.mode,
      baseUrl: saved.baseUrl,
      model: saved.model,
      hasApiKey,
      effective: saved.mode === 'advanced' && Boolean(saved.baseUrl && saved.model && hasApiKey),
      revision: saved.revision,
    };
  }

  private encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  private decrypt(value: string): string {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 29) throw new Error('settings_unavailable');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }

  async read(): Promise<SearchSettings> {
    return this.public(await this.load());
  }

  async resolve(): Promise<SearchSettings & { apiKey: string }> {
    const saved = await this.load();
    return { ...this.public(saved), apiKey: saved.encryptedKey ? this.decrypt(saved.encryptedKey) : '' };
  }

  write(input: SettingsWrite): Promise<SearchSettings> {
    const next = this.writes.then(async () => {
      const parsed = writeSchema.safeParse(input);
      if (!parsed.success) throw new Error('settings_invalid');
      const value = parsed.data;
      const current = await this.load();
      if (value.expectedRevision !== current.revision) throw new Error('settings_conflict');
      let saved: Saved;
      if (value.mode === 'ordinary') {
        saved = { ...empty(), revision: current.revision + 1 };
      } else {
        const baseUrl = validBaseURL((value.baseUrl ?? '').trim());
        const model = (value.model ?? '').trim();
        const replacement = (value.apiKey ?? '').trim();
        if (!model || model.length > 256 || /[\r\n]/u.test(model) || replacement.length > 8192 || (!replacement && !current.encryptedKey)) {
          throw new Error('settings_invalid');
        }
        saved = {
          revision: current.revision + 1,
          mode: 'advanced', baseUrl, model,
          encryptedKey: replacement ? this.encrypt(replacement) : current.encryptedKey,
        };
      }
      const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(saved), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return this.public(saved);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
}
