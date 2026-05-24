/**
 * EH.7 — Mount-warm + hover-warm cache prefetch for the /edit
 * header's "open in new tab" buttons (Datasheet / Flat File / Recover).
 *
 * The buttons now open `<a target="_blank">` anchors, which means the
 * new tab cannot benefit from Next.js's client-side route prefetch —
 * it's a fresh document. The only way to make the new tab feel
 * instant is to pre-warm the *backend* API caches the new tab will
 * hit during SSR. Both warm paths exercise endpoints that EH.4 added
 * a server-side TTL cache to:
 *
 *   • /api/products/:id/health         — 30 s server cache (Recover)
 *   • /api/amazon/flat-file/template   —  5 min server cache (Flat File)
 *   • /api/amazon/flat-file/rows       — bounded DB query (Flat File)
 *   • /api/products/:id/recover/events — cheap, but still worth pinging
 *
 * Mount-warm fires once on /edit mount with `priority: 'low'` so it
 * doesn't compete with the page's own data fetch. Hover-warm fires
 * on the anchor's mouseenter/focus at normal priority — the operator
 * has signalled intent and we want the click→FCP delta minimised.
 *
 * Datasheet is intentionally not warmed: its page.tsx hits Prisma
 * directly on the server, with no API surface to populate. Suspense
 * streaming (EH.6) is what makes Datasheet feel fast.
 */

'use client'

import { useCallback, useEffect, useRef } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface UseHeaderPrefetchOptions {
  productId: string
  /** Master product type, e.g. 'OUTERWEAR'. Used for the Flat File template URL. */
  productType?: string | null
  /** Family root id (parentId ?? productId) — Flat File rows query. */
  familyId?: string
  /** Marketplace code for the Flat File buttons. Defaults to 'IT'. */
  marketplace?: string
}

interface HeaderPrefetchHandlers {
  /** Attach to onMouseEnter/onFocus on the Datasheet anchor. (No-op today — Datasheet uses Prisma directly.) */
  onHoverDatasheet: () => void
  /** Attach to onMouseEnter/onFocus on the Flat File anchor. */
  onHoverFlatFile: () => void
  /** Attach to onMouseEnter/onFocus on the Recover anchor. */
  onHoverRecover: () => void
}

// Per-tab dedupe. Surviving component remounts is the point — opening
// /edit, navigating away, and back shouldn't re-warm what we already
// warmed seconds earlier. A simple Set is enough; we don't need
// per-key TTL because the underlying API caches have their own
// (health 30 s, template 5 min) and refire if those expire.
const warmedThisSession = new Set<string>()

function alreadyWarmed(key: string): boolean {
  if (warmedThisSession.has(key)) return true
  warmedThisSession.add(key)
  return false
}

/**
 * Low-allocation fetch wrapper. We don't care about the response
 * body — we just want the server to populate its caches. `keepalive`
 * lets the request survive the tab navigation if the operator clicks
 * before the warm finishes.
 */
function warmFetch(
  url: string,
  signal: AbortSignal,
  priority: 'low' | 'auto' = 'auto',
): void {
  // `priority` is a Fetch Priority API hint. TS DOM lib lags so we
  // cast through Record. Browsers without support ignore the hint.
  const init: RequestInit & { priority?: 'low' | 'auto' | 'high' } = {
    method: 'GET',
    cache: 'no-store',
    keepalive: true,
    signal,
  }
  if (priority === 'low') init.priority = 'low'
  // Fire and forget. Errors are non-fatal — failed warms just mean
  // the user pays the full cold-cache cost on click. We swallow them
  // silently to avoid noisy console output in normal operation.
  void fetch(url, init).catch(() => undefined)
}

export function useHeaderPrefetch({
  productId,
  productType,
  familyId,
  marketplace = 'IT',
}: UseHeaderPrefetchOptions): HeaderPrefetchHandlers {
  const backend = getBackendUrl()
  const controllerRef = useRef<AbortController | null>(null)

  // Initialise the abort controller once. We tear down on unmount so
  // any in-flight warm doesn't keep the React fiber alive.
  if (controllerRef.current === null) {
    controllerRef.current = new AbortController()
  }

  // ── Mount-warm ──────────────────────────────────────────────────
  // Runs once per productId. Fires low-priority background requests
  // for the two slowest endpoints. Datasheet excluded — no API.
  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return
    const signal = controller.signal

    const healthKey = `health:${productId}`
    if (!alreadyWarmed(healthKey)) {
      warmFetch(
        `${backend}/api/products/${productId}/health`,
        signal,
        'low',
      )
    }

    const pt = (productType ?? 'OUTERWEAR').toUpperCase()
    const tmplKey = `flatFileTmpl:${marketplace}:${pt}`
    if (!alreadyWarmed(tmplKey)) {
      warmFetch(
        `${backend}/api/amazon/flat-file/template?marketplace=${marketplace}&productType=${pt}`,
        signal,
        'low',
      )
    }

    return () => {
      controller.abort()
      controllerRef.current = null
    }
    // marketplace + productType change so rarely (per-product) that
    // it's fine to refire on change; the dedupe Set still gates.
  }, [backend, productId, productType, marketplace])

  // ── Hover-warm — Flat File ──────────────────────────────────────
  // Fires both template + rows at normal priority. The template is
  // already mount-warmed but a second hit costs the server nothing
  // (cache hit). Rows isn't mount-warmed because it's family-scoped
  // and a no-op without a familyId for non-family products.
  const onHoverFlatFile = useCallback(() => {
    const signal = controllerRef.current?.signal
    if (!signal) return
    const pt = (productType ?? 'OUTERWEAR').toUpperCase()
    warmFetch(
      `${backend}/api/amazon/flat-file/template?marketplace=${marketplace}&productType=${pt}`,
      signal,
    )
    const rowsParams = new URLSearchParams({
      marketplace,
      productType: pt,
    })
    if (familyId) rowsParams.set('productId', familyId)
    warmFetch(
      `${backend}/api/amazon/flat-file/rows?${rowsParams.toString()}`,
      signal,
    )
  }, [backend, productType, marketplace, familyId])

  // ── Hover-warm — Recover ────────────────────────────────────────
  // Health is mount-warmed; this is a no-op for the server beyond a
  // cache touch. Events are cheap (~50 ms Prisma) but warming them
  // means the new tab's Promise.all() resolves both branches at
  // similar latency.
  const onHoverRecover = useCallback(() => {
    const signal = controllerRef.current?.signal
    if (!signal) return
    warmFetch(`${backend}/api/products/${productId}/health`, signal)
    warmFetch(`${backend}/api/products/${productId}/recover/events`, signal)
  }, [backend, productId])

  // Datasheet has no API surface to warm — its page.tsx pulls from
  // Prisma directly. Kept as a no-op so the handler shape stays
  // uniform with the other two buttons.
  const onHoverDatasheet = useCallback(() => {
    /* intentional no-op — see comment above */
  }, [])

  return { onHoverDatasheet, onHoverFlatFile, onHoverRecover }
}
