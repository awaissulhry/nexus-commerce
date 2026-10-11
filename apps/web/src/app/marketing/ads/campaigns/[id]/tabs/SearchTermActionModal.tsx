'use client'

/**
 * CBN.3 — Search Terms bulk action modal: add the selected search terms as positive
 * KEYWORD targets (POST /advertising/keywords/create per term) or as campaign-level
 * NEGATIVE keywords (POST /advertising/negative-keywords per term). H10's own button is
 * "Add to Keyword Tracker" (their research tool, N/A here) — this is the campaign-management
 * equivalent. One component, two modes. Deploy-safe: web dev hits the live API.
 */
import { useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { Field, Listbox, Modal } from '@/design-system/components'
import '../../campaigns-ds.css'

import { adsAdd, addSummary } from '../../../_shared/adsWrite'

const KW_MATCH = [{ value: 'EXACT', label: 'Exact' }, { value: 'PHRASE', label: 'Phrase' }, { value: 'BROAD', label: 'Broad' }]
const NEG_MATCH = [{ value: 'NEGATIVE_EXACT', label: 'Negative Exact' }, { value: 'NEGATIVE_PHRASE', label: 'Negative Phrase' }]

export function SearchTermActionModal({ mode, terms, adGroups, externalCampaignId, marketplace, currency = '€', negativeAdGroup = null, onClose, onDone }: {
  mode: 'keyword' | 'negative'
  terms: string[]
  adGroups: Array<{ id: string; name?: string }>
  externalCampaignId: string | null
  marketplace: string | null
  currency?: string
  /**
   * Negative Targeting (2026-10-11) — opened from an AD GROUP's Search Terms: a negative goes in that ad group (scope
   * AD_GROUP) unless the person picks the whole campaign. It wrote campaign-wide from an ad group before (the bug).
   * Absent (the campaign's Search Terms): campaign-level, as before.
   */
  negativeAdGroup?: { externalAdGroupId: string | null; name?: string } | null
  onClose: () => void
  onDone: () => void
}) {
  const isKw = mode === 'keyword'
  const agScope = !isKw && !!negativeAdGroup
  const [negWhere, setNegWhere] = useState<'AD_GROUP' | 'CAMPAIGN'>(agScope && negativeAdGroup?.externalAdGroupId ? 'AD_GROUP' : 'CAMPAIGN')
  const [adGroupId, setAdGroupId] = useState(adGroups[0]?.id ?? '')
  const [matchType, setMatchType] = useState(isKw ? 'EXACT' : 'NEGATIVE_EXACT')
  const [bid, setBid] = useState('0.50')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ fail: number; text: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const valid = terms.length > 0 && (isKw ? (adGroupId !== '' && Number(bid) > 0) : (!!externalCampaignId && !!marketplace && (negWhere === 'CAMPAIGN' || !!negativeAdGroup?.externalAdGroupId)))

  async function submit() {
    setBusy(true); setErr(null); setResult(null)
    try {
      // CM-8 — "added" means Amazon holds it; every other answer carries the write gate's or Amazon's reason.
      const url = isKw ? '/api/advertising/keywords/create' : '/api/advertising/negative-keywords'
      const results = await Promise.all(terms.map((kw) => adsAdd(url, isKw
        ? { adGroupId, keywordText: kw, matchType, bidEur: Number(bid) }
        : negWhere === 'AD_GROUP'
          ? { externalCampaignId, externalAdGroupId: negativeAdGroup!.externalAdGroupId, keywordText: kw, matchType, scope: 'AD_GROUP', marketplace }
          : { externalCampaignId, keywordText: kw, matchType, scope: 'CAMPAIGN', marketplace })))
      const sum = addSummary(results, isKw ? 'keyword' : 'negative')
      setResult({ fail: results.filter((r) => !r.added).length, text: sum.text })
      if (sum.anyAdded) onDone()
      if (sum.allAdded) window.setTimeout(onClose, 800)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Request failed') } finally { setBusy(false) }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isKw ? 'Add as Keyword' : 'Add as Negative'}
      subtitle={isKw
          ? `Add ${terms.length} search term${terms.length === 1 ? '' : 's'} as keyword targets in an ad group.`
          : `Add ${terms.length} search term${terms.length === 1 ? '' : 's'} as negative keywords ${negWhere === 'AD_GROUP' ? `in the ad group${negativeAdGroup?.name ? ` "${negativeAdGroup.name}"` : ''}` : 'in the whole campaign'}.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <span className="grow" />
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Adding…' : isKw ? 'Add Keywords' : 'Add Negatives'}</Button>
        </>
      }
    >
      <div className="h10-st-chips">
        {terms.slice(0, 24).map((t) => <span key={t} className="chip" title={t}>{t}</span>)}
        {terms.length > 24 && <span className="chip more">+{terms.length - 24} more</span>}
      </div>
      {isKw && (
        <Field className="cd-field" label="Ad Group" htmlFor="stam-adgroup">
          <Listbox width="100%" value={adGroupId} onChange={setAdGroupId} options={adGroups.map((a) => ({ value: a.id, label: a.name || a.id }))} ariaLabel="Ad Group" />
        </Field>
      )}
      {agScope && (
        <Field className="cd-field" label="Where" htmlFor="stam-where">
          <Listbox width="100%" value={negWhere} onChange={(v) => setNegWhere(v === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP')} ariaLabel="Where"
            options={[
              { value: 'AD_GROUP', label: 'This ad group', heldReason: negativeAdGroup?.externalAdGroupId ? undefined : 'Amazon has not given this ad group an id yet' },
              { value: 'CAMPAIGN', label: 'Whole campaign' },
            ]} />
        </Field>
      )}
      <Field className="cd-field" label="Match Type" htmlFor="stam-match">
        <Listbox width="100%" value={matchType} onChange={setMatchType} options={isKw ? KW_MATCH : NEG_MATCH} ariaLabel="Match Type" />
      </Field>
      {isKw && (
        <Field className="cd-field s" label="Bid">
          <Input inputMode="decimal" prefix={currency} value={bid} onChange={(e) => setBid(e.target.value)} fieldClassName="cd-money-field" />
        </Field>
      )}
      {result && <div className={result.fail ? 'h10-cd-modalerr' : 'h10-st-ok'}>{result.text}.</div>}
      {err && <div className="h10-cd-modalerr">{err}</div>}
    </Modal>
  )
}
