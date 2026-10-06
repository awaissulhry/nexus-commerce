/**
 * Ads autonomy W0 — whose target ACoS a keyword's bid moves toward. ONE answer per campaign for every caller of the bid
 * optimiser (auto-bid, autopilot plans, the target-ACoS bid rules, the previews and the recommendations), so two engines
 * never pull one keyword toward two targets. Before this the optimiser used a flat 30 % or profit data only, and the
 * target the Owner set on a campaign or on the account steered nothing of Nexus's own.
 *
 * The sources, in order — the first that answers decides:
 *   campaign  `Campaign.dynamicBidding.targetAcos`, a FRACTION (0.25 = 25 %). Written by Apply Rules › Target ACoS and
 *             the Campaigns grid (PATCH /campaigns/:id/automation), the bid page's Goal (PUT /campaigns/:id/goal), the
 *             budget control plane, the `set_campaign_target_acos` rule action and Claude's set-campaign-target-acos.
 *             (`Campaign.targetAcosPct`, the integer column, has no writer: ads-guardrails.ts. It is not read.)
 *   account   `AdsAutomationState.defaultTargetAcosPct`, an INTEGER PERCENT (25 = 25 %). Written by the Suggestions bid
 *             settings (POST /automation/default-target-acos) and Claude's tune-ad-engine account-target-acos.
 *   profit    the ad group's profit-derived target (ads-target-acos.service.ts) — only when the caller runs in profit mode.
 *   flat      the caller's own target (a rule's, an autopilot plan's, a preview's), else 30 %.
 *
 * The Owner's own numbers come before a derived one and before a caller's. Units are never guessed: each field is read
 * in the unit its writers store, and a value that is not a target ACoS above 0 % and at most 100 % in that unit (a
 * campaign storing 30, which as a fraction is 3,000 %; a cleared 0) is skipped — the next source answers, and the
 * proposal names the value it skipped. The next wave adds product, category and market levels: they go in front of
 * `campaign` in TARGET_ACOS_SOURCES.
 */
import prisma from '../../db.js'
import { FALLBACK_TARGET_ACOS } from './ads-target-acos.service.js'

export type TargetAcosSource = 'campaign' | 'account' | 'profit' | 'flat'

/** What the sources read for one keyword or target. */
export interface TargetAcosSubject {
  adGroupId: string
  /** Its campaign's `dynamicBidding.targetAcos`, as stored (unchecked); undefined when the campaign has none. */
  campaignTargetAcos: unknown
}

/** What the sources read once per run. */
export interface TargetAcosInputs {
  /** `AdsAutomationState.defaultTargetAcosPct`, as stored (unchecked); null when none is set. */
  accountDefaultPct: unknown
  /** Profit-derived target per ad group (fractions); null when the caller is not in profit mode. */
  profitByAdGroup: ReadonlyMap<string, number> | null
  /** The caller's own target, a fraction (30 % when the caller gave none). */
  flatTargetAcos: number
}

export interface ResolvedTargetAcos {
  /** A fraction (0.25 = 25 %). */
  targetAcos: number
  source: TargetAcosSource
  /** Values the Owner's sources hold that are not a target ACoS in their own unit, skipped on the way. */
  skipped: Array<{ source: TargetAcosSource; stored: unknown }>
}

/** A source's answer: a fraction, null (nothing set for this subject), or a stored value it refuses to read. */
type Reading = number | null | { refused: unknown }

/** A campaign target as stored: a FRACTION above 0 and at most 1 (100 %). */
export function campaignTargetFraction(stored: unknown): Reading {
  if (stored == null) return null
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 && stored <= 1 ? stored : { refused: stored }
}

/** The account default as stored: an INTEGER PERCENT above 0 and at most 100, read as a fraction (25 → 0.25). */
export function accountDefaultFraction(stored: unknown): Reading {
  if (stored == null) return null
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 && stored <= 100 ? stored / 100 : { refused: stored }
}

/** The sources, highest first. A source that has nothing for a subject passes it on to the next. */
export const TARGET_ACOS_SOURCES: ReadonlyArray<{ source: TargetAcosSource; read: (subject: TargetAcosSubject, inputs: TargetAcosInputs) => Reading }> = [
  { source: 'campaign', read: (s) => campaignTargetFraction(s.campaignTargetAcos) },
  { source: 'account', read: (_s, i) => accountDefaultFraction(i.accountDefaultPct) },
  { source: 'profit', read: (s, i) => i.profitByAdGroup?.get(s.adGroupId) ?? null },
  { source: 'flat', read: (_s, i) => i.flatTargetAcos },
]

/** The target ACoS a subject's bid moves toward, and whose it is. Pure. */
export function resolveTargetAcos(subject: TargetAcosSubject, inputs: TargetAcosInputs): ResolvedTargetAcos {
  const skipped: ResolvedTargetAcos['skipped'] = []
  for (const { source, read } of TARGET_ACOS_SOURCES) {
    const r = read(subject, inputs)
    if (typeof r === 'number') return { targetAcos: r, source, skipped }
    if (r != null) skipped.push({ source, stored: r.refused })
  }
  // Unreachable while `flat` is last and always answers; kept so the function is total.
  return { targetAcos: FALLBACK_TARGET_ACOS, source: 'flat', skipped }
}

/**
 * True when no source ranked before `source` answers for this subject, so `source` is the one consulted next. The
 * optimiser asks it before working out profit targets: an ad group the Owner's targets already cover needs none.
 */
export function reachesSource(source: TargetAcosSource, subject: TargetAcosSubject, inputs: TargetAcosInputs): boolean {
  for (const s of TARGET_ACOS_SOURCES) {
    if (s.source === source) return true
    if (typeof s.read(subject, inputs) === 'number') return false
  }
  return false
}

/**
 * The Owner's stored targets: each named campaign's and the account default, as stored. Not caught: a run that cannot
 * read them stops, rather than bidding toward a target the Owner did not choose.
 */
export async function readOwnerTargets(campaignIds: string[]): Promise<{ byCampaign: Map<string, unknown>; accountDefaultPct: unknown }> {
  const [campaigns, state] = await Promise.all([
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, dynamicBidding: true } }) : Promise.resolve([]),
    prisma.adsAutomationState.findUnique({ where: { id: 'singleton' }, select: { defaultTargetAcosPct: true } }),
  ])
  return {
    byCampaign: new Map(campaigns.map((c) => [c.id, (c.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos])),
    accountDefaultPct: state?.defaultTargetAcosPct ?? null,
  }
}

const SOURCE_WORDS: Record<TargetAcosSource, string> = {
  campaign: "this campaign's target ACoS",
  account: "the account's default target ACoS",
  profit: 'the profit-derived target ACoS',
  flat: 'a flat target ACoS',
}

/** Whose target, in words ("this campaign's target ACoS"). */
export function targetSourceWords(source: TargetAcosSource): string {
  return SOURCE_WORDS[source]
}


/** The proposal's reason suffix: whose target, and any stored value skipped on the way. Empty for a plain flat target. */
export function targetSourceNote(r: Pick<ResolvedTargetAcos, 'source' | 'skipped'>): string {
  const label = r.source === 'campaign' ? ' (campaign target)' : r.source === 'account' ? ' (account default)' : r.source === 'profit' ? ' (profit-derived)' : ''
  const skipped = r.skipped.map((s) => s.source === 'campaign'
    ? `campaign target ${JSON.stringify(s.stored)} skipped: not a fraction above 0 and at most 1`
    : `account default ${JSON.stringify(s.stored)} skipped: not a percent above 0 and at most 100`)
  return label + (skipped.length ? ` [${skipped.join('; ')}]` : '')
}

/**
 * One target and source for a batch of proposals when they all moved toward the same one (a campaign's or the account's
 * target is one per campaign); `null` when they differ (profit targets are per ad group).
 */
export function commonTargetOf(proposals: Array<{ targetAcosUsed: number; targetSource: TargetAcosSource }>): { targetAcosPct: number; source: TargetAcosSource } | null {
  if (!proposals.length) return null
  const [first] = proposals
  if (!proposals.every((p) => p.targetAcosUsed === first.targetAcosUsed && p.targetSource === first.targetSource)) return null
  return { targetAcosPct: Math.round(first.targetAcosUsed * 10_000) / 100, source: first.targetSource }
}
