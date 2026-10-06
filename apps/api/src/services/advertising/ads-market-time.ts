/**
 * CC-26 — the time zone of an Amazon Ads account, for the dates Nexus sends it (a campaign's start date).
 *
 *   1. `AmazonAdsProfile.timezone` — what Amazon's `GET /v2/profiles` reported, stored by the daily reconcile (wave 4b);
 *   2. else the discovery scope's `timezone` (refreshed by the connection heartbeat; covers the time before the first
 *      reconcile);
 *   3. else the market's own zone (`MARKET_TIME_ZONE`);
 *   4. else null — the caller says so and uses UTC.
 *
 * No Amazon call is made here.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'
import { isKnownTimeZone } from './ads-local-day.js'

/**
 * Each European ads market's own time zone, used only when Amazon has not reported the account's. The same values the
 * dayparting refresh uses for these markets (`ads-dayparting-refresh.service.ts MARKET_TZ`).
 */
export const MARKET_TIME_ZONE: Readonly<Record<string, string>> = {
  IT: 'Europe/Rome', DE: 'Europe/Berlin', FR: 'Europe/Paris', ES: 'Europe/Madrid', NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels', SE: 'Europe/Stockholm', PL: 'Europe/Warsaw', IE: 'Europe/Dublin', UK: 'Europe/London',
}

export type AdsTimeZoneSource = 'profile' | 'discovery' | 'market'

export async function adsAccountTimeZone(
  profileId: string | null | undefined,
  marketplace: string | null | undefined,
): Promise<{ timeZone: string; source: AdsTimeZoneSource } | null> {
  if (profileId) {
    const profile = await prisma.amazonAdsProfile.findUnique({
      where: { workspace_profileId: workspaceKey({ profileId }) },
      select: { timezone: true },
    }).catch(() => null)
    if (isKnownTimeZone(profile?.timezone)) return { timeZone: profile.timezone.trim(), source: 'profile' }

    const scope = await prisma.connectionScope.findFirst({
      where: { kind: 'profile', externalId: profileId },
      select: { metadata: true },
    }).catch(() => null)
    const discovered = (scope?.metadata as Record<string, unknown> | null)?.timezone
    if (isKnownTimeZone(discovered)) return { timeZone: discovered.trim(), source: 'discovery' }
  }
  const code = (normalizeMarketplaceCode(marketplace ?? '', '') || (marketplace ?? '')).toUpperCase()
  const known = MARKET_TIME_ZONE[code]
  return known ? { timeZone: known, source: 'market' } : null
}
