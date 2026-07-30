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

/**
 * APS.3b — Amazon's own eligibility verdict, from GET /advertising/eligibility.
 *
 * Scoping (APS.2b) answers "is this listed here". This answers "will Amazon
 * actually serve it" — out of stock, buy box lost, listing suppressed. A
 * campaign built on an ineligible ASIN launches successfully and then delivers
 * nothing, which is discovered days later in Amazon's console.
 *
 * UNKNOWN is a first-class state, not a synonym for eligible. It means we did
 * not get an answer, and the row says so instead of quietly implying "fine".
 */
type EligVerdict = 'ELIGIBLE' | 'ELIGIBLE_WITH_WARNING' | 'INELIGIBLE' | 'UNKNOWN'
type EligRow = {
  asin: string
  sku?: string | null
  status: EligVerdict
  reasons: Array<{ name: string; severity: string; message: string | null; helpUrl: string | null }>
  unknownReason?: string
}

/** Amazon's reason codes are SCREAMING_SNAKE; operators are not compilers. */
const REASON_LABEL: Record<string, string> = {
  NOT_IN_BUYBOX: 'Not winning the buy box',
  OUT_OF_STOCK: 'Out of stock',
  VARIATION_PARENT: 'Variation parent — advertise the child instead',
  LISTING_SUPRESSED: 'Listing suppressed',
  MISSING_IMAGE: 'No main image',
  MISSING_TITLE: 'No title',
  ADULT_PRODUCT: 'Adult product',
  CLOSED_CATEGORY: 'Closed category',
  RESTRICTED_CATEGORY: 'Restricted category',
  INELIGIBLE_CONDITION: 'Ineligible condition',
  INELIGIBLE_OFFER: 'Ineligible offer',
  INELIGIBLE_PRODUCT_COST: 'Price outside the eligible range',
}
const reasonText = (r: { name: string; message: string | null }) =>
  REASON_LABEL[r.name] ?? r.message ?? r.name.replace(/_/g, ' ').toLowerCase()

function EligPill({ e }: { e: EligRow | undefined }) {
  if (!e) return null
  const reasons = e.reasons.map(reasonText)
  if (e.status === 'ELIGIBLE') {
    // Deliberately quiet: a pass is worth showing (it proves the check RAN and
    // distinguishes it from UNKNOWN) but must not compete with the problems.
    return <span className="h10-elig ok" title="Amazon reports this product can be advertised">Eligible</span>
  }
  if (e.status === 'UNKNOWN') {
    return <span className="h10-elig unk" title={e.unknownReason ? `Not checked — ${e.unknownReason}` : 'Not checked'}>Not checked</span>
  }
  const label = e.status === 'INELIGIBLE' ? 'Ineligible' : 'Warning'
  return (
    <span className={`h10-elig ${e.status === 'INELIGIBLE' ? 'bad' : 'warn'}`} title={reasons.join(' · ') || label}>
      {label}{reasons.length ? <span className="why"> · {reasons[0]}</span> : null}
    </span>
  )
}

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
  // APS.3b — Amazon's verdict per ASIN. Keyed uppercase, same as the API.
  const [elig, setElig] = useState<Record<string, EligRow>>({})
  const [eligDegraded, setEligDegraded] = useState<string | null>(null)

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

  // A verdict belongs to a marketplace; carrying IT's answers into DE would be
  // worse than having none.
  useEffect(() => { setElig({}); setEligDegraded(null) }, [scope])

  /**
   * Which ASINs need a verdict: standalone products on the page, plus the
   * children of any expanded family.
   *
   * Family PARENTS are deliberately excluded. Amazon's own reason list contains
   * VARIATION_PARENT — a parent is never advertisable — so asking about one
   * would mark every family "Ineligible" and drown the real signal in noise.
   * The advertisable unit is the child, which is the same conclusion APS.2b
   * reached from the listing data.
   */
  const needAsins = useMemo(() => {
    if (channel !== 'AMAZON') return [] as string[]
    const out = new Set<string>()
    for (const p of all) if (p.childCount === 0 && p.asin) out.add(p.asin.toUpperCase())
    for (const id of expanded) for (const k of childCache[id] ?? []) if (k.asin) out.add(k.asin.toUpperCase())
    return [...out]
  }, [all, expanded, childCache, channel])

  /**
   * ASINs already sent upstream, so one is never requested twice.
   *
   * Without this the effect loops forever: it depends on `elig`, and setElig
   * spreads into a NEW object every time, so any ASIN the response does not
   * cover (the route caps at 200, and UNKNOWN rows are not cached) keeps
   * `missing` non-empty and re-triggers the effect on its own output.
   */
  const askedRef = useRef<Set<string>>(new Set())
  useEffect(() => { askedRef.current = new Set() }, [scope])

  useEffect(() => {
    if (!market || channel !== 'AMAZON') return
    const missing = needAsins.filter((a) => !elig[a] && !askedRef.current.has(a))
    if (missing.length === 0) return
    // Mark before the request: a second render must not re-send these.
    for (const a of missing) askedRef.current.add(a)

    let alive = true
    const url = `${api}/api/advertising/eligibility?marketplace=${encodeURIComponent(market)}&adType=sp&asins=${encodeURIComponent(missing.join(','))}`
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { items?: Record<string, EligRow>; degraded?: boolean; degradedReason?: string }) => {
        if (!alive) return
        setElig((cur) => ({ ...cur, ...(j.items ?? {}) }))
        setEligDegraded(j.degraded ? (j.degradedReason ?? 'Eligibility could not be checked.') : null)
      })
      .catch(() => {
        if (!alive) return
        // Failing the check must not silently look like "all eligible".
        setEligDegraded('Eligibility could not be checked.')
      })
    return () => { alive = false }
  }, [needAsins, elig, market, channel, api])

  /**
   * A product with no ASIN on file cannot be asked about — and rendering
   * nothing would make it indistinguishable from a row that simply has not
   * loaded yet. Measured on prod: 16 of AIREON's 40 children have no
   * amazonAsin, so a blank cell is common rather than rare.
   *
   * It stays ADDABLE: Sponsored Products ads are created from the seller SKU
   * (ads-create.service.ts), so a missing ASIN blocks the CHECK, not the ad.
   */
  const verdict = (p: SpwProduct): EligRow | undefined => {
    if (!p.asin) {
      return { asin: '', sku: p.sku, status: 'UNKNOWN', reasons: [], unknownReason: 'no ASIN on file for this product' }
    }
    return elig[p.asin.toUpperCase()]
  }
  /** Only a verdict Amazon actually gave blocks staging. UNKNOWN never blocks. */
  const blocked = (p: SpwProduct): boolean => verdict(p)?.status === 'INELIGIBLE'

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
    // Never bulk-stage something Amazon has already said it will not serve.
    const ok = kids.filter((k) => !blocked(k))
    setProducts((cur) => { const ids = new Set(cur.map((p) => p.id)); return [...cur, ...ok.filter((k) => !ids.has(k.id))] })
  }
  const removeAllChildren = (parent: SpwProduct) => setProducts((cur) => cur.filter((p) => p.parentId !== parent.id))
  const addAll = async () => { for (const p of view) { if (p.childCount > 0) await addAllChildren(p); else if (!blocked(p)) add(p) } }

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
          {/* Never let a failed check pass for a clean bill of health. */}
          {eligDegraded ? <span className="h10-spw-ps-scopenote">{eligDegraded} Rows show “Not checked” rather than a verdict.</span> : null}
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
                        {/* Eligibility is a property of the advertisable unit, so it
                            appears on standalones and children — never on a family row. */}
                        {!isFamily ? <EligPill e={verdict(p)} /> : null}
                        {isFamily
                          ? <button type="button" className={`addbtn ${allSel ? 'on' : ''}`} onClick={() => (allSel ? removeAllChildren(p) : void addAllChildren(p))}>{allSel ? <><Check size={13} /> Added</> : sel > 0 ? <>{sel}/{adv ?? p.childCount}</> : <><Plus size={13} /> Add all</>}</button>
                          : <button type="button" className={`addbtn ${has(p.id) ? 'on' : ''}`} disabled={blocked(p) && !has(p.id)} title={blocked(p) ? 'Amazon reports this product cannot be advertised' : undefined} onClick={() => (has(p.id) ? remove(p.id) : add(p))}>{has(p.id) ? <><Check size={13} /> Added</> : <><Plus size={13} /> Add</>}</button>}
                      </div>
                      {open && (loadingKids.has(p.id) ? (
                        <div className="h10-spw-ps-kidload">Loading variations…</div>
                      ) : (childCache[p.id] ?? []).length === 0 ? (
                        <div className="h10-spw-ps-kidload">No variations of this family are advertisable on {market}.</div>
                      ) : (childCache[p.id] ?? []).map((kid) => (
                        <div className={`row kid${blocked(kid) ? ' inelig' : ''}`} key={kid.id}>
                          <Thumb p={kid} />
                          <ProductMeta p={kid} />
                          <EligPill e={verdict(kid)} />
                          <button type="button" className={`addbtn ${has(kid.id) ? 'on' : ''}`} disabled={blocked(kid) && !has(kid.id)} title={blocked(kid) ? 'Amazon reports this product cannot be advertised' : undefined} onClick={() => (has(kid.id) ? remove(kid.id) : add(kid))}>{has(kid.id) ? <><Check size={13} /> Added</> : <><Plus size={13} /> Add</>}</button>
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
              <div key={p.id} className={`row${blocked(p) ? ' inelig' : ''}`}>
                <Thumb p={p} />
                <ProductMeta p={p} />
                {/* A product can become ineligible AFTER it was staged (stock runs
                    out mid-build). The tray must show that, not just the catalogue. */}
                <EligPill e={verdict(p)} />
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
