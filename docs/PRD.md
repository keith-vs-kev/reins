# PRD: Reins

**Status:** Draft  
**Author:** Quinn (via Iris)  
**Date:** 2026-03-03  
**Repo:** mcinteer/reins

---

## Problem Statement

AI coding agents are increasingly capable — but that capability is also their failure mode. A single agent asked to "build X" will read files, write code, run commands, search the web, and make architectural decisions in the same turn, often getting lost, going wide, or doing things it wasn't asked to do.

The root cause: agents have too many tools and no structural constraint on how they use them. Telling an agent "don't do X" in a system prompt is advisory. We want it to be architectural.

**Reins** enforces single-responsibility at the harness level:
1. A context builder agent curates what the main agent needs to know
2. The main agent can only delegate, think, and communicate — it cannot execute directly

---

## Goals

- **G1:** Strip the main agent's tool access to delegate-only — hard block, not a suggestion. Reins registers its own delegation tool (`reins_delegate`) via `pi.registerTool()`, which internally spawns `pi` sub-processes using `child_process.spawn()` (matching Pi's own subagent example extension).
- **G2:** Run a context builder sub-agent once per user prompt (via `before_agent_start`) that injects relevant context as a modified system prompt
- **G3:** Toggleable via `/reins on|off|status` slash command, backed by persistent config in settings files
- **G4:** Default OFF — zero impact until activated
- **G5:** Implemented as a Pi extension (`@mariozechner/pi-coding-agent`)

## Non-Goals / Out of Scope

- Not a general-purpose tool restriction framework
- Not a billing/cost control mechanism
- Not a replacement for good prompting — it's a structural complement
- v1 does not include a UI or dashboard
- **OpenClaw plugin support is explicitly out of scope for v1.** Reins targets Pi only. A future version may port to other platforms, but v1 requirements, hooks, config, and acceptance criteria are defined exclusively against the Pi extension API.
- **Reins does not guarantee invisible failure of blocked tool calls.** Blocked calls surface as error results that the model sees and may reference. This is by design (teaching mode). See ARCH.md §13.

---

## User Stories

**US1 — Enable the harness**
As a developer, I want to run `/reins on` so that my agent is constrained to delegation-only mode for the rest of the session.

**US2 — Context injection**
As a developer, when I send a message to my agent, I want a context builder to automatically run first and inject relevant files, memory, and docs into the prompt — so the main agent starts with everything it needs.

_Acceptance criteria:_
- Given a prompt mentioning [feature X], the context builder injects at least one file path or memory snippet relevant to [feature X] within the timeout window.
- Given a prompt with no clear file/code relevance, the builder returns EMPTY and no context is injected.

**US3 — Explicit prework**
As a developer, I want to run `/prework <my prompt>` to manually trigger context building for a specific task, without enabling the always-on harness.

**US4 — Transparent injection (v2)**
As a developer, I want to see what context was injected (or know that nothing was injected) so I can debug and tune the context builder over time.

_Deferred to v2._ In v1, context injection is invisible. v2 will add opt-in transparency (e.g. `/reins verbose on`).

**US5 — Persistent toggle**
As a developer, I want the harness enabled/disabled state to survive restarts so I don't have to re-enable it every session.

_Persistence model:_ Toggle state is stored in Pi's settings files using the two-scope model:
- **Global:** `~/.pi/agent/settings.json` → applies to all projects
- **Project:** `.pi/settings.json` → overrides global for this project

The `/reins on|off` command writes to the **global** settings file by default. A future version may support `--project` scope. Mid-session state (context cache, tool block counts) is in-memory and resets on restart — this is by design.

**US6 — Graceful failure**
As a developer, if the context builder fails or times out, I want the main agent to proceed unblocked — Reins should never be the reason a turn fails.

---

## Architecture Overview

### Pi Built-in Tools (Reference)

Pi's default active tools are: `read`, `bash`, `edit`, `write` (4 tools). Additional tools available in the registry: `grep`, `find`, `ls` (7 total). There are no built-in delegation, messaging, or TTS tools. Delegation must be provided by extensions — either the `subagent` example extension or a custom tool registered via `pi.registerTool()`.

### Components

```
User message
     │
     ▼
[Reins Extension] ─── before_agent_start event
     │
     ├─ enabled? ──no──► [Main Agent] (full tools, normal turn)
     │
     └─ yes
          │
          ├─── [1. Context Builder] ──────────────────────┐
          │    - Reads prompt intent                       │
          │    - Searches files, memory, past turns        │
          │    - Returns: context block OR empty            │
          │    - Model: settings.reins.model (configurable)  │
          │    - Timeout: 10-15s (Promise.race)            │
          │    - On timeout: stale cache or proceed without  │
          │    - On failure: return void, proceed unblocked │
          │                                                │
          ├─── [2. Tool Restriction — Dual Layer] ────────┤
          │    SOFT: before_agent_start injects system      │
          │      context: "you are delegation-only"        │
          │    HARD: tool_call event blocks                 │
          │      non-delegation calls at execution time    │
          │                                                │
          ▼                                                │
   Modified system prompt ◄────────────────────────────────┘
          │
          ▼
   [Main Agent — CUFFED]
   Tools visible but blocked except: reins_delegate (registered by this extension)
   LLM sees full tool schema; non-delegation calls return:
     { block: true, reason: "Reins: restricted to delegation only" }
          │
          ▼
   Delegates to executor sub-agent(s) via reins_delegate tool
```

### Toggle Mechanism

```jsonc
// ~/.pi/agent/settings.json (global scope)
// .pi/settings.json (project scope — overrides global)
{
  "extensions": ["~/.pi/agent/extensions/reins/index.ts"],
  "reins": {
    "enabled": false   // default OFF
  }
}
```

Slash command handler (registered via `pi.registerCommand`):
- `/reins on` → sets `reins.enabled = true` in `~/.pi/agent/settings.json`
- `/reins off` → sets to `false`
- `/reins status` → reports current state

### Hook Registration

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Register the delegation tool so the cuffed agent can spawn sub-agents.
  // Pi has no built-in delegation tool — we must provide one.
  pi.registerTool({
    name: "reins_delegate",
    label: "Delegate",
    description: "Delegate a task to a sub-agent with full tool access",
    parameters: Type.Object({
      task: Type.String({ description: "Task description for the sub-agent" }),
      model: Type.Optional(Type.String({ description: "Model ID override. Uses settings.reins.model if omitted." })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Spawns a pi sub-process via child_process.spawn() — see ARCH.md §3
      // ...
      return { content: [{ type: "text", text: "..." }] };
    },
  });

  // Soft enforcement: inject delegation-only system context
  // Note: before_agent_start fires once per user prompt, not per internal tool/LLM turn
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isEnabled()) return;

    // 1. Run context builder with timeout
    const context = await buildContextWithTimeout(ctx);

    // 2. Inject delegation-only instruction + gathered context
    const parts = [
      event.systemPrompt,
      "You are in delegation-only mode (Reins). You MUST delegate all work to sub-agents via reins_delegate. Do not use other tools directly.",
    ];
    if (context) parts.push(context);

    return { systemPrompt: parts.join("\n\n") };
  });

  // Hard enforcement: block non-delegation tool calls at execution time
  pi.on("tool_call", async (event, ctx) => {
    if (!isEnabled()) return;
    const allowed = ["reins_delegate"]; // Extension-provided delegation tool
    if (!allowed.includes(event.toolName)) {
      return { block: true, reason: "Reins: restricted to delegation only" };
    }
  });

  // Register /reins command
  pi.registerCommand("reins", {
    description: "Toggle delegation-only harness (on/off/status)",
    handler: async (args, ctx) => {
      // ... toggle logic — reads/writes ~/.pi/agent/settings.json
    },
  });

  // Register /prework command
  pi.registerCommand("prework", {
    description: "Manually trigger context building for a prompt",
    handler: async (args, ctx) => {
      // ... context builder logic
    },
  });
}
```

### Context Builder

- Runs as a sub-process: the extension's `reins_delegate` tool or a dedicated builder function uses `pi.exec()` to spawn `pi` with `--mode json -p --no-session` flags
- **Model:** configurable via `settings.reins.model` (e.g. `claude-sonnet-4-20250514` — illustrative, not hardcoded)
- Given: the user's raw prompt (from `event.prompt`)
- Outputs: a structured context block, or nothing
- Scope: codebase files, memory, docs — builder decides what's relevant

**Failure handling:**
- Extension implements its own timeout via `Promise.race` (no built-in timeout in Pi's event system)
- **On timeout with stale cache:** inject previous cached context with caveat marker
- **On timeout with no cache:** return `void`, agent proceeds unblocked without injected context
- **On total failure:** return `void`, agent proceeds unblocked
- **Cache pattern:** cache previous context results; return stale cache on timeout for subsequent turns

### Tool Restriction (Dual-Layer Enforcement)

`pi.setActiveTools()` can hide tools, but we want them visible-but-blocked so the LLM understands the constraint. The solution is dual-layer enforcement:

1. **Soft layer — `before_agent_start`:** Modifies system prompt telling the agent it's delegation-only. Reduces wasted attempts — the model knows not to try.
2. **Hard layer — `tool_call`:** Blocks non-delegation tool calls at execution time. Returns `{ block: true, reason: "Reins: restricted to delegation only" }`.

Tools still appear in the LLM's schema but calls are blocked. The model sees them but can't use them. This is acceptable for v1 — the soft layer minimises noise, the hard layer guarantees enforcement.

---

## Open Questions

All open questions have been resolved or dropped.

| # | Question | Resolution |
|---|----------|------------|
| OQ1 | How do you hard-restrict tool access? | **Resolved.** Dual-layer enforcement: `tool_call` event blocks non-delegation calls (hard), `before_agent_start` modifies system prompt (soft). `pi.setActiveTools()` exists but hides tools entirely — we want visible-but-blocked. |
| OQ2 | Context builder model choice? | **Resolved.** Configurable via `settings.reins.model`. Example: `claude-sonnet-4-20250514`. Startup warning if configured model unavailable. |
| OQ3 | Cost model / token budget cap? | **Dropped.** Not relevant for v1. |
| OQ4 | Context builder failure modes? | **Resolved.** Extension implements own timeout (Promise.race, 10–15s). Outcomes: success / timeout+stale cache / timeout+no cache / failure. On total failure, return void — agent proceeds. Cache pattern for stale fallback on subsequent turns. |
| OQ5 | How does cuffed agent communicate delegation plan? | **Resolved.** The agent's natural language response describes what it's delegating and why — no special UX needed. |

---

## Success Metrics

- **Activation rate:** % of sessions where `/reins on` is used
- **Context hit rate:** % of turns where context builder injects something (vs. nothing)
- **Context builder success rate:** % of turns where context was injected vs timed out/failed
- **Tool block rate:** Number of blocked tool calls per session — should trend toward 0 as the soft prompt improves
- **Sub-agent retry rate:** % of delegated tasks that required a retry or follow-up correction
- **Latency overhead:** p50/p95 added latency per turn from context builder
- **Error rate:** % of turns where context builder fails/times out

---

## Implementation Phases

### v1 — Core Harness (Pi Extension)
- [ ] Pi extension scaffold (`~/.pi/agent/extensions/reins/index.ts`)
- [ ] `reins_delegate` tool registered via `pi.registerTool()` — spawns `pi` sub-processes via `child_process.spawn()`
- [ ] `/reins` slash command (on/off/status) via `pi.registerCommand` with `handler` callback
- [ ] Config-backed toggle via `~/.pi/agent/settings.json` (global) with `.pi/settings.json` (project) override
- [ ] `before_agent_start` event — context injection + soft tool restriction (fires once per user prompt)
- [ ] `tool_call` event — hard tool restriction (dual-layer enforcement)
- [ ] Context builder sub-process via `child_process.spawn()` to spawn `pi --mode json -p --no-session` (model: configurable via `settings.reins.model`)
- [ ] Context builder timeout + cache pattern
- [ ] `/prework <prompt>` explicit trigger via `pi.registerCommand`

- [ ] Test matrix validation (see ARCH.md §17 for full test matrix)

### v2 — Refinement
- [ ] Context builder tuning / scope configuration
- [ ] Metrics + logging
- [ ] Context injection transparency — opt-in visibility of injected context (US4)
- [ ] `/reins on --project` for project-scoped toggle
- [ ] Evaluate porting to OpenClaw plugin if demand exists
