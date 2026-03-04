/**
 * reins_delegate tool — delegates a task to a Pi sub-agent.
 *
 * The LLM calls this tool with a task description. The tool spawns a child
 * `pi` process with REINS_SUBAGENT=1 in its environment (isolated to the child
 * via child_process.spawn() env option — never mutates parent process.env).
 *
 * Uses child_process.spawn() directly, matching Pi's own subagent example
 * extension pattern. pi.exec() is not used because its ExecOptions lacks an
 * env option, which is required for REINS_SUBAGENT=1 isolation.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getReinsConfig } from "../config.js";
import {
  DELEGATE_DEFAULT_TOOLS,
  REINS_SUBAGENT_ENV_VAR,
} from "../constants.js";

// ─── Subprocess helpers ───────────────────────────────────────────────────────

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface SpawnOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function spawnPiSubprocess(args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const proc = spawn("pi", args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let buffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      buffer += chunk.toString();
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
 * Extract the final assistant text output from pi's JSON mode stdout.
 * Pi emits newline-delimited JSON events. We find the last message_end
 * event with an assistant message and extract its text content.
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
      // Skip non-JSON lines (debug output, etc.)
    }
  }

  return lastOutput;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerDelegateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "reins_delegate",
    label: "Delegate",
    description:
      "Delegate a task to a sub-agent. " +
      "The sub-agent runs in an isolated context with the specified tools " +
      "(defaults to all 7 built-in tools: read, bash, edit, write, grep, find, ls) " +
      "and returns a text result. Use this for all implementation work.",
    parameters: Type.Object({
      task: Type.String({ description: "Detailed task description for the sub-agent" }),
      agent: Type.Optional(
        Type.String({
          description: "Agent name override (uses default pi agent if omitted).",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory for the sub-agent process. Defaults to current cwd.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = getReinsConfig(ctx.cwd);

      const args: string[] = ["--mode", "json", "-p", "--no-session"];

      // Always specify tools explicitly so sub-agent has full built-in access.
      args.push("--tools", DELEGATE_DEFAULT_TOOLS.join(","));

      // Task prompt is the last argument.
      args.push(`Task: ${params.task}`);

      const result = await spawnPiSubprocess(args, {
        signal,
        cwd: params.cwd ?? ctx.cwd,
        // REINS_SUBAGENT=1 is isolated to the child environment via spawn()
        // env option. It is never set on parent process.env.
        env: { ...process.env, [REINS_SUBAGENT_ENV_VAR]: "1" },
      });

      if (result.code !== 0) {
        // AgentToolResult has no isError field — signal errors via content text.
        // The model reads this and can self-correct or retry.
        return {
          content: [
            {
              type: "text",
              text: `Sub-agent failed (exit ${result.code}): ${result.stderr || "(no stderr)"}`,
            },
          ],
        };
      }

      const output = extractFinalOutput(result.stdout);
      return {
        content: [{ type: "text", text: output || "(no output)" }],
      };
    },
  });
}
