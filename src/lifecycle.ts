/** A listener is deliberately narrower than the walkthrough authority: lifecycle
 * changes may replace this resource, but never the active walkthrough session. */
export interface McpListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type McpLifecycleState = 'off' | 'starting' | 'ready' | 'stopping';
export interface McpConfiguration { enabled: boolean; port: number; }

/**
 * Serializes configuration changes into one desired listener configuration.  The
 * final saved configuration wins even when VS Code delivers changes mid-start.
 */
export class McpLifecycle {
  private current: McpListener | undefined;
  private currentPort: number | undefined;
  private desired: McpConfiguration = { enabled: false, port: 61337 };
  private running: Promise<void> = Promise.resolve();
  private _state: McpLifecycleState = 'off';

  public constructor(private readonly createListener: (port: number) => Promise<McpListener> | McpListener) {}

  public get state(): McpLifecycleState { return this._state; }
  public get port(): number | undefined { return this.currentPort; }

  public configure(configuration: McpConfiguration): Promise<void> {
    if (!Number.isInteger(configuration.port) || configuration.port < 1024 || configuration.port > 65535) {
      return Promise.reject(new RangeError('CodeAlongAI MCP port must be an integer from 1024 through 65535.'));
    }
    this.desired = { ...configuration };
    // Keep the queue usable after a bind failure; this call still receives the
    // error from its own reconciliation.
    this.running = this.running.catch(() => undefined).then(() => this.reconcile());
    return this.running;
  }

  public async dispose(): Promise<void> {
    this.desired = { ...this.desired, enabled: false };
    this.running = this.running.catch(() => undefined).then(() => this.reconcile());
    await this.running;
  }

  private async reconcile(): Promise<void> {
    // A change received while an await is pending is observed by the loop.
    while (true) {
      if (!this.desired.enabled) {
        if (!this.current) { this._state = 'off'; return; }
        const listener = this.current;
        this._state = 'stopping';
        await listener.stop();
        if (this.current === listener) { this.current = undefined; this.currentPort = undefined; }
        this._state = 'off';
        continue;
      }
      if (this.current && this.currentPort === this.desired.port) { this._state = 'ready'; return; }
      if (this.current) {
        const listener = this.current;
        this._state = 'stopping';
        await listener.stop();
        if (this.current === listener) { this.current = undefined; this.currentPort = undefined; }
        this._state = 'off';
        continue;
      }
      const port = this.desired.port;
      this._state = 'starting';
      const listener = await this.createListener(port);
      try {
        await listener.start();
      } catch (error) {
        this._state = 'off';
        throw error;
      }
      // Do not report a transient ready state when disable/port-change arrived
      // during startup; reconcile it immediately.
      this.current = listener;
      this.currentPort = port;
      if (!this.desired.enabled || this.desired.port !== port) continue;
      this._state = 'ready';
      return;
    }
  }
}
