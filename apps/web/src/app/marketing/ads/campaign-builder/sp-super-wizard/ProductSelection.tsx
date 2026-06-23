'use client'

/**
 * SPW.1 — Product Selection (inline two-panel, Helium 10 match). Left: Search /
 * Enter tabs over a product list with expandable parents — each variation family
 * (e.g. GALE-JACKET → 18 colour/size children) shows a chevron that lazy-loads its
 * variations via ?parentId=; you Add the whole family or individual variations.
 * Right: the running "N Products Added" list. Selection is a flat list of the
 * advertisable child/standalone SKUs (one product ad per child ASIN at launch).
 */
import { type Dispatch, type SetStateAction, Fragment, useCallback, useEffect, useState } from 'react'
import { Search, Plus, Check, Trash2, Copy, ChevronsUpDown, ChevronLeft, ChevronRight, ChevronDown, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export type SpwProduct = { id: string; name: string; sku: string; asin: string; imageUrl: string | null; parentId: string | null; childCount: number }
type Raw = { id: string; name: string; sku: string; asin?: string | null; imageUrl?: string | null; photoUrl?: string | null; parentId?: string | null; childCount?: number }
const toProd = (p: Raw): SpwProduct => ({ id: p.id, name: p.name, sku: p.sku, asin: p.asin ?? '', imageUrl: p.imageUrl ?? p.photoUrl ?? null, parentId: p.parentId ?? null, childCount: p.childCount ?? 0 })

const PAGE = 10

function AmazonBadge({ size = 15 }: { size?: number }) {
  return (
    <span className="h10-spw-amz" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 20 20" width={size} height={size}>
        <rect width="20" height="20" rx="3" fill="#232f3e" />
        <text x="4.5" y="13.5" fontSize="11" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">a</text>
        <path d="M3.5 14.5c3 1.7 6.5 1.7 9.4-.2" stroke="#ff9900" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      </svg>
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

function ProductMeta({ p, copyable }: { p: SpwProduct; copyable?: boolean }) {
  const idText = p.asin || p.sku
  return (
    <span className="m">
      <span className="nm" title={p.name}>{p.name}</span>
      <span className="id">
        <AmazonBadge size={14} />
        <span className="code">{idText}</span>
        {copyable && idText ? (
          <button type="button" className="cp" title="Copy" onClick={() => { try { void navigator.clipboard?.writeText(idText) } catch { /* ignore */ } }}><Copy size={12} /></button>
        ) : null}
        {p.asin && p.sku ? <span className="dot">·</span> : null}
        {p.asin && p.sku ? <span className="sku">{p.sku}</span> : null}
      </span>
    </span>
  )
}

export function ProductSelection({ products, setProducts, sponsoredVideo }: {
  products: SpwProduct[]
  setProducts: Dispatch<SetStateAction<SpwProduct[]>>
  // SB.4 — optional per-product "Sponsored Videos" toggle column (Single Campaign builder).
  // When omitted, the right panel renders exactly as before (SP Super Wizard unaffected).
  sponsoredVideo?: { enabled: Set<string>; onToggle: (id: string) => void }
}) {
  const [tab, setTab] = useState<'search' | 'enter'>('search')
  const [q, setQ] = useState('')
  const [all, setAll] = useState<SpwProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [enterText, setEnterText] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childCache, setChildCache] = useState<Record<string, SpwProduct[]>>({})
  const [loadingKids, setLoadingKids] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}/api/products/search?q=${encodeURIComponent(q)}&limit=100`)
        .then((r) => r.json())
        .then((j) => { if (!alive) return; setAll(((j?.items ?? []) as Raw[]).map(toProd)); setPage(1); setLoading(false) })
        .catch(() => { if (alive) { setAll([]); setLoading(false) } })
    }, q ? 280 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  const fetchChildren = useCallback(async (parentId: string): Promise<SpwProduct[]> => {
    if (childCache[parentId]) return childCache[parentId]
    setLoadingKids((s) => new Set(s).add(parentId))
    try {
      const r = await fetch(`${getBackendUrl()}/api/products/search?parentId=${parentId}&limit=500`)
      const j = await r.json()
      const kids = ((j?.items ?? []) as Raw[]).map(toProd)
      setChildCache((c) => ({ ...c, [parentId]: kids }))
      return kids
    } catch { return [] } finally { setLoadingKids((s) => { const n = new Set(s); n.delete(parentId); return n }) }
  }, [childCache])

  const toggleExpand = (parent: SpwProduct) => {
    const willOpen = !expanded.has(parent.id)
    setExpanded((s) => { const n = new Set(s); if (n.has(parent.id)) n.delete(parent.id); else n.add(parent.id); return n })
    if (willOpen && !childCache[parent.id]) void fetchChildren(parent.id)
  }

  const total = all.length
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const start = (page - 1) * PAGE
  const view = all.slice(start, start + PAGE)
  const has = (id: string) => products.some((p) => p.id === id)
  const add = (p: SpwProduct) => setProducts((cur) => (cur.some((x) => x.id === p.id) ? cur : [...cur, p]))
  const remove = (id: string) => setProducts((cur) => cur.filter((p) => p.id !== id))
  const selOfParent = (parent: SpwProduct) => products.filter((p) => p.parentId === parent.id).length
  const addAllChildren = async (parent: SpwProduct) => {
    const kids = childCache[parent.id] ?? (await fetchChildren(parent.id))
    setProducts((cur) => { const ids = new Set(cur.map((p) => p.id)); return [...cur, ...kids.filter((k) => !ids.has(k.id))] })
  }
  const removeAllChildren = (parent: SpwProduct) => setProducts((cur) => cur.filter((p) => p.parentId !== parent.id))
  const addAll = async () => { for (const p of view) { if (p.childCount > 0) await addAllChildren(p); else add(p) } }
  const addEntered = () => {
    const toks = enterText.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (!toks.length) return
    const pool = [...all, ...Object.values(childCache).flat()]
    const match = pool.filter((p) => toks.some((t) => p.sku.toLowerCase() === t || p.asin.toLowerCase() === t || p.name.toLowerCase().includes(t)))
    setProducts((cur) => { const ids = new Set(cur.map((p) => p.id)); return [...cur, ...match.filter((p) => !ids.has(p.id))] })
    setEnterText('')
  }

  return (
    <div className="h10-spw-ps">
      <div className="h10-spw-ps-left">
        <div className="h10-spw-ps-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Search for Products</button>
          <button type="button" role="tab" aria-selected={tab === 'enter'} className={tab === 'enter' ? 'on' : ''} onClick={() => setTab('enter')}>Enter Products</button>
        </div>

        {tab === 'search' ? (
          <>
            <div className="h10-spw-ps-search">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SearchTerm by product name, ASIN, or SKU" aria-label="Search products" />
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
                <div className="h10-spw-ps-empty">No products match your search.</div>
              ) : (
                view.map((p) => {
                  const isFamily = p.childCount > 0
                  const sel = isFamily ? selOfParent(p) : 0
                  const allSel = isFamily && sel >= p.childCount
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
                            <AmazonBadge size={14} /><span className="code">{p.asin || p.sku}</span>
                            {isFamily ? <span className="varc">· {p.childCount} variation{p.childCount === 1 ? '' : 's'}</span> : null}
                          </span>
                        </span>
                        {isFamily
                          ? <button type="button" className={`addbtn ${allSel ? 'on' : ''}`} onClick={() => (allSel ? removeAllChildren(p) : void addAllChildren(p))}>{allSel ? <><Check size={13} /> Added</> : sel > 0 ? <>{sel}/{p.childCount}</> : <><Plus size={13} /> Add all</>}</button>
                          : <button type="button" className={`addbtn ${has(p.id) ? 'on' : ''}`} onClick={() => (has(p.id) ? remove(p.id) : add(p))}>{has(p.id) ? <><Check size={13} /> Added</> : <><Plus size={13} /> Add</>}</button>}
                      </div>
                      {open && (loadingKids.has(p.id) ? (
                        <div className="h10-spw-ps-kidload">Loading variations…</div>
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
              <button type="button" className="addall" disabled={!enterText.trim()} onClick={addEntered}><Plus size={13} /> Add</button>
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
