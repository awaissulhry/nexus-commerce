'use client'

/**
 * Campaign Section picker for the schedule builders — "Select the Campaigns and products you
 * want to include". Left: All Campaigns / Portfolios / Products tabs + search + status filter +
 * Add All + pager. Right: "N Campaigns Added" panel. Reuses the shared cp-* styling from the
 * rule-builder CampaignPicker so the two pickers stay visually identical.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Check, Search, Trash2, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { getBackendUrl } from '@/lib/backend-url'

export interface SchedCampaign { id: string; name: string; marketplace: string | null; status: string; targetingType: string; adProduct: string; dailyBudget: number | null; portfolioId: string | null }

const prodShort = (it: { type?: string | null; adProduct?: string | null }): string => {
  const t = (it.type ?? '').toUpperCase()
  if (t === 'SP' || t === 'SB' || t === 'SD') return t
  const a = (it.adProduct ?? '').toUpperCase()
  if (a.includes('BRAND')) return 'SB'
  if (a.includes('DISPLAY')) return 'SD'
  return 'SP'
}
export const toCampaign = (it: Record<string, unknown>): SchedCampaign => ({
  id: String(it.id),
  name: String(it.name ?? ''),
  marketplace: (it.marketplace as string) ?? null,
  status: String(it.status ?? 'ENABLED').toUpperCase(),
  targetingType: /auto/i.test(String(it.name ?? '')) ? 'AUTO' : 'MANUAL',
  adProduct: prodShort(it as { type?: string; adProduct?: string }),
  dailyBudget: it.dailyBudget != null ? Number(it.dailyBudget) : null,
  portfolioId: it.portfolioId != null ? String(it.portfolioId) : null,
})

const badges = (c: SchedCampaign) => (<>
  <span className={`cp-badge ${c.targetingType === 'AUTO' ? 'auto' : 'manual'}`} title={c.targetingType === 'AUTO' ? 'Auto' : 'Manual'}>{c.targetingType === 'AUTO' ? 'A' : 'M'}</span>
  <span className="cp-badge prod" title={c.adProduct}>{c.adProduct}</span>
</>)
const statusText = (s: string) => (s === 'ENABLED' ? 'Enabled' : s === 'PAUSED' ? 'Paused' : 'Archived')

const TABS = ['All Campaigns', 'Portfolios', 'Products']

export function CampaignSection({ selected, onAdd, onAddMany, onRemove, onClear }: {
  selected: SchedCampaign[]
  onAdd: (c: SchedCampaign) => void
  onAddMany: (cs: SchedCampaign[]) => void
  onRemove: (id: string) => void
  onClear: () => void
}) {
  const [tab, setTab] = useState('All Campaigns')
  const [all, setAll] = useState<SchedCampaign[]>([])
  const [portfolios, setPortfolios] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | 'enabled' | 'paused'>('all')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(50)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [cj, pj] = await Promise.all([
          fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`).then((r) => r.json()).catch(() => ({ items: [] })),
          fetch(`${getBackendUrl()}/api/advertising/portfolios`).then((r) => r.json()).catch(() => ({ items: [] })),
        ])
        if (!alive) return
        const items = (Array.isArray(cj?.items) ? cj.items : Array.isArray(cj) ? cj : []) as Array<Record<string, unknown>>
        setAll(items.map(toCampaign))
        // /api/advertising/portfolios returns { portfolios: [{ portfolioId, name }] } — the id key is
        // portfolioId (the Amazon external id, matching Campaign.portfolioId), not `id`. Reading pj.items
        // silently yielded [] → names never resolved and the tab showed raw numeric ids.
        const praw = (pj.portfolios ?? pj.items ?? (Array.isArray(pj) ? pj : [])) as Array<{ portfolioId?: string | number; id?: string | number; name?: string }>
        setPortfolios((Array.isArray(praw) ? praw : []).map((x) => { const pid = String(x.portfolioId ?? x.id ?? ''); return { id: pid, name: String(x.name ?? pid) } }))
      } catch { /* fail soft */ }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const selIds = useMemo(() => new Set(selected.map((c) => c.id)), [selected])
  const ql = q.trim().toLowerCase()
  const filtered = useMemo(() => all.filter((c) => {
    if (status === 'enabled' && c.status !== 'ENABLED') return false
    if (status === 'paused' && c.status !== 'PAUSED') return false
    if (status === 'all' && c.status === 'ARCHIVED') return false
    if (ql && !c.name.toLowerCase().includes(ql)) return false
    return true
  }), [all, status, ql])

  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const pg = Math.min(page, pages)
  const pageItems = filtered.slice((pg - 1) * perPage, pg * perPage)
  const addable = filtered.filter((c) => !selIds.has(c.id))
  // Portfolios tab groups the same campaigns under their portfolio.
  const portfolioGroups = useMemo(() => {
    if (tab !== 'Portfolios') return null
    const m = new Map<string, { name: string; items: SchedCampaign[] }>()
    for (const c of filtered) {
      const k = c.portfolioId ?? '__none'
      const name = c.portfolioId ? (portfolios.find((p) => p.id === c.portfolioId)?.name ?? c.portfolioId) : 'No Portfolio'
      if (!m.has(k)) m.set(k, { name, items: [] })
      m.get(k)!.items.push(c)
    }
    return [...m.values()]
  }, [tab, filtered, portfolios])

  const row = (c: SchedCampaign) => {
    const added = selIds.has(c.id)
    return (
      <div className="cp-row" key={c.id}>
        {badges(c)}
        <span className="cp-name" title={c.name}>{c.name}</span>
        <span className={`cp-status ${c.status === 'ENABLED' ? 'on' : 'off'}`}>{statusText(c.status)}</span>
        <button type="button" className={`cp-add ${added ? 'added' : ''}`} disabled={added} onClick={() => onAdd(c)}>{added ? <><Check size={14} /> Added</> : <><Plus size={14} /> Add</>}</button>
      </div>
    )
  }

  return (
    <div className="h10-rb-camps h10-sb-camps">
      <div className="cp-left">
        <div className="h10-sb-cptabs" role="tablist" aria-label="Campaign source">
          {TABS.map((t) => <button key={t} type="button" role="tab" aria-selected={t === tab} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        <div className="cp-search">
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Search for Campaigns" aria-label="Search for campaigns" />
          <Search size={16} className="ic" />
        </div>
        <div className="cp-statusrow">
          <span className="lbl">Campaign Status:</span>
          {(['all', 'enabled', 'paused'] as const).map((s) => (
            <label key={s} className="rad"><input type="radio" name="schedcpstatus" checked={status === s} onChange={() => { setStatus(s); setPage(1) }} /> {s[0].toUpperCase() + s.slice(1)}</label>
          ))}
          <button type="button" className="cp-addall" disabled={tab === 'Products' || !addable.length} onClick={() => onAddMany(addable)}>Add All</button>
        </div>
        <div className="cp-list">
          {loading ? <div className="cp-msg">Loading campaigns…</div>
            : tab === 'Products' ? <div className="cp-msg">Scope by product is coming soon — use All&nbsp;Campaigns or Portfolios.</div>
            : tab === 'Portfolios' ? (
              portfolioGroups && portfolioGroups.length ? portfolioGroups.map((grp, i) => (
                <div className="cp-grp" key={i}>
                  <div className="cp-grph"><span className="gn" title={grp.name}>{grp.name}</span><button type="button" className="cp-grpadd" disabled={!grp.items.filter((c) => !selIds.has(c.id)).length} onClick={() => onAddMany(grp.items.filter((c) => !selIds.has(c.id)))}><Plus size={12} /> Add</button></div>
                  {grp.items.map(row)}
                </div>
              )) : <div className="cp-msg">No campaigns match.</div>
            )
            : pageItems.length === 0 ? <div className="cp-msg">No campaigns match.</div>
            : pageItems.map(row)}
        </div>
        {tab === 'All Campaigns' && (
        <div className="cp-pager">
          <button type="button" className="pg" disabled={pg <= 1} onClick={() => setPage(pg - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
          <span className="pgn">{pg}</span>
          <button type="button" className="pg" disabled={pg >= pages} onClick={() => setPage(pg + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
          <span className="pp">Rows per page: <H10Select width={72} options={[{ value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }]} value={String(perPage)} onChange={(v) => { setPerPage(Number(v)); setPage(1) }} ariaLabel="Rows per page" /></span>
        </div>
        )}
      </div>
      <div className="cp-right">
        <div className="cp-rhead">
          <b>{selected.length} Campaign{selected.length === 1 ? '' : 's'} Added</b>
          <button type="button" className="cp-removeall" disabled={!selected.length} onClick={onClear}><Trash2 size={14} /> Remove All</button>
        </div>
        <div className="cp-colhdr">Campaign</div>
        {selected.length === 0 ? (
          <div className="cp-empty"><span className="cp-illus"><Search size={26} /></span>No Campaigns Added</div>
        ) : (
          <div className="cp-alist">
            {selected.map((c) => (
              <div className="cp-arow" key={c.id}>
                {badges(c)}
                <span className="cp-name" title={c.name}>{c.name}</span>
                <span className={`cp-status ${c.status === 'ENABLED' ? 'on' : 'off'}`}>{statusText(c.status)}</span>
                <button type="button" className="cp-rm" onClick={() => onRemove(c.id)} aria-label={`Remove ${c.name}`}><X size={15} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
