'use client'

/**
 * "Add Negative Keywords to Ad Group" modal (H10 match) — the ad-group-scoped sibling of the
 * campaign-level AddNegativeKeywordsModal, on the shared .h10-modal-* + .h10-apm layout (same
 * context strip + paste flow as AddNegativeTargetsModal). Pick a Match Type (Negative Exact /
 * Negative Phrase) → paste keywords (one per line) → stage into "N Negative Keywords Added" →
 * submit one POST /api/advertising/negative-keywords per staged keyword with scope='AD_GROUP'
 * (externalCampaignId + externalAdGroupId + marketplace). Write-gated server-side (the gate
 * returns denied → never a silent live push).
 */
import { useMemo, useState } from 'react'
import { X, Trash2, Layers, PlusCircle, ChevronsUpDown } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

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
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal wide apm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add Negative Keywords to Ad Group">
        <div className="h10-modal-h"><b>Add Negative Keywords to Ad Group</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-b">
          <div className="apm-ctx">
            <div className="apm-ctx-c"><span className="lbl">Campaign</span><span className="val">{campaignName || '—'}</span></div>
            <div className="apm-ctx-c"><span className="lbl">Ad group</span><span className="val"><Layers size={15} /> {adGroupName || '—'}</span></div>
          </div>
          <div className="h10-apm">
            <div className="apm-left">
              <div className="apm-mt">
                <span className="lbl">Match Type:</span>
                <label className={matchType === 'NEGATIVE_EXACT' ? 'on' : ''}><input type="radio" name="agnegmt" checked={matchType === 'NEGATIVE_EXACT'} onChange={() => setMatchType('NEGATIVE_EXACT')} /> Negative Exact</label>
                <label className={matchType === 'NEGATIVE_PHRASE' ? 'on' : ''}><input type="radio" name="agnegmt" checked={matchType === 'NEGATIVE_PHRASE'} onChange={() => setMatchType('NEGATIVE_PHRASE')} /> Negative Phrase</label>
              </div>
              <div className="apm-enter no-pad-top">
                <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Negative keywords" />
                <button type="button" className="apm-enterbtn" disabled={!text.trim()} onClick={stage}><PlusCircle size={14} /> Add Negative Keywords</button>
              </div>
            </div>

            <div className="apm-right">
              <div className="apm-rh"><span>{n} Negative Keyword{n === 1 ? '' : 's'} Added</span><button type="button" className="apm-removeall" disabled={!n} onClick={() => setStaged([])}><Trash2 size={14} /> Remove All</button></div>
              <div className="apm-thead"><button type="button" className={`apm-sort ${sortDir ?? ''}`} onClick={toggleSort} aria-label="Sort by keyword">Keyword <ChevronsUpDown size={12} /></button></div>
              {n === 0 ? (
                <div className="apm-rempty">No data</div>
              ) : (
                <div className="apm-rrows">
                  {view.map((s) => (
                    <div className="apm-rrow kw" key={keyOf(s)}>
                      <span className="ai"><span className="t" title={s.keyword}>{s.keyword}</span></span>
                      <span className="apm-mtcol">{mtLabel(s.matchType)}</span>
                      <button type="button" className="apm-x" onClick={() => remove(keyOf(s))} aria-label={`Remove ${s.keyword}`}><X size={15} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {msg && <div className="h10-cd-modalerr">{msg}</div>}
        </div>
        <div className="h10-modal-f">
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="h10-am-btn primary" disabled={!n || submitting} onClick={() => void submit()}>{submitting ? 'Adding…' : `Add to Ad Group${n ? ` (${n})` : ''}`}</button>
        </div>
      </div>
    </div>
  )
}
