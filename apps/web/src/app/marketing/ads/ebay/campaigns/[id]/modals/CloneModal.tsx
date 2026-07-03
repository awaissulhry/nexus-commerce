'use client'

/**
 * ER1 — clone-by-rematerialization (ported from _write-modals.tsx): structure
 * always copies; CPC groups/keywords/negatives + scoped rules rematerialize;
 * General ads copy only from ENDED sources. Shows per-kind counts.
 */
import { useEffect, useState } from 'react'
import { H10Modal, Err } from '../../../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner } from '../../../_lib'

export function CloneModal(props: { open: boolean; onClose: () => void; campaignId: string; sourceName: string; onDone?: (newId: string) => void }) {
  const mode = useWriteMode()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ campaignId: string; counts?: Record<string, number> } | null>(null)
  useEffect(() => { if (props.open) { setName(`${props.sourceName} (copy)`); setError(null); setDone(null) } }, [props.open, props.sourceName])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ campaignId: string; counts?: Record<string, number> }>(`/campaigns/${props.campaignId}/clone`, { name })
      setDone(out)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Clone campaign"
      subtitle="Structure always copies. Keywords/ad groups/negatives + scoped rules rematerialize; General ads copy only from ENDED sources (a live campaign still owns its listings). Selection rules become editable in the clone flow."
      footer={done ? <>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={() => { props.onDone?.(done.campaignId); props.onClose() }}>Open clone</button>
      </> : <>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !name.trim()}>{busy ? 'Cloning…' : 'Clone'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      {done ? (
        <ul className="eb-results">
          <li className="ok">Campaign created</li>
          {done.counts && Object.entries(done.counts).filter(([, v]) => v > 0).map(([k, v]) => (
            <li key={k} className={k === 'skippedAds' ? 'warn' : 'ok'}>
              {k === 'skippedAds' ? `${v} ad(s) NOT copied — source is live and still owns its listings (use the builder's "move" to transfer)` : `${v} ${k} copied`}
            </li>
          ))}
        </ul>
      ) : (
        <div><label>New campaign name</label><input className="h10-cd-input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} /></div>
      )}
      <Err msg={error} />
    </H10Modal>
  )
}
