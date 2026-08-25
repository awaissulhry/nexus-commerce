'use client'

/**
 * CBN.3 — shared bulk-action helpers for the AdsDataGrid `selectionActions` slot. `bulkPatch`
 * fires one PATCH per selected id against /api/advertising/<base>/<id>; AdjustBidModal is the
 * shared "set bid for N selected" dialog used by Ad Groups (Default Bid) and Targets (Bid).
 */
import { useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'

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
    <Modal
      open
      onClose={onClose}
      title={<>Adjust {bidLabel}</>}
      subtitle={<>Set the {bidLabel.toLowerCase()} for {count} selected {noun}{count === 1 ? '' : 's'}.</>}
      footer={
        <>
<Button onClick={onClose}>Cancel</Button>
          <span className="grow" />
     <Button variant="primary" disabled={!valid || busy} onClick={async () => { setBusy(true); try { await onApply(Number(bid)) } finally { setBusy(false) } }}>{busy ? 'Applying…' : 'Apply'}</Button>
        </>
      }
    >
      <div className="h10-cd-field s"><label>{bidLabel}</label>
        <div className="h10-cd-money"><span className="pf">{currency}</span><input type="number" min="0.02" step="0.01" value={bid} onChange={(e) => setBid(e.target.value)} autoFocus aria-label={bidLabel} /></div>
      </div>
    </Modal>
  )
}
