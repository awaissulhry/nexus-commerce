'use client'

/**
 * ER3.2 (delta 9) — Drift, lifted verbatim from the v1 client (E-series,
 * verified live): values eBay changed under us vs what Nexus last set.
 * Structural move only — rendering and Re-apply/Accept semantics unchanged.
 */
import { useCallback, useEffect, useState } from 'react'
import { getEbayAds, postEbayAds, eurC } from '../../_lib'

interface DriftRow {
  campaignId: string; externalCampaignId: string; campaignName: string; marketplace: string
  kind: 'ad_rate' | 'budget' | 'ad_removed'; listingId: string | null
  nexusValue: number; ebayValue: number | null; setAt: string; sourceAction: string
}

export function DriftTab({ busy, act, bump }: { busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; bump: number }) {
  const [drifts, setDrifts] = useState<DriftRow[]>([])
  const reload = useCallback(async () => {
    setDrifts((await getEbayAds<{ drifts: DriftRow[] }>('/reconciliation')).drifts)
  }, [])
  useEffect(() => { reload().catch(() => {}) }, [reload, bump])

  return (
    <div className="h10-am-card" style={{ padding: '6px 0' }}>
      <p style={{ fontSize: 12, color: '#5b6573', padding: '10px 18px 4px', margin: 0 }}>
        Values eBay changed under us — "easy boost" rate overwrites, Seller Hub edits, removed ads — vs what Nexus last set (from the audit trail). <b>Re-apply</b> pushes the Nexus value back through the guarded write layer; <b>Accept</b> makes eBay's value the new baseline (audited).
      </p>
      {drifts.length === 0 ? (
        <div style={{ padding: '28px 18px', textAlign: 'center', fontSize: 13, color: '#5b6573' }}>No drift — everything on eBay matches what Nexus last set.</div>
      ) : drifts.map((d) => (
        <div key={`${d.campaignId}-${d.kind}-${d.listingId ?? 'campaign'}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid #eef1f5', flexWrap: 'wrap', fontSize: 12.5 }}>
          <span className={`h10-pill ${d.kind === 'ad_removed' ? 'warn' : 'arch'}`}>{d.kind.replace(/_/g, ' ')}</span>
          <span style={{ fontWeight: 600 }}>{d.campaignName}</span>
          <span style={{ color: '#8a93a1' }}>{d.listingId ?? ''}</span>
          <span>
            Nexus set <b>{d.kind === 'budget' ? eurC(d.nexusValue) : `${d.nexusValue}%`}</b> ({new Date(d.setAt).toLocaleDateString('en-GB')}) · eBay now <b>{d.ebayValue == null ? 'removed' : d.kind === 'budget' ? eurC(d.ebayValue) : `${d.ebayValue}%`}</b>
          </span>
          <span className="grow" style={{ flex: 1 }} />
          <button type="button" className="h10-am-btn sm primary" disabled={busy} onClick={() => void act(() => postEbayAds('/reconciliation/repair', { campaignId: d.campaignId, kind: d.kind, listingId: d.listingId, action: 'reapply' }), 'Nexus value re-applied')}>Re-apply</button>
          <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => void act(() => postEbayAds('/reconciliation/repair', { campaignId: d.campaignId, kind: d.kind, listingId: d.listingId, action: 'accept' }), 'eBay value accepted')}>Accept</button>
        </div>
      ))}
    </div>
  )
}
