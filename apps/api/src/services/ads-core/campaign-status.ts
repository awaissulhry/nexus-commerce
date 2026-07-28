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
  // D1 — eBay pauses a whole account's campaigns when seller standing drops
  // (error 35077). It was absent here, and normalizeCampaignStatus falls back
  // to DRAFT, so a retailer-paused campaign was not merely unmapped — it was
  // actively mislabelled as a draft everywhere normalisation is used.
  SYSTEM_PAUSED: 'PAUSED',
}

/**
 * D1 — campaigns we MANAGE: they exist on eBay and are not dead.
 *
 * `EbayCampaign.status` stores eBay's raw string (ebay-ads-entity-sync:72), and
 * 14 call sites filtered on the literals 'RUNNING'/'PAUSED'. When eBay set this
 * account to SYSTEM_PAUSED that matched **zero of eleven** campaigns: coverage
 * read 0%, the products rollup showed nothing promoted, the builder's conflict
 * preflight missed all 24 ads, and every automation rule evaluated an empty
 * candidate set — silently, with no error raised anywhere.
 *
 * Use this for "which campaigns do we consider", which is nearly always the
 * question being asked.
 */
export const EBAY_MANAGED_STATUSES = ['RUNNING', 'PAUSED', 'SYSTEM_PAUSED'] as const

/**
 * D1 — campaigns actually SERVING right now. SYSTEM_PAUSED is not serving, and
 * neither is PAUSED. Deliberately separate from MANAGED so the distinction is
 * available rather than re-derived: today every call site wants MANAGED, but a
 * "what is live this minute" question must not silently inherit that answer.
 */
export const EBAY_SERVING_STATUSES = ['RUNNING'] as const

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
