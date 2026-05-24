/**
 * EH.8 — Cross-tab click→FCP measurement for /edit's "open in new
 * tab" buttons.
 *
 * Because the buttons use `<a target="_blank">`, the click and the
 * subsequent first-contentful-paint happen in two different document
 * contexts. We bridge them with `localStorage` (same-origin shared
 * across tabs in the same browser profile):
 *
 *   parent /edit:        markClick(button, productId)
 *                        ↓ writes { button, productId, t } to LS
 *   <new tab opens>
 *   target page mounts:  reportFromTarget(button)
 *                        ↓ reads LS, matches productId+button,
 *                          waits for first FCP, logs delta, cleans up
 *
 * The keying on button+productId tolerates the rare race where the
 * operator clicks two buttons in quick succession before the first
 * report runs — each new-tab still picks up the right click mark.
 *
 * Output is `console.info` in development only. In production the
 * report runs but logs nothing (the hook is still useful if we wire
 * it to an analytics endpoint later; that wiring is intentionally
 * out of scope for EH.8).
 */

'use client'

export type NewTabButton = 'datasheet' | 'flatFile' | 'recover'

interface ClickMark {
  button: NewTabButton
  productId: string
  /** Date.now() at click time. Comparable across tabs since both use wall-clock. */
  t: number
}

function storageKey(button: NewTabButton, productId: string): string {
  return `eh:click:${button}:${productId}`
}

/**
 * Called by the parent /edit page on anchor click. Writes a tiny
 * marker that the new tab will read on mount. Safe to call from
 * server components — guarded against missing window.
 */
export function markClick(button: NewTabButton, productId: string): void {
  if (typeof window === 'undefined') return
  try {
    const payload: ClickMark = { button, productId, t: Date.now() }
    window.localStorage.setItem(storageKey(button, productId), JSON.stringify(payload))
  } catch {
    // LocalStorage can throw in private-browsing / quota-exceeded /
    // sandbox scenarios. Telemetry isn't worth failing the click for.
  }
}

/**
 * Called by the target page on mount. Reads the click mark (if any),
 * waits for the document's first FCP, computes the delta, and logs
 * it in development. Deletes the mark so it doesn't double-report
 * on subsequent reloads.
 */
export function reportFromTarget(button: NewTabButton, productId: string): void {
  if (typeof window === 'undefined') return
  const key = storageKey(button, productId)
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(key)
  } catch {
    return
  }
  if (!raw) return

  let mark: ClickMark
  try {
    mark = JSON.parse(raw) as ClickMark
  } catch {
    try { window.localStorage.removeItem(key) } catch {}
    return
  }

  // Defence in depth — only consume marks that match what we're
  // reporting. Anything stale (>30 s) is presumed orphaned (e.g.
  // operator opened the tab, walked away, refresh later).
  const STALE_MS = 30_000
  if (mark.button !== button || mark.productId !== productId) return
  if (Date.now() - mark.t > STALE_MS) {
    try { window.localStorage.removeItem(key) } catch {}
    return
  }

  // Resolve FCP via PerformanceObserver. If FCP already fired by the
  // time we observe (common after hydration), check existing entries
  // synchronously. Either path computes the same click→FCP delta.
  const consumeAndLog = (fcpAtMs: number) => {
    const deltaMs = fcpAtMs - mark.t
    try { window.localStorage.removeItem(key) } catch {}
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.info(
        `[EH] ${button} click→FCP: ${deltaMs.toFixed(0)}ms ` +
          `(productId=${productId.slice(0, 8)}…)`,
      )
    }
    // Hook a global event the user (or a dashboard widget) can listen
    // for. Lets EH.10's verification step record numbers without
    // coupling to a specific analytics SDK.
    window.dispatchEvent(
      new CustomEvent('eh:perf:newTabClick', {
        detail: { button, productId, deltaMs, clickAtMs: mark.t, fcpAtMs },
      }),
    )
  }

  // FCP already happened?
  const existing = performance.getEntriesByType('paint')
    .find((e) => e.name === 'first-contentful-paint')
  if (existing) {
    consumeAndLog(mark.t + (Date.now() - mark.t) - (performance.now() - existing.startTime))
    return
  }

  // Not yet — observe.
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          observer.disconnect()
          // Convert performance.now (monotonic, ms since navigation)
          // back to wall-clock by anchoring on Date.now() at observe
          // time minus performance.now() at observe time.
          const wallClockNow = Date.now()
          const monotonicNow = performance.now()
          const fcpWallClock = wallClockNow - (monotonicNow - entry.startTime)
          consumeAndLog(fcpWallClock)
          return
        }
      }
    })
    observer.observe({ type: 'paint', buffered: true })
  } catch {
    // PerformanceObserver unavailable — fall back to "now" so the
    // delta is at least an upper-bound. Better than silently dropping.
    consumeAndLog(Date.now())
  }
}
