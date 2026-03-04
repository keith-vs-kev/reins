/**
 * Context builder — spawns a read-only Pi subprocess to gather context
 * before the main agent starts delegating.
 *
 * Key behaviours:
 * - Promise.race() timeout pattern (TIMEOUT_SENTINEL)
 * - Stale cache fallback on timeout or hard failure
 * - Hard truncation cap of 40,000 chars (≈ CONTEXT_BUILDER_MAX_TOKENS * 4)
 * - Subprocess marked with REINS_SUBAGENT=1 to prevent recursive restriction
 *
 * Per ARCH §4.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_BUILDER_MAX_TOKENS,
  CONTEXT_BUILDER_TOOLS,
  DEFAULT_CACHE_MAX_AGE,
  REINS_SUBAGENT_ENV_VAR,
} from "../constants.js";
import { contextCache, hashPrompt } from "./cache.js";
import { CONTEXT_BUILDER_SYSTEM_PROMPT } from "./prompt.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BuildResult {
  /** The gathered context string, or undefined if nothing relevant was found. */
  context: string | undefined;
  /**
   * True if the result is partial (timeout or stale cache used).
   * False on clean success or hard failure with no cache.
   */
  partial: boolean;
}

interface BuildOptions {
  prompt: string;
  model: string;
  timeoutMs: number;
  cacheMaxAge?: number;
  promptHash: string;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

// ─── Sentinel ────────────────────────────────────────────────────────────────

const TIMEOUT_SENTINEL = Symbol("timeout");

// ─── Subprocess helpers ───────────────────────────────────────────────────────

function spawnPiSubprocess(
  args: string[],
  opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const proc = spawn("pi", args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });

    proc.on("error", () => {
      resolve({ code: 1, stdout, stderr });
    });

    if (opts.signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (opts.signal.aborted) {
        killProc();
      } else {
        opts.signal.addEventListener("abort", killProc, { once: true });
      }
    }
  });
}

/**
 * Write a string to a temp file. Returns the file path.
 * Used to pass the system prompt to pi via --append-system-prompt.
 */
function writeTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reins-ctx-"));
  const filePath = join(dir, "system-prompt.md");
  writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return filePath;
}

function cleanupTempFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Extract the final assistant text output from pi's JSON mode stdout.
 */
function extractFinalOutput(stdout: string): string {
  const lines = stdout.split("\n");
  let lastOutput = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        event["type"] === "message_end" &&
        event["message"] &&
        typeof event["message"] === "object"
      ) {
        const msg = event["message"] as Record<string, unknown>;
        if (msg["role"] === "assistant" && Array.isArray(msg["content"])) {
          for (const part of msg["content"] as Array<Record<string, unknown>>) {
            if (part["type"] === "text" && typeof part["text"] === "string") {
              lastOutput = part["text"];
            }
          }
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return lastOutput;
}

// ─── Context builder subprocess ───────────────────────────────────────────────

/**
 * Spawn a Pi context builder subprocess with read-only + research tools.
 * Returns context string or undefined if nothing relevant.
 */
async function spawnContextBuilder(opts: {
  prompt: string;
  model: string;
}): Promise<BuildResult> {
  const tmpFile = writeTempFile(CONTEXT_BUILDER_SYSTEM_PROMPT);

  try {
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      opts.model,
      "--tools",
      CONTEXT_BUILDER_TOOLS.join(","),
      "--append-system-prompt",
      tmpFile,
      `Task: Gather context for the following user request:\n\n${opts.prompt}`,
    ];

    const result = await spawnPiSubprocess(args, {
      env: { ...process.env, [REINS_SUBAGENT_ENV_VAR]: "1" },
    });

    if (result.code !== 0) {
      return { context: undefined, partial: false };
    }

    const output = extractFinalOutput(result.stdout);

    if (!output || output.trim() === "EMPTY") {
      return { context: undefined, partial: false };
    }

    // Hard truncation cap: 40,000 chars (≈ CONTEXT_BUILDER_MAX_TOKENS * 4)
    const maxChars = CONTEXT_BUILDER_MAX_TOKENS * 4;
    const truncated =
      output.length > maxChars
        ? output.slice(0, maxChars) + "\n\n[truncated by Reins context builder]"
        : output;

    return { context: truncated, partial: false };
  } finally {
    cleanupTempFile(tmpFile);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build context with a timeout, falling back to stale cache on timeout/error.
 *
 * Flow:
 * 1. Race builder subprocess against timeout (TIMEOUT_SENTINEL pattern)
 * 2. Timeout → stale cache (partial: true) or nothing (partial: true)
 * 3. Hard failure → stale cache (partial: true) or nothing (partial: false)
 * 4. Success → update cache, return context (partial: false)
 */
export async function buildContextWithTimeout(opts: BuildOptions): Promise<BuildResult> {
  const { prompt, model, timeoutMs, promptHash } = opts;
  const maxAge = opts.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE;

  const buildPromise = spawnContextBuilder({ prompt, model });

  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
    setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs),
  );

  try {
    const result = await Promise.race([buildPromise, timeoutPromise]);

    if (result === TIMEOUT_SENTINEL) {
      // Timeout — check stale cache
      const stale = contextCache.get(promptHash);
      if (stale) return { context: stale, partial: true };
      return { context: undefined, partial: true };
    }

    // Success — update cache if we got context
    if (result.context) {
      contextCache.set(promptHash, result.context, maxAge);
    }
    return result;
  } catch {
    // Hard failure — check stale cache
    const stale = contextCache.get(promptHash);
    if (stale) return { context: stale, partial: true };
    return { context: undefined, partial: false };
  }
}
