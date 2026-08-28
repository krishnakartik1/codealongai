import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { OriginDescriptor, WalkthroughAuthority } from './walkthrough';
import { WorkspaceError, WorkspaceReader, type WorkspaceSource } from './workspace';

const schemaVersion = z.literal(1);
const pathInput = z.object({ schemaVersion, path: z.string().min(1), startLine: z.number().int().nonnegative().optional(), endLine: z.number().int().nonnegative().optional() }).strict();
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const unavailableWorkspace: WorkspaceSource = { workspaceFolderCount: () => 0, files: async () => [] };

export class LoopbackMcpEndpoint {
  private listener: http.Server | undefined;
  public constructor(private readonly authority: WalkthroughAuthority, workspace: WorkspaceSource = unavailableWorkspace) {
    this.workspace = new WorkspaceReader(workspace);
  }
  private readonly workspace: WorkspaceReader;

  public async start(port: number): Promise<void> {
    if (this.listener) return;
    const createServer = (): McpServer => {
    const server = new McpServer({ name: 'CodeAlongAI', version: '0.0.1' });
    server.registerTool('codealongai_get_walkthrough', {
      description: 'Read the current walkthrough snapshot.', annotations: readAnnotations
    }, async () => {
      const snapshot = await this.walkthroughSnapshot();
      return { structuredContent: snapshot, content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
    });
    server.registerTool('codealongai_get_walkthrough_request', {
      description: 'Read one immutable human-authorized walkthrough request.',
      inputSchema: z.object({ schemaVersion, requestId: z.string().min(1) }).strict(), annotations: readAnnotations
    }, async (input: { schemaVersion: 1; requestId: string }) => {
      const request = this.authority.getStartRequest(input.requestId);
      if (!request) return this.domainError('request_not_found', 'The requested walkthrough request is unavailable.', false);
      const result = { schemaVersion: 1, requestId: request.id, status: request.status === 'consumed' ? 'committed' : request.status === 'cancelled' ? 'canceled' : 'pending', capturedAt: request.snapshot.capturedAt, kind: 'start', authorizedAction: 'start', input: { origin: { path: request.origin.document, range: request.origin.range } }, snapshot: await this.walkthroughSnapshot() };
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    server.registerTool('codealongai_list_workspace_files', {
      description: 'List workspace-relative text paths.', inputSchema: z.object({ schemaVersion, cursor: z.string().optional() }).strict(), annotations: readAnnotations
    }, async (input: { schemaVersion: 1; cursor?: string }) => this.workspaceResult(async () => {
      const paths = await this.workspace.list();
      return paged(paths, input.cursor, 'list', '');
    }));
    server.registerTool('codealongai_read_workspace_file', {
      description: 'Read bounded text from one workspace file.', inputSchema: pathInput, annotations: readAnnotations
    }, async (input: z.infer<typeof pathInput>) => this.workspaceResult(() => this.workspace.read(input.path, input.startLine, input.endLine)));
    server.registerTool('codealongai_search_workspace', {
      description: 'Search workspace text literally and case-sensitively.', inputSchema: z.object({ schemaVersion, query: z.string().min(1), cursor: z.string().optional() }).strict(), annotations: readAnnotations
    }, async (input: { schemaVersion: 1; query: string; cursor?: string }) => this.workspaceResult(async () => {
      const matches = await this.workspace.search(input.query);
      return paged(matches, input.cursor, 'search', input.query, (match) => `${match.path}\u0000${match.range.start.line}\u0000${match.range.start.character}\u0000${match.range.end.line}\u0000${match.range.end.character}`);
    }));
    server.registerTool('codealongai_start_walkthrough', {
      description: 'Commit an authorized origin-only walkthrough.',
      inputSchema: z.object({ schemaVersion, requestId: z.string(), origin: z.object({ stopId: z.string().min(1), displayName: z.string().min(1), explanation: z.string(), document: z.string().min(1), range: z.object({ start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict(), end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict() }).strict() }).strict() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, (input) => {
      try {
        const session = this.authority.start(input.requestId, input.origin);
        const receipt = { schemaVersion: 1, requestId: input.requestId, sessionId: session.id, revision: session.revision, attentionStopId: session.attentionStopId };
        return { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error) }] };
      }
    }); return server; };
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    this.listener = http.createServer((request, response) => {
      if (request.url !== '/mcp') { response.statusCode = 404; response.end(); return; }
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      void createServer().connect(transport).then(() => transport.handleRequest(request, response));
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

  public get port(): number | undefined {
    const address = this.listener?.address();
    return typeof address === 'object' && address ? address.port : undefined;
  }

  private async workspaceResult<T>(operation: () => Promise<T>): Promise<{ structuredContent: Record<string, unknown>; content: [{ type: 'text'; text: string }]; isError?: true }> {
    try {
      const result = await operation();
      const structuredContent: Record<string, unknown> = { schemaVersion: 1, ...(result as object) };
      return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : 'internal_error';
      return this.domainError(code, code === 'workspace_unavailable' ? 'Exactly one workspace folder is required.' : 'The requested workspace file is unavailable.', code === 'workspace_unavailable' || code === 'internal_error');
    }
  }

  private domainError(code: string, message: string, retryable: boolean): { isError: true; structuredContent: Record<string, unknown>; content: [{ type: 'text'; text: string }] } {
    const structuredContent = { schemaVersion: 1, code, message, retryable };
    return { isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
  }

  private async walkthroughSnapshot(): Promise<object> {
    const session = this.authority.getSession();
    if (!session) return { schemaVersion: 1, capturedAt: new Date().toISOString(), status: 'inactive' };
    let stopExcerpts: object[] = [];
    try {
      const excerpt = await this.workspace.read(session.origin.document, session.origin.range.start.line, session.origin.range.end.line + 1);
      stopExcerpts = [{ stopId: session.origin.stopId, path: excerpt.path, range: session.origin.range, text: excerpt.text, ...(excerpt.documentVersion === undefined ? {} : { documentVersion: excerpt.documentVersion }) }];
    } catch { /* A snapshot never widens the workspace boundary when an origin file is no longer readable. */ }
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), status: 'active', positionEncoding: 'utf-16', sessionId: session.id, revision: session.revision, humanOriginStopId: session.origin.stopId, attentionStopId: session.attentionStopId, stops: [{ id: session.origin.stopId, displayName: session.origin.displayName, explanation: session.origin.explanation, path: session.origin.document, range: session.origin.range, destinations: [], conversation: [] }], stopExcerpts, editorState: { visibleEditors: [] } };
  }
}

function paged<T>(items: readonly T[], cursor: string | undefined, tool: string, query: string, key: (item: T) => string = (item) => String(item)): { paths?: T[]; matches?: T[]; nextCursor?: string } {
  let after: string | undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { tool: string; query: string; after: string };
      if (decoded.tool !== tool || decoded.query !== query || typeof decoded.after !== 'string') throw new Error('cursor');
      after = decoded.after;
    } catch { throw new WorkspaceError('path_invalid'); }
  }
  const start = after === undefined ? 0 : items.findIndex((item) => key(item) > after);
  const page = items.slice(start < 0 ? items.length : start, (start < 0 ? items.length : start) + 200);
  const response = tool === 'list' ? { paths: page } : { matches: page };
  if (page.length === 200 && page.length < items.length - (start < 0 ? items.length : start)) return { ...response, nextCursor: Buffer.from(JSON.stringify({ tool, query, after: key(page[page.length - 1]) })).toString('base64url') };
  return response;
}

/** The model-free producer uses the same public transport a future producer will use. */
export async function commitDeterministicOrigin(port: number, requestId: string, origin: OriginDescriptor): Promise<void> {
  const client = new Client({ name: 'CodeAlongAI deterministic producer', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const request = await client.callTool({ name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId } });
    if (request.isError || request.structuredContent === null) throw new Error('the authorized start request is unavailable');
    const result = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: { schemaVersion: 1, requestId, origin } });
    if (result.isError) throw new Error(result.content.map((item) => item.type === 'text' ? item.text : '').join(''));
  } finally {
    await transport.close();
  }
}
