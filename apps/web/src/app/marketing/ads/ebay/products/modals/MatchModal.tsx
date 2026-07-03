'use client'

/**
 * ER1 — listing→product Match modal (moved verbatim from _write-modals.tsx per C1: one file per
 * modal; products-page scope).
 */
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { H10Modal, Err } from '../../_lib/modal'
import { postEbayAds } from '../../_lib'

// ── Match a listing to a catalog product (unlocks costs + break-evens) ──────
interface MatchCandidate { id: string; sku: string; name: string; costPriceCents: number | null; suggested: boolean }

export function MatchModal(props: { open: boolean; onClose: () => void; itemId: string; marketplace: string; listingTitle: string | null; onDone?: () => void }) {
  const [q, setQ] = useState('')
  const [cands, setCands] = useState<MatchCandidate[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.open) return
    setQ(''); setPick(null); setError(null); setCands(null)
  }, [props.open, props.itemId])

  useEffect(() => {
    if (!props.open) return
    const t = setTimeout(() => {
      const params = new URLSearchParams({ itemId: props.itemId, marketplace: props.marketplace, ...(q.trim() ? { q: q.trim() } : {}) })
      fetch(`${getBackendUrl()}/api/ebay-ads/products/match-candidates?${params}`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j: { candidates: MatchCandidate[] }) => setCands(j.candidates))
        .catch((e) => setError((e as Error).message))
    }, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [props.open, props.itemId, props.marketplace, q])

  const save = async () => {
    if (!pick) return
    setBusy(true); setError(null)
    try {
      await postEbayAds('/products/match', { itemId: props.itemId, marketplace: props.marketplace, productId: pick })
      props.onDone?.(); props.onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Match listing to product" wide
      subtitle={`${props.listingTitle ?? props.itemId} — pick the catalog product behind this eBay listing. Suggestions are title-similarity only; your confirmation is what links them. Sticky across syncs.`}
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={() => void save()} disabled={busy || !pick}>{busy ? 'Matching…' : 'Match'}</button>
      </>}>
      <div>
        <label>Search catalog (name / SKU) — leave empty for suggestions</label>
        <input className="h10-cd-input" style={{ width: '100%' }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. GALE, VENTRA, slider…" />
      </div>
      {cands == null ? (
        <p className="eb-be-hint">Loading candidates…</p>
      ) : cands.length === 0 ? (
        <p className="eb-be-hint">No candidates — try a search term.</p>
      ) : (
        <ul className="eb-results" style={{ maxHeight: 300 }}>
          {cands.map((c) => (
            <li key={c.id} className={pick === c.id ? 'ok' : ''} style={{ cursor: 'pointer' }} onClick={() => setPick(c.id)}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="radio" name="match-candidate" checked={pick === c.id} onChange={() => setPick(c.id)} />
                <span style={{ flex: 1 }}>{c.name}</span>
                <code>{c.sku}</code>
                {c.suggested && <span className="h10-pill arch">suggested</span>}
                {c.costPriceCents != null && <span className="h10-pill ok">cost €{(c.costPriceCents / 100).toFixed(2)}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <Err msg={error} />
    </H10Modal>
  )
}

