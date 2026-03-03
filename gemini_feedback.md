# Gemini Feedback: Reins Plan Review

**Date:** 2026-03-04  
**Reviewer:** Gemini CLI  
**Rating:** 4.5/5

## Executive Summary
The Reins plan is **architecturally solid** and well-aligned with the Pi Extension framework. It correctly identifies the `before_agent_start` (for context injection) and `tool_call` (for hard enforcement) hooks as the primary extension points. The strategy of using a read-only sub-agent (`subpi`) for context building is a high-signal pattern for reducing agent drift.

## Validation Findings

| Component | Plan Assumption | Observed Reality | Status |
| :--- | :--- | :--- | :--- |
| **Hook Awaiting** | `before_agent_start` is awaited | Confirmed in `runner.ts` (line 739) | ✅ **Valid** |
| **System Prompt Injection** | `systemPrompt` field in result | Confirmed in `types.ts` (line 900) | ✅ **Valid** |
| **Tool Blocking** | `block: true, reason: "..."` | Confirmed in `types.ts` (line 880) | ✅ **Valid** |
| **`subpi` CLI** | Has `--system` and `--prompt` | `subpi spawn` uses positional `PROMPT` and lacks `--system` | ⚠️ **Mismatch** |
| **Command Registration** | Uses `execute` property | API uses `handler` property | ⚠️ **Minor** |
| **Main Agent ID** | `ctx.depth` or `ctx.parentId` | Missing from `ExtensionContext`; use `!process.env.SUBPI_SESSION_NAME` | 💡 **Heuristic** |

## Technical Analysis & Risks

### 1. `subpi` CLI Discrepancy
The ARCH documentation proposes `pi.exec("subpi", ["spawn", "--system", ...])`. However, `subpi spawn` (v0.x) does not currently support a `--system` or `--prompt` flag. It expects the prompt as a positional argument. 
- **Mitigation:** Update `subpi` to support `--system-prompt` or pass these as `--pi-flags "--system-prompt ..."` which `subpi` forwards to the underlying `pi` process.

### 2. Tool Name Alignment
Your allowlist includes `subagents`, `sessions_spawn`, `message`, and `tts`. 
- **Note:** The built-in example in `pi-mono` is named `subagent` (singular). 
- **Observation:** `sessions_spawn`, `message`, and `tts` are not part of the core `pi-mono` or `subpi` repos. They are likely assumed to be external extensions or part of a specific user environment.

### 3. Main Agent Identification (ADR-002)
Since `ExtensionContext` doesn't expose recursion depth or parent IDs, the most reliable way to identify the "main" agent in the current ecosystem is checking for the absence of environment variables set by sub-agent spawners.
- **Recommended Heuristic:** `!process.env.SUBPI_SESSION_NAME`.

### 4. Registration Naming
In `ExtensionAPI.registerCommand`, the property is named `handler`, not `execute`.

## Final Verdict
The plan is highly professional and technically grounded. It provides a clear path to enforcing single-responsibility at the harness level. I recommend proceeding with implementation after resolving the minor CLI argument mismatches.
