'use client'

/**
 * CBN.3 — Search Terms bulk action modal: add the selected search terms as positive
 * KEYWORD targets (POST /advertising/keywords/create per term) or as campaign-level
 * NEGATIVE keywords (POST /advertising/negative-keywords per term). H10's own button is
 * "Add to Keyword Tracker" (their research tool, N/A here) — this is the campaign-management
 * equivalent. One component, two modes. Deploy-safe: web dev hits the live API.
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { H10Select } from '../../FilterDropdown'

const KW_MATCH = [{ value: 'EXACT', label: 'Exact' }, { value: 'PHRASE', label: 'Phrase' }, { value: 'BROAD', label: 'Broad' }]
const NEG_MATCH = [{ value: 'NEGATIVE_EXACT', label: 'Negative Exact' }, { value: 'NEGATIVE_PHRASE', label: 'Negative Phrase' }]

export function SearchTermActionModal({ mode, terms, adGroups, externalCampaignId, marketplace, currency = '€', onClose, onDone }: {
  mode: 'keyword' | 'negative'
  terms: string[]
  adGroups: Array<{ id: string; name?: string }>
  externalCampaignId: string | null
  marketplace: string | null
  currency?: string
  onClose: () => void
  onDone: () => void
}) {
  const isKw = mode === 'keyword'
  const [adGroupId, setAdGroupId] = useState(adGroups[0]?.id ?? '')
  const [matchType, setMatchType] = useState(isKw ? 'EXACT' : 'NEGATIVE_EXACT')
  const [bid, setBid] = useState('0.50')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: number; fail: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const valid = terms.length > 0 && (isKw ? (adGroupId !== '' && Number(bid) > 0) : (!!externalCampaignId && !!marketplace))

  async function submit() {
    setBusy(true); setErr(null); setResult(null)
    let ok = 0, fail = 0
    try {
      await Promise.all(terms.map(async (kw) => {
        try {
          const url = isKw ? '/api/advertising/keywords/create' : '/api/advertising/negative-keywords'
          const body = isKw
            ? { adGroupId, keywordText: kw, matchType, bidEur: Number(bid) }
            : { externalCampaignId, keywordText: kw, matchType, scope: 'CAMPAIGN', marketplace }
          const r = await fetch(`${getBackendUrl()}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          const d = await r.json().catch(() => ({}))
          if (!r.ok || (d as { error?: string; denied?: boolean }).error || (d as { denied?: boolean }).denied) fail++; else ok++
        } catch { fail++ }
      }))
      setResult({ ok, fail })
      if (fail === 0) { onDone(); window.setTimeout(onClose, 800) }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Request failed') } finally { setBusy(false) }
  }

  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={isKw ? 'Add as Keyword' : 'Add as Negative'}>
        <div className="h10-modal-h"><b>{isKw ? 'Add as Keyword' : 'Add as Negative'}</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">{isKw
          ? `Add ${terms.length} search term${terms.length === 1 ? '' : 's'} as keyword targets in an ad group.`
          : `Add ${terms.length} search term${terms.length === 1 ? '' : 's'} as campaign-level negative keywords.`}</div>
        <div className="h10-modal-b">
          <div className="h10-st-chips">
            {terms.slice(0, 24).map((t) => <span key={t} className="chip" title={t}>{t}</span>)}
            {terms.length > 24 && <span className="chip more">+{terms.length - 24} more</span>}
          </div>
          {isKw && (
            <div className="h10-cd-field"><label>Ad Group</label>
              <H10Select width="100%" value={adGroupId} onChange={setAdGroupId} options={adGroups.map((a) => ({ value: a.id, label: a.name || a.id }))} ariaLabel="Ad Group" />
            </div>
          )}
          <div className="h10-cd-field"><label>Match Type</label>
            <H10Select width="100%" value={matchType} onChange={setMatchType} options={isKw ? KW_MATCH : NEG_MATCH} ariaLabel="Match Type" />
          </div>
          {isKw && (
            <div className="h10-cd-field s"><label>Bid</label>
              <div className="h10-cd-money"><span className="pf">{currency}</span><input type="number" min="0.02" step="0.01" value={bid} onChange={(e) => setBid(e.target.value)} aria-label="Bid" /></div>
            </div>
          )}
          {result && <div className={result.fail ? 'h10-cd-modalerr' : 'h10-st-ok'}>{result.ok} added{result.fail ? ` · ${result.fail} failed` : ''}.</div>}
          {err && <div className="h10-cd-modalerr">{err}</div>}
        </div>
        <div className="h10-modal-f">
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <button type="button" className="h10-am-btn primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Adding…' : isKw ? 'Add Keywords' : 'Add Negatives'}</button>
        </div>
      </div>
    </div>
  )
}
