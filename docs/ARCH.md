# Architecture Spec: Reins

**Status:** Draft
**Author:** Soren (via Iris)
**Date:** 2026-03-03
**Companion:** [PRD](./PRD.md)

> **Reins is a Pi extension.** It hooks into the Pi coding agent's event system to constrain the main agent to delegation-only mode. Sub-agent work is performed via `subpi` — a CLI/agent tool available on PATH, not a Pi-specific API.

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
│   ├── context-builder/
│   │   ├── builder.ts         # Sub-agent orchestration + timeout wrapper
│   │   ├── prompt.ts          # System prompt template for the context builder
│   │   └── cache.ts           # Stale-cache layer
│   ├── config.ts              # Config reading from settings.json
│   └── constants.ts           # Tool allowlist, timeouts, cache keys
└── docs/
    ├── PRD.md
    └── ARCH.md
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

Configuration lives in `~/.pi/agent/settings.json` under a `reins` key:

```json
{
  "extensions": ["~/.pi/agent/extensions/reins/index.ts"],
  "reins": {
    "enabled": false,
    "model": "sonnet",
    "timeoutMs": 12000,
    "allowedTools": ["subagents", "sessions_spawn", "message", "tts"],
    "cacheMaxAge": 300000,
    "debug": false
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

export default function (pi: ExtensionAPI) {
  registerToolCall(pi);
  registerBeforeAgentStart(pi);
  registerReinsCommand(pi);
  registerPreworkCommand(pi);
}
```

Registration uses `pi.on()` for lifecycle events and `pi.registerCommand()` for slash commands. No tools are registered by this extension — it restricts, not extends.

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
    // Sub-agents run under their own context; the main agent is identified
    // by being the top-level session (not spawned by another agent).
    // Implementation note: determine main vs sub-agent via ctx properties
    // available at runtime. See ADR-002 for details.
    if (!isMainAgent(ctx)) return;

    const allowed = config.allowedTools ?? ALLOWED_TOOLS;
    if (allowed.includes(event.toolName)) return;

    return {
      block: true,
      reason:
        `Reins: "${event.toolName}" is blocked in delegation-only mode. ` +
        `Delegate this work to a sub-agent via subagents tool instead.`,
    };
  });
}

/**
 * Determine whether the current context is the main (top-level) agent.
 * Implementation will depend on what Pi's ExtensionContext exposes at runtime.
 * Candidates: ctx.parentSessionId === undefined, ctx.depth === 0, or similar.
 */
function isMainAgent(ctx: unknown): boolean {
  // TODO: Confirm with Pi's ExtensionContext API which field distinguishes
  // main agent from sub-agents. Placeholder uses a conservative check.
  return true; // Will be refined during implementation
}
```

**Key decisions:**

- **Only restricts the main agent** — sub-agents spawned by the main agent must have full tool access, otherwise the entire pattern collapses. The guard uses `isMainAgent()` which will be implemented based on what Pi's `ExtensionContext` exposes (see ADR-002).
- **Returns `{ block: true, reason }` (not `blockReason`)** — this is the Pi extension return shape for `tool_call` events.
- **Synchronous** — no async work, no allocations on the hot path when disabled.
- **Configurable allowlist** — defaults from `ALLOWED_TOOLS`, overridable via settings.

### 2.2 `before_agent_start` — Soft Enforcement + Context Injection

The complex hook. Async, spawns a context builder sub-agent, manages timeouts and cache.

> **Enabled guard (mandatory):** Same pattern — check enabled first, return immediately if off.

> **Async guarantee:** This hook assumes `before_agent_start` is `await`ed by the Pi runtime before the agent starts. **Validation requirement:** Confirm this with Pi's event system before v1 ships. If the event is fire-and-forget, the context injection strategy must be redesigned.

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

    // Only affect main agent
    if (!isMainAgent(ctx)) return;

    // Recursion guard — prevent the context builder sub-agent from
    // triggering this hook again
    if ((ctx as any).__reins_building_context) return;

    // 1. Build context (with timeout + cache fallback)
    const prompt = extractPrompt(event);
    const promptHash = hashPrompt(prompt);
    const cacheKey = `${promptHash}`;
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
        contextCache.set(cacheKey, contextBlock, config.cacheMaxAge);
      }
    } catch {
      // Total failure — try stale cache
      contextBlock = contextCache.get(cacheKey);
      partial = !!contextBlock;
    }

    // 2. Build system prompt injection
    const parts: string[] = [
      "## Reins: Delegation-Only Mode\n\n" +
        "You are operating under Reins. You MUST NOT use tools directly except " +
        "`subagents` / `sessions_spawn` (to spawn sub-agents), `message` (to communicate), " +
        "and `tts` (text-to-speech output). " +
        "All implementation work — file reads, writes, shell commands, web searches — " +
        "must be delegated to sub-agents via the `subagents` tool.\n\n" +
        "If you attempt to call a blocked tool, it will be rejected. " +
        "Plan your delegation strategy, then spawn sub-agents to execute.",
    ];

    if (contextBlock) {
      const marker = partial ? "[context: partial — builder timed out or used cache]" : "";
      parts.push(`## Reins: Pre-gathered Context\n\n${marker}\n${contextBlock}`);
    }

    // Pi's before_agent_start can inject systemPrompt content
    return { systemPrompt: parts.join("\n\n") };
  });
}

function extractPrompt(event: any): string {
  // Extract the user's prompt from the event — exact field depends on
  // Pi's before_agent_start event shape
  return event.prompt ?? event.userMessage ?? "";
}

function isMainAgent(ctx: unknown): boolean {
  return true; // Placeholder — see ADR-002
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

**Lifecycle per turn:**

1. Check enabled + main agent guard
2. Run context builder with `Promise.race` timeout
3. On success → hard-truncate to 4000 tokens, inject context, update cache
4. On timeout → inject partial result if available, else stale cache
5. On total failure → stale cache or nothing
6. Always inject delegation-only instruction regardless of context outcome
7. Return `{ systemPrompt }` — Pi concatenates system prompt injections from extensions

---

## 3. Context Builder Sub-Agent

The context builder is the intelligence layer. It decides what the main agent needs to know before delegating.

### 3.1 Execution Model

The context builder runs as a **sub-process spawned via `pi.exec()`**. Pi extensions do not have a dedicated sub-agent spawning API — instead, `pi.exec()` shells out to the `subpi` CLI tool (available on PATH in OpenClaw environments) which handles sub-agent lifecycle.

The builder is granted **read-only tools only**: `Read`, `Glob`, `Grep`, `Ls`. It cannot write, execute shell commands, or modify anything. It reads files, builds a structured summary, and returns it.

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

  const builderInput = formatBuilderInput(prompt);

  // Spawn context builder as a sub-agent via pi.exec + subpi CLI.
  // subpi is a CLI tool on PATH, not a Pi extension API.
  // The exact invocation will depend on subpi's CLI interface.
  const buildPromise = spawnContextBuilder(pi, {
    systemPrompt: CONTEXT_BUILDER_SYSTEM_PROMPT,
    userPrompt: builderInput,
    model,
    tools: ["Read", "Glob", "Grep", "Ls"],
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
  // Implementation: use pi.exec() to invoke subpi CLI with appropriate args.
  // subpi handles sub-agent lifecycle, tool restrictions, and result capture.
  // Exact CLI interface TBD during implementation.
  //
  // Example (conceptual):
  //   pi.exec("subpi", ["spawn", "--model", opts.model,
  //     "--tools", opts.tools.join(","),
  //     "--system", opts.systemPrompt,
  //     "--prompt", opts.userPrompt])
  //
  throw new Error("Not yet implemented — see implementation spec");
}

function formatBuilderInput(prompt: string): string {
  return `Gather context for the following user request:\n\n${prompt}`;
}
```

### 3.2 What It Receives

| Input | Source | Purpose |
|-------|--------|---------|
| User's raw prompt | Extracted from `before_agent_start` event | Understand intent |
| Read-only tools | `Read`, `Glob`, `Grep`, `Ls` | Gather file contents and structure |

### 3.3 What It Does

The context builder is a sub-agent with read-only tool access. It:

1. Receives the user's prompt
2. Uses `Glob` and `Ls` to explore the workspace structure
3. Uses `Grep` to find relevant files
4. Uses `Read` to pull file contents
5. Returns a structured markdown summary of relevant context

### 3.4 What It Returns

A structured context block (plain text/markdown) containing any combination of:

- **Relevant file contents** — files the main agent will need to reference when delegating
- **Memory excerpts** — from MEMORY.md, daily logs, etc.
- **Codebase structure** — directory trees, key file listings
- **Nothing** — if the prompt is conversational or doesn't need codebase context

After the builder returns, the extension applies a **hard truncation cap** of 4000 tokens (see §2.2).

### 3.5 System Prompt

```ts
// context-builder/prompt.ts
export const CONTEXT_BUILDER_SYSTEM_PROMPT = `You are a context builder for an AI agent operating in delegation-only mode.

You have read-only tools: Read, Glob, Grep, Ls. Use them to explore the workspace
and gather context the main agent needs to effectively delegate work.

## What to gather
- File contents directly relevant to the prompt (use Read)
- Directory structure if the prompt involves code navigation (use Ls, Glob)
- Memory/context files if the prompt references past work (use Read)
- Config or schema files if the prompt involves system configuration (use Read)
- Search for relevant patterns (use Grep)

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

### 3.6 Sub-Agent Spawn Details

The context builder is spawned via **`subpi`** — a CLI tool available on PATH in OpenClaw environments. `subpi` is **not** a Pi extension API; it is an agent-level tool that handles sub-agent lifecycle. Key aspects:

1. **Read-only tool set** — the spawn restricts tools to `Read`, `Glob`, `Grep`, `Ls`. The builder cannot write, execute, or modify anything.
2. **Timeout control** — `Promise.race` wraps the spawn; if it exceeds `timeoutMs`, we fall back to stale cache.
3. **Model selection** — the spawn specifies the configured model (default: Sonnet) for fast context gathering.
4. **Cleanup** — the sub-agent process terminates when it completes; no manual cleanup required.
5. **Recursion safety** — the context builder runs as a sub-agent, so the `isMainAgent()` guard in our hooks prevents it from being restricted.

---

## 4. Tool Allowlist

### Canonical Allowed Tools (delegation-only mode)

```ts
["subagents", "sessions_spawn", "message", "tts"]
```

| Tool | Reason |
|------|--------|
| `subagents` | Core delegation mechanism — spawn, list, steer, kill sub-agents |
| `sessions_spawn` | Alternative sub-agent spawn entry point |
| `message` | Send messages to channels (the agent still needs to communicate) |
| `tts` | Text-to-speech output — an output modality, not work |

> **Note on `subpi`:** `subpi` is a CLI tool used internally by the extension (via `pi.exec()`). It is **not** in the allowlist because it is not a tool the main agent calls directly — the extension calls it on the agent's behalf.

### Blocked (everything else)

All other tools are blocked at the `tool_call` level. Key blocked tools:

| Tool | Why blocked |
|------|------------|
| `exec` | Shell execution — must be delegated |
| `Read` / `Write` / `Edit` | File operations — must be delegated |
| `web_search` / `web_fetch` | Research — must be delegated |
| `browser` | Browser automation — must be delegated |
| `image` | Image analysis — must be delegated |

### Configurable Override

The allowlist is configurable via `~/.pi/agent/settings.json` under `reins.allowedTools`.

---

## 5. Config Schema

Configuration in `~/.pi/agent/settings.json`:

```jsonc
{
  // Pi-level extension registration
  "extensions": ["~/.pi/agent/extensions/reins/index.ts"],

  // Reins configuration (read by the extension at runtime)
  "reins": {
    "enabled": false,         // Master toggle. Default: false.
    "model": "sonnet",        // Context builder model. Default: "sonnet".
    "timeoutMs": 12000,       // Context builder timeout in ms. Default: 12000.
    "allowedTools": [         // Tools allowed in delegation mode.
      "subagents",            // Default: ["subagents", "sessions_spawn", "message", "tts"]
      "sessions_spawn",
      "message",
      "tts"
    ],
    "cacheMaxAge": 300000,    // Cache TTL in ms (5 min). Default: 300000.
    "debug": false            // Log context builder input/output. Default: false.
  }
}
```

### Config Resolution

```ts
// config.ts
import { readFileSync } from "node:fs";
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

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

let cachedSettings: Record<string, unknown> | null = null;
let cachedMtime = 0;

function readSettings(): Record<string, unknown> {
  // Re-read settings if file has changed (stat-based cache)
  try {
    const { mtimeMs } = require("node:fs").statSync(SETTINGS_PATH);
    if (cachedSettings && mtimeMs === cachedMtime) return cachedSettings;
    cachedSettings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    cachedMtime = mtimeMs;
    return cachedSettings!;
  } catch {
    return {};
  }
}

export function getReinsConfig(): ReinsConfig {
  const settings = readSettings();
  const rc = (settings.reins ?? {}) as Record<string, unknown>;

  return {
    enabled: typeof rc.enabled === "boolean" ? rc.enabled : false,
    model: typeof rc.model === "string" ? rc.model : "sonnet",
    timeoutMs: typeof rc.timeoutMs === "number" ? rc.timeoutMs : DEFAULT_TIMEOUT_MS,
    allowedTools: Array.isArray(rc.allowedTools) ? rc.allowedTools : ALLOWED_TOOLS,
    cacheMaxAge: typeof rc.cacheMaxAge === "number" ? rc.cacheMaxAge : DEFAULT_CACHE_MAX_AGE,
    debug: typeof rc.debug === "boolean" ? rc.debug : false,
  };
}
```

---

## 6. Command Handlers

### 6.1 `/reins on|off|status`

```ts
// commands/reins.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getReinsConfig, setReinsEnabled } from "../config.js";

export function registerReinsCommand(pi: ExtensionAPI) {
  pi.registerCommand("reins", {
    description: "Toggle delegation-only mode: /reins on|off|status",
    async execute(args, ctx) {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "on") {
        await setReinsEnabled(true);
        ctx.ui.notify("🫸 Reins **on** — agent is now delegation-only.", "info");
        return;
      }

      if (arg === "off") {
        await setReinsEnabled(false);
        ctx.ui.notify("🔓 Reins **off** — agent has full tool access.", "info");
        return;
      }

      if (arg === "status" || arg === "") {
        const config = getReinsConfig();
        const msg = config.enabled
          ? `🫸 Reins is **on** (context builder: ${config.model})`
          : "🔓 Reins is **off**";
        ctx.ui.notify(msg, "info");
        return;
      }

      ctx.ui.notify("Usage: `/reins on|off|status`", "warn");
    },
  });
}
```

**`setReinsEnabled` implementation:** Reads `~/.pi/agent/settings.json`, sets `reins.enabled`, writes back atomically.

### 6.2 `/prework <prompt>`

Explicitly triggers the context builder without enabling the always-on harness.

```ts
// commands/prework.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildContextWithTimeout } from "../context-builder/builder.js";
import { getReinsConfig } from "../config.js";

export function registerPreworkCommand(pi: ExtensionAPI) {
  pi.registerCommand("prework", {
    description: "Pre-gather context for a task: /prework <prompt>",
    async execute(args, ctx) {
      const prompt = (args ?? "").trim();
      if (!prompt) {
        ctx.ui.notify("Usage: `/prework <what you're about to work on>`", "warn");
        return;
      }

      const config = getReinsConfig();
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
        // Use sendMessage to inject the context into the conversation
        pi.sendMessage({
          type: "text",
          text: `📋 **Pre-gathered context**${marker}:\n\n${result.context}`,
        });
      } catch {
        ctx.ui.notify("⚠️ Context builder failed.", "error");
      }
    },
  });
}
```

---

## 7. State Management

### 7.1 Enabled State

- **Persisted in:** `~/.pi/agent/settings.json` at `reins.enabled`
- **Written by:** `/reins on|off` command handler
- **Read by:** Both hooks on every invocation (stat-cached to avoid redundant disk reads)
- **Survives restarts:** Yes — it's in the settings file

### 7.2 Context Cache

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

## 8. Extension Points

### 8.1 Composability

Pi extensions compose naturally:

- Multiple extensions can subscribe to `before_agent_start` — Pi concatenates system prompt injections
- Multiple extensions can subscribe to `tool_call` — any extension returning `{ block: true }` prevents the call
- The context builder model is configurable — can use a local model, a different provider, etc.

### 8.2 Future Commands

- `/reins config <key> <value>` — runtime config changes
- `/reins allow <tool>` — temporarily allow a tool
- `/reins log` — show what context was injected on the last turn

### 8.3 Versioning & Migration

v0.1.0 is the initial release. Config keys are additive — new keys get defaults, removed keys are ignored.

---

## 9. Architecture Decision Records

### ADR-001: Pi Extension Only

**Status:** Accepted
**Date:** 2026-03-03

**Context:** Reins could be built as either a Pi extension or an OpenClaw plugin. Both systems support tool interception, lifecycle hooks, and custom commands.

**Decision:** Build Reins as a Pi extension exclusively.

**Rationale:**
- Reins constrains the **coding agent's** tool usage. Pi is the coding agent; OpenClaw is the gateway layer above it. Constraining at the agent level is architecturally correct.
- Pi's event model (`tool_call`, `before_agent_start`) maps directly to what Reins needs. No translation layer required.
- Keeps the extension portable — works in any Pi environment, not just those running OpenClaw.
- Simpler deployment — drop a `.ts` file in the extensions directory, no manifest file needed.

**Consequences:**
- No access to OpenClaw-specific features (HTTP routes, channel registration, gateway lifecycle hooks). These are not needed for Reins.
- If OpenClaw adds native tool policy enforcement (e.g., `toolPolicy` in hook results), a future version could optionally integrate, but v1 does not depend on it.

### ADR-002: Main Agent Identification

**Status:** Proposed
**Date:** 2026-03-03

**Context:** Reins must restrict only the main (top-level) agent, not sub-agents. Pi's `ExtensionContext` needs to provide a way to distinguish them.

**Decision:** Use whatever Pi exposes to identify the top-level session (e.g., `ctx.parentSessionId === undefined`, `ctx.depth === 0`). Placeholder `isMainAgent()` function will be implemented during development once the exact API is confirmed.

**Rationale:** Hardcoding `ctx.agentId === "main"` is fragile and undocumented. A structural check (no parent = main) is more robust.

**Consequences:** Implementation blocked until Pi's context API is inspected. If no structural field exists, fall back to a heuristic or request an upstream addition.

### ADR-003: subpi Is a CLI Tool, Not a Pi API

**Status:** Accepted
**Date:** 2026-03-03

**Context:** `subpi` is referenced throughout as the mechanism for spawning sub-agents. It could be confused with a Pi extension API.

**Decision:** Document clearly: `subpi` is a CLI tool on PATH (provided by the OpenClaw environment). Pi extensions invoke it via `pi.exec()`. It is not part of `@mariozechner/pi-coding-agent`.

**Consequences:** The context builder spawn requires shelling out via `pi.exec()` rather than calling a typed API. Error handling must account for process-level failures.

---

## 10. Migration Checklist: OpenClaw Plugin → Pi Extension

For anyone porting an OpenClaw plugin to a Pi extension:

| # | OpenClaw Plugin | Pi Extension | Notes |
|---|----------------|--------------|-------|
| 1 | `openclaw.plugin.json` manifest | No manifest — use file convention or `package.json` `"pi"` key | Delete the manifest file |
| 2 | `import { OpenClawPluginApi } from "openclaw/plugin-sdk"` | `import { ExtensionAPI } from "@mariozechner/pi-coding-agent"` | |
| 3 | Object export: `{ id, register(api) }` | Function export: `export default function(pi)` | |
| 4 | `api.on("before_tool_call", ...)` | `pi.on("tool_call", ...)` | Different event name |
| 5 | `api.on("before_prompt_build", ...)` | `pi.on("before_agent_start", ...)` | Different event name |
| 6 | Return `{ block: true, blockReason: "..." }` | Return `{ block: true, reason: "..." }` | Different field name |
| 7 | Return `{ prependContext: "..." }` | Return `{ systemPrompt: "..." }` | Different injection mechanism |
| 8 | `api.pluginConfig` | Read `~/.pi/agent/settings.json` directly | No built-in plugin config |
| 9 | `api.registerCommand({ name, handler })` | `pi.registerCommand(name, { execute })` | Different registration shape |
| 10 | `api.config.plugins.entries.<id>.enabled` | `settings.json` → `reins.enabled` | Different config location |
| 11 | `~/.openclaw/extensions/` | `~/.pi/agent/extensions/` | Different directory |
| 12 | `"openclaw": { "extensions": [...] }` in package.json | `"pi": { "extensions": [...] }` in package.json | Different key |
| 13 | `api.subpi.spawn(...)` | `pi.exec("subpi", [...])` | subpi is a CLI, not an API |

---

## 11. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Context builder adds 5–12s latency per turn** | High — UX degradation | High | Timeout with stale cache fallback. `/prework` for explicit pre-build. Sonnet is fast. |
| **LLM ignores soft enforcement and tries blocked tools** | Medium — wasted tokens | Medium | Hard enforcement via `tool_call` catches all attempts. Soft layer reduces frequency. |
| **Sub-agents also restricted** | Critical — delegation breaks | Low (mitigated by design) | `isMainAgent()` guard ensures only main agent is restricted. |
| **Context builder injects irrelevant context** | Medium — misleading | Medium | Conservative builder prompt. Cache keyed by prompt hash. TTL. Debug mode. |
| **Pi `before_agent_start` not awaited** | High — context injection fails | Low (assumed awaited) | **Validate with Pi source before v1.** |
| **Main agent identification unreliable** | High — blocks sub-agents or misses main | Medium | ADR-002: implement based on confirmed Pi API. |
| **`pi.exec()` spawn overhead** | Medium — slower context building | Medium | Timeout + cache fallback. |
| **Token cost of context injection** | Low — adds tokens per turn | High (by design) | Hard truncation at 4000 tokens. Cache reduces redundant builds. |

### Risk: Recursive Hook Invocation

If the context builder triggers `before_agent_start` again, the hook would recurse. **Mitigation:** The `isMainAgent()` guard prevents this — the context builder runs as a sub-agent. Additional safety: a `__reins_building_context` flag on the context object breaks any unexpected recursion.

---

## Appendix: Constants

```ts
// constants.ts
export const ALLOWED_TOOLS = ["subagents", "sessions_spawn", "message", "tts"];
export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes
export const CONTEXT_BUILDER_MAX_TOKENS = 4_000;
export const MAX_CACHE_ENTRIES = 100;
```
