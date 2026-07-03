'use client'

/**
 * ER1 — Promote (product-first or campaign-scoped), ported verbatim from
 * _write-modals.tsx (C1). Used by the Products page and the detail page's
 * Add-listings action. Guardrail: rates above break-even are blocked without
 * a named reason.
 */
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { H10Modal, Err, ResultsList } from '../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner, type WriteItemOutcome, type CampaignRow } from '../_lib'

export function PromoteModal(props: {
  open: boolean
  onClose: () => void
  productIds?: string[]
  listingIds?: string[]
  presetCampaignId?: string
  onDone?: () => void
}) {
  const mode = useWriteMode()
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([])
  const [campaignId, setCampaignId] = useState(props.presetCampaignId ?? '')
  const [ratePct, setRatePct] = useState('8')
  const [overrideReason, setOverrideReason] = useState('')
  const [manualIds, setManualIds] = useState('')
  const noPreselection = (props.productIds?.length ?? 0) + (props.listingIds?.length ?? 0) === 0
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)

  useEffect(() => {
    if (!props.open) return
    setResults(null); setError(null); setManualIds('')
    setCampaignId(props.presetCampaignId ?? '')
    fetch(`${getBackendUrl()}/api/ebay-ads/campaigns`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        const all = j.campaigns as CampaignRow[]
        const eligible = all.filter((c) => c.fundingModel === 'COST_PER_SALE' && !c.isRulesBased && c.status !== 'ENDED' && !c.channels.includes('OFF_SITE'))
        // keep the preset campaign selectable even if it wouldn't normally qualify
        const preset = props.presetCampaignId ? all.find((c) => c.id === props.presetCampaignId) : undefined
        setCampaigns(preset && !eligible.some((c) => c.id === preset.id) ? [preset, ...eligible] : eligible)
        if (!props.presetCampaignId && eligible[0]) setCampaignId(eligible[0].id)
      })
      .catch((e) => setError((e as Error).message))
  }, [props.open, props.presetCampaignId])

  const launch = async () => {
    setBusy(true); setError(null)
    try {
      const manual = manualIds.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d{9,15}$/.test(s))
      if (noPreselection && manual.length === 0) throw new Error('paste at least one eBay item ID (9–15 digits)')
      const out = await postEbayAds<{ mode: string; results: WriteItemOutcome[] }>('/promote', {
        productIds: props.productIds,
        listingIds: [...(props.listingIds ?? []), ...manual],
        marketplace: 'EBAY_IT',
        campaignId,
        defaultRatePct: Number(ratePct),
        ...(overrideReason.trim() ? { override: { reason: overrideReason.trim() } } : {}),
      })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal
      open={props.open}
      onClose={props.onClose}
      title="Promote on eBay"
      subtitle={props.productIds?.length ? `${props.productIds.length} product(s) — every live item ID resolves automatically` : props.listingIds?.length ? `${props.listingIds.length} listing(s) selected` : 'Paste item IDs to promote into this campaign'}
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={launch} disabled={busy || !campaignId || results != null}>{busy ? 'Launching…' : 'Launch ads'}</button>
      </>}
    >
      <SandboxBanner mode={mode} />
      <div className="eb-form-row">
        <div style={{ flex: 1 }}>
          <label>Target campaign (General, key-based)</label>
          <select className="h10-cd-input" style={{ width: '100%' }} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.status}{c.bidPercentage != null ? ` · default ${c.bidPercentage}%` : ''}</option>)}
          </select>
        </div>
        <div>
          <label>Ad rate %</label>
          <input className="h10-cd-input" style={{ width: 90 }} type="number" min={2} max={100} step={0.1} value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
        </div>
      </div>
      {noPreselection && (
        <div>
          <label>eBay item IDs — space/comma/newline separated</label>
          <textarea className="eb-textarea" rows={3} value={manualIds} onChange={(e) => setManualIds(e.target.value)} placeholder="256568121061 256566107046 …" />
        </div>
      )}
      <div>
        <label>Guardrail override reason (only to exceed break-even — audited)</label>
        <input className="h10-cd-input" style={{ width: '100%' }} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. launch push, 2 weeks" />
      </div>
      <p className="eb-be-hint">Rates above a listing&apos;s <b>break-even</b> are blocked unless you give an explicit override reason. Listings without cost data go through with a warning. A listing already promoted in another General campaign is rejected by eBay per item (one listing = one General campaign).</p>
      <Err msg={error} />
      {results && <ResultsList results={results} />}
    </H10Modal>
  )
}
