'use client'

/**
 * SCV.2 — product-first Sync Control grid.
 *
 * 37 MASTER rows (one per product family) on the shared DataGrid. Small
 * families expand inline to their listing rows; big families (childrenOmitted)
 * show an "Open ↗" button to the dedicated per-product page. Selection is at
 * the MASTER level — a bulk action applies to ALL of a master's non-FBA
 * listings (the server expands masterIds → listings, FBA excluded). Live via
 * usePolledList + invalidation, so orders/cascades reflect without a manual
 * refresh.
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, ChevronRight, ChevronDown, ExternalLink } from 'lucide-react'
import { DataGrid, Pagination, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'
import { GridToolbar } from '@/design-system/patterns'
import { Button, Input, Pill, SegmentedControl } from '@/design-system/primitives'
import { Thumbnail, DensityContext } from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import SyncExcelBar from './SyncExcelBar'
import {
  DENSITY_OPTIONS, MODE_TONE, MODE_LABEL, mapDensity,
  type Density, type Mode, type Row, type ProductMaster,
} from './sync-control-shared'
import styles from './styles.module.css'

const API = getBackendUrl()

interface ProductsResponse {
  total: number
  page: number
  pageSize: number
  products: ProductMaster[]
}

type DRow =
  | { key: string; kind: 'master'; m: ProductMaster }
  | { key: string; kind: 'child'; c: Row }

interface Props {
  filters: { channel: string; market: string; mode: string; q: string; drift: boolean }
  density: Density
  onDensity: (d: Density) => void
  onChanged: () => void
  notify: (msg: string) => void
  /** Live search-box value (parent debounces it into filters.q). */
  search: string
  onSearch: (v: string) => void
}

const BULK_ACTIONS: Array<[string, string]> = [
  ['FOLLOW', 'Set Follow'],
  ['PIN', 'Pin'],
  ['PAUSE', 'Pause'],
  ['RESUME', 'Resume'],
  ['ZERO_PIN', 'Zero & Pin'],
  ['EXCLUDE', 'Exclude'],
  ['INCLUDE', 'Include'],
]

/** A master is all-FBA (nothing to act on) when every listing is FBA. */
function allFba(m: ProductMaster): boolean {
  return m.rollup.listings > 0 && (m.rollup.modeCounts.FBA ?? 0) === m.rollup.listings
}

export default function SyncProductsGrid({ filters, density, onDensity, onChanged, notify, search, onSearch }: Props) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bufferVal, setBufferVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [family, setFamily] = useState('')
  const confirm = useConfirm()

  const url = useMemo(() => {
    const p = new URLSearchParams()
    if (filters.channel) p.set('channel', filters.channel)
    if (filters.market) p.set('market', filters.market)
    if (filters.mode) p.set('mode', filters.mode)
    if (filters.q) p.set('q', filters.q)
    if (filters.drift) p.set('drift', '1')
    p.set('page', String(page))
    p.set('pageSize', String(pageSize))
    return `/api/stock/sync-control/products?${p.toString()}`
  }, [filters, page, pageSize])

  // Export mirrors the active filters ("export what you see"). Family narrows
  // client-side only, so it isn't part of the server export scope.
  const exportQuery = useMemo(() => {
    const p = new URLSearchParams()
    if (filters.channel) p.set('channel', filters.channel)
    if (filters.market) p.set('market', filters.market)
    if (filters.mode) p.set('mode', filters.mode)
    if (filters.q) p.set('q', filters.q)
    if (filters.drift) p.set('drift', '1')
    return p.toString()
  }, [filters])

  const { data, loading } = usePolledList<ProductsResponse>({
    url,
    intervalMs: 30_000,
    invalidationTypes: ['stock.adjusted', 'listing.updated', 'product.updated'],
  })

  // Family facet — derived from the loaded masters (all 37 fit one page), so
  // the dropdown always covers every family. Narrows client-side.
  const familyOptions = useMemo(() => {
    const byCode = new Map<string, string>()
    for (const p of data?.products ?? []) if (p.family) byCode.set(p.family.code, p.family.label)
    return [...byCode.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [data])
  const products = useMemo(() => {
    const all = data?.products ?? []
    return family ? all.filter((p) => p.family?.code === family) : all
  }, [data, family])
  const total = family ? products.length : (data?.total ?? 0)

  const displayRows = useMemo<DRow[]>(() => {
    const out: DRow[] = []
    for (const m of products) {
      out.push({ key: `m:${m.masterId}`, kind: 'master', m })
      if (expanded.has(m.masterId) && !m.childrenOmitted) {
        m.children.forEach((c, i) =>
          out.push({ key: `c:${m.masterId}:${c.channel}:${c.marketplace}:${c.sku}:${c.itemId ?? i}`, kind: 'child', c }),
        )
      }
    }
    return out
  }, [products, expanded])

  const selectedMasterIds = useMemo(
    () => [...selected].filter((k) => k.startsWith('m:')).map((k) => k.slice(2)),
    [selected],
  )

  const toggleExpand = useCallback((masterId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(masterId) ? next.delete(masterId) : next.add(masterId)
      return next
    })
  }, [])

  const runAction = async (action: string, opts: { buffer?: number } = {}) => {
    if (selectedMasterIds.length === 0) { notify(`Select one or more products first.`); return }
    const ok = await confirm({
      title: `${action.replace('_', ' ')} — ${selectedMasterIds.length} product${selectedMasterIds.length === 1 ? '' : 's'}`,
      description:
        `Applies to every non-FBA listing across ${selectedMasterIds.length} product${selectedMasterIds.length === 1 ? '' : 's'}` +
        ` (all channels + markets). FBA stays Amazon-managed.` +
        (action === 'ZERO_PIN' ? ' · pushes quantity 0 NOW and pins there.' : '') +
        (action === 'PAUSE' ? ' · freezes current quantities; nothing pushes until Resume.' : ''),
      confirmLabel: 'Apply',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(`${API}/api/stock/sync-control/actions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, masterIds: selectedMasterIds, buffer: opts.buffer }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`)
      notify(`${action}: updated ${d.updated}, unchanged ${d.unchanged ?? 0}, FBA skipped ${d.skippedFba ?? 0}${d.recascadeQueued ? `, recascading ${d.recascadeQueued} product(s)` : ''}`)
      setSelected(new Set())
      emitInvalidation({ type: 'listing.updated', meta: { source: 'sync-control-products', masters: selectedMasterIds.length } })
      onChanged()
    } catch (e) {
      notify(`${action} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<Array<Column<DRow>>>(() => [
    {
      key: 'product', label: 'Product', sticky: true, width: 340,
      render: (r) => r.kind === 'master' ? <MasterCell m={r.m} expanded={expanded.has(r.m.masterId)} onToggle={() => toggleExpand(r.m.masterId)} /> : <ChildCell c={r.c} />,
    },
    {
      key: 'scope', label: 'Scope', width: 150,
      render: (r) => r.kind === 'master'
        ? <span className="text-xs text-zinc-500">{r.m.variantCount} var · {r.m.listingCount} lst · {r.m.rollup.channels.length} ch</span>
        : <span className="text-xs text-zinc-500">{r.c.lane === 'SHARED' ? 'Shared' : 'Listing'}</span>,
    },
    {
      key: 'sync', label: 'Sync', width: 170,
      render: (r) => r.kind === 'master' ? <SyncRollup m={r.m} /> : <Pill tone={MODE_TONE[r.c.mode]}>{MODE_LABEL[r.c.mode]}</Pill>,
    },
    {
      key: 'intended', label: 'Intended', align: 'right', width: 80,
      render: (r) => r.kind === 'child' ? <span className="tabular-nums">{r.c.mode === 'FBA' ? '—' : r.c.intendedQty ?? '—'}</span> : null,
    },
    {
      key: 'live', label: 'Live', align: 'right', width: 70,
      render: (r) => r.kind === 'child' ? <span className="tabular-nums">{r.c.mode === 'FBA' ? '—' : r.c.liveQty ?? '—'}</span> : null,
    },
    {
      key: 'stock', label: 'In stock', align: 'right', width: 120,
      render: (r) => r.kind === 'master'
        ? <span className="text-xs"><span className="tabular-nums font-medium">{r.m.poolTotal}</span> u · <span className="tabular-nums text-zinc-500">{r.m.variantsInStock}/{r.m.variantCount}</span></span>
        : null,
    },
    {
      key: 'drift', label: 'Drift', width: 90,
      render: (r) => {
        if (r.kind === 'master') {
          return r.m.rollup.driftCount > 0
            ? <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />{r.m.rollup.driftCount}</span>
            : <span className="text-xs text-emerald-600">✓</span>
        }
        const d = r.c.mode !== 'FBA' && r.c.intendedQty != null && r.c.liveQty != null && r.c.intendedQty !== r.c.liveQty
        return d ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" /> : null
      },
    },
    {
      key: 'buffer', label: 'Buffer', align: 'right', width: 70,
      render: (r) => r.kind === 'master'
        ? <span className="tabular-nums text-xs text-zinc-500">{r.m.rollup.maxBuffer || '—'}</span>
        : <span className="tabular-nums text-xs">{r.c.mode === 'FBA' ? '—' : r.c.buffer}</span>,
    },
  ], [expanded, toggleExpand])

  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="h10-ds-gridcard">
      <GridToolbar
        count={
          selectedMasterIds.length > 0
            ? <>Selected <b>{selectedMasterIds.length}</b> {selectedMasterIds.length === 1 ? 'product' : 'products'}</>
            : <>Viewing <b>{from}–{to}</b> of <b>{total}</b> products</>
        }
        right={
          <>
            <SyncExcelBar exportQuery={exportQuery} notify={notify} onApplied={onChanged} />
            {familyOptions.length > 0 && (
              <span style={{ width: 150, display: 'inline-flex' }}>
                <Listbox ariaLabel="Family" value={family} onChange={setFamily}
                  options={[{ value: '', label: 'All families' }, ...familyOptions.map(([code, label]) => ({ value: code, label }))]} />
              </span>
            )}
            <SegmentedControl options={DENSITY_OPTIONS} value={density} onChange={(v) => onDensity(v as Density)} size="sm" />
            <span style={{ width: 110, display: 'inline-flex' }}>
              <Listbox ariaLabel="Rows per page" value={String(pageSize)} onChange={(v) => { setPage(1); setPageSize(Number(v)) }}
                options={[25, 50, 100].map((n) => ({ value: String(n), label: `${n} / page` }))} />
            </span>
          </>
        }
      >
        {selectedMasterIds.length > 0 ? (
          <span className={styles.selActions}>
            {BULK_ACTIONS.map(([a, label]) => (
              <Button key={a} size="sm" disabled={busy} onClick={() => void runAction(a)}>{label}</Button>
            ))}
            <span className="inline-flex items-center gap-1 text-sm">
              Buffer
              <Input inputMode="numeric" value={bufferVal} onChange={(e) => setBufferVal(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" style={{ width: 56 }} />
              <Button size="sm" disabled={busy || bufferVal === ''} onClick={() => void runAction('BUFFER', { buffer: Number(bufferVal) })}>Apply</Button>
            </span>
            <Button size="sm" disabled={busy} onClick={() => setSelected(new Set())}>Clear</Button>
          </span>
        ) : (
          <span className={styles.searchField}>
            <Input leadingIcon={<Search size={13} style={{ color: 'var(--text-tertiary)' }} />} placeholder="Search product or SKU…" value={search} onChange={(e) => onSearch(e.target.value)} style={{ width: '100%' }} />
          </span>
        )}
      </GridToolbar>

      <DensityContext.Provider value={mapDensity(density)}>
        <div className={density === 'compact' ? styles.densityCompact : density === 'spacious' ? styles.densitySpacious : undefined}>
          <DataGrid<DRow>
            columns={columns}
            rows={displayRows}
            rowKey={(r) => r.key}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            rowSelectable={(r) => r.kind === 'master' && !allFba(r.m)}
            rowSelectableHint="Amazon-managed (FBA) — no non-FBA listings to act on"
            emptyState={loading ? <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span> : <span style={{ color: 'var(--text-tertiary)' }}>No products match the filters.</span>}
          />
        </div>
      </DensityContext.Provider>

      <div className={styles.gridFooter}>
        <span className="tabular-nums">{total} products · page {page}/{pages}</span>
        <Pagination page={page} pageCount={pages} onPage={setPage} />
      </div>
    </div>
  )
}

// ── cells ───────────────────────────────────────────────────────────────────

function MasterCell({ m, expanded, onToggle }: { m: ProductMaster; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-2">
      {m.childrenOmitted ? (
        <Link
          href={`/fulfillment/stock/sync-control/product/${m.masterId}`}
          target="_blank"
          rel="noopener"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
          title={`Open ${m.listingCount} listings in a new tab`}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={13} />
        </Link>
      ) : m.listingCount > 0 ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); onToggle() }} aria-label={expanded ? 'Collapse' : 'Expand'} className="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      ) : (
        <span className="inline-block h-5 w-5" aria-hidden />
      )}
      <Thumbnail src={m.imageUrl} alt={m.name} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Link href={`/products/${m.masterId}/edit`} target="_blank" rel="noopener" className="truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100" title={m.name} onClick={(e) => e.stopPropagation()}>
            {m.name}
          </Link>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="font-mono">{m.sku}</span>
          {m.family && <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">{m.family.label}</span>}
        </div>
      </div>
    </div>
  )
}

function ChildCell({ c }: { c: Row }) {
  return (
    <div className="flex items-center gap-2 pl-7">
      <div className="min-w-0">
        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {c.sku}{c.itemId ? <span className="ml-1 text-zinc-400">#{c.itemId}</span> : null}
        </div>
        <div className="text-xs text-zinc-500">{c.channel} · {c.marketplace}</div>
      </div>
    </div>
  )
}

function SyncRollup({ m }: { m: ProductMaster }) {
  const { rollup } = m
  if (rollup.uniform && rollup.dominantMode) {
    return (
      <span className="inline-flex items-center gap-1">
        <Pill tone={MODE_TONE[rollup.dominantMode as Mode] ?? 'neutral'}>{MODE_LABEL[rollup.dominantMode as Mode] ?? rollup.dominantMode}</Pill>
      </span>
    )
  }
  const entries = Object.entries(rollup.modeCounts).sort((a, b) => b[1] - a[1])
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs">
      {entries.map(([mode, n]) => (
        <span key={mode} className="inline-flex items-center gap-0.5">
          <Pill tone={MODE_TONE[mode as Mode] ?? 'neutral'}>{MODE_LABEL[mode as Mode] ?? mode}</Pill>
          <span className="tabular-nums text-zinc-500">{n}</span>
        </span>
      ))}
    </span>
  )
}
