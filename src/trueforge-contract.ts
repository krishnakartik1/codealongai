/** The only boundary between CodeAlongAI and the external TrueForge runtime. */
import type { DaytonaProbeResult } from './daytona';
export interface TrueForgeStartOptions {
  readonly port: number;
  readonly dataPath: string;
}

export interface TrueForgeRuntime {
  start(options: TrueForgeStartOptions): Promise<void>;
  health(port: number): Promise<boolean>;
  /** Proves the endpoint speaks the public TrueForge API, not only /healthz. */
  verifyCapability(port: number): Promise<boolean>;
  /** Lets startup reject an owned bind failure instead of trusting the released port. */
  hasExited(): boolean;
  /** Validates the retained child identity before reusing its loopback endpoint. */
  ownsRunningChild(): Promise<boolean>;
  open(url: string): Promise<void>;
  stop(): Promise<void>;
  readonly producer: TrueForgeProducerRuntime;
}

export interface TrueForgeTurnRequest { readonly sessionId: string; readonly request: unknown; }

/** Safe, credentials-free producer configuration supplied by the extension. */
export interface TrueForgeProducerReadinessInput {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly mcpUrl: string;
  readonly skillCommit: string;
}

export type TrueForgeProducerReadinessPhase = 'node' | 'architecture' | 'sidecar' | 'model' | 'network' | 'authentication' | 'alias' | 'reasoning' | 'skill' | 'connector' | 'mcp-discovery' | 'ready';
export interface TrueForgeProducerReadinessResult { readonly phase: TrueForgeProducerReadinessPhase; readonly outcome: 'ready' | 'failed'; }

export interface TrueForgeProducerRuntime {
  discoverConfiguration(): Promise<unknown>;
  discoverProviders(): Promise<unknown>;
  discoverModels(): Promise<unknown>;
  discoverSkills(): Promise<unknown>;
  createSession(sessionRequest: unknown): Promise<unknown>;
  runTurn(input: TrueForgeTurnRequest): Promise<unknown>;
  events(sessionId: string, turnId: string): AsyncIterable<unknown>;
  cancelTurn(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Creates and disposes a credential-free, provider-backed readiness probe. */
  probeDaytona(): Promise<DaytonaProbeResult>;
  /** Reconciles only CodeAlongAI-owned producer configuration and proves its MCP catalog. */
  prepareProducer(input: TrueForgeProducerReadinessInput): Promise<TrueForgeProducerReadinessResult>;
}
