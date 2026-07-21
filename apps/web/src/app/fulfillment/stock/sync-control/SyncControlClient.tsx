'use client'

/**
 * SC.2 — read-only Sync Control client. Dense, simple, truthful:
 * every mode/quantity comes from the SAME derivation core the engine uses.
 * FBA rows render as untouchable ("—") by design — they will stay that way
 * in every future phase.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Listbox } from '@/design-system/components/Listbox'
import { DataGrid, Pagination, type Column } from '@/design-system/components'
import { GridToolbar, FilterBar, type FilterDimension } from '@/design-system/patterns'
import { Button, Input, Pill, SegmentedControl, type Tone, type SegmentedOption } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { useConfirm } from '@/components/ui/ConfirmProvider'
// DS class styles — the Listbox/grid markup is unstyled without these
// (pages import them directly; see ApiKeysClient for the convention).
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import styles from './styles.module.css'

const API = getBackendUrl()

type Mode = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED'

interface Row {
  lane: 'LISTING' | 'SHARED'
  sku: string
  productId: string | null
  channel: string
  marketplace: string
  mode: Mode
  intendedQty: number | null
  liveQty: number | null
  buffer: number
  routedLocations: string[]
  itemId?: string
}

interface Overview {
  summary: {
    rows: number
    listings: number
    shared: number
    products: number
    byMode: Record<string, number>
    routedLocations: number
    policies: number
  }
  locations: Array<{
    code: string
    name: string
    type: string
    isActive: boolean
    syncRoutes: string[]
    servesMarketplaces: string[]
    stockUnits: number
  }>
  policies: Array<{ channel: string; marketplace: string; pushesPaused: boolean; newListingDefaultMode: string }>
  audit: Array<{ id: string; createdAt: string; actor: string; scopeType: string; scopeName: string | null; field: string }>
  uploadVsPool?: Array<{ id: string; createdAt: string; channel: string; errorMessage: string; resolutionStatus: string }>
}

/** SCG.1 — DS Pill tone per mode (FBA/Uncounted neutral, Excluded danger). */
const MODE_TONE: Record<Mode, Tone> = {
  FOLLOW: 'success',
  PINNED: 'info',
  PAUSED: 'warning',
  PAUSED_POLICY: 'warning',
  UNCOUNTED: 'neutral',
  FBA: 'neutral',
  EXCLUDED: 'danger',
}

const DENSITY_OPTIONS: SegmentedOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'spacious', label: 'Spacious' },
]

const MODE_LABEL: Record<Mode, string> = {
  FOLLOW: 'Follow',
  PINNED: 'Pinned',
  PAUSED: 'Paused',
  PAUSED_POLICY: 'Paused (policy)',
  UNCOUNTED: 'Uncounted',
  FBA: 'FBA',
  EXCLUDED: 'Excluded',
}

/** Cap long card tables: render the first `cap` rows with a Show-all toggle.
 *  All data stays client-side (the server already bounds each list). */
function CappedRows<T>({ rows, cap = 5, render }: { rows: T[]; cap?: number; render: (visible: T[]) => React.ReactNode }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? rows : rows.slice(0, cap)
  return (
    <>
      {render(visible)}
      {rows.length > cap && (
        <div className="border-t border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
          <button
            type="button"
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        </div>
      )}
    </>
  )
}

const inputCls =
  'h-8 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200'

export default function SyncControlClient() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [channel, setChannel] = useState('')
  const [market, setMarket] = useState('')
  const [mode, setMode] = useState('')
  const [q, setQ] = useState('')
  const [qLive, setQLive] = useState('') // input value; q lags 250ms behind
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Map<string, Row>>(new Map())
  const [bufferVal, setBufferVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [editingLoc, setEditingLoc] = useState<string | null>(null)
  const [locDraft, setLocDraft] = useState('')
  const [polChannel, setPolChannel] = useState('AMAZON')
  const [polMarket, setPolMarket] = useState('*')
  const confirm = useConfirm()
  const [pageSize, setPageSize] = useState(50)
  const [density, setDensity] = useState<'compact' | 'cozy' | 'spacious'>('cozy')

  const rowKey = (r: Row) => `${r.lane}|${r.channel}|${r.marketplace}|${r.sku}|${r.itemId ?? ''}`

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/stock/sync-control/overview`, { credentials: 'include' })
      if (!res.ok) throw new Error(`overview ${res.status}`)
      setOverview(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const rowsSeq = useRef(0)
  const loadRows = useCallback(async () => {
    setLoading(true)
    const seq = ++rowsSeq.current
    try {
      const params = new URLSearchParams()
      if (channel) params.set('channel', channel)
      if (market) params.set('market', market)
      if (mode) params.set('mode', mode)
      if (q) params.set('q', q)
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))
      const res = await fetch(`${API}/api/stock/sync-control/listings?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`listings ${res.status}`)
      const data = await res.json()
      if (seq !== rowsSeq.current) return // stale response — a newer request superseded this one
      setRows(data.rows)
      setTotal(data.total)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === rowsSeq.current) setLoading(false)
    }
  }, [channel, market, mode, q, page, pageSize])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => { void loadRows() }, [loadRows])
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setQ(qLive) }, 250)
    return () => clearTimeout(t)
  }, [qLive])

  const runAction = async (action: string, opts: { buffer?: number } = {}) => {
    const rows = [...selected.values()]
    const listings = rows.filter((r) => r.lane === 'LISTING' && r.mode !== 'FBA' && r.productId)
    const memberships = rows.filter((r) => r.lane === 'SHARED')
    const listingActions = ['FOLLOW', 'PIN', 'PAUSE', 'RESUME', 'ZERO_PIN', 'BUFFER']
    const sharedActions = ['EXCLUDE', 'INCLUDE', 'BUFFER']
    const l = listingActions.includes(action) ? listings : []
    const m = sharedActions.includes(action) ? memberships : []
    if (l.length === 0 && m.length === 0) { setNotice(`No eligible rows for ${action}.`); return }
    const fbaSkipped = rows.filter((r) => r.mode === 'FBA').length
    const ok = await confirm({
      title: `${action.replace('_', ' ')} — ${l.length + m.length} row(s)`,
      description:
        `${l.length} listing row(s)${m.length ? ` + ${m.length} shared variant(s)` : ''}` +
        (fbaSkipped ? ` · ${fbaSkipped} FBA row(s) skipped (Amazon-managed)` : '') +
        (action === 'ZERO_PIN' ? ' · pushes quantity 0 NOW and pins there (resume via Set Follow)' : '') +
        (action === 'PAUSE' ? ' · freezes current quantities; nothing pushes until Resume' : ''),
      confirmLabel: 'Apply',
    })
    if (!ok) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch(`${API}/api/stock/sync-control/actions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          buffer: opts.buffer,
          listings: l.map((r) => ({ productId: r.productId, channel: r.channel, marketplace: r.marketplace })),
          memberships: m.map((r) => ({ itemId: r.itemId, marketplace: r.marketplace, sku: r.sku })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setNotice(`${action}: updated ${data.updated}, unchanged ${data.unchanged ?? 0}, FBA skipped ${data.skippedFba ?? 0}${data.recascadeQueued ? `, recascading ${data.recascadeQueued} product(s)` : ''}`)
      setSelected(new Map())
      await Promise.all([loadRows(), loadOverview()])
    } catch (e) {
      setNotice(`${action} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const saveLocRoutes = async (code: string) => {
    const tokens = locDraft.split(',').map((t) => t.trim()).filter(Boolean)
    const ok = await confirm({
      title: `Route ${code}`,
      description: tokens.length
        ? `${code} will sync ONLY to: ${tokens.join(', ')} — every product stocked here recascades now.`
        : `${code} returns to the default (routes everywhere) — every product stocked here recascades now.`,
      confirmLabel: 'Save routing',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(`${API}/api/stock/sync-control/location-routes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, syncRoutes: tokens }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.problems ? data.problems.map((p: { token: string; problem: string }) => `${p.token}: ${p.problem}`).join('; ') : data?.error ?? `HTTP ${res.status}`)
      setNotice(`Routing saved for ${code} — recascading ${data.recascadeQueued} product(s).`)
      setEditingLoc(null)
      await Promise.all([loadOverview(), loadRows()])
    } catch (e) {
      setNotice(`Routing save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // SC.5 — kill-switch + new-listing default. The server deletes an
  // all-default rule, so "resume + FOLLOW" naturally clears the row.
  const savePolicy = async (
    channel: string,
    marketplace: string,
    patch: { pushesPaused?: boolean; newListingDefaultMode?: 'FOLLOW' | 'PAUSED' },
  ) => {
    const scope = `${channel}:${marketplace === '*' ? 'all markets' : marketplace}`
    const desc =
      patch.pushesPaused === true
        ? `KILL-SWITCH: nothing pushes to ${scope} until you resume. Current marketplace quantities freeze as they are.`
        : patch.pushesPaused === false
          ? `Pushes to ${scope} resume — every product in scope recascades to pool truth now.`
          : patch.newListingDefaultMode === 'PAUSED'
            ? `New listings on ${scope} created from now on start PAUSED (dark) instead of following the pool. Existing listings are untouched.`
            : `New listings on ${scope} follow the pool from birth again.`
    const ok = await confirm({
      title: `Policy — ${scope}`,
      description: desc,
      confirmLabel: 'Apply policy',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(`${API}/api/stock/sync-control/policies`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, marketplace, ...patch }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setNotice(`Policy saved for ${scope}${data.recascadeQueued ? ` — recascading ${data.recascadeQueued} product(s)` : ''}.`)
      await Promise.all([loadOverview(), loadRows()])
    } catch (e) {
      setNotice(`Policy save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const s = overview?.summary
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const pausedPolicies = (overview?.policies ?? []).filter((p) => p.pushesPaused)

  // ── SCG.1 — DataGrid plumbing ─────────────────────────────────────────
  // Selection source of truth stays the Map<string, Row> (runAction needs the
  // Row objects); the grid speaks Set<string>. Keys picked on other pages
  // survive toggles (DataGrid copies the set); select-all is page-scoped.
  const selectedKeys = useMemo(() => new Set(selected.keys()), [selected])
  const onGridSelect = (next: Set<string>) => {
    const map = new Map<string, Row>()
    for (const k of next) {
      const existing = selected.get(k)
      if (existing) map.set(k, existing)
      else {
        const row = rows.find((r) => rowKey(r) === k)
        if (row) map.set(k, row)
      }
    }
    setSelected(map)
  }

  const columns = useMemo<Array<Column<Row>>>(() => [
    {
      key: 'sku', label: 'SKU', sticky: true, width: 230, sortable: true,
      sortValue: (r) => r.sku,
      render: (r) => (
        <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }}>
          {r.sku}
          {r.itemId ? <span style={{ marginLeft: 4, color: 'var(--text-tertiary)' }}>#{r.itemId}</span> : null}
        </span>
      ),
    },
    { key: 'channel', label: 'Channel', width: 90, sortable: true, sortValue: (r) => r.channel, render: (r) => r.channel },
    { key: 'market', label: 'Market', width: 80, sortable: true, sortValue: (r) => r.marketplace, render: (r) => r.marketplace },
    { key: 'lane', label: 'Lane', width: 70, render: (r) => <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{r.lane === 'SHARED' ? 'Shared' : 'Listing'}</span> },
    {
      key: 'mode', label: 'Mode', width: 130, sortable: true, sortValue: (r) => r.mode,
      render: (r) => <Pill tone={MODE_TONE[r.mode]}>{MODE_LABEL[r.mode]}</Pill>,
    },
    {
      key: 'intended', label: 'Intended', align: 'right', width: 85, sortable: true,
      sortValue: (r) => (r.mode === 'FBA' ? -1 : r.intendedQty ?? -1),
      render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.intendedQty ?? '—'}</span>,
    },
    {
      key: 'live', label: 'Live', align: 'right', width: 75, sortable: true,
      sortValue: (r) => (r.mode === 'FBA' ? -1 : r.liveQty ?? -1),
      render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.liveQty ?? '—'}</span>,
    },
    { key: 'buffer', label: 'Buffer', align: 'right', width: 70, render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.buffer}</span> },
    {
      key: 'routed', label: 'Routed from',
      render: (r) => (
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
          {r.mode === 'FBA' ? 'Amazon-managed' : r.routedLocations.join(', ') || (r.mode === 'FOLLOW' ? '' : '—')}
        </span>
      ),
    },
  ], [])

  const filterDimensions: FilterDimension[] = [
    {
      key: 'channel', label: 'Channel', kind: 'select', value: channel,
      onChange: (v) => { setPage(1); setChannel(v) },
      options: [
        { value: '', label: 'All channels' },
        { value: 'AMAZON', label: 'Amazon' },
        { value: 'EBAY', label: 'eBay' },
        { value: 'SHOPIFY', label: 'Shopify' },
      ],
    },
    {
      key: 'market', label: 'Market', kind: 'select', value: market,
      onChange: (v) => { setPage(1); setMarket(v) },
      options: [{ value: '', label: 'All markets' }, ...['IT', 'DE', 'FR', 'ES', 'DEFAULT'].map((m) => ({ value: m, label: m }))],
    },
    {
      key: 'mode', label: 'Mode', kind: 'select', value: mode,
      onChange: (v) => { setPage(1); setMode(v) },
      options: [{ value: '', label: 'All modes' }, ...(Object.keys(MODE_LABEL) as Mode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))],
    },
  ]
  const activeFilterCount = [channel, market, mode].filter(Boolean).length + (q ? 1 : 0)
  const rangeFrom = total === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeTo = Math.min(page * pageSize, total)

  return (
    <div className="space-y-4 p-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {[
          ['Rows', s?.rows],
          ['Products', s?.products],
          ['Follow', s?.byMode?.FOLLOW ?? 0],
          ['Pinned', s?.byMode?.PINNED ?? 0],
          ['Paused', (s?.byMode?.PAUSED ?? 0) + (s?.byMode?.PAUSED_POLICY ?? 0) + (s?.byMode?.EXCLUDED ?? 0)],
          ['FBA (excluded)', s?.byMode?.FBA ?? 0],
          ['Routed locations', s?.routedLocations],
          ['Policies', s?.policies],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
            <div className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value ?? '…'}</div>
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
          Failed to load: {error}
        </div>
      )}

      {pausedPolicies.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <span className="font-semibold">Pushes paused:</span>
          {pausedPolicies.map((p) => (
            <span key={`${p.channel}:${p.marketplace}`} className="rounded bg-amber-100 px-1.5 py-0.5 font-medium dark:bg-amber-900">
              {p.channel}:{p.marketplace === '*' ? 'ALL' : p.marketplace}
            </span>
          ))}
          <span>— quantities are NOT being sent to these markets. Resume in Channel policies below.</span>
        </div>
      )}

      {notice && (
        <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">
          {notice}
        </div>
      )}

      {/* SCG.1 — filters (DS FilterBar) + gridcard (GridToolbar + DataGrid) */}
      <FilterBar
        dimensions={filterDimensions}
        activeCount={activeFilterCount}
        onClear={() => { setPage(1); setChannel(''); setMarket(''); setMode(''); setQLive(''); setQ('') }}
      />

      <div className="h10-ds-gridcard">
        <GridToolbar
          count={
            selected.size > 0 ? (
              <>Selected <b>{selected.size}</b> {selected.size === 1 ? 'row' : 'rows'}</>
            ) : (
              <>Viewing <b>{rangeFrom}–{rangeTo}</b> of <b>{total}</b> rows</>
            )
          }
          right={
            <>
              <SegmentedControl
                options={DENSITY_OPTIONS}
                value={density}
                onChange={(v) => setDensity(v as 'compact' | 'cozy' | 'spacious')}
                size="sm"
              />
              <span style={{ width: 110, display: 'inline-flex' }}>
                <Listbox
                  ariaLabel="Rows per page"
                  value={String(pageSize)}
                  onChange={(v) => { setPage(1); setPageSize(Number(v)) }}
                  options={[50, 100, 200].map((n) => ({ value: String(n), label: `${n} / page` }))}
                />
              </span>
            </>
          }
        >
          {selected.size > 0 ? (
            <span className={styles.selActions}>
              {[
                ['FOLLOW', 'Set Follow'],
                ['PIN', 'Pin'],
                ['PAUSE', 'Pause'],
                ['RESUME', 'Resume'],
                ['ZERO_PIN', 'Zero & Pin'],
                ['EXCLUDE', 'Exclude'],
                ['INCLUDE', 'Include'],
              ].map(([a, label]) => (
                <Button key={a} size="sm" disabled={busy} onClick={() => void runAction(a)}>
                  {label}
                </Button>
              ))}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                Buffer
                <Input
                  inputMode="numeric"
                  value={bufferVal}
                  onChange={(e) => setBufferVal(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="0"
                  style={{ width: 56 }}
                />
                <Button size="sm" disabled={busy || bufferVal === ''} onClick={() => void runAction('BUFFER', { buffer: Number(bufferVal) })}>
                  Apply
                </Button>
              </span>
              <Button size="sm" disabled={busy} onClick={() => setSelected(new Map())}>
                Clear
              </Button>
            </span>
          ) : (
            <span className={styles.searchField}>
              <Input
                leadingIcon={<Search size={13} style={{ color: 'var(--text-tertiary)' }} />}
                placeholder="Search SKU…"
                value={qLive}
                onChange={(e) => setQLive(e.target.value)}
                style={{ width: '100%' }}
              />
            </span>
          )}
        </GridToolbar>

        <div className={density === 'compact' ? styles.densityCompact : density === 'spacious' ? styles.densitySpacious : undefined}>
          <DataGrid<Row>
            columns={columns}
            rows={rows}
            rowKey={rowKey}
            selectable
            selected={selectedKeys}
            onSelectedChange={onGridSelect}
            rowSelectable={(r) => r.mode !== 'FBA'}
            rowSelectableHint="Amazon-managed (FBA) — excluded from actions"
            emptyState={
              loading ? (
                <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>No rows match the filters.</span>
              )
            }
          />
        </div>

        <div className={styles.gridFooter}>
          <span className="tabular-nums">{total} rows · page {page}/{pages}</span>
          <Pagination page={page} pageCount={pages} onPage={setPage} />
        </div>
      </div>

      {/* Locations routing + policies + history */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-200 px-3 py-2 text-sm font-semibold dark:border-zinc-800">Location routing</div>
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2 text-right">Units</th>
                <th className="px-3 py-2">Sync routes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {(overview?.locations ?? []).map((l) => (
                <tr key={l.code}>
                  <td className="px-3 py-1.5 font-mono text-xs">{l.code}</td>
                  <td className="px-3 py-1.5 text-xs">{l.type}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.stockUnits}</td>
                  <td className="px-3 py-1.5 text-xs">
                    {l.type !== 'WAREHOUSE' ? (
                      <span className="text-zinc-400">not a sync source</span>
                    ) : editingLoc === l.code ? (
                      <span className="flex items-center gap-1">
                        <input
                          className={`${inputCls} w-64 font-mono text-[11px]`}
                          value={locDraft}
                          onChange={(e) => setLocDraft(e.target.value)}
                          placeholder="e.g. AMAZON:IT, EBAY — empty = everywhere"
                        />
                        <button disabled={busy} className="h-7 rounded border border-emerald-400 px-1.5 text-[11px] text-emerald-700 dark:text-emerald-400" onClick={() => void saveLocRoutes(l.code)}>Save</button>
                        <button className="h-7 rounded border border-zinc-300 px-1.5 text-[11px] dark:border-zinc-700" onClick={() => setEditingLoc(null)}>Cancel</button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        {l.syncRoutes.length
                          ? l.syncRoutes.map((t) => (
                              <span key={t} className="inline-block rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">{t}</span>
                            ))
                          : <span className="text-emerald-700 dark:text-emerald-400">routes everywhere (default)</span>}
                        <button
                          className="ml-1 h-6 rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          onClick={() => { setEditingLoc(l.code); setLocDraft(l.syncRoutes.join(', ')) }}
                        >
                          Edit
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="border-b border-zinc-200 px-3 py-2 text-sm font-semibold dark:border-zinc-800">Channel policies</div>
            {(overview?.policies?.length ?? 0) === 0 ? (
              <div className="px-3 py-3 text-sm text-zinc-500">No policies — every channel-market pushes normally, new listings are born Following.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {overview!.policies.map((p) => (
                    <tr key={`${p.channel}-${p.marketplace}`}>
                      <td className="px-3 py-1.5 font-medium">{p.channel}:{p.marketplace === '*' ? 'ALL' : p.marketplace}</td>
                      <td className="px-3 py-1.5">
                        {p.pushesPaused ? <span className="font-semibold text-amber-600">pushes PAUSED</span> : <span className="text-emerald-600">active</span>}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-zinc-500">new: {p.newListingDefaultMode === 'PAUSED' ? 'born paused' : 'follow'}</td>
                      <td className="px-3 py-1.5 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void savePolicy(p.channel, p.marketplace, { pushesPaused: !p.pushesPaused })}
                            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            {p.pushesPaused ? 'Resume' : 'Pause'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void savePolicy(p.channel, p.marketplace, { newListingDefaultMode: p.newListingDefaultMode === 'PAUSED' ? 'FOLLOW' : 'PAUSED' })}
                            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            {p.newListingDefaultMode === 'PAUSED' ? 'New: follow' : 'New: paused'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <span style={{ width: 120, display: 'inline-flex' }}>
                <Listbox
                  ariaLabel="Policy channel"
                  value={polChannel}
                  onChange={setPolChannel}
                  options={[
                    { value: 'AMAZON', label: 'Amazon' },
                    { value: 'EBAY', label: 'eBay' },
                    { value: 'SHOPIFY', label: 'Shopify' },
                  ]}
                />
              </span>
              <span style={{ width: 120, display: 'inline-flex' }}>
                <Listbox
                  ariaLabel="Policy market"
                  value={polMarket}
                  onChange={setPolMarket}
                  options={[{ value: '*', label: 'All markets' }, ...['IT', 'DE', 'FR', 'ES'].map((m) => ({ value: m, label: m }))]}
                />
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void savePolicy(polChannel, polMarket, { pushesPaused: true })}
                className="rounded border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950"
              >
                Pause pushes
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void savePolicy(polChannel, polMarket, { newListingDefaultMode: 'PAUSED' })}
                className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                New listings born paused
              </button>
            </div>
            <div className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-800">
              Pause = channel-market kill-switch: quantities freeze on the marketplace until Resume (which recascades pool truth). FBA stays Amazon-managed regardless.
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="border-b border-zinc-200 px-3 py-2 text-sm font-semibold dark:border-zinc-800">Your upload vs pool (last 24h)</div>
            {(overview?.uploadVsPool?.length ?? 0) === 0 ? (
              <div className="px-3 py-4 text-sm text-zinc-500">No divergence detected — marketplace quantities match the pool everywhere the read-backs looked.</div>
            ) : (
              <CappedRows
                rows={overview!.uploadVsPool!}
                render={(visible) => (
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {visible.map((u) => (
                        <tr key={u.id}>
                          <td className="px-3 py-1.5 text-xs text-zinc-500">{new Date(u.createdAt).toLocaleTimeString()}</td>
                          <td className="px-3 py-1.5 text-xs">{u.channel}</td>
                          <td className="px-3 py-1.5 text-xs">{u.errorMessage}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              />
            )}
            <div className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-800">
              Your own marketplace uploads never overwrite the pool — the sync restores pool truth and logs the difference here.
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <span className="text-sm font-semibold">History</span>
              <a
                href="/fulfillment/stock/sync-control/history"
                target="_blank"
                rel="noopener"
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Open full history ↗
              </a>
            </div>
            {(overview?.audit?.length ?? 0) === 0 ? (
              <div className="px-3 py-4 text-sm text-zinc-500">No Sync Control changes yet — every mutation will be recorded here (who, what, before → after).</div>
            ) : (
              <CappedRows
                rows={overview!.audit}
                render={(visible) => (
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {visible.map((a) => (
                        <tr key={a.id}>
                          <td className="px-3 py-1.5 text-xs text-zinc-500">{new Date(a.createdAt).toLocaleString()}</td>
                          <td className="px-3 py-1.5 text-xs">{a.actor}</td>
                          <td className="px-3 py-1.5 text-xs">{a.scopeType} {a.scopeName ?? ''}</td>
                          <td className="px-3 py-1.5 text-xs font-mono">{a.field}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
