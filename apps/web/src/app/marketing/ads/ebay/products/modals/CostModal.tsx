'use client'

/**
 * ER1 — product cost (COGS) entry modal (moved verbatim from _write-modals.tsx per C1: one file per
 * modal; products-page scope).
 */
import { useEffect, useState } from 'react'
import { H10Modal, Err } from '../../_lib/modal'
import { postEbayAds } from '../../_lib'

// ── Product cost entry (the ONE operator input the margin engine waits on) ───
export function CostModal(props: { open: boolean; onClose: () => void; itemId: string; marketplace: string; listingTitle: string | null; productSku: string | null; currentCostCents: number | null; onDone?: () => void }) {
  const [costEur, setCostEur] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ breakEvenAdRatePct: number | null; updatedProducts: string[] } | null>(null)
  useEffect(() => {
    if (props.open) { setCostEur(props.currentCostCents != null ? (props.currentCostCents / 100).toFixed(2) : ''); setError(null); setDone(null) }
  }, [props.open, props.itemId, props.currentCostCents])

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ breakEvenAdRatePct: number | null; updatedProducts: string[] }>('/products/cost', { itemId: props.itemId, marketplace: props.marketplace, costEur: Number(costEur) })
      setDone(out)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Product cost (COGS)"
      subtitle={`${props.listingTitle ?? props.itemId} — unit cost in EUR. Applies to ${props.productSku ?? "the listing's matched product(s)"}; break-even ad rate recomputes immediately. Refine per-variant later in the product editor.`}
      footer={done ? <>
        <button type="button" className="h10-am-btn primary" onClick={props.onClose}>Done</button>
      </> : <>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={() => void save()} disabled={busy || !(Number(costEur) > 0)}>{busy ? 'Saving…' : 'Save cost'}</button>
      </>}>
      {done ? (
        <ul className="eb-results">
          <li className="ok">Cost saved on {done.updatedProducts.join(', ')}</li>
          <li className={done.breakEvenAdRatePct != null ? 'ok' : 'warn'}>
            {done.breakEvenAdRatePct != null
              ? `Break-even ad rate: ${done.breakEvenAdRatePct}% — automations can now clamp to it`
              : 'Break-even still unavailable (check listing price)'}
          </li>
        </ul>
      ) : (
        <div>
          <label>Unit cost €</label>
          <input className="h10-cd-input" style={{ width: 140 }} type="number" min={0.01} step={0.01} value={costEur} onChange={(e) => setCostEur(e.target.value)} autoFocus />
        </div>
      )}
      <Err msg={error} />
    </H10Modal>
  )
}
