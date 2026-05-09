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
  Download,
  Keyboard,
  Loader2,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  X,
} from 'lucide-react'
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
import { ForecastModelsCard } from './_shared/ForecastModelsCard'
import { StockoutImpactCard } from './_shared/StockoutImpactCard'
import { CashFlowCard } from './_shared/CashFlowCard'
import { BulkPoModal } from './_shared/BulkPoModal'
import { SavedViewsButton } from './_shared/SavedViewsButton'
import { FbaRestockHealthCard } from './_shared/FbaRestockPanels'
import {
  ContainerFillCard,
  type ContainerFillEntry,
} from './_shared/ContainerFillCard'
import { KeyboardHelpOverlay } from './_shared/KeyboardHelpOverlay'
import { ForecastHealthCard } from './_shared/ForecastDiagnosticsCards'
import { ForecastDetailDrawer } from './_shared/ForecastDetailDrawer'

// W9.6l — ContainerFillCard + ContainerFillEntry moved to _shared/.
//          KeyboardHelpOverlay moved to _shared/.
// W9.6m — SubstitutionPanel + RecommendationHistoryCard moved to _shared/.
// W9.6o — ForecastDetailDrawer + SupplierAlternativesPanel + drawer-only
//          panels (Reorder/Signal/StockByLocation/ChannelCover/FbaRestockSignal/
//          ForecastAccuracy/Substitution/RecommendationHistory) consumed by
//          the drawer module — workspace no longer imports them directly.

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
        <div className="inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5">
          {(['NEEDS_REORDER', 'CRITICAL', 'HIGH', 'MEDIUM', 'ALL'] as const).map(
            (t) => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={cn(
                  'h-7 px-3 text-base font-medium rounded transition-colors',
                  filter === t
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
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
          className="h-8 px-2 border border-slate-200 dark:border-slate-700 rounded-md text-base bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
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
          className="h-8 px-2 border border-slate-200 dark:border-slate-700 rounded-md text-base bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
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
            className="h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            title="Auto-refresh interval (paused when tab hidden)"
          >
            <option value={0}>Auto-refresh: Off</option>
            <option value={5}>Auto-refresh: 5 min</option>
            <option value={15}>Auto-refresh: 15 min</option>
          </select>
          <button
            onClick={fetchData}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Refresh
          </button>
          {/* R.5 — CSV export of currently filtered + sorted suggestions */}
          <button
            onClick={() => exportSuggestionsCsv(filtered)}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
            title="Export the currently filtered + sorted suggestions to CSV"
            disabled={filtered.length === 0}
          >
            <Download size={12} /> Export CSV
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            className="h-8 w-8 grid place-items-center text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={12} />
          </button>
        </div>
      </div>

      {/* Bulk action bar — visible only when rows are selected */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-md px-3 py-2 flex items-center justify-between gap-3">
          <div className="text-md text-slate-700 dark:text-slate-300">
            <span className="font-semibold">{selectedIds.size}</span>{' '}
            selected
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="h-7 px-2 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900"
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
              className="h-7 px-3 text-base bg-white dark:bg-slate-900 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900 rounded hover:bg-red-50 dark:hover:bg-red-950/40 inline-flex items-center gap-1.5"
              title={t('replenishment.dismiss.bulkTooltip')}
            >
              <X size={12} /> {t('replenishment.dismiss.bulkButton')}
            </button>
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              className="h-7 px-3 text-base bg-blue-600 dark:bg-blue-500 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1.5"
            >
              <ShoppingCart size={12} /> Bulk-create POs
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading && !data ? (
        <Card>
          <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
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
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
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
  return 'px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300'
}
function thRight() {
  return 'px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300'
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




// W9.6e — ReorderMathPanel (R.4) moved to _shared/ReorderMathPanel.tsx
// (imported at the top of this file).

// W9.6m — SubstitutionPanel (R.17) + RecommendationHistoryCard (R.3)
// moved to _shared/SubstitutionPanel.tsx + _shared/RecommendationHistoryCard.tsx
// (imported at the top of this file).

// W9.6n — ForecastAccuracyCard (R.1) + ForecastHealthCard (R.2) moved
// to _shared/ForecastDiagnosticsCards.tsx (imported at the top).



