'use client'

/**
 * "Add Negative Keywords to Ad Group" modal (H10 match) — the ad-group-scoped sibling of the
 * campaign-level AddNegativeKeywordsModal, in a Nexus DS <Modal> over .h10-apm (same
 * context strip + paste flow as AddNegativeTargetsModal). Pick a Match Type (Negative Exact /
 * Negative Phrase) → paste keywords (one per line) → stage into "N Negative Keywords Added" →
 * submit one POST /api/advertising/negative-keywords per staged keyword with scope='AD_GROUP'
 * (externalCampaignId + externalAdGroupId + marketplace). Write-gated server-side (the gate
 * returns denied → never a silent live push).
 */
import { useMemo, useState } from 'react'
import { Button, Radio, Textarea, ToolbarButton } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { X, Trash2, Layers, PlusCircle, ChevronsUpDown } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import '../../../../campaigns-ds.css'

type MT = 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'
type Staged = { keyword: string; matchType: MT }
const mtLabel = (m: MT) => (m === 'NEGATIVE_EXACT' ? 'Negative Exact' : 'Negative Phrase')
const keyOf = (s: Staged) => `${s.keyword.toLowerCase()}|${s.matchType}`

export function AddNegativeKeywordsAgModal({ externalCampaignId, externalAdGroupId, marketplace, campaignName, adGroupName, onClose, onAdded }: {
  externalCampaignId: string | null
  externalAdGroupId: string | null
  marketplace: string | null
  campaignName: string
  adGroupName: string
  onClose: () => void
  onAdded?: () => void
}) {
  const [matchType, setMatchType] = useState<MT>('NEGATIVE_EXACT')
  const [text, setText] = useState('')
  const [staged, setStaged] = useState<Staged[]>([])
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const synced = !!externalCampaignId && !!externalAdGroupId && !!marketplace

  const stage = () => {
    const kws = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!kws.length) return
    setStaged((prev) => { const seen = new Set(prev.map(keyOf)); const next = [...prev]; for (const kw of kws) { const s: Staged = { keyword: kw, matchType }; if (!seen.has(keyOf(s))) { seen.add(keyOf(s)); next.push(s) } } return next })
    setText('')
  }
  const remove = (k: string) => setStaged((prev) => prev.filter((s) => keyOf(s) !== k))
  const toggleSort = () => setSortDir((d) => (d === null ? 'asc' : d === 'asc' ? 'desc' : null))
  const view = useMemo(() => (sortDir ? [...staged].sort((a, b) => (sortDir === 'asc' ? a.keyword.localeCompare(b.keyword) : b.keyword.localeCompare(a.keyword))) : staged), [staged, sortDir])

  const submit = async () => {
    if (!staged.length || submitting) return
    if (!synced) { setMsg('This ad group is not synced to Amazon yet — cannot add negatives.'); return }
    setSubmitting(true); setMsg(null)
    const outcomes = await Promise.allSettled(staged.map((s) =>
      fetch(`${getBackendUrl()}/api/advertising/negative-keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId, externalAdGroupId, keywordText: s.keyword, matchType: s.matchType, scope: 'AD_GROUP', marketplace }) })
        .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok || (d as { error?: string; denied?: boolean }).error || (d as { denied?: boolean }).denied) throw new Error('rejected') })))
    const ok = outcomes.filter((r) => r.status === 'fulfilled').length
    setSubmitting(false)
    if (ok === staged.length) { onAdded?.(); onClose() }
    else { setMsg(`${ok}/${staged.length} added — some failed (write-gate / non-live).`); if (ok) onAdded?.() }
  }

  const n = staged.length
  return (
    <Modal
      open
      onClose={onClose}
      size="xxl"
      title="Add Negative Keywords to Ad Group"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!n || submitting} onClick={() => void submit()}>{submitting ? 'Adding…' : `Add to Ad Group${n ? ` (${n})` : ''}`}</Button>
        </>
      }
    >
      <div className="apm-ctx">
        <div className="apm-ctx-c"><span className="lbl">Campaign</span><span className="val">{campaignName || '—'}</span></div>
        <div className="apm-ctx-c"><span className="lbl">Ad group</span><span className="val"><Layers size={15} /> {adGroupName || '—'}</span></div>
      </div>
      <div className="h10-apm">
        <div className="apm-left">
          <div className="apm-mt">
            <span className="lbl">Match Type:</span>
            <Radio name="agnegmt" className={matchType === 'NEGATIVE_EXACT' ? 'on' : undefined} checked={matchType === 'NEGATIVE_EXACT'} onChange={() => setMatchType('NEGATIVE_EXACT')} label="Negative Exact" />
            <Radio name="agnegmt" className={matchType === 'NEGATIVE_PHRASE' ? 'on' : undefined} checked={matchType === 'NEGATIVE_PHRASE'} onChange={() => setMatchType('NEGATIVE_PHRASE')} label="Negative Phrase" />
          </div>
          <div className="apm-enter no-pad-top">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Negative keywords" />
            <Button disabled={!text.trim()} onClick={stage}><PlusCircle size={14} /> Add Negative Keywords</Button>
          </div>
        </div>

        <div className="apm-right">
          <div className="apm-rh"><span>{n} Negative Keyword{n === 1 ? '' : 's'} Added</span><Button size="sm" disabled={!n} onClick={() => setStaged([])}><Trash2 size={14} /> Remove All</Button></div>
          <div className="apm-thead"><Button variant="quiet" size="xs" className={`apm-sortbtn ${sortDir ?? ''}`} onClick={toggleSort} aria-label="Sort by keyword">Keyword <ChevronsUpDown size={12} /></Button></div>
          {n === 0 ? (
            <div className="apm-rempty">No data</div>
          ) : (
            <div className="apm-rrows">
              {view.map((s) => (
                <div className="apm-rrow kw" key={keyOf(s)}>
                  <span className="ai"><span className="t" title={s.keyword}>{s.keyword}</span></span>
                  <span className="apm-mtcol">{mtLabel(s.matchType)}</span>
                  <ToolbarButton size="sm" tone="danger" tooltip={false} icon={<X size={15} />} label={`Remove ${s.keyword}`} onClick={() => remove(keyOf(s))} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {msg && <div className="h10-cd-modalerr">{msg}</div>}
    </Modal>
  )
}
