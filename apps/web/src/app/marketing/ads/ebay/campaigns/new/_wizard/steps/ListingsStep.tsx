'use client'

/**
 * EV2 — step ③ Listings on the FULL Amazon ProductSelection anatomy
 * (.h10-spw-ps, shared CSS): two panels, Search/Enter tabs, 44px thumbnails
 * (eBay gallery image, catalog MAIN fallback — never faked), family grouping
 * by matched product with expand, per-row/f amily Add, Add All, pager,
 * skeleton rows, staged tray with Remove All. ER2 semantics preserved:
 * conflict pill + skip/move/include resolution on the staged side, PRI
 * out-of-stock exclusion (eBay rejects OOS on Priority at creation).
 */
import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Copy, Plus, Search, Trash2, X } from 'lucide-react'
import { money, pct } from '../../../../../campaigns/_grid/format'
import { H10Select } from '../../../../../campaigns/FilterDropdown'
import { EbayMark } from '../../../../../_shell/EbayMark'
import type { CampaignPlan, PlanListing } from '../plan'

const PAGE = 10

function Thumb({ l, kid }: { l: PlanListing; kid?: boolean }) {
  void kid
  return (
    <span className="h10-spw-ps-th">
      {l.imageUrl ? <img src={l.imageUrl} alt="" loading="lazy" /> : <span className="ph" />}
    </span>
  )
}

function ListingMeta({ l, copyable }: { l: PlanListing; copyable?: boolean }) {
  return (
    <span className="m">
      <span className="nm" title={l.title ?? l.itemId}>{l.title ?? l.itemId}</span>
      <span className="id">
        <EbayMark />
        <span className="code">{l.itemId}</span>
        {copyable && (
          <button type="button" className="cp" title="Copy item ID" onClick={() => { try { void navigator.clipboard?.writeText(l.itemId) } catch { /* ignore */ } }}><Copy size={12} /></button>
        )}
        <span className="dot">·</span>
        <span className="sku">{money(l.priceCents)} · qty {l.quantity ?? '—'} · BE {l.breakEvenPct != null ? pct(l.breakEvenPct / 100) : 'add cost'} · 30d {money(l.trailingSales30dCents)}</span>
      </span>
    </span>
  )
}

interface Group { key: string; name: string; listings: PlanListing[] }

export function ListingsStep({ plan, set, listings, isPriority, loading }: {
  plan: CampaignPlan
  set: (patch: Partial<CampaignPlan>) => void
  listings: PlanListing[]
  isPriority: boolean
  loading?: boolean
}) {
  const [tab, setTab] = useState<'search' | 'enter'>('search')
  const [q, setQ] = useState('')
  const [enterText, setEnterText] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)

  const selectedSet = useMemo(() => new Set(plan.selected), [plan.selected])
  const oos = (l: PlanListing) => isPriority && (l.quantity ?? 0) <= 0
  const staged = useMemo(() => listings.filter((l) => selectedSet.has(l.itemId)), [listings, selectedSet])
  const trailingStaged = staged.reduce((a, l) => a + l.trailingSales30dCents, 0)

  const add = (ids: string[]) => set({ selected: [...new Set([...plan.selected, ...ids.filter((id) => { const l = listings.find((x) => x.itemId === id); return l && !oos(l) })])] })
  const remove = (id: string) => set({ selected: plan.selected.filter((x) => x !== id) })

  // family grouping by matched product; unmatched listings stay flat rows
  const groups = useMemo<Array<Group | PlanListing>>(() => {
    const match = (l: PlanListing) => !q.trim() || (l.title ?? l.itemId).toLowerCase().includes(q.trim().toLowerCase()) || l.itemId.includes(q.trim())
    const avail = listings.filter((l) => !selectedSet.has(l.itemId) && match(l))
    const byProd = new Map<string, PlanListing[]>()
    const flat: PlanListing[] = []
    for (const l of avail) {
      if (l.productId) { const a = byProd.get(l.productId) ?? []; a.push(l); byProd.set(l.productId, a) } else flat.push(l)
    }
    const out: Array<Group | PlanListing> = []
    for (const [key, ls] of byProd) {
      if (ls.length === 1) out.push(ls[0])
      else out.push({ key, name: ls[0].productName ?? ls[0].title ?? key, listings: ls })
    }
    out.push(...flat)
    return out
  }, [listings, selectedSet, q])

  const total = groups.length
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const safePage = Math.min(page, pages)
  const start = (safePage - 1) * PAGE
  const view = groups.slice(start, start + PAGE)

  const addEntered = () => {
    const tokens = enterText.split(/[\n,]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (!tokens.length) return
    const hits = listings.filter((l) => tokens.some((t) => l.itemId.toLowerCase() === t || (l.title ?? '').toLowerCase().includes(t)))
    add(hits.map((l) => l.itemId))
    setEnterText('')
    setTab('search')
  }

  const rowPills = (l: PlanListing) => (
    <>
      {l.conflict && <span className="h10-pill warn" title={`Already promoted in "${l.conflict.campaignName}" — resolve after staging (one listing = one General campaign)`}>in campaign</span>}
      {oos(l) && <span className="h10-pill warn" title="eBay rejects out-of-stock listings on Priority campaigns at creation — restock first">out of stock</span>}
    </>
  )

  return (
    <div className="h10-spw-ps">
      <div className="h10-spw-ps-left">
        <div className="h10-spw-ps-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Search listings</button>
          <button type="button" role="tab" aria-selected={tab === 'enter'} className={tab === 'enter' ? 'on' : ''} onClick={() => setTab('enter')}>Enter item IDs</button>
        </div>

        {tab === 'search' ? (
          <>
            <div className="h10-spw-ps-search">
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Search by listing title or item ID" aria-label="Search listings" />
              <Search size={15} />
            </div>
            <div className="h10-spw-ps-cnt">
              <span>Viewing {total === 0 ? 0 : start + 1}-{Math.min(start + PAGE, total)} of {total} Listings</span>
              <button type="button" className="addall" disabled={!view.length} onClick={() => add(groups.flatMap((g) => ('listings' in g ? g.listings.map((l) => l.itemId) : [g.itemId])))}><Plus size={13} /> Add All</button>
            </div>
            <div className="h10-spw-ps-list">
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => <div key={i} className="row sk"><span className="skth" /><span className="skm"><span /><span /></span></div>)
              ) : view.length === 0 ? (
                <div className="h10-spw-ps-empty">{q ? 'No listings match your search.' : 'Everything is staged.'}</div>
              ) : (
                view.map((g) => {
                  if ('listings' in g) {
                    const kids = g.listings
                    const addable = kids.filter((l) => !oos(l))
                    const open = expanded.has(g.key)
                    return (
                      <Fragment key={g.key}>
                        <div className="row">
                          <button type="button" className="exp" onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n })} aria-expanded={open} aria-label={open ? 'Collapse listings' : 'Expand listings'}>
                            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                          <Thumb l={kids[0]} />
                          <span className="m">
                            <span className="nm" title={g.name}>{g.name}</span>
                            <span className="id"><EbayMark /><span className="varc">{kids.length} listing{kids.length === 1 ? '' : 's'}</span></span>
                          </span>
                          <button type="button" className="addbtn" disabled={!addable.length} onClick={() => add(addable.map((l) => l.itemId))}><Plus size={13} /> Add all</button>
                        </div>
                        {open && kids.map((l) => (
                          <div className="row kid" key={l.itemId} style={oos(l) ? { opacity: 0.55 } : undefined}>
                            <Thumb l={l} kid />
                            <ListingMeta l={l} />
                            {rowPills(l)}
                            {!oos(l) && <button type="button" className="addbtn" onClick={() => add([l.itemId])}><Plus size={13} /> Add</button>}
                          </div>
                        ))}
                      </Fragment>
                    )
                  }
                  const l = g
                  return (
                    <div className="row" key={l.itemId} style={oos(l) ? { opacity: 0.55 } : undefined}>
                      <span className="exp-sp" />
                      <Thumb l={l} />
                      <ListingMeta l={l} />
                      {rowPills(l)}
                      {!oos(l) && <button type="button" className="addbtn" onClick={() => add([l.itemId])}><Plus size={13} /> Add</button>}
                    </div>
                  )
                })
              )}
            </div>
            {pages > 1 && (
              <div className="h10-spw-ps-pager">
                <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page"><ChevronLeft size={15} /></button>
                {Array.from({ length: pages }).slice(0, 7).map((_, i) => (
                  <button type="button" key={i} className={safePage === i + 1 ? 'on' : ''} onClick={() => setPage(i + 1)}>{i + 1}</button>
                ))}
                <button type="button" disabled={safePage >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))} aria-label="Next page"><ChevronRight size={15} /></button>
              </div>
            )}
          </>
        ) : (
          <div className="h10-spw-ps-enter">
            <textarea value={enterText} onChange={(e) => setEnterText(e.target.value)} placeholder="Enter item IDs or title fragments — one per line" />
            <div className="h10-spw-ps-enterfoot">
              <button type="button" className="addall" disabled={!enterText.trim()} onClick={addEntered}><Plus size={13} /> Add</button>
            </div>
          </div>
        )}
      </div>

      <div className="h10-spw-ps-right">
        <div className="h10-spw-ps-rh">
          <b>{staged.length} Listing{staged.length === 1 ? '' : 's'} staged</b>
          <button type="button" className="rm" disabled={!staged.length} onClick={() => set({ selected: [] })}><Trash2 size={12} /> Remove All</button>
        </div>
        <div className="h10-spw-ps-rcol">Listing <ChevronsUpDown size={11} /><span style={{ marginLeft: 'auto', fontWeight: 500 }}>trailing-30d {money(trailingStaged)}</span></div>
        <div className="h10-spw-ps-rlist">
          {staged.length === 0 ? (
            <div className="h10-spw-ps-nodata">Nothing staged — add listings from the left, or Add All for a catch-all.</div>
          ) : (
            staged.map((l) => (
              <div key={l.itemId} className="row">
                <Thumb l={l} />
                <ListingMeta l={l} />
                {l.conflict && (
                  <span className="eb-dd dense" title={`Already in "${l.conflict.campaignName}" at ${l.conflict.currentRatePct ?? '?'}% — one listing = one General campaign`}>
                    <H10Select ariaLabel={`Conflict resolution for ${l.title ?? l.itemId}`} width={132}
                      value={plan.resolutions[l.itemId] ?? 'skip'}
                      onChange={(v) => set({ resolutions: { ...plan.resolutions, [l.itemId]: v as 'include' | 'skip' | 'move' } })}
                      options={[
                        { value: 'skip', label: 'skip' },
                        { value: 'move', label: 'move here' },
                        { value: 'include', label: 'include (will fail)' },
                      ]} />
                  </span>
                )}
                <button type="button" className="x" onClick={() => remove(l.itemId)} aria-label={`Remove ${l.title ?? l.itemId}`}><X size={14} /></button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
