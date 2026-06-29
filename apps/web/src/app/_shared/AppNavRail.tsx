'use client'

/**
 * AppNavRail — the app-wide navigation container.
 *
 * Owns the live data (sidebar counts + channel connections) and resolves the
 * canonical nav via buildAppNav, then renders the presentational AppRail. This
 * is the component that replaces AppSidebar in AppShell's `sidebar` slot
 * (Phase 5); until then it is previewed at /products/next via ProductsRail.
 *
 * Data behaviour is ported verbatim from components/layout/AppSidebar.tsx so the
 * two never drift during the migration: counts poll every 60s + refetch on tab
 * focus + a 300ms-debounced refetch on listing/product mutation events.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { getBackendUrl } from '@/lib/backend-url'
import { AppRail } from './AppRail'
import { buildAppNav, type SidebarCounts, type Connections } from './app-nav'

export function AppNavRail() {
  const [counts, setCounts] = useState<SidebarCounts>({})
  const [conn, setConn] = useState<Connections>({ amazon: false, ebay: false })

  // Channel connection state (Amazon/eBay) — fetched once. The sidebar must
  // never crash the shell, so every fetch swallows errors.
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/connections`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        const list = (data.connections ?? []) as Array<{
          channel: string
          isActive: boolean
        }>
        setConn({
          amazon: list.some((c) => c.channel === 'AMAZON' && c.isActive),
          ebay: list.some((c) => c.channel === 'EBAY' && c.isActive),
        })
      })
      .catch(() => {
        /* swallow — sidebar must never crash the shell */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Counts — initial fetch + 60s poll + refetch on tab focus.
  const cancelledRef = useRef(false)
  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/sidebar/counts`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = (await res.json()) as SidebarCounts
      if (!cancelledRef.current) setCounts(data)
    } catch {
      /* sidebar should never crash the shell */
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    fetchCounts()
    const id = window.setInterval(fetchCounts, 60_000)
    const onFocus = () => fetchCounts()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelledRef.current = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchCounts])

  // Refresh counts within ~300ms of any listing/product mutation (trailing-edge
  // debounce coalesces bursts) instead of waiting for the next 60s tick.
  const refetchTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (refetchTimerRef.current !== null) {
        window.clearTimeout(refetchTimerRef.current)
        refetchTimerRef.current = null
      }
    },
    [],
  )
  const debouncedRefetch = useCallback(() => {
    if (typeof window === 'undefined') return
    if (refetchTimerRef.current !== null) {
      window.clearTimeout(refetchTimerRef.current)
    }
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null
      void fetchCounts()
    }, 300)
  }, [fetchCounts])
  useInvalidationChannel(
    [
      'listing.created',
      'listing.deleted',
      'wizard.submitted',
      'bulk-job.completed',
      'product.created',
      'product.deleted',
    ],
    debouncedRefetch,
  )

  const navItems = buildAppNav(counts, conn)

  return (
    <AppRail
      navItems={navItems}
      brand={{ mark: 'N', name: 'Nexus' }}
      footer="Products · rebuild"
    />
  )
}
