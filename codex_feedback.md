# Reins Plan Validation Feedback (Codex)

Date: 2026-03-04

Scope reviewed:
- `docs/PRD.md`
- `docs/ARCH.md`
- `docs/UX-SPEC.md`

Validation method:
- Cross-checked against actual Pi extension framework source/docs in `~/projects/pi-mono/packages/coding-agent`
- Verified extension APIs, event contracts, command contracts, tool registry, and lifecycle flow from code

## Executive Summary

The plan has strong intent (structural enforcement via extension hooks) and correctly identifies key Pi extension mechanisms (`before_agent_start`, `tool_call`). However, it is currently **not implementation-ready** because multiple core assumptions target APIs/tool names that are not the actual Pi surface.

Overall rating: **3.5 / 10** for implementation readiness against current Pi reality.

## What Is Correct

1. `tool_call` hard blocking with `{ block: true, reason }` is real and correct.
2. `before_agent_start` is the right place for per-turn prompt/system-prompt injection.
3. The event is awaited before agent prompt execution.
4. Extension discovery assumptions are mostly correct (global/project extension paths + settings + package `pi.extensions`).

## Critical Gaps (Fix Before Build)

### 1) Delegation model relies on non-existent tool names/APIs

The docs repeatedly assume a delegate-only allowlist of tools like `subagents`, `sessions_spawn`, `message`, and `tts`, plus `subpi` as a built-in delegation primitive. That is not Pi’s built-in tool surface.

Observed in Pi:
- Built-in tools are: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- Delegation is done via extensions (for example, the `subagent` example tool), not via built-in `sessions_spawn`/`message`/`tts` tool names.
- The example subagent implementation spawns `pi` subprocesses directly (`spawn("pi", ...)`).

Impact:
- Current allowlist/blocklist logic in docs will block the wrong tools and fail to produce the intended behavior.
- “Cuffed main agent” behavior is underspecified against actual available tools.

Required fix:
- Rebase the architecture on real tool names.
- Decide whether Reins itself provides a delegation tool, or depends on a known installed delegation extension/tool (`subagent`).
- Define enforcement rules in terms of actual registered tool names at runtime (`pi.getAllTools()` / `pi.getActiveTools()`).

---

### 2) Command registration contract is wrong in code examples

Docs use:
- `pi.registerCommand("reins", { async execute(...) { ... } })`

Actual Pi expects:
- `pi.registerCommand("reins", { handler: async (args, ctx) => { ... } })`

Impact:
- Commands won’t execute if implemented as shown.

Required fix:
- Replace all `execute` properties with `handler` in specs and examples.

---

### 3) Main-agent vs sub-agent detection is based on unsupported context fields

Docs propose checking things like `ctx.parentSessionId` or `ctx.depth` to distinguish main agent from sub-agent turns. Those fields are not part of current `ExtensionContext`.

Impact:
- “Only restrict main agent” logic is currently not implementable as described.

Required fix:
- Either:
  1. Restrict by tool/turn behavior without relying on absent context fields, or
  2. Implement a robust marker strategy (process/session-level separation, explicit flags in controlled paths), or
  3. Accept that restrictions apply to all tool calls in this process and move delegation execution out-of-process.

---

### 4) Persistence model confusion (`appendEntry` is session scope, not global onboarding state)

UX spec suggests using `pi.appendEntry("reins_onboarding", { shown: true })` for “first `/reins on` ever” onboarding state. `appendEntry` writes session entries, not durable global product settings.

Impact:
- “Shown once ever” behavior won’t hold across independent sessions/projects as intended.

Required fix:
- Persist onboarding and toggle state in settings (`~/.pi/agent/settings.json` and/or `.pi/settings.json`) or a dedicated extension-managed file.
- Keep `appendEntry` for session analytics/history, not global feature flags.

---

### 5) Settings strategy ignores Pi’s two-scope merge model

Docs focus on `~/.pi/agent/settings.json` only. Pi supports both:
- global: `~/.pi/agent/settings.json`
- project: `.pi/settings.json`
with project override/merge behavior.

Impact:
- Ambiguous persistence behavior, especially for team/project-specific Reins policy.

Required fix:
- Define explicit precedence and write target for `/reins on|off` (global vs project).
- Decide if `/reins` should support scope flags (e.g., `--global`, `--project`) or default policy.

---

### 6) Model identifier assumption likely invalid (`"sonnet"`)

Docs use generic model strings like `sonnet` for builder config. Pi APIs/docs are oriented around concrete provider/model IDs (e.g., `claude-sonnet-4-5`).

Impact:
- Model resolution may fail unless custom mapping is implemented.

Required fix:
- Use concrete model IDs in config, or define an explicit alias-resolution layer.

## Medium-Priority Improvements

### 7) Context builder execution details are underspecified for real Pi

The plan says “sub-process via `pi.exec()` + subpi” but does not pin actual command/protocol contract.

Improve by specifying:
1. exact subprocess invocation (`pi --mode json -p --no-session ...` style or equivalent)
2. streaming parse contract for success/failure/timeout
3. cancellation and cleanup behavior
4. structured output schema for context blocks

### 8) Tool-loop circuit-breaker wording uses non-framework API concepts

UX text suggests escalation prompt says to delegate via `pi.exec()` as if model directly calls that. `pi.exec()` is extension API, not an LLM-callable built-in tool.

Improve by:
- Referring to actual LLM-callable delegation tool names.
- Defining escalation as injected system prompt + optional `ctx.ui.notify` based on extension-side counters.

### 9) Transparency requirement conflict across docs

PRD includes transparency user story; UX defers transparency to v2 and makes context injection fully invisible. This is a valid product choice, but currently contradictory.

Improve by:
- Marking US4 explicitly as deferred (v2) in PRD acceptance criteria and MVP scope.

### 10) Claims about “zero impact when disabled” should be test-backed

Architecturally reasonable, but should be validated with tests and instrumentation.

Improve by adding acceptance tests for:
- no prompt modifications when disabled
- no tool blocks when disabled
- command toggling persists/reloads correctly

## Low-Priority / Clarity Improvements

### 11) Allowlist terminology drift (`subpi`, `subagent`, `subagents`)

The docs use multiple variants for delegation mechanisms. Standardize naming and distinguish:
- extension tool name(s)
- subprocess executable (`pi`)
- conceptual agent role names

### 12) Context source claims should map to concrete Pi APIs

Docs mention “memory, docs, past conversations.” Clarify exactly what “memory” means in Pi terms:
- session entries via `ctx.sessionManager`
- files in repo
- extension custom entries
- prompt/skill resources

### 13) Timeouts and partial-result semantics need deterministic contract

Current wording mixes partial/live and stale-cache fallback. Define a deterministic order:
1. live complete
2. live partial (if stream parser has data)
3. stale cache
4. none

## Recommended Architecture Corrections (Concrete)

1. **Delegation primitive**
- Choose one:
  - Depend on installed `subagent` extension tool (document dependency), or
  - Bundle/register a Reins-owned delegation tool.

2. **Tool policy**
- Use real runtime tool names from `pi.getAllTools()`.
- Maintain a configurable allowlist of actual tool names.
- Block all others in `tool_call` with explicit reason.

3. **Commands**
- Implement `pi.registerCommand(... { handler })` only.
- Define argument grammar for `/reins` and `/prework`.

4. **Scope-aware settings**
- Decide if toggle is global, project, or both with precedence.
- Persist state in settings, not in session entries.

5. **Main/sub-agent boundary**
- Remove unsupported `ctx.depth/parentSessionId` assumptions.
- If needed, enforce boundary via subprocess architecture rather than in-process context fields.

6. **Builder model config**
- Require explicit provider/model ID (e.g., `anthropic/claude-sonnet-4-5` pattern or equivalent internal representation).

## Suggested Acceptance Tests (Must Add)

1. `/reins on` persists and survives restart.
2. `/reins off` restores unrestricted tool execution.
3. When enabled, blocked tool calls return deterministic reason.
4. Delegation tool remains callable while restricted.
5. `before_agent_start` injection appears in effective system prompt only when enabled.
6. Builder timeout path still allows turn to proceed.
7. Builder failure path (including subprocess error) still allows turn to proceed.
8. `/prework` injects next-turn-only context and then clears.
9. Scope behavior works per chosen policy (global/project precedence).

## Source Anchors Used

- Pi extension API types/events/command contract/tool events:
  - `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- Tool wrapping/block behavior:
  - `~/projects/pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts`
- `before_agent_start` execution/await behavior:
  - `~/projects/pi-mono/packages/coding-agent/src/core/agent-session.ts`
  - `~/projects/pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- Built-in tool registry:
  - `~/projects/pi-mono/packages/coding-agent/src/core/tools/index.ts`
- Extension docs (commands/events/exec/settings):
  - `~/projects/pi-mono/packages/coding-agent/docs/extensions.md`
  - `~/projects/pi-mono/packages/coding-agent/docs/settings.md`
- Subagent reference implementation:
  - `~/projects/pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts`
  - `~/projects/pi-mono/packages/coding-agent/examples/extensions/subagent/README.md`

## Final Assessment

The current Reins plan is promising but requires a **framework-reality rewrite** in its core delegation/tool policy sections before implementation. Once the tool model, command contract, settings scope, and main/sub-agent boundary are corrected to actual Pi behavior, this can become a strong and buildable v1.
