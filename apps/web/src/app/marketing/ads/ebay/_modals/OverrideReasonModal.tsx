'use client'

/**
 * ER1 — the guardrail override-reason collector (replaces every
 * window.prompt — critique X4/B-3). Lists what was blocked and why; the
 * reason is audited with the write.
 */
import { useEffect, useState } from 'react'
import { H10Modal, Err } from '../_lib/modal'

export function OverrideReasonModal(props: {
  open: boolean; onClose: () => void
  title?: string
  blockedItems: string[]
  onSubmit: (reason: string) => void | Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (props.open) { setReason(''); setError(null) } }, [props.open])
  const submit = async () => {
    if (!reason.trim()) { setError('a named reason is required — it is written to the audit log'); return }
    setBusy(true); setError(null)
    try { await props.onSubmit(reason.trim()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title={props.title ?? 'Break-even override'}
      subtitle="These changes exceed the margin guardrail. They only proceed with a named reason, which is audited."
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={() => void submit()} disabled={busy || !reason.trim()}>{busy ? 'Applying…' : 'Apply with override'}</button>
      </>}>
      <ul className="eb-results">
        {props.blockedItems.map((b, i) => <li key={i} className="blocked">{b}</li>)}
      </ul>
      <div>
        <label>Override reason (audited)</label>
        <input className="h10-cd-input" style={{ width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. launch push for 2 weeks — accept negative margin" autoFocus />
      </div>
      <Err msg={error} />
    </H10Modal>
  )
}
