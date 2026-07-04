'use client'

/**
 * ER1 — End campaign with consequences stated (quality bar; replaces
 * window.confirm — critique X4). ENDED is terminal on eBay.
 */
import { useEffect, useState } from 'react'
import { H10Modal, Err } from '../../../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner } from '../../../_lib'

export function EndCampaignModal(props: { open: boolean; onClose: () => void; campaignId: string; campaignName: string; onDone?: () => void }) {
  const mode = useWriteMode()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (props.open) setError(null) }, [props.open])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      await postEbayAds(`/campaigns/${props.campaignId}/action`, { action: 'end' })
      props.onDone?.(); props.onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="End this campaign?"
      subtitle={props.campaignName}
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn danger-solid" onClick={apply} disabled={busy}>{busy ? 'Ending…' : 'End campaign'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <ul className="eb-results">
        <li className="warn">All ads in this campaign stop serving permanently.</li>
        <li className="warn"><b>ENDED is terminal on eBay</b> — the campaign cannot be resumed. Clone it to relaunch.</li>
        <li className="ok">History, metrics and the Activity log are retained.</li>
        <li className="ok">Its listings become free to promote in another General campaign.</li>
      </ul>
      <Err msg={error} />
    </H10Modal>
  )
}
