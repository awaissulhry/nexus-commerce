'use client'

/**
 * "Add Keywords & Targets to Ad Group" modal (H10 match) — the richest of the ad-group
 * creation flows, on the shared .h10-modal-* + .h10-apm layout (context strip + staged
 * right pane like the negatives modals). Two tabs:
 *   • Keyword Targeting — pick one or more Match Types (Broad / Phrase / Exact) + a Bid,
 *     paste keywords (one per line) → stages one row per keyword × match type.
 *   • Product Targeting — a Bid + paste ASINs → stages PRODUCT targets.
 * Submit fans out, write-gated server-side:
 *   keyword → POST /advertising/keywords/create { adGroupId, keywordText, matchType, bidEur }
 *   product → POST /advertising/targets/create  { adGroupId, kind:'PRODUCT', value, bidEur }
 */
import { useMemo, useState } from 'react'
import { X, Trash2, Layers, PlusCircle, ChevronsUpDown } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type KMatch = 'BROAD' | 'PHRASE' | 'EXACT'
type Staged = { kind: 'keyword' | 'product'; value: string; matchType?: KMatch; bid: number }
const TYPE_LABEL: Record<string, string> = { BROAD: 'Broad', PHRASE: 'Phrase', EXACT: 'Exact' }
const keyOf = (s: Staged) => `${s.kind}|${s.value.toLowerCase()}|${s.matchType ?? ''}`

export function AddKeywordsTargetsModal({ adGroupId, adGroupName, campaignName, defaultBidEur, onClose, onAdded }: {
  adGroupId: string
  adGroupName: string
  campaignName: string
  defaultBidEur: number
  onClose: () => void
  onAdded?: () => void
}) {
  const [tab, setTab] = useState<'keyword' | 'product'>('keyword')
  const [matches, setMatches] = useState<Record<KMatch, boolean>>({ BROAD: true, PHRASE: false, EXACT: false })
  const [bid, setBid] = useState(defaultBidEur.toFixed(2))
  const [text, setText] = useState('')
  const [staged, setStaged] = useState<Staged[]>([])
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const bidNum = Math.max(0, parseFloat(bid) || 0)
  const checkedMatches = (Object.keys(matches) as KMatch[]).filter((m) => matches[m])

  const addStaged = (items: Staged[]) => setStaged((prev) => { const seen = new Set(prev.map(keyOf)); const next = [...prev]; for (const it of items) if (!seen.has(keyOf(it))) { seen.add(keyOf(it)); next.push(it) } return next })
  const stageKeywords = () => {
    const kws = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!kws.length || !checkedMatches.length) return
    addStaged(kws.flatMap((kw) => checkedMatches.map((m) => ({ kind: 'keyword' as const, value: kw, matchType: m, bid: bidNum }))))
    setText('')
  }
  const stageProducts = () => {
    const asins = text.split(/[\n,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (!asins.length) return
    addStaged(asins.map((a) => ({ kind: 'product' as const, value: a, bid: bidNum })))
    setText('')
  }
  const remove = (k: string) => setStaged((prev) => prev.filter((s) => keyOf(s) !== k))
  const toggleSort = () => setSortDir((d) => (d === null ? 'asc' : d === 'asc' ? 'desc' : null))
  const view = useMemo(() => (sortDir ? [...staged].sort((a, b) => (sortDir === 'asc' ? a.value.localeCompare(b.value) : b.value.localeCompare(a.value))) : staged), [staged, sortDir])

  const submit = async () => {
    if (!staged.length || submitting) return
    setSubmitting(true); setMsg(null)
    const outcomes = await Promise.allSettled(staged.map((s) => {
      const url = s.kind === 'keyword' ? '/api/advertising/keywords/create' : '/api/advertising/targets/create'
      const body = s.kind === 'keyword'
        ? { adGroupId, keywordText: s.value, matchType: s.matchType, bidEur: s.bid }
        : { adGroupId, kind: 'PRODUCT', value: s.value, bidEur: s.bid }
      return fetch(`${getBackendUrl()}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok || (d as { error?: string; denied?: boolean }).error || (d as { denied?: boolean }).denied) throw new Error('rejected') })
    }))
    const ok = outcomes.filter((r) => r.status === 'fulfilled').length
    setSubmitting(false)
    if (ok === staged.length) { onAdded?.(); onClose() }
    else { setMsg(`${ok}/${staged.length} added — some failed (write-gate / non-live).`); if (ok) onAdded?.() }
  }

  const n = staged.length
  const BidField = (
    <div className="apm-bid">
      <span className="lbl">Bid:</span>
      <span className="apm-bidbox"><span className="cur">€</span><input inputMode="decimal" value={bid} onChange={(e) => setBid(e.target.value)} aria-label="Bid" /></span>
    </div>
  )

  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal wide apm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add Keywords and Targets to Ad Group">
        <div className="h10-modal-h"><b>Add Keywords &amp; Targets to Ad Group</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-b">
          <div className="apm-ctx">
            <div className="apm-ctx-c"><span className="lbl">Campaign</span><span className="val">{campaignName || '—'}</span></div>
            <div className="apm-ctx-c"><span className="lbl">Ad group</span><span className="val"><Layers size={15} /> {adGroupName || '—'}</span></div>
          </div>
          <div className="h10-apm">
            <div className="apm-left">
              <div className="apm-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'keyword'} className={tab === 'keyword' ? 'on' : ''} onClick={() => { setTab('keyword'); setText('') }}>Keyword Targeting</button>
                <button type="button" role="tab" aria-selected={tab === 'product'} className={tab === 'product' ? 'on' : ''} onClick={() => { setTab('product'); setText('') }}>Product Targeting</button>
              </div>
              {tab === 'keyword' ? (
                <>
                  <div className="apm-ctrl">
                    <div className="apm-mt">
                      <span className="lbl">Match Type:</span>
                      {(['BROAD', 'PHRASE', 'EXACT'] as KMatch[]).map((m) => (
                        <label key={m} className={matches[m] ? 'on' : ''}><input type="checkbox" checked={matches[m]} onChange={(e) => setMatches((p) => ({ ...p, [m]: e.target.checked }))} /> {TYPE_LABEL[m]}</label>
                      ))}
                    </div>
                    {BidField}
                  </div>
                  <div className="apm-enter no-pad-top">
                    <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Keywords" />
                    <button type="button" className="apm-enterbtn" disabled={!text.trim() || !checkedMatches.length} onClick={stageKeywords}><PlusCircle size={14} /> Add Keywords</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="apm-ctrl">{BidField}</div>
                  <div className="apm-enter no-pad-top">
                    <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste product ASINs (one per line)" aria-label="Product ASINs" />
                    <button type="button" className="apm-enterbtn" disabled={!text.trim()} onClick={stageProducts}><PlusCircle size={14} /> Add Products</button>
                  </div>
                </>
              )}
            </div>

            <div className="apm-right">
              <div className="apm-rh"><span>{n} Target{n === 1 ? '' : 's'} Added</span><button type="button" className="apm-removeall" disabled={!n} onClick={() => setStaged([])}><Trash2 size={14} /> Remove All</button></div>
              <div className="apm-thead tgt"><button type="button" className={`apm-sort ${sortDir ?? ''}`} onClick={toggleSort} aria-label="Sort by target">Target <ChevronsUpDown size={12} /></button><span>Match Type</span><span>Bid</span><span /></div>
              {n === 0 ? (
                <div className="apm-rempty">No data</div>
              ) : (
                <div className="apm-rrows">
                  {view.map((s) => (
                    <div className="apm-rrow tgt" key={keyOf(s)}>
                      <span className="ai"><span className="t" title={s.value}>{s.value}</span></span>
                      <span className="apm-tcol">{s.kind === 'keyword' ? TYPE_LABEL[s.matchType ?? 'BROAD'] : 'Product'}</span>
                      <span className="apm-bcol">€{s.bid.toFixed(2)}</span>
                      <button type="button" className="apm-x" onClick={() => remove(keyOf(s))} aria-label={`Remove ${s.value}`}><X size={15} /></button>
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
