'use client'

/**
 * Trading Desk — native campaign cockpit (drill-down in-hub).
 * Header + KPIs from GET /advertising/campaigns/:id, then tabs:
 *  - Placements: ToS/PDP/RoS metrics + inline-editable multiplier (P2.3),
 *    PATCH /advertising/campaigns/:id/placements (gated write path).
 *  - Targets: keywords/targets across ad groups (read).
 *  - Ad groups: per-ad-group metrics (read).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowUpRight, Target as TargetIcon } from 'lucide-react'
import { marketplaceCode } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'

interface AdTarget { id: string; kind: string; expressionType: string; expressionValue: string; bidCents: number; status: string; impressions: number; clicks: number; spendCents: number; salesCents: number; ordersCount: number; isNegative: boolean }
interface AdGroup { id: string; externalAdGroupId?: string | null; name: string; status: string; defaultBidCents?: number | null; impressions: number; clicks: number; spendCents: number; salesCents: number; ordersCount: number; acos: number | null; roas: number | null; targets: AdTarget[] }
interface STItem { query: string; matchType: string | null; campaignId: string; adGroupId: string; marketplace: string; impressions: number; clicks: number; costUnits: number; salesCents: number; orders: number; acos: number | null; isCandidate?: boolean }
export interface CockpitCampaign { id: string; name: string; type: string; status: string; marketplace: string | null; externalCampaignId: string | null; spend: number; sales: number; acos: number | null; roas: number | null; trueProfitCents: number; impressions: number; clicks: number; dailyBudget?: string; biddingStrategy?: string; adGroups: AdGroup[]; dataThrough?: string | null }
interface Placement { placement: string; impressions: number; clicks: number; costMicros: string; sales7dCents: number; orders7d: number; adjustmentPct: number }

const OLD = '/marketing/advertising/campaigns'
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pctFrac = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const acosClsFrac = (v: number | null | undefined) => (v == null ? '' : v <= 0.2 ? 'acos-good' : v <= 0.35 ? 'acos-mid' : 'acos-bad')
const matchCls = (t: string) => { const u = t.toUpperCase(); return u === 'EXACT' ? 'mt-exact' : u === 'PHRASE' ? 'mt-phrase' : u === 'BROAD' ? 'mt-broad' : 'mt-auto' }
const placeLabel = (k: string) => { const l = k.toLowerCase(); if (l.includes('top')) return 'Top of Search'; if (l.includes('product') || l.includes('detail')) return 'Product pages'; if (l.includes('rest')) return 'Rest of search'; if (l.includes('home')) return 'Home'; return k }

export function CampaignCockpit({ campaign }: { campaign: CockpitCampaign }) {
  const [c, setC] = useState<CockpitCampaign>(campaign)
  const [tab, setTab] = useState<'placements' | 'targets' | 'searchterms' | 'adgroups'>('placements')
  const [searchTerms, setSearchTerms] = useState<STItem[] | null>(null)
  const [stBusy, setStBusy] = useState<string | null>(null)
  const [stDone, setStDone] = useState<Record<string, string>>({})
  const [placements, setPlacements] = useState<Placement[] | null>(null)
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [bidEdit, setBidEdit] = useState<Record<string, string>>({})
  const [bidBusy, setBidBusy] = useState<string | null>(null)

  const refetchCampaign = useCallback(async () => {
    const d = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (d?.campaign) setC(d.campaign as CockpitCampaign)
  }, [campaign.id])
  const saveBid = async (t: AdTarget) => {
    const v = bidEdit[t.id]; if (v == null) return
    const n = parseFloat(v); if (!Number.isFinite(n) || n < 0) { setBidEdit((s) => { const x = { ...s }; delete x[t.id]; return x }); return }
    setBidBusy(t.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [{ adTargetId: t.id, bidCents: Math.round(n * 100) }] }) })
      setBidEdit((s) => { const x = { ...s }; delete x[t.id]; return x })
      await refetchCampaign()
    } finally { setBidBusy(null) }
  }

  const agByExt = useMemo(() => { const m = new Map<string, { id: string; defaultBidCents?: number | null }>(); for (const g of c.adGroups) if (g.externalAdGroupId) m.set(g.externalAdGroupId, { id: g.id, defaultBidCents: g.defaultBidCents }); return m }, [c.adGroups])
  const loadSearchTerms = useCallback(async () => {
    if (!campaign.externalCampaignId) { setSearchTerms([]); return }
    const d = await fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?campaignId=${encodeURIComponent(campaign.externalCampaignId)}&lookbackDays=30&limit=300&sortBy=spend`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] }))
    setSearchTerms((d.items ?? []) as STItem[])
  }, [campaign.externalCampaignId])
  const graduate = async (r: STItem, mt: 'EXACT' | 'PHRASE') => {
    const local = agByExt.get(r.adGroupId)
    if (!local) { setStDone((s) => ({ ...s, [r.query]: 'ad group not tracked' })); return }
    setStBusy(r.query)
    try {
      const bidEur = local.defaultBidCents != null ? local.defaultBidCents / 100 : 0.5
      const res = await fetch(`${getBackendUrl()}/api/advertising/keywords/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId: local.id, keywordText: r.query, matchType: mt, bidEur }) }).then((x) => x.json()).catch(() => null)
      setStDone((s) => ({ ...s, [r.query]: res && !res.error ? `→ ${mt.toLowerCase()}` : 'failed' }))
    } finally { setStBusy(null) }
  }
  const negate = async (r: STItem) => {
    setStBusy(r.query)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/negative-keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId: r.campaignId, externalAdGroupId: r.adGroupId, keywordText: r.query, matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: r.marketplace }) }).then((x) => x.json()).catch(() => null)
      setStDone((s) => ({ ...s, [r.query]: res && !res.error ? 'negated' : 'failed' }))
    } finally { setStBusy(null) }
  }

  const loadPlacements = useCallback(async () => {
    const d = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}/placements`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ placements: [] }))
    setPlacements((d.placements ?? []) as Placement[])
  }, [c.id])
  useEffect(() => { if (tab === 'placements' && placements === null) void loadPlacements() }, [tab, placements, loadPlacements])
  useEffect(() => { if (tab === 'searchterms' && searchTerms === null) void loadSearchTerms() }, [tab, searchTerms, loadSearchTerms])

  const spendC = Math.round(c.spend * 100), salesC = Math.round(c.sales * 100)
  const targets = useMemo(() => c.adGroups.flatMap((g) => g.targets.filter((t) => !t.isNegative)), [c.adGroups])

  const savePlacement = async (key: string) => {
    const v = edit[key]; if (v == null || !placements) return
    const pct = parseInt(v, 10); if (!Number.isFinite(pct)) { setEdit((s) => { const n = { ...s }; delete n[key]; return n }); return }
    setBusy(true)
    try {
      const adjustments = placements.map((p) => ({ placement: p.placement, percentage: p.placement === key ? Math.max(0, Math.min(900, pct)) : p.adjustmentPct }))
      await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}/placements`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adjustments }) })
      setEdit((s) => { const n = { ...s }; delete n[key]; return n })
      await loadPlacements()
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="top">
        <div><h1 style={{ maxWidth: 560, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</h1><div className="sub">{c.type} · {marketplaceCode(c.marketplace)} · {c.status}{c.dataThrough ? ` · data through ${c.dataThrough}` : ''}</div></div>
        <span className="spacer" />
        <a className="ctl" href={`${OLD}/${c.id}`} target="_blank" rel="noopener noreferrer" title="Open the full classic detail in a new tab">Classic detail <ArrowUpRight size={13} /></a>
      </div>

      <div className="scroll">
        <div className="ckhdr">
          <Link className="backlink" href="/marketing/trading-desk/campaigns"><ArrowLeft size={14} /> Campaigns</Link>
          <span className={c.status === 'ENABLED' ? 'pill g' : 'pill n'}>{c.status === 'ENABLED' ? 'Enabled' : c.status}</span>
          <span className="cc az"><span className="dot" style={{ background: 'var(--az)' }} />{c.type}</span>
          <span className="pill b">{marketplaceCode(c.marketplace)}</span>
        </div>

        <div className="grid5" style={{ marginBottom: 16 }}>
          <div className="card kpi"><div className="lbl">Spend</div><div className="val" style={{ fontSize: 20 }}>{eur(spendC)}</div></div>
          <div className="card kpi"><div className="lbl">Sales</div><div className="val" style={{ fontSize: 20 }}>{eur(salesC)}</div></div>
          <div className="card kpi"><div className="lbl">ACOS</div><div className="val" style={{ fontSize: 20 }}>{pctFrac(c.acos)}</div></div>
          <div className="card kpi"><div className="lbl">ROAS</div><div className="val" style={{ fontSize: 20 }}>{c.roas != null ? `${c.roas.toFixed(2)}×` : '—'}</div></div>
          <div className="card kpi hero"><div className="lbl">True profit</div><div className="val" style={{ fontSize: 20 }}>{eur(c.trueProfitCents)}</div></div>
        </div>

        <div className="cocktabs">
          <button className={tab === 'placements' ? 'on' : ''} onClick={() => setTab('placements')}>Placements</button>
          <button className={tab === 'targets' ? 'on' : ''} onClick={() => setTab('targets')}>Targets ({targets.length})</button>
          <button className={tab === 'searchterms' ? 'on' : ''} onClick={() => setTab('searchterms')}>Search terms</button>
          <button className={tab === 'adgroups' ? 'on' : ''} onClick={() => setTab('adgroups')}>Ad groups ({c.adGroups.length})</button>
        </div>

        {tab === 'placements' && (
          <div>
            {placements === null && <div className="card"><div className="empty">Loading placements…</div></div>}
            {placements && placements.length === 0 && <div className="card"><div className="empty">No placement data for this campaign yet.</div></div>}
            {placements && placements.length > 0 && (
              <div className="placegrid">
                {placements.map((p) => {
                  const editing = edit[p.placement] != null
                  const spendCp = Math.round(Number(p.costMicros) / 10000)
                  const acos = p.sales7dCents > 0 ? spendCp / p.sales7dCents : null
                  return (
                    <div className="placecard" key={p.placement}>
                      <div className="pn"><TargetIcon size={14} />{placeLabel(p.placement)}</div>
                      <div className="pv">{editing
                        ? <>+<input autoFocus type="number" value={edit[p.placement]} onChange={(e) => setEdit((s) => ({ ...s, [p.placement]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') void savePlacement(p.placement); if (e.key === 'Escape') setEdit((s) => { const n = { ...s }; delete n[p.placement]; return n }) }} onBlur={() => void savePlacement(p.placement)} disabled={busy} />%</>
                        : <>{p.adjustmentPct > 0 ? `+${p.adjustmentPct}%` : `${p.adjustmentPct}%`}</>}</div>
                      {!editing && <button className="ed" onClick={() => setEdit((s) => ({ ...s, [p.placement]: String(p.adjustmentPct) }))}>Edit multiplier</button>}
                      <div className="pr">{eur(spendCp)} spend · {num(p.clicks)} clicks · {acos != null ? `ACOS ${(acos * 100).toFixed(1)}%` : 'no sales'}</div>
                    </div>
                  )
                })}
              </div>
            )}
            <p className="note" style={{ marginTop: 10 }}>Edit a multiplier inline — saved through the gated write path (sandbox = DB-only + audit). Amazon hides these behind clicks.</p>
          </div>
        )}

        {tab === 'targets' && (
          <div className="card"><div className="tablewrap"><table>
            <thead><tr><th className="l">Keyword / target</th><th>Match</th><th>Bid</th><th>Impr.</th><th>Clicks</th><th>Spend</th><th>Orders</th><th>ACOS</th><th>Status</th></tr></thead>
            <tbody>
              {targets.length === 0 && <tr><td colSpan={9} className="empty">No targets on this campaign.</td></tr>}
              {targets.map((t) => { const acos = t.salesCents > 0 ? t.spendCents / t.salesCents : null; return (
                <tr key={t.id}>
                  <td className="l">{t.expressionValue}</td>
                  <td><span className={`matchbadge ${matchCls(t.expressionType)}`}>{t.expressionType}</span></td>
                  <td className="num">{bidEdit[t.id] != null
                    ? <input autoFocus className="bedit" type="number" step="0.01" value={bidEdit[t.id]} onChange={(e) => setBidEdit((s) => ({ ...s, [t.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') void saveBid(t); if (e.key === 'Escape') setBidEdit((s) => { const x = { ...s }; delete x[t.id]; return x }) }} onBlur={() => void saveBid(t)} disabled={bidBusy === t.id} />
                    : <button className="budget-btn" onClick={() => setBidEdit((s) => ({ ...s, [t.id]: (t.bidCents / 100).toFixed(2) }))} title="Edit bid">{eur(t.bidCents)}</button>}</td>
                  <td className="num">{num(t.impressions)}</td><td className="num">{num(t.clicks)}</td>
                  <td className="num">{eur(t.spendCents)}</td><td className="num">{num(t.ordersCount)}</td>
                  <td><span className={acosClsFrac(acos)}>{pctFrac(acos)}</span></td>
                  <td>{t.status === 'ENABLED' ? <span className="pill g">On</span> : <span className="pill n">{t.status}</span>}</td>
                </tr>
              ) })}
            </tbody>
          </table></div></div>
        )}

        {tab === 'searchterms' && (
          <div className="card"><div className="tablewrap"><table>
            <thead><tr><th className="l">Search term</th><th>Match</th><th>Impr.</th><th>Clicks</th><th>Spend</th><th>Orders</th><th>ACOS</th><th className="l">Harvest</th></tr></thead>
            <tbody>
              {searchTerms === null && <tr><td colSpan={8} className="empty">Loading…</td></tr>}
              {searchTerms && searchTerms.length === 0 && <tr><td colSpan={8} className="empty">No search-term data for this campaign in the last 30 days.</td></tr>}
              {searchTerms?.map((r) => {
                const done = stDone[r.query]
                return (
                  <tr key={`${r.query}-${r.adGroupId}`} style={r.isCandidate ? { background: 'var(--red-soft)' } : undefined}>
                    <td className="l">{r.query}{r.isCandidate && <span className="pill r" style={{ marginLeft: 6 }}>wasteful</span>}</td>
                    <td>{r.matchType ? <span className={`matchbadge ${matchCls(r.matchType)}`}>{r.matchType}</span> : <span className="sub">—</span>}</td>
                    <td className="num">{num(r.impressions)}</td>
                    <td className="num">{num(r.clicks)}</td>
                    <td className="num">{eur(Math.round(r.costUnits * 100))}</td>
                    <td className="num">{num(r.orders)}</td>
                    <td><span className={acosClsFrac(r.acos != null ? r.acos / 100 : null)}>{r.acos != null ? `${r.acos.toFixed(1)}%` : '—'}</span></td>
                    <td className="l">{done
                      ? <span className="pill g">{done}</span>
                      : <div style={{ display: 'flex', gap: 6 }}>
                          <button className="iact" disabled={stBusy === r.query} onClick={() => void graduate(r, 'EXACT')} title="Add as exact-match keyword">→ Exact</button>
                          <button className="iact" disabled={stBusy === r.query} onClick={() => void graduate(r, 'PHRASE')} title="Add as phrase-match keyword">→ Phrase</button>
                          <button className="iact" disabled={stBusy === r.query} onClick={() => void negate(r)} title="Add as negative-exact">Negate</button>
                        </div>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
          <div className="legend" style={{ padding: '12px 14px' }}><span><b>Harvest:</b> graduate converting terms to a managed Exact/Phrase keyword, or negate wasteful ones (≥€2 spend, 0 orders → flagged). Writes route through the gated path.</span></div>
          </div>
        )}

        {tab === 'adgroups' && (
          <div className="card"><div className="tablewrap"><table>
            <thead><tr><th className="l">Ad group</th><th>Status</th><th>Default bid</th><th>Impr.</th><th>Clicks</th><th>Spend</th><th>Sales</th><th>ACOS</th></tr></thead>
            <tbody>
              {c.adGroups.length === 0 && <tr><td colSpan={8} className="empty">No ad groups.</td></tr>}
              {c.adGroups.map((g) => (
                <tr key={g.id}>
                  <td className="l">{g.name}</td>
                  <td>{g.status === 'ENABLED' ? <span className="pill g">On</span> : <span className="pill n">{g.status}</span>}</td>
                  <td className="num">{g.defaultBidCents != null ? eur(g.defaultBidCents) : '—'}</td>
                  <td className="num">{num(g.impressions)}</td><td className="num">{num(g.clicks)}</td>
                  <td className="num">{eur(g.spendCents)}</td><td className="num">{eur(g.salesCents)}</td>
                  <td><span className={acosClsFrac(g.acos)}>{pctFrac(g.acos)}</span></td>
                </tr>
              ))}
            </tbody>
          </table></div></div>
        )}
      </div>
    </>
  )
}
