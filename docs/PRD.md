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

- **G1:** Strip the main agent's tool access to delegate-only — hard block, not a suggestion. Reins provides its own delegation tool via the extension (using `pi.exec()` to spawn `pi` sub-processes), or relies on any extension-provided sub-agent tool already available.
- **G2:** Run a context builder sub-agent once per user prompt (via `before_agent_start`) that injects relevant context as a prepended system prompt
- **G3:** Toggleable via `/reins on|off|status` slash command, backed by persistent config
- **G4:** Default OFF — zero impact until activated
- **G5:** Implemented as a Pi extension (`@mariozechner/pi-coding-agent`)

## Non-Goals / Out of Scope

- Not a general-purpose tool restriction framework
- Not a billing/cost control mechanism
- Not a replacement for good prompting — it's a structural complement
- v1 does not include a UI or dashboard
- **OpenClaw plugin support is explicitly out of scope for v1.** Reins targets Pi only. A future version may port to other platforms, but v1 requirements, hooks, config, and acceptance criteria are defined exclusively against the Pi extension API.

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
As a developer, I want the harness enabled/disabled state to survive restarts (persisted via `~/.pi/agent/settings.json`) so I don't have to re-enable it every session. Note: mid-session state (context cache, tool block counts) is in-memory and resets on restart — this is by design.

**US6 — Graceful failure**
As a developer, if the context builder fails or times out, I want the main agent to proceed unblocked — Reins should never be the reason a turn fails.

---

## Architecture Overview

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
          │    - Model: Sonnet (default, user-configurable) │
          │    - Timeout: 10-15s (Promise.race)            │
          │    - On timeout: inject partial / stale cache   │
          │    - On failure: return void, proceed unblocked │
          │                                                │
          ├─── [2. Tool Restriction — Dual Layer] ────────┤
          │    SOFT: before_agent_start injects system      │
          │      context: "you are delegation-only"        │
          │    HARD: tool_call event blocks                 │
          │      non-delegation calls at execution time    │
          │                                                │
          ▼                                                │
   Prepend context to prompt ◄─────────────────────────────┘
          │
          ▼
   [Main Agent — CUFFED]
   Tools visible but blocked except: delegation tool(s) provided by the extension
   LLM sees full tool schema; non-delegation calls return:
     { block: true, reason: "Reins: restricted to delegation only" }
          │
          ▼
   Delegates to executor sub-agent(s)
```

### Toggle Mechanism

```jsonc
// ~/.pi/agent/settings.json
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

export default function (pi: ExtensionAPI) {
  // Soft enforcement: inject delegation-only system context
  // Note: before_agent_start fires once per user prompt, not per internal tool/LLM turn
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isEnabled()) return;

    // 1. Run context builder with timeout
    const context = await buildContextWithTimeout(ctx);

    // 2. Inject delegation-only instruction + gathered context
    const parts = [
      "You are in delegation-only mode (Reins). You MUST delegate all work to sub-agents. Do not use other tools directly.",
    ];
    if (context) parts.push(context);

    return { systemPrompt: parts.join("\n\n") };
  });

  // Hard enforcement: block non-delegation tool calls at execution time
  pi.on("tool_call", async (event, ctx) => {
    if (!isEnabled()) return;
    const allowed = ["reins_delegate"]; // Extension-provided delegation tool(s)
    if (!allowed.includes(event.toolName)) {
      return { block: true, reason: "Reins: restricted to delegation only" };
    }
  });

  // Register /reins command
  pi.registerCommand("reins", {
    description: "Toggle delegation-only harness (on/off/status)",
    handler: async (args, ctx) => {
      // ... toggle logic
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

- Runs as a sub-process via `pi.exec()` with configurable timeout (default 10–15s, via `Promise.race`)
- **Model:** Sonnet by default, user-configurable via `reins.contextModel` in `~/.pi/agent/settings.json`
- Given: the user's raw prompt + recent conversation
- Outputs: a structured context block, or nothing
- Scope: codebase files, memory, docs, past conversations — builder decides what's relevant

**Failure handling:**
- Extension implements its own timeout via `Promise.race` (no built-in timeout in Pi's event system)
- **On timeout:** inject whatever partial context was gathered, or return stale cached results
- **On total failure:** return `void`, agent proceeds unblocked
- **Partial results:** always inject partial context (partial > nothing), with a caveat marker (e.g. `[context: partial — builder timed out]`)
- **Cache pattern:** cache previous context results; return stale cache on timeout for subsequent turns

### Tool Restriction (Dual-Layer Enforcement)

There is no extension API to inject tool policies into the pipeline directly. `pi.setActiveTools()` can hide tools, but we want them visible-but-blocked so the LLM understands the constraint. The solution is dual-layer enforcement:

1. **Soft layer — `before_agent_start`:** Injects system context telling the agent it's delegation-only. Reduces wasted attempts — the model knows not to try.
2. **Hard layer — `tool_call`:** Blocks non-delegation tool calls at execution time. Returns `{ block: true, reason: "Reins: restricted to delegation only" }`.

Tools still appear in the LLM's schema but calls are blocked. The model sees them but can't use them. This is acceptable for v1 — the soft layer minimises noise, the hard layer guarantees enforcement.

---

## Open Questions

All open questions have been resolved or dropped.

| # | Question | Resolution |
|---|----------|------------|
| OQ1 | How do you hard-restrict tool access? | **Resolved.** Dual-layer enforcement: `tool_call` event blocks non-delegation calls (hard), `before_agent_start` injects delegation-only instruction (soft). `pi.setActiveTools()` exists but hides tools entirely — we want visible-but-blocked. |
| OQ2 | Context builder model choice? | **Resolved.** Default to Sonnet, user-configurable via `reins.contextModel` in `~/.pi/agent/settings.json`. |
| OQ3 | Cost model / token budget cap? | **Dropped.** Not relevant for v1. |
| OQ4 | Context builder failure modes? | **Resolved.** Extension implements own timeout (Promise.race, 10–15s). Partial results injected with caveat marker. On total failure, return void — agent proceeds. Cache pattern for stale fallback on subsequent turns. |
| OQ5 | How does cuffed agent communicate delegation plan? | **Resolved.** The agent's natural language response describes what it's delegating and why — no special UX needed. The cuffed agent already explains its plan conversationally before spawning sub-agents. |

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
- [ ] `/reins` slash command (on/off/status) via `pi.registerCommand`
- [ ] Config-backed toggle via `~/.pi/agent/settings.json`
- [ ] `before_agent_start` event — context injection + soft tool restriction
- [ ] `tool_call` event — hard tool restriction (dual-layer enforcement)
- [ ] Context builder sub-process via `pi.exec()` to spawn `pi` subprocess (Sonnet default, configurable model)
- [ ] Context builder timeout + cache pattern
- [ ] `/prework <prompt>` explicit trigger via `pi.registerCommand`

### v2 — Refinement
- [ ] Context builder tuning / scope configuration
- [ ] Metrics + logging
- [ ] Context injection transparency — opt-in visibility of injected context (US4)
- [ ] Evaluate porting to OpenClaw plugin if demand exists
