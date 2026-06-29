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
import Link from 'next/link'
import { Search, Sun, Moon, Monitor, ChevronDown } from 'lucide-react'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { getBackendUrl } from '@/lib/backend-url'
import { useTheme } from '@/lib/theme/use-theme'
import { useRecentlyViewed } from '@/lib/use-recently-viewed'
import { AppRail } from './AppRail'
import { buildAppNav, type SidebarCounts, type Connections } from './app-nav'

function dispatchCmdK() {
  window.dispatchEvent(new CustomEvent('nexus:open-command-palette'))
}

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

  // ── Chrome: theme toggle, recently-viewed (persisted collapse) ──
  const { mode, cycleTheme } = useTheme()
  const ThemeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  const themeLabel =
    mode === 'light'
      ? 'Switch to dark mode'
      : mode === 'dark'
        ? 'Switch to system theme'
        : 'Switch to light mode'

  const recent = useRecentlyViewed()
  // useRecentlyViewed reads localStorage, so it returns [] on the server but
  // real items on the client's first render — a hydration mismatch. Gate the
  // list on `mounted` so SSR and first client render agree (show the empty
  // state), then populate after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [recentCollapsed, setRecentCollapsed] = useState(false)
  useEffect(() => {
    try {
      setRecentCollapsed(
        localStorage.getItem('nexus.sidebar.recentCollapsed') === '1',
      )
    } catch {
      /* ignore */
    }
  }, [])
  const toggleRecent = useCallback(() => {
    setRecentCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem('nexus.sidebar.recentCollapsed', next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const header = (
    <>
      <div className="h10-railctl">
        <button
          type="button"
          className="h10-railbtn"
          onClick={cycleTheme}
          title={themeLabel}
          aria-label={themeLabel}
        >
          <ThemeIcon size={16} />
        </button>
        <button
          type="button"
          className="h10-railbtn"
          onClick={dispatchCmdK}
          title="Search (⌘K)"
          aria-label="Search"
        >
          <Search size={16} />
        </button>
      </div>
      <button type="button" className="h10-ws">
        <span className="h10-ws-txt">
          <span className="nm">Xavia Racing</span>
          <span className="sub">Workspace</span>
        </span>
        <ChevronDown size={14} className="h10-ws-chev" aria-hidden="true" />
      </button>
    </>
  )

  const footer = (
    <>
      <div className="h10-recent">
        <button
          type="button"
          className="h10-recent-hd"
          onClick={toggleRecent}
          aria-expanded={!recentCollapsed}
        >
          <span>Recently viewed</span>
          <ChevronDown
            size={13}
            className={`h10-recent-chev ${recentCollapsed ? '' : 'open'}`}
            aria-hidden="true"
          />
        </button>
        {!recentCollapsed && (
          <ul className="h10-recent-list">
            {!mounted || recent.length === 0 ? (
              <li className="h10-recent-empty">No recent items</li>
            ) : (
              recent.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className="h10-recent-link" title={item.label}>
                    {item.label}
                  </Link>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      <button type="button" className="h10-user">
        <span className="h10-user-av">A</span>
        <span className="h10-user-txt">
          <span className="nm">Awa</span>
          <span className="sub">Xavia Racing</span>
        </span>
      </button>
    </>
  )

  const navItems = buildAppNav(counts, conn)

  return (
    <AppRail
      navItems={navItems}
      brand={{ mark: 'N', name: 'Nexus' }}
      header={header}
      footer={footer}
    />
  )
}
