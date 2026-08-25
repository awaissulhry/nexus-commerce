'use client'

/**
 * Harvest console — the manual companion to the harvest automation. Live from
 * GET /advertising/harvest/preview: search terms to GRADUATE (converting → new
 * exact keywords) and to NEGATE (wasted spend). One-click apply the whole batch
 * (POST /advertising/harvest/apply), or automate it from the Library.
 */

import { useEffect, useMemo, useState } from 'react'
import { Sprout, Ban, RefreshCw, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'
import { useCampaignMap, campaignHref } from './useCampaignMap'
import { GridSkel } from './_ui'
import { downloadCsv } from './_csv'
import { useAmazonLinks, buildAmazonCampaignHref } from './useAmazonLinks'
import { ExternalLink } from 'lucide-react'

interface Term { query: string; externalCampaignId: string; externalAdGroupId: string; impressions: number; clicks: number; costCents: number; orders: number; salesCents: number }

/** A factory: the campaign cell needs `campMap`/`profileMap` and the orders tint needs `kind`,
 *  all component state. Alignment inverts between `.az-table` and `.nds-grid` — the five
 *  numeric columns carried no `.l`. */
const harvestColumns = (
  campMap: Record<string, { id: string; name: string; marketplace?: string | null }>,
  profileMap: Record<string, string>,
  kind: string,
): Array<Column<Term>> => [
  { key: 'term', label: 'Search term', render: (t) => <span style={{ fontWeight: 500 }}>{t.query}</span> },
  { key: 'campaign', label: 'Campaign · market', render: (t) => {
    const c = campMap[t.externalCampaignId]
    const amzHref = buildAmazonCampaignHref(t.externalCampaignId, c?.marketplace, profileMap)
    return (<>
      {c ? <a className="cn" href={campaignHref(c.id)} target="_blank" rel="noopener noreferrer">{c.name}</a> : <span className="az-cell-sub">{t.externalCampaignId}</span>}
      <div className="az-cell-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {c?.marketplace ? `${c.marketplace} · ` : ''}AG {t.externalAdGroupId}
        {amzHref && <a href={amzHref} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--link)', textDecoration: 'none', fontWeight: 600 }}>Amazon <ExternalLink size={9} /></a>}
      </div>
    </>)
  } },
  { key: 'impressions', label: 'Impressions', align: 'right', render: (t) => num(t.impressions) },
  { key: 'clicks', label: 'Clicks', align: 'right', render: (t) => num(t.clicks) },
  { key: 'spend', label: 'Spend', align: 'right', render: (t) => eur(t.costCents) },
  { key: 'orders', label: 'Orders', align: 'right', render: (t) => <span style={{ color: kind === 'grad' ? 'var(--green)' : undefined }}>{num(t.orders)}</span> },
  { key: 'sales', label: 'Sales', align: 'right', render: (t) => eur(t.salesCents) },
]
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const num = (n: number) => new Intl.NumberFormat('en-US').format(n)

export function HarvestTab() {
  const profileMap = useAmazonLinks()
  const [negatives, setNegatives] = useState<Term[]>([])
  const [graduations, setGraduations] = useState<Term[]>([])
  const [windowDays, setWindowDays] = useState(60)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const campMap = useCampaignMap()
  const load = () => { setLoading(true); void fetch(`${getBackendUrl()}/api/advertising/harvest/preview?windowDays=${windowDays}`, { cache: 'no-store' }).then((r) => r.json()).then((d) => { setNegatives(d.negatives ?? []); setGraduations(d.graduations ?? []) }).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(load, [windowDays])

  const applyAll = async () => {
    if (typeof window !== 'undefined' && !window.confirm(`Apply harvest: promote ${graduations.length} converting term(s) to exact keywords and negate ${negatives.length} wasteful term(s)? (Queued as pending.)`)) return
    setBusy(true); setMsg('')
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/harvest/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowDays }) }).then((x) => x.json()).catch(() => null); setMsg(r ? (r.message ?? `Applied · ${r.promoted ?? r.graduated ?? 0} promoted, ${r.negated ?? 0} negated`) : 'Applied (pending)'); load() } finally { setBusy(false) }
  }
  const wastedTotal = useMemo(() => negatives.reduce((s, t) => s + t.costCents, 0), [negatives])

  const tbl = (terms: Term[], kind: 'grad' | 'neg') => (
    <DataGrid<Term>
        rows={loading ? [] : terms}
        rowKey={(t) => `${t.query}:${t.externalCampaignId}:${t.externalAdGroupId}`}
        columns={harvestColumns(campMap, profileMap, kind)}
        className="az-grid-mb"
        emptyState={loading ? <GridSkel /> : (kind === 'grad' ? 'No converting terms to graduate right now.' : 'No wasteful terms to negate right now.')}
      />
  )

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">To graduate</div><div className="v" style={{ color: 'var(--green)' }}>{graduations.length}</div><div className="s">converting terms → exact keywords</div></div>
        <div className="az-stat"><div className="k">To negate</div><div className="v" style={{ color: '#cc1100' }}>{negatives.length}</div><div className="s">wasteful terms</div></div>
        <div className="az-stat"><div className="k">Wasted spend found</div><div className="v">{eur(wastedTotal)}</div><div className="s">last {windowDays} days</div></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 2px 12px', flexWrap: 'wrap' }}>
        <span className="ctl" style={{ cursor: 'default', gap: 8 }}>Window
          <Listbox ariaLabel="Harvest window" width={120} value={String(windowDays)} onChange={(v) => setWindowDays(Number(v))} options={[14, 30, 60, 90].map((d) => ({ value: String(d), label: `${d} days` }))} />
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="primary" disabled={busy || (negatives.length + graduations.length === 0)} onClick={() => void applyAll()}>{busy ? 'Applying…' : `Apply harvest (${negatives.length + graduations.length})`}</Button>
        {msg && <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{msg}</span>}
        <ToolbarButton variant="boxed" icon={<Download size={15} />} label="Export CSV" onClick={() => downloadCsv(`harvest-${windowDays}d.csv`, [...graduations, ...negatives].map((t, idx) => ({ kind: idx < graduations.length ? 'graduate' : 'negate', query: t.query, campaign: campMap[t.externalCampaignId]?.name ?? t.externalCampaignId, marketplace: campMap[t.externalCampaignId]?.marketplace ?? '', adGroupId: t.externalAdGroupId, impressions: t.impressions, clicks: t.clicks, spendCents: t.costCents, orders: t.orders, salesCents: t.salesCents })))} />
        <ToolbarButton variant="boxed" icon={<RefreshCw size={15} className={loading ? 'az-spin' : ''} />} label="Refresh" onClick={load} />
      </div>
      <h4 style={{ margin: '4px 2px 8px', fontSize: 13.5 }}><Sprout size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5, color: 'var(--green)' }} />Graduate to exact keywords</h4>
      {tbl(graduations, 'grad')}
      <h4 style={{ margin: '4px 2px 8px', fontSize: 13.5 }}><Ban size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5, color: '#cc1100' }} />Negate wasteful terms</h4>
      {tbl(negatives, 'neg')}
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '2px 2px 14px' }}>Want this hands-free? Add the <b>Harvest &amp; negate</b> automation from the Library to run it on a schedule.</div>
    </div>
  )
}
