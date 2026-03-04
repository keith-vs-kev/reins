/**
 * Reins — Delegation-only harness for the Pi coding agent.
 *
 * Extension entry point. Wires all hooks, commands, and the delegate tool.
 *
 * All hooks guard on:
 *   1. getReinsConfig(ctx.cwd).enabled — no-op when Reins is off
 *   2. isMainAgent() (REINS_SUBAGENT env var) — never restrict sub-agents
 *
 * Per ARCH §1.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBeforeAgentStart } from "./hooks/before-agent-start.js";
import { registerToolCall } from "./hooks/tool-call.js";
import { registerReinsCommand } from "./commands/reins.js";
import { registerPreworkCommand } from "./commands/prework.js";
import { registerDelegateTool } from "./tools/delegate.js";
import { getReinsConfig } from "./config.js";
import { createSessionState } from "./state.js";

export default function (pi: ExtensionAPI): void {
  // Bail early when Reins is disabled — zero footprint, no hooks/tools registered.
  const config = getReinsConfig(process.cwd());
  if (!config.enabled) return;

  // Shared in-memory state for status telemetry and circuit breaker.
  const state = createSessionState();

  // Reset session counters on session start.
  pi.on("session_start", () => {
    state.toolBlockCount = 0;
    state.consecutiveBlockCount = 0;
    state.lastBuildTimestamp = null;
    state.lastBuildStatus = null;
    state.lastBuildTokenEstimate = null;
  });

  // Register the delegation tool (always registered — needed even when Reins is off
  // so the LLM can reference it; tool_call guard handles enforcement).
  registerDelegateTool(pi);

  // Register hooks (both guard on enabled + isMainAgent internally).
  registerToolCall(pi, state);
  registerBeforeAgentStart(pi, state);

  // Register slash commands.
  registerReinsCommand(pi, state);
  registerPreworkCommand(pi);
}
