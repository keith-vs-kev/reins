# UX Spec: Reins

**Status:** Draft
**Author:** Lux (via Iris)
**Date:** 2026-03-03

---

## 0. Terminology

Consistent language for contributors working on Reins as a **Pi extension**.

| Term | Meaning |
|------|---------|
| **Pi** | The `pi` coding agent (`@mariozechner/pi-coding-agent`) |
| **Extension** | A TypeScript module extending Pi via `ExtensionAPI` |
| **ExtensionAPI** | The API object passed to the extension's default export function |
| **Event** | A Pi lifecycle event subscribed via `pi.on(eventName, handler)` |
| **Tool** | An LLM-callable function registered via `pi.registerTool()` |
| **Command** | A `/slash` command registered via `pi.registerCommand(name, { handler })` |
| **`tool_call` event** | Fires before tool execution; return `{ block: true, reason }` to prevent it |
| **`tool_result` event** | Fires after tool execution; can modify the result |
| **`before_agent_start` event** | Fires once per user prompt before the agent loop; used for prompt/context injection |
| **Settings** | Pi config in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project). Project overrides global. |
| **Default active tools** | `read`, `bash`, `edit`, `write` — the 4 tools active by default (`codingTools`) |
| **Available tools (registry)** | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — all 7 tools in Pi's `allTools` registry |
| **`pi.exec()`** | Extension-side API for running shell commands (supports `signal`, `timeout`, `cwd` only — no `env`). NOT usable for subprocess spawning. Reins uses `child_process.spawn()` instead. |

**Not used (these are OpenClaw concepts, not Pi):**
`plugin`, `hook`, `gateway`, `OpenClawPluginApi`, `before_tool_call`, `before_prompt_build`, `blockReason`, `openclaw.plugin.json`, `api.registerHook()`.

**Not Pi built-in (do not reference as available tools):**
`subagents`, `sessions_spawn`, `message`, `tts`, `web_search`, `web_fetch`, `browser`, `image`.

---

## 1. Command Interface

### `/reins on`

```
🔒 Reins enabled. Agent is delegation-only.
```

That's it. One line. No explanation of what changed — the user ran the command, they know what it does.

### `/reins off`

```
🔓 Reins disabled. Agent has full tool access.
```

**Mid-task note:** Running sub-agents continue to completion — `/reins off` doesn't kill them. The main agent regains full tool access on the _next_ turn, not immediately mid-turn.

### `/reins status`

```
Reins: enabled                          (global)
Context builder: claude-sonnet-4-20250514  (global)
Last context build: 12s ago — success (~1,247 tokens, estimated)
Cache age: 12s
Tool blocks this session: 0
Extension load order: reins (1 of 2)
```

Or with project overrides:

```
Reins: enabled                          (global)
Context builder: claude-haiku-4-20250414   ⚠️ overridden by project config
Last context build: 4m ago — partial (timeout, ~483 tokens, estimated)
Cache age: 4m 12s
Tool blocks this session: 3
Extension load order: reins (1 of 2)
```

Or when off:

```
Reins: disabled
```

Status is the only command that shows detail. On/off are fire-and-forget.

### `/reins` (no argument)

Same as `/reins status`.

---

## 2. State Indicators

**None.**

When Reins is active, the user sees no persistent badge, prefix, or header. The agent just works differently — it delegates instead of executing directly. The user notices this through behaviour, not chrome.

**Rationale:** Engineers don't need a blinking light to remember what mode they're in. They ran `/reins on`. They know. If they forget, `/reins` tells them.

The only moment Reins surfaces visually is in the `/reins status` response and in error states (§4).

---

## 3. Context Injection UX

### What "invisible" means

The context builder runs once per user prompt (via `before_agent_start`, which fires once before the agent loop starts). The user **never sees**:

- The context builder spawning
- The injected context block
- Any "gathering context..." indicator
- Any delay spinner or progress bar

From the user's perspective, they send a message, the agent responds. The response is better-informed because the context builder front-loaded relevant files, memory, and docs — but the user doesn't see the mechanism.

### What the user actually experiences

- **Slightly longer first-response time** — the context builder adds 2–15s of latency once per user prompt before the agent starts. This is the only observable side effect. No loading indicator is shown; the agent simply takes a beat longer to start responding.
- **Better-informed responses** — the agent references files it wasn't explicitly pointed at, remembers context from previous sessions, surfaces relevant docs. This is the payoff.
- **No injected content in chat history** — the context is injected via system prompt modification (returned as `systemPrompt` from `before_agent_start`), not as a visible message. It does not appear in the conversation thread.

### Transparency (v2)

US4 in the PRD requests optional transparency — seeing what was injected. **This is deferred to v2 in both the PRD and UX spec.** When implemented, it should be opt-in (e.g. `/reins verbose on`) and render as a collapsed/summary block, not inline content.

---

## 4. Error States

### Context builder timeout

The user sees **nothing different**. The agent responds normally, possibly with less context than usual. If partial results were gathered before timeout, those are injected silently via the system prompt.

Internally, the extension logs the timeout. The user is not notified unless they check `/reins status`, which could show:

```
Reins: enabled
Context builder: claude-sonnet-4-20250514
Last context build: timed out (partial context injected)
```

### Context builder total failure

Same as timeout — the agent proceeds with full delegation-only constraints but without injected context. The user's experience is: the agent still delegates, it just might ask more questions or be less informed on that turn.

No error toast. No warning banner. The agent doesn't announce "I couldn't build context" — it just does its best.

### Tool block

When the cuffed agent attempts a non-delegation tool call (shouldn't happen often with the soft layer, but the hard layer catches it):

The agent receives `{ block: true, reason: "Reins: restricted to delegation only" }` and re-routes to delegation. The blocked attempt is typically internal — the user doesn't see it in the chat UI — but the model receives the block reason as an error result and may reference it in its response.

**Implementation detail:** The `tool_call` event handler returns `{ block: true, reason: "..." }` (typed as `ToolCallEventResult`) for any tool not on the allow-list. Pi surfaces the `reason` string as an error result that the model sees. This means blocked tool calls are **not invisible** — they surface as error results that may influence the model's behavior. This is by design: it teaches the model to self-correct toward delegation.

### Tool-block circuit breaker

If the agent gets stuck in a block loop, Reins escalates automatically:

- **3 consecutive blocked tool calls in a single turn** — Reins injects a stronger delegation prompt: _"You cannot use tools directly. Delegate this task to a sub-agent using `reins_delegate`."_ This is injected via `pi.sendMessage()` with `{ deliverAs: "steer" }` to interrupt the current turn. The user sees nothing; the agent course-corrects silently.
- **5 consecutive blocked tool calls in a single turn** — Reins surfaces a warning to the user via `ctx.ui.notify`:

```
⚠️ Reins: agent attempted restricted tools 5 times.
Check delegation prompt or run `/reins off` to debug.
```

The agent's turn continues — Reins doesn't kill it — but the user now has signal that something is stuck. The block counter resets at the start of each new turn (tracked via `turn_start` event).

---

## 5. First-Run / Onboarding

### First `/reins on` ever

```
🔒 Reins enabled. Agent is delegation-only.

First time? Here's what changed:
  • Your agent can only delegate — no direct tool use
  • A context builder runs once per prompt (invisible to you)
  • /reins off to disable, /reins status for details
```

The three-bullet explainer appears **once** — first activation only. Subsequent `/reins on` shows the single-line confirmation.

**Persistence:** The "has seen onboarding" flag is stored as a file at `~/.pi/agent/reins-onboarding-shown` (not via `pi.appendEntry()`, which persists in the current session file and survives restarts of that session, but is not global cross-session state). See ARCH.md ADR-004.

### Setup required

None. The extension ships with sensible defaults:

- Context builder model: configurable via `settings.reins.model` (e.g. `claude-sonnet-4-20250514`)
- Timeout: 12s
- Allowed tools: `reins_delegate` only (registered by the extension via `pi.registerTool()`)

No config file to edit. No API keys to set (uses the same API key Pi is already configured with). `/reins on` and go.

Advanced users can configure via settings files:
- `~/.pi/agent/settings.json` for global defaults
- `.pi/settings.json` for project-specific overrides (project takes precedence)

---

## 6. `/prework` Command

### Purpose

Explicit, one-shot context building without enabling the always-on harness. Useful for complex tasks where you want the agent to have full context before you engage.

### `/prework <prompt>`

```
User: /prework refactor the auth middleware to use the new token service

📋 Context built (1,847 tokens, ready). Send your prompt.
```

The prework response is **one line**: confirmation with token count and status. No dump of what was gathered. The context is queued invisibly for the next turn via `pi.sendMessage()` with `display: false` and `{ deliverAs: "nextTurn" }` — the user never sees the raw context, only the one-line confirmation.

### `/prework` (no argument)

```
Usage: /prework <prompt>
Builds context for your next message. Does not enable Reins.
```

### Behaviour

- Prework does **not** enable Reins. The agent retains full tool access.
- The gathered context is injected into the **next turn only** — it's not persistent. Internally, `/prework` sends a custom message via `pi.sendMessage()` with `{ deliverAs: "nextTurn" }`, which queues it for the next user prompt. One shot — no residue.
- If Reins is already enabled, `/prework` still works but is redundant (context builder runs automatically). Show:

```
Reins is active — context is built automatically each turn.
Running explicit prework anyway...
Context built (1,847 tokens, 3.1s). Ready.
```

### Failure

```
User: /prework refactor the auth middleware

Agent: Context build failed (timeout). Your next message will proceed without pre-built context.
```

One line. No drama. The user can retry or just proceed.

---

## 7. Non-Interactive Mode Behavior

Reins is primarily designed for interactive Pi sessions, but must behave correctly in all modes:

- **JSON mode (`--mode json`) / Print mode (`-p`):** The `/reins` command **is executable** — prompt text starting with `/` is parsed as a command in all modes. UI discoverability (tab-complete) is interactive-only, but command execution works everywhere. Users can also configure Reins via settings files directly (`reins.enabled: true` in `~/.pi/agent/settings.json`). Tool blocking works normally. `ctx.ui.notify()` is a no-op — the circuit breaker warning (§4) will not surface visually. See ARCH.md §14 for the canonical decision tree: when `ctx.hasUI === false`, the warning is injected via the next `before_agent_start` systemPrompt modification.
- **RPC mode (`--mode rpc`):** `/reins` is available via the `prompt` RPC command. `ctx.ui.notify()` emits to the RPC client.

---

## 8. Status Telemetry

The `/reins status` output (§1) reports specific runtime data. Source of truth for each field:

| Field | What it shows | Where it comes from |
|-------|--------------|-------------------|
| `Reins: enabled/disabled` | Current toggle state + source scope | `reins.enabled` in settings file (persistent). Shows `(global)` or `(project)` scope. |
| `Context builder:` | Model used + override warning | `reins.model` in settings file. Shows `⚠️ overridden by project config` if project differs from global. |
| `Last context build:` | Time since last build + outcome | In-memory timestamp + status from last `buildContextWithTimeout` call. Resets on Pi restart. |
| `Cache age:` | Time since last successful cache write | In-memory, `Date.now() - cacheEntry.timestamp`. Resets on restart. |
| `Tool blocks this session:` | Count of blocked tool calls | In-memory counter incremented in `tool_call` hook. Resets on restart (per-session by design). |
| `Extension load order:` | Position of Reins in extension discovery order | From `pi.getAllExtensions()` or equivalent. Debug info for multi-extension interaction. |

Token estimates in the status output use a rough `chars / 4` heuristic — this is an approximation, not a true token count. Status output shows `~X tokens (estimated)` to make this clear.
