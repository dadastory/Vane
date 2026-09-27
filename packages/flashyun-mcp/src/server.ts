import { createServer, type IncomingMessage } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { credentialsMatch, parseRequestConfiguration } from './config.js';
import { searchWeb } from './search.js';
import { SearchSettingsStore, type SettingsWrite } from './settings.js';

const required = (name: string): string => {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const serviceToken = required('FLASHYUN_VANE_MCP_TOKEN');
const managementToken = required('FLASHYUN_VANE_SETTINGS_TOKEN');
const searxngBaseURL = required('FLASHYUN_SEARXNG_BASE_URL');
const settings = new SearchSettingsStore(
  required('FLASHYUN_VANE_SETTINGS_PATH'), required('FLASHYUN_VANE_SETTINGS_KEY'),
);
const listenHost = (process.env.FLASHYUN_VANE_LISTEN_HOST ?? '0.0.0.0').trim();
const listenPort = Number.parseInt(process.env.FLASHYUN_VANE_LISTEN_PORT ?? '8080', 10);

function headers(request: IncomingMessage): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') result.set(name, value);
    else if (value) result.set(name, value.join(', '));
  }
  return result;
}

function createMcpServer(configuration: ReturnType<typeof parseRequestConfiguration>): McpServer {
  const server = new McpServer({ name: 'flashyun-vane-search', version: '1.0.0' });
  server.registerTool(
    'web_search',
    {
      title: 'Web search',
      description: 'Search public web sources and return structured evidence.',
      inputSchema: z.object({ query: z.string().trim().min(1).max(1_000) }).strict(),
      outputSchema: z.object({
        query: z.string(),
        mode: z.enum(['ordinary', 'speed', 'balanced', 'quality']),
        findings: z.array(z.object({ title: z.string(), url: z.string(), content: z.string(), excerpt: z.string().optional() })),
        sources: z.array(z.object({ title: z.string(), url: z.string(), hostname: z.string(), description: z.string().optional() })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const output = await searchWeb(query, configuration, { searxngBaseURL, settings });
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        const code = error instanceof Error && /^[a-z_]{1,64}$/u.test(error.message)
          ? error.message
          : 'web_search_unavailable';
        return { isError: true, content: [{ type: 'text', text: code }] };
      }
    },
  );
  return server;
}

createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url === '/internal/settings/search' && (request.method === 'GET' || request.method === 'PUT')) {
    const authorization = headers(request).get('authorization') ?? '';
    if (!credentialsMatch(authorization, `Bearer ${managementToken}`)) {
      response.writeHead(401).end();
      return;
    }
    try {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(await settings.read()));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 16_384) throw new Error('settings_invalid');
        chunks.push(bytes);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SettingsWrite;
      const saved = await settings.write(input);
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(saved));
    } catch (error) {
      const code = error instanceof Error && error.message === 'settings_conflict' ? 409
        : error instanceof Error && error.message === 'settings_invalid' ? 400 : 503;
      response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: code === 409 ? 'settings_conflict' : code === 400 ? 'settings_invalid' : 'settings_unavailable' }));
    }
    return;
  }
  if (request.url !== '/mcp' || request.method !== 'POST') {
    response.writeHead(404).end();
    return;
  }
  let configuration: ReturnType<typeof parseRequestConfiguration>;
  try {
    configuration = parseRequestConfiguration(headers(request), serviceToken);
  } catch {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"error":"unauthorized"}');
    return;
  }
  const server = createMcpServer(configuration);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    if (!response.writableEnded) response.end('{"error":"unavailable"}');
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}).listen(listenPort, listenHost);
