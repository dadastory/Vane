import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, type Dispatcher, request } from 'undici';

const MAX_REDIRECTS = 4;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export function assertPublicAddress(address: string): void {
  const parsed = ipaddr.process(address);
  if (parsed.range() !== 'unicast') throw new Error('web_content_unavailable');
}

export function assertPublicURL(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('web_content_unavailable');
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('web_content_unavailable');
  }
  if (ipaddr.isValid(hostname)) assertPublicAddress(hostname);
}

async function publicAddresses(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  const result = answers.map(({ address, family }) => {
    assertPublicAddress(address);
    return { address, family: family === 6 ? 6 as const : 4 as const };
  });
  if (!result.length) throw new Error('web_content_unavailable');
  return result;
}

export async function validatePublicURL(input: string): Promise<string> {
  const url = new URL(input);
  assertPublicURL(url);
  await publicAddresses(url.hostname);
  return url.toString();
}

async function pinnedAgent(url: URL): Promise<Dispatcher> {
  const answers = await publicAddresses(url.hostname);
  let index = 0;
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) {
          (callback as unknown as (error: Error | null, addresses: typeof answers) => void)(null, answers);
          return;
        }
        const family = typeof options === 'object' ? options.family : options;
        const matching = family === 4 || family === 6 ? answers.filter((answer) => answer.family === family) : answers;
        const answer = matching[index % matching.length];
        index += 1;
        if (!answer) return callback(new Error('web_content_unavailable'), '', 4);
        callback(null, answer.address, answer.family);
      },
    },
  });
}

// This endpoint is selected only by a system administrator. Unlike model-
// discovered public pages, it may be hosted on the deployment's private LAN.
export async function postConfiguredJSON(url: URL, authorization: string, body: unknown): Promise<unknown> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('embedding_unavailable');
  const dispatcher = new Agent();
  try {
    const response = await request(url, {
      dispatcher, method: 'POST',
      headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), headersTimeout: 15_000, bodyTimeout: 30_000,
    });
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new Error('embedding_unavailable');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 4 * 1024 * 1024) throw new Error('embedding_unavailable');
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await dispatcher.close();
  }
}

export type PublicPage = { url: string; contentType: string; body: string };

export async function fetchPublicPage(input: string, signal?: AbortSignal): Promise<PublicPage> {
  let current = new URL(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertPublicURL(current);
    const dispatcher = await pinnedAgent(current);
    try {
      const response = await request(current, {
        dispatcher,
        ...(signal ? { signal } : {}),
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
          'user-agent': 'FlashYun-Vane/1.0',
        },
        headersTimeout: 10_000,
        bodyTimeout: 15_000,
      });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        await response.body.dump();
        if (!location || redirects === MAX_REDIRECTS) throw new Error('web_content_unavailable');
        current = new URL(Array.isArray(location) ? location[0] ?? '' : location, current);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump();
        throw new Error('web_content_unavailable');
      }
      const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) {
        await response.body.dump();
        throw new Error('web_content_unavailable');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_PAGE_BYTES) throw new Error('web_content_unavailable');
        chunks.push(buffer);
      }
      return { url: current.toString(), contentType, body: Buffer.concat(chunks).toString('utf8') };
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error('web_content_unavailable');
}
