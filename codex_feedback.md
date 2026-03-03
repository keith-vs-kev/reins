# Codex Feedback: Reins Plan Validation (against pi-mono reality)

Date: 2026-03-03
Repository reviewed: `docs/` in this repo
Framework validated against: `~/projects/pi-mono` (source + docs)

## Overall rating

**4/10**

Core concept is viable, but several foundational assumptions in the plan are incorrect for current Pi and would block implementation until corrected.

## Findings (severity-ordered)

### 1) Critical: delegation allowlist is based on non-existent Pi tools

The plan repeatedly assumes built-in/available delegation tools: `subagents`, `sessions_spawn`, `message`, `tts`, and/or `subpi`.

Current Pi built-in tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
Pi also explicitly documents there is no built-in sub-agent system in core.

Impact: If implemented as written, the harness can deadlock (everything blocked, no valid delegation path).

Doc refs:
- `docs/PRD.md:100`
- `docs/PRD.md:150`
- `docs/ARCH.md:8`
- `docs/ARCH.md:71`
- `docs/ARCH.md:222`

Pi refs:
- `~/projects/pi-mono/packages/coding-agent/README.md:476`
- `~/projects/pi-mono/packages/coding-agent/README.md:408`
- `~/projects/pi-mono/packages/coding-agent/src/core/tools/index.ts:88`

### 2) Critical: command API shape in snippets is wrong

Plan uses `pi.registerCommand(... { async execute(args, ctx) { ... } })`.
Actual Pi API expects `handler: async (args, ctx) => { ... }`.

Impact: compile/runtime failure.

Doc refs:
- `docs/PRD.md:159`

Pi refs:
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts:906`
- `~/projects/pi-mono/packages/coding-agent/docs/extensions.md:1031`

### 3) High: sub-agent execution model mismatched to Pi

ARCH assumes `subpi` CLI/OpenClaw environment coupling.
In Pi reality, sub-agents are typically implemented by custom extension tools that spawn `pi` itself (see official example).

Impact: integration path in ARCH is likely incorrect in this codebase.

Doc refs:
- `docs/ARCH.md:281`

Pi refs:
- `~/projects/pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts:287`
- `~/projects/pi-mono/packages/coding-agent/examples/extensions/README.md:42`

### 4) High: “main vs sub-agent” guard is ungrounded in current ExtensionContext

Plan depends on fields like `ctx.parentSessionId` / `ctx.depth` to detect top-level agent.
Those fields are not present in current `ExtensionContext` API.

Impact: key restriction boundary is undefined; behavior may be wrong.

Doc refs:
- `docs/ARCH.md:141`

Pi refs:
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts:261`

### 5) Medium: event timing semantics are partially misstated

Docs describe context builder running before each main-agent “turn”.
`before_agent_start` fires once per user prompt (before agent loop), not before each internal tool/LLM turn.

Impact: latency/per-turn metrics and implementation expectations are off.

Doc refs:
- `docs/PRD.md:25`
- `docs/UX-SPEC.md:100`

Pi refs:
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts:496`
- `~/projects/pi-mono/packages/coding-agent/docs/extensions.md:393`

### 6) Medium: circuit-breaker prompt text references extension API as if model tool

UX proposes instruction: delegate using `pi.exec()`.
`pi.exec()` is an extension-side method, not an LLM tool the agent can call directly.

Doc refs:
- `docs/UX-SPEC.md:153`

Pi refs:
- `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1039`

### 7) Medium: PRD/UX requirement mismatch

PRD US4 requests transparency for injected context.
UX explicitly defers transparency to v2.

Impact: acceptance ambiguity.

Doc refs:
- `docs/PRD.md:55`
- `docs/UX-SPEC.md:117`

## What is accurate

- `tool_call` event supports `{ block: true, reason }`
  - `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts:835`
- `before_agent_start` can replace `systemPrompt`
  - `~/projects/pi-mono/packages/coding-agent/src/core/extensions/types.ts:854`
  - `~/projects/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:713`
- Extension discovery/config assumptions are mostly correct (`~/.pi/agent/extensions`, `.pi/extensions`, `pi.extensions` in `package.json`)
  - `~/projects/pi-mono/packages/coding-agent/src/core/extensions/loader.ts:403`
- Settings path assumption is correct (`~/.pi/agent/settings.json`)
  - `~/projects/pi-mono/packages/coding-agent/src/config.ts:213`

## Recommended correction path (short)

1. Replace fictional delegation tools with a real extension-provided tool (e.g. based on Pi’s `subagent` example).
2. Fix all command handler snippets to use `handler` instead of `execute`.
3. Define a concrete top-level-only enforcement strategy based on actual runtime/session markers (or scope Reins to all agents until proven safe).
4. Reword “before each turn” semantics to align with `before_agent_start` behavior.
5. Align PRD and UX on transparency scope (v1 vs v2).
