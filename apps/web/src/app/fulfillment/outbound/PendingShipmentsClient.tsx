'use client'

// O.4 — Pending-shipment aggregation. THE cornerstone outbound surface:
// "what do I ship today, across all channels?" Renders orders that need
// a shipment created (status ∈ PENDING|PROCESSING, no active shipment),
// grouped by ship-by urgency, filterable by channel + marketplace,
// bulk-create-able. Drawer (per-order detail) lands in O.5.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Truck, Search, RefreshCw, Crown, AlertTriangle, Clock, Package, X, Plus,
  Bookmark, BookmarkPlus, ChevronDown, Trash2, Star, ArrowRight, Sparkles,
  Bell, BellOff,
} from 'lucide-react'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { getBackendUrl } from '@/lib/backend-url'

type Urgency = 'OVERDUE' | 'TODAY' | 'TOMORROW' | 'THIS_WEEK' | 'LATER' | 'UNKNOWN'

type PendingOrder = {
  id: string
  channel: string
  marketplace: string | null
  channelOrderId: string
  status: string
  customerName: string
  customerEmail: string
  shippingAddress: { city?: string; country?: string; countryCode?: string } | any
  purchaseDate: string | null
  shipByDate: string | null
  earliestShipDate: string | null
  latestDeliveryDate: string | null
  fulfillmentLatency: number | null
  isPrime: boolean | null
  totalPrice: number
  currencyCode: string | null
  createdAt: string
  itemCount: number
  totalQuantity: number
  urgency: Urgency
  items: Array<{ id: string; sku: string; quantity: number; productId: string | null; price: number }>
}

type Counts = {
  overdue: number
  today: number
  tomorrow: number
  thisWeek: number
  later: number
  unknown: number
  byChannel: Record<string, number>
}

type Response = {
  items: PendingOrder[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  counts: Counts
}

const URGENCY_TONE: Record<Urgency, { tint: string; icon: typeof Clock }> = {
  OVERDUE: { tint: 'text-rose-700 bg-rose-50 border-rose-200', icon: AlertTriangle },
  TODAY: { tint: 'text-amber-700 bg-amber-50 border-amber-200', icon: Clock },
  TOMORROW: { tint: 'text-yellow-700 bg-yellow-50 border-yellow-200', icon: Clock },
  THIS_WEEK: { tint: 'text-slate-700 bg-slate-50 border-slate-200', icon: Clock },
  LATER: { tint: 'text-slate-500 bg-slate-50 border-slate-200', icon: Clock },
  UNKNOWN: { tint: 'text-slate-500 bg-slate-50 border-slate-200', icon: Clock },
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'Woo',
  ETSY: 'Etsy',
  MANUAL: 'Manual',
}

const URGENCY_FILTERS: Array<{ key: Urgency | 'ALL'; tKey: string }> = [
  { key: 'ALL', tKey: 'outbound.pending.urgency.all' },
  { key: 'OVERDUE', tKey: 'outbound.pending.urgency.overdue' },
  { key: 'TODAY', tKey: 'outbound.pending.urgency.today' },
  { key: 'TOMORROW', tKey: 'outbound.pending.urgency.tomorrow' },
  { key: 'THIS_WEEK', tKey: 'outbound.pending.urgency.thisWeek' },
  { key: 'LATER', tKey: 'outbound.pending.urgency.later' },
  { key: 'UNKNOWN', tKey: 'outbound.pending.urgency.unknown' },
]

function formatRelative(d: string | null): string {
  if (!d) return '—'
  const t = new Date(d).getTime()
  const now = Date.now()
  const diffH = (t - now) / 3_600_000
  if (Math.abs(diffH) < 1) return 'now'
  if (diffH < 0) {
    const past = -diffH
    if (past < 24) return `${Math.round(past)}h late`
    return `${Math.round(past / 24)}d late`
  }
  if (diffH < 24) return `in ${Math.round(diffH)}h`
  if (diffH < 24 * 14) return `in ${Math.round(diffH / 24)}d`
  return new Date(d).toLocaleDateString()
}

function formatMoney(v: number, currency: string | null): string {
  const c = currency || 'EUR'
  try {
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: c }).format(v)
  } catch {
    return `${v.toFixed(2)} ${c}`
  }
}

export default function PendingShipmentsClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { toast } = useToast()
  const { t } = useTranslations()

  // URL-state-backed filters so a refresh / bookmark survives.
  const channelFilter = (params.get('channel') ?? '').split(',').filter(Boolean)
  const urgencyFilter = (params.get('urgency') as Urgency | 'ALL' | null) ?? 'ALL'
  const search = params.get('q') ?? ''
  const sort = (params.get('sort') as 'ship-by-asc' | 'value-desc' | 'age-desc' | null) ?? 'ship-by-asc'

  const [data, setData] = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = useState(search)

  // O.27: saved views — persistent filter combinations.
  type SavedView = { id: string; name: string; filters: any; isDefault: boolean }
  type AlertRow = {
    id: string
    name: string
    isActive: boolean
    comparison: string
    threshold: number
    lastCount: number
    cooldownMinutes: number
  }
  const [views, setViews] = useState<SavedView[]>([])
  const [showViewsMenu, setShowViewsMenu] = useState(false)
  // O.52: per-view alert subscriptions. Map of viewId → alerts[].
  const [alertsByView, setAlertsByView] = useState<Record<string, AlertRow[]>>({})
  // O.61: multi-alert manager modal. Selected view → opens a panel
  // listing every alert with edit/remove + an "Add another" form.
  // The schema has always supported N alerts per view; v0 only
  // exposed the first one in a single-bell prompt.
  const [alertsModalView, setAlertsModalView] = useState<SavedView | null>(null)
  // O.67: bulk-create results modal. Surfaces the per-order errors
  // returned by /shipments/bulk-create so operators see which orders
  // failed and why (instead of just "3 of 10 created" in a toast).
  // Cleared on close.
  const [createResults, setCreateResults] = useState<{
    created: number
    total: number
    errors: Array<{ orderId: string; reason: string }>
  } | null>(null)
  // O.69: bulk-create preflight modal. Same shape as createResults
  // but rendered *before* the call so operators can fix master-data
  // gaps without burning the bulk-create round-trip.
  type PreflightOrder = {
    orderId: string
    channelOrderId: string
    country: string | null
    isInternational: boolean
    ready: boolean
    issues: Array<{ severity: 'error' | 'warning'; code: string }>
  }
  const [preflight, setPreflight] = useState<{
    total: number
    ready: number
    errors: number
    warnings: number
    orders: PreflightOrder[]
  } | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)

  // O.70: per-order snooze. Operator hits "Snooze 1h" on rows that
  // are blocked on something off-screen (waiting for stock, customer
  // clarification) and the row hides until the timestamp passes,
  // re-appearing automatically. Stored in localStorage so a refresh
  // doesn't drop snoozes; per-order timestamps so different orders
  // expire independently. No backend — this is private operator
  // state, like a sticky-note on the screen.
  const SNOOZE_KEY = 'outbound.pending.snoozedUntil'
  type SnoozeMap = Record<string, number>
  const [snoozedUntil, setSnoozedUntil] = useState<SnoozeMap>(() => {
    if (typeof window === 'undefined') return {}
    try {
      return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}') as SnoozeMap
    } catch {
      return {}
    }
  })
  const [showSnoozed, setShowSnoozed] = useState(false)
  // Tick every 30s so expired snoozes return to the active list
  // without a manual refresh. Cheap setState if nothing changed.
  const [, setNowTick] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const snooze = (orderId: string, hours: number) => {
    const until = Date.now() + hours * 3_600_000
    const next = { ...snoozedUntil, [orderId]: until }
    setSnoozedUntil(next)
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)) } catch { /* quota */ }
    toast.success(t('outbound.pending.snooze.toast', { hours }))
  }
  const unsnooze = (orderId: string) => {
    const next = { ...snoozedUntil }
    delete next[orderId]
    setSnoozedUntil(next)
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)) } catch { /* quota */ }
  }

  const fetchViews = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/saved-views?surface=outbound.pending`,
        { cache: 'no-store' },
      )
      if (res.ok) {
        const data = (await res.json()).items ?? []
        setViews(data as SavedView[])
        // O.52: parallel-fetch alert subscriptions per view.
        const alertEntries = await Promise.all(
          (data as SavedView[]).map(async (v): Promise<[string, AlertRow[]]> => {
            try {
              const ar = await fetch(
                `${getBackendUrl()}/api/saved-views/${v.id}/alerts`,
                { cache: 'no-store' },
              )
              if (!ar.ok) return [v.id, []]
              const body = await ar.json()
              return [v.id, (body.items ?? body.alerts ?? []) as AlertRow[]]
            } catch {
              return [v.id, []]
            }
          }),
        )
        const map: Record<string, AlertRow[]> = {}
        for (const [id, list] of alertEntries) map[id] = list
        setAlertsByView(map)
      }
    } catch {
      /* non-fatal */
    }
  }, [])
  useEffect(() => { fetchViews() }, [fetchViews])

  // O.52 + O.61: create alert on a view. The legacy single-arg form
  // (subscribeAlert(view)) prompts for a GT threshold; the multi-arg
  // form is called by the alerts modal with explicit comparison.
  const subscribeAlert = async (
    view: SavedView,
    explicit?: { comparison: string; threshold: number; name?: string },
  ) => {
    let comparison = 'GT'
    let threshold: number
    let name = view.name
    if (explicit) {
      comparison = explicit.comparison
      threshold = explicit.threshold
      if (explicit.name) name = explicit.name
    } else {
      const thresholdStr = window.prompt(t('outbound.alerts.prompt'), '5')
      if (thresholdStr == null) return
      threshold = Number(thresholdStr)
      if (!Number.isFinite(threshold) || threshold < 0) {
        toast.error(t('outbound.alerts.invalidThreshold'))
        return
      }
    }
    const res = await fetch(`${getBackendUrl()}/api/saved-views/${view.id}/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        comparison,
        threshold,
        cooldownMinutes: 60,
      }),
    })
    if (res.ok) {
      toast.success(t('outbound.alerts.created'))
      fetchViews()
      return true
    } else {
      toast.error(t('common.error'))
      return false
    }
  }

  // O.52 bug fix + O.58: DELETE goes via /saved-view-alerts/:id
  // (the singular form — the /saved-views/:viewId/alerts/:alertId
  // path was a typo and 404'd silently). PATCH for threshold edit
  // uses the same pattern.
  const updateAlertThreshold = async (alertId: string, threshold: number) => {
    const res = await fetch(`${getBackendUrl()}/api/saved-view-alerts/${alertId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold }),
    })
    if (res.ok) {
      toast.success(t('outbound.alerts.thresholdUpdated', { threshold }))
      fetchViews()
    } else {
      toast.error(t('common.error'))
    }
  }

  const unsubscribeAlert = async (alertId: string) => {
    const res = await fetch(
      `${getBackendUrl()}/api/saved-view-alerts/${alertId}`,
      { method: 'DELETE' },
    )
    if (res.ok) {
      toast.success(t('outbound.alerts.removed'))
      fetchViews()
    } else {
      toast.error(t('common.error'))
    }
  }

  // (O.58's editOrRemoveAlert prompt was superseded by O.61's modal,
  // which handles edit + remove with first-class buttons rather than
  // a single tri-action prompt.)

  // O.42: cross-tab refresh of the views dropdown when a sibling tab
  // edits the list (saved a new view, deleted one, toggled default).
  useInvalidationChannel('saved-view.changed', () => {
    fetchViews()
  })

  // O.41: default-view auto-apply on first visit. Triggers exactly
  // once per tab session: when the operator lands on /fulfillment/
  // outbound with NO existing URL filters AND a default view exists,
  // apply it. Subsequent navigation that clears filters won't
  // re-apply (URL state is the operator's source of truth).
  const autoAppliedDefaultRef = useRef(false)
  useEffect(() => {
    if (autoAppliedDefaultRef.current) return
    if (views.length === 0) return
    // Only auto-apply when the URL has no operator-set filters yet.
    const hasAnyFilter =
      params.get('channel') ||
      params.get('urgency') ||
      params.get('q') ||
      params.get('sort')
    if (hasAnyFilter) {
      autoAppliedDefaultRef.current = true // operator's URL wins; don't auto-apply later either
      return
    }
    const def = views.find((v) => v.isDefault)
    if (def) {
      autoAppliedDefaultRef.current = true
      applyView(def)
    }
    // applyView reads from views array; including views as a dep is
    // fine — once we mark auto-applied, the early return short-circuits.
  }, [views, params])

  // Apply a view by replacing the URL params with the view's filters.
  const applyView = (view: SavedView) => {
    const next = new URLSearchParams()
    const f = (view.filters ?? {}) as Record<string, string | string[]>
    if (Array.isArray(f.channel) && f.channel.length) next.set('channel', f.channel.join(','))
    else if (typeof f.channel === 'string' && f.channel) next.set('channel', f.channel)
    if (typeof f.urgency === 'string' && f.urgency && f.urgency !== 'ALL') next.set('urgency', f.urgency)
    if (typeof f.q === 'string' && f.q) next.set('q', f.q)
    if (typeof f.sort === 'string' && f.sort && f.sort !== 'ship-by-asc') next.set('sort', f.sort)
    router.replace(`?${next.toString()}`, { scroll: false })
    setShowViewsMenu(false)
  }

  const saveCurrentAsView = async () => {
    const name = window.prompt('Save view as…')
    if (!name?.trim()) return
    const filters = {
      channel: channelFilter,
      urgency: urgencyFilter,
      q: search,
      sort,
    }
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface: 'outbound.pending', name: name.trim(), filters }),
      })
      if (res.ok) {
        toast.success('View saved')
        emitInvalidation({ type: 'saved-view.changed', meta: { surface: 'outbound.pending' } })
        fetchViews()
      } else {
        toast.error('Failed to save view')
      }
    } catch {
      toast.error('Failed to save view')
    }
    setShowViewsMenu(false)
  }

  const deleteView = async (id: string) => {
    const res = await fetch(`${getBackendUrl()}/api/saved-views/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('View deleted')
      emitInvalidation({ type: 'saved-view.changed', id, meta: { surface: 'outbound.pending' } })
      fetchViews()
    } else {
      toast.error('Failed to delete view')
    }
  }

  const toggleDefault = async (view: SavedView) => {
    const res = await fetch(`${getBackendUrl()}/api/saved-views/${view.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: !view.isDefault }),
    })
    if (res.ok) {
      emitInvalidation({ type: 'saved-view.changed', id: view.id, meta: { surface: 'outbound.pending' } })
      fetchViews()
    }
  }

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString())
      if (value == null || value === '' || value === 'ALL') next.delete(key)
      else next.set(key, value)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [params, router],
  )

  // O.35: onboarding state — "have you ever connected a carrier?"
  // Drives the first-run banner. Cheap GET; refetched alongside data.
  const [carrierConnected, setCarrierConnected] = useState<boolean | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (channelFilter.length) qs.set('channel', channelFilter.join(','))
      if (urgencyFilter && urgencyFilter !== 'ALL') qs.set('urgency', urgencyFilter)
      if (search) qs.set('search', search)
      if (sort) qs.set('sort', sort)
      const [pendingRes, carriersRes] = await Promise.all([
        fetch(
          `${getBackendUrl()}/api/fulfillment/outbound/pending-orders?${qs.toString()}`,
          { cache: 'no-store' },
        ),
        fetch(`${getBackendUrl()}/api/fulfillment/carriers`, { cache: 'no-store' }),
      ])
      if (pendingRes.ok) setData(await pendingRes.json())
      else toast.error(t('outbound.pending.toast.loadFailed'))
      if (carriersRes.ok) {
        const carriersData = await carriersRes.json()
        const items: Array<{ isActive: boolean }> = carriersData.items ?? []
        setCarrierConnected(items.some((c) => c.isActive))
      }
    } catch (e) {
      toast.error(t('outbound.pending.toast.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [channelFilter.join(','), urgencyFilter, search, sort, toast])

  useEffect(() => { fetchData() }, [fetchData])

  // O.26: cross-tab refresh. When ANY tab on the same origin creates
  // a shipment, marks one shipped, or otherwise transitions outbound
  // state, this list re-fetches without a manual refresh.
  useInvalidationChannel(
    ['shipment.created', 'shipment.updated', 'shipment.deleted', 'order.shipped'],
    () => { fetchData() },
  )

  // Debounced search → URL on Enter only (avoids URL-thrash while typing).
  const submitSearch = () => setParam('q', searchInput || null)

  const toggleChannel = (code: string) => {
    const next = new Set(channelFilter)
    next.has(code) ? next.delete(code) : next.add(code)
    setParam('channel', next.size ? Array.from(next).join(',') : null)
  }

  // O.78: Shift+Click range select. Tracks the last toggled row so a
  // subsequent shift-click can select the contiguous slice between
  // them — same Linear/Notion/Airtable pattern. Mode of the range
  // (select vs deselect) follows the anchor's *new* state to match
  // user expectation: shift-click to extend a selection always
  // selects, shift-click to extend a deselect always deselects.
  const lastToggledId = useRef<string | null>(null)
  const toggleSelect = (id: string, shift = false) => {
    if (!data) return
    const next = new Set(selected)
    if (shift && lastToggledId.current && lastToggledId.current !== id) {
      const ids = data.items.map((o) => o.id)
      const a = ids.indexOf(lastToggledId.current)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const mode = next.has(lastToggledId.current) ? 'add' : 'remove'
        for (let i = lo; i <= hi; i++) {
          if (mode === 'add') next.add(ids[i])
          else next.delete(ids[i])
        }
        setSelected(next)
        lastToggledId.current = id
        return
      }
    }
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
    lastToggledId.current = id
  }
  const toggleSelectAll = () => {
    if (!data) return
    if (data.items.every((o) => selected.has(o.id))) setSelected(new Set())
    else setSelected(new Set(data.items.map((o) => o.id)))
  }

  // O.69: run the preflight against the current selection. Surfaces
  // a modal with per-order readiness so the operator can fix gaps
  // (missing HS codes for international, missing addresses) before
  // committing to bulk-create.
  const runPreflight = async () => {
    if (selected.size === 0) {
      toast.error(t('outbound.pending.toast.selectFirst'))
      return
    }
    setPreflightLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/outbound/preflight-bulk`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderIds: Array.from(selected) }),
        },
      )
      if (!res.ok) {
        toast.error(t('common.error'))
        return
      }
      const out = await res.json()
      setPreflight(out)
    } catch {
      toast.error(t('common.error'))
    } finally {
      setPreflightLoading(false)
    }
  }

  const bulkCreateShipments = async () => {
    if (selected.size === 0) {
      toast.error(t('outbound.pending.toast.selectFirst'))
      return
    }
    setCreating(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: Array.from(selected) }),
      })
      const out = await res.json()
      if (!res.ok) {
        toast.error(out.error ?? t('outbound.pending.toast.createdNone', { errors: 1 }))
        return
      }
      const { created = 0, errors = [] } = out
      if (created === selected.size) {
        toast.success(
          created === 1
            ? t('outbound.pending.toast.createdAll', { n: created })
            : t('outbound.pending.toast.createdAllPlural', { n: created }),
        )
      } else if (created > 0) {
        toast.warning(t('outbound.pending.toast.createdPartial', { ok: created, total: selected.size, errors: errors.length }))
      } else {
        toast.error(t('outbound.pending.toast.createdNone', { errors: errors.length }))
      }
      // O.67: when any order failed, open the results modal so the
      // operator can see which orderIds failed + why. Successful runs
      // skip the modal — toast is enough confirmation.
      if (errors.length > 0) {
        setCreateResults({ created, total: selected.size, errors })
      }
      // O.26: tell other tabs (sidebar, drawer, shipments tab) to refresh.
      if (created > 0) emitInvalidation({ type: 'shipment.created', meta: { count: created } })
      setSelected(new Set())
      fetchData()
    } catch (e) {
      toast.error(t('outbound.pending.toast.createdNone', { errors: 1 }))
    } finally {
      setCreating(false)
    }
  }

  // Channel set we render as filter chips — derived from the response so
  // we only show channels that actually have pending orders.
  const channelChips = useMemo(() => {
    if (!data) return []
    return Object.entries(data.counts.byChannel).sort((a, b) => b[1] - a[1])
  }, [data])

  const allSelected = data && data.items.length > 0 && data.items.every((o) => selected.has(o.id))

  // O.35: first-run onboarding banner — only appears when no carrier
  // is connected AND the operator has reached the surface (i.e., they
  // probably want to ship something). Hidden once any carrier is
  // active so it doesn't nag returning operators.
  const showOnboarding = carrierConnected === false

  return (
    <div className="space-y-3">
      {showOnboarding && (
        <Card>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-md bg-blue-50 text-blue-600 inline-flex items-center justify-center flex-shrink-0">
              <Sparkles size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-md font-semibold text-slate-900">
                {t('outbound.onboarding.title')}
              </div>
              <div className="text-base text-slate-600 mt-1">
                {t('outbound.onboarding.body')}
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                <Link
                  href="/fulfillment/carriers"
                  className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
                >
                  {t('outbound.onboarding.connectCarrier')}
                  <ArrowRight size={11} />
                </Link>
                <Link
                  href="/fulfillment/outbound/rules"
                  className="h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                >
                  {t('outbound.onboarding.defineRules')}
                </Link>
                <Link
                  href="/fulfillment/routing-rules"
                  className="h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                >
                  {t('outbound.onboarding.warehouseRouting')}
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ── Urgency filter row + counts ─────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        {URGENCY_FILTERS.map((f) => {
          const count =
            f.key === 'ALL'
              ? data?.total ?? 0
              : f.key === 'OVERDUE' ? data?.counts.overdue
              : f.key === 'TODAY' ? data?.counts.today
              : f.key === 'TOMORROW' ? data?.counts.tomorrow
              : f.key === 'THIS_WEEK' ? data?.counts.thisWeek
              : f.key === 'LATER' ? data?.counts.later
              : f.key === 'UNKNOWN' ? data?.counts.unknown
              : 0
          const isActive = urgencyFilter === f.key
          const isOverdue = f.key === 'OVERDUE' && (count ?? 0) > 0
          return (
            <button
              key={f.key}
              onClick={() => setParam('urgency', f.key === 'ALL' ? null : f.key)}
              className={`h-7 px-3 text-base border rounded-full inline-flex items-center gap-1.5 transition-colors ${
                isActive
                  ? 'bg-slate-900 text-white border-slate-900'
                  : isOverdue && !isActive
                  ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}
            >
              {t(f.tKey)}
              {count != null && (
                <span className={`tabular-nums ${isActive ? 'text-slate-300' : 'text-slate-400'}`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder={t('outbound.pending.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch()
                if (e.key === 'Escape') {
                  setSearchInput('')
                  setParam('q', null)
                }
              }}
              className="pl-7 w-64"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setParam('sort', e.target.value === 'ship-by-asc' ? null : e.target.value)}
            className="h-8 px-2 text-base border border-slate-200 rounded-md bg-white"
          >
            <option value="ship-by-asc">{t('outbound.pending.sort.shipBy')}</option>
            <option value="value-desc">{t('outbound.pending.sort.value')}</option>
            <option value="age-desc">{t('outbound.pending.sort.age')}</option>
          </select>
          {/* O.27: saved views dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowViewsMenu((v) => !v)}
              className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Bookmark size={12} /> {t('savedViews.label')}
              {views.length > 0 && (
                <span className="ml-1 tabular-nums text-slate-400">{views.length}</span>
              )}
              <ChevronDown size={11} />
            </button>
            {showViewsMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowViewsMenu(false)} />
                <div className="absolute right-0 mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-20">
                  <div className="p-1 max-h-72 overflow-y-auto">
                    {views.length === 0 ? (
                      <div className="text-sm text-slate-500 px-3 py-2">
                        {t('savedViews.empty')}
                      </div>
                    ) : (
                      views.map((v) => {
                        const alerts = alertsByView[v.id] ?? []
                        const hasAlert = alerts.some((a) => a.isActive)
                        return (
                          <div
                            key={v.id}
                            className="flex items-center gap-1 px-2 py-1.5 hover:bg-slate-50 rounded group"
                          >
                            <button
                              onClick={() => applyView(v)}
                              className="flex-1 text-left text-md text-slate-700 truncate"
                              title={
                                hasAlert
                                  ? t('outbound.alerts.viewHasAlert', {
                                      threshold: alerts[0].threshold,
                                      count: alerts[0].lastCount,
                                    })
                                  : v.name
                              }
                            >
                              {v.name}
                              {hasAlert && (
                                <span className="ml-1 text-xs text-amber-600">●</span>
                              )}
                            </button>
                            {/* O.52 + O.61: alerts manager. Single click on the
                                bell opens the modal listing every alert for
                                this view (was single-alert-only in v0). The
                                count badge surfaces multi-alert visibility
                                without a hover. */}
                            {hasAlert ? (
                              <button
                                onClick={() => { setShowViewsMenu(false); setAlertsModalView(v) }}
                                title={t('outbound.alerts.manage', {
                                  n: alerts.filter((a) => a.isActive).length,
                                })}
                                className="h-6 inline-flex items-center justify-center gap-0.5 px-1 text-amber-500 hover:text-amber-700 rounded"
                              >
                                <Bell size={11} fill="currentColor" />
                                {alerts.filter((a) => a.isActive).length > 1 && (
                                  <span className="text-[10px] font-medium tabular-nums">
                                    {alerts.filter((a) => a.isActive).length}
                                  </span>
                                )}
                              </button>
                            ) : (
                              <button
                                onClick={() => { setShowViewsMenu(false); setAlertsModalView(v) }}
                                title={t('outbound.alerts.subscribe')}
                                className="h-6 w-6 inline-flex items-center justify-center text-slate-300 hover:text-amber-500 rounded"
                              >
                                <BellOff size={11} />
                              </button>
                            )}
                            <button
                              onClick={() => toggleDefault(v)}
                              title={v.isDefault ? t('savedViews.unsetDefault') : t('savedViews.setDefault')}
                              className={`h-6 w-6 inline-flex items-center justify-center rounded ${
                                v.isDefault ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500'
                              }`}
                            >
                              <Star size={11} fill={v.isDefault ? 'currentColor' : 'none'} />
                            </button>
                            <button
                              onClick={() => deleteView(v.id)}
                              title={t('common.delete')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-rose-600 rounded opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div className="border-t border-slate-200 p-1">
                    <button
                      onClick={saveCurrentAsView}
                      className="w-full px-2 py-1.5 text-md text-blue-600 hover:bg-blue-50 rounded inline-flex items-center gap-1.5"
                    >
                      <BookmarkPlus size={11} /> {t('savedViews.saveCurrent')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          {/* O.70: show-snoozed toggle. Only renders when at least
              one snooze is currently in effect — avoids visual noise
              for users who never use the feature. Count reflects
              currently-active (not yet expired) snoozes. */}
          {(() => {
            const activeSnoozeCount = Object.values(snoozedUntil).filter(
              (until) => until > Date.now(),
            ).length
            if (activeSnoozeCount === 0) return null
            return (
              <button
                onClick={() => setShowSnoozed((s) => !s)}
                className={`h-8 px-3 text-base border rounded-md inline-flex items-center gap-1.5 ${
                  showSnoozed
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Clock size={12} />
                {t('outbound.pending.snooze.showToggle', { n: activeSnoozeCount })}
              </button>
            )
          })()}
          <button
            onClick={fetchData}
            className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* ── Channel filter chips ────────────────────────────────────────── */}
      {channelChips.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-slate-500 uppercase tracking-wider">{t('outbound.pending.channelLabel')}</span>
          {channelChips.map(([code, count]) => {
            const isActive = channelFilter.includes(code)
            return (
              <button
                key={code}
                onClick={() => toggleChannel(code)}
                className={`h-6 px-2.5 text-sm border rounded-full inline-flex items-center gap-1 transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                }`}
              >
                {CHANNEL_LABEL[code] ?? code}
                <span className={`tabular-nums ${isActive ? 'text-blue-100' : 'text-slate-400'}`}>
                  {count}
                </span>
              </button>
            )
          })}
          {channelFilter.length > 0 && (
            <button
              onClick={() => setParam('channel', null)}
              className="h-6 px-2 text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            >
              <X size={11} /> {t('outbound.pending.clearFilter')}
            </button>
          )}
        </div>
      )}

      {/* ── Bulk action bar ─────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20">
          <Card>
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-slate-700">
                {t('outbound.pending.selectedCount', { n: selected.size })}
              </span>
              <div className="h-4 w-px bg-slate-200" />
              <button
                onClick={bulkCreateShipments}
                disabled={creating}
                className="h-11 md:h-7 px-4 md:px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Plus size={12} /> {t('outbound.pending.bulkCreate', { n: selected.size })}
              </button>
              <button
                onClick={runPreflight}
                disabled={preflightLoading}
                className="h-11 md:h-7 px-4 md:px-3 text-base bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-white disabled:opacity-50 inline-flex items-center gap-1.5"
                title={t('outbound.pending.preflight.tooltip')}
              >
                <AlertTriangle size={12} />
                {preflightLoading
                  ? t('common.loading')
                  : t('outbound.pending.preflight.button')}
              </button>
              {/* O.82: bulk-snooze — same 1-hour window as the per-row
                  snooze (O.70). Useful when an operator triages a
                  batch of "waiting on customer support" orders and
                  wants them out of sight in one click. */}
              <button
                onClick={() => {
                  const ids = Array.from(selected)
                  if (ids.length === 0) return
                  const until = Date.now() + 3_600_000
                  const next = { ...snoozedUntil }
                  for (const id of ids) next[id] = until
                  setSnoozedUntil(next)
                  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)) } catch { /* quota */ }
                  setSelected(new Set())
                  toast.success(
                    t('outbound.pending.snooze.bulkToast', { n: ids.length, hours: 1 }),
                  )
                }}
                className="h-11 md:h-7 px-4 md:px-3 text-base bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-white inline-flex items-center gap-1.5"
                title={t('outbound.pending.snooze.bulkTooltip')}
              >
                <Clock size={12} /> {t('outbound.pending.snooze.bulkButton')}
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
              >
                <X size={14} />
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* ── List ────────────────────────────────────────────────────────── */}
      {loading && !data ? (
        <Card>
          <div className="text-md text-slate-500 py-8 text-center">{t('common.loading')}</div>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={t('outbound.pending.empty.title')}
          description={
            urgencyFilter !== 'ALL' || channelFilter.length > 0 || search
              ? t('outbound.pending.empty.filtered')
              : t('outbound.pending.empty.allCaughtUp')
          }
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={!!allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('outbound.pending.col.order')}
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('outbound.pending.col.channel')}
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('outbound.pending.col.customer')}
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('outbound.pending.col.items')}
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('outbound.pending.col.value')}
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('outbound.pending.col.shipBy')}
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('outbound.pending.col.action')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items
                  .filter((o) => {
                    // O.70: filter out actively-snoozed orders unless
                    // the operator has flipped the show-snoozed toggle.
                    const until = snoozedUntil[o.id]
                    if (!until || until <= Date.now()) return true
                    return showSnoozed
                  })
                  .map((o) => {
                  const tone = URGENCY_TONE[o.urgency]
                  const Icon = tone.icon
                  const ship = o.shippingAddress as any
                  const country = ship?.countryCode ?? ship?.country ?? null
                  // O.5: clicking the row anywhere except the checkbox
                  // and the action button opens the order drawer.
                  const openDrawer = () => setParam('drawer', o.id)
                  const isSnoozed = snoozedUntil[o.id] && snoozedUntil[o.id] > Date.now()
                  return (
                    <tr
                      key={o.id}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={openDrawer}
                    >
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(o.id)}
                          onChange={() => { /* native onChange fires before the wrapper */ }}
                          onClick={(e) => toggleSelect(o.id, e.shiftKey)}
                          aria-label={`Select order ${o.channelOrderId}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-base font-mono text-blue-600 hover:underline"
                          onClick={(e) => { e.stopPropagation(); openDrawer() }}
                        >
                          {o.channelOrderId.length > 18
                            ? `${o.channelOrderId.slice(0, 18)}…`
                            : o.channelOrderId}
                        </button>
                        {o.isPrime && (
                          <span
                            title="Amazon Prime SFP"
                            className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5"
                          >
                            <Crown size={10} /> Prime
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-base text-slate-700">
                        <Badge variant="info" size="sm">
                          {CHANNEL_LABEL[o.channel] ?? o.channel}
                          {o.marketplace ? ` · ${o.marketplace}` : ''}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-base text-slate-900 truncate max-w-[180px]">
                          {o.customerName || '—'}
                        </div>
                        <div className="text-sm text-slate-500 truncate max-w-[180px]">
                          {country ?? o.customerEmail}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-base text-slate-700">
                        {t(o.itemCount === 1 ? 'outbound.pending.itemSummary' : 'outbound.pending.itemSummaryPlural', {
                          units: o.totalQuantity,
                          skus: o.itemCount,
                        })}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-base text-slate-900">
                        {formatMoney(o.totalPrice, o.currencyCode)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center gap-1 h-6 px-2 text-sm border rounded ${tone.tint}`}
                        >
                          <Icon size={11} />
                          {formatRelative(o.shipByDate)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center gap-1">
                          {/* O.70: snooze affordance per row. When
                              already snoozed, click "wakes" the row
                              (clears the timestamp). */}
                          {isSnoozed ? (
                            <button
                              onClick={() => unsnooze(o.id)}
                              title={t('outbound.pending.snooze.wake')}
                              className="h-6 px-2 text-sm bg-slate-100 text-slate-600 rounded hover:bg-slate-200 inline-flex items-center gap-1"
                            >
                              <Clock size={11} /> {t('outbound.pending.snooze.wakeLabel')}
                            </button>
                          ) : (
                            <button
                              onClick={() => snooze(o.id, 1)}
                              title={t('outbound.pending.snooze.tooltip')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                            >
                              <Clock size={11} />
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setSelected(new Set([o.id]))
                              void (async () => {
                                await new Promise((r) => setTimeout(r, 0))
                                bulkCreateShipments()
                              })()
                            }}
                            className="h-6 px-2 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1"
                          >
                            <Package size={11} /> {t('outbound.pending.createShipment')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {alertsModalView && (
        <AlertsModal
          view={alertsModalView}
          alerts={alertsByView[alertsModalView.id] ?? []}
          onClose={() => setAlertsModalView(null)}
          onAdd={async (comparison, threshold) => {
            const ok = await subscribeAlert(alertsModalView, { comparison, threshold })
            return Boolean(ok)
          }}
          onRemove={unsubscribeAlert}
          onEditThreshold={updateAlertThreshold}
          t={t}
        />
      )}

      {createResults && (
        <BulkCreateResultsModal
          results={createResults}
          orders={data?.items ?? []}
          onClose={() => setCreateResults(null)}
          onOpenDrawer={(orderId) => {
            setCreateResults(null)
            const next = new URLSearchParams(params.toString())
            next.set('drawer', orderId)
            router.replace(`?${next.toString()}`, { scroll: false })
          }}
          t={t}
        />
      )}

      {preflight && (
        <PreflightModal
          report={preflight}
          onClose={() => setPreflight(null)}
          onProceed={() => {
            setPreflight(null)
            void bulkCreateShipments()
          }}
          onOpenDrawer={(orderId) => {
            setPreflight(null)
            const next = new URLSearchParams(params.toString())
            next.set('drawer', orderId)
            router.replace(`?${next.toString()}`, { scroll: false })
          }}
          t={t}
        />
      )}
    </div>
  )
}

// O.69: bulk-create preflight modal. Renders the per-order
// readiness report; ready orders show as a compact green pill,
// blocked orders list their issue codes (mapped to translated
// labels). Operator can fix issues via Open buttons or proceed
// anyway — the bulk-create endpoint will skip blocked orders.
const ISSUE_TKEY: Record<string, string> = {
  SHIPMENT_EXISTS: 'outbound.pending.preflight.issue.shipmentExists',
  MISSING_ADDRESS: 'outbound.pending.preflight.issue.missingAddress',
  CUSTOMS_HS_MISSING: 'outbound.pending.preflight.issue.hsMissing',
  CUSTOMS_ORIGIN_MISSING: 'outbound.pending.preflight.issue.originMissing',
}

function PreflightModal({
  report,
  onClose,
  onProceed,
  onOpenDrawer,
  t,
}: {
  report: {
    total: number
    ready: number
    errors: number
    warnings: number
    orders: Array<{
      orderId: string
      channelOrderId: string
      country: string | null
      isInternational: boolean
      ready: boolean
      issues: Array<{ severity: 'error' | 'warning'; code: string }>
    }>
  }
  onClose: () => void
  onProceed: () => void
  onOpenDrawer: (orderId: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const blocked = report.orders.filter((o) => !o.ready)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-md shadow-xl w-full max-w-xl mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <div className="text-sm font-medium text-slate-900">
              {t('outbound.pending.preflight.title')}
            </div>
            <div className="text-sm text-slate-500">
              {t('outbound.pending.preflight.summary', {
                ready: report.ready,
                total: report.total,
                blocked: report.errors,
              })}
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded"
          >
            <X size={12} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-1.5">
          {blocked.length === 0 ? (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
              {t('outbound.pending.preflight.allReady')}
            </div>
          ) : (
            blocked.map((o) => (
              <div
                key={o.orderId}
                className="flex items-start gap-2 px-2 py-1.5 border border-rose-200 bg-rose-50 rounded"
              >
                <AlertTriangle size={11} className="text-rose-500 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0 text-sm">
                  <div className="font-mono text-slate-900">
                    {o.channelOrderId}
                    {o.country && (
                      <span className="ml-2 text-xs text-slate-500 font-sans">
                        → {o.country}
                      </span>
                    )}
                  </div>
                  <ul className="text-xs text-rose-700 list-disc list-inside">
                    {o.issues.map((iss, idx) => (
                      <li key={`${iss.code}-${idx}`}>
                        {ISSUE_TKEY[iss.code]
                          ? t(ISSUE_TKEY[iss.code])
                          : iss.code.replace(/_/g, ' ')}
                      </li>
                    ))}
                  </ul>
                </div>
                <button
                  onClick={() => onOpenDrawer(o.orderId)}
                  className="text-xs px-2 py-0.5 text-slate-700 border border-slate-200 rounded hover:bg-white"
                >
                  {t('common.open')}
                </button>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200">
          <button
            onClick={onClose}
            className="h-7 px-3 text-sm text-slate-600 border border-slate-200 rounded hover:bg-slate-50"
          >
            {t('common.close')}
          </button>
          <button
            onClick={onProceed}
            disabled={report.ready === 0}
            className="ml-auto h-7 px-3 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Plus size={11} />
            {t('outbound.pending.preflight.proceedReady', { n: report.ready })}
          </button>
        </div>
      </div>
    </div>
  )
}

// O.67: bulk-create results modal. Renders only when at least one
// order failed; lists each failure with its operator-readable
// reason and a "Open" button that pops the drawer for diagnosis.
function BulkCreateResultsModal({
  results,
  orders,
  onClose,
  onOpenDrawer,
  t,
}: {
  results: {
    created: number
    total: number
    errors: Array<{ orderId: string; reason: string }>
  }
  orders: PendingOrder[]
  onClose: () => void
  onOpenDrawer: (orderId: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const orderById = useMemo(() => {
    const map = new Map<string, PendingOrder>()
    for (const o of orders) map.set(o.id, o)
    return map
  }, [orders])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-md shadow-xl w-full max-w-xl mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <div className="text-sm font-medium text-slate-900">
              {t('outbound.pending.bulkResults.title')}
            </div>
            <div className="text-sm text-slate-500">
              {t('outbound.pending.bulkResults.summary', {
                ok: results.created,
                total: results.total,
                failed: results.errors.length,
              })}
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded"
          >
            <X size={12} />
          </button>
        </div>
        <div className="px-4 py-3">
          <ul className="space-y-1.5">
            {results.errors.map((err) => {
              const o = orderById.get(err.orderId)
              return (
                <li
                  key={err.orderId}
                  className="flex items-start gap-2 px-2 py-1.5 border border-rose-200 bg-rose-50 rounded"
                >
                  <AlertTriangle size={11} className="text-rose-500 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0 text-sm">
                    <div className="font-mono text-slate-900">
                      {o?.channelOrderId ?? err.orderId.slice(0, 12)}
                    </div>
                    <div className="text-rose-700 text-xs">{err.reason}</div>
                  </div>
                  <button
                    onClick={() => onOpenDrawer(err.orderId)}
                    className="text-xs px-2 py-0.5 text-slate-700 border border-slate-200 rounded hover:bg-white"
                  >
                    {t('common.open')}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}

// O.61: alerts manager modal. Lists every alert for the chosen view +
// add-form at the bottom. The dropdown's bell click handler defers
// here so multi-alert flows (warn-then-escalate, GT+LT pairs) are a
// first-class operator workflow rather than buried under prompts.
function AlertsModal({
  view,
  alerts,
  onClose,
  onAdd,
  onRemove,
  onEditThreshold,
  t,
}: {
  view: { id: string; name: string }
  alerts: Array<{
    id: string
    name: string
    isActive: boolean
    comparison: string
    threshold: number
    lastCount: number
    cooldownMinutes: number
  }>
  onClose: () => void
  onAdd: (comparison: string, threshold: number) => Promise<boolean>
  onRemove: (alertId: string) => Promise<void>
  onEditThreshold: (alertId: string, threshold: number) => Promise<void>
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const [comparison, setComparison] = useState<'GT' | 'LT' | 'CHANGE_ABS' | 'CHANGE_PCT'>('GT')
  const [thresholdInput, setThresholdInput] = useState('5')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = Number(thresholdInput)
    if (!Number.isFinite(n) || n < 0) return
    setSubmitting(true)
    const ok = await onAdd(comparison, n)
    setSubmitting(false)
    if (ok) setThresholdInput('5')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-md shadow-xl w-full max-w-md mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <div className="text-sm font-medium text-slate-900">
              {t('outbound.alerts.modalTitle')}
            </div>
            <div className="text-sm text-slate-500 truncate">{view.name}</div>
          </div>
          <button
            onClick={onClose}
            className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded"
          >
            <X size={12} />
          </button>
        </div>

        <div className="px-4 py-3">
          {alerts.length === 0 ? (
            <div className="text-sm text-slate-500 py-2">
              {t('outbound.alerts.empty')}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {alerts.map((a) => (
                <li
                  key={a.id}
                  className={`flex items-center gap-2 px-2 py-1.5 border rounded ${
                    a.isActive ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50 opacity-60'
                  }`}
                >
                  <Bell size={11} className={a.isActive ? 'text-amber-500' : 'text-slate-400'} fill="currentColor" />
                  <span className="text-sm text-slate-700 flex-1">
                    {t(`outbound.alerts.comparison.${a.comparison}`)}
                    {' '}
                    <span className="tabular-nums font-medium text-slate-900">{a.threshold}</span>
                    <span className="text-xs text-slate-500 ml-2">
                      {t('outbound.alerts.lastCount', { count: a.lastCount })}
                    </span>
                  </span>
                  <button
                    onClick={async () => {
                      const next = window.prompt(
                        t('outbound.alerts.editPrompt', { threshold: a.threshold }),
                        String(a.threshold),
                      )
                      if (next == null) return
                      const n = Number(next)
                      if (!Number.isFinite(n) || n < 0) return
                      if (n === a.threshold) return
                      await onEditThreshold(a.id, n)
                    }}
                    className="text-xs px-2 py-0.5 text-slate-600 border border-slate-200 rounded hover:bg-white"
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => onRemove(a.id)}
                    className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-rose-600 rounded"
                    title={t('common.delete')}
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form onSubmit={submit} className="border-t border-slate-200 px-4 py-3 space-y-2">
          <div className="text-sm font-medium text-slate-700">
            {t('outbound.alerts.addAnother')}
          </div>
          <div className="flex gap-1.5 items-center">
            <select
              value={comparison}
              onChange={(e) => setComparison(e.target.value as typeof comparison)}
              className="text-sm border border-slate-200 rounded px-2 py-1 bg-white"
            >
              <option value="GT">{t('outbound.alerts.comparison.GT')}</option>
              <option value="LT">{t('outbound.alerts.comparison.LT')}</option>
              <option value="CHANGE_ABS">{t('outbound.alerts.comparison.CHANGE_ABS')}</option>
              <option value="CHANGE_PCT">{t('outbound.alerts.comparison.CHANGE_PCT')}</option>
            </select>
            <input
              type="number"
              min={0}
              step={1}
              value={thresholdInput}
              onChange={(e) => setThresholdInput(e.target.value)}
              className="text-sm border border-slate-200 rounded px-2 py-1 w-24 tabular-nums"
              placeholder="5"
            />
            <button
              type="submit"
              disabled={submitting}
              className="ml-auto h-7 px-3 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1 disabled:opacity-60"
            >
              <Plus size={11} /> {t('common.add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
