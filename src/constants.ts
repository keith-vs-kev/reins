/**
 * Reins extension constants.
 * Single source of truth for allowlist, timeouts, and cache config.
 */

/** Tools allowed in delegation-only mode. All other tools are blocked. */
export const ALLOWED_TOOLS = ["reins_delegate"];

/** Default context builder timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 12_000;

/** Default context cache TTL in milliseconds (5 minutes). */
export const DEFAULT_CACHE_MAX_AGE = 5 * 60 * 1000;

/**
 * Hard truncation cap for context injected into the system prompt.
 * Measured in tokens (rough estimate: chars / 4).
 */
export const CONTEXT_BUILDER_MAX_TOKENS = 4_000;

/** Maximum number of entries in the in-memory context cache. */
export const MAX_CACHE_ENTRIES = 100;

/** Read-only tools granted to the context builder subprocess. */
export const CONTEXT_BUILDER_TOOLS = ["read", "grep", "find", "ls", "web_search", "web_fetch"];

/** Default tools granted to sub-agents spawned via reins_delegate. */
export const DELEGATE_DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Environment variable used to mark Reins-spawned subprocesses. */
export const REINS_SUBAGENT_ENV_VAR = "REINS_SUBAGENT";

/** File used to persist the "onboarding shown" flag across sessions. */
export const ONBOARDING_FLAG_FILENAME = "reins-onboarding-shown";

/** Global settings file path relative to home directory. */
export const GLOBAL_SETTINGS_RELATIVE = ".pi/agent/settings.json";

/** Project settings file path relative to cwd. */
export const PROJECT_SETTINGS_RELATIVE = ".pi/settings.json";

/** Default model for the context builder. */
export const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/** Maximum number of consecutive tool blocks before circuit breaker fires. */
export const CIRCUIT_BREAKER_WARN_THRESHOLD = 3;

/** Maximum number of consecutive tool blocks before hard warning. */
export const CIRCUIT_BREAKER_HARD_THRESHOLD = 5;
