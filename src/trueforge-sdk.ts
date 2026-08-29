import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeProducerRuntime, TrueForgeTurnRequest } from './trueforge-contract';

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
  private readConfiguration(): Promise<unknown> { return Promise.all([this.client.settings.modelProviders.list(), this.client.settings.skills.list(), this.client.settings.sandboxProviders.get()]); }
  private readCatalogProviders(): Promise<unknown> { return this.client.catalogs.modelProviders.list(); }
  private readModels(): Promise<unknown> { return this.client.models.list(); }
  private readSkills(): Promise<unknown> { return this.client.skills.list(); }
}

/** Narrow structural seam over the pinned SDK: tests replace only this external client. */
export interface TrueForgeSdkClient {
  settings: { modelProviders: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> }; sandboxProviders: { get(): Promise<unknown> } };
  catalogs: { modelProviders: { list(): Promise<unknown> } }; models: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> };
  sessions: { create(sessionRequest: unknown): Promise<unknown>; createTurn(sessionId: string, turnRequest: unknown): Promise<unknown>; subscribeToTurn(sessionId: string, turnId: string): Promise<AsyncIterable<unknown>>; cancel(sessionId: string): Promise<unknown>; delete(sessionId: string): Promise<unknown>; };
}
export type TrueForgeSdkClientFactory = (baseUrl: string) => TrueForgeSdkClient;
