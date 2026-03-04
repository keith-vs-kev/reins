/**
 * In-memory context cache for the context builder.
 *
 * Keyed by promptHash (first 12 hex chars of SHA-256 of the prompt prefix).
 * Provides stale-cache fallback when the context builder times out or errors.
 *
 * Per ARCH §8.3.
 */

import { createHash } from "node:crypto";
import { MAX_CACHE_ENTRIES } from "../constants.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  context: string;
  timestamp: number;
  maxAge: number;
}

// ─── Cache class ─────────────────────────────────────────────────────────────

class ContextCache {
  private entries = new Map<string, CacheEntry>();

  /**
   * Store a context string for the given hash key.
   * Evicts the oldest entry when the cache is full (LRU-lite: FIFO eviction).
   */
  set(key: string, context: string, maxAge: number): void {
    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { context, timestamp: Date.now(), maxAge });
  }

  /**
   * Retrieve a context string if it exists and has not expired.
   * Returns undefined on cache miss or expired entry (and deletes expired).
   */
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > entry.maxAge) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.context;
  }

  /**
   * Check if a cache entry is stale (older than maxAge).
   * Returns true if no entry exists or entry is expired.
   */
  isStale(key: string, maxAge: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    return Date.now() - entry.timestamp > maxAge;
  }

  /** Get the age of a cache entry in milliseconds, or undefined if not present. */
  getAge(key: string): number | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return Date.now() - entry.timestamp;
  }

  /** Remove all entries. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.entries.size;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const contextCache = new ContextCache();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Hash a prompt string for use as a cache key.
 * Uses only the first 200 chars to avoid hashing huge prompts.
 * Returns a 12-char hex prefix of the SHA-256 digest.
 */
export function hashPrompt(prompt: string): string {
  return createHash("sha256")
    .update(prompt.slice(0, 200))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Retrieve a cached context (convenience wrapper over contextCache.get).
 */
export function getCache(hash: string): string | undefined {
  return contextCache.get(hash);
}

/**
 * Store a context in the cache (convenience wrapper over contextCache.set).
 */
export function setCache(hash: string, value: string, maxAge: number): void {
  contextCache.set(hash, value, maxAge);
}

/**
 * Check whether a cache entry is stale relative to the given maxAge.
 */
export function isStale(hash: string, maxAge: number): boolean {
  return contextCache.isStale(hash, maxAge);
}
