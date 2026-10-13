import OpenAI from 'openai';
import type { RequestConfiguration } from './config.js';

export async function embedTexts(
  baseURL: string,
  configuration: NonNullable<RequestConfiguration['embedding']>,
  texts: string[],
): Promise<number[][]> {
  const client = new OpenAI({
    baseURL: `${baseURL.replace(/\/+$/u, '')}/v1`,
    apiKey: configuration.key,
    maxRetries: 0,
    timeout: 30_000,
    fetchOptions: { redirect: 'error' },
    logLevel: 'off',
    defaultHeaders: {
      'x-litellm-spend-logs-metadata': JSON.stringify({ flashyun_service_id: 'web_search_embedding' }),
    },
  });
  try {
    const response = await client.embeddings.create({
      model: configuration.model, input: texts, encoding_format: 'float',
    });
    const data = response.data.sort((left, right) => left.index - right.index);
    const dimension = data[0]?.embedding.length ?? 0;
    if (!dimension || data.length !== texts.length || data.some((item, index) =>
      item.index !== index || item.embedding.length !== dimension || item.embedding.some((value) => !Number.isFinite(value)))) {
      throw new Error('embedding_unavailable');
    }
    return data.map((item) => item.embedding);
  } catch {
    throw new Error('embedding_unavailable');
  }
}
