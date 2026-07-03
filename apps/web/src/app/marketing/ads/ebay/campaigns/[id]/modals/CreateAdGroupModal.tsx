'use client'

/**
 * ER1 — create an ad group (PRI-manual). Mirrors Amazon's CreateAdGroupModal
 * role; POST /ebay-ads/campaigns/:id/ad-groups (guarded write, audited).
 */
import { useEffect, useState } from 'react'
import { H10Modal, Err } from '../../../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner } from '../../../_lib'

export function CreateAdGroupModal(props: { open: boolean; onClose: () => void; campaignId: string; onDone?: () => void }) {
  const mode = useWriteMode()
  const [name, setName] = useState('')
  const [bidEur, setBidEur] = useState('0.30')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (props.open) { setName(''); setBidEur('0.30'); setError(null) } }, [props.open])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      await postEbayAds(`/campaigns/${props.campaignId}/ad-groups`, { name: name.trim(), defaultBidCents: Math.round(Number(bidEur) * 100) })
      props.onDone?.(); props.onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Create ad group"
      subtitle="eBay allows up to 500 ad groups per campaign; keywords and negatives live under the group."
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create ad group'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <div className="eb-form-row">
        <div style={{ flex: 1 }}><label>Name</label><input className="h10-cd-input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jackets — brand terms" /></div>
        <div><label>Default bid (EUR)</label><input className="h10-cd-input" style={{ width: 110 }} type="number" min={0.02} step={0.01} value={bidEur} onChange={(e) => setBidEur(e.target.value)} /></div>
      </div>
      <Err msg={error} />
    </H10Modal>
  )
}
