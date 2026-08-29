import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeProducerRuntime, TrueForgeTurnRequest } from './trueforge-contract';
import type { DaytonaProbeResult, DaytonaReadinessPhase } from './daytona';

/** Pinned 0.1.3 SDK adapter. It owns no credentials and passes none to CodeAlongAI. */
export class SdkTrueForgeProducerRuntime implements TrueForgeProducerRuntime {
  private readonly client: TrueForgeSdkClient;
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
    const provider = await this.client.settings.sandboxProviders.get();
    if (!isDaytona(provider)) return failed('provider');
    if (sandboxStatus(provider) !== 'ready') return failed('authentication');
    const model = firstModelName(await this.client.models.list());
    if (!model) return failed('authentication');
    let sessionId: string | undefined;
    try {
      const session = await this.createSession({ agent: { spec: { model: { name: model }, config: { sandbox: { enabled: true, file_downloads: false } }, instructions: 'This is a disposable CodeAlongAI readiness probe. Do not use tools or a sandbox command. Reply READY.', messages: [{ type: 'user.message', content: 'Reply READY.' }] } } });
      sessionId = responseId(session);
      if (!sessionId) return failed('sandbox-create');
      await this.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: 'Reply READY.' }] } });
    } catch (error) { return failed(phaseFor(error)); }
    try { await this.deleteSession(sessionId!); }
    catch { return { provider: 'daytona', phase: 'cleanup', outcome: 'residual' }; }
    return { provider: 'daytona', phase: 'ready', outcome: 'ready' };
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
function sandboxStatus(value: unknown): string | undefined { const record = asRecord(value); const data = asRecord(record?.data); return typeof (data?.status ?? record?.status) === 'string' ? data?.status as string ?? record?.status as string : undefined; }
function firstModelName(value: unknown): string | undefined { const record = asRecord(value); const values = Array.isArray(record?.data) ? record.data : Array.isArray(value) ? value : []; for (const candidate of values) { const name = asRecord(candidate)?.name; if (typeof name === 'string' && name.length > 0) return name; } return undefined; }
function phaseFor(error: unknown): DaytonaReadinessPhase { const message = error instanceof Error ? error.message.toLowerCase() : ''; if (message.includes('snapshot')) return 'snapshots'; if (message.includes('sandbox')) return 'sandboxes'; if (message.includes('auth') || message.includes('credential') || message.includes('unauthor')) return 'authentication'; return 'sandbox-create'; }

/** Narrow structural seam over the pinned SDK: tests replace only this external client. */
export interface TrueForgeSdkClient {
  settings: { modelProviders: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> }; sandboxProviders: { get(): Promise<unknown> } };
  catalogs: { modelProviders: { list(): Promise<unknown> } }; models: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> };
  sessions: { create(sessionRequest: unknown): Promise<unknown>; createTurn(sessionId: string, turnRequest: unknown): Promise<unknown>; subscribeToTurn(sessionId: string, turnId: string): Promise<AsyncIterable<unknown>>; cancel(sessionId: string): Promise<unknown>; delete(sessionId: string): Promise<unknown>; };
}
export type TrueForgeSdkClientFactory = (baseUrl: string) => TrueForgeSdkClient;
