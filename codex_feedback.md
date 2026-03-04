# Reins Plan Validation Feedback (Against Observed `pi-mono` Reality)

**Date:** 2026-03-04  
**Reviewer:** Codex  
**Scope Reviewed:**
- `docs/PRD.md`
- `docs/ARCH.md`
- `docs/UX-SPEC.md`
- Pi framework source in `~/projects/pi-mono` (`packages/coding-agent`)

## Overall Rating

**6.5 / 10**

- **Product concept:** 8.5/10
- **Framework/API correctness:** 6/10
- **Implementation readiness:** 5/10

The core idea is strong and maps well to Pi’s extension model. The plan is not yet implementation-ready because several key claims are incorrect, internally inconsistent, or rely on behavior not guaranteed by the framework.

## Validation Method

Validated claims against these primary sources in `pi-mono`:
- Extension contracts and event/result types: `src/core/extensions/types.ts`
- Event orchestration and chaining semantics: `src/core/extensions/runner.ts`
- Tool block behavior path: `src/core/extensions/wrapper.ts`
- Extension loading/discovery behavior: `src/core/extensions/loader.ts`
- Mode behavior (interactive/print/rpc): `src/modes/*`
- Slash command execution path: `src/core/agent-session.ts`
- Built-in tool defaults and all-tools registry: `src/core/tools/index.ts`
- Extension-side shell execution API: `src/core/exec.ts`
- Official subagent example behavior: `examples/extensions/subagent/index.ts`

## What Is Correct

1. **Dual-layer enforcement architecture is valid.**
- `before_agent_start` can modify `systemPrompt`.
- `tool_call` can block with `{ block: true, reason }`.

2. **Settings two-scope model is valid.**
- Global `~/.pi/agent/settings.json`
- Project `.pi/settings.json`
- Project overrides global.

3. **Delegation via extension-provided tool is valid.**
- Pi has no built-in delegation tool.

4. **`before_agent_start` timing claim is valid.**
- It runs once per user prompt before loop start.

5. **Tool block reason surfacing to the model is directionally correct.**
- Blocked call throws and becomes an error path visible in tool-result flow.

## Findings (Ordered by Severity)

## Critical

1. **Non-interactive command availability is misdocumented.**
- Docs claim `/reins` is not available in JSON/print mode.
- In reality, extension commands are executed in `AgentSession.prompt()` before normal prompting, and print mode binds extensions.
- Impact: runtime behavior and operator expectations diverge.
- Evidence:
  - `docs/UX-SPEC.md` lines 253-254
  - `docs/ARCH.md` lines 1143-1149
  - `pi-mono/src/core/agent-session.ts` lines 805-812
  - `pi-mono/src/modes/print-mode.ts` lines 39-73

2. **`/prework` sample code is type-invalid as written.**
- Uses `display: "ephemeral"` in `pi.sendMessage` payload.
- Framework `CustomMessage.display` is `boolean`, not string enum.
- Impact: code won’t compile against actual types.
- Evidence:
  - `docs/ARCH.md` line 809
  - `pi-mono/src/core/extensions/types.ts` lines 1012-1015
  - `pi-mono/src/core/messages.ts` lines 46-51

## High

3. **Main-agent detection strategy is unresolved and brittle.**
- Plan depends on `REINS_SUBAGENT` marker to avoid cuffing child agents.
- This is not a Pi framework contract and won’t cover subagents created by other mechanisms.
- Impact: false restrictions or bypasses.
- Evidence:
  - `docs/ARCH.md` lines 163-172, 1093-1099
  - No framework-level subagent identity in `ExtensionContext` (`types.ts`)

4. **Official subagent reference does not validate the env-marker approach.**
- Pi’s own subagent example spawns `pi` via `spawn()` but does not set `REINS_SUBAGENT`-style env tags.
- Impact: plan may incorrectly assume ecosystem-wide compatibility.
- Evidence:
  - `pi-mono/examples/extensions/subagent/index.ts` lines 247-249, 287

5. **Skeleton code introduces global process-state hazard.**
- Skeleton sets `process.env.REINS_SUBAGENT = "1"` before `pi.exec()` and never restores it.
- That mutates parent process env and can disable restrictions in subsequent main-agent execution.
- Impact: security/control regression.
- Evidence:
  - `docs/ARCH.md` lines 1093-1099

## Medium

6. **`pi.exec` vs `spawn` architecture is internally inconsistent.**
- Some sections present `pi.exec` as canonical; others require `spawn` because env cannot be passed via `pi.exec`.
- Impact: ambiguity in implementation direction.
- Evidence:
  - `docs/ARCH.md` line 8
  - `docs/ARCH.md` lines 364-372

7. **Timeout/partial behavior is overpromised.**
- Docs promise partial context injection on timeout; provided approach (`Promise.race`) does not inherently yield partial streamed output.
- Impact: expected behavior likely unattainable without additional streaming/IPC implementation.
- Evidence:
  - `docs/PRD.md` lines 98-100
  - `docs/ARCH.md` lines 418-423

8. **Default tools are conflated with all available tools.**
- Docs repeatedly frame Pi built-ins as a default active set of 7.
- Actual default active tools are 4 (`read`, `bash`, `edit`, `write`), while 7 are available in the registry.
- Impact: inaccurate assumptions in enforcement/testing narrative.
- Evidence:
  - `docs/PRD.md` built-in tools section
  - `pi-mono/src/core/tools/index.ts` lines 82-95
  - `pi-mono/README.md` line 69

9. **Extension discovery language is imprecise.**
- “No manifest file” is true in one sense, but Pi does support `package.json` `pi.extensions` for discovery.
- Impact: can mislead implementers packaging the extension.
- Evidence:
  - `docs/ARCH.md` line 42
  - `pi-mono/src/core/extensions/loader.ts` lines 403-435

10. **UX/ARCH inconsistency for `/prework` output style.**
- UX says one-line confirmation only.
- ARCH sample queues a markdown payload (`📋 **Pre-gathered context**`) into next turn.
- Impact: spec conflict.
- Evidence:
  - `docs/UX-SPEC.md` lines 216-217
  - `docs/ARCH.md` lines 804-812

11. **Model IDs in examples are likely stale.**
- Plan hardcodes dated model IDs in many places. Pi model registry is provider/version dependent and changes over time.
- Impact: brittle defaults and support noise.
- Evidence:
  - Multiple references across PRD/ARCH/UX

## Low

12. **Onboarding persistence rationale around `appendEntry` should be clarified, not absolute.**
- Docs say `appendEntry` is session-scoped and not persistent across sessions.
- More precise: it persists in the current session file and survives restart, but is not global cross-session state.
- Impact: conceptual clarity.
- Evidence:
  - `docs/ARCH.md` lines 749-750
  - `pi-mono/src/core/extensions/types.ts` line 1026
  - `pi-mono/src/core/session-manager.ts` lines 886-896

13. **Circuit-breaker messaging in non-UI contexts needs explicit fallback semantics.**
- Current text mostly implies notify/no-op behavior; should define exact logging or model-facing fallback.
- Impact: operational visibility gaps in automation.

## Internal Spec Contradictions (Docs vs Docs)

1. `/prework` should be one-line/no dump (UX) vs markdown payload injection sample (ARCH).
2. `pi.exec` is presented as main subprocess mechanism in some sections, while other sections explicitly require `spawn` for env propagation.
3. Subagent identity treatment oscillates between “resolved” behavior and explicit unresolved risk.

## Required Corrections Before Implementation

1. **Fix non-interactive command claims.**
- Update UX/ARCH: extension slash commands can run in print/json modes when prompt text starts with `/`.
- Clarify what “not available” means (UI discoverability vs executable parser behavior).

2. **Fix type-invalid sample code.**
- Replace `display: "ephemeral"` with `display: false` (or `true`) in all samples.

3. **Replace brittle main/subagent identity assumption with an explicit contract.**
- Recommended options:
  - Restrict only when a Reins-managed “main turn” state flag is present.
  - Or run delegated child with an explicit extension set excluding Reins.
  - Or adopt “allowlist on main only by active session metadata” if available.
- Document fallback behavior when identity is unknown.

4. **Normalize on one subprocess strategy.**
- If env propagation is required, use `spawn` as canonical.
- If `pi.exec` is kept, remove env-marker dependence and redesign identity strategy.

5. **De-scope partial timeout claim unless implemented.**
- Keep: success / timeout with stale cache / timeout without cache / failure.
- Drop “partial injection” guarantee unless there is a real streaming parser.

6. **Correct tools documentation.**
- Distinguish:
  - Built-ins available: `read,bash,edit,write,grep,find,ls`
  - Default active: `read,bash,edit,write`

7. **Make model config robust.**
- Avoid hardcoding provider-specific dated IDs as defaults without fallback.
- Add validation and startup warning if configured model unavailable.

8. **Resolve `/prework` UX contract.**
- Decide whether prework result is invisible queued context or explicit visible message.
- Ensure ARCH and UX match exactly.

## Recommended Additional Tests

1. `tool_call` block correctness for built-ins and extension tools.
2. `before_agent_start` chaining with multiple extensions.
3. `/reins` behavior in interactive, rpc, print, and json modes.
4. Delegation child-agent behavior under each identity strategy.
5. Timeout cancellation and stale-cache fallback behavior.
6. Regression test: no persistent env mutation after delegate call.
7. `/prework` next-turn injection semantics with multiple queued custom messages.

## Suggested Updated Score After Fixes

If Critical + High items are fixed and Medium items 6-8 are addressed:

**Expected plan score: 8.5 / 10**

At that point, the design should be implementation-ready with manageable residual risk.
