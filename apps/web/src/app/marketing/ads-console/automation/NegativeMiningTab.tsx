'use client'

/**
 * Negative-keyword mining — finds search terms burning spend without converting
 * (GET /advertising/reports/negative-keyword-candidates) and lets the operator
 * bulk-negate them (POST /advertising/negative-keywords per term, using the
 * term's external campaign/ad-group ids + marketplace). The manual companion to
 * the auto-negation automations.
 */

import { useEffect, useMemo, useState } from 'react'
import { Ban, RefreshCw, Check, Download, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Input, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'
import { useCampaignMap, campaignHref } from './useCampaignMap'
import { GridSkel } from './_ui'
import { useAmazonLinks, buildAmazonCampaignHref } from './useAmazonLinks'
import { downloadCsv } from './_csv'

interface Cand { query: string; matchType: string; campaignId: string; adGroupId: string; marketplace: string; totalImpressions: number; totalClicks: number; totalCostUnits: number }

/** A factory, not a constant: the campaign cell needs `campMap`/`profileMap`, which are
 *  component state. Alignment inverts between `.az-table` and `.nds-grid`; the three counts
 *  carried no `.l`. The leading checkbox column is gone — `DataGrid` renders selection. */
const negativeColumns = (
  campMap: Record<string, { id: string; name: string; marketplace?: string | null }>,
  profileMap: Record<string, string>,
  done: Set<string>,
): Array<Column<Cand>> => [
  { key: 'term', label: 'Search term', render: (c) => <span style={{ fontWeight: 500 }}>{c.query}</span> },
  { key: 'match', label: 'Match', render: (c) => <span className="az-badge paused">{(c.matchType || '').replace(/_/g, ' ').toLowerCase()}</span> },
  { key: 'campaign', label: 'Campaign · market', render: (c) => {
    const cm = campMap[c.campaignId]
    const amzHref = buildAmazonCampaignHref(c.campaignId, c.marketplace, profileMap)
    return (<>
      <div>{cm ? <a className="cn" href={campaignHref(cm.id)} target="_blank" rel="noopener noreferrer">{cm.name}</a> : <span className="az-cell-sub">{c.campaignId}</span>}</div>
      <div className="az-cell-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{c.marketplace} · AG {c.adGroupId}{amzHref && <a href={amzHref} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--link)', textDecoration: 'none', fontWeight: 600 }}>Amazon <ExternalLink size={9} /></a>}</div>
    </>)
  } },
  { key: 'impressions', label: 'Impressions', align: 'right', render: (c) => num(c.totalImpressions) },
  { key: 'clicks', label: 'Clicks', align: 'right', render: (c) => num(c.totalClicks) },
  { key: 'wasted', label: 'Wasted spend', align: 'right', render: (c) => eur(c.totalCostUnits) },
  { key: 'status', label: 'Status', render: (c) => (done.has(`${c.query}:${c.campaignId}:${c.adGroupId}`)
    ? <span className="az-rowstat ok"><Check size={13} />Negated</span>
    : <span className="az-cell-sub">candidate</span>) },
]
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const eur = (u: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(u)

export function NegativeMiningTab() {
  const [cands, setCands] = useState<Cand[]>([])
  const [minSpend, setMinSpend] = useState('3')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [done, setDone] = useState<Set<string>>(new Set())
  const campMap = useCampaignMap()
  const profileMap = useAmazonLinks()
  const key = (c: Cand) => `${c.query}:${c.campaignId}:${c.adGroupId}`
  const load = () => { setLoading(true); void fetch(`${getBackendUrl()}/api/advertising/reports/negative-keyword-candidates?lookbackDays=30&minSpend=${minSpend || 0}&limit=300`, { cache: 'no-store' }).then((r) => r.json()).then((d) => { setCands(d.candidates ?? []); setSel(new Set()) }).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(load, [minSpend])

  const negateOne = async (c: Cand): Promise<boolean> => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/negative-keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId: c.campaignId, externalAdGroupId: c.adGroupId, keywordText: c.query, matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: c.marketplace }) }).catch(() => null)
    return !!r && r.ok
  }
  const negateSelected = async () => {
    const targets = cands.filter((c) => sel.has(key(c)) && !done.has(key(c)))
    if (!targets.length) return
    setBusy(true)
    try { const ok = new Set(done); for (const c of targets) { if (await negateOne(c)) ok.add(key(c)) } setDone(ok); setSel(new Set()) } finally { setBusy(false) }
  }
  const [mkt, setMkt] = useState('All')
  const markets = useMemo(() => Array.from(new Set(cands.map((c) => c.marketplace).filter(Boolean))) as string[], [cands])
  const shown = useMemo(() => (mkt === 'All' ? cands : cands.filter((c) => c.marketplace === mkt)), [cands, mkt])
  const wasted = useMemo(() => shown.reduce((s, c) => s + c.totalCostUnits, 0), [shown])

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Waste candidates</div><div className="v" style={{ color: shown.length ? '#cc1100' : 'var(--green)' }}>{shown.length}</div><div className="s">spend, no orders (30d)</div></div>
        <div className="az-stat"><div className="k">Wasted spend</div><div className="v">{eur(wasted)}</div><div className="s">recoverable by negating</div></div>
        <div className="az-stat"><div className="k">Negated</div><div className="v" style={{ color: 'var(--green)' }}>{done.size}</div><div className="s">this session</div></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 2px 10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}><Ban size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Negative-keyword mining</span>
        <span className="ctl" style={{ cursor: 'default', gap: 8 }}>Min spend<Input type="number" aria-label="Minimum spend" prefix="€" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} style={{ width: 56 }} /></span>
        <Listbox ariaLabel="Market" width={140} value={mkt} onChange={setMkt} options={[{ value: 'All', label: 'All markets' }, ...markets.map((m) => ({ value: m, label: m }))]} />
        <span style={{ flex: 1 }} />
        {sel.size > 0 && <Button variant="primary" disabled={busy} onClick={() => void negateSelected()}>{busy ? 'Negating…' : `Negate ${sel.size}`}</Button>}
        <ToolbarButton variant="boxed" icon={<Download size={15} />} label="Export CSV" onClick={() => downloadCsv('negative-keyword-candidates.csv', shown.map((c) => ({ query: c.query, matchType: c.matchType, campaign: campMap[c.campaignId]?.name ?? c.campaignId, marketplace: c.marketplace ?? '', adGroupId: c.adGroupId, impressions: c.totalImpressions, clicks: c.totalClicks, wastedSpendEur: c.totalCostUnits, status: done.has(key(c)) ? 'negated' : 'candidate' })))} />
        <ToolbarButton variant="boxed" icon={<RefreshCw size={15} className={loading ? 'az-spin' : ''} />} label="Refresh" onClick={load} />
      </div>
      <DataGrid<Cand>
        rows={loading ? [] : shown}
        rowKey={key}
        columns={negativeColumns(campMap, profileMap, done)}
        selectable
        /* A negated row USED to show a ticked, disabled box. `DataGrid` hard-codes
           `checked={false}` for any row `rowSelectable` rejects (DataGrid.tsx:429), so that tick
           cannot be reproduced — I tried folding `done` into `selected` and it changes nothing.
           The Status column still reads "Negated" with a check, so the state is still stated;
           it is stated once instead of twice. */
        selected={sel}
        onSelectedChange={setSel}
        rowSelectable={(c) => !done.has(key(c))}
        rowSelectableHint="Already negated"
        selectAllHint="Select every candidate not yet negated"
        rowClassName={(c) => (sel.has(key(c)) ? 'sel' : undefined)}
        emptyState={loading ? <GridSkel /> : 'No wasted-spend terms above this threshold. Clean.'}
      />
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}>Negatives are added as NEGATIVE_EXACT at the ad-group level (pending). Automate it with the <b>Negate wasted search terms</b> automation in the Library.</div>
    </div>
  )
}
