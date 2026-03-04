/**
 * /prework command — manually trigger the context builder.
 *
 * Allows users to pre-gather context for a task without enabling the
 * always-on Reins harness. The built context is injected as an invisible
 * message delivered to the LLM on the next turn.
 *
 * Per ARCH §7.2.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getReinsConfig } from "../config.js";
import { buildContextWithTimeout } from "../context-builder/builder.js";
import { hashPrompt } from "../context-builder/cache.js";

// ─── Notification helper ──────────────────────────────────────────────────────

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

// ─── Command registration ─────────────────────────────────────────────────────

export function registerPreworkCommand(pi: ExtensionAPI): void {
  pi.registerCommand("prework", {
    description: "Pre-gather context for a task: /prework <prompt>",
    handler: async (args, ctx) => {
      const prompt = (args ?? "").trim();

      if (!prompt) {
        notifyOrFallback(ctx, "Usage: /prework <what you're about to work on>", "warning");
        return;
      }

      const config = getReinsConfig(ctx.cwd);

      try {
        const promptHash = hashPrompt(prompt);
        const result = await buildContextWithTimeout({
          prompt,
          model: config.model,
          timeoutMs: config.timeoutMs,
          cacheMaxAge: config.cacheMaxAge,
          promptHash,
        });

        if (!result.context || result.context.trim() === "EMPTY") {
          notifyOrFallback(
            ctx,
            "📋 Context builder found nothing relevant for that prompt.",
            "info",
          );
          return;
        }

        const partialNote = result.partial ? " *(partial — timed out or used cache)*" : "";

        // Queue invisible context for the next turn.
        // display: false hides the message from the chat UI.
        // deliverAs: "nextTurn" injects it into the LLM context on the next user prompt.
        pi.sendMessage(
          {
            customType: "reins_prework",
            content: [
              {
                type: "text",
                text:
                  `## Reins: Pre-gathered Context (from /prework)\n\n` +
                  (result.partial
                    ? "[partial — context builder timed out or used stale cache]\n\n"
                    : "") +
                  result.context,
              },
            ],
            display: false,
          },
          { deliverAs: "nextTurn" },
        );

        // One-line confirmation to the user.
        const tokenEstimate = Math.round(result.context.length / 4);
        notifyOrFallback(
          ctx,
          `📋 Context built (~${tokenEstimate} tokens${partialNote}). Send your prompt.`,
          "info",
        );
      } catch {
        notifyOrFallback(ctx, "⚠️ Context builder failed.", "error");
      }
    },
  });
}
