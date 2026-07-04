'use client'

/**
 * ER1 — add keywords to an ad group (ported from _write-modals.tsx, C1: one
 * file per modal) + prefill support for the Search Terms → keyword flow.
 */
import { useEffect, useState } from 'react'
import { H10Select } from '../../../../campaigns/FilterDropdown'
import { H10Modal, Err, ResultsList } from '../../../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner, type WriteItemOutcome } from '../../../_lib'

export function AddKeywordsModal(props: {
  open: boolean; onClose: () => void; campaignId: string
  adGroups: Array<{ id: string; name: string }>
  prefillText?: string; prefillAdGroupId?: string
  onDone?: () => void
}) {
  const mode = useWriteMode()
  const [adGroupId, setAdGroupId] = useState('')
  const [text, setText] = useState('')
  const [matchType, setMatchType] = useState('PHRASE')
  const [bid, setBid] = useState('0.30')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)
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
      const keywords = text.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t, matchType, bidCents: Math.round(Number(bid) * 100) }))
      if (!keywords.length) throw new Error('add at least one keyword (one per line)')
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/keywords`, { adGroupId, keywords })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Add keywords" subtitle="One per line · ≤100 chars · ≤10 words · BROAD / PHRASE / EXACT"
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !adGroupId || results != null}>{busy ? 'Adding…' : 'Add keywords'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <div className="eb-form-row">
        <div style={{ flex: 1 }}><label>Ad group</label>
          <H10Select ariaLabel="Ad group" width="100%" value={adGroupId} onChange={setAdGroupId} options={props.adGroups.map((g) => ({ value: g.id, label: g.name }))} />
        </div>
        <div><label>Match</label>
          <H10Select ariaLabel="Match type" width={130} value={matchType} onChange={setMatchType} options={['EXACT', 'PHRASE', 'BROAD'].map((m) => ({ value: m, label: m }))} />
        </div>
        <div><label>Bid (EUR)</label><input className="h10-cd-input" style={{ width: 90 }} type="number" min={0.02} max={100} step={0.01} value={bid} onChange={(e) => setBid(e.target.value)} /></div>
      </div>
      <div><label>Keywords</label><textarea className="eb-textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'giacca moto uomo\ngiubbotto moto impermeabile'} /></div>
      <Err msg={error} />
      {results && <ResultsList results={results} />}
    </H10Modal>
  )
}
