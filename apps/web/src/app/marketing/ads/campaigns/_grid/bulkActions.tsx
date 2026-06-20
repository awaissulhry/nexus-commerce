'use client'

/**
 * CBN.3 — shared bulk-action helpers for the AdsDataGrid `selectionActions` slot. `bulkPatch`
 * fires one PATCH per selected id against /api/advertising/<base>/<id>; AdjustBidModal is the
 * shared "set bid for N selected" dialog used by Ad Groups (Default Bid) and Targets (Bid).
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

/** PATCH the same body to /api/advertising/<base>/<id> for every id (applyImmediately:false). */
export async function bulkPatch(base: string, ids: string[], body: Record<string, unknown>): Promise<void> {
  await Promise.all(ids.map((id) => fetch(`${getBackendUrl()}/api/advertising/${base}/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, applyImmediately: false }),
  })))
}

export function AdjustBidModal({ count, noun, bidLabel = 'Bid', currency = '€', onClose, onApply }: {
  count: number; noun: string; bidLabel?: string; currency?: string; onClose: () => void; onApply: (bidEur: number) => Promise<void>
}) {
  const [bid, setBid] = useState('0.50')
  const [busy, setBusy] = useState(false)
  const valid = Number(bid) > 0
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Adjust ${bidLabel}`}>
        <div className="h10-modal-h"><b>Adjust {bidLabel}</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">Set the {bidLabel.toLowerCase()} for {count} selected {noun}{count === 1 ? '' : 's'}.</div>
        <div className="h10-modal-b">
          <div className="h10-cd-field s"><label>{bidLabel}</label>
            <div className="h10-cd-money"><span className="pf">{currency}</span><input type="number" min="0.02" step="0.01" value={bid} onChange={(e) => setBid(e.target.value)} autoFocus aria-label={bidLabel} /></div>
          </div>
        </div>
        <div className="h10-modal-f">
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <button type="button" className="h10-am-btn primary" disabled={!valid || busy} onClick={async () => { setBusy(true); try { await onApply(Number(bid)) } finally { setBusy(false) } }}>{busy ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>
    </div>
  )
}
