# Reins Plan Validation Feedback (Against Actual PI Framework)

Date: 2026-03-04  
Reviewer: Codex (validated against local `~/projects/pi-mono` + PI docs/source)

## Executive Verdict

The plan is directionally strong and mostly aligned with the real PI extension framework, but it has two implementation-critical inconsistencies that must be fixed before build-out:

1. **Context-builder process spawning is described two different ways, and one is not viable** (`pi.exec()` path cannot set child-only env vars).
2. **Timeout + stale-cache behavior is specified but not actually implemented by the pseudocode flow shown.**

Overall quality score: **7.5/10**.

## What Is Correct (Validated)

### Extension API and lifecycle usage

The docs correctly use PI extension primitives:
- `pi.registerTool()`
- `pi.registerCommand()`
- `pi.on("before_agent_start" | "tool_call" | "tool_result" | "turn_start" ... )`
- `pi.sendMessage()` with `deliverAs`
- `pi.getAllTools()` / `pi.getActiveTools()`

Validation source:
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/docs/extensions.md`

### Tool-call hard block return shape

Using:

```ts
return { block: true, reason: "..." }
```

is correct for `tool_call` handlers (`ToolCallEventResult`).

Validation source:
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/wrapper.ts`

### before_agent_start semantics

The docs are correct that `before_agent_start` runs after user input and before the agent loop, and that system prompt modifications chain across handlers.

Validation source:
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/docs/extensions.md`

### Built-in tool inventory claims

These claims are accurate:
- Default active tools: `read`, `bash`, `edit`, `write`
- Additional registry tools: `grep`, `find`, `ls`

Validation source:
- `packages/coding-agent/src/core/tools/index.ts`

### Extension discovery + package manifest

`pi.extensions` in extension package manifest and extension discovery conventions are correctly represented.

Validation source:
- `packages/coding-agent/src/core/extensions/loader.ts`
- `packages/coding-agent/docs/extensions.md`

### Settings two-scope model

Correctly stated:
- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`
- Project overrides global

Validation source:
- `packages/coding-agent/docs/settings.md`

### `/prework` next-turn injection mechanism

Using `pi.sendMessage(..., { deliverAs: "nextTurn" })` is real and aligns with runtime behavior.

Validation source:
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/agent-session.ts`

### Non-interactive command behavior

The docs’ core claim that extension commands execute through the prompt pipeline in JSON/print/RPC modes is valid.

Validation source:
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/print-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`

## Critical Issues to Fix

### 1) Spawn strategy contradiction (`pi.exec()` vs `child_process.spawn()`)

#### Current doc conflict
- PRD says context builder can spawn via `pi.exec()`.
- ARCH says `spawn()` is required to set `REINS_SUBAGENT=1` in child env.

#### Reality
`pi.exec()` **does not support `env`** overrides. `ExecOptions` only has:
- `signal`
- `timeout`
- `cwd`

Therefore, the `pi.exec()` path is incompatible with the plan’s own main/sub-agent detection strategy.

#### Required correction
Make all docs unambiguous:
- **Reins must use `child_process.spawn()`** for both delegate tool and context builder subprocesses if child env markers are required.
- Remove language implying `pi.exec()` is a viable equivalent for this design.

### 2) Timeout + stale-cache logic mismatch

#### Current spec intent
- On timeout, prefer stale cache fallback if available.

#### Current pseudocode behavior
- `Promise.race([buildPromise, timeoutPromise])` timeout resolves as partial result.
- Cache fallback is shown in `catch`, which won’t execute for timeout-resolution path.

#### Result
Documented fallback behavior and shown implementation are inconsistent.

#### Required correction
Choose one consistent algorithm and reflect it everywhere. Recommended:
- Timeout path explicitly checks cache before returning no-context.
- Reserve `catch` for hard process failure.

Example behavior contract:
1. Success -> use fresh context, update cache.
2. Timeout -> if partial context available use partial; else if stale cache exists use stale; else none.
3. Error -> if stale cache exists use stale; else none.

## High-Impact Consistency Gaps

### 3) Global toggle writing vs project override precedence

`/reins on|off` writing global settings is fine, but project-level `reins.enabled` can override and make global toggles look ineffective in a repo.

Improve UX contract:
- `/reins status` should report both effective value and source scope (global/project).
- `/reins on` should warn if overridden by project config.

### 4) Main-agent detection guarantee is overstated in places

Some sections state env marker strategy “ensures” only main agent is restricted; other sections correctly call out limitation with external subagent mechanisms.

Unify language to:
- “Best-effort for Reins-spawned subprocesses; no framework-level parent/depth API currently exists.”

### 5) Circuit breaker + no-UI behavior needs one canonical implementation path

The UX spec mixes:
- `ctx.ui.notify` escalation
- fallback steer/system injection when `ctx.hasUI === false`

This is workable, but should be codified in ARCH as one deterministic decision tree, not scattered narrative.

## Medium Gaps / Clarifications Needed

### 6) Config I/O robustness

Planned JSON read/write behavior should include:
- Atomic write strategy (temp file + rename)
- Recovery behavior for invalid JSON
- File permission/ownership edge-case handling

### 7) Token accounting language

The docs use `chars/4` estimate. Good as heuristic, but should avoid presenting these as true token counts in status language.

### 8) Multi-extension interaction risk

If other extensions modify system prompt or block tools, current docs don’t define precedence/diagnostics strategy. Should include:
- deterministic ordering assumptions
- debug trace mode for chained `before_agent_start` and `tool_call` decisions

### 9) Recursion safety explanation should match exact execution paths

Current recursion claims are plausible, but should explicitly state which process invocations load extensions and when `REINS_SUBAGENT` gate applies.

## Document-by-Document Improvement Checklist

## `docs/PRD.md`

- Remove `pi.exec()` as an equivalent subprocess mechanism when env tagging is required.
- Tighten acceptance criteria for timeout/cache behavior to match real implementation path.
- Add explicit “effective config source” requirement for `/reins status`.

## `docs/ARCH.md`

- Replace any residual ambiguous language about subprocess spawning with one canonical approach.
- Fix timeout/cache pseudocode mismatch.
- Convert `isMainAgent()` section from “guarantee” framing to “bounded heuristic with known blind spots”.
- Add JSON settings write safety and corruption handling section.
- Add explicit diagnostics format for blocked tool loops and extension-chain interactions.

## `docs/UX-SPEC.md`

- Ensure status output includes scope source (`global`/`project`) and override warning.
- Keep no-UI behavior deterministic and mirrored in architecture docs.
- Clarify that block reasons may surface to the model and occasionally user-visible text.

## Proposed Overall Revised Rating Rubric

- API correctness: **9/10**
- Architecture feasibility: **7/10**
- Operational reliability: **6.5/10**
- Consistency across PRD/ARCH/UX docs: **7/10**
- Implementation readiness: **7/10**

Combined: **7.5/10**.

## Must-Fix Before Implementation Starts

1. Resolve spawn strategy contradiction (`pi.exec` vs `spawn` with env).
2. Correct timeout/cache control-flow mismatch.
3. Define effective config source reporting and override UX in `/reins status`.
4. Normalize `isMainAgent` guarantees to realistic bounded claims.

## Nice-to-Fix Before Beta

1. Add robust settings write strategy and recovery semantics.
2. Add structured debug telemetry for extension interaction chain.
3. Add explicit non-UI escalation behavior matrix.
4. Add integration test matrix covering:
   - interactive / print / rpc modes
   - timeout + stale cache branches
   - block-loop circuit-breaker paths
   - project override precedence

## Validation Artifacts Used

Primary local source of truth checked:
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/exec.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/tools/index.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/loader.ts`
- `~/projects/pi-mono/packages/coding-agent/docs/extensions.md`
- `~/projects/pi-mono/packages/coding-agent/docs/settings.md`
- `~/projects/pi-mono/packages/coding-agent/src/modes/print-mode.ts`
- `~/projects/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
