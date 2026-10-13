import { createServer, type IncomingMessage } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseRequestConfiguration } from './config.js';
import { searchWeb } from './search.js';
import { embedTexts } from './embedding.js';

const required = (name: string): string => {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const serviceToken = required('FLASHYUN_VANE_MCP_TOKEN');
const searxngBaseURL = required('FLASHYUN_SEARXNG_BASE_URL');
const litellmBaseURL = required('FLASHYUN_LITELLM_BASE_URL');
const endpoint = new URL(litellmBaseURL);
if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error('vane_gateway_configuration_invalid');
}
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
        const embedding = configuration.embedding;
        const output = await searchWeb(query, configuration, {
          searxngBaseURL,
          ...(embedding ? { embed: (texts: string[]) => embedTexts(litellmBaseURL, embedding, texts) } : {}),
        });
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
