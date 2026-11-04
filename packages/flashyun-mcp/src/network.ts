import { z } from 'zod';

export const searchNetworkSchema = z
  .object({
    enabled: z.boolean(),
    url: z.string().max(2048).default(''),
    username: z.string().max(320).default(''),
    password: z.string().max(2048).default(''),
    insecureSkipVerify: z.boolean().default(false),
    revision: z.coerce.number().int().nonnegative().default(0),
  })
  .superRefine((value, context) => {
    if (!value.enabled) return;
    try {
      const url = new URL(value.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw Error();
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'search_configuration_unavailable',
      });
    }
    if (/[\r\n\0]/u.test(value.username + value.password))
      context.addIssue({ code: 'custom', message: 'search_configuration_unavailable' });
  });
export type SearchNetwork = z.infer<typeof searchNetworkSchema>;
export function parseSearchNetwork(encoded: string): SearchNetwork {
  if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+={0,2}$/u.test(encoded))
    throw Error('search_configuration_unavailable');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length > 6000) throw Error('search_configuration_unavailable');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (value && typeof value === 'object' && 'unavailable' in value)
    throw Error('search_configuration_unavailable');
  return searchNetworkSchema.parse(value);
}
export function searchNetworkHeaders(
  network: SearchNetwork | undefined,
  token: string,
): Record<string, string> {
  const policy = network ?? { enabled: false, revision: 0 };
  return {
    'X-FlashYun-Network-Token': token,
    'X-FlashYun-Search-Network': Buffer.from(JSON.stringify(policy)).toString('base64url'),
  };
}
