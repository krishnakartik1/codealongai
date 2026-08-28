import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { OriginDescriptor, WalkthroughAuthority } from './walkthrough';

export class LoopbackMcpEndpoint {
  private listener: http.Server | undefined;
  public constructor(private readonly authority: WalkthroughAuthority) {}

  public async start(port: number): Promise<void> {
    if (this.listener) return;
    const server = new McpServer({ name: 'CodeAlongAI', version: '0.0.1' });
    server.registerTool('codealongai_get_walkthrough_request', {
      description: 'Read one immutable human-authorized walkthrough request.',
      inputSchema: z.object({ requestId: z.string() }).strict()
    }, (input: { requestId: string }) => ({ structuredContent: this.authority.getStartRequest(input.requestId) ?? null, content: [{ type: 'text', text: JSON.stringify(this.authority.getStartRequest(input.requestId) ?? null) }] }));
    server.registerTool('codealongai_start_walkthrough', {
      description: 'Commit an authorized origin-only walkthrough.',
      inputSchema: z.object({ requestId: z.string(), origin: z.object({}).passthrough() }).strict()
    }, (input) => {
      try {
        const session = this.authority.start(input.requestId, input.origin as unknown as OriginDescriptor);
        const receipt = { schemaVersion: 1, requestId: input.requestId, sessionId: session.id, revision: session.revision, attentionStopId: session.attentionStopId };
        return { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error) }] };
      }
    });
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    this.listener = http.createServer((request, response) => {
      if (request.url !== '/mcp') { response.statusCode = 404; response.end(); return; }
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      void server.connect(transport).then(() => transport.handleRequest(request, response));
    });
    await new Promise<void>((resolve, reject) => {
      this.listener?.once('error', reject);
      this.listener?.listen(port, '127.0.0.1', resolve);
    });
  }

  public async stop(): Promise<void> {
    if (!this.listener) return;
    const listener = this.listener;
    this.listener = undefined;
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
}

/** The model-free producer uses the same public transport a future producer will use. */
export async function commitDeterministicOrigin(port: number, requestId: string, origin: OriginDescriptor): Promise<void> {
  const client = new Client({ name: 'CodeAlongAI deterministic producer', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const request = await client.callTool({ name: 'codealongai_get_walkthrough_request', arguments: { requestId } });
    if (request.isError || request.structuredContent === null) throw new Error('the authorized start request is unavailable');
    const result = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: { requestId, origin } });
    if (result.isError) throw new Error(result.content.map((item) => item.type === 'text' ? item.text : '').join(''));
  } finally {
    await transport.close();
  }
}
