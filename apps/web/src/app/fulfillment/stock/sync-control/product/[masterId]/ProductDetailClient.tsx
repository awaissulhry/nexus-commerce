'use client'

/**
 * SCV.2b — per-product control surface. One master's full variant→listing
 * tree with per-listing selection + the same guarded actions as the main
 * page (server-side FBA exclusion, audit, recascade). Live via usePolledList.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { DataGrid, Pagination, type Column } from '@/design-system/components'
import { Listbox, MultiSelect } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import { Button, Input, Pill, SegmentedControl } from '@/design-system/primitives'
import { Thumbnail, DensityContext } from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { ExternalLink } from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'
import SyncExcelBar from '../../SyncExcelBar'
import {
  DENSITY_OPTIONS, MODE_TONE, MODE_LABEL, MODE_HELP, COLUMN_HELP, ACTION_HELP, CONTROL_HELP, PAGE_SIZES,
  type Density, type Mode, type Row, type ProductMaster,
} from '../../sync-control-shared'
import { Tip, TipText } from '../../SyncTip'
import styles from '../../styles.module.css'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

const API = getBackendUrl()

const BULK_ACTIONS: Array<[string, string]> = [
  ['FOLLOW', 'Set Follow'], ['PIN', 'Pin'], ['PAUSE', 'Pause'], ['RESUME', 'Resume'],
  ['ZERO_PIN', 'Zero & Pin'], ['CLOSE_OFFER', 'Close offer'], ['REOPEN_OFFER', 'Reopen offer'], ['EXCLUDE', 'Exclude'], ['INCLUDE', 'Include'],
]

/** SCD.6 — multi-select filter. Several channels/markets/modes at once so a
 *  change can be made across exactly the slice the operator wants. */
function FilterMulti({ label, values, onChange, options, placeholder, help }: { label: string; values: string[]; onChange: (v: string[]) => void; options: Array<{ value: string; label: string }>; placeholder: string; help?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <TipText help={help ?? ''}><span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span></TipText>
      <Tip help={help ?? ''} width={160}>
        <MultiSelect options={options} value={values} onChange={onChange} placeholder={placeholder} />
      </Tip>
    </label>
  )
}

const familyKeyOfRow = (r: Row): string => (r.itemId ? `${r.channel}:${r.marketplace}:${r.itemId}` : `${r.channel}:${r.marketplace}`)

const rowKey = (r: Row) => `${r.lane}|${r.channel}|${r.marketplace}|${r.sku}|${r.itemId ?? ''}`

export default function ProductDetailClient({ masterId }: { masterId: string }) {
  // SCD.4 — this page is usually opened standalone in a new tab, so it needs
  // its own SSE→invalidation bridge to stay live.
  useListingEvents()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bufferVal, setBufferVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [density, setDensity] = useState<Density>('cozy')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const confirm = useConfirm()

  // SCD.3 — ?family=<key> narrows this page to ONE parent listing, so every
  // action here touches only that family's child SKUs.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  // SCD.7 — filter state is LOCAL and authoritative; the URL is written from it.
  // Deriving the values straight from searchParams raced: router.replace is
  // async, so two quick clicks in a multi-select both read the pre-update URL
  // and the second overwrote the first (selecting FBA then Uncounted kept only
  // Uncounted). Local state compounds correctly and still round-trips to the URL.
  const csvOf = (v: string | null): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const [filters, setFilters] = useState(() => ({
    channel: csvOf(searchParams.get('channel')),
    market: csvOf(searchParams.get('market')),
    mode: csvOf(searchParams.get('mode')),
    lane: csvOf(searchParams.get('lane')),
    family: csvOf(searchParams.get('family')),
    drift: searchParams.get('drift') === '1',
  }))
  const fChannels = filters.channel
  const fMarkets = filters.market
  const fModes = filters.mode
  const fLanes = filters.lane
  const fFamilies = filters.family
  const fDrift = filters.drift
  const familyKey = fFamilies.length === 1 ? fFamilies[0] : null
  const url = useMemo(
    () => `/api/stock/sync-control/products?masterId=${encodeURIComponent(masterId)}${familyKey ? `&family=${encodeURIComponent(familyKey)}` : ''}`,
    [masterId, familyKey],
  )
  const { data, loading } = usePolledList<{ products: ProductMaster[] }>({
    url,
    intervalMs: 30_000,
    invalidationTypes: ['stock.adjusted', 'listing.updated', 'product.updated', 'product.created', 'listing.created', 'product.deleted', 'listing.deleted'],
  })
  const master = data?.products?.[0] ?? null
  const allChildren = useMemo(
    () => [...(master?.children ?? [])].sort((a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace)),
    [master],
  )

  // SCD.5 — filters. Kept in the URL so a filtered view is shareable and
  // survives a refresh (this page is opened in its own tab). `family` is
  // server-side scoping; the rest narrow the loaded rows client-side.
  const [qLive, setQLive] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => { setQ(qLive); setPage(1) }, 250)
    return () => clearTimeout(t)
  }, [qLive])

  // Write-through: update local state first (so rapid clicks compound), then
  // mirror the whole filter set into the URL for shareability.
  const setParam = useCallback((key: string, value: string) => {
    setFilters((prev) => {
      const next = key === 'drift'
        ? { ...prev, drift: value === '1' }
        : { ...prev, [key]: csvOf(value) }
      const p = new URLSearchParams()
      for (const k of ['channel', 'market', 'mode', 'lane', 'family'] as const) {
        const arr = next[k] as string[]
        if (arr.length) p.set(k, arr.join(','))
      }
      if (next.drift) p.set('drift', '1')
      router.replace(`${pathname}${p.toString() ? `?${p}` : ''}`, { scroll: false })
      return next
    })
  }, [router, pathname])

  const clearFilters = useCallback(() => {
    setFilters({ channel: [], market: [], mode: [], lane: [], family: [], drift: false })
    setQLive(''); setQ('')
    router.replace(pathname, { scroll: false })
  }, [router, pathname])

  // Facets derived from the loaded rows, so only real options are offered.
  const facets = useMemo(() => {
    const ch = new Set<string>(); const mk = new Set<string>(); const md = new Set<string>()
    for (const r of allChildren) { ch.add(r.channel); mk.add(r.marketplace); md.add(r.mode) }
    return { channels: [...ch].sort(), markets: [...mk].sort(), modes: [...md].sort() }
  }, [allChildren])

  const children = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return allChildren.filter((r) => {
      if (fChannels.length && !fChannels.includes(r.channel)) return false
      if (fMarkets.length && !fMarkets.includes(r.marketplace)) return false
      if (fModes.length && !fModes.includes(r.mode)) return false
      if (fLanes.length && !fLanes.includes(r.lane)) return false
      // >1 family selected → server returned the whole product; narrow here
      if (fFamilies.length > 1 && !fFamilies.includes(familyKeyOfRow(r))) return false
      if (fDrift && !(r.mode !== 'FBA' && r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty)) return false
      if (needle && !(r.sku.toLowerCase().includes(needle) || (r.itemId ?? '').includes(needle))) return false
      return true
    })
  }, [allChildren, fChannels, fMarkets, fModes, fLanes, fFamilies, fDrift, q])

  const activeFilters = fChannels.length + fMarkets.length + fModes.length + fLanes.length + fFamilies.length + (fDrift ? 1 : 0) + (q ? 1 : 0)

  // SCD.5 — the workbook must match the filtered view exactly.
  const exportQuery = useMemo(() => {
    const p = new URLSearchParams({ masterId })
    if (fFamilies.length) p.set('family', fFamilies.join(','))
    if (fChannels.length) p.set('channel', fChannels.join(','))
    if (fMarkets.length) p.set('market', fMarkets.join(','))
    if (fModes.length) p.set('mode', fModes.join(','))
    if (fLanes.length) p.set('lane', fLanes.join(','))
    if (fDrift) p.set('drift', '1')
    if (q) p.set('q', q)
    return p.toString()
  }, [masterId, familyKey, fFamilies, fChannels, fMarkets, fModes, fLanes, fDrift, q])

  // A hidden row must never be acted on: drop selections that the current
  // filters exclude, and reset paging when the result set changes.
  const visibleKeys = useMemo(() => new Set(children.map(rowKey)), [children])
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => visibleKeys.has(k)))
      return next.size === prev.size ? prev : next
    })
    setPage((p) => (p > Math.max(1, Math.ceil(children.length / pageSize)) ? 1 : p))
  }, [visibleKeys, children.length, pageSize])

  const rowByKey = useMemo(() => new Map(children.map((r) => [rowKey(r), r])), [children])

  const runAction = async (action: string, opts: { buffer?: number } = {}) => {
    const rows = [...selected].map((k) => rowByKey.get(k)).filter((r): r is Row => Boolean(r))
    const listings = rows.filter((r) => r.lane === 'LISTING' && r.mode !== 'FBA' && r.productId)
    const memberships = rows.filter((r) => r.lane === 'SHARED')
    const listingActs = ['FOLLOW', 'PIN', 'PAUSE', 'RESUME', 'ZERO_PIN', 'BUFFER', 'CLOSE_OFFER', 'REOPEN_OFFER']
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
      let d = await res.json()
      if (res.status === 409 && d?.euExpandRequired) {
        // SCT.5b — one honest confirm with the true EU scope, then execute.
        const okEu = await confirm({
          title: 'This covers ALL Amazon EU markets',
          description:
            `${d.error} Example: ${(d.preview ?? []).slice(0, 3).map((p2: { sku: string; addedMarkets: string[] }) => `${p2.sku} → also ${p2.addedMarkets.join('/')}`).join(' · ')}` +
            `${(d.preview ?? []).length > 3 ? ` · +${(d.preview ?? []).length - 3} more` : ''}. Proceed with the full EU scope?`,
          confirmLabel: `${action.replace('_', ' ')} on all EU markets`,
        })
        if (!okEu) { setBusy(false); return }
        const res2 = await fetch(`${API}/api/stock/sync-control/actions`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action, buffer: opts.buffer,
            listings: l.map((r) => ({ productId: r.productId, channel: r.channel, marketplace: r.marketplace })),
            memberships: m.map((r) => ({ itemId: r.itemId, marketplace: r.marketplace, sku: r.sku })),
            expandEuAligned: true,
          }),
        })
        d = await res2.json()
        if (!res2.ok) throw new Error(d?.error ?? d?.message ?? `HTTP ${res2.status}`)
      } else if (!res.ok) {
        throw new Error(d?.error ?? d?.message ?? `HTTP ${res.status}`)
      }
      if (d.error) {
        // Keep the selection — "re-run to continue" must be one click.
        setNotice(`${action} PARTIAL — ${d.error}`)
      } else {
        setNotice(`${action}: updated ${d.updated}, unchanged ${d.unchanged ?? 0}, FBA skipped ${d.skippedFba ?? 0}${d.euExpanded ? `, incl. ${d.euExpanded} sibling EU row(s)` : ''}${d.recascadeQueued ? `, recascading ${d.recascadeQueued} product(s)` : ''}`)
        setSelected(new Set())
      }
      emitInvalidation({ type: 'listing.updated', meta: { source: 'sync-control-product', masterId } })
    } catch (e) {
      setNotice(`${action} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<Array<Column<Row>>>(() => [
    { key: 'sku', label: <TipText help={COLUMN_HELP.variant} cursor="inherit">Variant / SKU</TipText>, sticky: true, width: 280, sortable: true, sortValue: (r) => r.sku,
      render: (r) => <span className="font-mono text-xs">{r.sku}{r.itemId ? <span className="ml-1 text-zinc-400">#{r.itemId}</span> : null}</span> },
    { key: 'channel', label: <TipText help={COLUMN_HELP.channel} cursor="inherit">Channel</TipText>, width: 90, sortable: true, sortValue: (r) => r.channel, render: (r) => r.channel },
    { key: 'market', label: <TipText help={COLUMN_HELP.market} cursor="inherit">Market</TipText>, width: 80, sortable: true, sortValue: (r) => r.marketplace, render: (r) => r.marketplace },
    { key: 'lane', label: <TipText help={COLUMN_HELP.lane}>Lane</TipText>, width: 70, render: (r) => <span className="text-xs text-zinc-500">{r.lane === 'SHARED' ? 'Shared' : 'Listing'}</span> },
    { key: 'mode', label: <Tooltip content={COLUMN_HELP.sync}><span style={{ cursor: 'help' }}>Mode</span></Tooltip>, width: 130, sortable: true, sortValue: (r) => r.mode, render: (r) => <Tooltip content={MODE_HELP[r.mode as Mode] ?? ''}><span className="inline-flex" style={{ cursor: 'help' }}><Pill tone={MODE_TONE[r.mode]}>{MODE_LABEL[r.mode]}</Pill></span></Tooltip> },
    { key: 'intended', label: <Tooltip content={COLUMN_HELP.intended}><span style={{ cursor: 'help' }}>Intended</span></Tooltip>, align: 'right', width: 85, sortable: true, sortValue: (r) => (r.mode === 'FBA' ? -1 : r.intendedQty ?? -1),
      render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.intendedQty ?? '—'}</span> },
    { key: 'live', label: <Tooltip content={COLUMN_HELP.live}><span style={{ cursor: 'help' }}>Live</span></Tooltip>, align: 'right', width: 75, sortable: true, sortValue: (r) => (r.mode === 'FBA' ? -1 : r.liveQty ?? -1),
      render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.liveQty ?? '—'}</span> },
    { key: 'buffer', label: <Tooltip content={COLUMN_HELP.buffer}><span style={{ cursor: 'help' }}>Buffer</span></Tooltip>, align: 'right', width: 70, render: (r) => <span className="tabular-nums">{r.mode === 'FBA' ? '—' : r.buffer}</span> },
    { key: 'drift', label: <TipText help={COLUMN_HELP.drift}>Drift</TipText>, width: 70, render: (r) => (r.mode !== 'FBA' && r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty)
      ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" title="live ≠ intended" /> : null },
  ], [])

  const pages = Math.max(1, Math.ceil(children.length / pageSize))
  const pageRows = children.slice((page - 1) * pageSize, page * pageSize)

  if (!loading && !master) {
    return <div className="p-4"><div className="rounded-md border border-zinc-200 px-3 py-6 text-sm text-zinc-500 dark:border-zinc-800">Product not found or has no synced listings. <Tooltip content="Back to the full Sync Control page."><Link href="/fulfillment/stock/sync-control" className="text-blue-600 hover:underline">Back to Sync Control</Link></Tooltip></div></div>
  }

  return (
    <div className="space-y-4 p-4">
      {/* Master header */}
      {master && (
        <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <DensityContext.Provider value="spacious"><Thumbnail src={master.imageUrl} alt={master.name} hoverPreview={false} /></DensityContext.Provider>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Tooltip content={CONTROL_HELP.productLink}>
                <Link href={`/products/${master.masterId}/edit`} target="_blank" rel="noopener" className="truncate text-base font-semibold text-zinc-900 hover:underline dark:text-zinc-100">{master.name}</Link>
              </Tooltip>
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

      {/* SCD.3 — the parent listings sharing these child SKUs. Open one to
          control ONLY its child SKUs, without touching the other copies. */}
      {master && (master.families?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="text-sm font-semibold">
              {master.families!.length} {master.families!.length === 1 ? 'listing family' : 'listing families'} share these child SKUs
            </span>
            {familyKey && (
              <Tooltip content={CONTROL_HELP.backToFamilies}>
                <Link href={`/fulfillment/stock/sync-control/product/${masterId}`} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
                  ← Show all families
                </Link>
              </Tooltip>
            )}
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {master.families!.map((f) => {
                const active = familyKey === f.key
                return (
                  <tr key={f.key} className={active ? 'bg-blue-50/60 dark:bg-blue-950/30' : undefined}>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs">{f.ownerSku ?? f.channel}</span>
                      {f.itemId && <span className="ml-1 text-xs text-zinc-400">#{f.itemId}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{f.channel} · {f.marketplace}</td>
                    <td className="px-3 py-1.5 text-xs text-zinc-500">{f.skus} SKUs · {f.listings} listings</td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex flex-wrap gap-1">
                        {Object.entries(f.modeCounts).sort((a, b) => b[1] - a[1]).map(([mo, n]) => (
                          <span key={mo} className="inline-flex items-center gap-0.5 text-xs">
                            <TipText help={MODE_HELP[mo as Mode] ?? ''}><Pill tone={MODE_TONE[mo as Mode] ?? 'neutral'}>{MODE_LABEL[mo as Mode] ?? mo}</Pill></TipText>
                            <span className="tabular-nums text-zinc-500">{n}</span>
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {f.driftCount > 0
                        ? <span className="font-medium text-amber-600">● {f.driftCount}</span>
                        : <span className="text-emerald-600">✓</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {active ? (
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">Viewing</span>
                      ) : (
                        <Tooltip content={`${CONTROL_HELP.openFamilyTab} This one is ${f.channel} · ${f.marketplace}, ${f.skus} SKUs.`}>
                        <Link
                          href={`/fulfillment/stock/sync-control/product/${masterId}?family=${encodeURIComponent(f.key)}`}
                          target="_blank"
                          rel="noopener"
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Open this family <ExternalLink size={11} />
                        </Link>
                        </Tooltip>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-800">
            Each family is one parent listing pooling the same child SKUs. Open one to change only its child SKUs — the other copies stay untouched.
          </div>
        </div>
      )}

      {familyKey && (
        <div className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          Scoped to one family — every action below applies to <b>this family&rsquo;s {children.length} listing(s) only</b>.
        </div>
      )}

      {/* SCD.5 — filters for this product's listings (URL-backed, so a filtered
          view can be shared/bookmarked and survives a refresh). */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <FilterMulti label="Channel" help={CONTROL_HELP.filterChannel} values={fChannels} placeholder="All channels" onChange={(v) => setParam('channel', v.join(','))}
          options={facets.channels.map((c) => ({ value: c, label: c }))} />
        <FilterMulti label="Market" help={CONTROL_HELP.filterMarket} values={fMarkets} placeholder="All markets" onChange={(v) => setParam('market', v.join(','))}
          options={facets.markets.map((m) => ({ value: m, label: m }))} />
        <FilterMulti label="Mode" help={CONTROL_HELP.filterMode} values={fModes} placeholder="All modes" onChange={(v) => setParam('mode', v.join(','))}
          options={facets.modes.map((m) => ({ value: m, label: MODE_LABEL[m as Mode] ?? m }))} />
        <FilterMulti label="Lane" help={CONTROL_HELP.filterLane} values={fLanes} placeholder="All lanes" onChange={(v) => setParam('lane', v.join(','))}
          options={[{ value: 'LISTING', label: 'Listing' }, { value: 'SHARED', label: 'Shared' }]} />
        {(master?.families?.length ?? 0) > 1 && (
          <FilterMulti label="Family" help={CONTROL_HELP.filterFamily} values={fFamilies} placeholder="All families" onChange={(v) => setParam('family', v.join(','))}
            options={(master?.families ?? []).map((f) => ({ value: f.key, label: `${f.ownerSku ?? f.channel} · ${f.marketplace}` }))} />
        )}
        <label className="flex flex-col gap-1">
          <TipText help={CONTROL_HELP.searchRows}><span className="text-[11px] uppercase tracking-wide text-zinc-500">Search</span></TipText>
          <Tip help={CONTROL_HELP.searchRows}>
            <Input placeholder="SKU or item id…" value={qLive} onChange={(e) => setQLive(e.target.value)} style={{ width: 190 }} />
          </Tip>
        </label>
        <Tooltip content={CONTROL_HELP.driftOnly}>
          <label className="mb-1 flex items-center gap-1.5 text-sm" style={{ cursor: 'help' }}>
            <input type="checkbox" checked={fDrift} onChange={(e) => setParam('drift', e.target.checked ? '1' : '')} />
            Drift only
          </label>
        </Tooltip>
        <div className="mb-1 ml-auto flex items-center gap-2">
          <span className="text-xs text-zinc-500">
            {children.length === allChildren.length
              ? `${allChildren.length} listings`
              : `${children.length} of ${allChildren.length} listings`}
          </span>
          <Tip help={CONTROL_HELP.clearFilters}>
            <Button size="sm" disabled={activeFilters === 0 && !familyKey} onClick={clearFilters}>
              Clear
            </Button>
          </Tip>
        </div>
      </div>

      {notice && <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">{notice}</div>}

      <div className="h10-ds-gridcard sc-card-pop">
        <GridToolbar
          count={selected.size > 0 ? <>Selected <b>{selected.size}</b> {selected.size === 1 ? 'listing' : 'listings'}</> : <>{children.length} listings</>}
          right={
            <>
              <SyncExcelBar exportQuery={exportQuery} notify={setNotice} onApplied={() => { /* usePolledList refetches on invalidation */ }} />
              <Tip help={CONTROL_HELP.density}>
                <SegmentedControl options={DENSITY_OPTIONS} value={density} onChange={(v) => setDensity(v as Density)} size="sm" />
              </Tip>
              <Tip help={CONTROL_HELP.pageSize} width={110}>
                <Listbox ariaLabel="Rows per page" value={String(pageSize)} onChange={(v) => { setPage(1); setPageSize(Number(v)) }} options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))} />
              </Tip>
            </>
          }
        >
          {selected.size > 0 && (
            <span className={styles.selActions}>
              {BULK_ACTIONS.map(([a, label]) => (
                <Tip key={a} help={familyKey ? `${ACTION_HELP[a]} Scoped to THIS family only.` : ACTION_HELP[a]}>
                  <Button size="sm" disabled={busy} onClick={() => void runAction(a)}>{label}</Button>
                </Tip>
              ))}
              <span className="inline-flex items-center gap-1 text-sm">
                <TipText help={ACTION_HELP.BUFFER}>Buffer</TipText>
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
            selectAllHint={CONTROL_HELP.selectAll}
            rowSelectableHint="Amazon-managed (FBA) — excluded from actions"
            emptyState={loading ? <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span> : <span style={{ color: 'var(--text-tertiary)' }}>No listings.</span>}
          />
        </div>

        <div className={styles.gridFooter}>
          <span className="tabular-nums">{children.length} listings · page {page}/{pages}</span>
          <Tip help={CONTROL_HELP.pagination}><Pagination page={page} pageCount={pages} onPage={setPage} /></Tip>
        </div>
      </div>
    </div>
  )
}
