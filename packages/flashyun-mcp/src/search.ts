import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import type { RequestConfiguration, RetrievalMode } from './config.js';
import { fetchPublicPage, postConfiguredJSON, validatePublicURL } from './security.js';
import type { SearchSettingsStore } from './settings.js';

export type SearchResult = { title: string; url: string; content: string };
export type SearchFinding = SearchResult & { excerpt?: string };
export type SearchOutput = {
  query: string;
  mode: RetrievalMode | 'ordinary';
  findings: SearchFinding[];
  sources: Array<{ title: string; url: string; hostname: string; description?: string }>;
};

export const retrievalBudgets = {
  speed: { searchResults: 8, pages: 0 },
  balanced: { searchResults: 16, pages: 3 },
  quality: { searchResults: 24, pages: 5 },
} as const satisfies Record<RetrievalMode, { searchResults: number; pages: number }>;

const searxngSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
    content: z.string().optional(),
  })).max(100),
});

const embeddingSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

function cosine(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

// Derived from Vane's executeSearch embedding ranking. The adapter keeps the
// upstream behavior isolated from FlashYun model routing and persistence.
export function rankResults(queryEmbedding: number[], results: SearchResult[], embeddings: number[][]): SearchResult[] {
  return results
    .map((result, index) => ({ result, score: cosine(queryEmbedding, embeddings[index] ?? []) }))
    .sort((left, right) => right.score - left.score)
    .map(({ result }) => result);
}

async function embeddings(texts: string[], settings: { baseUrl: string; model: string; apiKey: string }): Promise<number[][]> {
  const url = new URL(`${settings.baseUrl.replace(/\/$/u, '')}/embeddings`);
  const parsed = embeddingSchema.parse(await postConfiguredJSON(url, settings.apiKey, { model: settings.model, input: texts }));
  return parsed.data.sort((left, right) => left.index - right.index).map((item) => item.embedding);
}

async function discover(query: string, searxngBaseURL: string): Promise<SearchResult[]> {
  const url = new URL('/search', `${searxngBaseURL.replace(/\/$/u, '')}/`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', query);
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('search_backend_unavailable');
  const candidates = searxngSchema.parse(await response.json()).results;
  const validated = await Promise.allSettled(candidates.map(async (result) => ({
    title: result.title.trim().slice(0, 300),
    url: await validatePublicURL(result.url),
    content: (result.content ?? result.title).trim().slice(0, 2_000),
  })));
  return validated.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
}

function readableExcerpt(page: Awaited<ReturnType<typeof fetchPublicPage>>): string {
  if (page.contentType === 'text/plain') return page.body.trim().slice(0, 12_000);
  const document = new JSDOM(page.body, { url: page.url }).window.document;
  return (new Readability(document).parse()?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 12_000);
}

export async function searchWeb(
  query: string,
  config: RequestConfiguration,
  dependencies: { searxngBaseURL: string; settings: SearchSettingsStore },
): Promise<SearchOutput> {
  const normalizedQuery = query.replace(/\s+/gu, ' ').trim();
  if (!normalizedQuery || normalizedQuery.length > 1_000) throw new Error('search_query_invalid');
  const settings = await dependencies.settings.resolve().catch(() => ({
    effective: false, baseUrl: '', model: '', apiKey: '',
  }));
  const budget = retrievalBudgets[config.mode];
  if (!settings.effective) {
    const discovered = (await discover(normalizedQuery, dependencies.searxngBaseURL))
      .slice(0, retrievalBudgets.speed.searchResults);
    const findings = discovered.slice(0, 8);
    return {
      query: normalizedQuery,
      mode: 'ordinary',
      findings,
      sources: findings.map((finding) => ({
        title: finding.title,
        url: finding.url,
        hostname: new URL(finding.url).hostname,
        ...(finding.content ? { description: finding.content.slice(0, 300) } : {}),
      })),
    };
  }
  const discovered = (await discover(normalizedQuery, dependencies.searxngBaseURL))
    .slice(0, budget.searchResults);
  if (!discovered.length) return { query: normalizedQuery, mode: config.mode, findings: [], sources: [] };

  let vectors: number[][];
  try {
    vectors = await embeddings(
      [normalizedQuery, ...discovered.map((result) => `${result.title}\n${result.content}`)], settings,
    );
    if (vectors.length !== discovered.length + 1 || !vectors[0]?.length || vectors.some((vector) => vector.length !== vectors[0]?.length)) {
      throw new Error('embedding_unavailable');
    }
  } catch {
    const findings = discovered.slice(0, 8);
    return {
      query: normalizedQuery, mode: 'ordinary', findings,
      sources: findings.map((finding) => ({
        title: finding.title, url: finding.url, hostname: new URL(finding.url).hostname,
        ...(finding.content ? { description: finding.content.slice(0, 300) } : {}),
      })),
    };
  }
  const ranked = rankResults(vectors[0] ?? [], discovered, vectors.slice(1));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  const findings: SearchFinding[] = ranked.slice(0, Math.max(8, budget.pages));
  try {
    const pages = await Promise.allSettled(
      findings.slice(0, budget.pages).map(async (finding) => ({
        url: finding.url,
        excerpt: readableExcerpt(await fetchPublicPage(finding.url, controller.signal)),
      })),
    );
    for (const page of pages) {
      if (page.status !== 'fulfilled' || !page.value.excerpt) continue;
      const finding = findings.find((candidate) => candidate.url === page.value.url);
      if (finding) finding.excerpt = page.value.excerpt;
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    query: normalizedQuery,
    mode: config.mode,
    findings,
    sources: findings.map((finding) => ({
      title: finding.title,
      url: finding.url,
      hostname: new URL(finding.url).hostname,
      ...(finding.content ? { description: finding.content.slice(0, 300) } : {}),
    })),
  };
}
