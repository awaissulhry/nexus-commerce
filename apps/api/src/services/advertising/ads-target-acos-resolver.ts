/**
 * Ads autonomy W0 — whose target ACoS a keyword's bid moves toward, for every caller of the bid optimiser (auto-bid,
 * autopilot plans, the target-ACoS bid rules, the previews and the recommendations). Before this the optimiser used a
 * flat 30 % or profit data only, and the target the Owner set on a campaign or on the account steered nothing of
 * Nexus's own.
 *
 * The sources, in order — the first that answers decides. A number the Owner configured wins over a more general one:
 *   explicit  the caller's OWN target: a rule's `targetAcos`, an autopilot plan's own target, a number a person typed
 *             into a preview. A FRACTION. A default a caller passes "just in case" is not one: it is the `flat` fallback.
 *   campaign  `Campaign.dynamicBidding.targetAcos`, a FRACTION (0.25 = 25 %). Written by Apply Rules › Target ACoS and
 *             the Campaigns grid (PATCH /campaigns/:id/automation), the bid page's Goal (PUT /campaigns/:id/goal), the
 *             budget control plane, the `set_campaign_target_acos` rule action and Claude's set-campaign-target-acos.
 *             (`Campaign.targetAcosPct`, the integer column, has no writer: ads-guardrails.ts. It is not read.)
 *   strategy  W1-5 — the ads strategy's ACoS target for the keyword's AD GROUP (ads-strategy/bids.ts): its products'
 *             product row (variation, then parent), else their primary category's (deepest first), else the market's;
 *             the lowest across the ad group's products. A FRACTION, already checked (a TACoS target is never one).
 *             After the campaign's own target (Owner decision 2026-10-06: the campaign's own target wins).
 *   account   `AdsAutomationState.defaultTargetAcosPct`, an INTEGER PERCENT (25 = 25 %). Written by the Suggestions bid
 *             settings (POST /automation/default-target-acos) and Claude's tune-ad-engine account-target-acos.
 *   profit    the ad group's profit-derived target (ads-target-acos.service.ts) — only when the caller runs in profit mode.
 *   flat      the caller's fallback (an autopilot plan's goal default), else 30 %.
 *
 * Units are never guessed: each field is read in the unit its writers store, within the range they accept (up to 500 %:
 * launch targets above 100 % are real choices). A value outside it — a campaign storing 30, which as a fraction is
 * 3,000 %; a cleared 0 — is skipped: the next source answers, and the proposal names the value it skipped.
 */
import prisma from '../../db.js'
import { FALLBACK_TARGET_ACOS } from './ads-target-acos.service.js'
// The strategy registry imports this file's constants: from the strategy modules only types and the cycle-free words.
import type { StrategyTarget } from './ads-strategy/bids.js'
import type { StrategySource } from './ads-strategy/resolve.js'
import { strategyWords } from './ads-strategy/source-words.js'

export type TargetAcosSource = 'explicit' | 'campaign' | 'strategy' | 'account' | 'profit' | 'flat'

/**
 * The highest target a fraction field holds: 5 (500 %). The automation writer clamps to it (applyAutomationPatch,
 * campaign-settings.service.ts) and the screens take at most 500 % (MAX_TARGET_ACOS_PCT, web budgetInput.ts).
 */
export const MAX_TARGET_ACOS_FRACTION = 5
/** The highest account default: 500 (%), as POST /automation/default-target-acos and tune-ad-engine accept. */
export const MAX_ACCOUNT_DEFAULT_PCT = 500

/** What the sources read for one keyword or target. */
export interface TargetAcosSubject {
  adGroupId: string
  /** Its campaign's `dynamicBidding.targetAcos`, as stored (unchecked); undefined when the campaign has none. */
  campaignTargetAcos: unknown
}

/** What the sources read once per run. */
export interface TargetAcosInputs {
  /** The caller's own target, a fraction (unchecked); undefined when it set none. */
  explicitTargetAcos: unknown
  /** `AdsAutomationState.defaultTargetAcosPct`, as stored (unchecked); null when none is set. */
  accountDefaultPct: unknown
  /** W1-5 — the ads strategy's ACoS target per ad group (strategyBidReader); absent or null: no strategy target. */
  strategyByAdGroup?: ReadonlyMap<string, StrategyTarget> | null
  /** Profit-derived target per ad group (fractions); null when the caller is not in profit mode. */
  profitByAdGroup: ReadonlyMap<string, number> | null
  /** The caller's fallback, a fraction (30 % when it gave none). */
  flatTargetAcos: number
}

export interface ResolvedTargetAcos {
  /** A fraction (0.25 = 25 %). */
  targetAcos: number
  source: TargetAcosSource
  /** Values a source holds that are not a target ACoS in its own unit and range, skipped on the way. */
  skipped: Array<{ source: TargetAcosSource; stored: unknown }>
  /** W1-5 — with `strategy`: the strategy row that supplied it. */
  strategy?: StrategySource
}

/** A source's answer: a fraction, null (nothing set for this subject), or a stored value it refuses to read. */
type Reading = number | null | { refused: unknown }

/** A target as a FRACTION above 0 and at most 5 (500 %): the caller's own, or a campaign's as stored. */
export function targetFraction(stored: unknown): Reading {
  if (stored == null) return null
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 && stored <= MAX_TARGET_ACOS_FRACTION ? stored : { refused: stored }
}

/** The account default as stored: an INTEGER PERCENT above 0 and at most 500, read as a fraction (25 → 0.25). */
export function accountDefaultFraction(stored: unknown): Reading {
  if (stored == null) return null
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 && stored <= MAX_ACCOUNT_DEFAULT_PCT ? stored / 100 : { refused: stored }
}

/** The sources, highest first. A source that has nothing for a subject passes it on to the next. */
export const TARGET_ACOS_SOURCES: ReadonlyArray<{ source: TargetAcosSource; read: (subject: TargetAcosSubject, inputs: TargetAcosInputs) => Reading }> = [
  { source: 'explicit', read: (_s, i) => targetFraction(i.explicitTargetAcos) },
  { source: 'campaign', read: (s) => targetFraction(s.campaignTargetAcos) },
  { source: 'strategy', read: (s, i) => i.strategyByAdGroup?.get(s.adGroupId)?.targetAcos ?? null },
  { source: 'account', read: (_s, i) => accountDefaultFraction(i.accountDefaultPct) },
  { source: 'profit', read: (s, i) => i.profitByAdGroup?.get(s.adGroupId) ?? null },
  { source: 'flat', read: (_s, i) => i.flatTargetAcos },
]

/** The target ACoS a subject's bid moves toward, and whose it is. Pure. */
export function resolveTargetAcos(subject: TargetAcosSubject, inputs: TargetAcosInputs): ResolvedTargetAcos {
  const skipped: ResolvedTargetAcos['skipped'] = []
  for (const { source, read } of TARGET_ACOS_SOURCES) {
    const r = read(subject, inputs)
    if (typeof r === 'number') return answered(r, source, skipped, subject, inputs)
    if (r != null) skipped.push({ source, stored: r.refused })
  }
  // Unreachable while `flat` is last and always answers; kept so the function is total.
  return { targetAcos: FALLBACK_TARGET_ACOS, source: 'flat', skipped }
}

function answered(targetAcos: number, source: TargetAcosSource, skipped: ResolvedTargetAcos['skipped'], subject: TargetAcosSubject, inputs: TargetAcosInputs): ResolvedTargetAcos {
  const strategy = source === 'strategy' ? inputs.strategyByAdGroup?.get(subject.adGroupId)?.source : undefined
  return { targetAcos, source, skipped, ...(strategy ? { strategy } : {}) }
}

/**
 * W1-5 — a target someone CONFIGURED, for a caller that has no fallback of its own (the `bid_apply` rule's target-ACoS
 * ops): the caller's own number, the campaign's, the strategy's, the account default. Null when none is set: no profit
 * data and no flat 30 % are guessed for it.
 */
export function configuredTargetAcos(subject: TargetAcosSubject, inputs: Omit<TargetAcosInputs, 'profitByAdGroup' | 'flatTargetAcos'>): ResolvedTargetAcos | null {
  const all: TargetAcosInputs = { ...inputs, profitByAdGroup: null, flatTargetAcos: Number.NaN }
  const skipped: ResolvedTargetAcos['skipped'] = []
  for (const { source, read } of TARGET_ACOS_SOURCES) {
    if (source === 'profit' || source === 'flat') break
    const r = read(subject, all)
    if (typeof r === 'number') return answered(r, source, skipped, subject, all)
    if (r != null) skipped.push({ source, stored: r.refused })
  }
  return null
}

/**
 * True when no source ranked before `source` answers for this subject, so `source` is the one consulted next. The
 * optimiser asks it before working out profit targets: an ad group a configured target already covers needs none.
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
  explicit: 'its own target ACoS',
  campaign: "this campaign's target ACoS",
  strategy: "the ads strategy's target ACoS",
  account: "the account's default target ACoS",
  profit: 'the profit-derived target ACoS',
  flat: 'a flat target ACoS',
}

/** Whose target, in words ("this campaign's target ACoS"). */
export function targetSourceWords(source: TargetAcosSource): string {
  return SOURCE_WORDS[source]
}

/**
 * The proposal's reason suffix: whose target (an explicit one in the caller's words, e.g. "this rule's target"), and
 * any stored value skipped on the way. Empty for a plain flat target, as it always read.
 */
export function targetSourceNote(r: Pick<ResolvedTargetAcos, 'source' | 'skipped' | 'strategy'>, explicitFrom = 'the target asked for'): string {
  const label = r.source === 'explicit' ? ` (${explicitFrom})`
    : r.source === 'campaign' ? ' (campaign target)'
      : r.source === 'strategy' ? ` (${r.strategy ? strategyWords(r.strategy) : 'ads strategy'})`
        : r.source === 'account' ? ' (account default)'
          : r.source === 'profit' ? ' (profit-derived)' : ''
  // Only the explicit, campaign and account sources can refuse a value.
  const skipped = r.skipped.map((s) => (s.source === 'account'
    ? `account default ${JSON.stringify(s.stored)} skipped: not a percent above 0 and at most ${MAX_ACCOUNT_DEFAULT_PCT}`
    : `${s.source === 'explicit' ? explicitFrom : 'campaign target'} ${JSON.stringify(s.stored)} skipped: not a fraction above 0 and at most ${MAX_TARGET_ACOS_FRACTION}`))
  return label + (skipped.length ? ` [${skipped.join('; ')}]` : '')
}

/**
 * One target and source for a batch of proposals when they all moved toward the same one (an explicit, a campaign's or
 * the account's target is one per campaign); `null` when they differ (profit targets are per ad group).
 */
export function commonTargetOf(proposals: Array<{ targetAcosUsed: number; targetSource: TargetAcosSource }>): { targetAcosPct: number; source: TargetAcosSource } | null {
  if (!proposals.length) return null
  const [first] = proposals
  if (!proposals.every((p) => p.targetAcosUsed === first.targetAcosUsed && p.targetSource === first.targetSource)) return null
  return { targetAcosPct: Math.round(first.targetAcosUsed * 10_000) / 100, source: first.targetSource }
}
