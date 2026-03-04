/**
 * /reins command — toggle delegation-only mode and show status.
 *
 * Usage:
 *   /reins on     — enable Reins
 *   /reins off    — disable Reins
 *   /reins status — show current state and session telemetry
 *
 * Per ARCH §7.1.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getReinsConfig, setReinsEnabled } from "../config.js";
import { contextCache, hashPrompt } from "../context-builder/cache.js";
import { ONBOARDING_FLAG_FILENAME } from "../constants.js";
import type { ReinsSessionState } from "../state.js";

// ─── Onboarding persistence ───────────────────────────────────────────────────

const ONBOARDING_FLAG = join(homedir(), ".pi", "agent", ONBOARDING_FLAG_FILENAME);

function shouldShowOnboarding(): boolean {
  return !existsSync(ONBOARDING_FLAG);
}

function markOnboardingShown(): void {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(ONBOARDING_FLAG, new Date().toISOString(), "utf-8");
}

// ─── Notification helper ──────────────────────────────────────────────────────

/**
 * Notify with non-interactive fallback.
 * In JSON/print mode, ctx.ui.notify() is a no-op — fall back to stderr.
 */
function notifyOrFallback(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    console.error(`[reins] ${message}`);
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s ago`;
  }
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerReinsCommand(pi: ExtensionAPI, state: ReinsSessionState): void {
  pi.registerCommand("reins", {
    description: "Toggle delegation-only mode: /reins on|off|status",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      // ── /reins on ──
      if (arg === "on") {
        await setReinsEnabled(true);

        if (shouldShowOnboarding()) {
          notifyOrFallback(
            ctx,
            "🔒 Reins enabled. Agent is delegation-only.\n\n" +
              "First time? Here's what changed:\n" +
              "  • Your agent can only delegate — no direct tool use\n" +
              "  • A context builder runs once per prompt (invisible to you)\n" +
              "  • /reins off to disable, /reins status for details",
            "info",
          );
          markOnboardingShown();
        } else {
          notifyOrFallback(ctx, "🔒 Reins enabled. Agent is delegation-only.", "info");
        }
        return;
      }

      // ── /reins off ──
      if (arg === "off") {
        await setReinsEnabled(false);
        notifyOrFallback(ctx, "🔓 Reins disabled. Agent has full tool access.", "info");
        return;
      }

      // ── /reins status (or /reins with no args) ──
      if (arg === "status" || arg === "") {
        const config = getReinsConfig(ctx.cwd);
        const lines: string[] = [];

        lines.push(`Reins: ${config.enabled ? "🔒 enabled" : "🔓 disabled"}`);
        lines.push(`Model: ${config.model}`);
        lines.push(`Timeout: ${config.timeoutMs}ms`);
        lines.push(`Allowed tools: ${config.allowedTools.join(", ")}`);
        lines.push(`Cache TTL: ${Math.round(config.cacheMaxAge / 1000)}s`);
        lines.push("");

        // Session telemetry
        lines.push("── Session telemetry ──");
        if (state.lastBuildTimestamp !== null) {
          const age = Date.now() - state.lastBuildTimestamp;
          lines.push(`Last context build: ${formatAge(age)} (${state.lastBuildStatus ?? "n/a"})`);
        } else {
          lines.push("Last context build: n/a");
        }

        if (state.lastBuildTokenEstimate !== null) {
          lines.push(
            `Last build size: ~${state.lastBuildTokenEstimate} tokens (estimated, chars/4)`,
          );
        }

        lines.push(`Tool blocks this session: ${state.toolBlockCount}`);
        lines.push("");
        lines.push("Token estimates are approximate (~chars/4).");

        notifyOrFallback(ctx, lines.join("\n"), "info");
        return;
      }

      notifyOrFallback(ctx, "Usage: /reins on|off|status", "warning");
    },
  });
}
