/**
 * In-memory session state for Reins.
 *
 * Tracks telemetry for /reins status and circuit breaker behaviour.
 * All fields reset on Pi restart (per ARCH §16).
 */

export interface ReinsSessionState {
  /** Timestamp (Date.now()) when the last context build completed. null before first build. */
  lastBuildTimestamp: number | null;
  /** Status of the last context build. null before first build. */
  lastBuildStatus: "success" | "partial" | "timeout" | "failed" | null;
  /** Approximate token estimate for the last injected context (chars / 4). null before first build. */
  lastBuildTokenEstimate: number | null;
  /** Total number of tool blocks in this session. Resets on Pi restart. */
  toolBlockCount: number;
  /** Consecutive tool blocks in the current agent turn. Resets on before_agent_start. */
  consecutiveBlockCount: number;
}

export function createSessionState(): ReinsSessionState {
  return {
    lastBuildTimestamp: null,
    lastBuildStatus: null,
    lastBuildTokenEstimate: null,
    toolBlockCount: 0,
    consecutiveBlockCount: 0,
  };
}
