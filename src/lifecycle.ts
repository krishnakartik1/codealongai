/** A listener is deliberately narrower than the walkthrough authority: lifecycle
 * changes may replace this resource, but never the active walkthrough session. */
export interface McpListener {
  readonly port: number | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type McpLifecycleState = 'off' | 'starting' | 'ready' | 'stopping';
export interface McpConfiguration { enabled: boolean; }

const maximumAllocationRetries = 3;

/**
 * Serializes configuration changes into one desired listener configuration.  The
 * final saved configuration wins even when VS Code delivers changes mid-start.
 */
export class McpLifecycle {
  private current: McpListener | undefined;
  private desired: McpConfiguration = { enabled: false };
  private desiredRevision = 0;
  private running: Promise<void> = Promise.resolve();
  private _state: McpLifecycleState = 'off';

  public constructor(private readonly createListener: () => Promise<McpListener> | McpListener) {}

  public get state(): McpLifecycleState { return this._state; }
  /** The allocated port is available only to the extension's collaborators. */
  public get port(): number | undefined { return this.current?.port; }

  public configure(configuration: McpConfiguration): Promise<void> {
    this.desired = { ...configuration };
    this.desiredRevision++;
    if (this.current && !configuration.enabled) this._state = 'stopping';
    else if (!this.current && configuration.enabled) this._state = 'starting';
    // Keep the queue usable after a bind failure; this call still receives the
    // error from its own reconciliation.
    this.running = this.running.catch(() => undefined).then(() => this.reconcile());
    return this.running;
  }

  public async dispose(): Promise<void> {
    this.desired = { enabled: false };
    this.desiredRevision++;
    if (this.current) this._state = 'stopping';
    this.running = this.running.catch(() => undefined).then(() => this.reconcile());
    await this.running;
  }

  private async reconcile(): Promise<void> {
    // A change received while an await is pending is observed by the loop.
    while (true) {
      if (!this.desired.enabled) {
        if (!this.current) { this._state = 'off'; return; }
        await this.stopCurrent();
        continue;
      }
      if (this.current) { this._state = 'ready'; return; }
      const revision = this.desiredRevision;
      this._state = 'starting';
      let lastError: unknown;
      for (let retry = 0; retry <= maximumAllocationRetries; retry += 1) {
        const listener = await this.createListener();
        try {
          await listener.start();
        } catch (error) {
          lastError = error;
          await listener.stop().catch(() => undefined);
          if (revision !== this.desiredRevision || !this.desired.enabled) break;
          continue;
        }
        this.current = listener;
        // Do not report a transient ready state when disable arrived during startup.
        if (!this.desired.enabled || revision !== this.desiredRevision) break;
        this._state = 'ready';
        return;
      }
      if (this.current) continue;
      this._state = 'off';
      if (revision !== this.desiredRevision || !this.desired.enabled) continue;
      throw lastError;
    }
  }

  private async stopCurrent(): Promise<void> {
    const listener = this.current;
    if (!listener) return;
    this._state = 'stopping';
    await listener.stop();
    if (this.current === listener) this.current = undefined;
    this._state = 'off';
  }
}
