# Reins Plan Validation Feedback (Against `pi-mono` Reality)

**Date:** 2026-03-04  
**Reviewer:** Codex  
**Scope Reviewed:**
- `docs/PRD.md`
- `docs/ARCH.md`
- `docs/UX-SPEC.md`
- Actual framework implementation in `~/projects/pi-mono`

## TL;DR

The concept is strong, but the current plan is **not implementation-ready**. Core assumptions around sub-agent boundary detection and timeout/partial behavior are incorrect or underspecified against current `pi-coding-agent` APIs.

**Overall score: 5.5 / 10**
- Product direction: **8/10**
- API/framework correctness: **5/10**
- Implementation readiness: **4/10**

## Method Used

Validated every major technical claim against the current source of truth in `pi-mono`:
- Extension types and contracts: `packages/coding-agent/src/core/extensions/types.ts`
- Extension runtime behavior: `packages/coding-agent/src/core/extensions/runner.ts`, `wrapper.ts`, `loader.ts`
- Tool defaults and built-ins: `packages/coding-agent/src/core/tools/index.ts`, `core/sdk.ts`
- Settings model: `packages/coding-agent/docs/settings.md`, `core/settings-manager.ts`
- Exec API limitations: `packages/coding-agent/src/core/exec.ts`
- Subagent reference behavior: `packages/coding-agent/examples/extensions/subagent/index.ts`

## What Is Correct

1. Using extension hooks for enforcement is the right architecture.
- `before_agent_start` exists and can replace/chain `systemPrompt`.
- `tool_call` exists and supports blocking via `{ block: true, reason }`.
- `registerTool` and `registerCommand` behave as expected.

2. Two-scope settings model is correct.
- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`
- Project overrides global.

3. Delegation as an extension-registered tool is correct.
- Pi has no built-in delegation primitive.

## Critical Gaps and Corrections

## 1) Sub-agent bypass strategy is not implementable as written

### Problem
`ARCH.md` assumes `pi.exec()` can pass custom environment variables (e.g. `PI_SUBAGENT=1`) to child `pi` processes and that hooks can key off those variables.

### Reality
`ExecOptions` supports only:
- `signal`
- `timeout`
- `cwd`

No `env` support in current API (`core/exec.ts`, `extensions/types.ts`).

### Why this matters
Your `isMainAgent()` strategy is a core guardrail in both `tool_call` and `before_agent_start`. Without reliable context separation, either:
- sub-agents get accidentally cuffed, or
- main agent escapes constraints under edge conditions.

### Required improvement
Pick one explicit strategy and document it:
1. **Process-level config isolation**: spawn sub-agent in working dir/settings scope where Reins is disabled.
2. **Argument-level protocol**: pass a structured marker in prompt and enforce by extension state (more fragile).
3. **Custom sub-agent wrapper extension path**: invoke `pi` with explicit extension set that excludes Reins.

Do not rely on undocumented env vars unless you add a tested shim outside `pi.exec`.

## 2) Main-vs-sub detection is speculative

### Problem
Plan claims `SUBPI_SESSION_NAME` / `PI_SUBAGENT` are valid practical signals.

### Reality
They are not part of `ExtensionContext` or official extension event contracts. The referenced behavior is from custom/example flow, not framework guarantees.

### Required improvement
- Replace heuristic claims with an explicit, testable control plane.
- Add acceptance test: “main agent blocked, delegated child unrestricted” in CI.

## 3) Timeout and partial-context behavior is overstated/inconsistent

### Problem
Docs promise on-timeout partial context injection and/or stale cache fallback.

### Reality
Shown implementation uses `Promise.race` around a single subprocess call and returns timeout result. That does not provide streaming partial output from `pi.exec` result payload, and can leave the child still running if not explicitly canceled.

### Required improvement
- Define cancellation semantics clearly using `AbortSignal` and verify child termination behavior.
- Split outcomes into concrete states:
  - Success (full)
  - Timeout with canceled child + stale cache fallback
  - Timeout with no cache
  - Failure (non-zero exit)
- Remove “partial” claims unless you implement actual streaming parser pipeline from child process stdout.

## 4) Model IDs in docs are partly stale/wrong

### Problem
Examples include `claude-haiku-4-20250414`.

### Reality
Current registry includes `claude-haiku-4-5` and `claude-haiku-4-5-20251001` (plus provider-specific IDs). The documented ID likely won’t resolve.

### Required improvement
- Use model examples that exist in current registry.
- Add note: model IDs are provider-specific and version-sensitive.

## 5) “Memory/past turns” claim is too broad for shown builder flow

### Problem
Docs say builder searches memory/past turns.

### Reality
Builder subprocess examples use `--no-session`; it won’t automatically have prior conversation state unless explicitly provided or read from files.

### Required improvement
- Narrow claims to file-based context discovery by default.
- If session memory is required, specify exactly how it is supplied.

## 6) Built-in tools wording should distinguish “available” vs “default active”

### Problem
Docs present built-ins as flat always-on set.

### Reality
Registry has 7 built-ins (`read,bash,edit,write,grep,find,ls`), but default active tools are `read,bash,edit,write` unless configured otherwise.

### Required improvement
- Update wording throughout docs to avoid ambiguity.

## 7) `/reins status` and UX telemetry are underdefined for persistence boundaries

### Problem
UX spec shows rich status (last run, token count, cache age, block count), but architecture does not define durable schema for these metrics.

### Required improvement
- Define state model explicitly:
  - Session-only metrics in memory
  - Persisted config in settings
  - Optional persisted telemetry (if any)
- Define behavior across restart and `/reload`.

## 8) Command behavior in non-UI modes needs explicit policy

### Problem
UX assumes notifications and interactive messaging semantics but ignores print/json/rpc mode constraints.

### Reality
Extension UI APIs degrade to no-op in no-UI contexts (`runner.ts` no-op UI context).

### Required improvement
- Specify fallback outputs for non-interactive modes.
- Make `/reins` commands return deterministic textual content even without UI notifications.

## 9) Recursive risk section is optimistic

### Problem
Docs assert “no risk of recursion” based on env marker approach.

### Reality
Without reliable marker propagation, recursion and accidental self-cuffing remain plausible.

### Required improvement
- Add hard recursion guards:
  - max delegation depth
  - maximum delegated subprocesses per turn
  - explicit circuit-breaker failure mode surfaced to user

## 10) Testing strategy is insufficiently concrete

### Problem
Plans are detailed but missing executable verification matrix tied to framework behaviors.

### Required improvement
Add mandatory tests:
1. `tool_call` blocking for all non-allowlisted tools.
2. `before_agent_start` prompt chaining with multiple extensions.
3. `/reins on/off/status` in interactive and non-UI modes.
4. Subprocess timeout cancellation path.
5. Cache fallback correctness.
6. Ensure delegated subprocess is unrestricted while main stays restricted.
7. Race/parallel safety: multiple delegated calls in one turn.

## Doc-by-Doc Improvement Requests

## `docs/PRD.md`

1. Replace resolved statement for OQ1 with caveat that sub-agent boundary is unresolved in current design.
2. Downgrade “partial results on timeout” from guaranteed behavior to conditional behavior pending streaming implementation.
3. Clarify that builder context source is codebase/files by default; session memory is optional and requires explicit mechanism.
4. Update model examples to known-valid IDs.
5. Add success metric for “false restriction incidents” (main/sub misclassification).

## `docs/ARCH.md`

1. Remove or rewrite `PI_SUBAGENT`/`SUBPI_SESSION_NAME` reliance unless accompanied by real propagation implementation.
2. Update all `pi.exec` examples to reflect actual `ExecOptions` and constraints.
3. Redesign timeout section with explicit cancellation and child-process lifecycle handling.
4. Add an ADR specifically for sub-agent identity strategy.
5. Add an ADR for non-UI mode behavior.
6. Separate “framework facts” from “proposed implementation” in each section.
7. Add a conformance test matrix appendix.

## `docs/UX-SPEC.md`

1. Tie all user-visible status lines to defined underlying state fields.
2. Clarify behavior in print/json/rpc modes where UI notify is unavailable.
3. Rework circuit-breaker flow so it does not depend on assumptions about invisible interventions unless technically guaranteed.
4. Ensure `/prework` next-turn injection semantics are fully specified when multiple queued next-turn messages exist.
5. Clarify if `/reins off` during streaming affects only future calls or can alter current loop behavior.

## Suggested Revised Architecture (Pragmatic)

1. Keep dual-layer enforcement (`before_agent_start` soft + `tool_call` hard).
2. Implement delegation tool via subprocess, but isolate child behavior by **config scope**, not env vars.
3. Builder timeout behavior:
- Spawn subprocess with cancelable signal.
- On timeout: cancel process, then use stale cache if available.
- No “partial” claim until true streaming parse exists.
4. Store only config in settings; keep runtime telemetry in memory for v1.
5. Add hard safeguards:
- max delegate calls per turn
- max depth
- explicit fail-fast reason surfaced to model and user

## Revised Score After Fixing Top Issues

If items 1–4 in “Critical Gaps” are addressed, plan quality would move to roughly **8/10** and be build-ready.

## Session/Process Notes

- `bd ready` currently fails due to invalid `.beads/issues.jsonl` and could not be used for issue selection/state updates in this session.
- Command output observed: `Error: failed to open database: bootstrap failed: no valid issues found in JSONL file /Users/jakemc/projects/reins/.beads/issues.jsonl`.
