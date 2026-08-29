import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeProducerReadinessInput, TrueForgeProducerReadinessResult, TrueForgeProducerRuntime, TrueForgeTurnRequest } from './trueforge-contract';
import type { DaytonaProbeResult, DaytonaReadinessPhase } from './daytona';

/** Pinned 0.1.3 SDK adapter. It owns no credentials and passes none to CodeAlongAI. */
export class SdkTrueForgeProducerRuntime implements TrueForgeProducerRuntime {
  private readonly client: TrueForgeSdkClient;
  public constructor(baseUrl: string, createClient: TrueForgeSdkClientFactory = (url) => new TrueForge({ baseUrl: url }) as unknown as TrueForgeSdkClient, private readonly probeState: DaytonaProbeState = new DaytonaProbeState()) { this.client = createClient(baseUrl); }
  public discoverConfiguration(): Promise<unknown> { return this.readConfiguration(); }
  public discoverProviders(): Promise<unknown> { return this.readCatalogProviders(); }
  public discoverModels(): Promise<unknown> { return this.readModels(); }
  public discoverSkills(): Promise<unknown> { return this.readSkills(); }
  public createSession(sessionRequest: unknown): Promise<unknown> { return this.createSdkSession(sessionRequest); }
  public runTurn(turnInput: TrueForgeTurnRequest): Promise<unknown> { return this.createSdkTurn(turnInput); }
  public async *events(sessionId: string, turnId: string): AsyncIterable<unknown> { for await (const event of await this.subscribeSdkTurn(sessionId, turnId)) yield event; }
  public async cancelTurn(sessionId: string): Promise<void> { await this.cancelSdkSession(sessionId); }
  public async deleteSession(sessionId: string): Promise<void> { await this.deleteSdkSession(sessionId); }
  public probeDaytona(): Promise<DaytonaProbeResult> { const operation = this.probeState.queue.catch(() => undefined).then(async () => { await this.probeState.hydrate(); return this.probeDaytonaOwned(); }); this.probeState.queue = operation.then(() => undefined, () => undefined); return operation; }
  public async prepareProducer(input: TrueForgeProducerReadinessInput): Promise<TrueForgeProducerReadinessResult> {
    if (!isFullyQualifiedModel(input.model)) return { phase: 'alias', outcome: 'failed' };
    try {
      const models = await this.readConfiguredModels();
      const selected = configuredModel(models, input.model);
      if (!selected) return { phase: 'alias', outcome: 'failed' };
      if (!supportsReasoning(selected, input.reasoningEffort)) return { phase: 'reasoning', outcome: 'failed' };
    } catch (error) { return { phase: errorStatus(error) === 401 || errorStatus(error) === 403 ? 'authentication' : 'network', outcome: 'failed' }; }
    try {
      if (!this.client.settings.skills.createOrUpdate) return { phase: 'skill', outcome: 'failed' };
      await this.client.settings.skills.createOrUpdate({ manifest: codeAlongAiSkillManifest(input.skillCommit) });
      const skills = await this.readConfiguredSkills();
      if (!hasCodeAlongAiSkill(skills, input.skillCommit)) return { phase: 'skill', outcome: 'failed' };
    } catch { return { phase: 'skill', outcome: 'failed' }; }
    try {
      if (!this.client.settings.mcpServers?.createOrUpdate || !this.client.mcpServers?.listTools) return { phase: 'connector', outcome: 'failed' };
      await this.client.settings.mcpServers.createOrUpdate({ manifest: { name: 'codealongai-mcp', description: 'CodeAlongAI walkthrough MCP endpoint.', type: 'remote', url: input.mcpUrl } });
    } catch { return { phase: 'connector', outcome: 'failed' }; }
    try {
      const tools = await this.client.mcpServers.listTools('codealongai-mcp');
      if (!hasExactCatalog(tools)) return { phase: 'mcp-discovery', outcome: 'failed' };
    } catch { return { phase: 'mcp-discovery', outcome: 'failed' }; }
    let sessionId: string | undefined;
    try {
      const session = await this.createSession({ agent: { spec: producerAgentSpec(input) } });
      sessionId = responseId(session);
      if (!sessionId) return { phase: 'model', outcome: 'failed' };
      const turn = await this.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: 'Perform the configured-provider readiness check and reply READY.' }] } });
      const turnId = responseId(turn);
      if (!turnId || !await successfulTerminal(this, sessionId, turnId)) return { phase: 'network', outcome: 'failed' };
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
    const manifest = providerManifest(provider);
    if (!manifest) return failed('provider');
    let refreshed: unknown;
    try { refreshed = await this.refreshConfiguredSandboxProvider(manifest); }
    catch (error) { return failed(snapshotPhase(error)); }
    if (sandboxStatus(refreshed) !== 'ready') return failed('snapshots');
    let model: string | undefined;
    try { model = firstModelName(await this.readConfiguredModels()); }
    catch { return failed('model'); }
    if (!model) return failed('model');
    let sessionId: string | undefined;
    let result: DaytonaProbeResult | undefined;
    try {
      const session = await this.createSession({ agent: { spec: { model: { name: model }, config: { sandbox: { enabled: true, file_downloads: false } }, instructions: 'This is a disposable CodeAlongAI readiness probe. Use the supplied sandbox to run the command true exactly once. Do not access files, use MCP, or include workspace, editor, request, or credential data.', messages: [{ type: 'user.message', content: 'Run true in the supplied sandbox once, then reply READY.' }] } } });
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
      } catch (error) { result = failed(sandboxPhase(error)); }
    }
    if (!sessionId) return result ?? failed('sandbox-create');
    try { await this.deleteSession(sessionId); }
    catch { this.probeState.residualSessionId = sessionId; this.probeState.residualResult = result ?? { provider: 'daytona', phase: 'ready', outcome: 'ready' }; await this.probeState.persist(); return { provider: 'daytona', phase: 'cleanup', outcome: 'residual' }; }
    return result ?? { provider: 'daytona', phase: 'ready', outcome: 'ready' };
  }
  private createSdkSession(sessionRequest: unknown): Promise<unknown> { return this.client.sessions.create(sessionRequest as never); }
  private createSdkTurn(turnInput: TrueForgeTurnRequest): Promise<unknown> { return this.client.sessions.createTurn(turnInput.sessionId, turnInput.request as never); }
  private subscribeSdkTurn(sessionId: string, turnId: string): Promise<AsyncIterable<unknown>> { return this.client.sessions.subscribeToTurn(sessionId, turnId); }
  private async cancelSdkSession(sessionId: string): Promise<void> { await this.client.sessions.cancel(sessionId); }
  private async deleteSdkSession(sessionId: string): Promise<void> { await this.client.sessions.delete(sessionId); }
  private readConfiguration(): Promise<unknown> { return Promise.all([this.readConfiguredModelProviders(), this.readConfiguredSkills(), this.readConfiguredSandboxProvider()]); }
  private readConfiguredModelProviders(): Promise<unknown> { return this.client.settings.modelProviders.list(); }
  private readConfiguredSkills(): Promise<unknown> { return this.client.settings.skills.list(); }
  private readConfiguredSandboxProvider(): Promise<unknown> { return this.client.settings.sandboxProviders.get(); }
  private refreshConfiguredSandboxProvider(manifest: Record<string, unknown>): Promise<unknown> { return this.client.settings.sandboxProviders.createOrUpdate({ manifest }); }
  private readCatalogProviders(): Promise<unknown> { return this.client.catalogs.modelProviders.list(); }
  private readConfiguredModels(): Promise<unknown> { return this.client.models.list(); }
  private readModels(): Promise<unknown> { return this.readConfiguredModels(); }
  private readSkills(): Promise<unknown> { return this.client.skills.list(); }
}

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
function values(value: unknown): readonly unknown[] { const record = asRecord(value); return Array.isArray(record?.data) ? record.data : Array.isArray(value) ? value : []; }
function isFullyQualifiedModel(value: string): boolean { return /^[^/\s]+\/[^/\s]+$/.test(value); }
function configuredModel(value: unknown, name: string): Record<string, unknown> | undefined { return values(value).map(asRecord).find((candidate) => candidate?.name === name); }
function supportsReasoning(model: Record<string, unknown>, effort: string): boolean { const properties = asRecord(model.properties); const efforts = properties?.reasoningEfforts; return Array.isArray(efforts) && efforts.includes(effort); }
function hasCodeAlongAiSkill(value: unknown, commit: string): boolean { return values(value).some((candidate) => { const record = asRecord(candidate); const manifest = asRecord(record?.manifest ?? record?.data); return (manifest?.name ?? record?.name) === 'codealongai' && (manifest?.type ?? record?.type) === 'git' && (manifest?.url ?? record?.url) === 'https://github.com/krishnakartik1/codealongai.git' && (manifest?.ref ?? record?.ref) === commit && (manifest?.path ?? record?.path) === 'skills/codealongai'; }); }
function codeAlongAiSkillManifest(commit: string): Record<string, unknown> { return { name: 'codealongai', description: 'Produce one grounded CodeAlongAI walkthrough transition.', type: 'git', url: 'https://github.com/krishnakartik1/codealongai.git', path: 'skills/codealongai', ref: commit }; }
/** A credential-free, request-free public operation that verifies the configured provider can run the selected AgentSpec. */
export function producerAgentSpec(input: TrueForgeProducerReadinessInput): Record<string, unknown> { return { model: { name: input.model, params: { reasoningEffort: input.reasoningEffort } }, skills: [{ name: 'codealongai' }], mcpServers: [{ name: 'codealongai-mcp' }], config: { sandbox: { enabled: true, file_downloads: false }, parallel_tool_calls: false }, instructions: 'This is a CodeAlongAI producer readiness check. Do not access workspace, editor, source, requests, credentials, or MCP tools.' }; }
const CODEALONGAI_CATALOG = ['codealongai_get_walkthrough', 'codealongai_get_walkthrough_request', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_start_walkthrough', 'codealongai_replace_walkthrough', 'codealongai_reset_walkthrough', 'codealongai_commit_question_outcome', 'codealongai_navigate_walkthrough'];
function hasExactCatalog(value: unknown): boolean { const tools = values(value).map((tool) => asRecord(tool)?.name).filter((name): name is string => typeof name === 'string').sort(); return JSON.stringify(tools) === JSON.stringify([...CODEALONGAI_CATALOG].sort()); }
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
async function successfulTerminal(runtime: TrueForgeProducerRuntime, sessionId: string, turnId: string): Promise<boolean> { for await (const event of runtime.events(sessionId, turnId)) { const record = asRecord(event); if (record?.type !== 'turn.done') continue; const state = asRecord(record.state); return state?.status === 'completed' || state?.status === 'success'; } return false; }

/** Narrow structural seam over the pinned SDK: tests replace only this external client. */
export interface TrueForgeSdkClient {
  settings: { modelProviders: { list(): Promise<unknown> }; skills: { list(): Promise<unknown>; createOrUpdate?(request: unknown): Promise<unknown> }; sandboxProviders: { get(): Promise<unknown>; createOrUpdate(request: unknown): Promise<unknown> }; mcpServers?: { createOrUpdate(request: unknown): Promise<unknown> } };
  catalogs: { modelProviders: { list(): Promise<unknown> } }; models: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> };
  mcpServers?: { listTools(name: string): Promise<unknown> };
  sessions: { create(sessionRequest: unknown): Promise<unknown>; createTurn(sessionId: string, turnRequest: unknown): Promise<unknown>; subscribeToTurn(sessionId: string, turnId: string): Promise<AsyncIterable<unknown>>; cancel(sessionId: string): Promise<unknown>; delete(sessionId: string): Promise<unknown>; };
}
export type TrueForgeSdkClientFactory = (baseUrl: string) => TrueForgeSdkClient;
