import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const retrievalModeSchema = z.enum(['speed', 'balanced', 'quality']);
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;

export type RequestConfiguration = {
  mode: RetrievalMode;
};

const boundedHeader = (headers: Headers, name: string, maximum = 8_192): string => {
  const value = (headers.get(name) ?? '').trim();
  if (!value || value.length > maximum || /[\r\n]/u.test(value)) {
    throw new Error('vane_configuration_unavailable');
  }
  return value;
};

export const credentialsMatch = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export function parseRequestConfiguration(
  headers: Headers,
  serviceToken: string,
): RequestConfiguration {
  const authorization = boundedHeader(headers, 'authorization');
  if (!serviceToken || !credentialsMatch(authorization, `Bearer ${serviceToken}`)) {
    throw new Error('vane_unauthorized');
  }
  if (headers.has('x-flashyun-embedding-context') || headers.has('x-flashyun-embedding-model')) {
    throw new Error('vane_configuration_unavailable');
  }
  return {
    mode: retrievalModeSchema.parse(boundedHeader(headers, 'x-flashyun-search-mode', 32)),
  };
}
