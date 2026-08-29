/** The only boundary between CodeAlongAI and the external TrueForge runtime. */
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
}
