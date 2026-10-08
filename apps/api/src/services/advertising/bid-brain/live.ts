/**
 * BID BRAIN BB-6 — the campaigns the brain owns. A campaign is owned when the env ceiling NEXUS_BID_BRAIN_MODE is
 * `live` AND its BidBrainEnrollment row is LIVE or HELD (HELD = no raises; the brain is still the one writer). Every
 * other automatic bid or placement writer skips an owned campaign, and the write gate refuses their writes as the
 * last line. A leaf on purpose (prisma only), so the write gate and every engine can import it without a cycle.
 */
import prisma from '../../../db.js'

export const BRAIN_ACTOR = 'automation:bid-brain'
const OWNED_MODES = ['LIVE', 'HELD']

/** The env ceiling is `live` (anything else: the brain owns nothing). Same parse as shadow.ts bidBrainMode. */
export function brainLiveCeiling(env: string | undefined = process.env.NEXUS_BID_BRAIN_MODE): boolean {
  return (env ?? '').trim().toLowerCase() === 'live'
}

/** The ids among `campaignIds` (all when omitted) the brain owns now. Empty under a non-live ceiling (no query). */
export async function brainOwnedCampaignIds(campaignIds?: readonly string[]): Promise<Set<string>> {
  if (!brainLiveCeiling()) return new Set()
  if (campaignIds && campaignIds.length === 0) return new Set()
  const rows = await prisma.bidBrainEnrollment.findMany({
    where: { mode: { in: OWNED_MODES }, ...(campaignIds ? { campaignId: { in: [...campaignIds] } } : {}) },
    select: { campaignId: true },
  })
  return new Set(rows.map((r) => r.campaignId))
}
