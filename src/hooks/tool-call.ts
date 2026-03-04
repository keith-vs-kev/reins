/**
 * tool_call hook — hard enforcement of delegation-only mode.
 *
 * Blocks any tool not in the configured allowlist when Reins is enabled
 * and the process is identified as the main agent (not a Reins sub-agent).
 *
 * Returns { block: true, reason } to Pi, which surfaces the reason to the LLM
 * as a tool result error, enabling self-correction.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getReinsConfig } from "../config.js";
import { ALLOWED_TOOLS, REINS_SUBAGENT_ENV_VAR } from "../constants.js";
import type { ReinsSessionState } from "../state.js";

/**
 * Best-effort check for Reins-spawned subprocesses.
 *
 * Reins sets REINS_SUBAGENT=1 on every pi subprocess it spawns via
 * child_process.spawn() env option (isolated to child). Absence of the env
 * var is treated as the main agent.
 *
 * ⚠️ ADR-002: This is a bounded heuristic, not a guarantee. Sub-agents
 * spawned by other mechanisms (not via reins_delegate) will not have this
 * marker and may be incorrectly restricted if Reins is globally installed.
 */
function isMainAgent(): boolean {
  return !process.env[REINS_SUBAGENT_ENV_VAR];
}

export function registerToolCall(pi: ExtensionAPI, state: ReinsSessionState): void {
  pi.on("tool_call", (event, ctx) => {
    // ── Enabled guard — MUST be first. Zero cost when Reins is off. ──
    const config = getReinsConfig(ctx.cwd);
    if (!config.enabled) return;

    // Only restrict the main agent — sub-agents must have full tool access.
    if (!isMainAgent()) return;

    const allowed = config.allowedTools ?? ALLOWED_TOOLS;
    if (allowed.includes(event.toolName)) return;

    // Track block count for status telemetry and circuit breaker.
    state.toolBlockCount++;
    state.consecutiveBlockCount++;

    return {
      block: true,
      reason:
        `Reins: "${event.toolName}" is blocked in delegation-only mode. ` +
        `Delegate this work to a sub-agent via reins_delegate instead.`,
    };
  });
}
