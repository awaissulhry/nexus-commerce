/**
 * Ads Core (E1) — channel-agnostic campaign status vocabulary, transition
 * guard, and per-channel native→normalized maps.
 *
 * Single source of truth: the marketing adapters import their STATUS_MAP from
 * here instead of declaring local copies (kills the fork-drift hazard the E0
 * audit flagged — two adapters and a backfill script each carrying their own
 * mapping). The maps below preserve the adapters' existing behavior EXACTLY;
 * extending them (e.g. eBay SCHEDULED/PENDING) is an E2 change made here, in
 * one place, with tests.
 */

export const NORMALIZED_CAMPAIGN_STATUSES = [
  'DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'ENDED', 'DELETED',
] as const

export type NormalizedCampaignStatus = (typeof NORMALIZED_CAMPAIGN_STATUSES)[number]

/** Amazon legacy CampaignStatus → normalized (verbatim from amazon.adapter). */
export const AMAZON_CAMPAIGN_STATUS_MAP: Record<string, string> = {
  ENABLED: 'ACTIVE',
  PAUSED: 'PAUSED',
  ARCHIVED: 'ENDED',
  DRAFT: 'DRAFT',
}

/** eBay campaignStatus → normalized (verbatim from ebay.adapter). */
export const EBAY_CAMPAIGN_STATUS_MAP: Record<string, string> = {
  RUNNING: 'ACTIVE',
  PAUSED: 'PAUSED',
  ENDED: 'ENDED',
  SUSPENDED: 'SUSPENDED',
  DRAFT: 'DRAFT',
}

/** Map a channel-native status through a map with an explicit fallback. */
export function normalizeCampaignStatus(
  map: Record<string, string>,
  native: string | null | undefined,
  fallback: NormalizedCampaignStatus = 'DRAFT',
): string {
  if (!native) return fallback
  return map[native] ?? fallback
}

/**
 * Allowed transitions for operator/automation-initiated changes.
 * Platform-pushed states (e.g. eBay SUSPENDED) arrive via sync regardless —
 * this guard protects OUR mutation paths from writing nonsense (resume an
 * ENDED campaign, pause a DRAFT), not the sync from recording reality.
 */
const TRANSITIONS: Record<NormalizedCampaignStatus, readonly NormalizedCampaignStatus[]> = {
  DRAFT: ['SCHEDULED', 'ACTIVE', 'DELETED'],
  SCHEDULED: ['ACTIVE', 'PAUSED', 'ENDED', 'DELETED'],
  ACTIVE: ['PAUSED', 'ENDED', 'SUSPENDED'],
  PAUSED: ['ACTIVE', 'ENDED', 'DELETED'],
  SUSPENDED: ['ACTIVE', 'PAUSED', 'ENDED'],
  ENDED: [], // terminal — eBay/Amazon both require clone/recreate, not resume
  DELETED: [],
}

export function canTransitionCampaignStatus(
  from: NormalizedCampaignStatus,
  to: NormalizedCampaignStatus,
): boolean {
  if (from === to) return false
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function isTerminalCampaignStatus(s: NormalizedCampaignStatus): boolean {
  return TRANSITIONS[s]?.length === 0
}
