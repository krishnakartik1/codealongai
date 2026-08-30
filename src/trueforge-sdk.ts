import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { TrueForgeProducerReadinessInput, TrueForgeProducerReadinessResult, TrueForgeProducerRuntime, TrueForgeTurnRequest, TrueForgeRequestOptions } from './trueforge-contract';
import type { DaytonaProbeResult, DaytonaReadinessPhase } from './daytona';

/** Pinned 0.1.3 SDK adapter. It owns no credentials and passes none to CodeAlongAI. */
export class SdkTrueForgeProducerRuntime implements TrueForgeProducerRuntime {
  private readonly client: TrueForgeSdkClient;
  private readonly acceptancePhases = new Set<'provider' | 'snapshots' | 'sandboxes' | 'ready'>();
  private skillCommit: string | undefined;
  private connectorDiscovered = false;
  private mcpDiscovered = false;
  private probeCleaned = false;
  public constructor(baseUrl: string, createClient: TrueForgeSdkClientFactory = (url) => new TrueForge(trueForgeClientOptions(url)) as unknown as TrueForgeSdkClient, private readonly probeState: DaytonaProbeState = new DaytonaProbeState(), private readonly terminalTimer: TerminalTimer = systemTerminalTimer) { this.client = createClient(baseUrl); }
  public discoverConfiguration(): Promise<unknown> { return this.readConfiguration(); }
  public discoverProviders(): Promise<unknown> { return this.readCatalogProviders(); }
  public discoverModels(): Promise<unknown> { return this.readModels(); }
  public discoverSkills(): Promise<unknown> { return this.readSkills(); }
  public createSession(sessionRequest: unknown, options?: TrueForgeRequestOptions): Promise<unknown> { return this.createSdkSession(sessionRequest, options); }
  public runTurn(turnInput: TrueForgeTurnRequest): Promise<unknown> { return this.createSdkTurn(turnInput); }
  public async *events(sessionId: string, turnId: string, afterSequenceNumber?: number, options?: TrueForgeRequestOptions): AsyncIterable<unknown> {
    const stream = await this.subscribeSdkTurn(sessionId, turnId, afterSequenceNumber, options);
    const withMetadata = (stream as unknown as { withMetadata?: () => AsyncIterable<{ data: unknown; id?: string }> }).withMetadata;
    const metadata = typeof withMetadata === 'function' ? withMetadata.call(stream) : undefined;
    if (metadata) { for await (const item of metadata) { const sequence = Number(item.id); yield Number.isSafeInteger(sequence) && sequence >= 0 ? { sequenceNumber: sequence, event: item.data } : item.data; } return; }
    for await (const event of stream) yield event;
  }
  public async listTurnEvents(sessionId: string, turnId: string, options?: TrueForgeRequestOptions): Promise<readonly unknown[]> { if (!this.client.sessions.listTurnEvents) return []; const page = await this.client.sessions.listTurnEvents(sessionId, turnId, { order: 'asc', limit: 100 }, options); return page.data; }
  public async cancelTurn(sessionId: string, options?: TrueForgeRequestOptions): Promise<void> { await this.cancelSdkSession(sessionId, options); }
  public async deleteSession(sessionId: string, options?: TrueForgeRequestOptions): Promise<void> { await this.deleteSdkSession(sessionId, options); }
  public probeDaytona(): Promise<DaytonaProbeResult> { const operation = this.probeState.queue.catch(() => undefined).then(async () => { await this.probeState.hydrate(); return this.probeDaytonaOwned(); }); this.probeState.queue = operation.then(() => undefined, () => undefined); return operation; }
  public acceptanceFacts(): import('./trueforge-contract').NativeAcceptanceFacts { return { provider: 'daytona', phases: [...this.acceptancePhases], skillCommit: this.skillCommit, connectorDiscovered: this.connectorDiscovered, mcpDiscovered: this.mcpDiscovered, ownedSidecar: false, probeCleaned: this.probeCleaned }; }
  public async prepareProducer(input: TrueForgeProducerReadinessInput): Promise<TrueForgeProducerReadinessResult> {
    const configuration = new ProducerReadinessConfiguration(input);
    if (!configuration.hasQualifiedModel) return { phase: 'alias', outcome: 'failed' };
    try {
      const models = await this.readConfiguredModels();
      const selected = configuredModel(models, configuration.model);
      if (!selected) return { phase: 'alias', outcome: 'failed' };
      if (!supportsReasoning(selected, configuration.reasoningEffort)) return { phase: 'reasoning', outcome: 'failed' };
    } catch (error) { return { phase: errorStatus(error) === 401 || errorStatus(error) === 403 ? 'authentication' : 'network', outcome: 'failed' }; }
    try {
      await this.upsertCodeAlongAiSkill(configuration.skillManifest());
      const skills = await this.readConfiguredSkills();
      if (!hasCodeAlongAiSkill(skills, configuration.skillCommit)) return { phase: 'skill', outcome: 'failed' };
      this.skillCommit = configuration.skillCommit;
    } catch { return { phase: 'skill', outcome: 'failed' }; }
    try {
      await this.upsertCodeAlongAiConnector(configuration.connectorManifest());
    } catch { return { phase: 'connector', outcome: 'failed' }; }
    try {
      const tools = await this.listCodeAlongAiMcpTools();
      if (!hasExactCatalog(tools)) return { phase: 'mcp-discovery', outcome: 'failed' };
      this.connectorDiscovered = true; this.mcpDiscovered = true;
    } catch { return { phase: 'mcp-discovery', outcome: 'failed' }; }
    let sessionId: string | undefined;
    try {
      const session = await this.createSession({ agent: { spec: configuration.agentSpec() } });
      sessionId = responseId(session);
      if (!sessionId) return { phase: 'model', outcome: 'failed' };
      const turn = await this.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: 'Perform the configured-provider readiness check and reply READY.' }] } });
      const turnId = responseId(turn);
      if (!turnId) return { phase: 'network', outcome: 'failed' };
      const terminal = await terminalReadiness(this, sessionId, turnId, this.terminalTimer);
      if (terminal !== 'ready') return { phase: terminal, outcome: 'failed' };
    } catch (error) { return { phase: errorStatus(error) === 401 || errorStatus(error) === 403 ? 'authentication' : 'network', outcome: 'failed' }; }
    finally { if (sessionId) await this.deleteSession(sessionId).catch(() => undefined); }
    return { phase: 'ready', outcome: 'ready' };
  }
  private async probeDaytonaOwned(): Promise<DaytonaProbeResult> {
    if (this.probeState.residualSessionId) {
      try {
        await this.deleteSession(this.probeState.residualSessionId);
        const completed = this.probeState.residualResult ?? { provider: 'daytona' as const, phase: 'ready' as const, outcome: 'ready' as const };
        this.probeState.residualSessionId = undefined;
        this.probeState.residualResult = undefined;
        await this.probeState.persist();
        return completed;
      }
      catch { return { provider: 'daytona', phase: 'cleanup', outcome: 'residual' }; }
    }
    let provider: unknown;
    try { provider = await this.readConfiguredSandboxProvider(); }
    catch (error) { return failed(configurationPhase(error)); }
    if (!isDaytona(provider)) return failed('provider');
    this.acceptancePhases.add('provider');
    const manifest = providerManifest(provider);
    if (!manifest) return failed('provider');
    let refreshed: unknown;
    try { refreshed = await this.refreshConfiguredSandboxProvider(manifest); }
    catch (error) { return failed(snapshotPhase(error)); }
    if (sandboxStatus(refreshed) !== 'ready') return failed('snapshots');
    this.acceptancePhases.add('snapshots');
    let model: string | undefined;
    try { model = firstModelName(await this.readConfiguredModels()); }
    catch { return failed('model'); }
    if (!model) return failed('model');
    let sessionId: string | undefined;
    let result: DaytonaProbeResult | undefined;
    try {
      const spec: TrueForgeApi.AgentSpec = { model: { name: model }, config: { sandbox: { enabled: true, fileDownloads: false } }, instructions: 'This is a disposable CodeAlongAI readiness probe. Use the supplied sandbox to run the command true exactly once. Do not access files, use MCP, or include workspace, editor, request, or credential data.', messages: [{ type: 'user.message', content: 'Run true in the supplied sandbox once, then reply READY.' }] };
      const session = await this.createSession({ agent: { spec } });
      sessionId = responseId(session);
      if (!sessionId) result = failed('sandbox-create');
    } catch (error) { result = failed(sandboxPhase(error)); }
    if (sessionId && !result) {
      try {
        const turn = await this.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: 'Run true in the supplied sandbox once, then reply READY.' }] } });
        const turnId = responseId(turn);
        const sandbox = turnId ? await observedSandboxCreation(this, sessionId, turnId) : 'absent';
        if (sandbox === 'permission-denied') result = failed('sandboxes');
        else if (sandbox !== 'created') result = failed('sandbox-create');
        else this.acceptancePhases.add('sandboxes');
      } catch (error) { result = failed(sandboxPhase(error)); }
    }
    if (!sessionId) return result ?? failed('sandbox-create');
    try { await this.deleteSession(sessionId); this.probeCleaned = true; }
    catch { this.probeState.residualSessionId = sessionId; this.probeState.residualResult = result ?? { provider: 'daytona', phase: 'ready', outcome: 'ready' }; await this.probeState.persist(); return { provider: 'daytona', phase: 'cleanup', outcome: 'residual' }; }
    if (!result) this.acceptancePhases.add('ready');
    return result ?? { provider: 'daytona', phase: 'ready', outcome: 'ready' };
  }
  private createSdkSession(sessionRequest: unknown, options?: TrueForgeRequestOptions): Promise<unknown> { return this.client.sessions.create(sessionRequest as never, options); }
  private createSdkTurn(turnInput: TrueForgeTurnRequest): Promise<unknown> { return this.client.sessions.createTurn(turnInput.sessionId, turnInput.request as never, turnInput.options); }
  private subscribeSdkTurn(sessionId: string, turnId: string, afterSequenceNumber?: number, options?: TrueForgeRequestOptions): Promise<AsyncIterable<unknown>> { return this.client.sessions.subscribeToTurn(sessionId, turnId, afterSequenceNumber === undefined ? undefined : { afterSequenceNumber }, options); }
  private async cancelSdkSession(sessionId: string, options?: TrueForgeRequestOptions): Promise<void> { await this.client.sessions.cancel(sessionId, undefined, options); }
  private async deleteSdkSession(sessionId: string, options?: TrueForgeRequestOptions): Promise<void> { await this.client.sessions.delete(sessionId, options); }
  private readConfiguration(): Promise<unknown> { return Promise.all([this.readConfiguredModelProviders(), this.readConfiguredSkills(), this.readConfiguredSandboxProvider()]); }
  private readConfiguredModelProviders(): Promise<unknown> { return this.client.settings.modelProviders.list(); }
  private readConfiguredSkills(): Promise<unknown> { return this.client.settings.skills.list(); }
  private readConfiguredSandboxProvider(): Promise<unknown> { return this.client.settings.sandboxProviders.get(); }
  private refreshConfiguredSandboxProvider(manifest: Record<string, unknown>): Promise<unknown> { return this.client.settings.sandboxProviders.createOrUpdate({ manifest }); }
  private readCatalogProviders(): Promise<unknown> { return this.client.catalogs.modelProviders.list(); }
  private readConfiguredModels(): Promise<unknown> { return this.client.models.list(); }
  private readModels(): Promise<unknown> { return this.readConfiguredModels(); }
  private readSkills(): Promise<unknown> { return this.client.skills.list(); }
  private async upsertCodeAlongAiSkill(manifest: Record<string, unknown>): Promise<void> { if (!this.client.settings.skills.createOrUpdate) throw new Error('CodeAlongAI skill upsert is unavailable'); await this.client.settings.skills.createOrUpdate({ manifest }); }
  private async upsertCodeAlongAiConnector(manifest: Record<string, unknown>): Promise<void> { if (!this.client.settings.mcpServers?.createOrUpdate) throw new Error('CodeAlongAI connector upsert is unavailable'); await this.client.settings.mcpServers.createOrUpdate({ manifest }); }
  private async listCodeAlongAiMcpTools(): Promise<unknown> { if (!this.client.mcpServers?.listTools) throw new Error('CodeAlongAI MCP discovery is unavailable'); return this.client.mcpServers.listTools('codealongai-mcp'); }
}

/** Producer turns own their retry policy; the pinned client must never replay them. */
export function trueForgeClientOptions(baseUrl: string): TrueForge.Options { return { baseUrl, maxRetries: 0, stream: { reconnectionEnabled: false, maxReconnectionAttempts: 0 } }; }

/** Opaque lifecycle-only state shared by replacement SDK adapters. */
export interface DaytonaProbeStateStore { read(): Promise<{ readonly sessionId: string; readonly result: DaytonaProbeResult } | undefined>; write(value: { readonly sessionId: string; readonly result: DaytonaProbeResult } | undefined): Promise<void>; }
export class DaytonaProbeState {
  public queue: Promise<void> = Promise.resolve(); public residualSessionId: string | undefined; public residualResult: DaytonaProbeResult | undefined; private hydrated = false;
  public constructor(private readonly store?: DaytonaProbeStateStore) {}
  public async hydrate(): Promise<void> { if (this.hydrated) return; const value = await this.store?.read(); this.residualSessionId = value?.sessionId; this.residualResult = value?.result; this.hydrated = true; }
  public async persist(): Promise<void> { await this.store?.write(this.residualSessionId && this.residualResult ? { sessionId: this.residualSessionId, result: this.residualResult } : undefined); }
}

function failed(phase: DaytonaReadinessPhase): DaytonaProbeResult { return { provider: 'daytona', phase, outcome: 'failed' }; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function responseId(value: unknown): string | undefined { const record = asRecord(value); const data = asRecord(record?.data); return typeof data?.id === 'string' ? data.id : typeof record?.id === 'string' ? record.id : undefined; }
function isDaytona(value: unknown): boolean { const record = asRecord(value); const data = asRecord(record?.data); const manifest = asRecord(data?.manifest ?? record?.manifest); return manifest?.type === 'daytona'; }
function providerManifest(value: unknown): Record<string, unknown> | undefined { const record = asRecord(value); const data = asRecord(record?.data); return asRecord(data?.manifest ?? record?.manifest); }
function sandboxStatus(value: unknown): string | undefined { const record = asRecord(value); const data = asRecord(record?.data); return typeof (data?.status ?? record?.status) === 'string' ? data?.status as string ?? record?.status as string : undefined; }
function firstModelName(value: unknown): string | undefined { const record = asRecord(value); const values = Array.isArray(record?.data) ? record.data : Array.isArray(value) ? value : []; for (const candidate of values) { const name = asRecord(candidate)?.name; if (typeof name === 'string' && name.length > 0) return name; } return undefined; }
function sdkCollectionItems(value: unknown): readonly unknown[] { const record = asRecord(value); return Array.isArray(record?.data) ? record.data : Array.isArray(value) ? value : []; }
function isFullyQualifiedModel(value: string): boolean { return /^[^/\s]+\/[^/\s]+$/.test(value); }
function configuredModel(value: unknown, name: string): Record<string, unknown> | undefined { return sdkCollectionItems(value).map(asRecord).find((candidate) => candidate?.name === name); }
function supportsReasoning(model: Record<string, unknown>, effort: string): boolean { const properties = asRecord(model.properties); const efforts = properties?.reasoningEfforts; return Array.isArray(efforts) && efforts.includes(effort); }
function hasCodeAlongAiSkill(value: unknown, commit: string): boolean { return sdkCollectionItems(value).some((candidate) => { const record = asRecord(candidate); const manifest = asRecord(record?.manifest ?? record?.data); return (manifest?.name ?? record?.name) === 'codealongai' && (manifest?.type ?? record?.type) === 'git' && (manifest?.url ?? record?.url) === 'https://github.com/krishnakartik1/codealongai.git' && (manifest?.ref ?? record?.ref) === commit && (manifest?.path ?? record?.path) === 'skills/codealongai'; }); }
class ProducerReadinessConfiguration {
  public constructor(private readonly input: TrueForgeProducerReadinessInput) {}
  public get model(): string { return this.input.model; }
  public get reasoningEffort(): string { return this.input.reasoningEffort; }
  public get skillCommit(): string { return this.input.skillCommit; }
  public get hasQualifiedModel(): boolean { return isFullyQualifiedModel(this.model); }
  public skillManifest(): Record<string, unknown> { return { name: 'codealongai', description: 'Produce one grounded CodeAlongAI walkthrough transition.', type: 'git', url: 'https://github.com/krishnakartik1/codealongai.git', path: 'skills/codealongai', ref: this.skillCommit }; }
  public connectorManifest(): Record<string, unknown> { return { name: 'codealongai-mcp', description: 'CodeAlongAI walkthrough MCP endpoint.', type: 'remote', url: this.input.mcpUrl }; }
  public agentSpec(): TrueForgeApi.AgentSpec { return { model: { name: this.model, params: { reasoningEffort: this.reasoningEffort, parallelToolCalls: false } }, skills: [{ name: 'codealongai' }], mcpServers: [{ name: 'codealongai-mcp' }], config: { sandbox: { enabled: true, fileDownloads: false } }, instructions: 'This is a CodeAlongAI producer readiness check. Do not access workspace, editor, source, requests, credentials, or MCP tools.' }; }
}
/** A credential-free, request-free public operation that verifies the configured provider can run the selected AgentSpec. */
export function producerAgentSpec(input: TrueForgeProducerReadinessInput): TrueForgeApi.AgentSpec { return new ProducerReadinessConfiguration(input).agentSpec(); }
const CODEALONGAI_CATALOG = ['codealongai_get_walkthrough', 'codealongai_get_walkthrough_request', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_start_walkthrough', 'codealongai_replace_walkthrough', 'codealongai_reset_walkthrough', 'codealongai_commit_question_outcome', 'codealongai_navigate_walkthrough'];
function hasExactCatalog(value: unknown): boolean { const tools = sdkCollectionItems(value); if (tools.length !== CODEALONGAI_CATALOG.length) return false; const names: string[] = []; for (const tool of tools) { const name = asRecord(tool)?.name; if (typeof name !== 'string') return false; names.push(name); } return new Set(names).size === CODEALONGAI_CATALOG.length && JSON.stringify(names.sort()) === JSON.stringify([...CODEALONGAI_CATALOG].sort()); }
function errorStatus(error: unknown): number | undefined { const status = asRecord(error)?.statusCode ?? asRecord(error)?.status; return typeof status === 'number' ? status : undefined; }
function configurationPhase(error: unknown): DaytonaReadinessPhase { return errorStatus(error) === 401 || errorStatus(error) === 403 ? 'authentication' : 'provider'; }
function snapshotPhase(_error: unknown): DaytonaReadinessPhase { return 'snapshots'; }
function sandboxPhase(error: unknown): DaytonaReadinessPhase { const status = errorStatus(error); return status === 401 || status === 403 ? 'sandboxes' : 'sandbox-create'; }
/** Pinned 0.1.4 has no structured sandbox-error event. Its only public status
 * signal is an HTTP token in sandbox-probe tool-response event text; inspect
 * that token transiently and never retain or surface the text. */
async function observedSandboxCreation(runtime: TrueForgeProducerRuntime, sessionId: string, turnId: string): Promise<'created' | 'permission-denied' | 'absent'> {
  for await (const event of runtime.events(sessionId, turnId)) {
    const record = asRecord(event);
    if (record?.type === 'sandbox.created') return 'created';
    if (record?.type === 'tool.response' && hasSandboxPermissionStatus(record.content)) return 'permission-denied';
  }
  return 'absent';
}
function hasSandboxPermissionStatus(value: unknown): boolean { return typeof value === 'string' && /(^|\D)(401|403)(\D|$)/.test(value); }
export interface TerminalTimer { waitFor<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined>; now?(): number; }
const systemTerminalTimer: TerminalTimer = { waitFor: (operation, timeoutMs) => Promise.race([operation, new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs))]), now: () => Date.now() };
async function terminalReadiness(runtime: TrueForgeProducerRuntime, sessionId: string, turnId: string, timer: TerminalTimer): Promise<'ready' | 'authentication' | 'network'> {
  const iterator = runtime.events(sessionId, turnId)[Symbol.asyncIterator]();
  const now = timer.now ?? Date.now;
  const deadline = now() + 10_000;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) { await runtime.cancelTurn(sessionId).catch(() => undefined); return 'network'; }
    const next = await timer.waitFor(iterator.next(), remaining);
    if (!next) { await runtime.cancelTurn(sessionId).catch(() => undefined); return 'network'; }
    if (next.done) return 'network';
    const record = asRecord(next.value);
    if (record?.type !== 'turn.done') continue;
    const state = asRecord(record.state);
    if (state?.status === 'done') return isSuccessfulTurnStateDone(state) ? 'ready' : 'network';
    if (state?.status === 'error') return terminalFailurePhase(state.message);
    return 'network';
  }
}
/** Pinned SDK 0.1.3 decodes TurnStateDone and ModelMessageEvent to camel-case fields. */
function isSuccessfulTurnStateDone(state: Record<string, unknown>): boolean { return typeof state.completedAt === 'string' && isModelMessageEvent(state.output) && Array.isArray(state.requiredActions) && state.requiredActions.length === 0; }
function isModelMessageEvent(value: unknown): boolean { const event = asRecord(value); return event?.type === 'model.message' && typeof event.id === 'string' && typeof event.threadId === 'string' && typeof event.createdAt === 'string' && exactReadyContent(event.content) && optionalString(event.name) && optionalString(event.reasoningContent) && (event.refusal === undefined || event.refusal === null); }
function exactReadyContent(value: unknown): boolean { if (value === 'READY') return true; return Array.isArray(value) && value.length === 1 && asRecord(value[0])?.type === 'text' && asRecord(value[0])?.text === 'READY'; }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === 'string'; }
/** Inspect a terminal message transiently; its contents never cross the runtime boundary. */
function terminalFailurePhase(value: unknown): 'authentication' | 'network' { if (typeof value !== 'string') return 'network'; const text = value.toLowerCase(); if (/\bbrowser\b|\bfetch\b|\bnetwork\b|\bdns\b|\btimeout\b/.test(text)) return 'network'; return /(^|\D)(401|403)(\D|$)|\bunauthorized\b|\binvalid (api )?key\b|\bcredential\b/.test(text) ? 'authentication' : 'network'; }

/** Narrow structural seam over the pinned SDK: tests replace only this external client. */
export interface TrueForgeSdkClient {
  settings: { modelProviders: { list(): Promise<unknown> }; skills: { list(): Promise<unknown>; createOrUpdate?(request: unknown): Promise<unknown> }; sandboxProviders: { get(): Promise<unknown>; createOrUpdate(request: unknown): Promise<unknown> }; mcpServers?: { createOrUpdate(request: unknown): Promise<unknown> } };
  catalogs: { modelProviders: { list(): Promise<unknown> } }; models: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> };
  mcpServers?: { listTools(name: string): Promise<unknown> };
  sessions: { create(sessionRequest: unknown, options?: TrueForgeRequestOptions): Promise<unknown>; createTurn(sessionId: string, turnRequest: unknown, options?: TrueForgeRequestOptions): Promise<unknown>; subscribeToTurn(sessionId: string, turnId: string, request?: { afterSequenceNumber?: number }, options?: TrueForgeRequestOptions): Promise<AsyncIterable<unknown>>; listTurnEvents?(sessionId: string, turnId: string, request?: { order?: string; limit?: number }, options?: TrueForgeRequestOptions): Promise<{ data: readonly unknown[] }>; cancel(sessionId: string, request?: unknown, options?: TrueForgeRequestOptions): Promise<unknown>; delete(sessionId: string, options?: TrueForgeRequestOptions): Promise<unknown>; };
}
export type TrueForgeSdkClientFactory = (baseUrl: string) => TrueForgeSdkClient;
