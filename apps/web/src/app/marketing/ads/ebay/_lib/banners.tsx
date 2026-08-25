'use client'

/**
 * ER1 — shared UI atoms for the eBay console (split from _shared.tsx, C1):
 * write-mode hook + sandbox banner, freshness line (72h reconciliation
 * disclosure), strategy/status/break-even chips used by v1 pages until their
 * ER3 slot.
 */
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { ago } from '../../_canvas/format'
import { pctP } from './format'
import type { Freshness } from './types'

export function useWriteMode(): 'sandbox' | 'live' | null {
  const [mode, setMode] = useState<'sandbox' | 'live' | null>(null)
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/ebay-ads/write-mode`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setMode(j.mode ?? null))
      .catch(() => setMode(null))
  }, [])
  return mode
}

export function SandboxBanner({ mode }: { mode: 'sandbox' | 'live' | null }) {
  if (mode !== 'sandbox') return null
  return (
    <div className="eb-sandbox" role="status">
      <b>Sandbox mode</b> — changes are validated, guardrail-checked, mirrored locally and audited, but <b>not pushed to eBay</b> until
      <code> NEXUS_MARKETING_WRITES_EBAY=1</code> is set (the E4 acceptance flip).
    </div>
  )
}

export function FreshnessLine({ f }: { f: Freshness | undefined }) {
  if (!f) return null
  return (
    <div className="eb-fresh" title="Sales/fee figures inside eBay's 72h Reconciliation Period are provisional.">
      Data as of: facts {ago(f.factsReportedAt)} · entities {ago(f.entitySyncAt)} · listings {ago(f.listingSeenAt)} · attribution: any-click (30d)
    </div>
  )
}

export function BreakEvenCell({ pct, status }: { pct: number | null; status: string | null }) {
  if (pct != null) return <span>{pctP(pct)}</span>
  if (status === 'MISSING_COGS') return <span className="eb-chip eb-chip--warn" title="No product cost on file — break-even can't be computed. This listing is manual-only for automations.">add cost</span>
  if (status === 'MISSING_PRICE') return <span className="eb-chip eb-chip--warn">no price</span>
  return <span>—</span>
}
