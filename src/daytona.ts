/** Safe, public outcome of the disposable Daytona readiness lifecycle. */
export type DaytonaReadinessPhase = 'provider' | 'authentication' | 'sandboxes' | 'snapshots' | 'sandbox-create' | 'cleanup' | 'ready';
export type DaytonaReadinessOutcome = 'ready' | 'failed' | 'residual';

export interface DaytonaProbeResult {
  readonly provider: 'daytona';
  readonly phase: DaytonaReadinessPhase;
  readonly outcome: DaytonaReadinessOutcome;
}

/** The external-runtime capability required before a walkthrough request is captured. */
export interface DaytonaProbeRuntime {
  probeDaytona(): Promise<DaytonaProbeResult>;
}

export interface DaytonaSetup {
  open(): Promise<void>;
}

export interface DaytonaReadinessResult extends DaytonaProbeResult {
  readonly action: 'none' | 'open-setup';
}

/**
 * Keeps Daytona configuration and credentials inside TrueForge. This boundary
 * deliberately exposes only a provider name, a safe phase, and lifecycle
 * outcome; no request, source, credential, or provider payload crosses it.
 */
export class DaytonaReadiness {
  public constructor(private readonly runtime: DaytonaProbeRuntime, private readonly setup: DaytonaSetup) {}

  public async check(): Promise<DaytonaReadinessResult> {
    const result = await this.runtime.probeDaytona();
    return { ...result, action: result.outcome === 'ready' ? 'none' : 'open-setup' };
  }

  public async configureOrRetry(): Promise<void> { await this.setup.open(); }
}
