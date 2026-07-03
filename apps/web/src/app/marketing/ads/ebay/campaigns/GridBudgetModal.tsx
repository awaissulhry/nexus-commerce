'use client'

/**
 * ER3.1 — Budget from the Ad Manager row menu (spec delta 6): the Details-tab
 * semantics in a modal — current value, the 15/day meter BEFORE any attempt,
 * the 2×-daily note, guarded write.
 */
import { useEffect, useState } from 'react'
import { H10Modal, Err } from '../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner } from '../_lib'
import { money } from '../../campaigns/_grid/format'

export function GridBudgetModal(props: {
  open: boolean; onClose: () => void
  campaignId: string; campaignName: string
  currentCents: number | null; usedToday: number; currency: string
  onDone?: () => void
}) {
  const mode = useWriteMode()
  const [value, setValue] = useState('5.00')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (props.open) { setValue(props.currentCents != null ? (props.currentCents / 100).toFixed(2) : '5.00'); setError(null) }
  }, [props.open, props.currentCents])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      await postEbayAds(`/campaigns/${props.campaignId}/budget`, { dailyBudgetCents: Math.round(Number(value) * 100) })
      props.onDone?.(); props.onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Daily budget" subtitle={props.campaignName}
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !(Number(value) >= 1)}>{busy ? 'Saving…' : 'Save budget'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <div className="eb-form-row" style={{ alignItems: 'center' }}>
        <div><label>Daily budget ({props.currency})</label>
          <input className="h10-cd-input" style={{ width: 140 }} type="number" min={1} step={0.5} value={value} onChange={(e) => setValue(e.target.value)} /></div>
        <span className={`h10-pill ${props.usedToday >= 12 ? 'warn' : 'arch'}`} title="eBay hard limit: 15 budget updates per campaign per day">{props.usedToday} / 15 edits today</span>
      </div>
      <p className="eb-be-hint">Current: <b>{money(props.currentCents, props.currency)}</b>/day · eBay may spend up to 2× the daily budget on a single day (monthly cap = 30.4× daily).</p>
      <Err msg={error} />
    </H10Modal>
  )
}
