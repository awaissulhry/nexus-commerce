'use client'

// FULFILLMENT B.7 — Returns. RMA → receive → inspect (condition grade) → restock or scrap → refund.
// Manual refund default (per user choice — they recheck before restock); auto-refund opt-in via toggle.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Undo2, Plus, X, CheckCircle2, Package, Search, Download,
  ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight,
  ArrowDownToLine, Copy, Mail, Tag, Trash2, Truck, ArrowUp, ArrowDown,
  Bookmark, Star, Ban, AlertTriangle, RotateCw, Activity,
  Camera, Image as ImageIcon, Save, Keyboard, TrendingUp, Calendar,
} from 'lucide-react'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import {
  AutoRefreshSelect,
  DensityToggle as SharedDensityToggle,
  GridToolbar,
  KeyboardShortcutsModal,
  KpiStrip,
  type AutoRefreshInterval,
  type Density,
  type KpiTileSpec,
  type ShortcutGroup,
} from '@/app/_shared/grid-lens'
import PageHeader from '@/components/layout/PageHeader'
import {
  MultiSelectChips,
  ACTIVE_CHANNELS_OPTIONS,
} from '@/components/ui/MultiSelectChips'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Barcode128 } from '@/components/ui/Barcode128'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useInboundEvents } from '@/lib/sync/use-inbound-events'
import { useOutboundEvents } from '@/lib/sync/use-outbound-events'
import { useListingEvents } from '@/lib/sync/use-listing-events'
// RX.0 — domain types + tone/label constants now live in the shared
// returns module so the command center, policies page, and analytics
// import one canonical set (no per-surface drift).
import {
  ACTION_LABEL,
  CHANNEL_TONE,
  STATUS_TONE,
  STATUSES,
  type AuditEntry,
  type ItemChecklist,
  type RefundDeadlineView,
  type RefundRow,
  type ResolvedPolicyView,
  type ReturnFull,
  type ReturnRow,
  type SavedView,
} from '@/app/_shared/returns'
import CommandCenter from './CommandCenter'

export default function ReturnsWorkspace() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const askConfirm = useConfirm()

  // R1.1 — URL-driven filters. Each filter has a default value;
  // the URL only carries non-defaults so links stay short and the
  // back button lands on a meaningful previous state.
  const tab = (searchParams.get('tab') ?? 'ALL') as 'ALL' | 'NON_FBA' | 'FBA'
  const statusFilter = searchParams.get('status') ?? 'ALL'
  // RX.1 — named urgency queue from a command-center tile. Mutually
  // exclusive with statusFilter at the UI level (selecting one clears
  // the other) so the grid never carries two conflicting status filters.
  const queueFilter = searchParams.get('queue') ?? ''
  const channelFilter = searchParams.get('channel') ?? ''
  const search = searchParams.get('q') ?? ''
  const sortBy = searchParams.get('sortBy') ?? 'createdAt'
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'
  const page = Math.max(1, Number(searchParams.get('page')) || 1)
  const pageSize = Math.min(200, Math.max(10, Number(searchParams.get('pageSize')) || 50))

  const setFilters = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '' || v === 'ALL') next.delete(k)
        else next.set(k, v)
      }
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams],
  )

  // Debounced search — local mirror of the URL `q`, push to URL
  // 250ms after typing-quiet so we don't refire the list query on
  // every keystroke.
  const [searchInput, setSearchInput] = useState(search)
  useEffect(() => { setSearchInput(search) }, [search])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const onSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setFilters({ q: value, page: '1' })
    }, 250)
  }, [setFilters])

  const [items, setItems] = useState<ReturnRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === 'undefined') return 'comfortable'
    const v = window.localStorage.getItem('returns.density') as Density | null
    return v === 'compact' || v === 'comfortable' || v === 'spacious' ? v : 'comfortable'
  })
  useEffect(() => { try { window.localStorage.setItem('returns.density', density) } catch {} }, [density])
  const [autoRefreshMin, setAutoRefreshMin] = useState<AutoRefreshInterval>(() => {
    if (typeof window === 'undefined') return 0
    const n = Number(window.localStorage.getItem('returns.autoRefreshMin'))
    return (n === 5 || n === 15) ? n : 0
  })
  useEffect(() => { try { window.localStorage.setItem('returns.autoRefreshMin', String(autoRefreshMin)) } catch {} }, [autoRefreshMin])
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [viewsOpen, setViewsOpen] = useState(false)
  // R1.2 — bulk selection. Cleared on filter/sort/page change so
  // hidden selections can't accidentally apply on a different page.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  // R1.3 — keyboard list nav. -1 = no row highlighted.
  const [activeIdx, setActiveIdx] = useState(-1)

  type Analytics = {
    windowDays: number
    last30: number
    prior30: number
    trendPct: number | null
    byChannel: Array<{ channel: string; count: number }>
    topReasons: Array<{ reason: string; count: number }>
    fbaCount: number
    warehouseCount: number
    totalCount: number
  }
  const [analytics, setAnalytics] = useState<Analytics | null>(null)

  // O.53: read create-from-URL params. The outbound drawer (O.21)
  // links here as /fulfillment/returns?new=1&orderId=X — open the
  // modal auto-prefilled.
  const prefillOrderId = useMemo(() => searchParams.get('orderId'), [searchParams])
  const prefillNew = useMemo(() => searchParams.get('new') === '1' || !!prefillOrderId, [searchParams, prefillOrderId])
  useEffect(() => {
    if (prefillNew) setCreateOpen(true)
  }, [prefillNew])

  // After the modal closes (whether via cancel or successful create),
  // strip the new/orderId params so a refresh doesn't re-open it.
  const closeCreate = useCallback(() => {
    setCreateOpen(false)
    if (prefillNew) {
      const next = new URLSearchParams(searchParams.toString())
      next.delete('new')
      next.delete('orderId')
      router.replace(`?${next.toString()}`, { scroll: false })
    }
  }, [prefillNew, searchParams, router])

  const fetchReturns = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (statusFilter !== 'ALL') qs.set('status', statusFilter)
      if (queueFilter) qs.set('queue', queueFilter)
      if (channelFilter) qs.set('channel', channelFilter)
      if (tab === 'FBA') qs.set('fbaOnly', 'true')
      else if (tab === 'NON_FBA') qs.set('fbaOnly', 'false')
      if (search.trim()) qs.set('q', search.trim())
      qs.set('sortBy', sortBy)
      qs.set('sortDir', sortDir)
      qs.set('page', String(page))
      qs.set('pageSize', String(pageSize))
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns?${qs.toString()}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setLastFetchedAt(Date.now())
      }
    } finally { setLoading(false) }
  }, [tab, statusFilter, queueFilter, channelFilter, search, sortBy, sortDir, page, pageSize])

  useEffect(() => { fetchReturns() }, [fetchReturns])

  // F-RT.1 — open SSE pipes so the returns list refreshes when
  // upstream signals change: a refund webhook from Shopify, a status
  // flip on the originating order, an inbound shipment recording the
  // returned units back into stock. The hook returns are unused;
  // mounting opens the EventSources as side effects. Refresh is
  // driven by useInvalidationChannel below.
  useListingEvents()
  useInboundEvents()
  useOutboundEvents()
  useInvalidationChannel(
    [
      // Outbound: a shipment update may trigger a return (RTO / refused
      // delivery). order.shipped resets the no-returns timer.
      'shipment.updated', 'shipment.deleted', 'order.shipped',
      // Inbound: returned goods land back as an inbound.received row.
      'inbound.received', 'inbound.updated',
      // Listing/product: status flip or price change can re-classify a
      // pending refund (refund value changes if base price changed).
      'listing.updated', 'product.updated',
    ],
    useCallback(() => { fetchReturns() }, [fetchReturns]),
  )

  // R1.1 — saved views (reuse existing /api/saved-views with surface=returns).
  const fetchSavedViews = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views?surface=returns`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setSavedViews((data.items ?? []) as SavedView[])
      }
    } catch { /* non-fatal */ }
  }, [])
  useEffect(() => { fetchSavedViews() }, [fetchSavedViews])

  const currentFiltersJson = useMemo(
    () => ({ tab, status: statusFilter, channel: channelFilter, q: search, sortBy, sortDir, pageSize }),
    [tab, statusFilter, channelFilter, search, sortBy, sortDir, pageSize],
  )
  const applyView = useCallback((view: SavedView) => {
    const f = view.filters as any
    setFilters({
      tab: f.tab ?? null,
      status: f.status ?? null,
      channel: f.channel ?? null,
      q: f.q ?? null,
      sortBy: f.sortBy ?? null,
      sortDir: f.sortDir ?? null,
      pageSize: f.pageSize ? String(f.pageSize) : null,
      page: '1',
    })
    setViewsOpen(false)
  }, [setFilters])
  const saveView = useCallback(async () => {
    const name = window.prompt('Save current filters as:')
    if (!name?.trim()) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface: 'returns', name: name.trim(), filters: currentFiltersJson }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Save failed')
        return
      }
      toast.success(`Saved view “${name}”`)
      void fetchSavedViews()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    }
  }, [currentFiltersJson, fetchSavedViews, toast])
  const deleteView = useCallback(async (view: SavedView) => {
    const ok = await askConfirm({
      title: `Delete saved view “${view.name}”?`,
      description: 'Other operators using this view will lose it.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views/${view.id}`, { method: 'DELETE' })
      if (!res.ok) { toast.error('Delete failed'); return }
      toast.success('Saved view deleted')
      void fetchSavedViews()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [askConfirm, fetchSavedViews, toast])

  // R1.1 — clickable column headers. Click toggles direction;
  // clicking a different column resets to desc.
  const onSort = useCallback((col: string) => {
    if (sortBy === col) setFilters({ sortDir: sortDir === 'asc' ? 'desc' : 'asc', page: '1' })
    else setFilters({ sortBy: col, sortDir: 'desc', page: '1' })
  }, [sortBy, sortDir, setFilters])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // R1.2 — clear selection whenever the visible rows change.
  useEffect(() => { setSelected(new Set()); setActiveIdx(-1) }, [tab, statusFilter, queueFilter, channelFilter, search, sortBy, sortDir, page, pageSize])
  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])
  const allOnPageSelected = items.length > 0 && items.every((r) => selected.has(r.id))
  const toggleAllOnPage = useCallback(() => {
    setSelected((prev) => {
      if (allOnPageSelected) {
        const next = new Set(prev)
        for (const r of items) next.delete(r.id)
        return next
      }
      const next = new Set(prev)
      for (const r of items) next.add(r.id)
      return next
    })
  }, [allOnPageSelected, items])

  const runBulk = useCallback(async (
    path: 'approve' | 'deny' | 'receive',
    confirmCopy?: { title: string; description: string; tone?: 'danger' | 'warning' | 'info' },
  ) => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    if (confirmCopy) {
      const ok = await askConfirm({
        title: confirmCopy.title,
        description: confirmCopy.description,
        confirmLabel: 'Confirm',
        tone: confirmCopy.tone,
      })
      if (!ok) return
    }
    setBulkBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/bulk/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? `Bulk ${path} failed`); return }
      toast.success(`${data.ok ?? 0} updated${data.failed ? ` · ${data.failed} skipped` : ''}`)
      setSelected(new Set())
      void fetchReturns()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Bulk ${path} failed`)
    } finally {
      setBulkBusy(false)
    }
  }, [selected, askConfirm, toast, fetchReturns])

  const exportCsv = useCallback(() => {
    const qs = new URLSearchParams()
    if (statusFilter !== 'ALL') qs.set('status', statusFilter)
    if (channelFilter) qs.set('channel', channelFilter)
    if (tab === 'FBA') qs.set('fbaOnly', 'true')
    else if (tab === 'NON_FBA') qs.set('fbaOnly', 'false')
    if (search.trim()) qs.set('q', search.trim())
    window.open(`${getBackendUrl()}/api/fulfillment/returns/export.csv?${qs.toString()}`, '_blank')
  }, [statusFilter, channelFilter, tab, search])

  // R1.3 — Cmd+K page event listeners.
  useEffect(() => {
    const onNew = () => setCreateOpen(true)
    const onExport = () => exportCsv()
    const onFocus = () => searchInputRef.current?.focus()
    const onFilterPending = () => setFilters({ status: 'REQUESTED', queue: null, page: '1' })
    window.addEventListener('nexus:returns:new', onNew)
    window.addEventListener('nexus:returns:export', onExport)
    window.addEventListener('nexus:returns:focus-search', onFocus)
    window.addEventListener('nexus:returns:filter-pending', onFilterPending)
    return () => {
      window.removeEventListener('nexus:returns:new', onNew)
      window.removeEventListener('nexus:returns:export', onExport)
      window.removeEventListener('nexus:returns:focus-search', onFocus)
      window.removeEventListener('nexus:returns:filter-pending', onFilterPending)
    }
  }, [exportCsv, setFilters])

  // R1.3 — list keyboard navigation (j/k/Enter/Esc/x/⌘N//).
  useEffect(() => {
    const isTyping = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null
      if (!t) return false
      const tag = t.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault(); setCreateOpen(true); return
      }
      if (e.key === 'Escape') {
        if (drawerId) { setDrawerId(null); return }
        if (createOpen) { setCreateOpen(false); return }
        if (viewsOpen) { setViewsOpen(false); return }
      }
      if (isTyping(e)) return
      if (e.key === '/') {
        e.preventDefault(); searchInputRef.current?.focus(); return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (items.length === 0) return
        e.preventDefault()
        setActiveIdx((i) => Math.min(items.length - 1, (i < 0 ? -1 : i) + 1))
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        if (items.length === 0) return
        e.preventDefault()
        setActiveIdx((i) => Math.max(0, (i < 0 ? 0 : i) - 1))
        return
      }
      if (e.key === 'Enter') {
        if (activeIdx >= 0 && activeIdx < items.length) {
          e.preventDefault(); setDrawerId(items[activeIdx].id)
        }
        return
      }
      if (e.key === 'x' || e.key === 'X') {
        if (activeIdx >= 0 && activeIdx < items.length) {
          e.preventDefault(); toggleOne(items[activeIdx].id)
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, activeIdx, drawerId, createOpen, viewsOpen, toggleOne])

  // O.76: parallel KPI fetch. Same trigger as the list so it stays
  // in sync (e.g., creating a new return bumps the last30 count).
  // Failures are silent — the strip just doesn't render rather
  // than blocking the workspace.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/returns/analytics`,
          { cache: 'no-store' },
        )
        if (!res.ok || cancelled) return
        const data = (await res.json()) as Analytics
        if (!cancelled) setAnalytics(data)
      } catch {
        /* non-fatal */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [items.length])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Returns"
        description="Receive, inspect, refund, and restock customer returns. FBA returns mirrored read-only from Amazon."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Returns' }]}
      />

      {/* O.76: KPI strip. Last-30-day count + trend, FBA vs warehouse
          split, top channel, top reason. Now uses the shared KpiStrip
          for visual parity with the other grid workspaces. Stays
          visible across the tab/status filters because it's a summary
          of the whole surface, not the filtered slice. */}
      {analytics && analytics.totalCount > 0 && (
        <KpiStrip
          tiles={[
            {
              icon: Calendar,
              label: 'Last 30 days',
              value: analytics.last30.toLocaleString(),
              detail: analytics.trendPct != null
                ? `${analytics.trendPct > 0 ? '+' : ''}${analytics.trendPct.toFixed(0)}% vs prior 30d`
                : undefined,
              tone: analytics.trendPct != null && analytics.trendPct > 5
                ? 'rose'
                : analytics.trendPct != null && analytics.trendPct < -5
                ? 'emerald'
                : 'slate',
            },
            {
              icon: Package,
              label: 'Total returns',
              value: analytics.totalCount.toLocaleString(),
              detail: `${analytics.warehouseCount} warehouse · ${analytics.fbaCount} FBA`,
              tone: 'slate',
            },
            {
              icon: TrendingUp,
              label: 'Top channel (30d)',
              value: analytics.byChannel[0]?.channel ?? '—',
              detail: analytics.byChannel[0]
                ? `${analytics.byChannel[0].count} of ${analytics.last30}`
                : undefined,
              tone: 'blue',
            },
            {
              icon: AlertTriangle,
              label: 'Top reason (30d)',
              value: analytics.topReasons[0]?.reason ?? '—',
              detail: analytics.topReasons[0]
                ? `${analytics.topReasons[0].count} return${analytics.topReasons[0].count === 1 ? '' : 's'}`
                : undefined,
              tone: 'amber',
            },
          ] satisfies KpiTileSpec[]}
        />
      )}

      {/* RX.1 — command center: urgency queues + refund-deadline SLA +
          aging + channel health. Clicking a queue tile drives the grid
          filter below; reloadSignal re-pulls counts whenever the list
          refetches so the numbers and the grid never disagree. */}
      <CommandCenter
        activeQueue={queueFilter || null}
        onQueue={(qv) => setFilters({ queue: qv === queueFilter ? null : qv, status: null, page: '1' })}
        reloadSignal={lastFetchedAt ?? 0}
        onOpenReturn={(rid) => setDrawerId(rid)}
      />

      <div className="space-y-2">
        {/* Top row: search + tab + saved-views + actions */}
        <GridToolbar
          searchSlot={
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="search"
                value={searchInput}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="RMA, order, customer, tracking…   /"
                className="h-8 w-72 pl-8 pr-2 text-base border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:ring-1 focus:ring-slate-400"
              />
            </div>
          }
          quickFilterSlot={
            <div className="inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5">
              {(['ALL', 'NON_FBA', 'FBA'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setFilters({ tab: t === 'ALL' ? null : t, page: '1' })}
                  className={`h-7 px-3 text-base font-medium rounded transition-colors ${tab === t ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'}`}
                >
                  {t === 'NON_FBA' ? 'Warehouse' : t === 'FBA' ? 'FBA (read-only)' : 'All'}
                </button>
              ))}
            </div>
          }
          density={<SharedDensityToggle density={density} onChange={setDensity} />}
          autoRefresh={
            <AutoRefreshSelect
              value={autoRefreshMin}
              onChange={setAutoRefreshMin}
              onTick={fetchReturns}
            />
          }
          freshness={
            <FreshnessIndicator
              lastFetchedAt={lastFetchedAt}
              onRefresh={fetchReturns}
              loading={loading}
            />
          }
          savedViews={
            /* Saved views dropdown */
            <div className="relative">
            <button
              onClick={() => setViewsOpen((v) => !v)}
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            >
              <Bookmark size={12} /> Views{savedViews.length > 0 ? ` (${savedViews.length})` : ''}
            </button>
            {viewsOpen && (
              <div className="absolute z-20 mt-1 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg p-2">
                {savedViews.length === 0 ? (
                  <div className="text-sm text-slate-500 dark:text-slate-400 px-2 py-1.5">No saved views yet.</div>
                ) : (
                  <div className="max-h-60 overflow-y-auto">
                    {savedViews.map((v) => (
                      <div key={v.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 rounded">
                        <button
                          onClick={() => applyView(v)}
                          className="flex-1 text-left text-base text-slate-800 dark:text-slate-200 truncate"
                          title={`Apply view: ${v.name}`}
                        >
                          {v.isDefault && <Star size={11} className="inline -mt-0.5 mr-1 text-amber-500" />}
                          {v.name}
                        </button>
                        <button
                          onClick={() => deleteView(v)}
                          className="h-6 w-6 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-rose-600"
                          title="Delete view"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="border-t border-slate-100 dark:border-slate-800 mt-1 pt-1">
                  <button
                    onClick={() => { setViewsOpen(false); void saveView() }}
                    className="w-full text-left text-sm text-blue-700 dark:text-blue-300 px-2 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded inline-flex items-center gap-1.5"
                  >
                    <Plus size={11} /> Save current filters as…
                  </button>
                </div>
              </div>
            )}
          </div>
          }
          shortcuts={
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
            >
              <Keyboard size={12} />
            </button>
          }
          trailingSlot={
            <>
              <a
                href="/fulfillment/returns/analytics"
                className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <Activity size={12} /> Analytics
              </a>
              <button
                onClick={exportCsv}
                className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
                title="Export current filtered set as CSV"
              >
                <Download size={12} /> Export
              </button>
              <button onClick={() => setCreateOpen(true)} className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5">
                <Plus size={12} /> New return
              </button>
            </>
          }
        />

        {/* Filter chips row: status + channel */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Status</span>
          <div className="flex items-center gap-1 flex-wrap">
            {(STATUSES as readonly string[]).map((s) => (
              <button
                key={s}
                onClick={() => setFilters({ status: s, queue: null, page: '1' })}
                className={`h-7 px-2 text-sm border rounded ${statusFilter === s && !queueFilter ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
              >
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          {/* U.67 — channel filter migrated to the shared MultiSelectChips
              primitive. Single-select because the returns backend filters
              on a single channel column. */}
          <MultiSelectChips
            label="Channel"
            mode="single"
            options={ACTIVE_CHANNELS_OPTIONS}
            value={channelFilter ? [channelFilter] : []}
            onChange={(next) =>
              setFilters({ channel: next[0] ?? null, page: '1' })
            }
          />
        </div>
      </div>

      {/* R1.2 — bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 dark:bg-slate-100 text-white rounded-md text-base">
          <span className="font-medium tabular-nums">{selected.size} selected</span>
          <button
            onClick={() => setSelected(new Set())}
            className="h-7 px-2 text-sm text-slate-300 dark:text-slate-600 hover:text-white inline-flex items-center gap-1"
          >
            <X size={11} /> Clear
          </button>
          <div className="ml-auto flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => runBulk('approve')}
              disabled={bulkBusy}
              className="h-7 px-2.5 text-sm bg-emerald-600 dark:bg-emerald-700 hover:bg-emerald-500 rounded inline-flex items-center gap-1 disabled:opacity-50"
            >
              <CheckCircle2 size={11} /> Approve
            </button>
            <button
              onClick={() => runBulk('receive')}
              disabled={bulkBusy}
              className="h-7 px-2.5 text-sm bg-blue-600 dark:bg-blue-700 hover:bg-blue-500 rounded inline-flex items-center gap-1 disabled:opacity-50"
            >
              <ArrowDownToLine size={11} /> Mark received
            </button>
            <button
              onClick={() => runBulk('deny', {
                title: `Deny ${selected.size} return${selected.size === 1 ? '' : 's'}?`,
                description: 'This will mark them REJECTED. The customer will need to re-request if they still want a return.',
                tone: 'danger',
              })}
              disabled={bulkBusy}
              className="h-7 px-2.5 text-sm bg-rose-600 hover:bg-rose-500 rounded inline-flex items-center gap-1 disabled:opacity-50"
            >
              <Ban size={11} /> Deny
            </button>
          </div>
        </div>
      )}

      {loading && items.length === 0 ? (
        <Card><div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center">Loading returns…</div></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Undo2}
          title={search || statusFilter !== 'ALL' || channelFilter ? 'No matches' : 'No returns'}
          description={search || statusFilter !== 'ALL' || channelFilter
            ? 'No returns match the current filters. Clear filters or adjust your search.'
            : 'Returns from Amazon FBA mirror automatically. Non-FBA returns are created when customers request RMAs.'}
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleAllOnPage}
                      className="h-4 w-4 cursor-pointer accent-slate-900"
                      aria-label={allOnPageSelected ? 'Deselect all on page' : 'Select all on page'}
                    />
                  </th>
                  <SortHeader col="rmaNumber"  sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-left">RMA</SortHeader>
                  <SortHeader col="channel"    sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-left">Channel</SortHeader>
                  <SortHeader col="status"     sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-left">Status</SortHeader>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">Items</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">Reason</th>
                  <SortHeader col="refundCents" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-right">Refund</SortHeader>
                  <SortHeader col="createdAt"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-left">Created</SortHeader>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, idx) => (
                  <tr
                    key={r.id}
                    onClick={() => setDrawerId(r.id)}
                    onMouseEnter={() => setActiveIdx(idx)}
                    ref={(el) => {
                      if (el && idx === activeIdx) el.scrollIntoView({ block: 'nearest' })
                    }}
                    className={`border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer ${
                      selected.has(r.id) ? 'bg-blue-50/40' : ''
                    } ${idx === activeIdx ? 'ring-1 ring-inset ring-slate-900' : ''}`}
                  >
                    <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleOne(r.id)}
                        className="h-4 w-4 cursor-pointer accent-slate-900"
                        aria-label={`Select ${r.rmaNumber ?? r.id}`}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-base text-slate-700 dark:text-slate-300">{r.rmaNumber ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[r.channel] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}>{r.channel}</span>
                      {r.isFbaReturn && <span className="ml-1.5 text-xs font-mono text-orange-700">FBA</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_TONE[r.status] ?? 'default'} size="sm">{r.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300">
                      <span className="tabular-nums">{r.items.reduce((n, i) => n + i.quantity, 0)}</span> units · {r.items.length} SKU
                    </td>
                    <td className="px-3 py-2 text-base text-slate-600 dark:text-slate-400 truncate max-w-[200px]">{r.reason ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-base text-slate-700 dark:text-slate-300">
                      <div>{r.refundCents != null ? `€${(r.refundCents / 100).toFixed(2)}` : '—'}</div>
                      {/* UI.1 — F1.4 credit-note number on the row. Only
                          shows for refunded rows where the auto-assign
                          fired (or the operator manually clicked Assign
                          via the drawer's CreditNotePanel). */}
                      {r.refunds?.[0]?.creditNote?.creditNoteNumber && (
                        <div className="text-xs font-mono mt-0.5 inline-flex items-center gap-1 text-indigo-700 dark:text-indigo-300" title={`SDI: ${r.refunds[0].creditNote.sdiStatus ?? 'queued locally'}`}>
                          {r.refunds[0].creditNote.creditNoteNumber}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-base text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleDateString('it-IT', { year: '2-digit', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-3 py-2 text-right"><ChevronRight size={14} className="text-slate-400 dark:text-slate-500 inline" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* R1.1 — pagination footer */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-slate-200 dark:border-slate-700 bg-slate-50/40 text-base">
            <div className="text-sm text-slate-600 dark:text-slate-400 tabular-nums">
              {total === 0 ? 'No results' : (
                <>
                  Showing <span className="font-medium text-slate-900 dark:text-slate-100">{(page - 1) * pageSize + 1}</span>–
                  <span className="font-medium text-slate-900 dark:text-slate-100">{Math.min(page * pageSize, total)}</span>{' '}
                  of <span className="font-medium text-slate-900 dark:text-slate-100">{total}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1">
              <select
                value={pageSize}
                onChange={(e) => setFilters({ pageSize: e.target.value, page: '1' })}
                className="h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                title="Rows per page"
              >
                {[25, 50, 100, 200].map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
              <button
                onClick={() => setFilters({ page: '1' })}
                disabled={page === 1}
                className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                title="First page"
              >
                <ChevronsLeft size={13} />
              </button>
              <button
                onClick={() => setFilters({ page: String(Math.max(1, page - 1)) })}
                disabled={page === 1}
                className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                title="Previous page"
              >
                <ChevronLeft size={13} />
              </button>
              <span className="text-sm text-slate-600 dark:text-slate-400 px-2 tabular-nums">Page {page} of {totalPages}</span>
              <button
                onClick={() => setFilters({ page: String(Math.min(totalPages, page + 1)) })}
                disabled={page >= totalPages}
                className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                title="Next page"
              >
                <ChevronRight size={13} />
              </button>
              <button
                onClick={() => setFilters({ page: String(totalPages) })}
                disabled={page >= totalPages}
                className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                title="Last page"
              >
                <ChevronsRight size={13} />
              </button>
            </div>
          </div>
        </Card>
      )}

      {drawerId && <ReturnDrawer id={drawerId} onClose={() => setDrawerId(null)} onChanged={fetchReturns} />}
      {createOpen && (
        <CreateReturnModal
          initialOrderId={prefillOrderId ?? undefined}
          onClose={closeCreate}
          onCreated={() => { closeCreate(); fetchReturns() }}
        />
      )}

      {shortcutsOpen && (
        <KeyboardShortcutsModal
          groups={RETURNS_SHORTCUTS}
          onClose={() => setShortcutsOpen(false)}
        />
      )}
    </div>
  )
}

const RETURNS_SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: ['/'], label: 'Focus search' },
      { keys: ['j', '↓'], label: 'Move to next row' },
      { keys: ['k', '↑'], label: 'Move to previous row' },
      { keys: ['Enter'], label: 'Open RMA detail' },
      { keys: ['Esc'], label: 'Close drawer · drop focused row' },
    ],
  },
  {
    title: 'Tabs',
    rows: [
      { keys: ['1'], label: 'All returns' },
      { keys: ['2'], label: 'Warehouse only' },
      { keys: ['3'], label: 'FBA (read-only)' },
    ],
  },
  {
    title: 'Help',
    rows: [{ keys: ['?'], label: 'Toggle this overlay' }],
  },
]

// R1.1 — sortable column header.
function SortHeader({
  col, sortBy, sortDir, onSort, className, children,
}: {
  col: string
  sortBy: string
  sortDir: 'asc' | 'desc'
  onSort: (col: string) => void
  className?: string
  children: React.ReactNode
}) {
  const active = sortBy === col
  return (
    <th className={`${className ?? ''} text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300`}>
      <button
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100 ${active ? 'text-slate-900 dark:text-slate-100' : ''}`}
      >
        {children}
        {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  )
}

function ReturnDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [ret, setRet] = useState<ReturnRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [conditions, setConditions] = useState<Record<string, string>>({})
  // R2.1 + R5.1 — activity log + refund history. Fetched in parallel
  // with the return detail so the drawer paints once with full
  // context.
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [refunds, setRefunds] = useState<RefundRow[]>([])
  // RX.0 — refund-deadline now arrives with the aggregate so the badge
  // renders from drawer state instead of its own fetch.
  const [deadline, setDeadline] = useState<RefundDeadlineView | null>(null)
  // RX.3 — resolved policy (restocking %, who-pays-shipping) feeds the
  // refund composer's fee suggestions, from the same aggregate fetch.
  const [resolvedPolicy, setResolvedPolicy] = useState<ResolvedPolicyView | null>(null)

  const fetchOne = useCallback(async () => {
    setLoading(true)
    try {
      // RX.0 — one aggregate round-trip (detail + audit + refunds +
      // policy) replaces the prior four parallel fetches. The drawer
      // paints once with full context; the warehouse's flaky link gets
      // a single TLS handshake instead of four.
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/${id}/full`, { cache: 'no-store' })
      if (res.ok) {
        const data = (await res.json()) as ReturnFull
        setRet(data.return)
        setAudit(data.audit?.items ?? [])
        setRefunds(data.refunds?.items ?? [])
        setDeadline(data.policy?.deadline ?? null)
        setResolvedPolicy(data.policy?.resolved ?? null)
      }
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { fetchOne() }, [fetchOne])

  const [refundResult, setRefundResult] = useState<{
    outcome: string
    message?: string
    error?: string
    channelRefundId?: string
  } | null>(null)
  const [refundBusy, setRefundBusy] = useState(false)
  // RX.7 — comms. Tracks which stage email is currently sending so the
  // row can disable while in flight. Surfaces the send-email endpoint
  // (which had no UI) with the new authorized / label_ready stages.
  const [emailBusy, setEmailBusy] = useState<string | null>(null)
  const sendEmail = async (kind: string) => {
    setEmailBusy(kind)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/${id}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, locale: 'it' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? 'Email failed'); return }
      toast.success(data.dryRun ? `Email queued (dry-run): ${kind}` : `Email sent: ${kind}`)
      await fetchOne()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Email failed')
    } finally { setEmailBusy(null) }
  }

  const action = async (path: string, body?: any) => {
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/${id}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? `${path} failed`)
      return
    }
    await fetchOne()
    onChanged()
  }

  const submitInspect = () => {
    const items = ret?.items.map((it) => ({
      itemId: it.id,
      conditionGrade: conditions[it.id] || 'GOOD',
    })).filter((u) => u.conditionGrade) ?? []
    if (items.length === 0) { toast.error('Grade at least one item'); return }
    action('inspect', { items })
  }

  /**
   * H.14 — submit refund publishes to the originating channel before
   * marking the local row REFUNDED. We surface the channel outcome
   * inline so the operator sees:
   *   OK                   → refund posted, channelRefundId rendered
   *   OK_MANUAL_REQUIRED   → Amazon FBM / FBA hint with deep link
   *   NOT_IMPLEMENTED      → Shopify/Woo stubbed, retry later
   *   FAILED               → channel rejected; retry button visible
   *
   * The "Mark refunded only (skip channel push)" button is a deliberate
   * override for when the operator already issued the refund in the
   * channel back office and just needs Nexus to reflect.
   */
  const submitRefund = async (payload: RefundSubmitPayload) => {
    setRefundBusy(true)
    setRefundResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${id}/refund`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRefundResult({
          outcome: 'FAILED',
          error: json?.channelError ?? json?.error ?? 'Refund failed',
        })
      } else {
        setRefundResult({
          outcome: json.channelOutcome ?? 'OK',
          message: json.channelMessage,
          channelRefundId: json.channelRefundId,
        })
        await fetchOne()
        onChanged()
      }
    } catch (e) {
      setRefundResult({
        outcome: 'FAILED',
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRefundBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-2xl bg-white dark:bg-slate-900 shadow-2xl overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-900 z-10">
          <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            <Undo2 size={14} /> Return {ret?.rmaNumber}
          </div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-700"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          {loading || !ret ? <div className="text-base text-slate-500 dark:text-slate-400">Loading…</div> : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[ret.channel] ?? ''}`}>{ret.channel}</span>
                <Badge variant={STATUS_TONE[ret.status] ?? 'default'} size="sm">{ret.status.replace(/_/g, ' ')}</Badge>
                {ret.isFbaReturn && <span className="text-xs font-mono text-orange-700">FBA — managed by Amazon</span>}
                {/* R6.2 — refund deadline countdown badge. Only renders
                    once the return has been received AND not yet
                    refunded; the colour tracks safe/approaching/
                    overdue. Fetched from /returns/:id/policy on
                    drawer load. */}
                <RefundDeadlineBadge deadline={deadline} status={ret.status} refundStatus={ret.refundStatus} />
                {ret.returnType && ret.returnType !== 'STANDARD' && (
                  <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900">{ret.returnType}</span>
                )}
              </div>

              {/* RX.6b — warranty/defect claim track (diagnosis → routing). */}
              {!ret.isFbaReturn && (ret.returnType === 'WARRANTY' || ret.returnType === 'DEFECT') && (
                <WarrantyTrack ret={ret} onUpdated={async () => { await fetchOne(); onChanged() }} />
              )}

              {/* R2.1 — RMA barcode for warehouse identification */}
              {ret.rmaNumber && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-3 flex justify-center">
                  <Barcode128 value={ret.rmaNumber} moduleWidthPx={1.4} height={48} />
                </div>
              )}

              {/* RX.2 — Documents. The Italian withdrawal form (modulo di
                  recesso, D.Lgs. 21/2014) PDF endpoint existed with no UI;
                  surface it for direct/warehouse consumer returns. FBA is
                  Amazon-managed, so the statutory form doesn't apply. */}
              {!ret.isFbaReturn && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Documents</span>
                  <a
                    href={`${getBackendUrl()}/api/fulfillment/returns/${ret.id}/modulo-recesso.pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded hover:bg-slate-100 dark:hover:bg-slate-700 inline-flex items-center gap-1.5"
                    title="Italian statutory 14-day withdrawal form (bilingual IT/EN), pre-filled from this return"
                  >
                    <Download size={12} /> Modulo di recesso (PDF)
                  </a>
                </div>
              )}

              {/* R2.1 — customer + order + shipment context */}
              {ret.order && (
                <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded p-3 space-y-2 text-base">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Customer</div>
                      <div className="text-slate-900 dark:text-slate-100 truncate">{ret.order.customerName ?? 'Unknown customer'}</div>
                      {ret.order.customerEmail && (
                        <a href={`mailto:${ret.order.customerEmail}`} className="text-sm text-blue-700 dark:text-blue-300 hover:underline truncate block">
                          {ret.order.customerEmail}
                        </a>
                      )}
                      {(() => {
                        const a = ret.order!.shippingAddress as any
                        if (!a) return null
                        const city = a.City ?? a.city
                        const country = a.CountryCode ?? a.countryCode ?? a.country
                        if (!city && !country) return null
                        return <div className="text-sm text-slate-500 dark:text-slate-400 truncate">{[city, country].filter(Boolean).join(', ')}</div>
                      })()}
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <a
                        href={`/fulfillment/outbound?drawer=${ret.order.id}`}
                        className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded hover:bg-slate-100 dark:hover:bg-slate-700 inline-flex items-center gap-1"
                      >
                        <Package size={11} /> Open order
                      </a>
                      {ret.order.shipments[0] && (
                        <a
                          href={`/fulfillment/outbound/pack/${ret.order.shipments[0].id}`}
                          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded hover:bg-slate-100 dark:hover:bg-slate-700 inline-flex items-center gap-1"
                        >
                          <Truck size={11} /> Shipment
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 pt-1.5 border-t border-slate-200 dark:border-slate-700">
                    {ret.order.channelOrderId && (
                      <span className="inline-flex items-center gap-1">
                        <span className="uppercase text-xs tracking-wider font-semibold">Order</span>
                        <span className="font-mono text-slate-700 dark:text-slate-300">{ret.order.channelOrderId}</span>
                      </span>
                    )}
                    {ret.order.shipments[0]?.trackingNumber && (
                      <span className="inline-flex items-center gap-1">
                        <span className="uppercase text-xs tracking-wider font-semibold">Tracking</span>
                        <span className="font-mono text-slate-700 dark:text-slate-300">{ret.order.shipments[0].trackingNumber}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {ret.reason && <div><div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Reason</div><div className="text-base text-slate-700 dark:text-slate-300 mt-0.5">{ret.reason}</div></div>}

              {/* R2.2 — writable Return-level notes (FBA stays read-only) */}
              {!ret.isFbaReturn && (
                <ReturnNotesEditor returnId={ret.id} initial={ret.notes ?? ''} onSaved={fetchOne} />
              )}

              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">Items</div>
                <div className="space-y-2.5">
                  {ret.items.map((it) => (
                    <ReturnItemCard
                      key={it.id}
                      returnId={ret.id}
                      item={it}
                      isFba={ret.isFbaReturn}
                      isInspecting={ret.status === 'INSPECTING' || ret.status === 'RECEIVED'}
                      stagedGrade={conditions[it.id]}
                      onStageGrade={(grade) => setConditions({ ...conditions, [it.id]: grade })}
                      onChanged={fetchOne}
                    />
                  ))}
                </div>
              </div>

              {/* Return label tracking — only relevant for non-FBA returns
                  (FBA managed by Amazon). v0 stores carrier-generated
                  URL + tracking + email timestamp. Real Sendcloud return-
                  label generation = v1 follow-up. */}
              {!ret.isFbaReturn && (
                <ReturnLabelPanel
                  returnRow={ret}
                  onUpdated={async () => { await fetchOne(); onChanged() }}
                />
              )}

              {!ret.isFbaReturn && (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {ret.status === 'REQUESTED' || ret.status === 'AUTHORIZED' || ret.status === 'IN_TRANSIT' ? (
                      <button onClick={() => action('receive')} className="h-8 px-3 text-base bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 rounded hover:bg-blue-100 dark:hover:bg-blue-900/60 inline-flex items-center gap-1.5">
                        <ArrowDownToLine size={12} /> Mark received
                      </button>
                    ) : null}
                    {(ret.status === 'RECEIVED' || ret.status === 'INSPECTING') && (
                      <button onClick={submitInspect} className="h-8 px-3 text-base bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded hover:bg-amber-100 dark:hover:bg-amber-900/60 inline-flex items-center gap-1.5">
                        <CheckCircle2 size={12} /> Save inspection
                      </button>
                    )}
                    {ret.status === 'INSPECTING' && (
                      <>
                        <button onClick={() => action('restock')} className="h-8 px-3 text-base bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/60 inline-flex items-center gap-1.5">
                          <Package size={12} /> Restock
                        </button>
                        <button onClick={() => action('scrap')} className="h-8 px-3 text-base bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 rounded hover:bg-rose-100 dark:hover:bg-rose-900/60">Scrap</button>
                      </>
                    )}
                  </div>

                  {/* RX.7 — customer comms journey. Stage-aware buttons
                      surface the send-email endpoint (previously UI-less)
                      across the whole return lifecycle. Sends Italian
                      (buyer-facing); errors if no customer email on file. */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold inline-flex items-center gap-1"><Mail size={11} /> Notify</span>
                    {(ret.status === 'REQUESTED' || ret.status === 'AUTHORIZED') && (
                      <>
                        <CommsBtn label="Approved" busy={emailBusy === 'authorized'} disabled={!!emailBusy} onClick={() => sendEmail('authorized')} />
                        <CommsBtn label="Label ready" busy={emailBusy === 'label_ready'} disabled={!!emailBusy} onClick={() => sendEmail('label_ready')} />
                      </>
                    )}
                    {(ret.status === 'IN_TRANSIT' || ret.status === 'RECEIVED' || ret.status === 'INSPECTING') && (
                      <CommsBtn label="Received" busy={emailBusy === 'received'} disabled={!!emailBusy} onClick={() => sendEmail('received')} />
                    )}
                    {ret.status === 'REFUNDED' && (
                      <CommsBtn label="Refunded" busy={emailBusy === 'refunded'} disabled={!!emailBusy} onClick={() => sendEmail('refunded')} />
                    )}
                    <CommsBtn label="Rejected" busy={emailBusy === 'rejected'} disabled={!!emailBusy} onClick={() => sendEmail('rejected')} muted />
                  </div>

                  {/* R5.3 — failed-refund retry surface. Renders
                      a banner when the channel push failed; the
                      operator clicks "Retry now" to bypass the cron's
                      backoff window. The cron also picks the row up
                      hourly when NEXUS_ENABLE_REFUND_RETRY=1. */}
                  {ret.refundStatus === 'CHANNEL_FAILED' && (
                    <RefundRetryBanner returnId={ret.id} onRetried={async () => { await fetchOne(); onChanged() }} />
                  )}

                  {ret.refundStatus !== 'REFUNDED' && (
                    <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
                      {/* RX.3 — refund composer: kind (cash / store-credit
                          / exchange), per-line allocation, and policy-
                          driven fee deduction. Refunds stay a human click;
                          this only enriches what gets sent. */}
                      <RefundComposer
                        channel={ret.channel}
                        items={ret.items}
                        defaultAmountCents={ret.refundCents}
                        policy={resolvedPolicy}
                        busy={refundBusy}
                        onSubmit={submitRefund}
                      />
                      {/* H.14 — channel outcome surface. Each tone
                          maps to one of the four publisher outcomes. */}
                      {refundResult && (
                        <div
                          className={`text-sm rounded px-2.5 py-1.5 ${
                            refundResult.outcome === 'OK'
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-800'
                              : refundResult.outcome === 'OK_MANUAL_REQUIRED'
                                ? 'bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800'
                                : refundResult.outcome === 'NOT_IMPLEMENTED'
                                  ? 'bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                                  : 'bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800'
                          }`}
                        >
                          <div className="font-medium">
                            {refundResult.outcome === 'OK' && 'Refund posted to channel.'}
                            {refundResult.outcome === 'OK_MANUAL_REQUIRED' && 'Channel requires manual finish.'}
                            {refundResult.outcome === 'NOT_IMPLEMENTED' && 'Channel adapter not yet wired.'}
                            {refundResult.outcome === 'SKIPPED' && 'Marked refunded locally (channel skipped).'}
                            {refundResult.outcome === 'FAILED' && 'Channel push failed.'}
                          </div>
                          {refundResult.channelRefundId && (
                            <div className="mt-0.5 font-mono text-xs">
                              Channel refund id: {refundResult.channelRefundId}
                            </div>
                          )}
                          {refundResult.message && (
                            <div className="mt-0.5">{refundResult.message}</div>
                          )}
                          {refundResult.error && (
                            <div className="mt-0.5 font-mono text-xs">
                              {refundResult.error}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {ret.refundStatus === 'REFUNDED' && (ret as any).channelRefundId && (
                    <div className="text-sm text-emerald-700 dark:text-emerald-300 pt-1">
                      Channel refund id:{' '}
                      <span className="font-mono">
                        {(ret as any).channelRefundId}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* R5.1 — refund history (multi-attempt + per-channel-status) */}
              {refunds.length > 0 && <RefundHistory refunds={refunds} onAfterCreditNote={fetchOne} />}

              {/* R2.1 — activity log timeline */}
              {audit.length > 0 && <ActivityTimeline entries={audit} />}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function CreateReturnModal({
  initialOrderId,
  onClose,
  onCreated,
}: {
  initialOrderId?: string
  onClose: () => void
  onCreated: () => void
}) {
  const { toast } = useToast()
  const [orderId, setOrderId] = useState(initialOrderId ?? '')
  const [channel, setChannel] = useState('AMAZON')
  const [reason, setReason] = useState('')
  const [returnType, setReturnType] = useState('STANDARD') // RX.6b
  const [items, setItems] = useState<Array<{ sku: string; quantity: number }>>([{ sku: '', quantity: 1 }])
  const [busy, setBusy] = useState(false)
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderHint, setOrderHint] = useState<string | null>(null)

  // O.53: when initialOrderId is provided (deep-linked from outbound
  // drawer), fetch the order detail and pre-fill channel + items so
  // the operator doesn't re-type. Falls back to the original empty
  // state on fetch failure (operator can still type manually).
  useEffect(() => {
    if (!initialOrderId) return
    let cancelled = false
    ;(async () => {
      setOrderLoading(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/outbound/orders/${initialOrderId}`,
          { cache: 'no-store' },
        )
        if (!res.ok || cancelled) return
        const data = await res.json()
        setChannel(data.channel ?? 'AMAZON')
        if (Array.isArray(data.items) && data.items.length > 0) {
          setItems(data.items.map((it: any) => ({ sku: it.sku, quantity: it.quantity })))
        }
        setOrderHint(`${data.channel}${data.marketplace ? ` · ${data.marketplace}` : ''} — ${data.customerName ?? '—'}`)
      } catch {
        /* non-fatal */
      } finally {
        if (!cancelled) setOrderLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [initialOrderId])

  const submit = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: orderId || null, channel, reason, returnType,
          items: items.filter((i) => i.sku.trim()),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Create failed')
      }
      onCreated()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white dark:bg-slate-900 rounded-lg shadow-2xl w-full max-w-xl">
        <header className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">New return</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-700"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">Channel</div>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-8 w-full px-2 text-md border border-slate-200 dark:border-slate-700 rounded">
                <option value="AMAZON">Amazon</option>
                <option value="EBAY">eBay</option>
                <option value="SHOPIFY">Shopify</option>
                <option value="WOOCOMMERCE">WooCommerce</option>
                <option value="ETSY">Etsy</option>
              </select>
            </div>
            <div>
              <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">Order ID (optional)</div>
              <input type="text" value={orderId} onChange={(e) => setOrderId(e.target.value)} className="h-8 w-full px-2 text-md font-mono border border-slate-200 dark:border-slate-700 rounded" />
              {orderHint && (
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{orderLoading ? 'Loading order…' : orderHint}</div>
              )}
            </div>
          </div>
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">Reason</div>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong size, defective, …" className="h-8 w-full px-2 text-md border border-slate-200 dark:border-slate-700 rounded" />
          </div>
          {/* RX.6b — return type. WARRANTY/DEFECT open a diagnosis track. */}
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">Type</div>
            <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
              {(['STANDARD', 'WARRANTY', 'DEFECT'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setReturnType(t)}
                  className={`h-8 px-3 text-sm ${returnType === t ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                >
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">Items</div>
            <div className="space-y-1.5">
              {items.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={row.sku} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, sku: e.target.value } : s))} placeholder="SKU" className="flex-1 h-7 px-2 text-base font-mono border border-slate-200 dark:border-slate-700 rounded" />
                  <input type="number" min="1" value={row.quantity} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, quantity: Number(e.target.value) || 1 } : s))} className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded" />
                  <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="h-7 w-7 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-rose-600"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setItems([...items, { sku: '', quantity: 1 }])} className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline">+ Add SKU</button>
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center gap-2 justify-end">
          <button onClick={onClose} className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800">Cancel</button>
          <button onClick={submit} disabled={busy} className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50">Create return</button>
        </footer>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Return Label Panel
// Operator-driven label tracking. Shipping in v0 with the assumption
// that operators generate the actual label in their carrier's UI
// (Sendcloud / DHL portal / etc.) and paste the URL + tracking back.
// Native carrier integration → v1.
// ─────────────────────────────────────────────────────────────────────

const CARRIER_OPTIONS = [
  { value: 'SENDCLOUD', label: 'Sendcloud' },
  { value: 'DHL', label: 'DHL' },
  { value: 'GLS', label: 'GLS' },
  { value: 'POSTE', label: 'Poste Italiane' },
  { value: 'BRT', label: 'BRT' },
  { value: 'UPS', label: 'UPS' },
  { value: 'FEDEX', label: 'FedEx' },
  { value: 'MANUAL', label: 'Manual / Other' },
]

// R5.3 — banner shown in the drawer when a channel refund failed.
// Reads the retry-status endpoint to render the next eligible time
// (so the operator sees "next retry in 23m" instead of staring at a
// stuck CHANNEL_FAILED). The "Retry now" button bypasses backoff.
// R2.1 — activity timeline (newest-first AuditLog entries).
function ActivityTimeline({ entries }: { entries: AuditEntry[] }) {
  const fmtRel = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime()
    const m = Math.floor(ms / 60_000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d}d ago`
    return new Date(iso).toLocaleDateString('it-IT')
  }
  const TONE_DOT: Record<string, string> = {
    info: 'bg-blue-500', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-rose-500',
  }
  return (
    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">Activity</div>
      <ol className="space-y-2.5 text-base">
        {entries.map((e) => {
          const meta = ACTION_LABEL[e.action] ?? { label: e.action, tone: 'info' as const }
          const after = (e.after ?? {}) as Record<string, unknown>
          const md = (e.metadata ?? {}) as Record<string, unknown>
          let detail: string | null = null
          if (e.action === 'refund' && typeof after.channelOutcome === 'string') {
            const cents = typeof after.refundCents === 'number' ? `€${(after.refundCents / 100).toFixed(2)} · ` : ''
            detail = `${cents}${after.channelOutcome}`
          } else if (e.action === 'inspect' && Array.isArray(after.itemGrades)) {
            detail = `${(after.itemGrades as Array<{ grade: string }>).length} item(s) graded`
          } else if (e.action === 'restock' && Array.isArray(after.restockedItems)) {
            const r = (after.restockedItems as Array<{ qty: number }>).reduce((acc, i) => acc + (i.qty ?? 0), 0)
            const skipped = Array.isArray(after.skippedItems) ? (after.skippedItems as unknown[]).length : 0
            detail = `${r} unit${r === 1 ? '' : 's'} restocked${skipped ? ` · ${skipped} skipped` : ''}`
          } else if (e.action === 'carrier-scan' && typeof md.code === 'string') {
            detail = md.advancedTo ? `${md.code} → ${md.advancedTo}` : (md.code as string)
          } else if (e.action === 'attach-label' && typeof after.carrier === 'string') {
            detail = after.carrier as string
          }
          return (
            <li key={e.id} className="flex items-start gap-3">
              <div className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${TONE_DOT[meta.tone]}`} />
              <div className="flex-1 min-w-0">
                <div className="text-slate-900 dark:text-slate-100">
                  {meta.label}
                  {detail && <span className="text-slate-500 dark:text-slate-400 ml-1.5">— {detail}</span>}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {fmtRel(e.createdAt)}
                  {e.userId && <span className="ml-2">· {e.userId}</span>}
                  {(md as any).bulk && <span className="ml-2 italic">· bulk</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// R5.1 — refund history block (multi-refund + multi-attempt audit).
function RefundHistory({ refunds, onAfterCreditNote }: { refunds: RefundRow[]; onAfterCreditNote?: () => void }) {
  const STATUS_TONE: Record<string, string> = {
    POSTED: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
    PENDING: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
    FAILED: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
    MANUAL_REQUIRED: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
    NOT_IMPLEMENTED: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  }
  return (
    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
        Refund history ({refunds.length})
      </div>
      <div className="space-y-1.5 text-base">
        {refunds.map((r) => (
          <div key={r.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2.5 space-y-1">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="inline-flex items-center gap-2">
                <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">€{(r.amountCents / 100).toFixed(2)}</span>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">{r.currencyCode}</span>
                {r.kind !== 'CASH' && (
                  <span className="text-xs uppercase tracking-wider px-1 py-0.5 bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-900 rounded">
                    {r.kind.replace(/_/g, ' ')}
                  </span>
                )}
                <span className={`text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${STATUS_TONE[r.channelStatus] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}>
                  {r.channelStatus.replace(/_/g, ' ')}
                </span>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {new Date(r.createdAt).toLocaleString('it-IT', { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {r.channelRefundId && (
              <div className="text-xs">
                <span className="text-slate-500 dark:text-slate-400">{r.channel} refund id:</span>{' '}
                <span className="font-mono text-slate-700 dark:text-slate-300">{r.channelRefundId}</span>
              </div>
            )}
            {r.channelError && <div className="text-xs font-mono text-rose-700 dark:text-rose-300">{r.channelError}</div>}
            {r.attempts.length > 1 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {r.attempts.length} attempts · last:{' '}
                <span className="font-mono">
                  {r.attempts[0].outcome}
                  {r.attempts[0].durationMs != null ? ` (${r.attempts[0].durationMs}ms)` : ''}
                </span>
              </div>
            )}
            <CreditNotePanel refund={r} onAfter={onAfterCreditNote} />
          </div>
        ))}
      </div>
    </div>
  )
}

// F1.4 — Italian nota di credito panel inside RefundHistory.
//
// States:
//   - Refund not yet POSTED → muted hint ("Issued after refund posts")
//   - POSTED + creditNote present → number badge + download button
//   - POSTED + no creditNote → assign-now button (auto-assign hook
//     should have already done this; manual button is a safety net)
function CreditNotePanel({ refund, onAfter }: { refund: RefundRow; onAfter?: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState<'assign' | 'download' | null>(null)
  const cn = refund.creditNote ?? null

  if (refund.channelStatus !== 'POSTED') {
    return (
      <div className="text-xs text-slate-400 dark:text-slate-500 italic pt-1 border-t border-slate-100 dark:border-slate-800">
        Nota di credito issued after refund posts
      </div>
    )
  }

  const assign = async () => {
    setBusy('assign')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/refunds/${refund.id}/credit-note/assign`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      toast.success(`Nota di credito ${data.creditNoteNumber} assigned`)
      await onAfter?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Assign failed')
    } finally { setBusy(null) }
  }

  const download = async () => {
    setBusy('download')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/refunds/${refund.id}/credit-note/xml`,
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `nota-credito-${cn?.creditNoteNumber ?? refund.id}.xml`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success('FatturaPA TD04 XML downloaded')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download failed')
    } finally { setBusy(null) }
  }

  return (
    <div className="pt-1.5 mt-1 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
      <div className="inline-flex items-center gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Nota di credito</span>
        {cn ? (
          <>
            <span className="font-mono text-xs px-1.5 py-0.5 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-900 rounded">
              {cn.creditNoteNumber}
            </span>
            {cn.sdiStatus && (
              <span className="text-xs uppercase tracking-wider px-1 py-0.5 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 rounded">
                SDI: {cn.sdiStatus}
              </span>
            )}
            {cn.causale && (
              <span className="text-xs text-slate-500 dark:text-slate-400 italic">{cn.causale}</span>
            )}
          </>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500 italic">Not yet assigned</span>
        )}
      </div>
      <div className="inline-flex items-center gap-1.5">
        {!cn && (
          <button
            type="button"
            onClick={assign}
            disabled={busy !== null}
            className="text-xs px-2 py-1 border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'assign' ? 'Assigning…' : 'Assign number'}
          </button>
        )}
        {cn && (
          <button
            type="button"
            onClick={download}
            disabled={busy !== null}
            title="FatturaPA TD04 XML (B2B only)"
            className="text-xs px-2 py-1 border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'download' ? 'Generating…' : 'Download XML'}
          </button>
        )}
      </div>
    </div>
  )
}

// R2.2 — writable Return.notes (auto-save on blur).
function ReturnNotesEditor({
  returnId, initial, onSaved,
}: {
  returnId: string
  initial: string
  onSaved: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setValue(initial) }, [initial])
  const dirty = value !== initial
  const save = async () => {
    if (!dirty) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: value || null }),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success('Notes saved')
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1 inline-flex items-center gap-2">
        Operator notes
        {dirty && <span className="text-amber-600 dark:text-amber-400 normal-case font-normal text-[11px]">unsaved</span>}
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        rows={2}
        placeholder="Context for the next operator — anything not captured by the per-item state."
        className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded resize-y focus:outline-none focus:ring-1 focus:ring-slate-400"
      />
      {dirty && (
        <button
          onClick={save}
          disabled={busy}
          className="mt-1 h-7 px-2 text-sm bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Save size={11} /> Save
        </button>
      )}
    </div>
  )
}

// R2.2 — per-item card: SKU + condition staging + writable notes +
// inspection checklist + photo gallery + disposition badge.
function ReturnItemCard({
  returnId, item, isFba, isInspecting, stagedGrade, onStageGrade, onChanged,
}: {
  returnId: string
  item: ReturnRow['items'][number]
  isFba: boolean
  isInspecting: boolean
  stagedGrade: string | undefined
  onStageGrade: (grade: string) => void
  onChanged: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [notes, setNotes] = useState(item.notes ?? '')
  const [checklist, setChecklist] = useState<ItemChecklist>(item.inspectionChecklist ?? {})
  const [busy, setBusy] = useState(false)
  useEffect(() => { setNotes(item.notes ?? '') }, [item.notes])
  useEffect(() => { setChecklist(item.inspectionChecklist ?? {}) }, [item.inspectionChecklist])
  const dirty =
    notes !== (item.notes ?? '') ||
    JSON.stringify(checklist) !== JSON.stringify(item.inspectionChecklist ?? {})

  const saveItem = async () => {
    if (!dirty) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/items/${item.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notes: notes || null,
            inspectionChecklist: Object.keys(checklist).length > 0 ? checklist : null,
          }),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success(`${item.sku} saved`)
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally { setBusy(false) }
  }

  const uploadPhoto = async (file: File) => {
    if (!file) return
    if (item.photoUrls.length >= 10) { toast.error('Photo cap reached (10 per item)'); return }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/items/${item.id}/upload-photo`,
        { method: 'POST', body: fd },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      toast.success('Photo uploaded')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally { setBusy(false) }
  }

  const removePhoto = async (url: string) => {
    if (!(await askConfirm({
      title: 'Remove photo?',
      description: 'The image stays in Cloudinary but is unlinked from this item.',
      confirmLabel: 'Remove',
      tone: 'danger',
    }))) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/items/${item.id}/photos`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success('Photo removed')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Remove failed')
    } finally { setBusy(false) }
  }

  const setChk = (patch: Partial<ItemChecklist>) =>
    setChecklist((prev) => ({ ...prev, ...patch }))

  // R3.2 — disposition badge tone (display-only here; mobile inspect
  // page is where the operator picks).
  const DISPOSITION_TONE: Record<string, string> = {
    SELLABLE: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
    SECOND_QUALITY: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
    REFURBISH: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
    QUARANTINE: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
    SCRAP: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded p-3 space-y-2.5 text-base">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-slate-900 dark:text-slate-100">{item.sku}</div>
          <div className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">Qty {item.quantity}</div>
        </div>
        <div className="flex items-center gap-1.5">
          {item.disposition && (
            <span
              className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${DISPOSITION_TONE[item.disposition] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}
              title={item.scrapReason ? `Scrap reason: ${item.scrapReason}` : undefined}
            >
              {item.disposition.replace(/_/g, ' ')}
            </span>
          )}
          {isInspecting && !isFba ? (
            <select
              value={stagedGrade ?? item.conditionGrade ?? ''}
              onChange={(e) => onStageGrade(e.target.value)}
              className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded"
              aria-label={`Condition grade for ${item.sku}`}
            >
              <option value="">Grade…</option>
              <option value="NEW">NEW</option>
              <option value="LIKE_NEW">Like new</option>
              <option value="GOOD">Good</option>
              <option value="DAMAGED">Damaged</option>
              <option value="UNUSABLE">Unusable</option>
            </select>
          ) : (
            <span className="text-sm text-slate-600 dark:text-slate-400">{item.conditionGrade ?? '—'}</span>
          )}
        </div>
      </div>
      {item.disposition === 'SCRAP' && item.scrapReason && (
        <div className="text-xs text-rose-700 dark:text-rose-300 italic">Scrap reason: {item.scrapReason}</div>
      )}

      {isInspecting && !isFba && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!checklist.packagingPresent}
              onChange={(e) => setChk({ packagingPresent: e.target.checked })}
              className="h-3.5 w-3.5 cursor-pointer accent-slate-900"
            />
            Original packaging
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!checklist.tagsIntact}
              onChange={(e) => setChk({ tagsIntact: e.target.checked })}
              className="h-3.5 w-3.5 cursor-pointer accent-slate-900"
            />
            Tags / labels intact
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!checklist.visibleDamage}
              onChange={(e) => setChk({ visibleDamage: e.target.checked })}
              className="h-3.5 w-3.5 cursor-pointer accent-slate-900"
            />
            Visible damage
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!checklist.functionalTestPassed}
              onChange={(e) => setChk({ functionalTestPassed: e.target.checked })}
              className="h-3.5 w-3.5 cursor-pointer accent-slate-900"
            />
            Functional test passed
          </label>
          <div className="col-span-2 inline-flex items-center gap-2">
            <span className="text-slate-500 dark:text-slate-400">Signs of use:</span>
            {(['NONE', 'LIGHT', 'HEAVY'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setChk({ signsOfUse: s })}
                className={`h-6 px-2 text-sm rounded border ${
                  checklist.signsOfUse === s
                    ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isFba && (
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5">Notes</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Per-item observations, defect location, etc."
            className="w-full px-2 py-1 text-base border border-slate-200 dark:border-slate-700 rounded resize-y focus:outline-none focus:ring-1 focus:ring-slate-400"
          />
        </div>
      )}

      {!isFba && (
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1 inline-flex items-center gap-1.5">
            <ImageIcon size={11} /> Photos ({item.photoUrls.length}/10)
          </div>
          {item.photoUrls.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5 mb-1.5">
              {item.photoUrls.map((u) => (
                <div key={u} className="relative group">
                  <a href={u} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt="Item condition" className="w-full h-16 object-cover rounded border border-slate-200 dark:border-slate-700" />
                  </a>
                  <button
                    onClick={() => removePhoto(u)}
                    className="absolute top-0.5 right-0.5 h-5 w-5 inline-flex items-center justify-center rounded bg-white/80 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-600 dark:text-slate-400 hover:text-rose-700 dark:hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove photo"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadPhoto(f)
              e.target.value = ''
            }}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || item.photoUrls.length >= 10}
            className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Camera size={11} /> Add photo
          </button>
        </div>
      )}

      {dirty && !isFba && (
        <div className="flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
          <button
            onClick={saveItem}
            disabled={busy}
            className="h-7 px-2.5 text-sm bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Save size={11} /> Save item
          </button>
          <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved per-item changes</span>
        </div>
      )}
    </div>
  )
}

function RefundRetryBanner({
  returnId, onRetried,
}: {
  returnId: string
  onRetried: () => Promise<void> | void
}) {
  const { toast } = useToast()
  const [status, setStatus] = useState<{
    ready: boolean
    priorAttempts: number
    nextEligibleAt: string | null
    reason?: 'max_attempts' | 'backoff' | 'not_failed'
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/refund/retry-status`,
        { cache: 'no-store' },
      )
      if (r.ok) setStatus(await r.json())
    } catch { /* non-fatal */ }
  }, [returnId])
  useEffect(() => { void fetchStatus() }, [fetchStatus])

  const retry = async () => {
    setBusy(true)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/refund/retry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        },
      )
      const j = await r.json()
      if (r.ok && (j.outcome === 'OK' || j.outcome === 'OK_MANUAL_REQUIRED' || j.outcome === 'NOT_IMPLEMENTED')) {
        toast.success('Refund retry posted')
      } else if (j.outcome === 'SKIPPED') {
        toast.error(`Skipped: ${j.reason ?? 'unknown'}`)
      } else {
        toast.error(j.error ?? 'Retry failed')
      }
      await fetchStatus()
      await onRetried()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Retry failed')
    } finally {
      setBusy(false)
    }
  }

  const fmtRel = (iso: string | null): string => {
    if (!iso) return ''
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return 'now'
    const m = Math.ceil(ms / 60_000)
    if (m < 60) return `in ${m}m`
    return `in ${Math.ceil(m / 60)}h`
  }

  return (
    <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded p-3 space-y-1.5 text-base">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="font-medium text-rose-900">Channel refund failed</div>
          <div className="text-sm text-rose-700 dark:text-rose-300">
            {status?.priorAttempts ?? 0} / 5 attempts
            {status?.reason === 'max_attempts' && ' — gave up after 5 retries'}
            {status?.reason === 'backoff' && status?.nextEligibleAt && ` — next auto retry ${fmtRel(status.nextEligibleAt)}`}
            {status?.ready && ' — ready to retry'}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-1 border-t border-rose-200 dark:border-rose-900">
        <button
          onClick={retry}
          disabled={busy || status?.reason === 'max_attempts'}
          className="h-7 px-2.5 text-sm bg-rose-600 hover:bg-rose-500 text-white rounded inline-flex items-center gap-1 disabled:opacity-50"
          title={status?.reason === 'max_attempts' ? 'Max retries reached — investigate the failure before manually retrying' : 'Override backoff and retry now'}
        >
          <RotateCw size={11} className={busy ? 'animate-spin' : ''} /> {busy ? 'Retrying…' : 'Retry now'}
        </button>
        <span className="text-xs text-rose-600 dark:text-rose-400">
          Auto-retry runs hourly via cron (when enabled)
        </span>
      </div>
    </div>
  )
}

// RX.6b — warranty / defect claim track. Renders for WARRANTY/DEFECT
// returns: a diagnosis status + repair/replace/refund/reject routing +
// manufacturer claim ref. Recording REFUND here does NOT move money —
// the operator still issues the refund via the normal composer.
const WARRANTY_RESOLUTIONS = ['REPAIR', 'REPLACE', 'REFUND', 'REJECTED'] as const

function WarrantyTrack({ ret, onUpdated }: { ret: ReturnRow; onUpdated: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [mfrRef, setMfrRef] = useState(ret.manufacturerRef ?? '')

  const patch = async (body: Record<string, unknown>, key: string) => {
    setBusy(key)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/${ret.id}/warranty`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error ?? 'Update failed'); return }
      toast.success('Warranty updated')
      onUpdated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally { setBusy(null) }
  }

  return (
    <div className="rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300 inline-flex items-center gap-1.5">
          <Activity size={12} /> {ret.returnType === 'DEFECT' ? 'Defect' : 'Warranty'} claim
        </span>
        {ret.warrantyStatus && <Badge variant="info" size="sm">{ret.warrantyStatus.replace(/_/g, ' ')}</Badge>}
      </div>

      <div>
        <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Resolution</div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {WARRANTY_RESOLUTIONS.map((r) => (
            <button
              key={r}
              onClick={() => patch({ warrantyResolution: r, warrantyStatus: r === 'REJECTED' ? 'REJECTED' : r }, r)}
              disabled={!!busy}
              className={`h-7 px-2.5 text-xs border rounded disabled:opacity-50 ${ret.warrantyResolution === r ? 'bg-violet-600 text-white border-violet-600' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-violet-50 dark:hover:bg-violet-950/40'}`}
            >
              {busy === r ? '…' : r === 'REJECTED' ? 'Reject' : r.charAt(0) + r.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        {ret.warrantyResolution === 'REFUND' && (
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">Issue the refund below as usual — recording it here doesn't move money.</p>
        )}
      </div>

      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="text-xs text-slate-500 dark:text-slate-400">Manufacturer ref</span>
          <input
            value={mfrRef}
            onChange={(e) => setMfrRef(e.target.value)}
            placeholder="claim #"
            className="mt-0.5 w-full h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
          />
        </label>
        <button
          onClick={() => patch({ manufacturerRef: mfrRef.trim() || null }, 'mfr')}
          disabled={busy === 'mfr'}
          className="h-7 px-2.5 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          {busy === 'mfr' ? '…' : 'Save'}
        </button>
      </div>
      {ret.defectReportedAt && (
        <div className="text-xs text-slate-400">Reported {new Date(ret.defectReportedAt).toLocaleDateString()}</div>
      )}
    </div>
  )
}

// RX.7 — compact stage-email button for the drawer comms row.
function CommsBtn({
  label, onClick, busy, disabled, muted,
}: {
  label: string
  onClick: () => void
  busy: boolean
  disabled: boolean
  muted?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-7 px-2 text-xs border rounded disabled:opacity-50 inline-flex items-center gap-1 ${
        muted
          ? 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
          : 'border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 bg-blue-50/60 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/50'
      }`}
    >
      {busy ? '…' : label}
    </button>
  )
}

// RX.3 — payload the composer sends to POST /returns/:id/refund.
type RefundSubmitPayload = {
  refundCents: number
  kind: 'CASH' | 'STORE_CREDIT' | 'EXCHANGE'
  skipChannelPush: boolean
  perLineAmounts?: Record<string, number>
  grossCents?: number
  restockingFeeCents?: number
  returnShippingFeeCents?: number
}

const REFUND_KINDS: Array<{ k: 'CASH' | 'STORE_CREDIT' | 'EXCHANGE'; label: string }> = [
  { k: 'CASH', label: 'Cash' },
  { k: 'STORE_CREDIT', label: 'Store credit' },
  { k: 'EXCHANGE', label: 'Exchange' },
]

// RX.3 — refund composer. Kind (cash / store-credit / exchange),
// optional per-line allocation, and policy-driven fee deduction, all
// resolving to a single NET figure. Cash can push to the channel;
// store-credit/exchange are recorded locally (our channel adapters only
// issue cash refunds — the operator settles the credit/exchange in the
// channel, then records it here), which keeps the channel total from
// ever disagreeing with what we mark refunded.
function RefundComposer({
  channel, items, defaultAmountCents, policy, busy, onSubmit,
}: {
  channel: string
  items: ReturnRow['items']
  defaultAmountCents: number | null
  policy: ResolvedPolicyView | null
  busy: boolean
  onSubmit: (payload: RefundSubmitPayload) => void
}) {
  const [kind, setKind] = useState<'CASH' | 'STORE_CREDIT' | 'EXCHANGE'>('CASH')
  const [amount, setAmount] = useState<string>(defaultAmountCents != null ? (defaultAmountCents / 100).toFixed(2) : '')
  const [perLineOpen, setPerLineOpen] = useState(false)
  const [lines, setLines] = useState<Record<string, string>>({})
  const [restockEuros, setRestockEuros] = useState<string>('')
  const [shipEuros, setShipEuros] = useState<string>('')

  const grossCents = useMemo(() => {
    if (perLineOpen) {
      return Object.values(lines).reduce((s, v) => s + (Number(v) > 0 ? Math.round(Number(v) * 100) : 0), 0)
    }
    return amount && Number(amount) > 0 ? Math.round(Number(amount) * 100) : 0
  }, [perLineOpen, lines, amount])

  const restockCents = restockEuros && Number(restockEuros) > 0 ? Math.round(Number(restockEuros) * 100) : 0
  const shipCents = shipEuros && Number(shipEuros) > 0 ? Math.round(Number(shipEuros) * 100) : 0
  const netCents = Math.max(0, grossCents - restockCents - shipCents)
  const fmt = (c: number) => `€${(c / 100).toFixed(2)}`

  const suggestRestock = () => {
    if (policy?.restockingFeePct && grossCents > 0) {
      setRestockEuros(((grossCents * (policy.restockingFeePct / 100)) / 100).toFixed(2))
    }
  }

  const submit = (skipChannelPush: boolean) => {
    if (netCents <= 0) return
    const payload: RefundSubmitPayload = { refundCents: netCents, kind, skipChannelPush }
    if (grossCents !== netCents) payload.grossCents = grossCents
    if (restockCents > 0) payload.restockingFeeCents = restockCents
    if (shipCents > 0) payload.returnShippingFeeCents = shipCents
    if (perLineOpen) {
      const map: Record<string, number> = {}
      for (const [k, v] of Object.entries(lines)) { const c = Math.round(Number(v) * 100); if (c > 0) map[k] = c }
      if (Object.keys(map).length) payload.perLineAmounts = map
    }
    onSubmit(payload)
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-slate-500 dark:text-slate-400 mr-1">Type:</span>
        <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
          {REFUND_KINDS.map((rk) => (
            <button
              key={rk.k}
              onClick={() => setKind(rk.k)}
              className={`h-7 px-2.5 text-sm ${kind === rk.k ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              {rk.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {!perLineOpen ? (
          <>
            <span className="text-sm text-slate-500 dark:text-slate-400">Amount:</span>
            <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="h-8 w-24 px-2 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-base" />
            <span className="text-sm text-slate-500 dark:text-slate-400">€</span>
          </>
        ) : (
          <span className="text-sm text-slate-500 dark:text-slate-400">Per-line gross: <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-300">{fmt(grossCents)}</span></span>
        )}
        {items.length > 1 && (
          <button onClick={() => setPerLineOpen((o) => !o)} className="text-xs text-blue-700 dark:text-blue-300 hover:underline">
            {perLineOpen ? 'Use single amount' : 'Per-line allocation'}
          </button>
        )}
      </div>

      {perLineOpen && (
        <div className="space-y-1 pl-1">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-2">
              <span className="font-mono text-xs text-slate-600 dark:text-slate-300 flex-1 truncate">{it.sku} ×{it.quantity}</span>
              <input type="number" step="0.01" min="0" value={lines[it.id] ?? ''} onChange={(e) => setLines((l) => ({ ...l, [it.id]: e.target.value }))} placeholder="0.00" className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-sm" />
              <span className="text-xs text-slate-400">€</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="text-slate-500 dark:text-slate-400">Deduct:</span>
        <span className="inline-flex items-center gap-1">
          <input type="number" step="0.01" min="0" value={restockEuros} onChange={(e) => setRestockEuros(e.target.value)} placeholder="0" className="h-7 w-16 px-1.5 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-sm" />
          <span className="text-xs text-slate-400">€ restock</span>
        </span>
        {policy?.restockingFeePct ? (
          <button onClick={suggestRestock} className="text-xs text-blue-700 dark:text-blue-300 hover:underline" title={`Policy restocking fee: ${policy.restockingFeePct}%`}>
            apply {policy.restockingFeePct}%
          </button>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <input type="number" step="0.01" min="0" value={shipEuros} onChange={(e) => setShipEuros(e.target.value)} placeholder="0" className="h-7 w-16 px-1.5 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-sm" />
          <span className="text-xs text-slate-400">€ return ship</span>
        </span>
        {policy?.buyerPaysReturn && <span className="text-xs text-amber-700 dark:text-amber-300">policy: buyer pays return</span>}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-slate-600 dark:text-slate-300">Net: <span className="font-bold tabular-nums">{fmt(netCents)}</span></span>
        {(restockCents > 0 || shipCents > 0) && grossCents > 0 && (
          <span className="text-xs text-slate-400">({fmt(grossCents)} − {fmt(restockCents + shipCents)} fees)</span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {kind === 'CASH' ? (
          <>
            <button onClick={() => submit(false)} disabled={busy || netCents <= 0} className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5" title={`Issue refund on ${channel} and mark refunded`}>
              {busy ? '…' : `Refund on ${channel}`}
            </button>
            <button onClick={() => submit(true)} disabled={busy || netCents <= 0} className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50" title="Already refunded in channel back office — just mark Nexus">
              Mark only
            </button>
          </>
        ) : (
          <>
            <button onClick={() => submit(true)} disabled={busy || netCents <= 0} className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded hover:bg-slate-800 disabled:opacity-50" title={`Record ${kind === 'STORE_CREDIT' ? 'store credit' : 'exchange'} against this return`}>
              {busy ? '…' : `Record ${kind === 'STORE_CREDIT' ? 'store credit' : 'exchange'}`}
            </button>
            <span className="text-xs text-slate-400">Issue the {kind === 'STORE_CREDIT' ? 'store credit' : 'exchange'} in {channel}, then record it here.</span>
          </>
        )}
      </div>
    </div>
  )
}

// R6.2 — refund deadline countdown badge.
// Reads /returns/:id/policy and renders the days-until-deadline if
// the return is in a relevant state. Hidden for FBA (Amazon owns
// the deadline), already-refunded, or pre-receipt returns —
// nothing to count down to in those cases.
function RefundDeadlineBadge({
  deadline, status, refundStatus,
}: {
  deadline: RefundDeadlineView | null
  status: string
  refundStatus: string
}) {
  // RX.0 — presentational. The deadline now arrives via the drawer's
  // aggregate fetch; the badge no longer makes its own round-trip. The
  // relevance gate (only after receipt, before refund) is unchanged.
  const relevant =
    refundStatus !== 'REFUNDED' &&
    (status === 'RECEIVED' || status === 'INSPECTING')
  const data = relevant ? deadline : null

  if (!data || data.status === 'no_receive_date' || data.status === 'safe') return null

  // F1.12 — non-color signals: explicit severity prefix + role=status
  // + aria-label + dark-mode tones. Colorblind operators (and screen
  // readers) get the urgency from the leading "Critical" / "Warning"
  // word, not from rose/amber alone (WCAG 1.4.1).
  const isOverdue = data.status === 'overdue'
  const tone = isOverdue
    ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900'
    : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900'
  const severityWord = isOverdue ? 'Critical' : 'Warning'
  const detail = isOverdue
    ? `Overdue ${Math.abs(data.daysUntilDeadline ?? 0)}d`
    : `Refund due in ${data.daysUntilDeadline}d`
  const ariaLabel = isOverdue
    ? `Critical: refund overdue by ${Math.abs(data.daysUntilDeadline ?? 0)} days under Italian consumer law (${data.refundDeadlineDays}-day deadline)`
    : `Warning: refund due in ${data.daysUntilDeadline} days under Italian consumer law (${data.refundDeadlineDays}-day deadline)`

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${tone}`}
      title={`Italian consumer law: refund within ${data.refundDeadlineDays} days of receipt`}
    >
      <AlertTriangle size={11} aria-hidden="true" />
      <span className="font-bold">{severityWord}:</span>
      <span>{detail}</span>
    </span>
  )
}

function ReturnLabelPanel({
  returnRow,
  onUpdated,
}: {
  returnRow: ReturnRow
  onUpdated: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(returnRow.returnLabelUrl ?? '')
  const [carrier, setCarrier] = useState(returnRow.returnLabelCarrier ?? 'SENDCLOUD')
  const [tracking, setTracking] = useState(returnRow.returnTrackingNumber ?? '')

  const hasLabel = !!returnRow.returnLabelUrl
  const isEmailed = !!returnRow.returnLabelEmailedAt

  const handleAttach = async () => {
    if (!url.trim()) {
      toast.error('Label URL required')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnRow.id}/label`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: url.trim(),
            carrier: carrier || null,
            trackingNumber: tracking.trim() || null,
          }),
        },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success('Return label attached')
      setEditing(false)
      await onUpdated()
    } catch (err) {
      toast.error(`Attach failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleMarkEmailed = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnRow.id}/label/mark-emailed`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success('Marked as emailed to customer')
      await onUpdated()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    if (!(await askConfirm({ title: 'Remove return label?', description: 'Tracking and email status will also be cleared.', confirmLabel: 'Remove label', tone: 'danger' }))) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnRow.id}/label`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success('Label removed')
      setUrl('')
      setTracking('')
      setEditing(false)
      await onUpdated()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // O.75: native Sendcloud return-label generation. Replaces the
  // copy-paste-from-Sendcloud-dashboard workflow. dryRun-default —
  // when NEXUS_ENABLE_SENDCLOUD_REAL=false the backend returns a
  // mock URL + tracking so this round-trip works end-to-end without
  // touching Sendcloud. Real mode requires sandbox/production creds
  // wired via /carriers/SENDCLOUD/connect.
  const handleGenerate = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnRow.id}/generate-label`,
        { method: 'POST' },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(
        body.dryRun
          ? 'Mock label generated (NEXUS_ENABLE_SENDCLOUD_REAL=false)'
          : 'Sendcloud return label generated',
      )
      await onUpdated()
    } catch (err) {
      toast.error(`Generate failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copied`)
    } catch {
      toast.error('Copy failed — your browser blocked clipboard access')
    }
  }

  return (
    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2 inline-flex items-center gap-1.5">
        <Tag size={11} /> Return label
        {hasLabel && !isEmailed && (
          <Badge variant="warning" size="sm">Not emailed yet</Badge>
        )}
        {isEmailed && (
          <Badge variant="success" size="sm">Emailed</Badge>
        )}
      </div>

      {!hasLabel && !editing && (
        <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded p-3">
          <p className="text-base text-slate-600 dark:text-slate-400 mb-2">
            No label attached. Generate a Sendcloud return label in one click, or attach one you've already created in another portal.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerate}
              disabled={busy}
              className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 inline-flex items-center gap-1.5"
              title="Calls Sendcloud's parcels API with is_return=true. dryRun-default — mock label until NEXUS_ENABLE_SENDCLOUD_REAL=true."
            >
              <CheckCircle2 size={12} /> {busy ? 'Generating…' : 'Generate Sendcloud label'}
            </button>
            <button
              onClick={() => setEditing(true)}
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-white inline-flex items-center gap-1.5"
            >
              <Plus size={12} /> Attach existing
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-3 space-y-2">
          <div>
            <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              Label URL <span className="text-red-600">*</span>
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://app.sendcloud.com/labels/..."
              className="mt-1 w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                Carrier
              </label>
              <select
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                className="mt-1 w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
              >
                {CARRIER_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                Tracking number
              </label>
              <input
                type="text"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="Optional"
                className="mt-1 w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded font-mono"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleAttach}
              disabled={busy}
              className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <CheckCircle2 size={12} /> {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setEditing(false)
                setUrl(returnRow.returnLabelUrl ?? '')
                setCarrier(returnRow.returnLabelCarrier ?? 'SENDCLOUD')
                setTracking(returnRow.returnTrackingNumber ?? '')
              }}
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {hasLabel && !editing && (
        <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded p-3 space-y-2">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-base">
            <div className="md:col-span-2">
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">URL</div>
              <a
                href={returnRow.returnLabelUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-blue-700 dark:text-blue-300 hover:text-blue-900 break-all text-sm"
              >
                {returnRow.returnLabelUrl}
              </a>
            </div>
            <div className="space-y-1">
              {returnRow.returnLabelCarrier && (
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Carrier</div>
                  <div className="text-base text-slate-900 dark:text-slate-100 inline-flex items-center gap-1">
                    <Truck size={11} /> {returnRow.returnLabelCarrier}
                  </div>
                </div>
              )}
              {returnRow.returnTrackingNumber && (
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Tracking</div>
                  <div className="text-base font-mono text-slate-900 dark:text-slate-100">
                    {returnRow.returnTrackingNumber}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-200 dark:border-slate-700">
            <button
              onClick={() => handleCopy(returnRow.returnLabelUrl!, 'URL')}
              className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-white inline-flex items-center gap-1"
            >
              <Copy size={11} /> Copy URL
            </button>
            {returnRow.returnTrackingNumber && (
              <button
                onClick={() => handleCopy(returnRow.returnTrackingNumber!, 'Tracking number')}
                className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-white inline-flex items-center gap-1"
              >
                <Copy size={11} /> Copy tracking
              </button>
            )}
            {!isEmailed && (
              <button
                onClick={handleMarkEmailed}
                disabled={busy}
                className="h-7 px-2 text-sm bg-emerald-600 dark:bg-emerald-700 text-white border border-emerald-600 rounded hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1"
                title="Stamp the timestamp after you've emailed the URL to the customer"
              >
                <Mail size={11} /> Mark emailed
              </button>
            )}
            <button
              onClick={() => setEditing(true)}
              className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-white"
            >
              Edit
            </button>
            <button
              onClick={handleRemove}
              disabled={busy}
              className="h-7 px-2 text-sm text-red-700 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50 inline-flex items-center gap-1 ml-auto"
            >
              <Trash2 size={11} /> Remove
            </button>
          </div>

          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-3 flex-wrap">
            {returnRow.returnLabelGeneratedAt && (
              <span>Generated {new Date(returnRow.returnLabelGeneratedAt).toLocaleString()}</span>
            )}
            {returnRow.returnLabelEmailedAt && (
              <span>· Emailed {new Date(returnRow.returnLabelEmailedAt).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
