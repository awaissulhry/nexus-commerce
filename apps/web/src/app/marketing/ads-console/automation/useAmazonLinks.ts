'use client'

/**
 * Hook that loads the profileId-per-marketplace map from /advertising/connections.
 * Used throughout automation tabs to build Amazon Advertising Console deep links
 * alongside internal campaign links.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { amazonCampaignHref } from '../_shared/amazonLinks'

export function useAmazonLinks(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({}) // marketplace → profileId
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const m: Record<string, string> = {}
        for (const c of (d.items ?? [])) if (c.marketplace && c.profileId) m[c.marketplace] = c.profileId
        setMap(m)
      }).catch(() => {})
  }, [])
  return map
}

/** Build an Amazon campaign link if we have the profileId for the marketplace. */
export function buildAmazonCampaignHref(
  externalCampaignId: string | null | undefined,
  marketplace: string | null | undefined,
  profileMap: Record<string, string>,
): string | null {
  if (!externalCampaignId || !marketplace) return null
  const profileId = profileMap[marketplace]
  if (!profileId) return null
  return amazonCampaignHref(externalCampaignId, profileId, marketplace)
}
