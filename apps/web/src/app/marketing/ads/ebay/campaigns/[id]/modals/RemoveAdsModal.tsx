'use client'

/**
 * ER1 — bulk ad removal with consequences stated (replaces window.confirm —
 * critique X4). Reversible: listings can be re-promoted any time.
 */
import { useEffect, useState } from 'react'
import { H10Modal, Err, ResultsList } from '../../../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner, type WriteItemOutcome } from '../../../_lib'

export function RemoveAdsModal(props: { open: boolean; onClose: () => void; campaignId: string; listingIds: string[]; onDone?: () => void }) {
  const mode = useWriteMode()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)
  useEffect(() => { if (props.open) { setError(null); setResults(null) } }, [props.open])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/ads/remove`, { listingIds: props.listingIds })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title={`Remove ${props.listingIds.length} ad(s)?`}
      subtitle="The listings stop being promoted in this campaign."
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>{results ? 'Close' : 'Cancel'}</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || results != null}>{busy ? 'Removing…' : 'Remove ads'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <ul className="eb-results">
        <li className="ok">Reversible — re-promote the listings any time (rates are not remembered).</li>
        <li className="ok">Each listing becomes free for a different General campaign.</li>
      </ul>
      <Err msg={error} />
      {results && <ResultsList results={results} />}
    </H10Modal>
  )
}
