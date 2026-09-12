/**
 * PES.7 — the browser-local store behind auto-publish, the approval gate and rollback snapshots.
 *
 * These three are browser-only **by record, not by accident**: inventory §2.6 lists them with named
 * server-side successors (PB.9b / PB.11b / PB.12b) that were never built. Under the 100%-honest-UI
 * rule the rebuilt surfaces must keep saying "this browser only" where the old ones did, so that
 * sentence is carried by the store itself (`STORAGE_SCOPE_NOTE`) rather than left to each component
 * to remember.
 *
 * 🔴 **Every access is wrapped.** `localStorage` is not merely absent during SSR — reading it
 * *throws* in a browser configured to block site data, and a write throws when the quota is full.
 * An unguarded read here would take down the whole images tab for a setting nobody needs.
 *
 * 🔴 **Stored data is parsed as untrusted input**, exactly like a wire payload: it was written by an
 * older version of this code, on a machine we know nothing about, and may be any shape at all.
 */

/** The sentence every surface backed by this store must show. One wording, one place. */
export const STORAGE_SCOPE_NOTE =
  'Saved in this browser only — not on your account. Another browser, another machine, or a cleared '
  + 'cache will not see it, and nobody else on the team will.'

const PREFIX = 'nexus.studio.images.v1'

export function storageKey(...parts: Array<string | null | undefined>): string {
  return [PREFIX, ...parts.map((p) => p ?? '_')].join(':')
}

/** True when a store is actually usable — not merely present. Probed, not assumed. */
export function storageAvailable(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    const probe = `${PREFIX}:probe`
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    // Blocked site data, private mode, quota — all indistinguishable here, and all mean "no".
    return false
  }
}

/**
 * Read and validate. `parse` receives `unknown` and returns `null` to reject — a stored value that
 * no longer fits the current shape is dropped, never coerced into a plausible-looking lie.
 */
export function readLocal<T>(key: string, parse: (raw: unknown) => T | null): T | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    return parse(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/** Write. Returns whether it actually landed, so a caller can tell the operator the truth. */
export function writeLocal(key: string, value: unknown): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function removeLocal(key: string): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    window.localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/* ── parsing helpers: every field checked, nothing trusted ─────────────────────── */

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

export function asBoolean(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** An array of validated items; items that fail validation are dropped, not defaulted. */
export function asArrayOf<T>(v: unknown, item: (raw: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (const raw of v) {
    const parsed = item(raw)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/**
 * An enum value, or `null` when the stored string is not one we know.
 *
 * Deliberately NOT defaulted to the first member: a preference restored as something the operator
 * never chose is worse than a preference that reverts to the code's default and says nothing.
 */
export function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}
