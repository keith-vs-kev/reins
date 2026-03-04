# Reins Plan Validation (Against Actual Pi Framework)

Date: 2026-03-04  
Reviewer: Codex

## Executive Summary

The plan is strong conceptually and mostly uses the right Pi extension primitives, but it has several implementation-critical mismatches with real framework behavior. The largest issues are non-interactive command UX assumptions, extension-load telemetry assumptions, context-builder input/history assumptions, and type-invalid code snippets in ARCH.

Overall rating: **7.0/10**.

## Scope and Method

Validated all planning docs in this repo:
- `docs/PRD.md`
- `docs/ARCH.md`
- `docs/UX-SPEC.md`

Validated against actual source of truth in `~/projects/pi-mono`:
- extension API types/runtime
- command execution pipeline
- tool wrapping/blocking semantics
- settings manager and extension loader
- print/json/rpc mode behavior
- official `subagent` example extension

## What Is Correct

### Core extension architecture is well aligned

Correctly uses Pi extension surfaces:
- `pi.registerTool()`
- `pi.registerCommand()`
- `pi.on("before_agent_start")`
- `pi.on("tool_call")`
- `pi.on("tool_result")`
- `pi.sendMessage(..., { deliverAs })`

### Tool blocking mechanism is correctly specified

`tool_call` returning `{ block: true, reason }` is correct and actually enforced by wrapper logic.

### before_agent_start chaining claims are correct

System prompt modifications from multiple extensions are chained in order.

### Built-in tool inventory claims are correct

The docs correctly identify:
- default active tools: `read`, `bash`, `edit`, `write`
- additional available tools: `grep`, `find`, `ls`

### Two-scope settings model is correct

Global/project settings paths and merge behavior are correctly described:
- `~/.pi/agent/settings.json`
- `.pi/settings.json`
- project overrides global per key

### `child_process.spawn()` choice is correct for env-tagged subprocesses

Using `spawn()` to set child-only `REINS_SUBAGENT=1` aligns with real framework constraints.

## Critical Mismatches (Must Fix)

### 1) Non-interactive `/reins` UX is overstated

Problem:
- Docs state `/reins` executes in JSON/print mode and imply user-visible status/confirm text.
- In print/json mode, `ctx.hasUI === false`, and `ctx.ui.notify()` is a no-op.

Impact:
- Command handlers may run, but user-facing notify output is absent in print/json mode.
- Planned UX behavior is not achievable as currently documented.

Fix:
- Document command execution and command visibility separately.
- If output must appear in non-interactive modes, use a different path than `ui.notify` (e.g., explicit message injection strategy), and clearly define it.

### 2) `/reins status` “extension load order” relies on non-existent API

Problem:
- UX spec suggests deriving load order via `pi.getAllExtensions()` (or equivalent).
- `ExtensionAPI` does not expose extension-list APIs.

Impact:
- Spec requires telemetry that extension code cannot fetch directly through published API.

Fix:
- Remove this field from required status output, or move it behind framework change.
- If needed, compute indirect diagnostics from known extension-owned state only.

### 3) Context-builder input/history assumptions don’t match runtime flow

Problem:
- Docs repeatedly call builder input the “raw user prompt”.
- In actual flow, `before_agent_start` receives prompt after skill/template expansion.
- Builder subprocess is run with `--no-session`, so it has no session turn history.

Impact:
- Expected relevance behavior may differ from documentation.
- “search past turns/memory” expectations are overstated unless memory is file-based and discoverable via tools.

Fix:
- Update docs to say builder receives effective prompt post-expansion.
- Clarify that session-message history is not available to subprocess with `--no-session`.
- Reframe memory claims to file-based memory only (if present in workspace/agent files).

### 4) Sub-agent “full tool access” claim is too broad

Problem:
- Some sections imply sub-agents will have all built-ins (`read,bash,edit,write,grep,find,ls`).
- Actual default active tool set is 4 tools unless `--tools` is explicitly set.

Impact:
- Test matrix and expected behavior can fail due to incorrect default assumption.

Fix:
- Reword to: “sub-agent has unrestricted policy under Reins, but actual active tools are determined by child pi invocation settings/defaults.”
- If 7 tools are required, specify explicit `--tools read,bash,edit,write,grep,find,ls` in spawned args.

### 5) ARCH “compilable skeleton” is not type-correct as written

Problem:
- Tool execute snippets return `isError` in returned object.
- `registerTool().execute` return type is `AgentToolResult` (`content` + optional `details`), not `isError`.

Impact:
- Readers implementing from spec will produce type errors or incorrect runtime assumptions.

Fix:
- Remove `isError` from tool `execute` return examples.
- Show error return as normal `content` text or throw, consistent with framework patterns.

### 6) Config resolution samples are internally inconsistent on scope usage

Problem:
- Hooks in samples call `getReinsConfig()` without passing `ctx.cwd`.
- Same docs require project overrides to be respected.

Impact:
- Implementations following samples can accidentally ignore project settings in hooks.

Fix:
- Make `getReinsConfig(ctx.cwd)` mandatory in all hook examples.
- Add one explicit note: hook resolution is cwd-sensitive.

## High-Value Improvements (Should Fix)

### 7) Tighten non-interactive behavior specification

Current docs partially acknowledge no-op UI but still include user-facing command copy for these modes.

Improve by defining one explicit matrix:
- interactive: `ui.notify` visible
- rpc: UI events emitted to client
- print/json: `ui.notify` no-op
- and exact fallback behavior (if any) for warnings/statuses

### 8) Resolve spawn-strategy narrative drift everywhere

Most docs correctly standardize on `child_process.spawn()`, but wording still occasionally leaves ambiguity around `pi.exec` viability.

Improve by adding one single canonical statement in PRD/ARCH/UX:
- `pi.exec` is fine for simple command execution,
- but Reins subprocess spawning uses `spawn()` because child env tagging is required.

### 9) Clarify path-resolution behavior for `settings.extensions`

Some examples imply direct absolute paths only. In reality, path resolution supports absolute/`~`/relative via loader rules.

Improve by explicitly documenting relative-path interpretation and recommending absolute paths for reproducibility.

### 10) Normalize claims about “invisible” tool blocks

Docs mostly do this well, but some phrasing still implies user invisibility as default certainty.

Improve by explicitly separating:
- model visibility (yes, sees block error)
- user visibility (usually no in chat, but model may surface it)

### 11) Strengthen test matrix with framework-realistic assertions

Adjust tests to real runtime semantics:
- non-interactive command execution does not imply visible `ui.notify` output
- subprocess default tool set is 4 unless overridden
- builder prompt is post-expansion
- status field set excludes unavailable API data

## Lower-Priority Improvements

### 12) Eliminate unresolved editorial contradictions in ARCH

There are sections that intentionally self-correct midstream (e.g., allowed tools default sentence). Good thought process, but final spec should remove transitional text.

### 13) Make status telemetry fields explicitly optional

Fields like last-build/cache age can be null before first run. Mark output format accordingly.

### 14) Add one normative config schema block

Centralize final config keys with types/defaults and mark any v2 keys clearly.

## Suggested Doc Edits by File

### `docs/PRD.md`
- Replace “raw prompt” wording with “effective prompt as seen by `before_agent_start`.”
- Constrain memory/history claims to what subprocess can actually access.
- Update success criteria to exclude extension-load-order reporting unless framework API exists.

### `docs/ARCH.md`
- Fix all `execute` examples to be type-correct (`AgentToolResult` shape).
- Require `getReinsConfig(ctx.cwd)` in hook examples.
- Adjust sub-agent tool-access wording to default-4-tools reality unless explicit `--tools` is set.
- Remove any API references not in `ExtensionAPI` (notably extension list methods).
- Add one canonical non-interactive output policy section.

### `docs/UX-SPEC.md`
- Update non-interactive command UX to match no-op `ui.notify` reality.
- Remove or re-scope “extension load order” status line.
- Keep explicit note that block errors are model-visible and may be user-referenced.

## Final Rating

- API correctness: 8.5/10
- Architecture feasibility: 8/10
- Runtime fidelity to actual Pi behavior: 5.5/10
- Internal consistency across docs: 6.5/10
- Implementation readiness: 6.5/10

**Overall: 7.0/10**

## Evidence Reference (Primary)

- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/tools/index.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/loader.ts`
- `~/projects/pi-mono/packages/coding-agent/src/core/exec.ts`
- `~/projects/pi-mono/packages/coding-agent/src/modes/print-mode.ts`
- `~/projects/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `~/projects/pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts`
- `~/projects/pi-mono/packages/coding-agent/docs/extensions.md`
- `~/projects/pi-mono/packages/coding-agent/docs/settings.md`
