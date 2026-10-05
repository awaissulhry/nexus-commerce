'use client'

/**
 * CBN.3 — "Add Negative Keywords to Campaign" modal (H10 match). Two-panel staging flow:
 * pick Match Type (Negative Exact / Phrase) → type keywords (one per line) → "Add Negative
 * Keywords" stages them into the right list ("N Negative Keywords Added" + Remove All) →
 * "Add to Campaign" commits each via POST /advertising/negative-keywords (scope=CAMPAIGN).
 * Shell is the Nexus DS <Modal> (size xxl). Endpoint already on prod (frontend-only).
 */
import { useState } from 'react'
import { Button, Radio, Textarea, ToolbarButton } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { X, Trash2, ChevronsUpDown } from 'lucide-react'
import { adsAdd, addSummary } from '../../../_shared/adsWrite'

type MT = 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'
type Staged = { keyword: string; matchType: MT }
const mtLabel = (m: MT) => (m === 'NEGATIVE_EXACT' ? 'Negative Exact' : 'Negative Phrase')

export function AddNegativeKeywordsModal({ campaignName, badge, externalCampaignId, marketplace, onClose, onDone }: {
  campaignName: string
  badge: string
  externalCampaignId: string | null
  marketplace: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [matchType, setMatchType] = useState<MT>('NEGATIVE_EXACT')
  const [text, setText] = useState('')
  const [staged, setStaged] = useState<Staged[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ fail: number; text: string } | null>(null)

  const stage = () => {
    const kws = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!kws.length) return
    setStaged((prev) => {
      const seen = new Set(prev.map((s) => `${s.keyword.toLowerCase()}|${s.matchType}`))
      const next = [...prev]
      for (const kw of kws) { const k = `${kw.toLowerCase()}|${matchType}`; if (!seen.has(k)) { seen.add(k); next.push({ keyword: kw, matchType }) } }
      return next
    })
    setText('')
  }

  const submit = async () => {
    if (!staged.length || !externalCampaignId || !marketplace || busy) return
    setBusy(true); setResult(null)
    // CM-8/CM-25 — "added" means Amazon holds it; every other answer carries the write gate's or Amazon's reason.
    const results = await Promise.all(staged.map((s) => adsAdd('/api/advertising/negative-keywords',
      { externalCampaignId, keywordText: s.keyword, matchType: s.matchType, scope: 'CAMPAIGN', marketplace })))
    const sum = addSummary(results, 'negative')
    setResult({ fail: results.filter((r) => !r.added).length, text: sum.text }); setBusy(false)
    if (sum.anyAdded) onDone()
    if (sum.allAdded) window.setTimeout(onClose, 800)
    else setStaged((prev) => prev.filter((_, i) => !results[i]!.added))
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xxl"
      title="Add Negative Keywords to Campaign"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <span className="grow" />
          <Button variant="primary" disabled={!staged.length || busy} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add to Campaign'}</Button>
        </>
      }
    >
      <div className="h10-neg-camp">
        <span className="lbl">Campaign</span>
        <span className="val"><span className="h10-cd-badge" data-t={badge}>{badge}</span>{campaignName}</span>
      </div>
      <div className="h10-neg-cols">
        <div className="h10-neg-left">
          <div className="h10-neg-mt">
            <span className="lbl">Match Type:</span>
            <Radio name="negmt" className={matchType === 'NEGATIVE_EXACT' ? 'on' : undefined} checked={matchType === 'NEGATIVE_EXACT'} onChange={() => setMatchType('NEGATIVE_EXACT')} label="Negative Exact" />
            <Radio name="negmt" className={matchType === 'NEGATIVE_PHRASE' ? 'on' : undefined} checked={matchType === 'NEGATIVE_PHRASE'} onChange={() => setMatchType('NEGATIVE_PHRASE')} label="Negative Phrase" />
          </div>
          <Textarea style={{ minHeight: 300 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Negative keywords" />
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}><Button disabled={!text.trim()} onClick={stage}>Add Negative Keywords</Button></div>
        </div>
        <div className="h10-neg-right">
          <div className="h10-neg-rh">
            <span>{staged.length} Negative Keyword{staged.length === 1 ? '' : 's'} Added</span>
            <Button size="sm" disabled={!staged.length} onClick={() => setStaged([])}><Trash2 size={14} /> Remove All</Button>
          </div>
          <div className="h10-neg-lh"><span>Keyword</span><ChevronsUpDown size={13} /></div>
          <div className="h10-neg-list">
            {staged.length === 0 ? <div className="h10-neg-empty">No data</div> : staged.map((s, i) => (
              <div className="h10-neg-row" key={`${s.keyword}|${s.matchType}|${i}`}>
                <span className="kw" title={s.keyword}>{s.keyword}</span>
                <span className="mt">{mtLabel(s.matchType)}</span>
                <ToolbarButton size="sm" tone="danger" tooltip={false} icon={<X size={13} />} label={`Remove ${s.keyword}`} onClick={() => setStaged((p) => p.filter((_, idx) => idx !== i))} />
              </div>
            ))}
          </div>
        </div>
      </div>
      {result && <div className={result.fail ? 'h10-cd-modalerr' : 'h10-st-ok'}>{result.text}.</div>}
    </Modal>
  )
}
