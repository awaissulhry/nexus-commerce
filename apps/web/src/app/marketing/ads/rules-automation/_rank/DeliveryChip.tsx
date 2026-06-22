'use client'

/**
 * RGD.1 — per-campaign Amazon DELIVERY truth (re-skinned to H10 from the ads-console B1 chip).
 * Are this campaign's bid changes live on Amazon, pending, or gated / sandbox-only? Sourced from
 * GET /advertising/campaigns/:id/pending-writes (write-gate decision + queue state + sync stamps).
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface PendingWrites {
  adsMode?: 'sandbox' | 'live'
  gate?: { allowed: boolean; mode?: string; reason?: string; deniedAt?: string }
  campaign?: { liveBidWritesEnabled?: boolean; writesToday?: number }
  pendingCount?: number
  recent?: Array<{ status: string; errorCode: string | null; errorMessage: string | null; at: string; syncType: string }>
}

export function DeliveryChip({ campaignId, reloadSignal }: { campaignId: string; reloadSignal?: number }) {
  const [pw, setPw] = useState<PendingWrites | null>(null)
  const load = useCallback(() => {
    if (!campaignId) return
    fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/pending-writes`, { cache: 'no-store' })
      .then(r => r.json()).then(setPw).catch(() => setPw(null))
  }, [campaignId])
  useEffect(() => { load() }, [load, reloadSignal])
  if (!pw || !pw.gate) return null

  const last = pw.recent?.[0]
  const gated = pw.gate.allowed === false
  const sandbox = pw.adsMode !== 'live'
  const lastFailed = last?.status === 'FAILED'
  const tone = gated || lastFailed ? 'bad' : sandbox ? 'warn' : 'ok'
  const lastLabel = !last ? 'no pushes yet'
    : last.status === 'SUCCESS' ? '✓ live on Amazon'
      : last.status === 'FAILED' ? `✗ ${last.errorCode ?? 'failed'}`
        : `⊘ ${last.status.toLowerCase()}`
  const title = [
    `Amazon mode: ${sandbox ? 'SANDBOX (writes are local-only, not sent to Amazon)' : 'LIVE'}`,
    gated ? `Gate: DENIED — ${pw.gate.deniedAt}: ${pw.gate.reason}` : 'Gate: allowed',
    `Live writes today: ${pw.campaign?.writesToday ?? 0}`,
    pw.pendingCount ? `${pw.pendingCount} write(s) pending` : 'no pending writes',
    last ? `Last push: ${last.status}${last.errorMessage ? ` — ${last.errorMessage}` : ''} (${new Date(last.at).toLocaleString()})` : '',
  ].filter(Boolean).join('\n')

  return (
    <span className={`h10-deliv ${tone}`} title={title}>
      <span className="lbl">Amazon</span>
      <span className="bdg">{sandbox ? 'SANDBOX' : 'LIVE'}</span>
      {gated && <span className="bdg bad">gated</span>}
      <span className="sep">·</span>
      <span>{pw.campaign?.writesToday ?? 0} today</span>
      {!!pw.pendingCount && <><span className="sep">·</span><span>{pw.pendingCount} pending</span></>}
      <span className="sep">·</span>
      <span className="last">{lastLabel}</span>
      <button type="button" className="ref" onClick={load} title="Refresh delivery status" aria-label="Refresh delivery status"><RefreshCw size={11} /></button>
    </span>
  )
}
