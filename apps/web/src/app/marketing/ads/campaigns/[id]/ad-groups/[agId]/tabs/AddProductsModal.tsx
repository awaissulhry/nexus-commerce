'use client'

/**
 * "Add Products to Ad Group" modal (H10 match) — reuses the shared .h10-modal-* shell.
 * Two panes: LEFT searches the catalog (Search for Products → GET /api/products/search;
 * Enter Products → paste names/ASINs/SKUs), RIGHT is the staged "N Products Added" list.
 * Submit creates one product ad per staged item → POST /api/advertising/product-ads/create
 * { adGroupId, sku, productId } (DB write + Amazon push, the latter gated by the ads write
 * gate — so it never silently pushes live). The "Sponsored Videos [New]" column is a parity
 * placeholder (no SV creative source yet), exactly as the campaign grids treat such fields.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, PlusCircle, Check, Trash2, Copy } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Prod { id: string; sku?: string | null; asin?: string | null; name?: string | null; imageUrl?: string | null; amazon?: boolean }

/** Amazon channel badge (orange smile on Amazon squid-ink) — shown for Amazon-listed products. */
function AzBadge() {
  return (
    <span className="apm-az" aria-hidden>
      <svg viewBox="0 0 24 24" width="10" height="10">
        <path d="M3.6 13.4c4.7 3.1 11.6 3.1 16.4.2" fill="none" stroke="#ff9900" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M17.2 14.7l3.2-1.2-.8 3.3z" fill="#ff9900" />
      </svg>
    </span>
  )
}

function Thumb({ p }: { p: Prod }) {
  return (
    <span className="apm-thumb">
      {p.imageUrl ? <img src={p.imageUrl} alt="" /> : <span className="ph" />}
      {p.amazon ? <AzBadge /> : null}
    </span>
  )
}

export function AddProductsModal({ adGroupId, onClose, onAdded }: { adGroupId: string; onClose: () => void; onAdded?: () => void }) {
  const [tab, setTab] = useState<'search' | 'enter'>('search')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Prod[]>([])
  const [loading, setLoading] = useState(false)
  const [enterText, setEnterText] = useState('')
  const [added, setAdded] = useState<Prod[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const addedKeys = useMemo(() => new Set(added.map((p) => p.id || p.sku || p.asin || '')), [added])
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (tab !== 'search') return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      const term = q.trim()
      setLoading(true)
      fetch(`${getBackendUrl()}/api/products/search?q=${encodeURIComponent(term)}&limit=25`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => setResults(((d.items ?? []) as Array<Prod & { syncChannels?: string[]; channelKeys?: string[] }>).map((p) => ({
          id: p.id, sku: p.sku, asin: p.asin, name: p.name, imageUrl: p.imageUrl,
          amazon: (Array.isArray(p.syncChannels) && p.syncChannels.includes('AMAZON')) || (Array.isArray(p.channelKeys) && p.channelKeys.some((k) => k.startsWith('AMAZON'))) || !!p.asin,
        }))))
        .catch(() => setResults([]))
        .finally(() => setLoading(false))
    }, 250)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [q, tab])

  const keyOf = (p: Prod) => p.id || p.sku || p.asin || ''
  const add = (p: Prod) => setAdded((prev) => (addedKeys.has(keyOf(p)) ? prev : [...prev, p]))
  const addAll = () => setAdded((prev) => { const seen = new Set(prev.map(keyOf)); return [...prev, ...results.filter((p) => !seen.has(keyOf(p)))] })
  const remove = (k: string) => setAdded((prev) => prev.filter((p) => keyOf(p) !== k))
  const copy = (s: string) => { try { void navigator.clipboard?.writeText(s) } catch { /* clipboard unavailable */ } setCopied(s); setTimeout(() => setCopied((c) => (c === s ? null : c)), 1200) }
  const enterAdd = () => {
    const tokens = enterText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
    if (!tokens.length) return
    setAdded((prev) => { const seen = new Set(prev.map(keyOf)); const next = [...prev]; for (const t of tokens) { const isAsin = /^B0[A-Z0-9]{8}$/i.test(t); const p: Prod = isAsin ? { id: t, asin: t.toUpperCase(), name: t.toUpperCase(), amazon: true } : { id: t, sku: t, name: t }; if (!seen.has(keyOf(p))) { seen.add(keyOf(p)); next.push(p) } } return next })
    setEnterText('')
  }

  const submit = async () => {
    if (!added.length || submitting) return
    setSubmitting(true); setMsg(null)
    const outcomes = await Promise.allSettled(added.map((p) =>
      fetch(`${getBackendUrl()}/api/advertising/product-ads/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId, sku: p.sku ?? null, asin: p.asin ?? null, productId: p.id && !p.sku && !p.asin ? null : p.id }) })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })))
    const ok = outcomes.filter((r) => r.status === 'fulfilled').length
    setSubmitting(false)
    if (ok === added.length) { onAdded?.(); onClose() }
    else { setMsg(`${ok}/${added.length} added — some failed (write-gate / non-live).`); if (ok) onAdded?.() }
  }

  // Product name + primary-code(copy) · secondary line, shared by both panes. The search
  // projection has SKU (not ASIN), so SKU is the code; manual ASIN entries show the ASIN.
  const Meta = (p: Prod) => {
    const code = p.asin || p.sku || ''
    const sub = p.asin && p.sku ? p.sku : ''
    const codeLabel = p.asin ? 'ASIN' : 'SKU'
    return (
      <div className="ai">
        <span className="t" title={p.name ?? ''}>{p.name || p.sku || p.asin}</span>
        <span className="m">
          {code ? (
            <>
              <span className="asin">{code}</span>
              <button type="button" className="apm-cp" onClick={() => copy(code)} title={copied === code ? 'Copied' : `Copy ${codeLabel}`} aria-label={`Copy ${codeLabel}`}>{copied === code ? <Check size={11} /> : <Copy size={11} />}</button>
            </>
          ) : '—'}
          {sub ? <><span className="sep">·</span><span className="sku">{sub}</span></> : null}
        </span>
      </div>
    )
  }

  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal wide apm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add Products to Ad Group">
        <div className="h10-modal-h"><b>Add Products to Ad Group</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-b">
          <div className="h10-apm">
            <div className="apm-left">
              <div className="apm-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Search for Products</button>
                <button type="button" role="tab" aria-selected={tab === 'enter'} className={tab === 'enter' ? 'on' : ''} onClick={() => setTab('enter')}>Enter Products</button>
              </div>
              {tab === 'search' ? (
                <>
                  <div className="apm-srow">
                    <div className="apm-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by product name, ASIN, or SKU" aria-label="Search products" /></div>
                  </div>
                  <div className="apm-count">
                    <span>{loading ? 'Searching…' : `Viewing ${results.length ? `1-${results.length}` : 0} of ${results.length} Products`}</span>
                    <button type="button" className="apm-addall" disabled={!results.length} onClick={addAll}><PlusCircle size={14} /> Add All</button>
                  </div>
                  <div className="apm-list">
                    {results.length === 0 ? <div className="apm-none">{loading ? '' : 'No products match your search.'}</div> : results.map((p) => {
                      const on = addedKeys.has(keyOf(p))
                      return (
                        <div className="apm-item" key={keyOf(p)}>
                          <Thumb p={p} />
                          {Meta(p)}
                          <button type="button" className={`apm-add ${on ? 'added' : ''}`} disabled={on} onClick={() => add(p)}>{on ? <><Check size={14} /> Added</> : <><PlusCircle size={14} /> Add</>}</button>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="apm-enter">
                  <textarea value={enterText} onChange={(e) => setEnterText(e.target.value)} placeholder="Paste product names, ASINs, or SKUs (one per line)" aria-label="Enter products" />
                  <button type="button" className="apm-enterbtn" disabled={!enterText.trim()} onClick={enterAdd}><PlusCircle size={14} /> Add Products</button>
                </div>
              )}
            </div>

            <div className="apm-right">
              <div className="apm-rh"><span>{added.length} Products Added</span><button type="button" className="apm-removeall" disabled={!added.length} onClick={() => setAdded([])}><Trash2 size={14} /> Remove All</button></div>
              <div className="apm-thead"><span>Product</span><span className="sv">Sponsored Videos <i className="new">New</i></span></div>
              {added.length === 0 ? (
                <div className="apm-rempty">No data</div>
              ) : (
                <div className="apm-rrows">
                  {added.map((p) => (
                    <div className="apm-rrow" key={keyOf(p)}>
                      <Thumb p={p} />
                      {Meta(p)}
                      <span className="sv">—</span>
                      <button type="button" className="apm-x" onClick={() => remove(keyOf(p))} aria-label="Remove"><X size={15} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {msg && <div className="h10-cd-modalerr">{msg}</div>}
        </div>
        <div className="h10-modal-f">
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="h10-am-btn primary" disabled={!added.length || submitting} onClick={() => void submit()}>{submitting ? 'Adding…' : `Add to Ad Group${added.length ? ` (${added.length})` : ''}`}</button>
        </div>
      </div>
    </div>
  )
}
