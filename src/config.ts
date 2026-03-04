/**
 * Reins configuration reader.
 *
 * Two-scope model:
 *   - Global:  ~/.pi/agent/settings.json
 *   - Project: .pi/settings.json (relative to cwd)
 *
 * Project settings override global settings per-key.
 * Unspecified keys fall through to global, then to hardcoded defaults.
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_TOOLS,
  DEFAULT_CACHE_MAX_AGE,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  GLOBAL_SETTINGS_RELATIVE,
  PROJECT_SETTINGS_RELATIVE,
} from "./constants.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReinsConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  allowedTools: string[];
  cacheMaxAge: number;
  debug: boolean;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const GLOBAL_SETTINGS_PATH = join(homedir(), GLOBAL_SETTINGS_RELATIVE);

// ─── Global settings cache ───────────────────────────────────────────────────

let cachedGlobal: Record<string, unknown> | null = null;
let cachedGlobalMtime = 0;

// ─── File I/O ────────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file.
 * Returns empty object on missing file or parse error (with warning logged).
 * This is the corruption recovery strategy — invalid JSON is treated as empty.
 */
export function readJsonFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (existsSync(path)) {
      console.warn(`[reins] Failed to parse ${path}: ${err}. Using defaults.`);
    }
    return {};
  }
}

function readGlobalSettings(): Record<string, unknown> {
  try {
    const { mtimeMs } = statSync(GLOBAL_SETTINGS_PATH);
    if (cachedGlobal && mtimeMs === cachedGlobalMtime) return cachedGlobal;
    cachedGlobal = readJsonFile(GLOBAL_SETTINGS_PATH);
    cachedGlobalMtime = mtimeMs;
    return cachedGlobal;
  } catch {
    return {};
  }
}

function readProjectSettings(cwd: string): Record<string, unknown> {
  return readJsonFile(join(cwd, PROJECT_SETTINGS_RELATIVE));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the effective Reins config for the given working directory.
 * Project settings override global settings per-key.
 */
export function getReinsConfig(cwd?: string): ReinsConfig {
  const globalSettings = readGlobalSettings();
  const projectSettings = cwd ? readProjectSettings(cwd) : {};

  const globalRc = ((globalSettings["reins"] as Record<string, unknown>) ?? {});
  const projectRc = ((projectSettings["reins"] as Record<string, unknown>) ?? {});

  // Project overrides global per-key
  const merged: Record<string, unknown> = { ...globalRc, ...projectRc };

  return {
    enabled: typeof merged["enabled"] === "boolean" ? merged["enabled"] : false,
    model: typeof merged["model"] === "string" ? merged["model"] : DEFAULT_MODEL,
    timeoutMs: typeof merged["timeoutMs"] === "number" ? merged["timeoutMs"] : DEFAULT_TIMEOUT_MS,
    allowedTools: Array.isArray(merged["allowedTools"])
      ? (merged["allowedTools"] as string[])
      : ALLOWED_TOOLS,
    cacheMaxAge:
      typeof merged["cacheMaxAge"] === "number" ? merged["cacheMaxAge"] : DEFAULT_CACHE_MAX_AGE,
    debug: typeof merged["debug"] === "boolean" ? merged["debug"] : false,
  };
}

/**
 * Write reins.enabled to the global settings file.
 * Uses atomic write (temp file + rename) to prevent partial writes on crash.
 * Invalidates the in-memory cache after writing.
 */
export async function setReinsEnabled(enabled: boolean): Promise<void> {
  const settings = readJsonFile(GLOBAL_SETTINGS_PATH) as Record<string, Record<string, unknown>>;
  if (!settings["reins"]) settings["reins"] = {};
  settings["reins"]["enabled"] = enabled;

  const tmpPath = GLOBAL_SETTINGS_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, GLOBAL_SETTINGS_PATH);

  // Invalidate stat cache so next read picks up fresh file
  cachedGlobal = null;
  cachedGlobalMtime = 0;
}
