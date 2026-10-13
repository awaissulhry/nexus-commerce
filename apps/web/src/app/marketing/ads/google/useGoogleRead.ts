'use client'

/**
 * Google Ads step 1b — the step-1a load pattern (`Loaded<T>`: one answer per key, a late answer for an older key
 * dropped) as one hook, with a short per-key cache so a tab, a card and the campaign window that read the same thing
 * share one request and a tab opened again shows at once.
 *
 *   const alerts = useGoogleRead(googleReadKey('alerts', account), () => fetchGoogleAlerts({ account }))
 *
 * The rules:
 *  - `key` names everything the answer depends on (build it with `googleReadKey`); `null` reads nothing.
 *  - The cache never crosses businesses or people: every entry is filed under the business in the address (`/w/<id>`)
 *    and the signed-in person. Entries live `GOOGLE_READ_TTL_MS`; a failed read is never cached.
 *  - Two callers with the same key while it loads share the one request.
 *  - `reload()` drops this key's answer and reads it again (Try again).
 *  - `keepPrevious`: while a new key loads, `data` is the last answer of the old one (the grid's reload veil covers the
 *    change; `loading` says it is not the new answer yet). An error is never shown over an older answer.
 *
 * The pure half (`googleReadKey`, `googleReadCacheKey`, the cache itself) is exported for the node-only tests.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { browserWorkspaceId } from '@/lib/workspaces/paths'
import { browserUserId } from '@/lib/workspaces/browser-identity'

/** How long an answer is shown again without asking (Google is read once a day; Read now at most once an hour). */
export const GOOGLE_READ_TTL_MS = 5 * 60_000
/** The most answers kept; the oldest goes first. */
export const GOOGLE_READ_CACHE_MAX = 64

/** The key of one read: its name and every parameter, in order. `null`/`undefined` parts are kept as null. */
export function googleReadKey(name: string, ...parts: Array<string | number | boolean | null | undefined>): string {
  return JSON.stringify([name, ...parts.map((p) => (p === undefined ? null : p))])
}

/** The key filed under the business and the person, so an answer never shows in another business or to another person. */
export function googleReadCacheKey(key: string, workspaceId: string | null = browserWorkspaceId(), userId: string | null = browserUserId()): string {
  return `${workspaceId ?? '-'}|${userId ?? '-'}|${key}`
}

type Entry = { data: unknown; at: number }
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<unknown>>()

/** The cached answer for a full cache key, or undefined when there is none or it is too old. */
export function cachedGoogleRead<T>(fullKey: string, now = Date.now()): T | undefined {
  const hit = cache.get(fullKey)
  if (!hit) return undefined
  if (now - hit.at > GOOGLE_READ_TTL_MS) {
    cache.delete(fullKey)
    return undefined
  }
  return hit.data as T
}

/** Files an answer; past the cap the oldest answer goes. */
export function rememberGoogleRead(fullKey: string, data: unknown, now = Date.now()): void {
  cache.delete(fullKey)
  cache.set(fullKey, { data, at: now })
  while (cache.size > GOOGLE_READ_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Forgets every answer (a new read from Google was asked for), or the one key given. */
export function forgetGoogleReads(fullKey?: string): void {
  if (fullKey === undefined) cache.clear()
  else cache.delete(fullKey)
}

/** One request per key at a time: a second caller while it loads gets the same promise. */
export function sharedGoogleRead<T>(fullKey: string, load: () => Promise<T>): Promise<T> {
  const running = inFlight.get(fullKey) as Promise<T> | undefined
  if (running) return running
  const p = load().finally(() => { if (inFlight.get(fullKey) === p) inFlight.delete(fullKey) })
  inFlight.set(fullKey, p)
  return p
}

export interface GoogleReadState<T> {
  /** The answer for `key` (or, with `keepPrevious`, the last answer while the new key loads). Null before any. */
  data: T | null
  /** The server's sentence when the read for `key` failed; null otherwise. */
  error: string | null
  /** True until the read for `key` has answered (or failed). False when `key` is null. */
  loading: boolean
  /** Reads `key` again, past the cache. */
  reload: () => void
}

export interface GoogleReadOptions {
  /** While a new key loads, keep the last answer on screen. Default false. */
  keepPrevious?: boolean
  /** Use the cache. Default true; false always asks the server (still one request per key at a time). */
  cache?: boolean
  /** The sentence when the failure carries none. */
  fallbackError?: string
}

type Settled<T> = { key: string; data: T | null; error: string | null }

const messageOf = (err: unknown, fallback: string) => (err instanceof Error && err.message.trim() ? err.message : fallback)

/**
 * Reads `load()` for `key`. `load` may change identity on every render: only `key` (and `reload`) start a read, so `key`
 * must name every parameter `load` uses.
 */
export function useGoogleRead<T>(key: string | null, load: () => Promise<T>, options: GoogleReadOptions = {}): GoogleReadState<T> {
  const { keepPrevious = false, cache: useCache = true, fallbackError = 'Nexus could not load this from Google Ads.' } = options
  const loadRef = useRef(load)
  loadRef.current = load
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(() => {
    // Never on the server: the cache is the browser's (it is only ever filled in an effect).
    if (key == null || !useCache || typeof window === 'undefined') return null
    const hit = cachedGoogleRead<T>(googleReadCacheKey(key))
    return hit === undefined ? null : { key, data: hit, error: null }
  })
  const seq = useRef(0)
  // Set by `reload()`: the next read of this key goes past the cache.
  const force = useRef<string | null>(null)

  useEffect(() => {
    const mine = ++seq.current
    if (key == null) return
    const full = googleReadCacheKey(key)
    const forced = force.current === key
    force.current = null
    if (useCache && !forced) {
      const hit = cachedGoogleRead<T>(full)
      if (hit !== undefined) {
        setSettled({ key, data: hit, error: null })
        return
      }
    }
    sharedGoogleRead(full, () => loadRef.current())
      .then((data) => {
        if (useCache) rememberGoogleRead(full, data)
        if (seq.current === mine) setSettled({ key, data, error: null })
      })
      .catch((err: unknown) => {
        if (seq.current === mine) setSettled({ key, data: null, error: messageOf(err, fallbackError) })
      })
  }, [key, attempt, useCache, fallbackError])

  const reload = useCallback(() => {
    if (key == null) return
    forgetGoogleReads(googleReadCacheKey(key))
    force.current = key
    // Loading again: the failed (or old) answer of this key leaves the screen until the new one comes.
    setSettled((s) => (s?.key === key ? null : s))
    setAttempt((n) => n + 1)
  }, [key])

  if (key == null) return { data: null, error: null, loading: false, reload }
  const current = settled?.key === key ? settled : null
  if (current) return { data: current.data, error: current.error, loading: false, reload }
  const previous = keepPrevious && settled && settled.error == null ? settled.data : null
  return { data: previous, error: null, loading: true, reload }
}
