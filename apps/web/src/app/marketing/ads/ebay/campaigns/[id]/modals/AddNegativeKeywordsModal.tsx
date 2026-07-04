'use client'

/**
 * ER1 — add negative keywords (ported; renamed per D5). EXACT + PHRASE only
 * (verified — teardown §6 #5). Prefill support for Search Terms → negative.
 */
import { useEffect, useState } from 'react'
import { H10Select } from '../../../../campaigns/FilterDropdown'
import { H10Modal, Err, ResultsList } from '../../../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner, type WriteItemOutcome } from '../../../_lib'

export function AddNegativeKeywordsModal(props: {
  open: boolean; onClose: () => void; campaignId: string
  adGroups: Array<{ id: string; name: string }>
  prefillText?: string; prefillAdGroupId?: string
  onDone?: () => void
}) {
  const mode = useWriteMode()
  const [adGroupId, setAdGroupId] = useState('')
  const [text, setText] = useState('')
  const [matchType, setMatchType] = useState<'EXACT' | 'PHRASE'>('EXACT')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (props.open) {
      setResults(null); setError(null)
      setAdGroupId(props.prefillAdGroupId ?? props.adGroups[0]?.id ?? '')
      setText(props.prefillText ?? '')
    }
  }, [props.open, props.adGroups, props.prefillText, props.prefillAdGroupId])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const negatives = text.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t, matchType }))
      if (!negatives.length) throw new Error('add at least one negative keyword')
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/negatives`, { adGroupId, negatives })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Add negative keywords" subtitle="EXACT or PHRASE only — eBay does not support broad negatives"
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !adGroupId || results != null}>{busy ? 'Adding…' : 'Add negatives'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <div className="eb-form-row">
        <div style={{ flex: 1 }}><label>Ad group</label>
          <H10Select ariaLabel="Ad group" width="100%" value={adGroupId} onChange={setAdGroupId} options={props.adGroups.map((g) => ({ value: g.id, label: g.name }))} />
        </div>
        <div><label>Match</label>
          <H10Select ariaLabel="Match type" width={130} value={matchType} onChange={(v) => setMatchType(v as 'EXACT' | 'PHRASE')} options={['EXACT', 'PHRASE'].map((m) => ({ value: m, label: m }))} />
        </div>
      </div>
      <div><label>Negatives — one per line</label><textarea className="eb-textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} /></div>
      <Err msg={error} />
      {results && <ResultsList results={results} />}
    </H10Modal>
  )
}
