'use client'

/**
 * "Add Negative Target ASINs to Ad Group" modal (H10 match) — reuses the shared .h10-modal-*
 * shell + the .h10-apm two-pane layout from AddProductsModal. A context strip shows the
 * Campaign + Ad group it scopes to; LEFT is a paste-ASINs textarea + "Add Negative Target
 * ASINs"; RIGHT stages the "N Negative Target ASINs Added" list (ASIN column, sortable).
 * Submit creates one negative product target per ASIN → POST /api/advertising/negative-targets/
 * create { adGroupId, asin } (DB write + Amazon push gated by the ads write gate — never a
 * silent live push). No search pane: a negative-target ASIN is an arbitrary competitor ASIN.
 */
import { useMemo, useState } from 'react'
import { X, Trash2, Layers, PlusCircle, ChevronsUpDown } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export function AddNegativeTargetsModal({ adGroupId, adGroupName, campaignName, onClose, onAdded }: {
  adGroupId: string
  adGroupName: string
  campaignName: string
  onClose: () => void
  onAdded?: () => void
}) {
  const [text, setText] = useState('')
  const [staged, setStaged] = useState<string[]>([])
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const stage = () => {
    const asins = text.split(/[\n,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (!asins.length) return
    setStaged((prev) => { const seen = new Set(prev); const next = [...prev]; for (const a of asins) if (!seen.has(a)) { seen.add(a); next.push(a) } return next })
    setText('')
  }
  const remove = (a: string) => setStaged((prev) => prev.filter((x) => x !== a))
  const toggleSort = () => setSortDir((d) => (d === null ? 'asc' : d === 'asc' ? 'desc' : null))
  const view = useMemo(() => (sortDir ? [...staged].sort((a, b) => (sortDir === 'asc' ? a.localeCompare(b) : b.localeCompare(a))) : staged), [staged, sortDir])

  const submit = async () => {
    if (!staged.length || submitting) return
    setSubmitting(true); setMsg(null)
    const outcomes = await Promise.allSettled(staged.map((asin) =>
      fetch(`${getBackendUrl()}/api/advertising/negative-targets/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId, asin }) })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })))
    const ok = outcomes.filter((r) => r.status === 'fulfilled').length
    setSubmitting(false)
    if (ok === staged.length) { onAdded?.(); onClose() }
    else { setMsg(`${ok}/${staged.length} added — some failed (write-gate / non-live).`); if (ok) onAdded?.() }
  }

  const n = staged.length
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal wide apm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add Negative Target ASINs to Ad Group">
        <div className="h10-modal-h"><b>Add Negative Target ASINs to Ad Group</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-b">
          <div className="apm-ctx">
            <div className="apm-ctx-c"><span className="lbl">Campaign</span><span className="val">{campaignName || '—'}</span></div>
            <div className="apm-ctx-c"><span className="lbl">Ad group</span><span className="val"><Layers size={15} /> {adGroupName || '—'}</span></div>
          </div>
          <div className="h10-apm">
            <div className="apm-left">
              <div className="apm-enter">
                <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste negative target ASINs here" aria-label="Negative target ASINs" />
                <button type="button" className="apm-enterbtn" disabled={!text.trim()} onClick={stage}><PlusCircle size={14} /> Add Negative Target ASINs</button>
              </div>
            </div>

            <div className="apm-right">
              <div className="apm-rh"><span>{n} Negative Target ASIN{n === 1 ? '' : 's'} Added</span><button type="button" className="apm-removeall" disabled={!n} onClick={() => setStaged([])}><Trash2 size={14} /> Remove All</button></div>
              <div className="apm-thead"><button type="button" className={`apm-sort ${sortDir ?? ''}`} onClick={toggleSort} aria-label="Sort by ASIN">ASIN <ChevronsUpDown size={12} /></button></div>
              {n === 0 ? (
                <div className="apm-rempty">No data</div>
              ) : (
                <div className="apm-rrows">
                  {view.map((a) => (
                    <div className="apm-rrow asin" key={a}>
                      <span className="apm-azc" aria-hidden><svg viewBox="0 0 24 24" width="10" height="10"><path d="M3.6 13.4c4.7 3.1 11.6 3.1 16.4.2" fill="none" stroke="#ff9900" strokeWidth="2.4" strokeLinecap="round" /><path d="M17.2 14.7l3.2-1.2-.8 3.3z" fill="#ff9900" /></svg></span>
                      <span className="ai"><span className="t">{a}</span></span>
                      <button type="button" className="apm-x" onClick={() => remove(a)} aria-label={`Remove ${a}`}><X size={15} /></button>
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
