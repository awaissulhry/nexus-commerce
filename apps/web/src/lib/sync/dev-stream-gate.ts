/**
 * Dev-only gate for long-lived connections against a LOCAL backend.
 *
 * ## The measurement
 *
 * 2026-09-01, one fresh tab against the shared local API: **17 of 18 requests permanently pending**
 * on `http://127.0.0.1:8091`, while `curl` answered the same paths in ~1s. Reproduced from the page
 * itself — the identical request to the same server hung indefinitely on the app's origin and
 * returned 200 in 1.4s on a different host string, which is the signature of an exhausted
 * per-origin connection pool rather than a slow server.
 *
 * HTTP/1.1 allows ~6 connections per origin. Every SSE stream holds one open forever, and a poll
 * whose interval is shorter than the local API's response time stacks a second, third and fourth
 * copy of itself. Together they consume the pool, and everything else — a readiness read, a sheet
 * page — queues behind them and never runs. Production does not show this: the deployed API is
 * HTTP/2, where the limit does not apply the same way. It is a local-development pathology.
 *
 * ## The rule
 *
 * When the backend is local, long-lived streams are OFF by default so the pool stays free for the
 * requests a page actually needs to render. A toggle turns them back on for the passes that
 * specifically test live refresh.
 *
 * ```js
 * enableDevStreams(true)   // in the browser console, then reload — streams on
 * enableDevStreams(false)  // back to the default
 * ```
 *
 * Adoption is one line at each stream/poll: `useListingEvents(streamsEnabled())`. This file is the
 * mechanism only — it changes nothing on its own.
 */

import { getBackendUrl } from '@/lib/backend-url'

const TOGGLE_KEY = 'nexus:dev:streams'

/** Is the API this build talks to running on this machine? */
export function isLocalBackend(): boolean {
  try {
    const { hostname } = new URL(getBackendUrl())
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    // An unparseable backend URL is not a reason to disable anything.
    return false
  }
}

/**
 * Should long-lived streams open?
 *
 * `true` everywhere except a local backend, and `true` even there once the toggle is set — so
 * production and staging behaviour is completely unchanged, and a live-refresh test is one console
 * call away.
 */
export function streamsEnabled(): boolean {
  if (!isLocalBackend()) return true
  try {
    return window.localStorage.getItem(TOGGLE_KEY) === 'on'
  } catch {
    // Storage can throw (private mode, blocked site data). Default to the safe local behaviour.
    return false
  }
}

/** Flip the toggle. Returns the new value; reload for it to take effect. */
export function enableDevStreams(on: boolean): boolean {
  try {
    window.localStorage.setItem(TOGGLE_KEY, on ? 'on' : 'off')
  } catch {
    /* nothing to do — the getter already fails safe */
  }
  return on
}
