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
| **Command** | A `/slash` command registered via `pi.registerCommand()` |
| **`tool_call` event** | Fires before tool execution; return `{ block: true, reason }` to prevent it |
| **`tool_result` event** | Fires after tool execution; can modify the result |
| **`before_agent_start` event** | Fires before the agent turn; used for prompt/context injection |
| **Session entry** | Persistent extension state via `pi.appendEntry()` |
| **Settings** | Pi config in `~/.pi/agent/settings.json` or project `.pi/` |

**Not used (these are OpenClaw concepts, not Pi):**
`plugin`, `hook`, `gateway`, `OpenClawPluginApi`, `before_tool_call`, `before_prompt_build`, `blockReason`, `openclaw.plugin.json`, `api.registerHook()`.

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
Reins: enabled
Context builder: sonnet (default)
Last context build: 12s ago — success (1,247 tokens)
Cache age: 12s
Tool blocks this session: 0
```

Or with issues:

```
Reins: enabled
Context builder: sonnet (default)
Last context build: 4m ago — partial (timeout, 483 tokens)
Cache age: 4m 12s
Tool blocks this session: 3
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

The context builder runs once per user prompt (via `before_agent_start`). The user **never sees**:

- The context builder spawning
- The injected context block
- Any "gathering context..." indicator
- Any delay spinner or progress bar

From the user's perspective, they send a message, the agent responds. The response is better-informed because the context builder front-loaded relevant files, memory, and docs — but the user doesn't see the mechanism.

### What the user actually experiences

- **Slightly longer first-response time** — the context builder adds 2–15s of latency once per user prompt before the agent starts. This is the only observable side effect. No loading indicator is shown; the agent simply takes a beat longer to start responding.
- **Better-informed responses** — the agent references files it wasn't explicitly pointed at, remembers context from previous sessions, surfaces relevant docs. This is the payoff.
- **No injected content in chat history** — the prepended context is part of the prompt assembly, not a visible message. It does not appear in the conversation thread. It's equivalent to system context — present in the LLM call, absent from the chat UI.

### Transparency (v2)

US4 in the PRD requests optional transparency — seeing what was injected. **This is deferred to v2 in both the PRD and UX spec.** When implemented, it should be opt-in (e.g. `/reins verbose on`) and render as a collapsed/summary block, not inline content.

---

## 4. Error States

### Context builder timeout

The user sees **nothing different**. The agent responds normally, possibly with less context than usual. If partial results were gathered before timeout, those are injected silently.

Internally, the extension logs the timeout. The user is not notified unless they check `/reins status`, which could show:

```
Reins: enabled
Context builder: sonnet (default)
Last context build: timed out (partial context injected)
```

### Context builder total failure

Same as timeout — the agent proceeds with full delegation-only constraints but without injected context. The user's experience is: the agent still delegates, it just might ask more questions or be less informed on that turn.

No error toast. No warning banner. The agent doesn't announce "I couldn't build context" — it just does its best.

### Tool block

When the cuffed agent attempts a non-delegation tool call (shouldn't happen often with the soft layer, but the hard layer catches it):

The agent receives `{ block: true, reason: "Reins: restricted to delegation only" }` and re-routes to delegation. The user sees the agent delegate the task — they don't see the blocked attempt. This is internal plumbing.

**Implementation detail:** The `tool_call` event handler returns `{ block: true, reason: "..." }` for any tool not on the allow-list. Pi surfaces the `reason` string to the model so it can self-correct.

### Tool-block circuit breaker

If the agent gets stuck in a block loop, Reins escalates automatically:

- **3 consecutive blocked tool calls in a single turn** — Reins injects a stronger delegation prompt into the current turn: _"You cannot use tools directly. Delegate this task to a sub-agent using `reins_delegate`."_ The user sees nothing; the agent course-corrects silently.
- **5 consecutive blocked tool calls in a single turn** — Reins surfaces a warning to the user via `ctx.ui.notify`:

```
⚠️ Reins: agent attempted restricted tools 5 times.
Check delegation prompt or run `/reins off` to debug.
```

The agent's turn continues — Reins doesn't kill it — but the user now has signal that something is stuck. The block counter resets at the start of each new turn.

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

The three-bullet explainer appears **once** — first activation only. Subsequent `/reins on` shows the single-line confirmation. The "has seen onboarding" flag is persisted via `pi.appendEntry("reins_onboarding", { shown: true })`.

### Setup required

None. The extension ships with sensible defaults:

- Context builder model: Sonnet
- Timeout: 10s
- Allowed tools: `reins_delegate` only (extension-provided delegation tool)

No config file to edit. No API keys to set. `/reins on` and go.

Advanced users can configure via `~/.pi/agent/settings.json` — but that's a docs concern, not an onboarding flow.

---

## 6. `/prework` Command

### Purpose

Explicit, one-shot context building without enabling the always-on harness. Useful for complex tasks where you want the agent to have full context before you engage.

### `/prework <prompt>`

```
User: /prework refactor the auth middleware to use the new token service

Agent: Context built (1,847 tokens, 3.1s). Ready — send your prompt.
```

The prework response is **one line**: confirmation with token count and time. No dump of what was gathered — the context is injected into the next turn's prompt silently, same as the always-on mode.

### `/prework` (no argument)

```
Usage: /prework <prompt>
Builds context for your next message. Does not enable Reins.
```

### Behaviour

- Prework does **not** enable Reins. The agent retains full tool access.
- The gathered context is injected into the **next turn only** — it's not persistent. Internally, `/prework` stores the built context in the session cache with a `prework` flag. The next `before_agent_start` event handler detects this flag, injects the context into the system prompt, and clears both the flag and the cached content. One shot — no residue.
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
