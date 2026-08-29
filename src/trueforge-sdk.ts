import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeProducerRuntime, TrueForgeTurnRequest } from './trueforge-contract';
import type { DaytonaProbeResult, DaytonaReadinessPhase } from './daytona';

/** Pinned 0.1.3 SDK adapter. It owns no credentials and passes none to CodeAlongAI. */
export class SdkTrueForgeProducerRuntime implements TrueForgeProducerRuntime {
  private readonly client: TrueForgeSdkClient;
  private residualProbeSessionId: string | undefined;
  private residualProbeResult: DaytonaProbeResult | undefined;
  public constructor(baseUrl: string, createClient: TrueForgeSdkClientFactory = (url) => new TrueForge({ baseUrl: url }) as unknown as TrueForgeSdkClient) { this.client = createClient(baseUrl); }
  public discoverConfiguration(): Promise<unknown> { return this.readConfiguration(); }
  public discoverProviders(): Promise<unknown> { return this.readCatalogProviders(); }
  public discoverModels(): Promise<unknown> { return this.readModels(); }
  public discoverSkills(): Promise<unknown> { return this.readSkills(); }
  public createSession(sessionRequest: unknown): Promise<unknown> { return this.client.sessions.create(sessionRequest as never); }
  public runTurn(turnInput: TrueForgeTurnRequest): Promise<unknown> { return this.client.sessions.createTurn(turnInput.sessionId, turnInput.request as never); }
  public async *events(sessionId: string, turnId: string): AsyncIterable<unknown> { for await (const event of await this.client.sessions.subscribeToTurn(sessionId, turnId)) yield event; }
  public async cancelTurn(sessionId: string): Promise<void> { await this.client.sessions.cancel(sessionId); }
  public async deleteSession(sessionId: string): Promise<void> { await this.client.sessions.delete(sessionId); }
  public async probeDaytona(): Promise<DaytonaProbeResult> {
    if (this.residualProbeSessionId) {
      try {
        await this.deleteSession(this.residualProbeSessionId);
        const completed = this.residualProbeResult ?? { provider: 'daytona' as const, phase: 'ready' as const, outcome: 'ready' as const };
        this.residualProbeSessionId = undefined;
        this.residualProbeResult = undefined;
        return completed;
      }
      catch { return { provider: 'daytona', phase: 'cleanup', outcome: 'residual' }; }
    }
    let provider: unknown;
    try { provider = await this.client.settings.sandboxProviders.get(); }
    catch (error) { return failed(configurationPhase(error)); }
    if (!isDaytona(provider)) return failed('provider');
    const manifest = providerManifest(provider);
    if (!manifest) return failed('provider');
    let refreshed: unknown;
    try { refreshed = await this.client.settings.sandboxProviders.createOrUpdate({ manifest }); }
    catch (error) { return failed(snapshotPhase(error)); }
    if (sandboxStatus(refreshed) !== 'ready') return failed('snapshots');
    let model: string | undefined;
    try { model = firstModelName(await this.client.models.list()); }
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
    catch { this.residualProbeSessionId = sessionId; this.residualProbeResult = result ?? { provider: 'daytona', phase: 'ready', outcome: 'ready' }; return { provider: 'daytona', phase: 'cleanup', outcome: 'residual' }; }
    return result ?? { provider: 'daytona', phase: 'ready', outcome: 'ready' };
  }
  private readConfiguration(): Promise<unknown> { return Promise.all([this.client.settings.modelProviders.list(), this.client.settings.skills.list(), this.client.settings.sandboxProviders.get()]); }
  private readCatalogProviders(): Promise<unknown> { return this.client.catalogs.modelProviders.list(); }
  private readModels(): Promise<unknown> { return this.client.models.list(); }
  private readSkills(): Promise<unknown> { return this.client.skills.list(); }
}

function failed(phase: DaytonaReadinessPhase): DaytonaProbeResult { return { provider: 'daytona', phase, outcome: 'failed' }; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function responseId(value: unknown): string | undefined { const record = asRecord(value); const data = asRecord(record?.data); return typeof data?.id === 'string' ? data.id : typeof record?.id === 'string' ? record.id : undefined; }
function isDaytona(value: unknown): boolean { const record = asRecord(value); const data = asRecord(record?.data); const manifest = asRecord(data?.manifest ?? record?.manifest); return manifest?.type === 'daytona'; }
function providerManifest(value: unknown): Record<string, unknown> | undefined { const record = asRecord(value); const data = asRecord(record?.data); return asRecord(data?.manifest ?? record?.manifest); }
function sandboxStatus(value: unknown): string | undefined { const record = asRecord(value); const data = asRecord(record?.data); return typeof (data?.status ?? record?.status) === 'string' ? data?.status as string ?? record?.status as string : undefined; }
function firstModelName(value: unknown): string | undefined { const record = asRecord(value); const values = Array.isArray(record?.data) ? record.data : Array.isArray(value) ? value : []; for (const candidate of values) { const name = asRecord(candidate)?.name; if (typeof name === 'string' && name.length > 0) return name; } return undefined; }
function errorStatus(error: unknown): number | undefined { const status = asRecord(error)?.statusCode ?? asRecord(error)?.status; return typeof status === 'number' ? status : undefined; }
function configurationPhase(error: unknown): DaytonaReadinessPhase { return errorStatus(error) === 401 || errorStatus(error) === 403 ? 'authentication' : 'provider'; }
function snapshotPhase(error: unknown): DaytonaReadinessPhase { const status = errorStatus(error); if (status === 401 || status === 403) return 'authentication'; if (status === 422) return 'authentication-or-snapshots'; return 'snapshots'; }
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

/** Narrow structural seam over the pinned SDK: tests replace only this external client. */
export interface TrueForgeSdkClient {
  settings: { modelProviders: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> }; sandboxProviders: { get(): Promise<unknown>; createOrUpdate(request: unknown): Promise<unknown> } };
  catalogs: { modelProviders: { list(): Promise<unknown> } }; models: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> };
  sessions: { create(sessionRequest: unknown): Promise<unknown>; createTurn(sessionId: string, turnRequest: unknown): Promise<unknown>; subscribeToTurn(sessionId: string, turnId: string): Promise<AsyncIterable<unknown>>; cancel(sessionId: string): Promise<unknown>; delete(sessionId: string): Promise<unknown>; };
}
export type TrueForgeSdkClientFactory = (baseUrl: string) => TrueForgeSdkClient;
