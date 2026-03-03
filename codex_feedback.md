# Reins Docs Reality Check (Pi Framework Validation)

**Scope reviewed:**
- [PRD](./docs/PRD.md)
- [ARCH](./docs/ARCH.md)
- [UX-SPEC](./docs/UX-SPEC.md)

**Validation baseline:**
- `~/projects/pi-mono/packages/coding-agent/docs/extensions.md`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `~/projects/pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts`
- `~/projects/pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/loader.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/settings-manager.ts`

---

## Executive Rating

**Overall plan quality: 5.5 / 10**

The direction is promising and uses the right extension surfaces (`before_agent_start`, `tool_call`, custom command/tool registration). However, too many implementation details currently conflict with actual Pi framework behavior and type contracts. In the current state, implementation would likely incur avoidable churn and breakages.

---

## What Is Strong (Keep)

1. **Core control points are correct**
- Using `before_agent_start` for pre-turn prompt/system shaping and `tool_call` for hard guardrails is the right foundation.

2. **Block return shape is correct**
- `{ block: true, reason: "..." }` is the correct `tool_call` result shape.

3. **Extension framing is mostly correct**
- Pi extension model, event subscription, tool registration, command registration are correctly centered.

4. **Default-off + graceful-failure product stance is good**
- This is operationally sane and minimizes blast radius.

5. **Visibility/latency tradeoff is explicitly acknowledged**
- The docs are candid that context building adds turn latency.

---

## Critical Gaps and Corrections

### 1) Sub-agent detection strategy is not grounded in Pi runtime

**Current docs claim:** use `process.env.SUBPI_SESSION_NAME` and assume `subpi` sets it.

**Observed reality:**
- No evidence in `pi-mono` of a framework-level `SUBPI_SESSION_NAME` contract.
- Official subagent extension spawns `pi` subprocesses directly.

**Why this matters:**
- If this heuristic is wrong, you may accidentally restrict subagents (breaking delegation) or fail to restrict the top-level agent.

**Fix:**
- Mark top-level-vs-subagent detection as **unresolved implementation risk**, not “accepted ADR”.
- Prefer explicit process-level contracts your own extension controls (e.g., set a dedicated env var on spawned subprocess and gate on that), then verify in end-to-end tests.

---

### 2) Tool names/capabilities mismatch in context builder design

**Current docs claim:** builder gets `Read`, `Glob`, `Grep`, `Ls`.

**Observed reality:**
- Built-ins are lowercase: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- No built-in `glob` tool in the extension type definitions.

**Why this matters:**
- Wrong tool names and nonexistent tool references will fail at runtime or create wrong assumptions for spawn restrictions.

**Fix:**
- Replace all capitalized tool names with actual Pi names.
- Replace `Glob` with `find` and/or `grep` patterns.
- Update all examples and allowlists consistently.

---

### 3) Invalid API usage appears in implementation snippets

#### 3a) `ctx.ui.notify(..., "warn")`
- Pi expects: `"info" | "warning" | "error"`.
- `"warn"` is invalid.

#### 3b) `pi.sendMessage({ type: "text", text: ... })`
- Pi expects custom-message shape with `customType`, `content`, `display`, `details`.

**Why this matters:**
- Snippets are currently misleading and not copy/paste-safe.

**Fix:**
- Make every code snippet type-correct against `extensions/types.ts`.
- Add one “blessed minimal implementation” section that compiles as-is.

---

### 4) `appendEntry` is misused for global first-run onboarding state

**Current docs claim:** persist “first activation shown” via `pi.appendEntry`.

**Observed reality:**
- `appendEntry` persists in session history, not a global settings flag across all sessions/projects.

**Fix:**
- If global one-time onboarding is required, persist in settings file (or scoped settings key), not session entry stream.

---

### 5) Prompt-chaining language is inaccurate

**Current docs imply:** Pi concatenates prompt injections.

**Observed reality:**
- `before_agent_start` handlers run in sequence; each receives current `systemPrompt` and can replace it. Chaining is cooperative, not automatic concatenation.

**Fix:**
- Document exact semantics: each extension must append to `event.systemPrompt` when desired.

---

### 6) Config key inconsistency (`contextModel` vs `model`)

**Current docs conflict:**
- PRD mentions `reins.contextModel`.
- ARCH and snippets use `reins.model`.

**Fix:**
- Standardize now on one key (`reins.model` is simpler) and update all docs/examples.

---

### 7) `subpi` is treated as quasi-required despite no Pi API contract

**Observed reality:**
- Pi extension API provides `pi.exec(command, args, options)`, not `subpi` APIs.
- Official example uses `spawn("pi", ...)` for subagents.

**Fix:**
- Reframe `subpi` as optional ecosystem tool.
- Make canonical path: spawn `pi` with JSON mode from extension logic.
- If you keep `subpi` support, clearly define fallback order and detection.

---

### 8) Tool-block UX assumptions are too optimistic

**Current UX claim:** user won’t see blocked attempts.

**Observed runtime path:**
- Blocked tool calls are converted into execution errors with reason messages that can surface through normal message flow.

**Fix:**
- Reword UX to “typically internal, but may surface indirectly depending on model behavior and output path.”

---

## Additional Design Improvements Needed

### 9) Move from speculative pseudo-code to “compilable baseline”

Create one minimal vertical slice that is guaranteed type-correct:
- `/reins on|off|status`
- `before_agent_start` adds one deterministic line
- `tool_call` allowlists one known tool (`reins_delegate`)
- `reins_delegate` shells to `pi` subprocess

Then layer context builder complexity afterward.

---

### 10) Clarify whether restrictions should apply to custom tools from other extensions

Current model says “only delegation tool allowed.”

Potential issue:
- Other installed extensions may contribute critical safe tools.

Recommendation:
- Explicitly define policy mode:
  - strict singleton (`reins_delegate` only), or
  - bounded allowlist that can include third-party tools.

---

### 11) Tighten status telemetry definitions

UX spec status output includes:
- “Last context build Xs ago”
- token counts
- block counts

These require explicit state tracking and timestamps.

Recommendation:
- Define exact data schema and reset semantics:
  - reset per turn / per session / persisted?
  - source of truth for token counts (builder output vs estimated)

---

### 12) Replace hardcoded token math heuristic with explicit limits strategy

Current doc suggests rough chars/token truncation.

Recommendation:
- Keep heuristic as fallback but specify explicit safety behavior:
  - max chars cap + max sections + file excerpt limits.
- Prefer deterministic structured output from builder to reduce post-truncation risk.

---

### 13) Reduce architecture contradiction around tool visibility

Docs currently say “visible but blocked is desired,” while also acknowledging `setActiveTools` could hide tools.

Recommendation:
- Choose one canonical mode for v1 and justify:
  - visibility for teaching the model constraints vs
  - hidden tools for reduced retries and token waste.
- Add a config switch only if needed.

---

### 14) Add explicit test matrix before implementation starts

Must-have tests:
- Reins off: no behavior change.
- Reins on: blocked built-ins fail with reason.
- Delegation tool still callable.
- Context builder timeout path.
- Context builder hard failure path.
- Command toggles persist via settings.
- Multi-extension interaction ordering.
- Non-interactive modes (`json`, `print`, `rpc`) where UI methods may no-op.

---

## Doc-Specific Feedback

### PRD

Improve:
1. Unify config key naming (`model` vs `contextModel`).
2. Replace unverified claims about subagent environment markers with explicit “to-be-validated” status.
3. Add one non-goal: “Reins does not guarantee invisible failure of blocked tool calls.”
4. Add measurable v1 success criterion tied to implementation reality (e.g., block rate trend, delegation success rate).

### ARCH

Improve:
1. Remove/soften accepted ADRs that depend on unverified contracts (`SUBPI_SESSION_NAME`).
2. Replace incorrect tool list/names with actual Pi built-ins.
3. Fix all non-type-safe snippets.
4. Add one reference implementation path based on existing `subagent` example.
5. Clarify system prompt chaining semantics.
6. Clarify config persistence API strategy (use settings manager style and atomic writes).

### UX-SPEC

Improve:
1. Correct notification level names (`warning`, not `warn`).
2. Reword hidden-block behavior to match runtime truth.
3. Adjust first-run onboarding persistence approach.
4. Explicitly describe behavior in no-UI contexts (status command behavior in rpc/print/json).
5. Define exact semantics for counters and timestamps shown in `/reins status`.

---

## Recommended Rewrite Priorities (Order)

1. **Correctness pass (must do first)**
- API shapes, tool names, config key consistency, invalid snippet fixes.

2. **Runtime-contract pass**
- Replace speculative `subpi`/env assumptions with verified subprocess strategy.

3. **Behavior-spec pass**
- Finalize visibility policy, status schema, error-surface expectations.

4. **Implementation-ready pass**
- Add compile-checked minimal extension skeleton and concrete test plan.

---

## Suggested Updated Rating After Fixes

If the above changes are made before coding begins, this plan should move to **8.0–8.5 / 10** and be implementation-ready with materially lower risk.
