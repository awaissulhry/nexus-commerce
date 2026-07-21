'use client'

/**
 * SCV.2b — per-product control surface. One master's full variant→listing
 * tree with per-listing selection + the same guarded actions as the main
 * page (server-side FBA exclusion, audit, recascade). Live via usePolledList.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { DataGrid, Pagination, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'
import { GridToolbar } from '@/design-system/patterns'
import { Button, Input, Pill, SegmentedControl } from '@/design-system/primitives'
import { Thumbnail, DensityContext } from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import {
  DENSITY_OPTIONS, MODE_TONE, MODE_LABEL,
  type Density, type Row, type ProductMaster,
} from '../../sync-control-shared'
import styles from '../../styles.module.css'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

const API = getBackendUrl()

const BULK_ACTIONS: Array<[string, string]> = [
  ['FOLLOW', 'Set Follow'], ['PIN', 'Pin'], ['PAUSE', 'Pause'], ['RESUME', 'Resume'],
  ['ZERO_PIN', 'Zero & Pin'], ['EXCLUDE', 'Exclude'], ['INCLUDE', 'Include'],
]

const rowKey = (r: Row) => `${r.lane}|${r.channel}|${r.marketplace}|${r.sku}|${r.itemId ?? ''}`

export default function ProductDetailClient({ masterId }: { masterId: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bufferVal, setBufferVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [density, setDensity] = useState<Density>('cozy')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const confirm = useConfirm()

  const url = useMemo(() => `/api/stock/sync-control/products?masterId=${encodeURIComponent(masterId)}`, [masterId])
  const { data, loading } = usePolledList<{ products: ProductMaster[] }>({
    url,
    intervalMs: 30_000,
    invalidationTypes: ['stock.adjusted', 'listing.updated', 'product.updated'],
  })
  const master = data?.products?.[0] ?? null
  const children = useMemo(
    () => [...(master?.children ?? [])].sort((a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace)),
    [master],
  )

  const rowByKey = useMemo(() => new Map(children.map((r) => [rowKey(r), r])), [children])

  const runAction = async (action: string, opts: { buffer?: number } = {}) => {
    const rows = [...selected].map((k) => rowByKey.get(k)).filter((r): r is Row => Boolean(r))
    const listings = rows.filter((r) => r.lane === 'LISTING' && r.mode !== 'FBA' && r.productId)
    const memberships = rows.filter((r) => r.lane === 'SHARED')
    const listingActs = ['FOLLOW', 'PIN', 'PAUSE', 'RESUME', 'ZERO_PIN', 'BUFFER']
    const sharedActs = ['EXCLUDE', 'INCLUDE', 'BUFFER']
    const l = listingActs.includes(action) ? listings : []
    const m = sharedActs.includes(action) ? memberships : []
    if (l.length === 0 && m.length === 0) { setNotice(`No eligible rows for ${action}.`); return }
    const fbaSkipped = rows.filter((r) => r.mode === 'FBA').length
    const ok = await confirm({
      title: `${action.replace('_', ' ')} — ${l.length + m.length} row(s)`,
      description: `${l.length} listing(s)${m.length ? ` + ${m.length} shared variant(s)` : ''}${fbaSkipped ? ` · ${fbaSkipped} FBA skipped (Amazon-managed)` : ''}` +
        (action === 'ZERO_PIN' ? ' · pushes qty 0 NOW and pins there' : '') +
        (action === 'PAUSE' ? ' · freezes current quantities until Resume' : ''),
      confirmLabel: 'Apply',
    })
    if (!ok) return
    setBusy(true); setNotice(null)
    try {
      const res = await fetch(`${API}/api/stock/sync-control/actions`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action, buffer: opts.buffer,
          listings: l.map((r) => ({ productId: r.productId, channel: r.channel, marketplace: r.marketplace })),
          memberships: m.map((r) => ({ itemId: r.itemId, marketplace: r.marketplace, sku: r.sku })),
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`)
      setNotice(`${action}: updated ${d.updated}, unchanged ${d.unchanged ?? 0}, FBA skipped ${d.skippedFba ?? 0}${d.recascadeQueued ? `, recascading ${d.recascadeQueued} product(s)` : ''}`)
      setSelected(new Set())
      emitInvalidation({ type: 'listing.updated', meta: { source: 'sync-control-product', masterId } })
    } catch (e) {
      setNotice(`${action} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<Array<Column<Row>>>(() => [
    { key: 'sku', label: 'Variant / SKU', sticky: true, width: 280, sortable: true, sortValue: (r) => r.sku,
      render: (r) => <span className="font-mono text-xs">{r.sku}{r.itemId ? <span className="ml-1 text-zinc-400">#{r.itemId}</span> : null}</span> },
    { key: 'channel', label: 'Channel', width: 90, sortable: true, sortValue: (r) => r.channel, render: (r) => r.channel },
    { key: 'market', label: 'Market', width: 80, sortable: true, sortValue: (r) => r.marketplace, render: (r) => r.marketplace },
    { key: 'lane', label: 'Lane', width: 70, render: (r) => <span className="text-xs text-zinc-500">{r.lane === 'SHARED' ? 'Shared' : 'Listing'}</span> },
    { key: 'mode', label: 'Mode', width: 130, sortable: true, sortValue: (r) => r.mode, render: (r) => <Pill tone={MODE_TONE[r.mode]}>{MODE_LABEL[r.mode]}</Pill> },
    { key: 'intended', label: 'Intended', align: 'right', width: 85, sortable: true, sortValue: (r) => (r.mode === 'FBA' ? -1 : r.intendedQty ?? -1),
      render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.intendedQty ?? '—'}</span> },
    { key: 'live', label: 'Live', align: 'right', width: 75, sortable: true, sortValue: (r) => (r.mode === 'FBA' ? -1 : r.liveQty ?? -1),
      render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.liveQty ?? '—'}</span> },
    { key: 'buffer', label: 'Buffer', align: 'right', width: 70, render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.buffer}</span> },
    { key: 'drift', label: 'Drift', width: 70, render: (r) => (r.mode !== 'FBA' && r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty)
      ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" title="live ≠ intended" /> : null },
  ], [])

  const pages = Math.max(1, Math.ceil(children.length / pageSize))
  const pageRows = children.slice((page - 1) * pageSize, page * pageSize)

  if (!loading && !master) {
    return <div className="p-4"><div className="rounded-md border border-zinc-200 px-3 py-6 text-sm text-zinc-500 dark:border-zinc-800">Product not found or has no synced listings. <Link href="/fulfillment/stock/sync-control" className="text-blue-600 hover:underline">Back to Sync Control</Link></div></div>
  }

  return (
    <div className="space-y-4 p-4">
      {/* Master header */}
      {master && (
        <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <DensityContext.Provider value="spacious"><Thumbnail src={master.imageUrl} alt={master.name} hoverPreview={false} /></DensityContext.Provider>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link href={`/products/${master.masterId}/edit`} target="_blank" rel="noopener" className="truncate text-base font-semibold text-zinc-900 hover:underline dark:text-zinc-100" title={master.name}>{master.name}</Link>
              {master.family && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{master.family.label}</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
              <span className="font-mono">{master.sku}</span>
              <span>{master.variantCount} variants · {master.listingCount} listings · {master.rollup.channels.join(', ')}</span>
              <span><span className="font-medium tabular-nums">{master.poolTotal}</span> u in stock · {master.variantsInStock}/{master.variantCount} variants</span>
              {master.rollup.driftCount > 0 && <span className="font-medium text-amber-600">● {master.rollup.driftCount} drift</span>}
              {master.rollup.hasFba && <span className="text-zinc-400">· some FBA (Amazon-managed)</span>}
            </div>
          </div>
        </div>
      )}

      {notice && <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">{notice}</div>}

      <div className="h10-ds-gridcard">
        <GridToolbar
          count={selected.size > 0 ? <>Selected <b>{selected.size}</b> {selected.size === 1 ? 'listing' : 'listings'}</> : <>{children.length} listings</>}
          right={
            <>
              <SegmentedControl options={DENSITY_OPTIONS} value={density} onChange={(v) => setDensity(v as Density)} size="sm" />
              <span style={{ width: 110, display: 'inline-flex' }}>
                <Listbox ariaLabel="Rows per page" value={String(pageSize)} onChange={(v) => { setPage(1); setPageSize(Number(v)) }} options={[50, 100, 200].map((n) => ({ value: String(n), label: `${n} / page` }))} />
              </span>
            </>
          }
        >
          {selected.size > 0 && (
            <span className={styles.selActions}>
              {BULK_ACTIONS.map(([a, label]) => <Button key={a} size="sm" disabled={busy} onClick={() => void runAction(a)}>{label}</Button>)}
              <span className="inline-flex items-center gap-1 text-sm">
                Buffer
                <Input inputMode="numeric" value={bufferVal} onChange={(e) => setBufferVal(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" style={{ width: 56 }} />
                <Button size="sm" disabled={busy || bufferVal === ''} onClick={() => void runAction('BUFFER', { buffer: Number(bufferVal) })}>Apply</Button>
              </span>
              <Button size="sm" disabled={busy} onClick={() => setSelected(new Set())}>Clear</Button>
            </span>
          )}
        </GridToolbar>

        <div className={density === 'compact' ? styles.densityCompact : density === 'spacious' ? styles.densitySpacious : undefined}>
          <DataGrid<Row>
            columns={columns}
            rows={pageRows}
            rowKey={rowKey}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            rowSelectable={(r) => r.mode !== 'FBA'}
            rowSelectableHint="Amazon-managed (FBA) — excluded from actions"
            emptyState={loading ? <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span> : <span style={{ color: 'var(--text-tertiary)' }}>No listings.</span>}
          />
        </div>

        <div className={styles.gridFooter}>
          <span className="tabular-nums">{children.length} listings · page {page}/{pages}</span>
          <Pagination page={page} pageCount={pages} onPage={setPage} />
        </div>
      </div>
    </div>
  )
}
