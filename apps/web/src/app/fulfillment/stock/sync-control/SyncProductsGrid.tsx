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

import { useEffect, useCallback, useMemo, useState } from 'react'
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
import { Tooltip } from '@/components/ui/Tooltip'
import { Tip } from './SyncTip'
import SyncExcelBar from './SyncExcelBar'
import {
  DENSITY_OPTIONS, MODE_TONE, MODE_LABEL, MODE_HELP, COLUMN_HELP, ACTION_HELP, CONTROL_HELP, PAGE_SIZES, mapDensity,
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
  // SCD.2 — footer row under a big family's inline preview, linking to the
  // full per-product page.
  | { key: string; kind: 'more'; m: ProductMaster }

interface Props {
  filters: { channels: string[]; markets: string[]; modes: string[]; q: string; drift: boolean }
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
  ['CLOSE_OFFER', 'Close offer'],
  ['REOPEN_OFFER', 'Reopen offer'],
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

  // SCT.3 — search + family narrow the product LIST but are not part of the
  // server-side action scope; a selection made before typing a search could
  // still be acted on while hidden. Narrowing the list clears the selection.
  useEffect(() => { setSelected(new Set()) }, [search, family])
  const confirm = useConfirm()

  const url = useMemo(() => {
    const p = new URLSearchParams()
    if (filters.channels.length) p.set('channel', filters.channels.join(','))
    if (filters.markets.length) p.set('market', filters.markets.join(','))
    if (filters.modes.length) p.set('mode', filters.modes.join(','))
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
    if (filters.channels.length) p.set('channel', filters.channels.join(','))
    if (filters.markets.length) p.set('market', filters.markets.join(','))
    if (filters.modes.length) p.set('mode', filters.modes.join(','))
    if (filters.q) p.set('q', filters.q)
    if (filters.drift) p.set('drift', '1')
    return p.toString()
  }, [filters])

  const { data, loading } = usePolledList<ProductsResponse>({
    url,
    intervalMs: 30_000,
    // SCD.5 — also react to CREATE/DELETE so a freshly-listed or -duplicated
    // product (which joins its group via the pool) appears live, not on the
    // next 30s poll. Requires useListingEvents mounted on the page (SCD.5).
    invalidationTypes: ['stock.adjusted', 'listing.updated', 'product.updated', 'product.created', 'listing.created', 'product.deleted', 'listing.deleted'],
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
      // SCD.2 — EVERY family expands inline. Big ones ship a preview slice and
      // get a footer row linking to the full family in a new tab.
      if (expanded.has(m.masterId)) {
        m.children.forEach((c, i) =>
          out.push({ key: `c:${m.masterId}:${c.channel}:${c.marketplace}:${c.sku}:${c.itemId ?? i}`, kind: 'child', c }),
        )
        if (m.childrenOmitted) out.push({ key: `more:${m.masterId}`, kind: 'more', m })
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
    // SCT.3 — the action is narrowed server-side to the rows the active
    // filters show; the confirm dialog must say the same thing.
    const scopeBits = [
      filters.channels.length ? `channel ${filters.channels.join('/')}` : '',
      filters.markets.length ? `market ${filters.markets.join('/')}` : '',
      filters.modes.length ? `mode ${filters.modes.join('/')}` : '',
      filters.drift ? 'drifted rows only (evaluated at apply time — drift moves as syncs converge)' : '',
    ].filter(Boolean)
    const ok = await confirm({
      title: `${action.replace('_', ' ')} — ${selectedMasterIds.length} product${selectedMasterIds.length === 1 ? '' : 's'}`,
      description:
        `Applies to every non-FBA listing across ${selectedMasterIds.length} product${selectedMasterIds.length === 1 ? '' : 's'}` +
        (scopeBits.length ? ` matching your filters (${scopeBits.join(', ')}) — other markets/listings stay untouched.` : ` (all channels + markets).`) +
        ` FBA stays Amazon-managed.` +
        (action === 'ZERO_PIN' ? ' · pushes quantity 0 NOW and pins there.' : '') +
        (action === 'PAUSE' ? ' · freezes current quantities; nothing pushes until Resume.' : ''),
      confirmLabel: 'Apply',
    })
    if (!ok) return
    setBusy(true)
    // SCD.3 — a group's action must hit ALL its listings: the canonical master
    // AND the duplicate copies folded into it (memberMasterIds). The server's
    // masterIds expansion + shared-pool memberships then cover every listing.
    const expandedMasterIds = [...new Set(selectedMasterIds.flatMap((gid) => {
      const p = products.find((x) => x.masterId === gid)
      return [gid, ...(p?.memberMasterIds ?? [])]
    }))]
    try {
      const res = await fetch(`${API}/api/stock/sync-control/actions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action, masterIds: expandedMasterIds, buffer: opts.buffer,
          // Act-on-what-you-see: the server narrows the family expansion to
          // rows matching these filters with the same predicate the grid uses.
          scope: { channels: filters.channels, markets: filters.markets, modes: filters.modes, drift: filters.drift },
        }),
      })
      let d = await res.json()
      if (res.status === 409 && d?.euExpandRequired) {
        // SCT.5b — Amazon shares ONE EU quantity per SKU; one honest confirm
        // with the true scope, then it executes. No refusals.
        const okEu = await confirm({
          title: 'This covers ALL Amazon EU markets',
          description:
            `${d.error} Example: ${(d.preview ?? []).slice(0, 3).map((p2: { sku: string; addedMarkets: string[] }) => `${p2.sku} → also ${p2.addedMarkets.join('/')}`).join(' · ')}` +
            `${(d.preview ?? []).length > 3 ? ` · +${(d.preview ?? []).length - 3} more` : ''}. Proceed with the full EU scope?`,
          confirmLabel: `${action.replace('_', ' ')} on all EU markets`,
        })
        if (!okEu) { setBusy(false); return }
        const res2 = await fetch(`${API}/api/stock/sync-control/actions`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action, masterIds: expandedMasterIds, buffer: opts.buffer,
            scope: { channels: filters.channels, markets: filters.markets, modes: filters.modes, drift: filters.drift },
            expandEuAligned: true,
          }),
        })
        d = await res2.json()
        if (!res2.ok) throw new Error(d?.error ?? d?.message ?? `HTTP ${res2.status}`)
      } else if (!res.ok) {
        throw new Error(d?.error ?? d?.message ?? `HTTP ${res.status}`)
      }
      if (d.error) {
        // Partial: some rows committed, then a later chunk failed. KEEP the
        // selection — the message says "re-run to continue", so the re-run
        // must be one click, not a re-hunt for the same products.
        notify(`${action} PARTIAL — ${d.error}`)
      } else {
        notify(`${action}: updated ${d.updated}, unchanged ${d.unchanged ?? 0}, FBA skipped ${d.skippedFba ?? 0}${d.euExpanded ? `, incl. ${d.euExpanded} sibling EU row(s)` : ''}${d.scopedOut ? `, ${d.scopedOut} outside filters untouched` : ''}${d.recascadeQueued ? `, recascading ${d.recascadeQueued} product(s)` : ''}`)
        setSelected(new Set())
      }
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
      key: 'product', label: <Hdr k="product" label="Product" />, sticky: true, width: 340,
      render: (r) => r.kind === 'master'
        ? <MasterCell m={r.m} expanded={expanded.has(r.m.masterId)} onToggle={() => toggleExpand(r.m.masterId)} />
        : r.kind === 'more' ? <MoreCell m={r.m} /> : <ChildCell c={r.c} />,
    },
    {
      key: 'scope', label: <Hdr k="scope" label="Scope" />, width: 150,
      render: (r) => r.kind === 'master'
        ? <span className="text-xs text-zinc-500">{r.m.variantCount} var · {r.m.listingCount} lst · {r.m.rollup.channels.length} ch</span>
        : r.kind === 'child' ? <span className="text-xs text-zinc-500">{r.c.lane === 'SHARED' ? 'Shared' : 'Listing'}</span> : null,
    },
    {
      key: 'sync', label: <Hdr k="sync" label="Sync" />, width: 170,
      render: (r) => r.kind === 'master' ? <SyncRollup m={r.m} /> : r.kind === 'child' ? <ModePill mode={r.c.mode} /> : null,
    },
    {
      key: 'intended', label: <Hdr k="intended" label="Intended" />, align: 'right', width: 80,
      render: (r) => r.kind === 'child' ? <span className="tabular-nums">{r.c.mode === 'FBA' ? '—' : r.c.intendedQty ?? '—'}</span> : null,
    },
    {
      key: 'live', label: <Hdr k="live" label="Live" />, align: 'right', width: 70,
      render: (r) => r.kind === 'child' ? <span className="tabular-nums">{r.c.mode === 'FBA' ? '—' : r.c.liveQty ?? '—'}</span> : null,
    },
    {
      key: 'stock', label: <Hdr k="stock" label="In stock" />, align: 'right', width: 120,
      render: (r) => r.kind === 'master'
        ? <span className="text-xs"><span className="tabular-nums font-medium">{r.m.poolTotal}</span> u · <span className="tabular-nums text-zinc-500">{r.m.variantsInStock}/{r.m.variantCount}</span></span>
        : null,
    },
    {
      key: 'drift', label: <Hdr k="drift" label="Drift" />, width: 90,
      render: (r) => {
        if (r.kind === 'master') {
          return r.m.rollup.driftCount > 0
            ? <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />{r.m.rollup.driftCount}</span>
            : <span className="text-xs text-emerald-600">✓</span>
        }
        if (r.kind !== 'child') return null
        const d = r.c.mode !== 'FBA' && r.c.intendedQty != null && r.c.liveQty != null && r.c.intendedQty !== r.c.liveQty
        return d ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" /> : null
      },
    },
    {
      key: 'buffer', label: <Hdr k="buffer" label="Buffer" />, align: 'right', width: 70,
      render: (r) => r.kind === 'master'
        ? <span className="tabular-nums text-xs text-zinc-500">{r.m.rollup.maxBuffer || '—'}</span>
        : r.kind === 'child' ? <span className="tabular-nums text-xs">{r.c.mode === 'FBA' ? '—' : r.c.buffer}</span> : null,
    },
  ], [expanded, toggleExpand])

  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="h10-ds-gridcard sc-card-pop">
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
              <Tip help={CONTROL_HELP.filterFamily} width={150}>
                <Listbox ariaLabel="Family" value={family} onChange={setFamily}
                  options={[{ value: '', label: 'All families' }, ...familyOptions.map(([code, label]) => ({ value: code, label }))]} />
              </Tip>
            )}
            <Tip help={CONTROL_HELP.density}>
              <SegmentedControl options={DENSITY_OPTIONS} value={density} onChange={(v) => onDensity(v as Density)} size="sm" />
            </Tip>
            <Tip help={CONTROL_HELP.pageSize} width={110}>
              <Listbox ariaLabel="Rows per page" value={String(pageSize)} onChange={(v) => { setPage(1); setPageSize(Number(v)) }}
                options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))} />
            </Tip>
          </>
        }
      >
        {selectedMasterIds.length > 0 ? (
          <span className={styles.selActions}>
            {BULK_ACTIONS.map(([a, label]) => (
              <Tip key={a} help={ACTION_HELP[a]}>
                <Button size="sm" disabled={busy} onClick={() => void runAction(a)}>{label}</Button>
              </Tip>
            ))}
            <span className="inline-flex items-center gap-1 text-sm">
              <Tip help={ACTION_HELP.BUFFER}><span style={{ cursor: 'help' }}>Buffer</span></Tip>
              <Tip help={CONTROL_HELP.bufferInput}>
                <Input inputMode="numeric" value={bufferVal} onChange={(e) => setBufferVal(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" style={{ width: 56 }} />
              </Tip>
              <Tip help={CONTROL_HELP.bufferApply}>
                <Button size="sm" disabled={busy || bufferVal === ''} onClick={() => void runAction('BUFFER', { buffer: Number(bufferVal) })}>Apply</Button>
              </Tip>
            </span>
            <Tip help={CONTROL_HELP.clearSelection}>
              <Button size="sm" disabled={busy} onClick={() => setSelected(new Set())}>Clear</Button>
            </Tip>
          </span>
        ) : (
          <span className={styles.searchField}>
            <Tooltip content={CONTROL_HELP.searchProducts}>
              <span className="inline-flex" style={{ width: '100%' }}>
                <Input leadingIcon={<Search size={13} style={{ color: 'var(--text-tertiary)' }} />} placeholder="Search product or SKU…" value={search} onChange={(e) => onSearch(e.target.value)} style={{ width: '100%' }} />
              </span>
            </Tooltip>
          </span>
        )}
      </GridToolbar>

      <DensityContext.Provider value={mapDensity(density)}>
        <div className={`scv-fixed-grid ${density === 'compact' ? styles.densityCompact : density === 'spacious' ? styles.densitySpacious : ''}`.trim()}>
          <DataGrid<DRow>
            columns={columns}
            rows={displayRows}
            rowKey={(r) => r.key}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            rowSelectable={(r) => r.kind === 'master' && !allFba(r.m)}
            selectAllHint={CONTROL_HELP.selectAll}
            rowSelectableHint="Amazon-managed (FBA) — no non-FBA listings to act on"
            emptyState={loading ? <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span> : <span style={{ color: 'var(--text-tertiary)' }}>No products match the filters.</span>}
          />
        </div>
      </DensityContext.Provider>

      <div className={styles.gridFooter}>
        <span className="tabular-nums">{total} products · page {page}/{pages}</span>
        <Tip help={CONTROL_HELP.pagination}><Pagination page={page} pageCount={pages} onPage={setPage} /></Tip>
      </div>
    </div>
  )
}

// ── cells ───────────────────────────────────────────────────────────────────

// The cell FILLS the column (styles.fixedTable pins the column width) so the
// long product name truncates at the real column width instead of expanding it.
function MasterCell({ m, expanded, onToggle }: { m: ProductMaster; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="flex w-full items-center gap-2">
      {m.listingCount > 0 ? (
        <Tooltip content={expanded ? 'Hide this product’s listings.' : CONTROL_HELP.expandRow}>
          <button type="button" onClick={(e) => { e.stopPropagation(); onToggle() }} aria-label={expanded ? 'Collapse' : 'Expand'} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </Tooltip>
      ) : (
        <span className="inline-block h-5 w-5 shrink-0" aria-hidden />
      )}
      <span className="shrink-0"><Thumbnail src={m.imageUrl} alt={m.name} /></span>
      <div className="min-w-0 flex-1">
        <Tooltip content={`${m.name} — ${CONTROL_HELP.productLink}`}>
          <Link href={`/products/${m.masterId}/edit`} target="_blank" rel="noopener" className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100" onClick={(e) => e.stopPropagation()}>
            {m.name}
          </Link>
        </Tooltip>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="truncate font-mono">{m.sku}</span>
          {m.family && <span className="shrink-0 rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">{m.family.label}</span>}
        </div>
      </div>
      {/* SCD.5 — every product (not just big families) opens in its own tab:
          the per-product page is where filtering + per-family control live. */}
      {m.listingCount > 0 && (
        <Tooltip content={CONTROL_HELP.openProductTab}>
          <Link
            href={`/fulfillment/stock/sync-control/product/${m.masterId}`}
            target="_blank"
            rel="noopener"
            aria-label={`Open ${m.sku} in a new tab`}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950 dark:hover:text-blue-400"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={13} />
          </Link>
        </Tooltip>
      )}
    </div>
  )
}

/** SCD.2 — footer under a big family's inline preview: how many more listings
 *  exist, and a link to the full family in a new tab. */
function MoreCell({ m }: { m: ProductMaster }) {
  const shown = m.children.length
  const rest = Math.max(0, m.listingCount - shown)
  return (
    <div className="flex w-full items-center gap-2 pl-7">
      <Tooltip content={CONTROL_HELP.openAllListings}>
      <Link
        href={`/fulfillment/stock/sync-control/product/${m.masterId}`}
        target="_blank"
        rel="noopener"
        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        onClick={(e) => e.stopPropagation()}
      >
        Showing {shown} of {m.listingCount} — open all {rest > 0 ? `(+${rest})` : ''} <ExternalLink size={11} />
      </Link>
      </Tooltip>
    </div>
  )
}

function ChildCell({ c }: { c: Row }) {
  return (
    <div className="flex w-full items-center gap-2 pl-7">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {c.sku}{c.itemId ? <span className="ml-1 text-zinc-400">#{c.itemId}</span> : null}
        </div>
        <div className="text-xs text-zinc-500">{c.channel} · {c.marketplace}</div>
      </div>
    </div>
  )
}

// SCD.4 — tooltipped column header + mode pill.
function Hdr({ k, label }: { k: string; label: string }) {
  return <Tooltip content={COLUMN_HELP[k] ?? ''}><span style={{ cursor: 'help' }}>{label}</span></Tooltip>
}
function ModePill({ mode }: { mode: Mode }) {
  // The Tooltip clones its child with a ref + mouse handlers; <Pill> is a
  // function component that drops them, so it must wrap a real DOM node or the
  // tooltip never fires.
  return (
    <Tooltip content={MODE_HELP[mode] ?? ''}>
      <span className="inline-flex" style={{ cursor: 'help' }}><Pill tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</Pill></span>
    </Tooltip>
  )
}

function SyncRollup({ m }: { m: ProductMaster }) {
  const { rollup } = m
  if (rollup.uniform && rollup.dominantMode) {
    return (
      <span className="inline-flex items-center gap-1">
        <ModePill mode={rollup.dominantMode as Mode} />
      </span>
    )
  }
  const entries = Object.entries(rollup.modeCounts).sort((a, b) => b[1] - a[1])
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs">
      {entries.map(([mode, n]) => (
        <span key={mode} className="inline-flex items-center gap-0.5">
          <ModePill mode={mode as Mode} />
          <span className="tabular-nums text-zinc-500">{n}</span>
        </span>
      ))}
    </span>
  )
}
