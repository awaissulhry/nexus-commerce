'use client'

/**
 * Competitive — Share of Voice. Live from GET /share-of-voice: per search query,
 * your impression share, spend efficiency, how many of your own campaigns chase
 * it (cannibalisation), and relevance flags. The intelligence layer that tells
 * automation where to push, pull back, or consolidate.
 */

import { useEffect, useMemo, useState } from 'react'
import { Swords, RefreshCw, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Checkbox, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { TabControls, DEFAULT_RANGE, rangeQuery, type RangeValue } from './TabControls'
import { GridSkel } from './_ui'
import { downloadCsv } from './_csv'

interface SovRow { query: string; impressions: number; clicks: number; costCents: number; orders: number; ctr: number; cvr: number; cpcCents: number; sovPct: number; campaignCount: number; topCampaignSharePct: number; cannibalized: boolean; flag?: string }
interface SovResp { windowDays: number; totalImpressions: number; queries: number; rows: SovRow[] }

/** Alignment inverts between `.az-table` and `.nds-grid` — the eight columns that carried no
 *  `.l` are the right-aligned ones. `.num`'s tabular figures come from the `td.r` rule in
 *  amazon.css, not from a per-cell class. */
const SOV_COLUMNS: Array<Column<SovRow>> = [
  { key: 'query', label: 'Search query', render: (r) => <span style={{ fontWeight: 500 }}>{r.query}</span> },
  { key: 'sov', label: 'SoV', align: 'right', render: (r) => <span style={{ fontWeight: 700 }}>{pct(r.sovPct)}</span> },
  { key: 'impressions', label: 'Impressions', align: 'right', render: (r) => num(r.impressions) },
  { key: 'clicks', label: 'Clicks', align: 'right', render: (r) => num(r.clicks) },
  { key: 'ctr', label: 'CTR', align: 'right', render: (r) => pct(r.ctr, 2) },
  { key: 'cvr', label: 'CVR', align: 'right', render: (r) => pct(r.cvr, 1) },
  { key: 'cpc', label: 'CPC', align: 'right', render: (r) => eur(r.cpcCents) },
  { key: 'orders', label: 'Orders', align: 'right', render: (r) => num(r.orders) },
  { key: 'campaigns', label: 'Campaigns', align: 'right', render: (r) => <span style={r.cannibalized ? { color: '#cc1100', fontWeight: 700 } : undefined}>{r.campaignCount}</span> },
  { key: 'flags', label: 'Flags', render: (r) => (<>
      {r.cannibalized && <span className="az-badge warn" style={{ marginRight: 4 }}>cannibalised</span>}
      {r.flag && <span className="az-badge paused">{flagLabel[r.flag] ?? r.flag}</span>}
    </>) },
]
const pct = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const flagLabel: Record<string, string> = { 'weak-relevance': 'Weak relevance', 'high-sov': 'Dominating', 'low-sov': 'Low share', 'efficient': 'Efficient' }

export function SovTab() {
  const [d, setD] = useState<SovResp | null>(null)
  const [onlyFlags, setOnlyFlags] = useState(false)
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE)
  const load = () => void fetch(`${getBackendUrl()}/api/advertising/share-of-voice?${rangeQuery(range)}&limit=200`, { cache: 'no-store' }).then((r) => r.json()).then(setD).catch(() => {})
  useEffect(() => { load() }, [range]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (d?.rows ?? []).filter((r) => !onlyFlags || r.cannibalized || r.flag), [d, onlyFlags])
  const cannibalized = (d?.rows ?? []).filter((r) => r.cannibalized).length

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Search queries</div><div className="v">{d ? num(d.queries) : '…'}</div><div className="s">last {d?.windowDays ?? 30} days</div></div>
        <div className="az-stat"><div className="k">Total impressions</div><div className="v">{d ? num(d.totalImpressions) : '…'}</div><div className="s">across tracked queries</div></div>
        <div className="az-stat"><div className="k">Cannibalised</div><div className="v" style={{ color: cannibalized ? '#cc1100' : 'var(--green)' }}>{cannibalized}</div><div className="s">queries with overlapping campaigns</div></div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px 10px' }}>
        <span style={{ fontWeight: 700 }}><Swords size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Share of voice by query</span>
        <Checkbox checked={onlyFlags} onChange={(e) => setOnlyFlags(e.target.checked)} label="Flagged only" />
        <span style={{ flex: 1 }} />
        <TabControls value={range} onChange={setRange} />
        <ToolbarButton variant="boxed" icon={<Download size={15} />} label="Export CSV" onClick={() => downloadCsv('share-of-voice.csv', rows.map((r) => ({ query: r.query, sovPct: r.sovPct, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, cvr: r.cvr, cpcCents: r.cpcCents, orders: r.orders, campaigns: r.campaignCount, flag: r.flag ?? '' })))} />
        <ToolbarButton variant="boxed" icon={<RefreshCw size={15} />} label="Refresh" onClick={load} />
      </div>
      <DataGrid<SovRow>
        rows={d ? rows : []}
        rowKey={(r) => r.query}
        columns={SOV_COLUMNS}
        emptyState={d ? 'No queries match.' : <GridSkel />}
      />
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}>Cannibalised queries (multiple of your campaigns bidding against each other) waste spend — consolidate them, then let harvesting + negation keep them clean.</div>
    </div>
  )
}
