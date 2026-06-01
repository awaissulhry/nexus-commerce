'use client'

/**
 * Shared campaign-reference map: external Amazon campaign id → { local id, name,
 * marketplace }. Lets the Harvest / Negatives / SoV tabs show a navigable campaign
 * name + market instead of a bare external id, so every search-term / keyword row
 * is traceable to where it lives.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export interface CampRef { id: string; name: string; marketplace: string | null }

export function useCampaignMap(): Record<string, CampRef> {
  const [map, setMap] = useState<Record<string, CampRef>>({})
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { const m: Record<string, CampRef> = {}; for (const c of (d.items ?? [])) if (c.externalCampaignId) m[c.externalCampaignId] = { id: c.id, name: c.name, marketplace: c.marketplace }; setMap(m) })
      .catch(() => {})
  }, [])
  return map
}

/** Per-campaign detail surface (opens in a new tab). */
export const campaignHref = (localId: string) => `/marketing/trading-desk/campaigns/${localId}`
