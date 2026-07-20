'use client'

/**
 * SC.2 — read-only Sync Control client. Dense, simple, truthful:
 * every mode/quantity comes from the SAME derivation core the engine uses.
 * FBA rows render as untouchable ("—") by design — they will stay that way
 * in every future phase.
 */

import { useCallback, useEffect, useState } from 'react'

const API = process.env.NEXT_PUBLIC_API_URL ?? ''

type Mode = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED'

interface Row {
  lane: 'LISTING' | 'SHARED'
  sku: string
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
}

const MODE_STYLE: Record<Mode, string> = {
  FOLLOW: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  PINNED: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  PAUSED: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  PAUSED_POLICY: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  UNCOUNTED: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  FBA: 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500',
  EXCLUDED: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
}

const MODE_LABEL: Record<Mode, string> = {
  FOLLOW: 'Follow',
  PINNED: 'Pinned',
  PAUSED: 'Paused',
  PAUSED_POLICY: 'Paused (policy)',
  UNCOUNTED: 'Uncounted',
  FBA: 'FBA',
  EXCLUDED: 'Excluded',
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pageSize = 50

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/stock/sync-control/overview`, { credentials: 'include' })
      if (!res.ok) throw new Error(`overview ${res.status}`)
      setOverview(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadRows = useCallback(async () => {
    setLoading(true)
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
      setRows(data.rows)
      setTotal(data.total)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [channel, market, mode, q, page])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => { void loadRows() }, [loadRows])

  const s = overview?.summary
  const pages = Math.max(1, Math.ceil(total / pageSize))

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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={inputCls} value={channel} onChange={(e) => { setPage(1); setChannel(e.target.value) }} aria-label="Channel">
          <option value="">All channels</option>
          <option value="AMAZON">Amazon</option>
          <option value="EBAY">eBay</option>
          <option value="SHOPIFY">Shopify</option>
        </select>
        <select className={inputCls} value={market} onChange={(e) => { setPage(1); setMarket(e.target.value) }} aria-label="Market">
          <option value="">All markets</option>
          {['IT', 'DE', 'FR', 'ES', 'DEFAULT'].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select className={inputCls} value={mode} onChange={(e) => { setPage(1); setMode(e.target.value) }} aria-label="Mode">
          <option value="">All modes</option>
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <option key={m} value={m}>{MODE_LABEL[m]}</option>
          ))}
        </select>
        <input
          className={`${inputCls} w-56`}
          placeholder="Search SKU…"
          value={q}
          onChange={(e) => { setPage(1); setQ(e.target.value) }}
        />
        <div className="ml-auto text-sm text-zinc-500 tabular-nums">
          {total} rows · page {page}/{pages}
        </div>
        <button
          className="h-8 rounded-md border border-zinc-300 px-2 text-sm disabled:opacity-40 dark:border-zinc-700"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          ‹
        </button>
        <button
          className="h-8 rounded-md border border-zinc-300 px-2 text-sm disabled:opacity-40 dark:border-zinc-700"
          disabled={page >= pages}
          onClick={() => setPage((p) => p + 1)}
        >
          ›
        </button>
      </div>

      {/* Main table */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Channel</th>
              <th className="px-3 py-2">Market</th>
              <th className="px-3 py-2">Lane</th>
              <th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2 text-right">Intended</th>
              <th className="px-3 py-2 text-right">Live</th>
              <th className="px-3 py-2 text-right">Buffer</th>
              <th className="px-3 py-2">Routed from</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {loading && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-zinc-500">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-zinc-500">No rows match the filters.</td></tr>
            )}
            {!loading && rows.map((r, i) => {
              const fba = r.mode === 'FBA'
              return (
                <tr key={`${r.sku}-${r.channel}-${r.marketplace}-${r.itemId ?? i}`} className="bg-white dark:bg-zinc-950">
                  <td className="px-3 py-1.5 font-mono text-xs">{r.sku}{r.itemId ? <span className="ml-1 text-zinc-400">#{r.itemId}</span> : null}</td>
                  <td className="px-3 py-1.5">{r.channel}</td>
                  <td className="px-3 py-1.5">{r.marketplace}</td>
                  <td className="px-3 py-1.5 text-xs text-zinc-500">{r.lane === 'SHARED' ? 'Shared' : 'Listing'}</td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${MODE_STYLE[r.mode]}`}>
                      {MODE_LABEL[r.mode]}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fba ? '—' : (r.intendedQty ?? '—')}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fba ? '—' : (r.liveQty ?? '—')}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fba ? '—' : r.buffer}</td>
                  <td className="px-3 py-1.5 text-xs text-zinc-500">{fba ? 'Amazon-managed' : r.routedLocations.join(', ') || (r.mode === 'FOLLOW' ? '' : '—')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
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
                    {l.type !== 'WAREHOUSE'
                      ? <span className="text-zinc-400">not a sync source</span>
                      : l.syncRoutes.length
                        ? l.syncRoutes.map((t) => (
                            <span key={t} className="mr-1 inline-block rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">{t}</span>
                          ))
                        : <span className="text-emerald-700 dark:text-emerald-400">routes everywhere (default)</span>}
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
              <div className="px-3 py-4 text-sm text-zinc-500">No policies — every channel-market pushes normally, new listings are born Following.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {overview!.policies.map((p) => (
                    <tr key={`${p.channel}-${p.marketplace}`}>
                      <td className="px-3 py-1.5">{p.channel}:{p.marketplace}</td>
                      <td className="px-3 py-1.5">{p.pushesPaused ? <span className="text-amber-600">pushes PAUSED</span> : 'active'}</td>
                      <td className="px-3 py-1.5 text-xs text-zinc-500">new listings: {p.newListingDefaultMode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="border-b border-zinc-200 px-3 py-2 text-sm font-semibold dark:border-zinc-800">History</div>
            {(overview?.audit?.length ?? 0) === 0 ? (
              <div className="px-3 py-4 text-sm text-zinc-500">No Sync Control changes yet — every mutation will be recorded here (who, what, before → after).</div>
            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {overview!.audit.map((a) => (
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
          </div>
        </div>
      </div>
    </div>
  )
}
