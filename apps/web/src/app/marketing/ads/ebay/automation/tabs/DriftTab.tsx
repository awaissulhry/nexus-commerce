'use client'

/**
 * ER3.2 (delta 9) — Drift, lifted verbatim from the v1 client (E-series,
 * verified live): values eBay changed under us vs what Nexus last set.
 * Structural move only — rendering and Re-apply/Accept semantics unchanged.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Pill } from '@/design-system/primitives'
import { getEbayAds, postEbayAds, eurC } from '../../_lib'
import { pillTone } from '../../../_shared/pillTone'

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
    <div className="nds-card h10-cardstack eb-rowlist">
      <p className="hd plain">
        Values eBay changed under us — "easy boost" rate overwrites, Seller Hub edits, removed ads — vs what Nexus last set (from the audit trail). <b>Re-apply</b> pushes the Nexus value back through the guarded write layer; <b>Accept</b> makes eBay's value the new baseline (audited).
      </p>
      {drifts.length === 0 ? (
        <div className="empty ctr">No drift — everything on eBay matches what Nexus last set.</div>
      ) : drifts.map((d) => (
        <div key={`${d.campaignId}-${d.kind}-${d.listingId ?? 'campaign'}`} className="eb-row">
          <Pill tone={pillTone(d.kind === 'ad_removed' ? 'warn' : 'arch')}>{d.kind.replace(/_/g, ' ')}</Pill>
          <span className="nm6">{d.campaignName}</span>
          <span className="dim">{d.listingId ?? ''}</span>
          <span>
            Nexus set <b>{d.kind === 'budget' ? eurC(d.nexusValue) : `${d.nexusValue}%`}</b> ({new Date(d.setAt).toLocaleDateString('en-GB')}) · eBay now <b>{d.ebayValue == null ? 'removed' : d.kind === 'budget' ? eurC(d.ebayValue) : `${d.ebayValue}%`}</b>
          </span>
          <span className="grow" style={{ flex: 1 }} />
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(() => postEbayAds('/reconciliation/repair', { campaignId: d.campaignId, kind: d.kind, listingId: d.listingId, action: 'reapply' }), 'Nexus value re-applied')}>Re-apply</Button>
          <Button size="sm" disabled={busy} onClick={() => void act(() => postEbayAds('/reconciliation/repair', { campaignId: d.campaignId, kind: d.kind, listingId: d.listingId, action: 'accept' }), 'eBay value accepted')}>Accept</Button>
        </div>
      ))}
    </div>
  )
}
