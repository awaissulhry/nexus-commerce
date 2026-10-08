/**
 * BID BRAIN BB-9 — rules become inputs. On a campaign the brain owns (live.ts: the env ceiling `live` and its enrollment
 * LIVE or HELD) an ads rule's bid or placement action no longer writes: it becomes a BidDirective, an input the brain
 * reads on its next run (design §2 "Rules become inputs"):
 *
 *   bid_to_target_acos; bid_apply targetAcos / curBidTargetAcos   → GOAL for its scope; nothing when the rule names no
 *                                                                    target of its own or repeats the goal in force
 *   bid_down, lower_bid_to_floor, a bid_apply that lowers         → CEILING at the bid the rule asked, for 7 days
 *   bid_up, a bid_apply that raises                               → FLOOR at the bid the rule asked (the brain holds it
 *                                                                    to the band top), for 7 days
 *   raise_bids_for_rank_defense; a raise from a share-of-voice    → SHARE_FLOOR (the brain holds it to hi × 1.25 and the
 *   trigger (SOV_BID)                                                highest bid), for 7 days
 *   set_placement_multiplier, placement_apply                     → a lane CEILING (lowering) or FLOOR (raising), in %
 *   dayparting_apply, scale_bids_for_price_change                 → nothing: the hour factor and the order value the
 *                                                                    brain bids from already carry them
 *
 * The same rule saying it again replaces its own row (one per rule, campaign, keyword, lane and kind), so a rule that
 * matches every 15 minutes keeps one row, and its 7 days start again. A dry run (PROPOSE, a preview) writes nothing and
 * says what it would ask; the person's approval of that suggestion asks it (ads-suggestion-decide.service.ts).
 * Harvest, negatives, budget and alert actions are untouched, and so is every campaign the brain does not own: there
 * `ruleBrainInput` answers null and the rule runs exactly as before — without a read while the ceiling is not live.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { readOwnerTargets } from '../ads-target-acos-resolver.js'
import { goalTarget, type CampaignRow } from './facts.js'
import { brainLiveCeiling, brainOwnedCampaignIds } from './live.js'
import { loadStrategy } from './load.js'
import type { LaneName } from './recipe.js'

/** How long a rule's word holds unless it says it again (design §2: bid_down → 7 days; every kind alike). */
export const DIRECTIVE_DAYS = 7
/** Nexus's engine floor (ads-mutation.service.ts BID_FLOOR_CENTS): the rule handlers never ask below it. */
const FLOOR_CENTS = 5
/** The most targets one campaign-wide action turns into rows (the rank-defense handler's own `take`). */
const MAX_TARGETS = 200

export type DirectiveKind = 'CEILING' | 'FLOOR' | 'GOAL' | 'SHARE_FLOOR'

/** One input a rule asks for, before it is stored. A lane directive's value is a placement % in `valueCents`. */
export interface DirectiveDraft {
  targetId: string | null
  lane: LaneName | null
  kind: DirectiveKind
  valueCents: number | null
  valuePct: number | null
  reason: string
}

/** The actions that become inputs. */
export const DIRECTIVE_ACTIONS: ReadonlySet<string> = new Set([
  'bid_down', 'bid_up', 'bid_apply', 'lower_bid_to_floor', 'raise_bids_for_rank_defense', 'bid_to_target_acos',
  'set_placement_multiplier', 'placement_apply',
])

/** The actions the brain already carries in its own recipe: on an owned campaign they are left to it, with why. */
export const CARRIED_ACTIONS: Readonly<Record<string, string>> = {
  dayparting_apply: "the hourly plan is the brain's hour factor",
  scale_bids_for_price_change: 'a price change reaches the brain through the order value it bids from',
}

/** Triggers whose raise is about being seen, not about ACoS: their floor is a share floor. */
export const SHARE_TRIGGERS: ReadonlySet<string> = new Set(['SOV_BID'])

/** bid_apply ops that steer toward a target ACoS: the rule's target is a goal, not a bid. */
const GOAL_OPS: ReadonlySet<string> = new Set(['targetAcos', 'curBidTargetAcos'])

const LANE_OF: Readonly<Record<string, LaneName>> = {
  PLACEMENT_TOP: 'TOP_OF_SEARCH',
  PLACEMENT_PRODUCT_PAGE: 'PRODUCT_PAGE',
  PLACEMENT_REST_OF_SEARCH: 'REST_OF_SEARCH',
}

export interface RuleAsk {
  action: { type: string } & Record<string, unknown>
  trigger?: string | null
  /** The keywords in the action's scope and their bids now (one for a keyword action; an ad group's or campaign's). */
  targets?: ReadonlyArray<{ id: string; bidCents: number }>
  /** bid_apply / placement_apply: what the rule's own dry run asked, from → to (cents, or % for a placement). */
  asked?: { from: number; to: number } | null
  /** set_placement_multiplier: the lane's placement % now. */
  lanePctNow?: number | null
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** What one rule action asks the brain for, and in words. Pure. */
export function directivesFor(ask: RuleAsk): { drafts: DirectiveDraft[]; words: string } {
  const a = ask.action
  const targets = ask.targets ?? []
  const share = SHARE_TRIGGERS.has(String(ask.trigger ?? ''))
  const perTarget = (kind: DirectiveKind, cents: (bid: number) => number, why: string) => {
    const drafts = targets.map((t) => ({ targetId: t.id, lane: null, kind, valueCents: cents(t.bidCents), valuePct: null, reason: why }))
    const one = drafts.length === 1 ? ` ${drafts[0].valueCents}¢` : ''
    return { drafts, words: drafts.length ? `a ${kindWords(kind)}${one} on ${plural(drafts.length, 'keyword')} (${why}), for ${DIRECTIVE_DAYS} days` : 'no keyword in its scope' }
  }
  switch (a.type) {
    case 'bid_down': {
      const pct = Math.abs(Number(a.percent ?? 20))
      return perTarget('CEILING', (b) => Math.max(FLOOR_CENTS, Math.round(b * (1 - pct / 100))), `bid_down −${pct}%`)
    }
    case 'bid_up': {
      const pct = Math.abs(Number(a.percent ?? 15))
      return perTarget(share ? 'SHARE_FLOOR' : 'FLOOR', (b) => Math.max(FLOOR_CENTS, Math.round(b * (1 + pct / 100))), `bid_up +${pct}%`)
    }
    case 'lower_bid_to_floor': {
      const floor = Math.max(FLOOR_CENTS, Number(a.floorCents ?? FLOOR_CENTS))
      return perTarget('CEILING', () => floor, `lower_bid_to_floor ${floor}¢`)
    }
    case 'raise_bids_for_rank_defense': {
      const pct = Math.min(50, Math.max(5, Number(a.percent ?? 20)))
      return perTarget('SHARE_FLOOR', (b) => Math.round(b * (1 + pct / 100)), `rank defense +${pct}%`)
    }
    case 'bid_to_target_acos': {
      const frac = typeof a.targetAcos === 'number' && a.targetAcos > 0 && a.targetAcos <= 5 ? a.targetAcos : null
      if (frac == null) return { drafts: [], words: 'it names no target of its own: the brain already steers to the goal in force' }
      const pct = Math.round(frac * 100)
      return { drafts: [{ targetId: null, lane: null, kind: 'GOAL', valueCents: null, valuePct: pct, reason: `bid_to_target_acos ${pct}%` }], words: `the goal ${pct}% ACoS for the campaign, for ${DIRECTIVE_DAYS} days` }
    }
    case 'bid_apply': {
      const op = String(a.op ?? '')
      if (GOAL_OPS.has(op)) {
        const own = Number(a.value)
        if (!(Number.isFinite(own) && own > 0)) return { drafts: [], words: 'it names no target of its own: the brain already steers to the goal in force' }
        const pct = Math.round(own)
        return { drafts: targets.slice(0, 1).map((t) => ({ targetId: t.id, lane: null, kind: 'GOAL' as const, valueCents: null, valuePct: pct, reason: `bid_apply ${op} ${pct}%` })), words: `the goal ${pct}% ACoS for this keyword, for ${DIRECTIVE_DAYS} days` }
      }
      const asked = ask.asked
      if (!asked || asked.to === asked.from) return { drafts: [], words: 'it asks no change' }
      const kind: DirectiveKind = asked.to < asked.from ? 'CEILING' : share ? 'SHARE_FLOOR' : 'FLOOR'
      return perTarget(kind, () => Math.max(FLOOR_CENTS, Math.round(asked.to)), `bid_apply ${op} ${asked.from}¢ → ${Math.round(asked.to)}¢`)
    }
    case 'set_placement_multiplier':
    case 'placement_apply': {
      const lane = LANE_OF[String(a.placement ?? 'PLACEMENT_TOP')]
      if (!lane) return { drafts: [], words: `“${String(a.placement)}” is not a placement lane` }
      const from = a.type === 'placement_apply' ? ask.asked?.from ?? null : Math.max(0, Number(ask.lanePctNow ?? 0))
      const to = a.type === 'placement_apply' ? ask.asked?.to ?? null : Math.max(0, Math.min(900, Math.round(Number(a.percentage ?? 0))))
      if (from == null || to == null || to === from) return { drafts: [], words: 'it asks no change' }
      const kind: DirectiveKind = to < from ? 'CEILING' : 'FLOOR'
      return {
        drafts: [{ targetId: null, lane, kind, valueCents: Math.round(to), valuePct: null, reason: `${a.type} ${from}% → ${Math.round(to)}%` }],
        words: `a ${laneWords(lane)} ${kind === 'CEILING' ? 'cap' : 'floor'} of ${Math.round(to)}%, for ${DIRECTIVE_DAYS} days`,
      }
    }
    default:
      return { drafts: [], words: `${a.type} is not a bid input` }
  }
}

function kindWords(kind: DirectiveKind): string {
  return kind === 'CEILING' ? 'ceiling' : kind === 'FLOOR' ? 'floor' : kind === 'SHARE_FLOOR' ? 'share floor' : 'goal'
}

function laneWords(lane: LaneName): string {
  return lane === 'TOP_OF_SEARCH' ? 'top-of-search' : lane === 'PRODUCT_PAGE' ? 'product-page' : 'rest-of-search'
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
type Ctx = Record<string, Record<string, unknown> | undefined>

/** The campaign a rule's action (and its context) points at, or null (an account-wide action). */
export async function directiveCampaignId(action: Record<string, unknown>, context: unknown): Promise<string | null> {
  const c = (context ?? {}) as Ctx
  const direct = str(action.campaignId) ?? str(c.campaign?.id) ?? str(c.adGroup?.campaignId) ?? str(c.adTarget?.campaignId)
  if (direct) return direct
  const groupId = str(action.adGroupId) ?? str(c.adGroup?.id) ?? str(c.adTarget?.adGroupId)
  if (groupId) return (await prisma.adGroup.findUnique({ where: { id: groupId }, select: { campaignId: true } }))?.campaignId ?? null
  const targetId = str(action.adTargetId) ?? str(c.adTarget?.id)
  if (targetId) return (await prisma.adTarget.findUnique({ where: { id: targetId }, select: { adGroup: { select: { campaignId: true } } } }))?.adGroup.campaignId ?? null
  return null
}

/** The keywords in an action's scope, with their bids now. */
async function scopeTargets(action: Record<string, unknown>, context: unknown, campaignId: string): Promise<Array<{ id: string; bidCents: number; adGroupId: string }>> {
  const c = (context ?? {}) as Ctx
  const select = { id: true, bidCents: true, adGroupId: true } as const
  const type = String(action.type)
  if (type === 'raise_bids_for_rank_defense') {
    return prisma.adTarget.findMany({ where: { status: 'ENABLED', isNegative: false, adGroup: { campaignId } }, select, take: MAX_TARGETS, orderBy: { id: 'asc' } })
  }
  if ((type === 'bid_down' || type === 'bid_up') && String(action.target ?? 'ad_target') === 'ad_group') {
    const groupId = str(action.adGroupId) ?? str(c.adGroup?.id)
    return groupId ? prisma.adTarget.findMany({ where: { adGroupId: groupId, status: 'ENABLED', isNegative: false }, select, take: MAX_TARGETS, orderBy: { id: 'asc' } }) : []
  }
  const id = str(action.adTargetId) ?? str(c.adTarget?.id)
  if (!id) return []
  const t = await prisma.adTarget.findUnique({ where: { id }, select })
  return t ? [t] : []
}

/** "120¢ → 96¢", "120→96 cents", "40% → 60%": the from and to a handler's dry run states. */
export function parseWouldChange(v: unknown): { from: number; to: number } | null {
  if (typeof v !== 'string') return null
  const m = /(-?\d+(?:\.\d+)?)\s*(?:¢|%|cents)?\s*→\s*(-?\d+(?:\.\d+)?)/.exec(v)
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null
}

/** The ACoS targets (integer %) the brain steers these ad groups of a campaign to now, as goalTarget reads them. */
async function goalsInForce(campaignId: string, adGroupIds: readonly string[]): Promise<Set<number>> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { marketplace: true, dynamicBidding: true } })
  const market = strategyMarket(camp?.marketplace)
  const groups = adGroupIds.length ? adGroupIds : (await prisma.adGroup.findMany({ where: { campaignId }, select: { id: true } })).map((g) => g.id)
  const [owner, strategy] = await Promise.all([readOwnerTargets([]), market ? loadStrategy(market, groups) : Promise.resolve(new Map())])
  const row = { ownTargetAcos: (camp?.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos } as CampaignRow
  const accountDefaultPct = typeof owner.accountDefaultPct === 'number' ? owner.accountDefaultPct : null
  const out = new Set<number>()
  for (const id of groups) {
    const g = goalTarget(row, strategy.get(id), accountDefaultPct)
    out.add(g.target?.kind === 'ACOS' ? Math.round(g.target.pct) : Number.NaN)
  }
  return out
}

/** Store a rule's drafts: each replaces the rule's own row for the same campaign, keyword, lane and kind. */
export async function writeDirectives(args: { campaignId: string; source: string; drafts: readonly DirectiveDraft[]; now?: Date }): Promise<{ until: Date; rows: number }> {
  const now = args.now ?? new Date()
  const until = new Date(now.getTime() + DIRECTIVE_DAYS * 86_400_000)
  if (!args.drafts.length) return { until, rows: 0 }
  await prisma.$transaction([
    prisma.bidDirective.deleteMany({
      where: { campaignId: args.campaignId, source: args.source, OR: args.drafts.map((d) => ({ targetId: d.targetId, lane: d.lane, kind: d.kind })) },
    }),
    prisma.bidDirective.createMany({
      data: args.drafts.map((d) => ({
        campaignId: args.campaignId, targetId: d.targetId, lane: d.lane, kind: d.kind, valueCents: d.valueCents, valuePct: d.valuePct,
        source: args.source, until, reason: d.reason.slice(0, 500),
      })),
    }),
  ])
  return { until, rows: args.drafts.length }
}

export interface RuleBrainMeta {
  ruleId: string
  trigger?: string | null
  dryRun: boolean
}

type DryRun = (action: { type: string } & Record<string, unknown>) => Promise<{ ok: boolean; output?: unknown; error?: string }>

/**
 * A rule action on a campaign the brain owns, as the brain's input: the action result to record in its place, or null
 * when the rule runs as before (ceiling not live, not a bid or placement action, an account-wide action, a campaign the
 * brain does not own). `dryRun` runs the rule's own handler as a dry run (bid_apply, placement_apply: what it asks).
 */
export async function ruleBrainInput(
  action: { type: string } & Record<string, unknown>,
  context: unknown,
  meta: RuleBrainMeta,
  dryRun: DryRun,
): Promise<{ type: string; ok: boolean; output?: unknown; error?: string } | null> {
  if (!brainLiveCeiling()) return null
  const carried = CARRIED_ACTIONS[action.type]
  if (!carried && !DIRECTIVE_ACTIONS.has(action.type)) return null
  const campaignId = await directiveCampaignId(action, context)
  if (!campaignId) return null
  if (!(await brainOwnedCampaignIds([campaignId])).has(campaignId)) return null
  const left = (words: string) => `left to the bid brain: ${words} (it runs campaign ${campaignId}; one writer per campaign)`
  if (carried) return { type: action.type, ok: true, output: { skipped: left(carried), campaignId } }

  const targets = action.type === 'bid_to_target_acos' || action.type === 'set_placement_multiplier' || action.type === 'placement_apply'
    ? []
    : await scopeTargets(action, context, campaignId)
  let asked: { from: number; to: number } | null = null
  if ((action.type === 'bid_apply' && !GOAL_OPS.has(String(action.op ?? ''))) || action.type === 'placement_apply') {
    // What the rule's own handler would set: its op, its Min/Max, the strategy band and its own skips, unchanged.
    const r = await dryRun(action)
    const out = (r.output ?? {}) as { skipped?: string; noChange?: boolean; wouldChange?: unknown }
    if (r.ok === false || out.skipped) return { type: action.type, ok: r.ok, ...(r.error ? { error: r.error } : {}), output: r.output }
    asked = out.noChange ? null : parseWouldChange(out.wouldChange)
  }
  let lanePctNow: number | null = null
  if (action.type === 'set_placement_multiplier') {
    const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
    const lanes = ((c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding ?? []
    lanePctNow = lanes.find((x) => x.placement === String(action.placement ?? 'PLACEMENT_TOP'))?.percentage ?? 0
  }
  const asks = directivesFor({ action, trigger: meta.trigger ?? null, targets, asked, lanePctNow })
  let drafts = asks.drafts
  let words = asks.words
  // A goal the brain already steers to is no input: nothing is stored (design §2 "or nothing if it repeats the strategy").
  const goal = drafts.find((d) => d.kind === 'GOAL')
  if (goal) {
    const groups = goal.targetId ? targets.filter((t) => t.id === goal.targetId).map((t) => t.adGroupId) : []
    const inForce = await goalsInForce(campaignId, groups)
    if (inForce.size === 1 && inForce.has(goal.valuePct!)) {
      drafts = []
      words = `the goal ${goal.valuePct}% ACoS is already the one in force`
    }
  }
  if (!drafts.length) return { type: action.type, ok: true, output: { noChange: true, bidBrain: left(words), campaignId } }
  const summary = drafts.slice(0, 5).map((d) => ({ targetId: d.targetId, lane: d.lane, kind: d.kind, valueCents: d.valueCents, valuePct: d.valuePct }))
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, campaignId, wouldChange: `a bid brain input: ${words}`, bidBrain: { directives: drafts.length, sample: summary } } }
  }
  const stored = await writeDirectives({ campaignId, source: `rule:${meta.ruleId}`, drafts })
  return { type: action.type, ok: true, output: { campaignId, bidBrain: { stored: `${words} — the brain reads it on its next run`, directives: stored.rows, until: stored.until.toISOString(), sample: summary } } }
}
