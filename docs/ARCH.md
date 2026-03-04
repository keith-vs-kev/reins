# Architecture Spec: Reins

**Status:** Draft
**Author:** Soren (via Iris)
**Date:** 2026-03-03
**Companion:** [PRD](./PRD.md)

> **Reins is a Pi extension.** It hooks into the Pi coding agent's event system to constrain the main agent to delegation-only mode. The extension registers a `reins_delegate` tool via `pi.registerTool()` that internally spawns `pi` sub-processes using `child_process.spawn()` (matching Pi's own subagent example extension).

> **Spawn strategy:** Reins uses `child_process.spawn()` for **all** subprocess creation (both context builder and `reins_delegate`). `pi.exec()` is not used because its `ExecOptions` only exposes `signal`, `timeout`, and `cwd` — there is no `env` option, which is required for `REINS_SUBAGENT=1` tagging. `pi.exec()` remains suitable for simple non-Reins shell commands within other extensions.

---

## 1. Extension Structure

```
reins/
├── package.json              # Pi extension discovery via "pi.extensions"
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry point — export default function(pi: ExtensionAPI)
│   ├── hooks/
│   │   ├── before-agent-start.ts    # Context injection + soft enforcement
│   │   └── tool-call.ts             # Hard tool blocking
│   ├── commands/
│   │   ├── reins.ts           # /reins on|off|status
│   │   └── prework.ts         # /prework <prompt>
│   ├── tools/
│   │   └── delegate.ts        # reins_delegate tool definition
│   ├── context-builder/
│   │   ├── builder.ts         # Sub-process orchestration + timeout wrapper
│   │   ├── prompt.ts          # System prompt template for the context builder
│   │   └── cache.ts           # Stale-cache layer
│   ├── config.ts              # Config reading from settings.json (two-scope)
│   └── constants.ts           # Tool allowlist, timeouts, cache keys
└── docs/
    ├── PRD.md
    ├── ARCH.md
    └── UX-SPEC.md
```

### Discovery & Configuration

Pi extensions are discovered by convention or via `package.json`:

| Method | Path |
|--------|------|
| Global directory | `~/.pi/agent/extensions/reins/index.ts` |
| Project-local | `.pi/extensions/reins/index.ts` |
| Settings path | `~/.pi/agent/settings.json` → `"extensions": ["/path/to/reins/src/index.ts"]` |
| Package.json | `"pi": { "extensions": ["./src/index.ts"] }` |

**`package.json`:**

```json
{
  "name": "reins",
  "version": "0.1.0",
  "description": "Delegation-only harness for the Pi coding agent",
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "dependencies": {}
}
```

### Settings (Two-Scope Model)

Pi uses a two-scope settings model. Project settings override global settings:

| Scope | Path | Precedence |
|-------|------|-----------|
| Global | `~/.pi/agent/settings.json` | Base defaults |
| Project | `.pi/settings.json` | Overrides global |

Reins configuration lives under a `reins` key in either scope:

```jsonc
// ~/.pi/agent/settings.json (global — applies everywhere)
{
  "extensions": ["~/.pi/agent/extensions/reins/index.ts"],
  "reins": {
    "enabled": false,
    "model": "claude-sonnet-4-20250514",
    "timeoutMs": 12000,
    "allowedTools": ["reins_delegate"],
    "cacheMaxAge": 300000,
    "debug": false
  }
}
```

```jsonc
// .pi/settings.json (project — overrides global for this repo)
{
  "reins": {
    "enabled": true,           // Override: always-on for this project
    "model": "claude-haiku-4-20250414"  // Faster builder for this project
  }
}
```

### Entry Point (`src/index.ts`)

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolCall } from "./hooks/tool-call.js";
import { registerBeforeAgentStart } from "./hooks/before-agent-start.js";
import { registerReinsCommand } from "./commands/reins.js";
import { registerPreworkCommand } from "./commands/prework.js";
import { registerDelegateTool } from "./tools/delegate.js";

export default function (pi: ExtensionAPI) {
  registerDelegateTool(pi);
  registerToolCall(pi);
  registerBeforeAgentStart(pi);
  registerReinsCommand(pi);
  registerPreworkCommand(pi);
}
```

Registration uses `pi.on()` for lifecycle events, `pi.registerCommand()` for slash commands, and `pi.registerTool()` for the delegation tool. Pi has no built-in delegation tool — Reins must provide one.

---

## 2. Hook Implementations

### 2.1 `tool_call` — Hard Enforcement

The simplest hook. Synchronous, stateless, zero allocations on the happy path.

> **Enabled guard (mandatory):** The very first operation in this hook is reading the enabled flag from settings. If Reins is disabled, the hook returns immediately (no-op). When Reins is off, there is **zero impact** on agent behaviour.

```ts
// hooks/tool-call.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ALLOWED_TOOLS } from "../constants.js";
import { getReinsConfig } from "../config.js";

export function registerToolCall(pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    // ── Enabled guard ── MUST be first. No-op when Reins is off.
    const config = getReinsConfig(ctx.cwd);
    if (!config.enabled) return;

    // Only restrict main agent — sub-agents need full tool access.
    // See ADR-002 for detection strategy.
    if (!isMainAgent()) return;

    const allowed = config.allowedTools ?? ALLOWED_TOOLS;
    if (allowed.includes(event.toolName)) return;

    return {
      block: true,
      reason:
        `Reins: "${event.toolName}" is blocked in delegation-only mode. ` +
        `Delegate this work to a sub-agent via reins_delegate instead.`,
    };
  });
}

/**
 * Best-effort heuristic for Reins-spawned subprocesses.
 *
 * No framework-level parent/depth API currently exists in Pi.
 * Reins sets REINS_SUBAGENT=1 on sub-processes it spawns via reins_delegate.
 * Absence of this env var is treated as "main agent" — but this is a
 * bounded heuristic, not a guarantee. Sub-agents spawned by other
 * mechanisms (e.g., the subagent example extension) will not have this
 * marker and may be incorrectly restricted if Reins is loaded.
 *
 * ⚠️ ADR-002: Unresolved implementation risk. Validate with e2e tests.
 */
function isMainAgent(): boolean {
  return !process.env.REINS_SUBAGENT;
}
```

**Key decisions:**

- **Only restricts the main agent** — sub-agents spawned by the main agent must have full tool access, otherwise the entire pattern collapses. The guard uses `isMainAgent()` based on environment variables (see ADR-002).
- **Returns `{ block: true, reason }` ** — this is the actual Pi extension return shape for `tool_call` events (typed as `ToolCallEventResult` in `types.ts`).
- **Synchronous** — no async work, no allocations on the hot path when disabled.
- **Configurable allowlist** — defaults from `ALLOWED_TOOLS`, overridable via settings.

### 2.2 `before_agent_start` — Soft Enforcement + Context Injection

The complex hook. Async, spawns a context builder sub-process, manages timeouts and cache.

> **Enabled guard (mandatory):** Same pattern — check enabled first, return immediately if off.

> **Event timing:** `before_agent_start` fires **once per user prompt** (before the agent loop starts), not before each internal tool/LLM turn. The context builder therefore runs once per prompt, not per turn.
>
> **Return type:** `BeforeAgentStartEventResult` — can include `systemPrompt` (string) and/or `message` (custom message). If multiple extensions return `systemPrompt`, they are chained.

```ts
// hooks/before-agent-start.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getReinsConfig } from "../config.js";
import { buildContextWithTimeout } from "../context-builder/builder.js";
import { contextCache, hashPrompt } from "../context-builder/cache.js";
import { CONTEXT_BUILDER_MAX_TOKENS } from "../constants.js";

export function registerBeforeAgentStart(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    // ── Enabled guard ── MUST be first. No-op when Reins is off.
    const config = getReinsConfig(ctx.cwd);
    if (!config.enabled) return;

    // Only affect main agent (see ADR-002)
    if (!isMainAgent()) return;

    // 1. Build context (with timeout + stale-cache fallback)
    // event.prompt is the effective prompt (post skill/template expansion, not raw user input)
    // event.systemPrompt is the current system prompt
    const prompt = event.prompt;
    const promptHash = hashPrompt(prompt);

    // buildContextWithTimeout handles timeout → stale cache → NO_CONTEXT
    // and hard failure → stale cache → NO_CONTEXT internally (see §4.1)
    const result = await buildContextWithTimeout({
      prompt,
      model: config.model,
      timeoutMs: config.timeoutMs,
      cacheMaxAge: config.cacheMaxAge,
      promptHash,
      pi,
    });

    let contextBlock = result.context;
    const partial = result.partial;

    // Hard truncation — never inject more than the token budget
    if (contextBlock) {
      contextBlock = truncateToTokenBudget(contextBlock, CONTEXT_BUILDER_MAX_TOKENS);
    }

    // 2. Build system prompt modification
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
      const marker = partial ? "[context: partial — builder timed out or used cache]" : "";
      parts.push(`## Reins: Pre-gathered Context\n\n${marker}\n${contextBlock}`);
    }

    // Return modified system prompt — Pi chains systemPrompt across extensions
    return { systemPrompt: parts.join("\n\n") };
  });
}

function isMainAgent(): boolean {
  return !process.env.REINS_SUBAGENT;
}

/**
 * Hard-truncate context to a token budget.
 * Uses a rough chars/4 estimate (not a true token count). This is a safety
 * cap — the builder's prompt already instructs it to stay under budget, but
 * we enforce it here programmatically so an LLM overshoot can't blow out
 * the context window.
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[truncated by Reins — exceeded token budget]";
}
```

**Lifecycle per user prompt:**

1. Check enabled + main agent guard
2. Run context builder with `Promise.race` timeout
3. On success → hard-truncate to 4000 tokens, inject context, update cache
4. On timeout → inject partial result if available, else stale cache
5. On total failure → stale cache or nothing
6. Always inject delegation-only instruction regardless of context outcome
7. Return `{ systemPrompt }` — Pi chains system prompt modifications from multiple extensions

---

## 3. Delegation Tool

Pi has no built-in delegation tool. Pi's default active tools are `read`, `bash`, `edit`, `write` (4 tools), with `grep`, `find`, `ls` available in the registry (7 total). Reins must register its own delegation tool so the cuffed agent can spawn sub-agents.

### 3.1 Tool Registration

```ts
// tools/delegate.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export function registerDelegateTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "reins_delegate",
    label: "Delegate",
    description:
      "Delegate a task to a sub-agent. " +
      "The sub-agent runs in an isolated context with tools as specified (defaults to all 7 built-in tools) and returns a text result.",
    parameters: Type.Object({
      task: Type.String({ description: "Detailed task description for the sub-agent" }),
      model: Type.Optional(
        Type.String({
          description: "Model ID override (e.g. claude-sonnet-4-20250514). Uses default if omitted.",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tool subset for the sub-agent (e.g. ['read', 'bash', 'edit', 'write']). All tools if omitted.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = getReinsConfig(ctx.cwd);
      const model = params.model ?? config.model;
      const args: string[] = ["--mode", "json", "-p", "--no-session"];

      if (model) args.push("--model", model);
      // Default active tools are only 4: read, bash, edit, write.
      // Explicitly pass tools so the sub-agent has what it needs.
      const tools = params.tools?.length ? params.tools : ["read", "bash", "edit", "write", "grep", "find", "ls"];
      args.push("--tools", tools.join(","));

      args.push(`Task: ${params.task}`);

      // Use child_process.spawn() directly (matching Pi's own subagent
      // example) with REINS_SUBAGENT=1 isolated to the child env.
      const result = await spawnPiSubprocess(args, {
        signal,
        env: { ...process.env, REINS_SUBAGENT: "1" },
      });

      if (result.code !== 0) {
        // AgentToolResult has no isError field — signal errors via content text.
        // For hard failures, throw instead (Pi surfaces the error to the model).
        return {
          content: [{ type: "text", text: `Sub-agent failed (exit ${result.code}): ${result.stderr}` }],
        };
      }

      // Parse JSON mode output to extract final assistant message
      const output = extractFinalOutput(result.stdout);
      return {
        content: [{ type: "text", text: output || "(no output)" }],
      };
    },
  });
}
```

> **Error signalling:** `AgentToolResult<T>` is `{ content: (TextContent|ImageContent)[], details: T }` — there is no `isError` field in the type contract. To signal errors from `execute()`: return error text in `content` (the model reads it and self-corrects), or `throw` (Pi surfaces the exception as an error result). Note: `ToolResultEventResult` (the `tool_result` event handler return type) does have an optional `isError` field — but that's a different type used for post-execution result modification, not for `execute()` returns.

### 3.2 How It Works

1. The LLM calls `reins_delegate` with a task description
2. The tool's `execute()` function uses `child_process.spawn("pi", [...args])` to spawn a child `pi` process
3. The child runs in JSON mode (`--mode json`), print mode (`-p`), with no session (`--no-session`)
4. The child has tools as specified in spawn args (Reins defaults to all 7: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` via explicit `--tools` flag)
5. The child's environment includes `REINS_SUBAGENT=1` (set via `spawn()` env option — isolated to child, does not mutate parent `process.env`) so if Reins is loaded there, it won't restrict the sub-agent
6. Output is captured from stdout, parsed, and returned to the LLM

### 3.3 Key Design Note: `child_process.spawn()` vs LLM Tools

Reins uses `child_process.spawn()` directly (matching Pi's own `subagent` example extension) to spawn sub-processes. This is the canonical approach — it allows setting `REINS_SUBAGENT=1` in the child environment without mutating the parent's `process.env`.

The flow is:

```
LLM calls reins_delegate (LLM tool) → execute() runs spawn("pi", [...], { env }) → spawns pi subprocess
```

This distinction is critical: the LLM interacts with `reins_delegate` as a registered tool. The subprocess spawning is an implementation detail inside the tool's `execute()` function.

> **Note on `subpi`:** The `subpi` CLI tool is an optional ecosystem convenience for spawning Pi sub-agents. It is **not required** by Reins. The canonical approach is to spawn `pi` directly via `child_process.spawn("pi", ["--mode", "json", "-p", "--no-session", ...])`, matching the pattern from Pi's official `subagent` example extension.

> **Why not `pi.exec()`?** Pi's `ExecOptions` only exposes `signal`, `timeout`, and `cwd` — there is no `env` option. Since Reins needs to set `REINS_SUBAGENT=1` on the child process only, `child_process.spawn()` is required. Do not use `pi.exec()` for subprocess spawning.

---

## 4. Context Builder Sub-Agent

The context builder is the intelligence layer. It decides what the main agent needs to know before delegating.

### 4.1 Execution Model

The context builder runs as a **sub-process spawned via `child_process.spawn()`**. It invokes `pi` directly in print+JSON mode.

The builder is granted **read-only tools only**: `read`, `grep`, `find`, `ls`. It cannot write, execute shell commands, or modify anything.

```ts
// context-builder/builder.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CONTEXT_BUILDER_SYSTEM_PROMPT } from "./prompt.js";

type BuildResult = { context: string | undefined; partial: boolean };

const TIMEOUT_SENTINEL = Symbol("timeout");

export async function buildContextWithTimeout(opts: {
  prompt: string;
  model: string;
  timeoutMs: number;
  pi: ExtensionAPI;
  promptHash: string;
}): Promise<BuildResult> {
  const { prompt, model, timeoutMs, pi, promptHash } = opts;

  const buildPromise = spawnContextBuilder(pi, {
  systemPrompt: CONTEXT_BUILDER_SYSTEM_PROMPT,
  userPrompt: `Gather context for the following user request:\n\n${prompt}`,
  model,
  tools: ["read", "grep", "find", "ls", "web_search", "web_fetch"],
  });
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
    setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs),
  );

  try {
    const result = await Promise.race([buildPromise, timeoutPromise]);

    if (result === TIMEOUT_SENTINEL) {
      // Timeout path — check stale cache
      const stale = contextCache.get(promptHash);
      if (stale) return { context: stale, partial: true };
      return { context: undefined, partial: true };
    }

    // Success — update cache
    if (result.context) {
      contextCache.set(promptHash, result.context, opts.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE);
    }
    return result;
  } catch {
    // Hard failure — check stale cache
    const stale = contextCache.get(promptHash);
    if (stale) return { context: stale, partial: true };
    return { context: undefined, partial: false };
  }
}

async function spawnContextBuilder(
  pi: ExtensionAPI,
  opts: { systemPrompt: string; userPrompt: string; model: string; tools: string[] },
): Promise<BuildResult> {
  // Write system prompt to temp file for --append-system-prompt flag
  const tmpFile = writeTempFile(opts.systemPrompt);

  try {
    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--model", opts.model,
      "--tools", opts.tools.join(","),
      "--append-system-prompt", tmpFile,
      `Task: ${opts.userPrompt}`,
    ];

    const result = await spawnPiSubprocess(args, {
      env: { ...process.env, REINS_SUBAGENT: "1" },
    });

    if (result.code !== 0) {
      return { context: undefined, partial: false };
    }

    const output = extractFinalOutput(result.stdout);
    if (!output || output.trim() === "EMPTY") {
      return { context: undefined, partial: false };
    }

    return { context: output, partial: false };
  } finally {
    cleanupTempFile(tmpFile);
  }
}
```

### 4.2 What It Receives

| Input | Source | Purpose |
|-------|--------|---------|
| Effective prompt (post-expansion) | `event.prompt` from `before_agent_start` event | Understand intent (post skill/template expansion) |
| Read-only tools | `read`, `grep`, `find`, `ls` | Gather file contents and structure |
| Research tools | `web_search`, `web_fetch` | Research libraries, docs, and patterns |

> **Note:** The builder subprocess runs with `--no-session` and therefore has **no session message history**. "Memory" in this context means file-based memory (workspace files like `MEMORY.md`, daily logs) that the builder can `read` from disk — not session state.

### 4.3 What It Does

The context builder is a sub-process with read-only and research tool access. It:

1. Receives the effective prompt (post skill/template expansion)
2. Uses `find` and `ls` to explore the workspace structure
3. Uses `grep` to find relevant files
4. Uses `read` to pull file contents
5. Uses `web_search` and `web_fetch` to look up documentation, libraries, or architectural patterns
6. Returns a structured markdown summary of relevant context with citations

### 4.4 What It Returns

A structured context block (plain text/markdown) containing any combination of:

- **Relevant file contents** — files the main agent will need to reference when delegating
- **Web research results** — documentation summaries, library usage patterns
- **Citations** — references to local files (`[file: path]`) and web sources (`[url: link]`)
- **Memory excerpts** — from MEMORY.md, daily logs, etc.
- **Codebase structure** — directory trees, key file listings
- **Nothing** — if the prompt is conversational or doesn't need codebase context (returns "EMPTY")

After the builder returns, the extension applies a **hard truncation cap** of 4000 tokens (see §2.2).

### 4.5 System Prompt

```ts
// context-builder/prompt.ts
export const CONTEXT_BUILDER_SYSTEM_PROMPT = `You are a context builder for an AI agent operating in delegation-only mode.

You have read-only tools: read, grep, find, ls, and research tools: web_search, web_fetch. Use them to explore the workspace
and the web to gather context the main agent needs to effectively delegate work.

## What to gather
- File contents directly relevant to the prompt (use read)
- Documentation, library patterns, or concept research (use web_search, web_fetch)
- Directory structure if the prompt involves code navigation (use ls, find)
- Memory/context files if the prompt references past work (use read)
- Search for relevant patterns (use grep)

## Citations
You MUST provide citations for all information gathered:
- Local files: [file: path/to/file.ts]
- Web sources: [url: https://...]
Place citations next to the relevant information so the main agent knows where to look for more detail.

## Rules
1. Be conservative — only include what's clearly relevant
2. Prefer structure (file trees, signatures) over full file dumps
3. If the prompt is conversational (greeting, question, chat), return EMPTY
4. Keep total output under 4000 tokens
5. Format as markdown sections with file paths or web topics as headers
6. If you're unsure whether something is relevant, skip it

## Output format
Return markdown with relevant context and citations, or the single word EMPTY if no context is needed.`;
```

### 4.6 Recursion Safety

The context builder runs as a sub-process (separate `pi` invocation via `child_process.spawn()`). This means:
1. The child `pi` process loads its **own** extensions from discovery paths independently
2. The `REINS_SUBAGENT=1` env var is set (isolated to child via `spawn()` env option), so `isMainAgent()` returns false
3. Even if Reins is loaded in the sub-process, the tool_call hook won't restrict it
4. There is no risk of infinite recursion — the sub-process is a flat invocation, not a re-entrant hook

**Extension loading in child processes:** When Reins spawns `pi` via `child_process.spawn()`, the child process loads extensions from its own discovery paths. If Reins is installed globally (e.g., in `~/.pi/agent/extensions/`), the child `pi` will **also** load Reins. This is exactly why the `REINS_SUBAGENT=1` environment gate matters — without it, the child would restrict itself. The env var is the sole mechanism preventing recursive restriction.

This applies to both the context builder and the `reins_delegate` tool — any `pi` subprocess spawned by Reins must have `REINS_SUBAGENT=1` set.

---

## 5. Tool Allowlist

### Pi Built-in Tools (Reference)

Pi's default active tools (`codingTools`): `read`, `bash`, `edit`, `write` (4 tools).
Additional tools available in registry (`allTools`): `grep`, `find`, `ls` (7 total).

There are **no** built-in tools named `subagents`, `sessions_spawn`, `message`, `tts`, `web_search`, `web_fetch`, `browser`, or `image`. Those are either OpenClaw concepts or third-party extension tools.

### Canonical Allowed Tools (delegation-only mode)

```ts
["reins_delegate"]
```

| Tool | Reason |
|------|--------|
| `reins_delegate` | Extension-provided delegation tool — registered by Reins via `pi.registerTool()`. Spawns sub-agents via `child_process.spawn()` internally. |

### Blocked (everything else)

All other tools — both built-in and extension-provided — are blocked at the `tool_call` level:

| Tool | Why blocked |
|------|------------|
| `bash` | Shell execution — must be delegated |
| `read` | File reading — must be delegated |
| `write` | File writing — must be delegated |
| `edit` | File editing — must be delegated |
| `grep` | Search — must be delegated |
| `find` | File discovery — must be delegated |
| `ls` | Directory listing — must be delegated |
| Any extension tool | Third-party tools — must be delegated |

### Runtime Tool Discovery

The allowlist is checked against `event.toolName` at runtime. To see what tools are currently registered (built-in + extensions), use:

```ts
const allTools = pi.getAllTools();    // [{ name, description, parameters }]
const activeTools = pi.getActiveTools(); // ["read", "bash", "edit", ...]
```

### Configurable Override

The allowlist is configurable via settings under `reins.allowedTools`. This allows users to permit specific tools in delegation mode (e.g., allowing `read` for quick lookups without full delegation).

---

## 6. Config Schema

### Two-Scope Model

```jsonc
// ~/.pi/agent/settings.json (GLOBAL — base defaults)
{
  "extensions": ["~/.pi/agent/extensions/reins/index.ts"],
  "reins": {
    "enabled": false,                        // Master toggle. Default: false.
    "model": "claude-sonnet-4-20250514",     // Context builder model. Illustrative — any valid model ID.
    "timeoutMs": 12000,                      // Context builder timeout in ms. Default: 12000.
    "allowedTools": ["reins_delegate"],       // Tools allowed in delegation mode.
    "cacheMaxAge": 300000,                   // Cache TTL in ms (5 min). Default: 300000.
    "debug": false                           // Log context builder input/output. Default: false.
  }
}
```

```jsonc
// .pi/settings.json (PROJECT — overrides global for this project)
{
  "reins": {
    "enabled": true,                         // Override: always-on for this project
    "model": "claude-haiku-4-20250414",      // Faster model for this project
    "allowedTools": ["reins_delegate", "read"]  // Also allow direct reads
  }
}
```

**Precedence:** Project settings override global settings per-key. Unspecified project keys fall through to global. Unspecified global keys use hardcoded defaults.

### Config Resolution

```ts
// config.ts
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ALLOWED_TOOLS, DEFAULT_TIMEOUT_MS, DEFAULT_CACHE_MAX_AGE } from "./constants.js";

export type ReinsConfig = {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  allowedTools: string[];
  cacheMaxAge: number;
  debug: boolean;
};

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_FILE = "settings.json";

let cachedGlobal: Record<string, unknown> | null = null;
let cachedGlobalMtime = 0;

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    // Invalid JSON or missing file — log warning, use defaults
    if (existsSync(path)) {
      console.warn(`[reins] Failed to parse ${path}: ${err}. Using defaults.`);
    }
    return {};
  }
}

function readGlobalSettings(): Record<string, unknown> {
  try {
    const { mtimeMs } = statSync(GLOBAL_SETTINGS_PATH);
    if (cachedGlobal && mtimeMs === cachedGlobalMtime) return cachedGlobal;
    cachedGlobal = readJsonFile(GLOBAL_SETTINGS_PATH);
    cachedGlobalMtime = mtimeMs;
    return cachedGlobal!;
  } catch {
    return {};
  }
}

function readProjectSettings(cwd: string): Record<string, unknown> {
  return readJsonFile(join(cwd, ".pi", PROJECT_SETTINGS_FILE));
}

export function getReinsConfig(cwd?: string): ReinsConfig {
  const globalSettings = readGlobalSettings();
  const projectSettings = cwd ? readProjectSettings(cwd) : {};

  const globalRc = (globalSettings.reins ?? {}) as Record<string, unknown>;
  const projectRc = (projectSettings.reins ?? {}) as Record<string, unknown>;

  // Project overrides global per-key
  const merged = { ...globalRc, ...projectRc };

  return {
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : false,
    model: typeof merged.model === "string" ? merged.model : "claude-sonnet-4-20250514", // fallback — warn at startup if unavailable
    timeoutMs: typeof merged.timeoutMs === "number" ? merged.timeoutMs : DEFAULT_TIMEOUT_MS,
    allowedTools: Array.isArray(merged.allowedTools) ? merged.allowedTools : ALLOWED_TOOLS,
    cacheMaxAge: typeof merged.cacheMaxAge === "number" ? merged.cacheMaxAge : DEFAULT_CACHE_MAX_AGE,
    debug: typeof merged.debug === "boolean" ? merged.debug : false,
  };
}

/**
 * Write reins.enabled to global settings.
 * Reads current file, updates reins.enabled, writes back atomically.
 *
 * Config I/O robustness:
 * - Atomic write: write to temp file, rename to target (prevents partial writes on crash)
 * - Invalid JSON recovery: readJsonFile catches parse errors, logs warning, returns {}
 */
export async function setReinsEnabled(enabled: boolean): Promise<void> {
  const settings = readJsonFile(GLOBAL_SETTINGS_PATH) as Record<string, any>;
  if (!settings.reins) settings.reins = {};
  settings.reins.enabled = enabled;

  // Atomic write: temp file + rename
  const tmpPath = GLOBAL_SETTINGS_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, GLOBAL_SETTINGS_PATH);

  // Invalidate cache
  cachedGlobal = null;
}
```

---

## 7. Command Handlers

### 7.1 `/reins on|off|status`

```ts
// commands/reins.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getReinsConfig, setReinsEnabled } from "../config.js";

export function registerReinsCommand(pi: ExtensionAPI) {
  pi.registerCommand("reins", {
    description: "Toggle delegation-only mode: /reins on|off|status",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "on") {
        await setReinsEnabled(true);

        // Check if first-time onboarding needed (file-based persistence)
        if (shouldShowOnboarding()) {
          ctx.ui.notify(
            "🔒 Reins enabled. Agent is delegation-only.\n\n" +
            "First time? Here's what changed:\n" +
            "  • Your agent can only delegate — no direct tool use\n" +
            "  • A context builder runs once per prompt (invisible to you)\n" +
            "  • /reins off to disable, /reins status for details",
            "info",
          );
          markOnboardingShown();
        } else {
          ctx.ui.notify("🔒 Reins enabled. Agent is delegation-only.", "info");
        }
        return;
      }

      if (arg === "off") {
        await setReinsEnabled(false);
        ctx.ui.notify("🔓 Reins disabled. Agent has full tool access.", "info");
        return;
      }

      if (arg === "status" || arg === "") {
        const config = getReinsConfig(ctx.cwd);
        const configScopes = getReinsConfigScopes(ctx.cwd); // returns { key: "global"|"project" } per config key
        const lines: string[] = [];

        lines.push(`Reins: ${config.enabled ? "enabled" : "disabled"}  (${configScopes.enabled})`);
        if (config.enabled) {
          const modelScope = configScopes.model;
          const modelLine = `Context builder: ${config.model}`;
          lines.push(modelScope === "project" ? `${modelLine}  ⚠️ overridden by project config` : `${modelLine}  (${modelScope})`);
          // ... session telemetry (lastBuild, cache, blocks) ...
          lines.push(`Token estimates are approximate (~chars/4).`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      ctx.ui.notify("Usage: /reins on|off|status", "warning");
    },
  });
}
```

### Onboarding Persistence

The "has seen onboarding" flag must survive across sessions and projects. `pi.appendEntry()` writes to session state only — it does not persist across sessions. Instead, use file I/O:

```ts
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ONBOARDING_FLAG = join(homedir(), ".pi", "agent", "reins-onboarding-shown");

function shouldShowOnboarding(): boolean {
  return !existsSync(ONBOARDING_FLAG);
}

function markOnboardingShown(): void {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(ONBOARDING_FLAG, new Date().toISOString(), "utf-8");
}
```

### 7.2 `/prework <prompt>`

Explicitly triggers the context builder without enabling the always-on harness.

```ts
// commands/prework.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildContextWithTimeout } from "../context-builder/builder.js";
import { getReinsConfig } from "../config.js";

export function registerPreworkCommand(pi: ExtensionAPI) {
  pi.registerCommand("prework", {
    description: "Pre-gather context for a task: /prework <prompt>",
    handler: async (args, ctx) => {
      const prompt = (args ?? "").trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /prework <what you're about to work on>", "warning");
        return;
      }

      const config = getReinsConfig(ctx.cwd);
      try {
        const result = await buildContextWithTimeout({
          prompt,
          model: config.model,
          timeoutMs: config.timeoutMs,
          pi,
        });

        if (!result.context || result.context === "EMPTY") {
          ctx.ui.notify("📋 Context builder found nothing relevant for that prompt.", "info");
          return;
        }

        const marker = result.partial ? " *(partial — timed out)*" : "";

        // Queue invisible context for next turn — display: false hides from UI,
        // content is delivered to LLM context on the next user prompt.
        pi.sendMessage(
          {
            customType: "reins_prework",
            content: [{ type: "text", text: result.context }],
            display: false,
          },
          { deliverAs: "nextTurn" },
        );

        // One-line user confirmation (separate from the invisible injection)
        ctx.ui.notify(
          `📋 Context built (${Math.round(result.context.length / 4)} tokens, ${marker ? "partial" : "ready"}). Send your prompt.`,
          "info",
        );
      } catch {
        ctx.ui.notify("⚠️ Context builder failed.", "error");
      }
    },
  });
}
```

---

## 8. State Management

### 8.1 Enabled State

- **Persisted in:** `~/.pi/agent/settings.json` at `reins.enabled` (global scope), overridable by `.pi/settings.json` (project scope)
- **Written by:** `/reins on|off` command handler (writes to global scope)
- **Read by:** Both hooks on every invocation (stat-cached to avoid redundant disk reads)
- **Survives restarts:** Yes — it's in the settings file

### 8.2 Onboarding State

- **Persisted in:** `~/.pi/agent/reins-onboarding-shown` (dedicated file)
- **NOT** `pi.appendEntry()` — that persists in the current session file and survives restarts of that session, but is not global cross-session state
- **Written once:** on first `/reins on`
- **Read by:** `/reins on` command handler

### 8.3 Context Cache

In-memory cache, keyed by `promptHash`. Not persisted across Pi restarts.

```ts
// context-builder/cache.ts
import { createHash } from "node:crypto";

type CacheEntry = {
  context: string;
  timestamp: number;
  maxAge: number;
};

const MAX_CACHE_ENTRIES = 100;

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt.slice(0, 200)).digest("hex").slice(0, 12);
}

class ContextCache {
  private entries = new Map<string, CacheEntry>();

  set(key: string, context: string, maxAge: number): void {
    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { context, timestamp: Date.now(), maxAge });
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > entry.maxAge) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.context;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const contextCache = new ContextCache();
```

---

## 9. Extension Points

### 9.1 Composability

Pi extensions compose naturally:

- Multiple extensions can subscribe to `before_agent_start` — Pi chains `systemPrompt` modifications
- Multiple extensions can subscribe to `tool_call` — any extension returning `{ block: true }` prevents the call
- The context builder model is configurable via `settings.reins.model` — can use any valid model ID. Startup emits a warning if the configured model is unavailable.

### 9.2 Multi-Extension Interaction

Extension handlers run in **discovery order** (the order extensions are loaded by Pi):

- **`before_agent_start`:** Each handler receives the previous handler's output (chained). If extension A returns `{ systemPrompt: X }`, extension B's `event.systemPrompt` is `X`. Reins appends to whatever it receives.
- **`tool_call`:** Each handler is called in order. The **first** handler to return `{ block: true }` wins — subsequent handlers are not called for that tool call.

**Note:** There is no `ExtensionAPI` method to enumerate loaded extensions or determine load order. If Pi adds such an API in the future, `/reins status` could include load order as debug info.

### 9.3 Future Commands

- `/reins config <key> <value>` — runtime config changes
- `/reins allow <tool>` — temporarily allow a tool
- `/reins log` — show what context was injected on the last turn
- `/reins on --project` — write enabled state to project-scoped settings

### 9.4 Versioning & Migration

v0.1.0 is the initial release. Config keys are additive — new keys get defaults, removed keys are ignored.

---

## 10. Architecture Decision Records

### ADR-001: Pi Extension Only

**Status:** Accepted
**Date:** 2026-03-03

**Context:** Reins could be built as either a Pi extension or an OpenClaw plugin. Both systems support tool interception, lifecycle hooks, and custom commands.

**Decision:** Build Reins as a Pi extension exclusively.

**Rationale:**
- Reins constrains the **coding agent's** tool usage. Pi is the coding agent; OpenClaw is the gateway layer above it. Constraining at the agent level is architecturally correct.
- Pi's event model (`tool_call`, `before_agent_start`) maps directly to what Reins needs. No translation layer required.
- Keeps the extension portable — works in any Pi environment, not just those running OpenClaw.
- Simpler deployment — drop a `.ts` file in the extensions directory.

**Consequences:**
- No access to OpenClaw-specific features (HTTP routes, channel registration, gateway lifecycle hooks). These are not needed for Reins.

### ADR-002: Main Agent Identification

**Status:** Proposed — unresolved implementation risk
**Date:** 2026-03-03

**Context:** Reins must restrict only the main (top-level) agent, not sub-agents. Pi's `ExtensionContext` does **not** expose `depth`, `parentSessionId`, `parentId`, or any structural field to distinguish main from sub-agent.

**Decision:** Use a Reins-owned environment variable. The `reins_delegate` tool sets `REINS_SUBAGENT=1` when spawning sub-processes. The `isMainAgent()` function checks for the absence of this env var.

> **⚠️ Unresolved risk:** There is no framework-level env var contract in Pi for identifying sub-agents. `SUBPI_SESSION_NAME` is not a guaranteed Pi API — it's an ecosystem convention that may not exist. Reins must own its own env var (`REINS_SUBAGENT`) set explicitly on spawned subprocesses and gate on that. Do not depend on third-party env vars.

**Alternative considered:** Apply restrictions universally. Since `reins_delegate` spawns sub-agents as separate `pi` processes, they load fresh extension instances. If the sub-agent's settings don't enable Reins, restrictions naturally don't apply. This works but is less explicit.

**Rationale:** The env var approach is explicit and debuggable — but only if Reins controls the var. Relying on external env vars that may not exist is fragile.

**Consequences:** Depends on the delegation tool setting `REINS_SUBAGENT=1`. Reins controls its own `reins_delegate` tool spawn, so it CAN reliably set this env var. However, sub-agents spawned via other mechanisms (e.g., the `subagent` example extension, manual `pi` invocations) will not have this marker and may be incorrectly restricted if Reins is loaded in their process. Pi's own subagent example does NOT set any env markers for sub-agent detection — there is no framework-level convention for this. This is an accepted limitation for v1.

**Required validation:** End-to-end test that:
1. Main agent with Reins enabled has tools blocked
2. Sub-agent spawned via `reins_delegate` has full tool access
3. Sub-agent spawned via an external mechanism (e.g., `subagent` extension) is not incorrectly restricted

### ADR-003: Extension-Provided Delegation Tool

**Status:** Accepted
**Date:** 2026-03-03

**Context:** Pi has no built-in delegation tool. Its built-in LLM-callable tools are: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. The cuffed agent needs a way to spawn sub-agents.

**Decision:** Reins registers a `reins_delegate` tool via `pi.registerTool()`. This tool's `execute()` function uses `child_process.spawn()` to spawn `pi` sub-processes.

**Alternative considered:** Depend on the `subagent` example extension being installed. Rejected because: (a) it's an example, not a guaranteed dependency; (b) Reins should be self-contained.

**Rationale:** Self-contained is better for a v1. Users install one extension and everything works. No dependency on external extensions or CLI tools.

**Consequences:** Reins bundles its own delegation logic. The `reins_delegate` tool is simpler than the full `subagent` extension (single mode only in v1, no parallel/chain), but can be extended later.

### ADR-004: File-Based Onboarding Persistence

**Status:** Accepted
**Date:** 2026-03-03

**Context:** The "first `/reins on` ever" onboarding message should show once globally, not per-session.

**Decision:** Persist the "onboarding shown" flag as a file at `~/.pi/agent/reins-onboarding-shown`.

**Rejected alternative:** `pi.appendEntry("reins_onboarding", { shown: true })`. `appendEntry` persists in the current session file and survives restarts of that session, but it is not global cross-session state. A new session would not have the flag.

**Rationale:** A simple file is the most reliable cross-session persistence mechanism available in the Pi extension API.

---

## 11. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Context builder adds 5–12s latency per turn** | High — UX degradation | High | Timeout with stale cache fallback. `/prework` for explicit pre-build. |
| **LLM ignores soft enforcement and tries blocked tools** | Medium — wasted tokens | Medium | Hard enforcement via `tool_call` catches all attempts. Soft layer reduces frequency. |
| **Sub-agents also restricted** | Critical — delegation breaks | Low (mitigated by design) | `isMainAgent()` is a best-effort heuristic for Reins-spawned subprocesses via `REINS_SUBAGENT` env var. No framework-level parent/depth API currently exists in Pi. |
| **Context builder injects irrelevant context** | Medium — misleading | Medium | Conservative builder prompt. Cache keyed by prompt hash. TTL. Debug mode. |
| **Main agent identification unreliable** | High — blocks sub-agents or misses main | Low | ADR-002: env var is set explicitly by our delegation tool. |
| **`child_process.spawn()` overhead** | Medium — slower context building | Medium | Timeout + cache fallback. |
| **Token cost of context injection** | Low — adds tokens per turn | High (by design) | Hard truncation at 4000 tokens. Cache reduces redundant builds. |

---

## 12. Compilable Minimal Skeleton

A complete, type-correct extension that demonstrates all four Reins surfaces. This must compile against `types.ts` as-is.

```ts
// reins-minimal.ts — compilable skeleton for validation
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
  // ── State ──
  let enabled = false;
  const ONBOARDING_FLAG = join(homedir(), ".pi", "agent", "reins-onboarding-shown");

  // ── 1. Register /reins command ──
  pi.registerCommand("reins", {
    description: "Toggle delegation-only mode: /reins on|off|status",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "on") {
        enabled = true;
        if (!existsSync(ONBOARDING_FLAG)) {
          ctx.ui.notify(
            "🔒 Reins enabled. Agent is delegation-only.\n\n" +
              "First time? Here's what changed:\n" +
              "  • Your agent can only delegate — no direct tool use\n" +
              "  • A context builder runs once per prompt\n" +
              "  • /reins off to disable, /reins status for details",
            "info",
          );
          mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
          writeFileSync(ONBOARDING_FLAG, new Date().toISOString(), "utf-8");
        } else {
          ctx.ui.notify("🔒 Reins enabled. Agent is delegation-only.", "info");
        }
        return;
      }

      if (arg === "off") {
        enabled = false;
        ctx.ui.notify("🔓 Reins disabled. Agent has full tool access.", "info");
        return;
      }

      if (arg === "status" || arg === "") {
        ctx.ui.notify(enabled ? "🔒 Reins: enabled" : "🔓 Reins: disabled", "info");
        return;
      }

      ctx.ui.notify("Usage: /reins on|off|status", "warning");
    },
  });

  // ── 2. Hook before_agent_start — append to systemPrompt ──
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!enabled) return;
    if (process.env.REINS_SUBAGENT) return;

    const reinsContext =
      "## Reins: Delegation-Only Mode\n\n" +
      "You MUST delegate all work via `reins_delegate`. Do not use other tools directly.";

    return { systemPrompt: event.systemPrompt + "\n\n" + reinsContext };
  });

  // ── 3. Hook tool_call — block non-allowed tools ──
  pi.on("tool_call", (_event, _ctx) => {
    if (!enabled) return;
    if (process.env.REINS_SUBAGENT) return;

    const allowed = ["reins_delegate"];
    if (allowed.includes(_event.toolName)) return;

    return {
      block: true,
      reason:
        `Reins: "${_event.toolName}" is blocked in delegation-only mode. ` +
        `Delegate via reins_delegate instead.`,
    };
  });

  // ── 4. Register reins_delegate tool ──
  pi.registerTool({
    name: "reins_delegate",
    label: "Delegate",
    description: "Delegate a task to a sub-agent (tools specified via --tools flag)",
    parameters: Type.Object({
      task: Type.String({ description: "Task description for the sub-agent" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // Use child_process.spawn() with env option so REINS_SUBAGENT=1 is
      // isolated to the child process — never mutate parent process.env.
      const { spawn } = await import("node:child_process");
      const args = ["--mode", "json", "-p", "--no-session", `Task: ${params.task}`];
      const result = await spawnPiSubprocess(args, {
        signal,
        env: { ...process.env, REINS_SUBAGENT: "1" },
      });

      if (result.code !== 0) {
        // No isError on AgentToolResult — signal errors via content text
        return {
          content: [{ type: "text", text: `Sub-agent failed (exit ${result.code}): ${result.stderr}` }],
        };
      }

      return {
        content: [{ type: "text", text: result.stdout || "(no output)" }],
      };
    },
  });
}
```

> **Note:** This skeleton omits the context builder, caching, and config persistence for clarity. It demonstrates the four core surfaces: command registration with `handler`, `before_agent_start` hook (appending to `event.systemPrompt`), `tool_call` hook (blocking), and `pi.registerTool()` for delegation. The `spawn()` call matches the pattern from Pi's own `subagent` example: `spawn("pi", ["--mode", "json", "-p", "--no-session", ...], { env })`.

---

## 13. Tool Visibility Policy

**v1 decision: tools remain visible but blocked (teaching mode).**

Rationale:
- `pi.setActiveTools()` can hide tools entirely, but we want the LLM to see the full tool schema so it understands the constraint. The soft layer (system prompt) tells it not to try; the hard layer (`tool_call` block) catches any attempts.
- Blocked tool calls return `{ block: true, reason: "..." }`. Pi surfaces the `reason` string as an error result that the model sees. This is not invisible — the model receives the block reason and can self-correct.
- This is a deliberate teaching mode: the model learns from block messages and stops attempting blocked tools over time.

**Visibility semantics:** Blocked tool calls surface as error results that the **model always sees** (it's a tool result error in the conversation). The **user usually doesn't see** the raw block message in the chat UI — unless the model references it in its response. This is consistent behaviour: the block is invisible to the user but visible to the model, enabling self-correction.

**v2 consideration:** A config switch (`reins.hideBlockedTools: boolean`) could use `pi.setActiveTools()` to hide tools entirely, reducing token waste from the model attempting blocked tools. Deferred — v1 data on block rates will inform whether this is needed.

---

## 14. Non-Interactive Mode Behavior

Reins must work correctly across all Pi modes:

| Mode | `ctx.hasUI` | `/reins` command | `ctx.ui.notify()` | `ctx.ui.confirm()` | Fallback | Tool blocking |
|------|------------|-----------------|-------------------|-------------------|----------|---------------|
| Interactive | `true` | Available (tab-complete) | Works | Works | n/a | ✅ Works |
| RPC (`--mode rpc`) | `true` | Available (via `prompt`) | Emitted to client | Emitted to client | n/a | ✅ Works |
| JSON (`--mode json`) | `false` | Executable (prompt text starting with `/` is parsed) | **No-op** | **No-op** | `console.error()` / stderr | ✅ Works |
| Print (`-p`) | `false` | Executable (prompt text starting with `/` is parsed) | **No-op** | **No-op** | `console.error()` | ✅ Works |

Key implications:
- **Tool blocking works in all modes** — the `tool_call` hook fires regardless of UI mode.
- **Commands execute in all modes** — prompt text starting with `/` is parsed as a command in JSON/print modes. UI discoverability (tab-complete) is interactive-only, but command execution works everywhere.
- **`/reins on|off` silently takes effect in non-interactive modes** — settings are written to disk, but `ctx.ui.notify()` is a no-op so the user sees no confirmation. The state change persists and takes effect immediately.
- **`/reins status` in non-interactive modes** — since `ctx.ui.notify()` is a no-op, status output must use an alternative delivery mechanism. The canonical fallback is `console.error()` (stderr) so the output reaches the user without polluting stdout/JSON output.
- **`ctx.ui.notify()` no-ops in non-interactive modes.** All command handlers and the circuit breaker must use the following canonical decision tree:

```ts
// Canonical notification with non-interactive fallback
function notifyOrFallback(ctx: ExtensionContext, message: string, level: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    // No UI available (JSON/print mode) — write to stderr
    console.error(`[reins] ${message}`);
  }
}

// Circuit breaker notification — canonical decision tree
if (ctx.hasUI) {
  ctx.ui.notify(message, "warning");
} else {
  // No UI available — inject warning into the next
  // before_agent_start systemPrompt modification so the LLM sees it.
  pendingCircuitBreakerWarning = message;
  // Also log to stderr for operator visibility
  console.error(`[reins] ${message}`);
}
```
- **Context builder works in all modes** — it spawns a subprocess and modifies the system prompt, which is mode-independent.

---

## 15. Custom Tools from Other Extensions — Policy

Other installed extensions may register tools that are safe for the cuffed agent to use directly (e.g., a read-only search tool). Reins provides a config option for this:

```jsonc
{
  "reins": {
    "allowedTools": ["reins_delegate"],           // Core allowlist (always includes reins_delegate)
    "additionalAllowedTools": ["search_docs"]     // Third-party safe tools
  }
}
```

**Default:** Only `reins_delegate` + built-in `read` are allowed. Wait — for v1, only `reins_delegate` is allowed by default. The `allowedTools` config already exists and can be extended by the user.

**Resolution:** The existing `reins.allowedTools` config key (§6) serves this purpose. Default is `["reins_delegate"]`. Users can add third-party tools: `"allowedTools": ["reins_delegate", "search_docs"]`. No separate `additionalAllowedTools` key needed — one flat list is simpler.

---

## 16. Status Telemetry Schema

The `/reins status` command reports runtime telemetry. Each field has a defined source of truth and reset semantics:

| Field | Source | Reset | Example |
|-------|--------|-------|---------|
| Enabled state | `reins.enabled` in settings file | Persistent | `enabled` / `disabled` |
| Context builder model | `reins.model` in settings file | Persistent | `claude-sonnet-4-20250514` |
| Last build timestamp | In-memory, set after `buildContextWithTimeout` returns | Resets on Pi restart | `12s ago` |
| Last build status | In-memory, set from build result | Resets on Pi restart | `success` / `partial` / `timeout` / `failed` |
| Last build token estimate | In-memory, `contextBlock.length / 4` (rough heuristic, not true token count) | Resets on Pi restart | `~1,247 tokens (estimated)` |
| Cache age | In-memory, `Date.now() - cacheEntry.timestamp` | Resets on Pi restart | `12s` / `4m 12s` |
| Tool blocks this session | In-memory counter, incremented in `tool_call` hook | Resets on Pi restart (per-session) | `0` / `3` |

```ts
// State tracked in-memory for status reporting
// All fields except toolBlockCount are null before the first context build.
// Status output should handle null gracefully (e.g. "Last context build: n/a").
interface ReinsSessionState {
  lastBuildTimestamp: number | null;    // Date.now() after build completes. null before first build.
  lastBuildStatus: "success" | "partial" | "timeout" | "failed" | null;  // null before first build.
  lastBuildTokenEstimate: number | null; // contextBlock.length / 4 — approximate. null before first build.
  toolBlockCount: number;                // Reset on session_start. Always 0 initially.
}
```

> **Nullable fields:** `lastBuildTimestamp`, `lastBuildStatus`, `lastBuildTokenEstimate`, and cache age are all `null` before the first context build runs. `/reins status` should display these as `n/a` or omit them entirely when null.

---

## 17. Test Matrix

Must-have tests before implementation is considered complete:

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| T1 | Reins off (default) | Zero behavior change — no hooks fire, no tools blocked, no latency added |
| T2 | Reins on: built-in tool blocked | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` all return `{ block: true, reason: "..." }` |
| T3 | Reins on: `reins_delegate` callable | Delegation tool executes successfully, spawns sub-agent |
| T4 | Sub-agent has full tool access | Sub-agent spawned via `reins_delegate` can use all built-in tools |
| T5 | Context builder timeout | Agent proceeds with partial/stale context, no error surfaced to user |
| T6 | Context builder total failure | Agent proceeds with no injected context, delegation still works |
| T7 | Settings persistence | `/reins on` survives Pi restart (written to `~/.pi/agent/settings.json`) |
| T8 | Project settings override | `.pi/settings.json` `reins.enabled: true` overrides global `false` |
| T9 | Multi-extension ordering | Reins `before_agent_start` correctly appends to `event.systemPrompt` from prior extensions |
| T10 | Non-interactive mode | Tool blocking works in `--mode json` and `-p` modes |
| T11 | Onboarding shown once | First `/reins on` shows explainer; second does not |
| T12 | Circuit breaker (3 blocks) | After 3 consecutive blocks in one turn, steering message injected |
| T13 | Circuit breaker (5 blocks) | After 5 consecutive blocks, `ctx.ui.notify` warning fires |
| T14 | `/prework` without Reins | Context built and injected; agent retains full tool access |

---

## Appendix: Normative Config Schema

Single source of truth for all Reins config keys:

| Key | Type | Default | Scope | Description |
|-----|------|---------|-------|-------------|
| `reins.enabled` | `boolean` | `false` | global + project | Master toggle. Default OFF. |
| `reins.model` | `string` | `"claude-sonnet-4-20250514"` | global + project | Context builder model ID. Illustrative default — any valid model ID. |
| `reins.timeoutMs` | `number` | `12000` | global + project | Context builder timeout in ms. |
| `reins.allowedTools` | `string[]` | `["reins_delegate"]` | global + project | Tools allowed in delegation-only mode. |
| `reins.cacheMaxAge` | `number` | `300000` | global + project | Context cache TTL in ms (5 min). |
| `reins.debug` | `boolean` | `false` | global + project | Log context builder input/output to stderr. |
| `reins.hideBlockedTools` | `boolean` | — | — | **v2 only.** Use `pi.setActiveTools()` to hide blocked tools entirely. |

**Precedence:** Project (`.pi/settings.json`) overrides global (`~/.pi/agent/settings.json`) per-key. Unspecified keys fall through to global, then to hardcoded defaults.

---

## Appendix: Constants

```ts
// constants.ts
export const ALLOWED_TOOLS = ["reins_delegate"];
export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes
export const CONTEXT_BUILDER_MAX_TOKENS = 4_000;
export const MAX_CACHE_ENTRIES = 100;
```
