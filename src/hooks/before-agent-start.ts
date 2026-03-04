/**
 * before_agent_start hook — soft enforcement + context injection.
 *
 * Fires once per user prompt (before the agent loop). Appends a delegation-only
 * instruction to the system prompt, and optionally injects pre-gathered context
 * from the context builder subprocess.
 *
 * Return type: BeforeAgentStartEventResult with systemPrompt string.
 * Pi chains systemPrompt modifications from multiple extensions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getReinsConfig } from "../config.js";
import { hashPrompt } from "../context-builder/cache.js";
import { buildContextWithTimeout } from "../context-builder/builder.js";
import { CONTEXT_BUILDER_MAX_TOKENS, REINS_SUBAGENT_ENV_VAR } from "../constants.js";
import type { ReinsSessionState } from "../state.js";

function isMainAgent(): boolean {
  return !process.env[REINS_SUBAGENT_ENV_VAR];
}

/**
 * Hard-truncate context to a token budget.
 * Uses a rough chars/4 estimate (not a true token count). This is a safety cap —
 * the builder's prompt already instructs it to stay under budget, but we enforce
 * it programmatically so an LLM overshoot can't blow out the context window.
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[truncated by Reins — exceeded token budget]";
}

export function registerBeforeAgentStart(pi: ExtensionAPI, state: ReinsSessionState): void {
  pi.on("before_agent_start", async (event, ctx) => {
    // ── Enabled guard — MUST be first. Zero cost when Reins is off. ──
    const config = getReinsConfig(ctx.cwd);
    if (!config.enabled) return;

    // Only affect main agent.
    if (!isMainAgent()) return;

    // Reset consecutive block count at the start of each agent turn.
    state.consecutiveBlockCount = 0;

    // ── Build context (with timeout + stale-cache fallback) ──
    const prompt = event.prompt;
    const promptHash = hashPrompt(prompt);

    const result = await buildContextWithTimeout({
      prompt,
      model: config.model,
      timeoutMs: config.timeoutMs,
      cacheMaxAge: config.cacheMaxAge,
      promptHash,
    });

    // Update session state for /reins status telemetry.
    state.lastBuildTimestamp = Date.now();
    if (result.context) {
      state.lastBuildStatus = result.partial ? "partial" : "success";
      state.lastBuildTokenEstimate = Math.round(result.context.length / 4);
    } else {
      state.lastBuildStatus = result.partial ? "timeout" : "failed";
      state.lastBuildTokenEstimate = null;
    }

    let contextBlock = result.context;

    // Hard truncation — never inject more than the token budget.
    if (contextBlock) {
      contextBlock = truncateToTokenBudget(contextBlock, CONTEXT_BUILDER_MAX_TOKENS);
    }

    // ── Build system prompt modification ──
    // APPEND to event.systemPrompt — never replace it.
    const parts: string[] = [
      event.systemPrompt,
      "## Reins: Delegation-Only Mode\n\n" +
        "You are operating under Reins. You MUST NOT use tools directly except " +
        "`reins_delegate` (to spawn sub-agents). " +
        "All implementation work — file reads, writes, shell commands — " +
        "must be delegated to sub-agents via `reins_delegate`.\n\n" +
        "If you attempt to call a blocked tool, it will be rejected. " +
        "Plan your delegation strategy, then spawn sub-agents to execute.",
    ];

    if (contextBlock) {
      const marker = result.partial
        ? "[context: partial — builder timed out or used stale cache]\n"
        : "";
      parts.push(`## Reins: Pre-gathered Context\n\n${marker}${contextBlock}`);
    }

    return { systemPrompt: parts.join("\n\n") };
  });
}
