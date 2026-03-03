# Architecture Spec: Reins

**Status:** Draft
**Author:** Soren (via Iris)
**Date:** 2026-03-03
**Companion:** [PRD](./PRD.md)

> **Reins is a Pi extension.** It hooks into the Pi coding agent's event system to constrain the main agent to delegation-only mode. The extension registers a `reins_delegate` tool via `pi.registerTool()` that internally spawns `pi` sub-processes using `pi.exec()` (an extension-side API, not LLM-callable).

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

Pi extensions have **no manifest file**. Discovery is by convention:

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
    const config = getReinsConfig();
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
 * Determine whether the current context is the main (top-level) agent.
 *
 * Pi's ExtensionContext does NOT expose depth, parentSessionId, or parentId.
 * Heuristic: sub-agents spawned via the subagent extension or subpi set
 * environment variables (e.g. SUBPI_SESSION_NAME or PI_SUBAGENT).
 * Absence of these env vars indicates we're the main (top-level) agent.
 *
 * Alternative: apply restrictions universally. The reins_delegate tool
 * spawns sub-agents as separate pi processes, which load their own
 * extension instances. Since the sub-agent process won't have Reins
 * enabled in its project settings (or will have it disabled via env),
 * the restrictions naturally don't apply to sub-agents.
 */
function isMainAgent(): boolean {
  return !process.env.SUBPI_SESSION_NAME && !process.env.PI_SUBAGENT;
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
    const config = getReinsConfig();
    if (!config.enabled) return;

    // Only affect main agent (see ADR-002)
    if (!isMainAgent()) return;

    // 1. Build context (with timeout + cache fallback)
    // event.prompt is the user's prompt text (from BeforeAgentStartEvent)
    // event.systemPrompt is the current system prompt
    const prompt = event.prompt;
    const promptHash = hashPrompt(prompt);
    let contextBlock: string | undefined;
    let partial = false;

    try {
      const result = await buildContextWithTimeout({
        prompt,
        model: config.model,
        timeoutMs: config.timeoutMs,
        pi,
      });
      contextBlock = result.context;
      partial = result.partial;

      // Hard truncation — never inject more than the token budget
      if (contextBlock) {
        contextBlock = truncateToTokenBudget(contextBlock, CONTEXT_BUILDER_MAX_TOKENS);
      }

      // Update cache on success
      if (contextBlock && !partial) {
        contextCache.set(promptHash, contextBlock, config.cacheMaxAge);
      }
    } catch {
      // Total failure — try stale cache
      contextBlock = contextCache.get(promptHash);
      partial = !!contextBlock;
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
  return !process.env.SUBPI_SESSION_NAME && !process.env.PI_SUBAGENT;
}

/**
 * Hard-truncate context to a token budget.
 * Uses a rough 4 chars/token heuristic. This is a safety cap — the builder's
 * prompt already instructs it to stay under budget, but we enforce it here
 * programmatically so an LLM overshoot can't blow out the context window.
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

Pi has no built-in delegation tool. Its built-in LLM-callable tools are: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Reins must register its own delegation tool so the cuffed agent can spawn sub-agents.

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
      "Delegate a task to a sub-agent with full tool access. " +
      "The sub-agent runs in an isolated context and returns a text result.",
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
      const config = getReinsConfig();
      const model = params.model ?? config.model;
      const args: string[] = ["--mode", "json", "-p", "--no-session"];

      if (model) args.push("--model", model);
      if (params.tools?.length) args.push("--tools", params.tools.join(","));

      // Set env var so sub-agent's Reins hooks know not to restrict it
      const env = { PI_SUBAGENT: "1" };

      args.push(`Task: ${params.task}`);

      // pi.exec() is an extension-side API — it runs a shell command,
      // NOT an LLM tool. The LLM calls reins_delegate; the tool's
      // execute() function uses pi.exec() internally.
      const result = await pi.exec("pi", args, { signal });

      if (result.code !== 0) {
        return {
          content: [{ type: "text", text: `Sub-agent failed (exit ${result.code}): ${result.stderr}` }],
          isError: true,
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

### 3.2 How It Works

1. The LLM calls `reins_delegate` with a task description
2. The tool's `execute()` function uses `pi.exec("pi", [...args])` to spawn a child `pi` process
3. The child runs in JSON mode (`--mode json`), print mode (`-p`), with no session (`--no-session`)
4. The child has full tool access (all built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`)
5. The child's environment includes `PI_SUBAGENT=1` so if Reins is loaded there, it won't restrict the sub-agent
6. Output is captured from stdout, parsed, and returned to the LLM

### 3.3 Key Design Note: `pi.exec()` vs LLM Tools

`pi.exec()` is an **extension-side API** — it executes shell commands from within extension code. The LLM agent **cannot** call `pi.exec()` directly. The flow is:

```
LLM calls reins_delegate (LLM tool) → execute() runs pi.exec() (extension API) → spawns pi subprocess
```

This distinction is critical: the LLM interacts with `reins_delegate` as a registered tool. The subprocess spawning is an implementation detail inside the tool's `execute()` function.

---

## 4. Context Builder Sub-Agent

The context builder is the intelligence layer. It decides what the main agent needs to know before delegating.

### 4.1 Execution Model

The context builder runs as a **sub-process spawned via `pi.exec()`** — an extension-side API (not an LLM tool). It invokes `pi` directly in print+JSON mode.

The builder is granted **read-only tools only**: `read`, `grep`, `find`, `ls`. It cannot write, execute shell commands, or modify anything.

```ts
// context-builder/builder.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CONTEXT_BUILDER_SYSTEM_PROMPT } from "./prompt.js";

type BuildResult = { context: string | undefined; partial: boolean };

export async function buildContextWithTimeout(opts: {
  prompt: string;
  model: string;
  timeoutMs: number;
  pi: ExtensionAPI;
}): Promise<BuildResult> {
  const { prompt, model, timeoutMs, pi } = opts;

  const buildPromise = spawnContextBuilder(pi, {
    systemPrompt: CONTEXT_BUILDER_SYSTEM_PROMPT,
    userPrompt: `Gather context for the following user request:\n\n${prompt}`,
    model,
    tools: ["read", "grep", "find", "ls"],
  });

  const timeoutPromise = new Promise<BuildResult>((resolve) =>
    setTimeout(() => resolve({ context: undefined, partial: true }), timeoutMs),
  );

  return Promise.race([buildPromise, timeoutPromise]);
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

    const result = await pi.exec("pi", args, {});

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
| User's raw prompt | `event.prompt` from `before_agent_start` event | Understand intent |
| Read-only tools | `read`, `grep`, `find`, `ls` (Pi built-in tools, lowercase) | Gather file contents and structure |

### 4.3 What It Does

The context builder is a sub-process with read-only tool access. It:

1. Receives the user's prompt
2. Uses `find` and `ls` to explore the workspace structure
3. Uses `grep` to find relevant files
4. Uses `read` to pull file contents
5. Returns a structured markdown summary of relevant context

### 4.4 What It Returns

A structured context block (plain text/markdown) containing any combination of:

- **Relevant file contents** — files the main agent will need to reference when delegating
- **Memory excerpts** — from MEMORY.md, daily logs, etc.
- **Codebase structure** — directory trees, key file listings
- **Nothing** — if the prompt is conversational or doesn't need codebase context (returns "EMPTY")

After the builder returns, the extension applies a **hard truncation cap** of 4000 tokens (see §2.2).

### 4.5 System Prompt

```ts
// context-builder/prompt.ts
export const CONTEXT_BUILDER_SYSTEM_PROMPT = `You are a context builder for an AI agent operating in delegation-only mode.

You have read-only tools: read, grep, find, ls. Use them to explore the workspace
and gather context the main agent needs to effectively delegate work.

## What to gather
- File contents directly relevant to the prompt (use read)
- Directory structure if the prompt involves code navigation (use ls, find)
- Memory/context files if the prompt references past work (use read)
- Config or schema files if the prompt involves system configuration (use read)
- Search for relevant patterns (use grep)

## Rules
1. Be conservative — only include what's clearly relevant
2. Prefer structure (file trees, signatures) over full file dumps
3. If the prompt is conversational (greeting, question, chat), return EMPTY
4. Keep total output under 4000 tokens
5. Format as markdown sections with file paths as headers
6. If you're unsure whether something is relevant, skip it

## Output format
Return markdown with relevant context, or the single word EMPTY if no context is needed.`;
```

### 4.6 Recursion Safety

The context builder runs as a sub-process (separate `pi` invocation). This means:
1. It loads its own extension instances independently
2. The `PI_SUBAGENT=1` env var is set, so `isMainAgent()` returns false
3. Even if Reins is loaded in the sub-process, the tool_call hook won't restrict it
4. There is no risk of infinite recursion — the sub-process is a flat invocation, not a re-entrant hook

---

## 5. Tool Allowlist

### Pi Built-in Tools (Reference)

Pi's built-in LLM-callable tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

There are **no** built-in tools named `subagents`, `sessions_spawn`, `message`, `tts`, `web_search`, `web_fetch`, `browser`, or `image`. Those are either OpenClaw concepts or third-party extension tools.

### Canonical Allowed Tools (delegation-only mode)

```ts
["reins_delegate"]
```

| Tool | Reason |
|------|--------|
| `reins_delegate` | Extension-provided delegation tool — registered by Reins via `pi.registerTool()`. Spawns sub-agents via `pi.exec()` internally. |

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
    "model": "claude-sonnet-4-20250514",     // Context builder model. Concrete provider/model ID.
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
  } catch {
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
    model: typeof merged.model === "string" ? merged.model : "claude-sonnet-4-20250514",
    timeoutMs: typeof merged.timeoutMs === "number" ? merged.timeoutMs : DEFAULT_TIMEOUT_MS,
    allowedTools: Array.isArray(merged.allowedTools) ? merged.allowedTools : ALLOWED_TOOLS,
    cacheMaxAge: typeof merged.cacheMaxAge === "number" ? merged.cacheMaxAge : DEFAULT_CACHE_MAX_AGE,
    debug: typeof merged.debug === "boolean" ? merged.debug : false,
  };
}

/**
 * Write reins.enabled to global settings.
 * Reads current file, updates reins.enabled, writes back atomically.
 */
export async function setReinsEnabled(enabled: boolean): Promise<void> {
  const settings = readJsonFile(GLOBAL_SETTINGS_PATH) as Record<string, any>;
  if (!settings.reins) settings.reins = {};
  settings.reins.enabled = enabled;
  writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
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
        const msg = config.enabled
          ? `🔒 Reins: enabled (model: ${config.model})`
          : "🔓 Reins: disabled";
        ctx.ui.notify(msg, "info");
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

        // Inject as a custom message — appears in session, sent to LLM on next turn
        pi.sendMessage(
          {
            customType: "reins_prework",
            content: `📋 **Pre-gathered context**${marker}:\n\n${result.context}`,
            display: true,
          },
          { deliverAs: "nextTurn" },
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
- **NOT** `pi.appendEntry()` — that's session-scoped, not persistent across sessions
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
- The context builder model is configurable — can use any model with a concrete provider/model ID

### 9.2 Future Commands

- `/reins config <key> <value>` — runtime config changes
- `/reins allow <tool>` — temporarily allow a tool
- `/reins log` — show what context was injected on the last turn
- `/reins on --project` — write enabled state to project-scoped settings

### 9.3 Versioning & Migration

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

**Status:** Accepted
**Date:** 2026-03-03

**Context:** Reins must restrict only the main (top-level) agent, not sub-agents. Pi's `ExtensionContext` does **not** expose `depth`, `parentSessionId`, `parentId`, or any structural field to distinguish main from sub-agent.

**Decision:** Use environment variable heuristics. The `reins_delegate` tool sets `PI_SUBAGENT=1` when spawning sub-processes. The `isMainAgent()` function checks for the absence of known sub-agent env vars (`SUBPI_SESSION_NAME`, `PI_SUBAGENT`).

**Alternative considered:** Apply restrictions universally. Since `reins_delegate` spawns sub-agents as separate `pi` processes, they load fresh extension instances. If the sub-agent's settings don't enable Reins, restrictions naturally don't apply. This works but is less explicit.

**Rationale:** The env var approach is explicit and debuggable. It's consistent with how the `subagent` example extension manages sub-agent lifecycle.

**Consequences:** Depends on the delegation tool setting the env var. If sub-agents are spawned via a different mechanism, they need to set a recognized env var.

### ADR-003: Extension-Provided Delegation Tool

**Status:** Accepted
**Date:** 2026-03-03

**Context:** Pi has no built-in delegation tool. Its built-in LLM-callable tools are: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. The cuffed agent needs a way to spawn sub-agents.

**Decision:** Reins registers a `reins_delegate` tool via `pi.registerTool()`. This tool's `execute()` function uses `pi.exec()` (extension-side API) to spawn `pi` sub-processes.

**Alternative considered:** Depend on the `subagent` example extension being installed. Rejected because: (a) it's an example, not a guaranteed dependency; (b) Reins should be self-contained.

**Rationale:** Self-contained is better for a v1. Users install one extension and everything works. No dependency on external extensions or CLI tools.

**Consequences:** Reins bundles its own delegation logic. The `reins_delegate` tool is simpler than the full `subagent` extension (single mode only in v1, no parallel/chain), but can be extended later.

### ADR-004: File-Based Onboarding Persistence

**Status:** Accepted
**Date:** 2026-03-03

**Context:** The "first `/reins on` ever" onboarding message should show once globally, not per-session.

**Decision:** Persist the "onboarding shown" flag as a file at `~/.pi/agent/reins-onboarding-shown`.

**Rejected alternative:** `pi.appendEntry("reins_onboarding", { shown: true })`. `appendEntry` writes session entries — they only exist within a single session and are not durable global state. Checking session entries on startup would only find the flag if it was set in the same session.

**Rationale:** A simple file is the most reliable cross-session persistence mechanism available in the Pi extension API.

---

## 11. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Context builder adds 5–12s latency per turn** | High — UX degradation | High | Timeout with stale cache fallback. `/prework` for explicit pre-build. |
| **LLM ignores soft enforcement and tries blocked tools** | Medium — wasted tokens | Medium | Hard enforcement via `tool_call` catches all attempts. Soft layer reduces frequency. |
| **Sub-agents also restricted** | Critical — delegation breaks | Low (mitigated by design) | `isMainAgent()` guard + `PI_SUBAGENT` env var ensures only main agent is restricted. |
| **Context builder injects irrelevant context** | Medium — misleading | Medium | Conservative builder prompt. Cache keyed by prompt hash. TTL. Debug mode. |
| **Main agent identification unreliable** | High — blocks sub-agents or misses main | Low | ADR-002: env var is set explicitly by our delegation tool. |
| **`pi.exec()` spawn overhead** | Medium — slower context building | Medium | Timeout + cache fallback. |
| **Token cost of context injection** | Low — adds tokens per turn | High (by design) | Hard truncation at 4000 tokens. Cache reduces redundant builds. |

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
