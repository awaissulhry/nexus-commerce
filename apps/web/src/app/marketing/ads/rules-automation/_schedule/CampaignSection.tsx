'use client'

/**
 * THE campaign selector. One component, every builder — schedules, rank goals, and (since
 * 2026-08-18) every criteria rule builder in `_shared/RuleBuilder.tsx`.
 *
 * "Select the Campaigns and products you want to include". Left: All Campaigns / Portfolios /
 * Products tabs + search + status filter + Add All + pager. Right: "N Campaigns Added".
 *
 * 🔴 **Operator instruction, 2026-08-18: this is the single place to change the picker.** The
 * criteria builders used to carry their own copy — no Portfolios tab, no Products tab, and a
 * substring search where this one ranks matches — so the same control behaved differently
 * depending on which rule you were writing, and any change had to be made twice. That copy is
 * gone. Change this file and every builder changes with it; add a prop rather than a fork.
 *
 * Callers differ in exactly two ways, both props: `defaultStatus` (H10 opens the criteria builders
 * on Enabled and the schedule builders on All) and whether the campaign objects they hold carry
 * extra fields. The type below is a superset: `placements` is optional and only the Placement rule
 * reads it (its preview shows current → proposed multipliers per lane), but it must survive a round
 * trip through this picker or that preview silently reads 0.
 *
 * Styling is the shared `cp-*` block in `rules-automation.css`.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Check, Search, Trash2, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, Input, Radio } from '@/design-system/primitives'

import { searchOptions } from '@/lib/option-search'
import { getBackendUrl } from '@/lib/backend-url'
import { Listbox } from '@/design-system/components'

export interface SchedCampaign {
  id: string
  name: string
  marketplace: string | null
  status: string
  targetingType: string
  adProduct: string
  dailyBudget: number | null
  portfolioId: string | null
  /** Placement rules only — the current per-lane multipliers their preview compares against. */
  placements?: { tos: number | null; pdp: number | null; ros: number | null }
}

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
  placements: (it.placements as SchedCampaign['placements']) ?? undefined,
})

const badges = (c: SchedCampaign) => (<>
  <span className={`cp-badge ${c.targetingType === 'AUTO' ? 'auto' : 'manual'}`} title={c.targetingType === 'AUTO' ? 'Auto' : 'Manual'}>{c.targetingType === 'AUTO' ? 'A' : 'M'}</span>
  <span className="cp-badge prod" title={c.adProduct}>{c.adProduct}</span>
</>)
const statusText = (s: string) => (s === 'ENABLED' ? 'Enabled' : s === 'PAUSED' ? 'Paused' : 'Archived')

const TABS = ['All Campaigns', 'Portfolios', 'Products']

/** A product line and the campaigns it reaches — `/advertising/scope-options`'s own shape. */
interface ProductLine { id: string; sku: string; name: string; variations: number; campaigns: string[] }

export function CampaignSection({ selected, onAdd, onAddMany, onRemove, onClear, defaultStatus = 'all' }: {
  selected: SchedCampaign[]
  onAdd: (c: SchedCampaign) => void
  onAddMany: (cs: SchedCampaign[]) => void
  onRemove: (id: string) => void
  onClear: () => void
  /** H10 opens the criteria builders on Enabled and the schedule builders on All. */
  defaultStatus?: 'all' | 'enabled' | 'paused'
}) {
  const [tab, setTab] = useState('All Campaigns')
  const [all, setAll] = useState<SchedCampaign[]>([])
  const [portfolios, setPortfolios] = useState<Array<{ id: string; name: string }>>([])
  const [lines, setLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | 'enabled' | 'paused'>(defaultStatus)
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(50)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [cj, pj, sj] = await Promise.all([
          fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`).then((r) => r.json()).catch(() => ({ items: [] })),
          fetch(`${getBackendUrl()}/api/advertising/portfolios`).then((r) => r.json()).catch(() => ({ items: [] })),
          // The Products tab's data. `/advertising/scope-options` already carries every product line
          // WITH the campaigns it reaches — the same payload the eleven pages' filter bars read — so
          // the tab needs no new endpoint. A failure here leaves `lines` empty and the tab says so;
          // it must never take the campaign list down with it.
          fetch(`${getBackendUrl()}/api/advertising/scope-options`).then((r) => r.json()).catch(() => ({})),
        ])
        if (!alive) return
        const items = (Array.isArray(cj?.items) ? cj.items : Array.isArray(cj) ? cj : []) as Array<Record<string, unknown>>
        setAll(items.map(toCampaign))
        // /api/advertising/portfolios returns { portfolios: [{ portfolioId, name }] } — the id key is
        // portfolioId (the Amazon external id, matching Campaign.portfolioId), not `id`. Reading pj.items
        // silently yielded [] → names never resolved and the tab showed raw numeric ids.
        const praw = (pj.portfolios ?? pj.items ?? (Array.isArray(pj) ? pj : [])) as Array<{ portfolioId?: string | number; id?: string | number; name?: string }>
        setPortfolios((Array.isArray(praw) ? praw : []).map((x) => { const pid = String(x.portfolioId ?? x.id ?? ''); return { id: pid, name: String(x.name ?? pid) } }))
        const lraw = (sj?.productLines ?? []) as ProductLine[]
        setLines(Array.isArray(lraw) ? lraw.filter((l) => Array.isArray(l.campaigns) && l.campaigns.length) : [])
      } catch { /* fail soft */ }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const selIds = useMemo(() => new Set(selected.map((c) => c.id)), [selected])
  // OS.5 — status filtering first, then the shared ranked matcher. The old test was
  // `c.name.toLowerCase().includes(q)`, which could not find "gale broad" inside
  // "GALE | IT | Broad | Brand"; searchOptions also orders the best matches to the top,
  // which matters here because the list is paginated (a good hit was landing on page 3).
  const filtered = useMemo(() => {
    const byStatus = all.filter((c) => {
      if (status === 'enabled' && c.status !== 'ENABLED') return false
      if (status === 'paused' && c.status !== 'PAUSED') return false
      if (status === 'all' && c.status === 'ARCHIVED') return false
      return true
    })
    return searchOptions(q, byStatus, (c) => c.name)
  }, [all, status, q])

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

  /**
   * The Products tab. Until 2026-08-18 this tab rendered "Scope by product is coming soon" — a
   * dead third of a control the operator was told they had. It is real now, off the product lines
   * `/advertising/scope-options` already returns.
   *
   * The search box filters PRODUCTS here (SKU or title), not campaigns, because that is what the
   * list shows; the status filter still applies to the campaigns underneath, so "Enabled" on a
   * product means "its enabled campaigns". A product whose campaigns are all filtered out drops
   * from the list rather than offering an Add that would add nothing.
   */
  const productGroups = useMemo(() => {
    if (tab !== 'Products') return null
    const byId = new Map(filtered.map((c) => [c.id, c]))
    const hits = searchOptions(q, lines, (l) => `${l.sku} ${l.name}`)
    return hits
      .map((l) => ({ line: l, items: l.campaigns.map((id) => byId.get(id)).filter(Boolean) as SchedCampaign[] }))
      .filter((g) => g.items.length)
  }, [tab, lines, q, filtered])

  /** Every not-yet-added campaign under the products currently listed — what Add All means there. */
  const productAddable = useMemo(() => {
    if (!productGroups) return []
    const seen = new Set<string>()
    const out: SchedCampaign[] = []
    for (const g of productGroups) {
      for (const c of g.items) {
        // One campaign can advertise several products, so dedupe across groups.
        if (selIds.has(c.id) || seen.has(c.id)) continue
        seen.add(c.id); out.push(c)
      }
    }
    return out
  }, [productGroups, selIds])

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
          {/* The Products tab searches PRODUCTS (SKU or title) — the list it filters is products —
              so the box must not keep promising campaigns. H10 changes the same placeholder per
              tab ("Search for Product Title、ASIN or SKU"). */}
          <Input
            fieldClassName="cp-searchfield"
            leadingIcon={<Search size={16} />}
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder={tab === 'Products' ? 'Search for a product title or SKU' : 'Search for Campaigns'}
            aria-label={tab === 'Products' ? 'Search for a product title or SKU' : 'Search for campaigns'}
          />
        </div>
        <div className="cp-statusrow">
          <span className="lbl">Campaign Status:</span>
          {(['all', 'enabled', 'paused'] as const).map((s) => (
            <Radio key={s} className="rad" name="schedcpstatus" checked={status === s} onChange={() => { setStatus(s); setPage(1) }} label={s[0].toUpperCase() + s.slice(1)} />
          ))}
          {/* On Products, "Add All" means every campaign of the products currently listed — the
              campaign-level `addable` would not match what the list is showing. */}
          {tab === 'Products' ? (
            <Button variant="primary" disabled={!productAddable.length} onClick={() => onAddMany(productAddable)}>Add All</Button>
          ) : (
            <Button variant="primary" disabled={!addable.length} onClick={() => onAddMany(addable)}>Add All</Button>
          )}
        </div>
        <div className="cp-list">
          {loading ? <div className="cp-msg">Loading campaigns…</div>
            : tab === 'Products' ? (
              productGroups && productGroups.length ? productGroups.map((grp) => {
                const add = grp.items.filter((c) => !selIds.has(c.id))
                return (
                  <div className="cp-grp" key={grp.line.id}>
                    <div className="cp-grph">
                      <span className="gn" title={`${grp.line.name} · ${grp.line.sku}`}>
                        {grp.line.name || grp.line.sku}
                        <em className="cp-grpsub">{grp.line.sku}{grp.line.variations > 1 ? ` · ${grp.line.variations} variations` : ''} · {grp.items.length} campaign{grp.items.length === 1 ? '' : 's'}</em>
                      </span>
                      <Button variant="ghost" size="sm" disabled={!add.length} onClick={() => onAddMany(add)}><Plus size={12} /> Add</Button>
                    </div>
                    {grp.items.map(row)}
                  </div>
                )
              }) : <div className="cp-msg">{lines.length ? 'No products match.' : 'No product lines are mapped to campaigns yet.'}</div>
            )
            : tab === 'Portfolios' ? (
              portfolioGroups && portfolioGroups.length ? portfolioGroups.map((grp, i) => (
                <div className="cp-grp" key={i}>
                  <div className="cp-grph"><span className="gn" title={grp.name}>{grp.name}</span><Button variant="ghost" size="sm" disabled={!grp.items.filter((c) => !selIds.has(c.id)).length} onClick={() => onAddMany(grp.items.filter((c) => !selIds.has(c.id)))}><Plus size={12} /> Add</Button></div>
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
          <span className="pp">Rows per page: <Listbox width={72} options={[{ value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }]} value={String(perPage)} onChange={(v) => { setPerPage(Number(v)); setPage(1) }} ariaLabel="Rows per page" /></span>
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
