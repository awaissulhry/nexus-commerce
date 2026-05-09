'use client'

// F.5 — Smart Replenishment workspace.
//
// Reads from the F.4 forecast layer:
//   - urgency tiles (CRITICAL/HIGH/MEDIUM/LOW counts)
//   - upcoming retail events banner with prep deadlines
//   - virtualized table with forecast-driven velocity, lead-time-window
//     demand + 80% confidence band, ATP composition (on-hand + inbound),
//     lead time + supplier source
//   - row-click drawer with 90-day forecast chart, signal breakdown,
//     open inbound shipments
//   - multi-select → bulk-draft-PO flow (one POST creates one PO per
//     supplier, grouped automatically)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  AlertCircle,
  Download,
  Keyboard,
  Loader2,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  X,
} from 'lucide-react'
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts'
import PageHeader from '@/components/layout/PageHeader'
import {
  MultiSelectChips,
  ACTIVE_CHANNELS_OPTIONS,
  ACTIVE_MARKETPLACES_OPTIONS,
} from '@/components/ui/MultiSelectChips'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import { AutomationRulesCard } from './_shared/AutomationRulesCard'
import { CommandCenterKpis } from './_shared/CommandCenterKpis'
import { ScenariosCard } from './_shared/ScenariosCard'
import { SlowMoversCard } from './_shared/SlowMoversCard'
import { PanEuDistributionCard } from './_shared/PanEuDistributionCard'
import { SupplierSpendCard } from './_shared/SupplierSpendCard'
import { ForecastBiasCard } from './_shared/ForecastBiasCard'
import { CannibalizationCard } from './_shared/CannibalizationCard'

// W9.6c — Suggestion + Urgency + OpenShipmentRef moved to
// _shared/types.ts so the extracted shared cards pull the same shape.
import type { Suggestion } from './_shared/types'
import { MobileSuggestionCard } from './_shared/MobileSuggestionCard'
import { SuggestionRow } from './_shared/SuggestionRow'
import { ReorderMathPanel } from './_shared/ReorderMathPanel'
import { ForecastModelsCard } from './_shared/ForecastModelsCard'
import { StockoutImpactCard } from './_shared/StockoutImpactCard'
import { CashFlowCard } from './_shared/CashFlowCard'
import { BulkPoModal } from './_shared/BulkPoModal'
import { SavedViewsButton } from './_shared/SavedViewsButton'
import {
  SignalsPanel,
  StockByLocationPanel,
  ChannelCoverPanel,
} from './_shared/DrawerPanels'
import {
  FbaRestockHealthCard,
  FbaRestockSignalPanel,
} from './_shared/FbaRestockPanels'
import {
  ContainerFillCard,
  type ContainerFillEntry,
} from './_shared/ContainerFillCard'
import { KeyboardHelpOverlay } from './_shared/KeyboardHelpOverlay'
import type { DetailResponse } from './_shared/types'

// W9.6l — ContainerFillCard + ContainerFillEntry moved to _shared/.
//          KeyboardHelpOverlay moved to _shared/.

interface ReplenishmentResponse {
  suggestions: Suggestion[]
  counts: { critical: number; high: number; medium: number; low: number }
  window: number
  filter: { channel: string | null; marketplace: string | null }
  // R.19 — per-supplier container fill summary (only suppliers with profiles).
  containerFill?: ContainerFillEntry[]
}

// W9.6 — UpcomingEvent + UrgencyTile + UpcomingEventsBanner moved to
// _shared/UrgencyTiles.tsx so the workspace shrinks below 4400 lines.
import type { UpcomingEvent } from './_shared/UrgencyTiles'
import { UrgencyTile, UpcomingEventsBanner } from './_shared/UrgencyTiles'

// W9.6 — URGENCY_TONE source-of-truth lives in _shared/UrgencyTiles.
// Re-imported wherever the workspace's drawer header / cells still
// reference it directly.

// R.5 — sort keys for the table column headers. 'urgency' falls
// through to backend ordering (CRITICAL → HIGH → MEDIUM → LOW with
// daysOfStockLeft asc as tiebreaker); other keys re-sort the
// already-fetched array in JS.
// W9.6b — SortKey + SortableTh moved to _shared/SortableTh.tsx
import type { SortKey } from './_shared/SortableTh'
import { SortableTh } from './_shared/SortableTh'

export default function ReplenishmentWorkspace() {
  // R.5 — URL-driven state. Filters / search / sort are bookmarkable
  // and shareable. Selection + bulk modal stay local (ephemeral).
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useTranslations()

  const filter = (searchParams.get('filter') ??
    'NEEDS_REORDER') as 'ALL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NEEDS_REORDER'
  const channelFilter = searchParams.get('channel') ?? ''
  const marketplaceFilter = searchParams.get('marketplace') ?? ''
  const urlSearch = searchParams.get('search') ?? ''
  const sortBy = (searchParams.get('sortBy') ?? 'urgency') as SortKey
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'
  const drawerProductId = searchParams.get('drawer')

  const [data, setData] = useState<ReplenishmentResponse | null>(null)
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  // W2.2 — replaces window.prompt for dismiss-with-reason. Holds the
  // pending request; cleared on confirm/cancel. `onConfirm` receives
  // the trimmed reason or null when the operator left it blank.
  const [dismissPrompt, setDismissPrompt] = useState<{
    title: string
    onConfirm: (reason: string | null) => void
  } | null>(null)
  // searchInput is local + debounced; the URL param is the persisted value.
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  // R.5 — auto-refresh interval persisted per-device via localStorage.
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)
  // Keyboard shortcuts. focusedIndex is -1 when no row has keyboard
  // focus; helpOpen toggles the "?" overlay.
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [helpOpen, setHelpOpen] = useState(false)
  // Migrated from the inline 30-line toast queue to the app-wide
  // ToastProvider (components/ui/Toast.tsx). Same pushToast(tone, msg)
  // call signature so existing call-sites keep working unchanged;
  // tone 'ok' maps to 'success', 'error' stays.
  const { toast } = useToast()
  const pushToast = useCallback(
    (tone: 'ok' | 'error', msg: string) => {
      if (tone === 'ok') toast.success(msg)
      else toast.error(msg)
    },
    [toast],
  )

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  const setFilter = (f: typeof filter) => updateUrl({ filter: f === 'NEEDS_REORDER' ? undefined : f })
  const setChannelFilter = (c: string) => updateUrl({ channel: c || undefined })
  const setMarketplaceFilter = (m: string) => updateUrl({ marketplace: m || undefined })
  const setDrawerProductId = (id: string | null) => updateUrl({ drawer: id ?? undefined })
  const setSort = (key: SortKey) => {
    if (key === sortBy) {
      updateUrl({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })
    } else {
      updateUrl({ sortBy: key === 'urgency' ? undefined : key, sortDir: undefined })
    }
  }

  // Debounced search input → URL
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searchInput !== urlSearch) updateUrl({ search: searchInput || undefined })
    }, 250)
    return () => window.clearTimeout(t)
  }, [searchInput, urlSearch, updateUrl])

  // Restore auto-refresh preference
  useEffect(() => {
    const stored = window.localStorage.getItem('nexus-replenishment-autorefresh')
    const n = Number(stored)
    if (n === 5 || n === 15) setAutoRefreshMin(n)
  }, [])
  useEffect(() => {
    window.localStorage.setItem('nexus-replenishment-autorefresh', String(autoRefreshMin))
  }, [autoRefreshMin])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ window: '30' })
      if (channelFilter) params.set('channel', channelFilter)
      if (marketplaceFilter) params.set('marketplace', marketplaceFilter)
      const [r1, r2] = await Promise.all([
        fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment?${params.toString()}`,
          { cache: 'no-store' },
        ),
        fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment/upcoming-events`,
          { cache: 'no-store' },
        ),
      ])
      if (r1.ok) setData(await r1.json())
      if (r2.ok) {
        const ev = await r2.json()
        setEvents(ev.events ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [channelFilter, marketplaceFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // F.5.1 — Facets for the marketplace dropdown. Sourced from
  // /fulfillment/facets (distinct ACTIVE ChannelListing.marketplace
  // values), with a hardcoded fallback during initial load + on
  // facets endpoint failure so the dropdown is never empty.
  const FACETS_FALLBACK = ['IT', 'DE', 'FR', 'ES', 'UK', 'GLOBAL']
  const [marketplaceOptions, setMarketplaceOptions] =
    useState<string[]>(FACETS_FALLBACK)
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/fulfillment/facets`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return
        const list = Array.isArray(j.marketplaces) ? j.marketplaces : []
        if (list.length > 0) setMarketplaceOptions(list)
      })
      .catch(() => {
        // Keep fallback. Operator can still filter manually via URL.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    if (!data) return []
    let rows = data.suggestions
    if (filter === 'CRITICAL') rows = rows.filter((s) => s.urgency === 'CRITICAL')
    else if (filter === 'HIGH')
      rows = rows.filter((s) => s.urgency === 'HIGH' || s.urgency === 'CRITICAL')
    else if (filter === 'MEDIUM') rows = rows.filter((s) => s.urgency === 'MEDIUM')
    else if (filter === 'NEEDS_REORDER') rows = rows.filter((s) => s.needsReorder)
    if (urlSearch.trim()) {
      const q = urlSearch.trim().toLowerCase()
      rows = rows.filter(
        (r) =>
          r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
    }
    // R.5 — client-side sort. urgency mode = backend ordering; other
    // keys re-sort the already-fetched array.
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortBy !== 'urgency') {
      rows = [...rows].sort((a, b) => {
        let av: number | string
        let bv: number | string
        switch (sortBy) {
          case 'daysOfCover':
            av = a.daysOfStockLeft ?? Number.MAX_SAFE_INTEGER
            bv = b.daysOfStockLeft ?? Number.MAX_SAFE_INTEGER
            return (av - (bv as number)) * dir
          case 'velocity': return ((a.velocity ?? 0) - (b.velocity ?? 0)) * dir
          case 'qty':      return ((a.reorderQuantity ?? 0) - (b.reorderQuantity ?? 0)) * dir
          case 'stock':    return ((a.effectiveStock ?? 0) - (b.effectiveStock ?? 0)) * dir
          case 'sku':      return a.sku.localeCompare(b.sku) * dir
          case 'name':     return a.name.localeCompare(b.name) * dir
          default:         return 0
        }
      })
    }
    return rows
  }, [data, filter, urlSearch, sortBy, sortDir])

  // R.5 — auto-refresh. Pause when document is hidden so a backgrounded
  // tab doesn't burn requests.
  useEffect(() => {
    if (autoRefreshMin === 0) return
    const ms = autoRefreshMin * 60_000
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchData()
    }, ms)
    return () => window.clearInterval(id)
  }, [autoRefreshMin, fetchData])

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map((r) => r.productId)))
    }
  }
  const clearSelection = () => setSelectedIds(new Set())

  const draftSinglePo = async (s: Suggestion) => {
    if (s.isManufactured) {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/work-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: s.productId,
          quantity: s.reorderQuantity,
          notes: 'Replenishment auto-suggestion',
        }),
      })
      if (res.ok) {
        pushToast('ok', `Work order created for ${s.reorderQuantity} × ${s.sku}`)
        fetchData()
      } else pushToast('error', 'Work order create failed')
      return
    }
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${s.productId}/draft-po`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: s.reorderQuantity,
          supplierId: s.preferredSupplierId,
          // R.3 — link PO back to source recommendation
          recommendationId: s.recommendationId ?? undefined,
        }),
      },
    )
    if (res.ok) {
      const po = await res.json()
      pushToast('ok', `Draft PO ${po.poNumber} created`)
      fetchData()
    } else {
      pushToast('error', 'Draft PO failed')
    }
  }

  // W2.2 — opens DismissReasonModal with a callback. Replaces 4
  // window.prompt() callsites with a proper modal that supports dark
  // mode, focus management, escape-to-cancel, and Italian i18n.
  const askDismissReason = useCallback(
    (title: string, onConfirm: (reason: string | null) => void) => {
      setDismissPrompt({ title, onConfirm })
    },
    [],
  )

  // R.21 — Bulk-dismiss every currently-selected recommendation. The
  // backend loops single-id dismiss internally; we get back per-id
  // counts. Toast summarises so operators clearing 200 noisy MEDIUMs
  // see exactly what landed.
  const bulkDismissSelected = async (reason: string | null) => {
    const ids = filtered
      .filter((s) => selectedIds.has(s.productId) && s.recommendationId)
      .map((s) => s.recommendationId!)
    if (ids.length === 0) {
      pushToast('error', 'No recommendations selected (or selection lacks rec ids)')
      return
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/recommendations/bulk-dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recommendationIds: ids, reason }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const r = await res.json()
      const parts = [`${r.succeeded} dismissed`]
      if (r.alreadyTerminal > 0) parts.push(`${r.alreadyTerminal} already gone`)
      if (r.failed?.length > 0) parts.push(`${r.failed.length} errored`)
      pushToast(r.failed?.length > 0 ? 'error' : 'ok', parts.join(' · '))
      clearSelection()
      fetchData()
    } catch (err) {
      pushToast(
        'error',
        `Bulk dismiss failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // R.21 — Dismiss a recommendation. ACTIVE → DISMISSED in DB; the
  // operator's reason flows to dismissedReason for audit. We refetch
  // after success so the row falls out of the visible list (it's no
  // longer ACTIVE on the next forecast pass either, until the engine
  // generates a fresh rec — which it will when the underlying signal
  // changes).
  const dismissRow = async (s: Suggestion, reason: string | null) => {
    if (!s.recommendationId) {
      pushToast('error', 'No recommendation id on this row')
      return
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/recommendations/${s.recommendationId}/dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      pushToast('ok', `Dismissed: ${s.sku}`)
      fetchData()
    } catch (err) {
      pushToast(
        'error',
        `Dismiss failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const drawerProduct = useMemo(
    () => filtered.find((s) => s.productId === drawerProductId) ?? null,
    [filtered, drawerProductId],
  )

  // Reset focused index when filtered list changes and current focus
  // is out of bounds (e.g. user changed filter and the focused row
  // disappeared).
  useEffect(() => {
    if (focusedIndex >= filtered.length) {
      setFocusedIndex(filtered.length > 0 ? filtered.length - 1 : -1)
    }
  }, [filtered, focusedIndex])

  // Scroll the focused row into view. `block: 'nearest'` keeps the
  // page from scrolling when the row is already visible.
  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= filtered.length) return
    const id = filtered[focusedIndex].productId
    const el = document.querySelector<HTMLElement>(`[data-suggestion-id="${id}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex, filtered])

  // Global keyboard handler. Skips when the user is typing in an
  // input/textarea (except Esc, which still routes through to close
  // the drawer / blur the input). Help overlay (?) toggles a modal
  // listing all shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const inInput =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable === true

      if (e.key === 'Escape') {
        if (helpOpen) {
          setHelpOpen(false)
          return
        }
        if (inInput) {
          ;(target as HTMLElement).blur()
          return
        }
        if (drawerProductId) {
          setDrawerProductId(null)
          return
        }
        if (selectedIds.size > 0) {
          clearSelection()
          return
        }
        if (focusedIndex >= 0) {
          setFocusedIndex(-1)
          return
        }
      }

      if (inInput) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen((v) => !v)
        return
      }
      if (helpOpen) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex((i) => {
          if (i < 0) return 0
          return Math.min(filtered.length - 1, i + 1)
        })
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex((i) => Math.max(0, i - 1))
        return
      }

      const focused =
        focusedIndex >= 0 && focusedIndex < filtered.length
          ? filtered[focusedIndex]
          : null

      if (focused) {
        if (e.key === 'Enter') {
          e.preventDefault()
          setDrawerProductId(focused.productId)
          return
        }
        if (e.key === 'x' || e.key === ' ') {
          e.preventDefault()
          toggleSelected(focused.productId)
          return
        }
        if (e.key === 'p') {
          e.preventDefault()
          draftSinglePo(focused)
          return
        }
        if (e.key === 'd') {
          e.preventDefault()
          askDismissReason(
            t('replenishment.dismiss.titleSku', { sku: focused.sku }),
            (reason) => {
              void dismissRow(focused, reason)
            },
          )
          return
        }
      }

      if (e.key === '1') {
        e.preventDefault()
        setFilter('CRITICAL')
        return
      }
      if (e.key === '2') {
        e.preventDefault()
        setFilter('HIGH')
        return
      }
      if (e.key === '3') {
        e.preventDefault()
        setFilter('MEDIUM')
        return
      }
      if (e.key === '0') {
        e.preventDefault()
        setFilter('ALL')
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        const input = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search SKU…"]',
        )
        input?.focus()
        input?.select()
        return
      }
      if (e.key === 'r') {
        e.preventDefault()
        fetchData()
        return
      }
      if (e.key === 'g') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex(0)
        return
      }
      if (e.key === 'G') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex(filtered.length - 1)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filtered,
    focusedIndex,
    helpOpen,
    selectedIds,
    drawerProductId,
  ])

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('replenishment.title')}
        description={t('replenishment.description')}
        breadcrumbs={[
          { label: t('replenishment.breadcrumb.fulfillment'), href: '/fulfillment' },
          { label: t('replenishment.breadcrumb.self') },
        ]}
      />

      {/* U.67 — quick-filters strip. Single-select per dimension because
          the velocity backend does per-channel attribution math; an [All]
          chip + per-channel single-select keeps the UX consistent with
          /products and /listings. */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 flex items-center gap-x-5 gap-y-2 flex-wrap">
        <MultiSelectChips
          label="Channel"
          mode="single"
          options={ACTIVE_CHANNELS_OPTIONS}
          value={channelFilter ? [channelFilter] : []}
          onChange={(next) => setChannelFilter(next[0] ?? '')}
        />
        <MultiSelectChips
          label="Market"
          mode="single"
          options={ACTIVE_MARKETPLACES_OPTIONS}
          value={marketplaceFilter ? [marketplaceFilter] : []}
          onChange={(next) => setMarketplaceFilter(next[0] ?? '')}
        />
      </div>

      {/* W2.2 — dismiss-reason modal. Mounted once at the top of the
          tree; opened imperatively via askDismissReason() from row
          clicks, the bulk-dismiss button, and the 'd' keyboard shortcut. */}
      <DismissReasonModal
        open={dismissPrompt !== null}
        title={dismissPrompt?.title ?? ''}
        onClose={() => setDismissPrompt(null)}
        onConfirm={(reason) => {
          dismissPrompt?.onConfirm(reason)
          setDismissPrompt(null)
        }}
      />

      {/* W1.5 — pipeline health strip. Surfaces foundation-table row
          counts + cron status + a "Run pipeline now" button so silent
          failures of the forecast layer become visible at a glance. */}
      <PipelineHealthStrip onRefreshPageData={fetchData} />

      {/* W4.5 — automation rules card. Empty by default; once seeded
          shows the 8 templates with enable/disable toggles + dry-run
          badges + per-rule counters. */}
      <div id="automation" className="scroll-mt-4">
        <AutomationRulesCard />
      </div>

      {/* W5.4 — scenarios card. Empty by default; once an operator
          creates a what-if scenario it lists with last-run summary
          and a Run button. Pure analysis — never modifies real recs. */}
      <div id="scenarios" className="scroll-mt-4">
        <ScenariosCard />
      </div>

      {/* W6.1 — slow-mover / dead-stock dashboard. Hides itself when
          no DORMANT inventory exists; otherwise lists top 50 by
          capital tied up with bucket switcher. */}
      <div id="slow-movers" className="scroll-mt-4">
        <SlowMoversCard />
      </div>

      {/* W7.2 — Pan-EU FBA distribution recommender. Hides itself
          when inventory is balanced; otherwise lists surplus →
          shortage transfer suggestions across IT/DE/FR/ES/NL. */}
      <div id="pan-eu" className="scroll-mt-4">
        <PanEuDistributionCard />
      </div>

      {/* W9.3 — supplier spend dashboard. Hides itself when no PO
          history exists; otherwise lists per-supplier 30/90/365d
          spend + open commitment, sorted by 90d spend desc. */}
      <div id="supplier-spend" className="scroll-mt-4">
        <SupplierSpendCard />
      </div>

      {/* W8.4b — forecast bias card. Hides itself when there's no
          ForecastAccuracy data or every SKU is calibrated; otherwise
          surfaces top 20 most-miscalibrated SKUs by bias direction. */}
      <div id="forecast-bias" className="scroll-mt-4">
        <ForecastBiasCard />
      </div>

      {/* W8.3b — cannibalization card. Hides itself when no recently
          launched SKU has cannibalized siblings. Each finding expands
          to show pre/post velocity for affected SKUs. */}
      <div id="cannibalization" className="scroll-mt-4">
        <CannibalizationCard />
      </div>

      {/* W3.2 — command-center KPI strip. Five tiles answering
          "what should I do today?" — open POs / awaiting review /
          stockout risk / working capital / forecast accuracy.
          Distinct from the W1.5 pipeline-health strip which answers
          "is the system working?". */}
      <CommandCenterKpis onFilterCritical={() => setFilter('CRITICAL')} />

      {/* Upcoming-events banner — surfaces the next ≤3 events with prep deadlines */}
      {events && events.length > 0 && (
        <UpcomingEventsBanner events={events.slice(0, 3)} />
      )}

      {/* Urgency tiles */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <UrgencyTile
            label={t('replenishment.urgency.critical')}
            value={data.counts.critical}
            tone="CRITICAL"
            onClick={() => setFilter('CRITICAL')}
          />
          <UrgencyTile
            label={t('replenishment.urgency.high')}
            value={data.counts.high}
            tone="HIGH"
            onClick={() => setFilter('HIGH')}
          />
          <UrgencyTile
            label={t('replenishment.urgency.medium')}
            value={data.counts.medium}
            tone="MEDIUM"
            onClick={() => setFilter('MEDIUM')}
          />
          <UrgencyTile
            label={t('replenishment.urgency.lowOk')}
            value={data.counts.low}
            tone="LOW"
            onClick={() => setFilter('ALL')}
          />
        </div>
      )}

      {/* R.1 — forecast health (aggregate MAPE + per-regime + trend).
          Renders only when accuracy data exists (post-cron / post-
          backfill); silent before the first run so the page doesn't
          show a noisy empty card. */}
      <ForecastHealthCard />

      {/* R.12 — stockout impact (events count + lost margin/revenue).
          Renders only when there are stockouts to report; silent
          pre-launch. */}
      <StockoutImpactCard />

      {/* R.16 — model A/B card. Silent unless a challenger is rolled
          out via the rollout endpoint. */}
      <ForecastModelsCard />

      {/* R.19 — supplier-level container fill summary. Silent unless
          at least one supplier has a SupplierShippingProfile. */}
      {data?.containerFill && data.containerFill.length > 0 && (
        <ContainerFillCard entries={data.containerFill} />
      )}

      {/* R.20 — 13-week cash flow projection. Always renders; prompts
          the operator to set cashOnHandCents when null. */}
      <CashFlowCard />

      {/* R.8 — Amazon FBA Restock health. Silent until at least one
          marketplace has a fresh ingestion. */}
      <FbaRestockHealthCard />


      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
          {(['NEEDS_REORDER', 'CRITICAL', 'HIGH', 'MEDIUM', 'ALL'] as const).map(
            (t) => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={cn(
                  'h-7 px-3 text-base font-medium rounded transition-colors',
                  filter === t
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {t === 'NEEDS_REORDER'
                  ? 'Needs reorder'
                  : t.charAt(0) + t.slice(1).toLowerCase()}
              </button>
            ),
          )}
        </div>
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="h-8 px-2 border border-slate-200 rounded-md text-base bg-white"
        >
          <option value="">All channels</option>
          <option value="AMAZON">Amazon</option>
          <option value="EBAY">eBay</option>
          <option value="SHOPIFY">Shopify</option>
          <option value="WOOCOMMERCE">WooCommerce</option>
        </select>
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="h-8 px-2 border border-slate-200 rounded-md text-base bg-white"
        >
          <option value="">All marketplaces</option>
          {marketplaceOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <SavedViewsButton
          currentState={{
            filter,
            channelFilter,
            marketplaceFilter,
            search: urlSearch,
            sortBy,
            sortDir,
          }}
          onLoad={(state) => {
            updateUrl({
              filter: state.filter === 'NEEDS_REORDER' ? undefined : state.filter,
              channel: state.channelFilter || undefined,
              marketplace: state.marketplaceFilter || undefined,
              search: state.search || undefined,
              sortBy: state.sortBy === 'urgency' ? undefined : state.sortBy,
              sortDir: state.sortDir === 'desc' ? undefined : state.sortDir,
            })
          }}
        />

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search SKU…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-44 sm:w-56"
          />
          {/* R.5 — auto-refresh dropdown. Pauses when tab is hidden. */}
          <select
            value={autoRefreshMin}
            onChange={(e) => setAutoRefreshMin(Number(e.target.value) as 0 | 5 | 15)}
            className="h-8 px-2 text-sm border border-slate-200 rounded-md bg-white"
            title="Auto-refresh interval (paused when tab hidden)"
          >
            <option value={0}>Auto-refresh: Off</option>
            <option value={5}>Auto-refresh: 5 min</option>
            <option value={15}>Auto-refresh: 15 min</option>
          </select>
          <button
            onClick={fetchData}
            className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Refresh
          </button>
          {/* R.5 — CSV export of currently filtered + sorted suggestions */}
          <button
            onClick={() => exportSuggestionsCsv(filtered)}
            className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
            title="Export the currently filtered + sorted suggestions to CSV"
            disabled={filtered.length === 0}
          >
            <Download size={12} /> Export CSV
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            className="h-8 w-8 grid place-items-center text-base border border-slate-200 rounded-md hover:bg-slate-50 text-slate-500"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={12} />
          </button>
        </div>
      </div>

      {/* Bulk action bar — visible only when rows are selected */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-2 flex items-center justify-between gap-3">
          <div className="text-md text-slate-700">
            <span className="font-semibold">{selectedIds.size}</span>{' '}
            selected
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="h-7 px-2 text-base border border-slate-200 rounded hover:bg-slate-50"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                askDismissReason(
                  t('replenishment.dismiss.titleBulk', { count: selectedIds.size }),
                  (reason) => {
                    void bulkDismissSelected(reason)
                  },
                )
              }}
              className="h-7 px-3 text-base bg-white text-red-700 border border-red-200 rounded hover:bg-red-50 inline-flex items-center gap-1.5"
              title={t('replenishment.dismiss.bulkTooltip')}
            >
              <X size={12} /> {t('replenishment.dismiss.bulkButton')}
            </button>
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              className="h-7 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
            >
              <ShoppingCart size={12} /> Bulk-create POs
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading && !data ? (
        <Card>
          <div className="text-md text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" />
            Reading forecast layer…
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing to reorder"
          description="All products in this view have plenty of runway."
        />
      ) : (
        <>
        {/* R.5 — mobile: render each suggestion as a card. Desktop
            (lg+) keeps the dense table. The 13-column layout was an
            unusable horizontal scroll below ~1100px. */}
        <div className="lg:hidden space-y-2">
          {filtered.map((s, idx) => (
            <MobileSuggestionCard
              key={s.productId}
              s={s}
              selected={selectedIds.has(s.productId)}
              focused={idx === focusedIndex}
              onToggleSelect={() => toggleSelected(s.productId)}
              onOpenDrawer={() => setDrawerProductId(s.productId)}
              onDraftPo={() => draftSinglePo(s)}
              onDismiss={() =>
                askDismissReason(
                  t('replenishment.dismiss.titleSku', { sku: s.sku }),
                  (reason) => {
                    void dismissRow(s, reason)
                  },
                )
              }
            />
          ))}
        </div>
        <Card noPadding className="hidden lg:block">
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left w-9">
                    <input
                      type="checkbox"
                      checked={
                        filtered.length > 0 &&
                        selectedIds.size === filtered.length
                      }
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </th>
                  <SortableTh sortKey="name" current={sortBy} dir={sortDir} onSort={setSort} className={th()}>Product</SortableTh>
                  <SortableTh sortKey="urgency" current={sortBy} dir={sortDir} onSort={setSort} className={th()}>Urgency</SortableTh>
                  <SortableTh sortKey="stock" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>On-hand</SortableTh>
                  <th className={thRight()}>Inbound (LT)</th>
                  <th className={thRight()}>ATP</th>
                  <SortableTh sortKey="velocity" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>Velocity</SortableTh>
                  <SortableTh sortKey="daysOfCover" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>Days left</SortableTh>
                  <th className={thRight()}>Lead time</th>
                  <th className={thRight()}>Forecast (LT)</th>
                  <SortableTh sortKey="qty" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>Suggested qty</SortableTh>
                  <th className={thRight()}></th>
                  <th className={th()}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, idx) => (
                  <SuggestionRow
                    key={s.productId}
                    suggestion={s}
                    selected={selectedIds.has(s.productId)}
                    focused={idx === focusedIndex}
                    onToggle={() => toggleSelected(s.productId)}
                    onOpenDrawer={() => setDrawerProductId(s.productId)}
                    onDraftPo={() => draftSinglePo(s)}
                    onDismiss={() =>
                askDismissReason(
                  t('replenishment.dismiss.titleSku', { sku: s.sku }),
                  (reason) => {
                    void dismissRow(s, reason)
                  },
                )
              }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        </>
      )}

      {/* Toast tray now lives at the app layout level (ToastProvider in
          /app/layout.tsx → /components/ui/Toast.tsx). pushToast above
          calls into the shared useToast() hook. */}

      {/* Detail drawer */}
      {drawerProduct && (
        <ForecastDetailDrawer
          productId={drawerProduct.productId}
          marketplace={marketplaceFilter || null}
          channel={channelFilter || null}
          onClose={() => setDrawerProductId(null)}
        />
      )}

      {/* Keyboard shortcuts overlay (?) */}
      {helpOpen && <KeyboardHelpOverlay onClose={() => setHelpOpen(false)} />}

      {/* Bulk-PO modal */}
      {bulkOpen && (
        <BulkPoModal
          suggestions={filtered.filter((s) => selectedIds.has(s.productId))}
          onClose={() => setBulkOpen(false)}
          onSuccess={() => {
            setBulkOpen(false)
            clearSelection()
            fetchData()
          }}
        />
      )}
    </div>
  )
}

function th() {
  return 'px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700'
}
function thRight() {
  return 'px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700'
}

// W9.6 — UrgencyTile + UpcomingEventsBanner moved to
// _shared/UrgencyTiles.tsx (imported at the top of this file).

// W9.6b — SortableTh moved to _shared/SortableTh.tsx (imported above).

// W9.6c — MobileSuggestionCard moved to _shared/MobileSuggestionCard.tsx
// (imported alongside Suggestion at the top of this file).

// R.5 — CSV export of currently filtered + sorted suggestions.
// Pure client-side: build the CSV string, trigger a download via
// <a download>. No new endpoint.
function exportSuggestionsCsv(suggestions: Suggestion[]): void {
  const rows: string[][] = [
    [
      'SKU', 'Name', 'Urgency', 'On-hand', 'Inbound (LT)', 'Effective stock',
      'Velocity (units/day)', 'Forecast 30d', 'Days of cover', 'Reorder point',
      'Reorder qty', 'Safety stock', 'EOQ', 'Constraints', 'Lead time (days)',
      'Supplier', 'Recommendation ID',
    ],
  ]
  for (const s of suggestions) {
    rows.push([
      s.sku,
      s.name,
      s.urgency,
      String(s.currentStock),
      String(s.inboundWithinLeadTime),
      String(s.effectiveStock),
      String(s.velocity),
      s.forecastedDemand30d != null ? String(s.forecastedDemand30d) : '',
      s.daysOfStockLeft != null ? String(s.daysOfStockLeft) : '',
      String(s.reorderPoint),
      String(s.reorderQuantity),
      s.safetyStockUnits != null ? String(s.safetyStockUnits) : '',
      s.eoqUnits != null ? String(s.eoqUnits) : '',
      (s.constraintsApplied ?? []).join('|'),
      String(s.leadTimeDays),
      s.preferredSupplierId ?? '',
      s.recommendationId ?? '',
    ])
  }
  const csv = rows
    .map((r) => r.map((cell) => {
      const needsQuote = /[",\n]/.test(cell)
      return needsQuote ? `"${cell.replace(/"/g, '""')}"` : cell
    }).join(','))
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `replenishment-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}



function ForecastDetailDrawer({
  productId,
  marketplace,
  channel,
  onClose,
}: {
  productId: string
  marketplace: string | null
  channel: string | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // R.5 — error state. Pre-R.5 a fetch failure left the spinner
  // running indefinitely; now we render an error panel with retry.
  const [error, setError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (channel) params.set('channel', channel)
    if (marketplace) params.set('marketplace', marketplace)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
        params.toString() ? `?${params.toString()}` : ''
      }`,
      { cache: 'no-store' },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`)
        return r.json()
      })
      .then((j) => {
        if (cancelled) return
        setDetail(j)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId, channel, marketplace, retryTick])

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-slate-900/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="w-full max-w-2xl bg-white border-l border-slate-200 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div className="min-w-0">
            {detail ? (
              <>
                <div className="text-lg font-semibold text-slate-900 truncate">
                  {detail.product.name}
                </div>
                <div className="text-sm text-slate-500 font-mono">
                  {detail.product.sku}
                </div>
              </>
            ) : (
              <div className="text-md text-slate-500">Loading detail…</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && !error && (
            <div className="text-md text-slate-500 inline-flex items-center gap-2 py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading forecast…
            </div>
          )}
          {/* R.5 — error UI with retry. Pre-R.5 a fetch failure left
              the spinner running indefinitely. */}
          {!loading && error && (
            <div className="bg-rose-50 border border-rose-200 rounded p-4 text-md text-rose-800">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold mb-1">Couldn't load forecast detail</div>
                  <div className="text-base mb-3">{error}</div>
                  <button
                    onClick={() => setRetryTick((n) => n + 1)}
                    className="h-7 px-2.5 text-sm bg-rose-600 text-white rounded hover:bg-rose-700 inline-flex items-center gap-1"
                  >
                    <RefreshCw size={11} /> Retry
                  </button>
                </div>
              </div>
            </div>
          )}
          {!loading && !error && detail && (
            <>
              {/* 90-day chart */}
              <div>
                <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold mb-1">
                  60-day actual + 90-day forecast
                </div>
                <div className="h-56 w-full">
                  <ResponsiveContainer>
                    <ComposedChart data={detail.series} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                      <CartesianGrid stroke="#eef2f7" vertical={false} />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 10, fill: '#64748b' }}
                        tickFormatter={(v) => v.slice(5)}
                        minTickGap={24}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#64748b' }}
                        width={28}
                      />
                      <Tooltip
                        contentStyle={{ fontSize: 11 }}
                        formatter={(v: any) => (typeof v === 'number' ? v.toFixed(1) : v)}
                      />
                      <ReferenceLine
                        x={detail.series.find((p) => p.forecast != null)?.day}
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        label={{
                          value: 'today',
                          fontSize: 10,
                          fill: '#64748b',
                          position: 'insideTopRight',
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="upper80"
                        stroke="none"
                        fill="#bfdbfe"
                        fillOpacity={0.3}
                      />
                      <Area
                        type="monotone"
                        dataKey="lower80"
                        stroke="none"
                        fill="#ffffff"
                        fillOpacity={1}
                      />
                      <Line
                        type="monotone"
                        dataKey="actual"
                        stroke="#0f172a"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="forecast"
                        stroke="#3b82f6"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                        strokeDasharray="3 3"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 flex items-center gap-3 text-sm text-slate-500">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-px bg-slate-900" /> actual
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-px border-t border-dashed border-blue-500" /> forecast
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-2 bg-blue-200 rounded-sm" /> 80% interval
                  </span>
                  {detail.generationTag && (
                    <span className="ml-auto text-xs uppercase tracking-wider text-amber-700">
                      {detail.generationTag.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  )}
                </div>
              </div>

              {/* R.2 — per-location stock breakdown + ATP totals */}
              {detail.atp && (
                <StockByLocationPanel atp={detail.atp} />
              )}

              {/* R.14 — channel-driven urgency banner. Renders only
                  when the worst channel pushed urgency above what the
                  global aggregate would have shown. Tells operators
                  why the headline is more severe than the totals
                  suggest. */}
              {detail.recommendation?.urgencySource === 'CHANNEL' &&
                detail.recommendation?.worstChannelKey && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-base text-rose-800">
                  <span className="font-semibold">{detail.recommendation.urgency}</span>{' '}
                  driven by{' '}
                  <span className="font-mono">
                    {detail.recommendation.worstChannelKey.replace(':', ' · ')}
                  </span>
                  {' '}({detail.recommendation.worstChannelDaysOfCover}d cover).
                  Aggregate stock looks fine, but this channel is at risk.
                </div>
              )}

              {/* R.2 — per-channel days-of-cover */}
              {detail.channelCover && detail.channelCover.length > 0 && (
                <ChannelCoverPanel
                  channelCover={detail.channelCover}
                  leadTimeDays={detail.atp?.leadTimeDays ?? 14}
                />
              )}

              {/* R.4 — reorder math snapshot. Shows EOQ, safety stock,
                  reorder point, and any MOQ/case-pack constraints
                  that bumped the final qty up. */}
              {detail.recommendation && (
                <ReorderMathPanel rec={detail.recommendation} />
              )}

              {/* R.8 — Amazon FBA Restock cross-check. Renders only
                  when this product has a fresh Amazon recommendation
                  cached on the rec. */}
              {detail.recommendation?.amazonRecommendedQty != null && detail.recommendation && (
                <FbaRestockSignalPanel rec={detail.recommendation} />
              )}

              {/* R.9 — supplier alternatives. Lazy-loaded panel that
                  ranks every supplier with a SupplierProduct row for
                  this product. */}
              <SupplierAlternativesPanel
                productId={productId}
                urgency={detail.recommendation?.urgency ?? 'MEDIUM'}
                onChanged={async () => {
                  const params = new URLSearchParams()
                  if (marketplace) params.set('marketplace', marketplace)
                  if (channel) params.set('channel', channel)
                  const r = await fetch(
                    `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
                      params.toString() ? `?${params.toString()}` : ''
                    }`,
                  )
                  if (r.ok) setDetail(await r.json())
                }}
              />


              {/* R.17 — substitution links + raw-vs-adjusted velocity. */}
              <SubstitutionPanel
                productId={productId}
                rec={detail.recommendation}
                substitutions={detail.substitutions ?? []}
                onChanged={async () => {
                  const params = new URLSearchParams()
                  if (marketplace) params.set('marketplace', marketplace)
                  if (channel) params.set('channel', channel)
                  const r = await fetch(
                    `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
                      params.toString() ? `?${params.toString()}` : ''
                    }`,
                  )
                  if (r.ok) setDetail(await r.json())
                }}
              />


              {/* Open shipments */}
              {detail.atp && detail.atp.openShipments.length > 0 && (
                <div>
                  <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold mb-2">
                    Open inbound shipments
                  </div>
                  <div className="border border-slate-200 rounded overflow-hidden">
                    {detail.atp.openShipments.map((sh) => (
                      <div
                        key={sh.shipmentId}
                        className="flex items-center justify-between px-3 py-1.5 text-base border-b border-slate-100 last:border-0"
                      >
                        <div>
                          <span className="font-mono text-sm text-slate-700">
                            {sh.reference ?? sh.shipmentId.slice(-8)}
                          </span>
                          <span className="ml-2 text-xs uppercase tracking-wider text-slate-500">
                            {sh.type} · {sh.status}
                          </span>
                        </div>
                        <div className="text-slate-700 tabular-nums">
                          +{sh.remainingUnits} units
                          {sh.expectedAt && (
                            <span className="ml-2 text-sm text-slate-500">
                              {new Date(sh.expectedAt)
                                .toISOString()
                                .slice(0, 10)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Signals breakdown */}
              {detail.signals && typeof detail.signals === 'object' && (
                <SignalsPanel signals={detail.signals} />
              )}

              {/* R.1 — Forecast accuracy. Below signals so the reading
                  flow is prediction → causal → retrospective. */}
              <ForecastAccuracyCard
                sku={detail.product?.sku ?? null}
                channel={null}
                marketplace={null}
              />

              {/* R.3 — Recommendation history. Audit trail of every
                  recommendation we've ever shown for this product +
                  the POs/WOs that came from them. Collapsed by
                  default; expand to load. */}
              <RecommendationHistoryCard productId={detail.product?.id ?? null} />

              {/* Model */}
              {detail.model && (
                <div className="text-sm text-slate-500">
                  Generated by{' '}
                  <span className="font-mono text-slate-700">{detail.model}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}


// W2.2 — Dismiss-reason prompt. Modal-based replacement for the four
// window.prompt() callsites that asked for an optional dismiss reason.
// Centralised so the operator gets focus management, escape-to-cancel,
// dark mode, and Italian i18n — none of which window.prompt offers.
function DismissReasonModal({
  open,
  title,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  onClose: () => void
  onConfirm: (reason: string | null) => void
}) {
  const { t } = useTranslations()
  const [reason, setReason] = useState('')
  // Reset every time the modal opens for a fresh prompt.
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
        {t('replenishment.dismiss.optionalReasonHint')}
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        autoFocus
        placeholder={t('replenishment.dismiss.placeholder')}
        aria-label={t('replenishment.dismiss.reasonLabel')}
        className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
        onKeyDown={(e) => {
          // ⌘+Enter / Ctrl+Enter submits, matching ConfirmDialog ergonomics.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onConfirm(reason.trim() || null)
          }
        }}
      />
      <ModalFooter>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="danger"
          onClick={() => onConfirm(reason.trim() || null)}
        >
          {t('replenishment.dismiss.confirmButton')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// W1.5 — Pipeline health strip. Surfaces foundation-table row counts
// + cron status + a "Run pipeline now" button so silent failures of
// the forecast layer become visible at a glance. Pairs with W1.3
// (POST .../pipeline/run) and W1.4 (GET .../pipeline/health).
//
// Tone rules:
//   green  — rows > 0 AND last cron success within 48h
//   amber  — rows > 0 AND last cron stale (>48h) OR no recent run
//   red    — rows = 0 (foundation table empty)
//   slate  — disabled via env flag (informational, not a failure)
interface PipelineHealth {
  tables: {
    dailySalesAggregate: { rows: number; oldest: string | null; newest: string | null; updatedAt: string | null }
    replenishmentForecast: { rows: number; latestHorizon: string | null; lastGeneratedAt: string | null }
    forecastAccuracy: { rows: number; latestDay: string | null; avgPercentError: number | null; withinBandCount: number }
  }
  crons: Record<
    'forecast' | 'forecast-accuracy' | 'abc-classification',
    {
      lastRun: { startedAt: string; finishedAt: string | null; status: string; outputSummary: string | null; triggeredBy: string } | null
      enabledFlag: boolean
    }
  >
}

function PipelineHealthStrip({ onRefreshPageData }: { onRefreshPageData: () => void }) {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [health, setHealth] = useState<PipelineHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const fetchHealth = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/pipeline/health`,
        { cache: 'no-store' },
      )
      if (res.ok) setHealth(await res.json())
    } catch {
      /* swallow — strip degrades to "—" */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchHealth()
  }, [fetchHealth])

  const runPipeline = useCallback(async () => {
    setRunning(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/pipeline/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 365 }),
          cache: 'no-store',
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        const failed = (json.steps ?? []).filter((s: { ok: boolean }) => !s.ok)
        toast.error(
          failed.length
            ? t('replenishment.pipeline.toast.failedSteps', {
                n: failed.length,
                steps: failed.map((s: { step: string }) => s.step).join(', '),
              })
            : t('replenishment.pipeline.toast.failed'),
        )
      } else {
        const seconds = Math.round((json.totalDurationMs ?? 0) / 100) / 10
        toast.success(
          t('replenishment.pipeline.toast.success', {
            seconds,
            n: json.steps.length,
          }),
        )
      }
      await fetchHealth()
      onRefreshPageData()
    } catch (err) {
      toast.error(
        t('replenishment.pipeline.toast.error', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setRunning(false)
    }
  }, [fetchHealth, onRefreshPageData, toast, t])

  function ageBadge(iso: string | null): { text: string; tone: 'green' | 'amber' | 'red' | 'slate' } {
    if (!iso) return { text: '—', tone: 'slate' }
    const ageMs = Date.now() - new Date(iso).getTime()
    const hours = ageMs / 3_600_000
    if (hours < 48) return { text: `${Math.max(1, Math.round(hours))}h ago`, tone: 'green' }
    const days = Math.round(hours / 24)
    return { text: `${days}d ago`, tone: hours < 168 ? 'amber' : 'red' }
  }

  function tableTone(rows: number, freshIso: string | null): 'green' | 'amber' | 'red' {
    if (rows === 0) return 'red'
    if (!freshIso) return 'amber'
    const ageH = (Date.now() - new Date(freshIso).getTime()) / 3_600_000
    return ageH < 48 ? 'green' : 'amber'
  }

  const TONE_CLASSES: Record<'green' | 'amber' | 'red' | 'slate', string> = {
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
    red: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
    slate: 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:ring-slate-800',
  }

  if (loading && !health) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        {t('replenishment.pipeline.loading')}
      </div>
    )
  }
  if (!health) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
        {t('replenishment.pipeline.unavailable')}
      </div>
    )
  }

  const dsa = health.tables.dailySalesAggregate
  const fc = health.tables.replenishmentForecast
  const fa = health.tables.forecastAccuracy
  const dsaTone = tableTone(dsa.rows, dsa.updatedAt)
  const fcTone = tableTone(fc.rows, fc.lastGeneratedAt)
  const faTone = tableTone(fa.rows, fa.latestDay)
  const dsaAge = ageBadge(dsa.updatedAt)
  const fcAge = ageBadge(fc.lastGeneratedAt)

  const cronChips: Array<{ key: keyof PipelineHealth['crons']; labelKey: string }> = [
    { key: 'forecast', labelKey: 'replenishment.pipeline.cron.forecast' },
    { key: 'forecast-accuracy', labelKey: 'replenishment.pipeline.cron.accuracy' },
    { key: 'abc-classification', labelKey: 'replenishment.pipeline.cron.abc' },
  ]

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mr-1">
          {t('replenishment.pipeline.label')}
        </span>

        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full ring-1 ring-inset font-medium',
            TONE_CLASSES[dsaTone],
          )}
          title={t('replenishment.pipeline.tooltip.salesAgg', {
            rows: dsa.rows,
            oldest: dsa.oldest ?? '—',
            newest: dsa.newest ?? '—',
          })}
        >
          {t('replenishment.pipeline.salesAgg')}: {dsa.rows.toLocaleString()}{' '}
          <span className="opacity-70">· {dsaAge.text}</span>
        </span>

        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full ring-1 ring-inset font-medium',
            TONE_CLASSES[fcTone],
          )}
          title={t('replenishment.pipeline.tooltip.forecast', {
            rows: fc.rows,
            latest: fc.latestHorizon ?? '—',
          })}
        >
          {t('replenishment.pipeline.forecast')}: {fc.rows.toLocaleString()}{' '}
          <span className="opacity-70">· {fcAge.text}</span>
        </span>

        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full ring-1 ring-inset font-medium',
            TONE_CLASSES[faTone],
          )}
          title={t('replenishment.pipeline.tooltip.mape', {
            rows: fa.rows,
            pct: fa.avgPercentError != null ? fa.avgPercentError.toFixed(1) + '%' : '—',
            band: fa.withinBandCount,
          })}
        >
          {t('replenishment.pipeline.mape')}:{' '}
          {fa.rows > 0 && fa.avgPercentError != null ? `${fa.avgPercentError.toFixed(1)}%` : '—'}{' '}
          <span className="opacity-70">· {fa.rows.toLocaleString()} obs</span>
        </span>

        <span className="mx-1 text-slate-300 dark:text-slate-700">|</span>

        {cronChips.map(({ key, labelKey }) => {
          const c = health.crons[key]
          const tone: 'green' | 'amber' | 'red' | 'slate' = !c.enabledFlag
            ? 'slate'
            : c.lastRun?.status === 'SUCCESS'
              ? 'green'
              : c.lastRun?.status === 'FAILED'
                ? 'red'
                : 'amber'
          const detail = c.lastRun
            ? `${c.lastRun.status} · ${ageBadge(c.lastRun.startedAt).text}${c.lastRun.outputSummary ? ' · ' + c.lastRun.outputSummary : ''}`
            : c.enabledFlag
              ? t('replenishment.pipeline.noRuns')
              : t('replenishment.pipeline.disabled')
          return (
            <span
              key={key}
              className={cn(
                'text-xs px-2 py-0.5 rounded-full ring-1 ring-inset font-medium',
                TONE_CLASSES[tone],
              )}
              title={t('replenishment.pipeline.tooltip.cron', { name: key, detail })}
            >
              {t(labelKey)}: {!c.enabledFlag ? t('replenishment.pipeline.cronOff') : c.lastRun?.status ?? '—'}
            </span>
          )
        })}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runPipeline()}
            disabled={running}
            className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-slate-900 dark:bg-slate-700 text-white hover:bg-slate-800 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title={t('replenishment.pipeline.runTooltip')}
            aria-label={t('replenishment.pipeline.runAriaLabel')}
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            )}
            {running ? t('replenishment.pipeline.runningButton') : t('replenishment.pipeline.runButton')}
          </button>
        </div>
      </div>
    </div>
  )
}


// R.9 — drawer: ranked alternative suppliers for this product. Lazy
// loads on first expand to avoid firing the request for every drawer
// open. Allows one-click switch of the preferred supplier — calls
// the rec engine to re-derive on next page render.
function SupplierAlternativesPanel({
  productId,
  urgency,
  onChanged,
}: {
  productId: string
  urgency: string
  onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{
    candidates: Array<{
      supplierId: string
      supplierName: string
      unitCostCentsEur: number | null
      leadTimeDays: number
      moq: number
      casePack: number | null
      currencyCode: string
      compositeScore: number
      costScore: number
      speedScore: number
      flexScore: number
      reliabilityScore: number
      rank: number
      isCurrentlyPreferred: boolean
      paymentTerms: string | null
      notes: string[]
    }>
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const url = new URL(
        `${getBackendUrl()}/api/fulfillment/replenishment/products/${productId}/supplier-comparison`,
      )
      url.searchParams.set('urgency', urgency)
      const res = await fetch(url.toString())
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }

  async function switchPreferred(supplierId: string) {
    setSwitching(supplierId)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/products/${productId}/preferred-supplier`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supplierId }),
        },
      )
      if (res.ok) {
        await load()
        await onChanged()
      }
    } finally {
      setSwitching(null)
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <button
        type="button"
        onClick={() => {
          if (!open && !data) load()
          setOpen((v) => !v)
        }}
        className="flex items-center gap-2 text-sm font-semibold text-slate-900 w-full"
      >
        <span>Supplier alternatives</span>
        <span className="text-xs text-slate-400">
          {open ? '▼' : '▶'} {data ? `${data.candidates.length} suppliers` : ''}
        </span>
      </button>
      {open && loading && (
        <div className="mt-2 text-base text-slate-400">Loading…</div>
      )}
      {open && !loading && data && data.candidates.length === 0 && (
        <p className="mt-2 text-base text-slate-500">
          No supplier rows for this product. Add a SupplierProduct entry to enable comparison.
        </p>
      )}
      {open && !loading && data && data.candidates.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {data.candidates.map((c) => (
            <li
              key={c.supplierId}
              className={cn(
                'rounded border p-2 text-base',
                c.isCurrentlyPreferred
                  ? 'border-indigo-300 bg-indigo-50/40'
                  : 'border-slate-200',
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-400">#{c.rank}</span>
                  <span className="font-semibold text-slate-900">{c.supplierName}</span>
                  {c.isCurrentlyPreferred && (
                    <span className="text-xs uppercase tracking-wider text-indigo-700">
                      preferred
                    </span>
                  )}
                </div>
                <div className="font-mono text-sm text-slate-700">
                  score {(c.compositeScore * 100).toFixed(0)}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-sm text-slate-600">
                <div>
                  <div className="text-slate-400">Cost</div>
                  <div className="font-mono">
                    {c.unitCostCentsEur != null
                      ? `€${(c.unitCostCentsEur / 100).toFixed(2)}`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Lead</div>
                  <div className="font-mono">{c.leadTimeDays}d</div>
                </div>
                <div>
                  <div className="text-slate-400">MOQ</div>
                  <div className="font-mono">{c.moq}</div>
                </div>
                <div>
                  <div className="text-slate-400">Terms</div>
                  <div className="font-mono truncate">{c.paymentTerms ?? '—'}</div>
                </div>
              </div>
              {c.notes.length > 0 && (
                <p className="mt-1 text-xs text-slate-500 leading-snug">
                  {c.notes.join(' · ')}
                </p>
              )}
              {!c.isCurrentlyPreferred && (
                <button
                  type="button"
                  onClick={() => switchPreferred(c.supplierId)}
                  disabled={switching === c.supplierId}
                  className="mt-1 text-sm text-indigo-600 hover:underline disabled:opacity-50"
                >
                  {switching === c.supplierId ? 'switching…' : 'set as preferred'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}



// W9.6e — ReorderMathPanel (R.4) moved to _shared/ReorderMathPanel.tsx
// (imported at the top of this file).

// R.17 — Substitution panel. Shows raw vs adjusted velocity and the
// list of products this SKU substitutes for (or is substituted by),
// with inline fraction edit + add/delete.
function SubstitutionPanel({
  productId,
  rec,
  substitutions,
  onChanged,
}: {
  productId: string
  rec: DetailResponse['recommendation']
  substitutions: NonNullable<DetailResponse['substitutions']>
  onChanged: () => void | Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [newSku, setNewSku] = useState('')
  const [newRole, setNewRole] = useState<'PRIMARY' | 'SUBSTITUTE'>('PRIMARY')
  const [newFraction, setNewFraction] = useState('0.5')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const raw = rec?.rawVelocity != null ? Number(rec.rawVelocity) : null
  const delta = rec?.substitutionAdjustedDelta != null ? Number(rec.substitutionAdjustedDelta) : null
  const adjusted = raw != null && delta != null ? raw + delta : null

  async function handleAdd() {
    setBusy(true); setError(null)
    try {
      const fraction = Number(newFraction)
      if (!(fraction > 0 && fraction <= 1)) throw new Error('fraction must be in (0, 1]')
      const otherSku = newSku.trim()
      if (!otherSku) throw new Error('SKU required')
      const body = newRole === 'PRIMARY'
        ? { primarySku: otherSku, substituteProductId: productId, substitutionFraction: fraction }
        : { primaryProductId: productId, substituteSku: otherSku, substitutionFraction: fraction }
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/substitutions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setNewSku(''); setNewFraction('0.5'); setAdding(false)
      await onChanged()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleUpdateFraction(id: string, fraction: number) {
    if (!(fraction > 0 && fraction <= 1)) return
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/substitutions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ substitutionFraction: fraction }),
      })
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/substitutions/${id}`, {
        method: 'DELETE',
      })
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900">Substitution-aware demand</h4>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-indigo-600 hover:underline"
        >
          {adding ? 'cancel' : '+ link'}
        </button>
      </div>

      {raw != null && adjusted != null && (
        <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-slate-500">Raw velocity</div>
            <div className="font-mono text-slate-900">{raw.toFixed(2)}/d</div>
          </div>
          <div>
            <div className="text-slate-500">Adjusted</div>
            <div className="font-mono text-slate-900">{adjusted.toFixed(2)}/d</div>
          </div>
          <div>
            <div className="text-slate-500">Δ</div>
            <div className={`font-mono ${delta! > 0 ? 'text-emerald-700' : delta! < 0 ? 'text-amber-700' : 'text-slate-700'}`}>
              {delta! > 0 ? '+' : ''}{delta!.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {adding && (
        <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          <div className="mb-2 grid grid-cols-3 gap-2">
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as any)}
              className="rounded border border-slate-300 px-1 py-0.5"
            >
              <option value="PRIMARY">Primary is…</option>
              <option value="SUBSTITUTE">Substitute is…</option>
            </select>
            <input
              type="text"
              placeholder="other SKU"
              value={newSku}
              onChange={(e) => setNewSku(e.target.value)}
              className="rounded border border-slate-300 px-1 py-0.5 font-mono"
            />
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="1"
              value={newFraction}
              onChange={(e) => setNewFraction(e.target.value)}
              className="rounded border border-slate-300 px-1 py-0.5"
            />
          </div>
          {error && <div className="mb-2 text-rose-600">{error}</div>}
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy || !newSku.trim()}
            className="rounded bg-indigo-600 px-2 py-1 text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}

      {substitutions.length === 0 ? (
        <p className="text-xs text-slate-500">
          No substitution links. Add one when stockouts on this SKU drive customers to a related product (or vice versa).
        </p>
      ) : (
        <ul className="space-y-1.5">
          {substitutions.map((s) => {
            const isSubstituteSide = s.substituteProductId === productId
            const other = isSubstituteSide ? s.primary : s.substitute
            return (
              <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="flex-1 truncate">
                  <span className="text-slate-500">
                    {isSubstituteSide ? 'substitutes for' : 'substituted by'}
                  </span>{' '}
                  <span className="font-mono">{other?.sku ?? '(missing)'}</span>{' '}
                  <span className="text-slate-400">— {other?.name ?? ''}</span>
                </div>
                <input
                  type="number"
                  step="0.05"
                  min="0.05"
                  max="1"
                  defaultValue={Number(s.substitutionFraction)}
                  onBlur={(e) => {
                    const v = Number(e.target.value)
                    if (v !== Number(s.substitutionFraction)) handleUpdateFraction(s.id, v)
                  }}
                  className="w-16 rounded border border-slate-300 px-1 py-0.5 text-right font-mono"
                />
                <button
                  type="button"
                  onClick={() => handleDelete(s.id)}
                  className="text-rose-600 hover:underline"
                >
                  delete
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// R.3 — Recommendation history audit trail for the drawer. Shows a
// chronological list of every recommendation we've ever shown for
// this product, with status pills (ACTIVE / SUPERSEDED / ACTED) +
// urgency + qty + the resulting PO/WO when ACTED. Lazy-loaded on
// expand so closed drawers don't fire the request.
function RecommendationHistoryCard({ productId }: { productId: string | null }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  // R.5 polish — pagination + status filter for the history list.
  // Expand from the original 5-row teaser to all rows (we fetch 50
  // so the upper bound is reasonable; users with very long histories
  // can use the API directly until we add load-more semantics).
  const [showAll, setShowAll] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  useEffect(() => {
    if (!open || !productId || data) return
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/${productId}/history?limit=50`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [open, productId, data])

  if (!productId) return null

  // Apply status filter + slice for show-N. Counts derived from full list.
  const allHistory: any[] = data?.history ?? []
  const counts: Record<string, number> = { all: allHistory.length }
  for (const h of allHistory) counts[h.status] = (counts[h.status] ?? 0) + 1
  const filtered =
    statusFilter === 'all'
      ? allHistory
      : allHistory.filter((h) => h.status === statusFilter)
  const visible = showAll ? filtered : filtered.slice(0, 5)
  const hidden = filtered.length - visible.length

  const HISTORY_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'ACTIVE', label: 'Active' },
    { key: 'ACTED', label: 'Acted' },
    { key: 'DISMISSED', label: 'Dismissed' },
    { key: 'SUPERSEDED', label: 'Super.' },
  ]

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-sm uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1 hover:text-slate-700"
      >
        History {open ? '▾' : '▸'}
        {data?.history && (
          <span className="text-slate-400 normal-case font-normal">
            ({data.history.length})
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2">
          {loading && <div className="text-base text-slate-400">Loading…</div>}
          {!loading && allHistory.length === 0 && (
            <div className="text-sm text-slate-500 italic">
              No history yet — recommendations are persisted starting from this commit.
            </div>
          )}
          {!loading && allHistory.length > 0 && (
            <>
              {/* Status filter chips — R.5 polish */}
              {allHistory.length > 1 && (
                <div className="flex items-center gap-1 mb-2 flex-wrap">
                  {HISTORY_FILTERS.map((f) => {
                    const c = counts[f.key] ?? 0
                    if (f.key !== 'all' && c === 0) return null
                    return (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => {
                          setStatusFilter(f.key)
                          setShowAll(false)
                        }}
                        className={cn(
                          'px-2 py-0.5 text-xs font-medium rounded border transition-colors',
                          statusFilter === f.key
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
                        )}
                      >
                        {f.label}
                        <span className="ml-1 opacity-70">{c}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              <ul className="space-y-1 text-sm">
                {visible.map((h: any) => {
                const tone =
                  h.status === 'ACTIVE' ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : h.status === 'ACTED' ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : h.status === 'DISMISSED' ? 'bg-slate-100 border-slate-200 text-slate-500'
                  : 'bg-slate-50 border-slate-200 text-slate-600'
                return (
                  <li key={h.id} className="flex items-start gap-2 border border-slate-100 rounded px-2 py-1">
                    <span className="text-slate-500 tabular-nums w-28 flex-shrink-0">
                      {new Date(h.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}
                    </span>
                    <span className={cn('text-xs uppercase tracking-wider px-1.5 py-0.5 rounded border w-20 text-center flex-shrink-0', tone)}>
                      {h.status === 'SUPERSEDED' ? 'SUPER.' : h.status}
                    </span>
                    <span className="text-slate-700 flex-shrink-0">{h.urgency}</span>
                    <span className="text-slate-600 tabular-nums flex-shrink-0">qty {h.reorderQuantity}</span>
                    <span className="text-slate-500 tabular-nums flex-shrink-0">stock {h.effectiveStock}</span>
                    {h.actedAt && (h.resultingPoId || h.resultingWorkOrderId) && (
                      <span className="text-emerald-700 truncate">
                        → {h.resultingPoId ? 'PO ' : 'WO '}{(h.resultingPoId ?? h.resultingWorkOrderId).slice(-8)}
                        {h.overrideQuantity != null && h.overrideQuantity !== h.reorderQuantity && (
                          <span className="text-slate-500"> (override {h.reorderQuantity}→{h.overrideQuantity})</span>
                        )}
                      </span>
                    )}
                  </li>
                )
              })}
              </ul>
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-2 text-sm text-blue-700 hover:text-blue-900 font-medium"
                >
                  Show all {filtered.length}
                </button>
              )}
              {showAll && filtered.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAll(false)}
                  className="mt-2 text-sm text-slate-500 hover:text-slate-700 font-medium"
                >
                  Show less
                </button>
              )}
              {filtered.length === 0 && statusFilter !== 'all' && (
                <div className="text-sm text-slate-500 italic">
                  No {statusFilter.toLowerCase()} entries.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// R.1 — Forecast accuracy mini-card for the drawer. Shows rolling
// 30-day MAPE / MAE / 80%-band calibration plus a per-regime split
// (so we can see whether HOLT_WINTERS is actually beating the
// fallbacks for this SKU). Suppresses noisy numbers when sample
// count is too low to be statistically meaningful.
function ForecastAccuracyCard({
  sku,
  channel,
  marketplace,
}: {
  sku: string | null
  channel: string | null
  marketplace: string | null
}) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!sku) return
    setLoading(true)
    const qs = new URLSearchParams({ sku, windowDays: '30' })
    if (channel) qs.set('channel', channel)
    if (marketplace) qs.set('marketplace', marketplace)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/forecast-accuracy?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [sku, channel, marketplace])

  if (!sku) return null
  if (loading) {
    return (
      <div>
        <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold mb-1">Forecast accuracy (last 30d)</div>
        <div className="text-base text-slate-400">Loading…</div>
      </div>
    )
  }
  if (!data) return null

  const sampleCount = data.sampleCount ?? 0
  if (sampleCount < 7) {
    return (
      <div>
        <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold mb-1">Forecast accuracy (last 30d)</div>
        <div className="text-base text-slate-500 italic">
          Not enough history yet (n={sampleCount}). Need ≥7 days.
        </div>
      </div>
    )
  }

  const mape = data.mape == null ? '—' : `${Number(data.mape).toFixed(1)}%`
  const mae = data.mae == null ? '—' : `${Number(data.mae).toFixed(2)}`
  const cal = data.bandCalibration == null ? '—' : `${Number(data.bandCalibration).toFixed(0)}%`
  const regimes = Object.entries((data.byRegime ?? {}) as Record<string, any>)
    .filter(([, s]) => (s as any).sampleCount >= 3)
    .sort((a: any, b: any) => b[1].sampleCount - a[1].sampleCount)

  return (
    <div>
      <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold mb-1">
        Forecast accuracy (last 30d)
      </div>
      <div className="grid grid-cols-3 gap-2 text-base mb-2">
        <div className="border border-slate-200 rounded px-2 py-1 bg-slate-50">
          <div className="uppercase tracking-wider text-xs text-slate-500 font-semibold">MAPE</div>
          <div className="tabular-nums font-semibold text-slate-900">{mape}</div>
        </div>
        <div className="border border-slate-200 rounded px-2 py-1 bg-slate-50">
          <div className="uppercase tracking-wider text-xs text-slate-500 font-semibold">MAE</div>
          <div className="tabular-nums font-semibold text-slate-900">{mae}</div>
        </div>
        <div className="border border-slate-200 rounded px-2 py-1 bg-slate-50">
          <div className="uppercase tracking-wider text-xs text-slate-500 font-semibold">Calibration</div>
          <div className="tabular-nums font-semibold text-slate-900">{cal} <span className="text-xs text-slate-500 font-normal">/ 80%</span></div>
        </div>
      </div>
      <div className="text-xs text-slate-500">n = {sampleCount} days</div>
      {regimes.length > 1 && (
        <div className="mt-2">
          <div className="uppercase tracking-wider text-xs text-slate-500 font-semibold mb-1">By regime</div>
          <ul className="space-y-0.5">
            {regimes.map(([key, s]: any) => (
              <li key={key} className="flex items-center justify-between text-sm">
                <span className="font-mono text-slate-700">{key}</span>
                <span className="tabular-nums text-slate-700">
                  {s.mape == null ? '—' : `${Number(s.mape).toFixed(1)}%`} <span className="text-slate-400">(n={s.sampleCount})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// R.1 — workspace-level "Forecast health" card. Aggregate MAPE +
// per-regime breakdown + a tiny daily-MAPE trend sparkline. Sits
// alongside the urgency tiles so operators can spot model drift at
// a glance. Suppresses entirely when there's no data yet (cron
// hasn't run or pre-deploy state).
function ForecastHealthCard() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/forecast-accuracy/aggregate?windowDays=30&groupBy=regime`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [refreshTick])

  if (loading || !data?.overall) return null
  const sampleCount = data.overall.sampleCount ?? 0
  if (sampleCount === 0) return null

  const mape = data.overall.mape == null ? '—' : `${Number(data.overall.mape).toFixed(1)}%`
  const cal = data.overall.bandCalibration == null ? '—' : `${Number(data.overall.bandCalibration).toFixed(0)}%`
  const groups: Array<{ key: string; mape: number | null; sampleCount: number }> = data.groups ?? []
  const trend: Array<{ day: string; mape: number | null }> = data.trend ?? []
  const sparkPoints = trend.filter((t) => t.mape != null).map((t) => Number(t.mape))
  const sparkMax = sparkPoints.length > 0 ? Math.max(...sparkPoints, 1) : 1

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
            Forecast health (last 30d)
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-[20px] font-semibold tabular-nums text-slate-900">{mape}</span>
            <span className="text-sm text-slate-500">MAPE · n={sampleCount}</span>
            <span className="text-sm text-slate-500">Calibration {cal} / 80%</span>
          </div>
          {data.worstSku && (
            <div className="text-sm text-slate-500 mt-0.5">
              Worst: <span className="font-mono">{data.worstSku.sku}</span> ({Number(data.worstSku.mape).toFixed(1)}% MAPE, n={data.worstSku.sampleCount})
            </div>
          )}
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="h-7 px-2 text-sm border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
      {groups.length > 0 && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          {groups.map((g) => (
            <div key={g.key} className="border border-slate-200 rounded px-2 py-1.5">
              <div className="uppercase tracking-wider text-xs text-slate-500 font-semibold">
                {g.key}
              </div>
              <div className="tabular-nums font-semibold text-slate-900 mt-0.5">
                {g.mape == null ? '—' : `${Number(g.mape).toFixed(1)}%`}
              </div>
              <div className="text-xs text-slate-500">n={g.sampleCount}</div>
            </div>
          ))}
        </div>
      )}
      {sparkPoints.length > 1 && (
        <div className="mt-3">
          <div className="uppercase tracking-wider text-xs text-slate-500 font-semibold mb-1">
            Daily MAPE trend
          </div>
          <svg viewBox={`0 0 ${sparkPoints.length * 8} 24`} className="w-full h-6">
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-blue-600"
              points={sparkPoints
                .map((p, i) => `${i * 8},${24 - (p / sparkMax) * 20}`)
                .join(' ')}
            />
          </svg>
        </div>
      )}
    </Card>
  )
}


