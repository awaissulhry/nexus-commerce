'use client'

/**
 * SPW.1 — Product Selection (inline two-panel, Helium 10 match). Left: Search /
 * Enter tabs over a product list with expandable parents — each variation family
 * (e.g. GALE-JACKET → 18 colour/size children) shows a chevron that lazy-loads its
 * variations via ?parentId=; you Add the whole family or individual variations.
 * Right: the running "N Products Added" list. Selection is a flat list of the
 * advertisable child/standalone SKUs (one product ad per child ASIN at launch).
 *
 * APS.2b — this component is SHARED by nine surfaces and used to be channel-blind:
 * it called the generic catalog endpoint with no scope, so an Amazon campaign
 * builder offered eBay-only products. Measured on prod 2026-07-30: 24 of the 37
 * rows it showed could not be advertised on Amazon at all. Four things changed:
 *
 *   · SCOPE. Every query carries advertisableOn=<CHANNEL>_<MARKET>, which matches
 *     ProductReadCache.rollupChannelKeys (a row's own listings UNION its
 *     children's). The rollup matters: `normal-knee-slider` is listed only on
 *     eBay itself while eight of its children are live on Amazon, so filtering
 *     on the row's own channelKeys would have HIDDEN a family with 8 advertisable
 *     ASINs. Scoping on the rollup returns 14 families for AMAZON_IT vs 37
 *     unscoped.
 *
 *   · SEARCH + PAGING moved server-side. The old code sent `?q=`, which the API
 *     never read (it wanted `search=`), so typing re-fetched the same unfiltered
 *     rows forever; and it paged client-side inside a limit=100 slice, silently
 *     truncating past 100 families.
 *
 *   · IDENTITY is honest. The row used to render an Amazon badge beside
 *     `asin || sku` — and asin was ALWAYS empty, because the API never returned
 *     it. A SKU was being presented as an ASIN. Now a real ASIN shows as one and
 *     a SKU is labelled a SKU.
 *
 *   · PASTE resolves against the server. It used to match only within the rows
 *     already loaded, so an ASIN outside the first page silently matched nothing.
 *     Unmatched tokens are now reported instead of disappearing.
 */
import { type Dispatch, type SetStateAction, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Plus, Check, Trash2, Copy, ChevronsUpDown, ChevronLeft, ChevronRight, ChevronDown, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AmazonBadge } from '../../_shell/BrandMarks'
import { useAdsMarketplace } from '../../_shell/MarketplaceContext'
import { FLAG, MARKET_NAME } from '../../_shell/MarketSelect'

export type SpwProduct = { id: string; name: string; sku: string; asin: string; imageUrl: string | null; parentId: string | null; childCount: number }
type Raw = { id: string; name: string; sku: string; asin?: string | null; imageUrl?: string | null; photoUrl?: string | null; parentId?: string | null; childCount?: number }
const toProd = (p: Raw): SpwProduct => ({ id: p.id, name: p.name, sku: p.sku, asin: p.asin ?? '', imageUrl: p.imageUrl ?? p.photoUrl ?? null, parentId: p.parentId ?? null, childCount: p.childCount ?? 0 })

const PAGE = 10
/** Paste is bounded so one huge paste cannot fan out into unbounded requests. */
const MAX_PASTE_TOKENS = 50

function Thumb({ p }: { p: SpwProduct }) {
  return (
    <span className="h10-spw-ps-th">
      {p.imageUrl ? <img src={p.imageUrl} alt="" /> : <span className="ph" />}
      <span className="tag"><AmazonBadge size={12} /></span>
    </span>
  )
}

/**
 * The identity line. An ASIN gets the Amazon badge because it IS an Amazon
 * identifier; a SKU gets the word "SKU". Conflating the two is what made the
 * old picker claim every product had an ASIN.
 */
function ProductIdent({ p, copyable }: { p: SpwProduct; copyable?: boolean }) {
  const copy = (t: string) => { try { void navigator.clipboard?.writeText(t) } catch { /* ignore */ } }
  return (
    <span className="id">
      {p.asin ? (
        <>
          <AmazonBadge size={14} />
          <span className="code">{p.asin}</span>
          {copyable ? <button type="button" className="cp" title="Copy ASIN" onClick={() => copy(p.asin)}><Copy size={12} /></button> : null}
          {p.sku ? <span className="dot">·</span> : null}
          {p.sku ? <span className="sku">{p.sku}</span> : null}
        </>
      ) : (
        <>
          <span className="h10-spw-ps-skutag">SKU</span>
          <span className="code">{p.sku}</span>
          {copyable && p.sku ? <button type="button" className="cp" title="Copy SKU" onClick={() => copy(p.sku)}><Copy size={12} /></button> : null}
        </>
      )}
    </span>
  )
}

function ProductMeta({ p, copyable }: { p: SpwProduct; copyable?: boolean }) {
  return (
    <span className="m">
      <span className="nm" title={p.name}>{p.name}</span>
      <ProductIdent p={p} copyable={copyable} />
    </span>
  )
}

export function ProductSelection({ products, setProducts, sponsoredVideo, channel = 'AMAZON', marketplace }: {
  products: SpwProduct[]
  setProducts: Dispatch<SetStateAction<SpwProduct[]>>
  // SB.4 — optional per-product "Sponsored Videos" toggle column (Single Campaign builder).
  // When omitted, the right panel renders exactly as before (SP Super Wizard unaffected).
  sponsoredVideo?: { enabled: Set<string>; onToggle: (id: string) => void }
  // APS.2b — the advertising scope. `marketplace` defaults to the console
  // context (APS.2a) so eight of the nine call sites need no change; the
  // Replicate builder passes its DESTINATION market explicitly, because a
  // cross-market copy is precisely the case where the two differ.
  channel?: 'AMAZON' | 'EBAY'
  marketplace?: string
}) {
  const { market: consoleMarket } = useAdsMarketplace()
  const market = marketplace ?? consoleMarket
  const scope = market ? `${channel}_${market}` : ''

  const [tab, setTab] = useState<'search' | 'enter'>('search')
  const [q, setQ] = useState('')
  const [all, setAll] = useState<SpwProduct[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [enterText, setEnterText] = useState('')
  const [entering, setEntering] = useState(false)
  const [enterMsg, setEnterMsg] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childCache, setChildCache] = useState<Record<string, SpwProduct[]>>({})
  const [loadingKids, setLoadingKids] = useState<Set<string>>(new Set())

  const api = getBackendUrl()
  /** Every read is scoped; nothing in this component queries the whole catalog. */
  const scoped = useCallback((qs: string) => `${api}/api/products/search?advertisableOn=${encodeURIComponent(scope)}&${qs}`, [api, scope])

  // Changing the term or the market invalidates the page cursor and any
  // children we cached against the previous scope.
  useEffect(() => { setPage(1) }, [q, scope])
  useEffect(() => { setChildCache({}); setExpanded(new Set()) }, [scope])

  /**
   * Products staged for one market are not valid in another — a Milan SKU is
   * not advertisable in Germany just because the operator switched the picker.
   * Silently carrying them over would launch a campaign against products the
   * scope says are unavailable, which is exactly the class of bug APS exists to
   * kill. So the staging tray is cleared on a REAL market change, and says so.
   *
   * The ref distinguishes a real change from the initial '' → 'AMAZON_IT'
   * resolution of the console context, which must not clear anything.
   */
  const prevScope = useRef('')
  const [scopeNote, setScopeNote] = useState('')
  useEffect(() => {
    const prev = prevScope.current
    prevScope.current = scope
    if (!prev || !scope || prev === scope) return
    setProducts((cur) => {
      if (cur.length === 0) return cur
      setScopeNote(`Cleared ${cur.length} product${cur.length === 1 ? '' : 's'} staged for ${prev.split('_')[1]} — they are not in scope for ${scope.split('_')[1]}.`)
      return []
    })
  }, [scope, setProducts])
  // The notice is about the last change only; a new search should not keep it.
  useEffect(() => { setScopeNote('') }, [q])

  useEffect(() => {
    if (!scope) { setAll([]); setTotal(0); setLoading(false); return }
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      fetch(scoped(`search=${encodeURIComponent(q)}&page=${page}&limit=${PAGE}`))
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return
          setAll(((j?.items ?? []) as Raw[]).map(toProd))
          setTotal(Number(j?.total ?? 0))
          setLoading(false)
        })
        .catch(() => { if (alive) { setAll([]); setTotal(0); setLoading(false) } })
    }, q ? 280 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [q, page, scope, scoped])

  const fetchChildren = useCallback(async (parentId: string): Promise<SpwProduct[]> => {
    if (childCache[parentId]) return childCache[parentId]
    setLoadingKids((s) => new Set(s).add(parentId))
    try {
      // Scoped too — a family can be half-listed. GALE-JACKET has 40 children
      // and only 20 on Amazon; "Add all" must never stage the other 20.
      const r = await fetch(scoped(`parentId=${parentId}&limit=500`))
      const j = await r.json()
      const kids = ((j?.items ?? []) as Raw[]).map(toProd)
      setChildCache((c) => ({ ...c, [parentId]: kids }))
      return kids
    } catch { return [] } finally { setLoadingKids((s) => { const n = new Set(s); n.delete(parentId); return n }) }
  }, [childCache, scoped])

  const toggleExpand = (parent: SpwProduct) => {
    const willOpen = !expanded.has(parent.id)
    setExpanded((s) => { const n = new Set(s); if (n.has(parent.id)) n.delete(parent.id); else n.add(parent.id); return n })
    if (willOpen && !childCache[parent.id]) void fetchChildren(parent.id)
  }

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const start = (page - 1) * PAGE
  const view = all
  const has = (id: string) => products.some((p) => p.id === id)
  const add = (p: SpwProduct) => setProducts((cur) => (cur.some((x) => x.id === p.id) ? cur : [...cur, p]))
  const remove = (id: string) => setProducts((cur) => cur.filter((p) => p.id !== id))
  const selOfParent = (parent: SpwProduct) => products.filter((p) => p.parentId === parent.id).length
  /** Advertisable child count — known only once the scoped children have loaded. */
  const advCount = (parent: SpwProduct): number | null => childCache[parent.id]?.length ?? null
  const addAllChildren = async (parent: SpwProduct) => {
    const kids = childCache[parent.id] ?? (await fetchChildren(parent.id))
    setProducts((cur) => { const ids = new Set(cur.map((p) => p.id)); return [...cur, ...kids.filter((k) => !ids.has(k.id))] })
  }
  const removeAllChildren = (parent: SpwProduct) => setProducts((cur) => cur.filter((p) => p.parentId !== parent.id))
  const addAll = async () => { for (const p of view) { if (p.childCount > 0) await addAllChildren(p); else add(p) } }

  /**
   * Resolve pasted identifiers against the SERVER, within scope, including
   * children — an operator pastes child ASINs, and children are never on the
   * top-level page. Anything that does not resolve is named back to them.
   */
  const addEntered = async () => {
    const toks = Array.from(new Set(enterText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)))
    if (!toks.length || !scope) return
    setEntering(true); setEnterMsg('')
    try {
      const capped = toks.slice(0, MAX_PASTE_TOKENS)
      const results = await Promise.all(capped.map(async (t) => {
        try {
          const r = await fetch(scoped(`search=${encodeURIComponent(t)}&includeChildren=1&limit=25`))
          const j = await r.json()
          const rows = ((j?.items ?? []) as Raw[]).map(toProd)
          const lower = t.toLowerCase()
          // Exact identifier wins; a name substring is the fallback so pasting
          // a product title still works, as it did before.
          const exact = rows.find((p) => p.sku.toLowerCase() === lower || p.asin.toLowerCase() === lower)
          return { token: t, hit: exact ?? rows.find((p) => p.name.toLowerCase().includes(lower)) ?? null }
        } catch { return { token: t, hit: null } }
      }))
      const hits = results.map((r) => r.hit).filter((p): p is SpwProduct => !!p)
      setProducts((cur) => { const ids = new Set(cur.map((p) => p.id)); return [...cur, ...hits.filter((p) => !ids.has(p.id))] })

      const missed = results.filter((r) => !r.hit).map((r) => r.token)
      const dropped = toks.length - capped.length
      const parts: string[] = []
      if (hits.length) parts.push(`Added ${hits.length}.`)
      if (missed.length) parts.push(`Not advertisable on ${market} (or not found): ${missed.slice(0, 8).join(', ')}${missed.length > 8 ? ` +${missed.length - 8} more` : ''}.`)
      if (dropped > 0) parts.push(`${dropped} line(s) beyond the ${MAX_PASTE_TOKENS}-item limit were ignored.`)
      setEnterMsg(parts.join(' ') || 'Nothing matched.')
      if (hits.length && !missed.length && !dropped) setEnterText('')
    } finally { setEntering(false) }
  }

  const scopeLabel = useMemo(
    () => (market ? `${FLAG[market] ?? '🏳️'} ${MARKET_NAME[market] ?? market}` : ''),
    [market],
  )

  // Without a market there is no such thing as "advertisable", so the panel
  // says so rather than showing the whole catalogue as if it were valid.
  if (!scope) {
    return (
      <div className="h10-spw-ps">
        <div className="h10-spw-ps-left">
          <div className="h10-spw-ps-empty">Select an Amazon marketplace to choose products.</div>
        </div>
        <div className="h10-spw-ps-right">
          <div className="h10-spw-ps-rh"><b>{products.length} Products Added</b></div>
          <div className="h10-spw-ps-rlist"><div className="h10-spw-ps-nodata">No data</div></div>
        </div>
      </div>
    )
  }

  return (
    <div className="h10-spw-ps">
      <div className="h10-spw-ps-left">
        <div className="h10-spw-ps-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Search for Products</button>
          <button type="button" role="tab" aria-selected={tab === 'enter'} className={tab === 'enter' ? 'on' : ''} onClick={() => setTab('enter')}>Enter Products</button>
        </div>

        {/* The scope is stated, not implied — the operator should never wonder
            why a product they own is absent. */}
        <div className="h10-spw-ps-scope">
          Showing products advertisable on <b>{channel === 'EBAY' ? 'eBay' : 'Amazon'} {scopeLabel}</b>
          {scopeNote ? <span className="h10-spw-ps-scopenote">{scopeNote}</span> : null}
        </div>

        {tab === 'search' ? (
          <>
            <div className="h10-spw-ps-search">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by product name, ASIN, or SKU" aria-label="Search products" />
              <Search size={15} />
            </div>
            <div className="h10-spw-ps-cnt">
              <span>Viewing {total === 0 ? 0 : start + 1}-{Math.min(start + PAGE, total)} of {total} Products</span>
              <button type="button" className="addall" disabled={!view.length} onClick={() => void addAll()}><Plus size={13} /> Add All</button>
            </div>
            <div className="h10-spw-ps-list">
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => <div key={i} className="row sk"><span className="skth" /><span className="skm"><span /><span /></span></div>)
              ) : view.length === 0 ? (
                <div className="h10-spw-ps-empty">{q ? 'No products match your search.' : `Nothing in the catalogue is advertisable on ${market} yet.`}</div>
              ) : (
                view.map((p) => {
                  const isFamily = p.childCount > 0
                  const sel = isFamily ? selOfParent(p) : 0
                  const adv = advCount(p)
                  const allSel = isFamily && adv != null && sel >= adv && adv > 0
                  const open = expanded.has(p.id)
                  return (
                    <Fragment key={p.id}>
                      <div className="row">
                        {isFamily
                          ? <button type="button" className="exp" onClick={() => toggleExpand(p)} aria-label={open ? 'Collapse variations' : 'Expand variations'} aria-expanded={open}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                          : <span className="exp-sp" />}
                        <Thumb p={p} />
                        <span className="m">
                          <span className="nm" title={p.name}>{p.name}</span>
                          <span className="id">
                            {p.asin ? <><AmazonBadge size={14} /><span className="code">{p.asin}</span></> : <><span className="h10-spw-ps-skutag">SKU</span><span className="code">{p.sku}</span></>}
                            {/* Before expansion we only know the family's TOTAL variations.
                                Once the scoped children load we can say how many of them
                                are actually advertisable here — often fewer. */}
                            {isFamily ? (
                              <span className="varc">
                                · {adv != null ? `${adv} of ${p.childCount}` : p.childCount} variation{(adv ?? p.childCount) === 1 ? '' : 's'}
                                {adv != null && adv < p.childCount ? ` on ${market}` : ''}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        {isFamily
                          ? <button type="button" className={`addbtn ${allSel ? 'on' : ''}`} onClick={() => (allSel ? removeAllChildren(p) : void addAllChildren(p))}>{allSel ? <><Check size={13} /> Added</> : sel > 0 ? <>{sel}/{adv ?? p.childCount}</> : <><Plus size={13} /> Add all</>}</button>
                          : <button type="button" className={`addbtn ${has(p.id) ? 'on' : ''}`} onClick={() => (has(p.id) ? remove(p.id) : add(p))}>{has(p.id) ? <><Check size={13} /> Added</> : <><Plus size={13} /> Add</>}</button>}
                      </div>
                      {open && (loadingKids.has(p.id) ? (
                        <div className="h10-spw-ps-kidload">Loading variations…</div>
                      ) : (childCache[p.id] ?? []).length === 0 ? (
                        <div className="h10-spw-ps-kidload">No variations of this family are advertisable on {market}.</div>
                      ) : (childCache[p.id] ?? []).map((kid) => (
                        <div className="row kid" key={kid.id}>
                          <Thumb p={kid} />
                          <ProductMeta p={kid} />
                          <button type="button" className={`addbtn ${has(kid.id) ? 'on' : ''}`} onClick={() => (has(kid.id) ? remove(kid.id) : add(kid))}>{has(kid.id) ? <><Check size={13} /> Added</> : <><Plus size={13} /> Add</>}</button>
                        </div>
                      )))}
                    </Fragment>
                  )
                })
              )}
            </div>
            {pages > 1 && (
              <div className="h10-spw-ps-pager">
                <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page"><ChevronLeft size={15} /></button>
                {Array.from({ length: pages }).slice(0, 7).map((_, i) => (
                  <button type="button" key={i} className={page === i + 1 ? 'on' : ''} onClick={() => setPage(i + 1)}>{i + 1}</button>
                ))}
                <button type="button" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))} aria-label="Next page"><ChevronRight size={15} /></button>
              </div>
            )}
          </>
        ) : (
          <div className="h10-spw-ps-enter">
            <textarea value={enterText} onChange={(e) => setEnterText(e.target.value)} placeholder="Enter product names, ASINs, or SKUs — one per line" />
            <div className="h10-spw-ps-enterfoot">
              {enterMsg ? <span className="h10-spw-ps-entermsg">{enterMsg}</span> : <span />}
              <button type="button" className="addall" disabled={!enterText.trim() || entering} onClick={() => void addEntered()}><Plus size={13} /> {entering ? 'Resolving…' : 'Add'}</button>
            </div>
          </div>
        )}
      </div>

      <div className="h10-spw-ps-right">
        <div className="h10-spw-ps-rh">
          <b>{products.length} Products Added</b>
          <button type="button" className="rm" disabled={!products.length} onClick={() => setProducts([])}><Trash2 size={12} /> Remove All</button>
        </div>
        {sponsoredVideo ? (
          <div className="h10-spw-ps-rcol sv"><span className="pcol">Product <ChevronsUpDown size={11} /></span><span className="svcol">Sponsored Videos <span className="newtag">New</span></span></div>
        ) : (
          <div className="h10-spw-ps-rcol">Product <ChevronsUpDown size={11} /></div>
        )}
        <div className="h10-spw-ps-rlist">
          {products.length === 0 ? (
            <div className="h10-spw-ps-nodata">No data</div>
          ) : (
            products.map((p) => (
              <div key={p.id} className="row">
                <Thumb p={p} />
                <ProductMeta p={p} />
                {sponsoredVideo && (
                  <label className="h10-spw-ps-sv" title="Run a Sponsored Brands video for this product">
                    <input type="checkbox" checked={sponsoredVideo.enabled.has(p.id)} onChange={() => sponsoredVideo.onToggle(p.id)} aria-label={`Sponsored Videos for ${p.name}`} />
                  </label>
                )}
                <button type="button" className="x" onClick={() => remove(p.id)} aria-label={`Remove ${p.name}`}><X size={14} /></button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
