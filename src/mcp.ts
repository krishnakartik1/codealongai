import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { NavigationDirection, OriginDescriptor, QuestionCommit, QuestionOutcome, WalkthroughAuthority } from './walkthrough';
import { WorkspaceError, WorkspaceReader, type WorkspaceSource } from './workspace';

const schemaVersion = z.literal(1);
const pathInput = z.object({ schemaVersion, path: z.string().min(1), startLine: z.number().int().nonnegative().optional(), endLine: z.number().int().nonnegative().optional() }).strict();
const position = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict();
const range = z.object({ start: position, end: position }).strict();
const addedStop = z.object({ id: z.string().min(1), displayName: z.string().min(1), explanationMarkdown: z.string(), path: z.string().min(1), range, destinationIds: z.array(z.string().min(1)), recommendedNextId: z.string().min(1).optional(), backId: z.string().min(1).optional() }).strict();
const graphPatch = z.object({ addedStops: z.array(addedStop), appendedDestinations: z.array(z.object({ sourceStopId: z.string().min(1), destinationIds: z.array(z.string().min(1)) }).strict()), recommendedNextUpdates: z.array(z.object({ sourceStopId: z.string().min(1), targetStopId: z.string().min(1) }).strict()) }).strict();
const questionOutcome = z.discriminatedUnion('kind', [z.object({ kind: z.literal('explanation-only'), answerMarkdown: z.string() }).strict(), z.object({ kind: z.literal('destination-offer'), answerMarkdown: z.string(), destinationIds: z.array(z.string().min(1)) }).strict(), z.object({ kind: z.literal('generated-walkthrough'), answerMarkdown: z.string(), patch: graphPatch }).strict(), z.object({ kind: z.literal('explicit-unsupported'), answerMarkdown: z.string() }).strict()]);
const originDescriptor = z.object({ stopId: z.string().min(1), displayName: z.string().min(1), explanation: z.string(), document: z.string().min(1), range }).strict();
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const unavailableWorkspace: WorkspaceSource = { workspaceFolderCount: () => 0, listFiles: async () => [], readFile: async (path) => ({ path, dirty: false, failure: 'file_unsupported' }) };
const maxRequestBytes = 1024 * 1024;
const defaultToolCallDeadlineMs = 30_000;

export class LoopbackMcpEndpoint {
  private listener: http.Server | undefined;
  private toolCallInFlight = false;
  public constructor(private readonly authority: WalkthroughAuthority, workspace: WorkspaceSource = unavailableWorkspace, private readonly toolCallDeadlineMs = defaultToolCallDeadlineMs) {
    this.workspace = new WorkspaceReader(workspace);
  }
  private readonly workspace: WorkspaceReader;

  public async start(port: number): Promise<void> {
    if (this.listener) return;
    const createServer = (): McpServer => {
    const server = new McpServer({ name: 'CodeAlongAI', version: '0.0.1' }, { supportedProtocolVersions: ['2026-07-28', '2025-11-25'] });
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
      const question = this.authority.getQuestionRequest(input.requestId);
      const replacement = this.authority.getReplacementRequest(input.requestId);
      const reset = this.authority.getResetRequest(input.requestId);
      if (question) {
        const sessionSnapshot = question.snapshot.session;
        const snapshot = { sessionId: sessionSnapshot.id, revision: sessionSnapshot.revision, humanOriginStopId: sessionSnapshot.origin.stopId, attentionStopId: sessionSnapshot.attentionStopId, origin: sessionSnapshot.origin, stops: sessionSnapshot.stops, stopExcerpts: question.snapshot.stopExcerpts, editorState: question.snapshot.editorState };
        const result = { schemaVersion: 1, requestId: question.id, status: question.status === 'consumed' ? 'committed' : question.status === 'cancelled' ? 'canceled' : 'pending', capturedAt: question.capturedAt, kind: 'question', authorizedAction: 'question', input: { sessionId: question.sessionId, revision: question.revision, sourceStopId: question.sourceStopId, text: question.text }, snapshot };
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (replacement) {
        const result = { schemaVersion: 1, requestId: replacement.id, status: replacement.status === 'consumed' ? 'committed' : replacement.status === 'cancelled' ? 'canceled' : 'pending', capturedAt: replacement.snapshot.capturedAt, kind: 'replace', authorizedAction: 'replace', input: { expectedSessionId: replacement.expectedSessionId, expectedRevision: replacement.expectedRevision, origin: { path: replacement.origin.document, range: replacement.origin.range } }, snapshot: replacement.snapshot.session };
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (reset) {
        const result = { schemaVersion: 1, requestId: reset.id, status: reset.status === 'consumed' ? 'committed' : reset.status === 'cancelled' ? 'canceled' : 'pending', kind: 'reset', authorizedAction: 'reset', input: { expectedSessionId: reset.sessionId, expectedRevision: reset.revision } };
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (!request) return domainErrorResult('request_not_found', 'The requested walkthrough request is unavailable.', false);
      const snapshot = { schemaVersion: 1, capturedAt: request.snapshot.capturedAt, status: 'inactive', positionEncoding: 'utf-16', origin: { path: request.snapshot.origin.document, range: request.snapshot.origin.range } };
      const result = { schemaVersion: 1, requestId: request.id, status: request.status === 'consumed' ? 'committed' : request.status === 'cancelled' ? 'canceled' : 'pending', capturedAt: request.snapshot.capturedAt, kind: 'start', authorizedAction: 'start', input: { origin: { path: request.origin.document, range: request.origin.range } }, snapshot };
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
    }, async (input: z.infer<typeof pathInput>) => this.workspaceResult(() => this.workspace.read(input)));
    server.registerTool('codealongai_search_workspace', {
      description: 'Search workspace text literally and case-sensitively.', inputSchema: z.object({ schemaVersion, query: z.string().min(1).refine((value) => !/[\r\n]/.test(value), 'query must be single-line'), cursor: z.string().optional() }).strict(), annotations: readAnnotations
    }, async (input: { schemaVersion: 1; query: string; cursor?: string }) => this.workspaceResult(async () => {
      const after = decodeCursor(input.cursor, 'search', input.query);
      const matches = await this.workspace.search(input.query, after);
      return paged(matches, input.cursor, 'search', input.query, (match) => `${match.path}\u0000${match.range.start.line}\u0000${match.range.start.character}\u0000${match.range.end.line}\u0000${match.range.end.character}`);
    }));
    server.registerTool('codealongai_start_walkthrough', {
      description: 'Commit an authorized origin-only walkthrough.',
      inputSchema: z.object({ schemaVersion, requestId: z.string(), origin: z.object({ stopId: z.string().min(1), displayName: z.string().min(1), explanation: z.string(), document: z.string().min(1), range: z.object({ start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict(), end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict() }).strict() }).strict() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, (input, context) => {
      if (context.mcpReq.signal.aborted) return domainErrorResult('request_cancelled', 'The request was cancelled before commit.', true);
      try {
        const session = this.authority.start(input.requestId, input.origin);
        const receipt = { schemaVersion: 1, requestId: input.requestId, sessionId: session.id, revision: session.revision, attentionStopId: session.attentionStopId };
        return { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch {
        return domainErrorResult('walkthrough_conflict', 'The walkthrough request is unavailable or stale.', false);
      }
    });
    server.registerTool('codealongai_replace_walkthrough', {
      description: 'Atomically replace an authorized walkthrough after validating its new origin.',
      inputSchema: z.object({ schemaVersion, requestId: z.string().min(1), expectedSessionId: z.string().min(1), expectedRevision: z.number().int().positive(), origin: originDescriptor }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, (input, context) => {
      if (context.mcpReq.signal.aborted) return domainErrorResult('request_cancelled', 'The request was cancelled before commit.', true);
      try {
        const receipt = this.authority.replace(input.requestId, input.expectedSessionId, input.expectedRevision, input.origin);
        return { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch { return domainErrorResult('walkthrough_conflict', 'The walkthrough request is unavailable or stale.', false); }
    });
    server.registerTool('codealongai_reset_walkthrough', {
      description: 'Atomically clear an authorized walkthrough without changing editor state or source documents.',
      inputSchema: z.object({ schemaVersion, requestId: z.string().min(1), expectedSessionId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, (input, context) => {
      if (context.mcpReq.signal.aborted) return domainErrorResult('request_cancelled', 'The request was cancelled before commit.', true);
      try {
        const receipt = this.authority.reset(input.requestId, input.expectedSessionId, input.expectedRevision);
        return { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch { return domainErrorResult('walkthrough_conflict', 'The walkthrough request is unavailable or stale.', false); }
    });
    server.registerTool('codealongai_commit_question_outcome', {
      description: 'Atomically commit one authorized question outcome and append-only graph patch.',
      inputSchema: z.object({ schemaVersion, requestId: z.string().min(1), expectedSessionId: z.string().min(1), expectedRevision: z.number().int().positive(), outcome: questionOutcome }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, (input, context) => {
      if (context.mcpReq.signal.aborted) return domainErrorResult('request_cancelled', 'The request was cancelled before commit.', true);
      try {
        const receipt = this.authority.commitQuestionOutcome({ requestId: input.requestId, sessionId: input.expectedSessionId, revision: input.expectedRevision }, input.outcome as QuestionOutcome);
        return { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch { return domainErrorResult('walkthrough_conflict', 'The walkthrough request is unavailable or stale.', false); }
    });
    server.registerTool('codealongai_navigate_walkthrough', {
      description: 'Move CodeAlongAI walkthrough attention along a server-derived Back or Next edge, or directly to one known stop.',
      inputSchema: z.union([
        z.object({ schemaVersion, expectedSessionId: z.string().min(1), expectedRevision: z.number().int().positive(), sourceStopId: z.string().min(1), direction: z.enum(['back', 'next']) }).strict(),
        z.object({ schemaVersion, expectedSessionId: z.string().min(1), expectedRevision: z.number().int().positive(), targetStopId: z.string().min(1) }).strict()
      ]),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, (input: { schemaVersion: 1; expectedSessionId: string; expectedRevision: number; sourceStopId: string; direction: NavigationDirection } | { schemaVersion: 1; expectedSessionId: string; expectedRevision: number; targetStopId: string }, context) => {
      if (context.mcpReq.signal.aborted) return domainErrorResult('request_cancelled', 'The request was cancelled before commit.', true);
      try {
        const receipt = 'targetStopId' in input
          ? this.authority.navigateDestination({ sessionId: input.expectedSessionId, revision: input.expectedRevision, targetStopId: input.targetStopId })
          : this.authority.navigate({ sessionId: input.expectedSessionId, revision: input.expectedRevision, sourceStopId: input.sourceStopId, direction: input.direction });
        return { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch { return domainErrorResult('walkthrough_conflict', 'The walkthrough request is unavailable or stale.', false); }
    }); return server; };
    this.listener = http.createServer((request, response) => {
      void this.handleRequest(request, response, createServer);
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

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse, createServer: () => McpServer): Promise<void> {
    if (request.url !== '/mcp') return this.httpError(response, 404, -32601, 'Not found');
    // This endpoint is intentionally narrower than the SDK's localhost helpers:
    // only a non-browser client addressed to this listener may enter the parser.
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${this.port}`) return this.httpError(response, 403, -32600, 'Invalid request');
    if (request.method !== 'POST') return this.httpError(response, 405, -32600, 'Invalid request');
    const declaredLength = request.headers['content-length'];
    const contentLength = declaredLength === undefined ? undefined : Number(declaredLength);
    if (contentLength !== undefined && (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxRequestBytes)) return this.httpError(response, 413, -32600, 'Request too large');
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof BodyTooLargeError) return this.httpError(response, 413, -32600, 'Request too large');
      return this.httpError(response, 400, -32700, 'Parse error');
    }
    const isToolCall = isToolsCall(parsedBody);
    if (isToolCall && this.toolCallInFlight) return this.json(response, 200, { jsonrpc: '2.0', id: requestId(parsedBody), result: domainErrorResult('endpoint_busy', 'The endpoint is busy. Retry the tool call.', true) });
    if (isToolCall) this.toolCallInFlight = true;
    let deadline: NodeJS.Timeout | undefined;
    const deadlineExpired = isToolCall ? new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        request.destroy();
        response.destroy();
        reject(new ToolCallDeadlineError());
      }, this.toolCallDeadlineMs);
    }) : undefined;
    try {
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await createServer().connect(transport);
      const handling = transport.handleRequest(request, response, parsedBody);
      await (deadlineExpired ? Promise.race([handling, deadlineExpired]) : handling);
    } catch {
      if (!response.headersSent && !response.destroyed) this.httpError(response, 500, -32603, 'Internal server error');
    } finally {
      if (deadline) clearTimeout(deadline);
      if (isToolCall) this.toolCallInFlight = false;
    }
  }

  private httpError(response: http.ServerResponse, status: number, code: number, message: string): void { this.json(response, status, { jsonrpc: '2.0', error: { code, message }, id: null }); }
  private json(response: http.ServerResponse, status: number, body: object): void { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

  private async workspaceResult<T>(operation: () => Promise<T>): Promise<{ structuredContent: Record<string, unknown>; content: [{ type: 'text'; text: string }]; isError?: true }> {
    try {
      const result = await operation();
      const structuredContent: Record<string, unknown> = { schemaVersion: 1, ...(result as object) };
      return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : 'internal_error';
      return domainErrorResult(code, code === 'workspace_unavailable' ? 'Exactly one workspace folder is required.' : 'The requested workspace file is unavailable.', code === 'workspace_unavailable' || code === 'internal_error');
    }
  }

  private async walkthroughSnapshot(): Promise<object> {
    const session = this.authority.getSession();
    if (!session) return { schemaVersion: 1, capturedAt: new Date().toISOString(), status: 'inactive' };
    const stopExcerpts = await Promise.all(session.stops.map(async (stop) => {
      try { const excerpt = await this.workspace.read({ path: stop.document, startLine: stop.range.start.line, endLine: stop.range.end.line + 1 }); return { stopId: stop.id, path: excerpt.path, range: stop.range, text: excerpt.text, ...(excerpt.documentVersion === undefined ? {} : { documentVersion: excerpt.documentVersion }) }; }
      catch { return undefined; }
    }));
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), status: 'active', positionEncoding: 'utf-16', sessionId: session.id, revision: session.revision, humanOriginStopId: session.origin.stopId, attentionStopId: session.attentionStopId, origin: session.origin, stops: session.stops.map((stop) => ({ id: stop.id, displayName: stop.displayName, explanation: stop.explanation, path: stop.document, range: stop.range, destinationIds: stop.destinationIds, ...(stop.recommendedNextId === undefined ? {} : { recommendedNextId: stop.recommendedNextId }), ...(stop.backId === undefined ? {} : { backId: stop.backId }), conversation: stop.conversation })), stopExcerpts: stopExcerpts.filter((excerpt): excerpt is Exclude<typeof excerpt, undefined> => excerpt !== undefined), editorState: { visibleEditors: [] } };
  }
}

function paged<T>(items: readonly T[], cursor: string | undefined, tool: string, query: string, key: (item: T) => string = (item) => String(item)): { paths?: T[]; matches?: T[]; nextCursor?: string } {
  const after = decodeCursor(cursor, tool, query);
  const start = after === undefined ? 0 : items.findIndex((item) => key(item) > after);
  const page = items.slice(start < 0 ? items.length : start, (start < 0 ? items.length : start) + 200);
  const response = tool === 'list' ? { paths: page } : { matches: page };
  if (page.length === 200 && page.length < items.length - (start < 0 ? items.length : start)) return { ...response, nextCursor: Buffer.from(JSON.stringify({ tool, query, after: key(page[page.length - 1]) })).toString('base64url') };
  return response;
}

function decodeCursor(cursor: string | undefined, tool: string, query: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { tool: string; query: string; after: string };
    if (decoded.tool !== tool || decoded.query !== query || typeof decoded.after !== 'string') throw new Error('cursor');
    return decoded.after;
  } catch { throw new WorkspaceError('path_invalid'); }
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const bodyChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += bodyChunk.length;
    if (bytes > maxRequestBytes) throw new BodyTooLargeError();
    chunks.push(bodyChunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class BodyTooLargeError extends Error {}
class ToolCallDeadlineError extends Error {}

function isToolsCall(body: unknown): boolean {
  return !!body && typeof body === 'object' && !Array.isArray(body) && (body as { method?: unknown }).method === 'tools/call';
}

function requestId(body: unknown): string | number | null {
  const id = body && typeof body === 'object' && !Array.isArray(body) ? (body as { id?: unknown }).id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function domainErrorResult(code: string, message: string, retryable: boolean): { isError: true; structuredContent: Record<string, unknown>; content: [{ type: 'text'; text: string }] } {
  const structuredContent = { schemaVersion: 1, code, message, retryable };
  return { isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
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

/** The deterministic producer replaces through the same strict MCP boundary as an external producer. */
export async function commitDeterministicReplacement(port: number, requestId: string, expectedSessionId: string, expectedRevision: number, origin: OriginDescriptor): Promise<void> {
  const client = new Client({ name: 'CodeAlongAI deterministic producer', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const request = await client.callTool({ name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId } });
    if (request.isError || request.structuredContent === null) throw new Error('the authorized replacement request is unavailable');
    const result = await client.callTool({ name: 'codealongai_replace_walkthrough', arguments: { schemaVersion: 1, requestId, expectedSessionId, expectedRevision, origin } });
    if (result.isError) throw new Error(result.content.map((item) => item.type === 'text' ? item.text : '').join(''));
  } finally { await transport.close(); }
}

/** The deterministic question producer exercises the same loopback command boundary. */
export async function commitDeterministicQuestion(port: number, commit: QuestionCommit, outcome: QuestionOutcome): Promise<void> {
  const client = new Client({ name: 'CodeAlongAI deterministic producer', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const request = await client.callTool({ name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId: commit.requestId } });
    if (request.isError || request.structuredContent === null) throw new Error('the authorized question request is unavailable');
    const result = await client.callTool({ name: 'codealongai_commit_question_outcome', arguments: { schemaVersion: 1, requestId: commit.requestId, expectedSessionId: commit.sessionId, expectedRevision: commit.revision, outcome } });
    if (result.isError) throw new Error(result.content.map((item) => item.type === 'text' ? item.text : '').join(''));
  } finally { await transport.close(); }
}
