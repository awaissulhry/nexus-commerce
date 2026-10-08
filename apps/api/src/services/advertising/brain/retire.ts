/**
 * ONE BRAIN AB-20 — retire the duplicate writers of a product once its brain runs every lever (design 2026-10-08-ads-one-brain/
 * DESIGN.md §3 "one owner per lever", §8 row AB-20; BID-BRAIN-DESIGN.md §6 BB-12 "7 duplicate writers retire"). Today AB-6
 * already SKIPS an owned lever at run time; retirement is the cleanup that makes the skip unnecessary and the map clean. Pure:
 * who is ready, which configuration rows retire and which stay (each with why), and what a give-back does. brain/retire-run.ts
 * reads and writes.
 *
 *   ready      one product × market: enrolled, not excluded, the server switch live (NEXUS_BID_BRAIN_MODE: in shadow the brain
 *              only plans, so today's engines keep their rows), at least one campaign of its own, and EVERY lever settled —
 *              AUTO, or a level or a lock the Owner chose himself (the hours and structure levers ask a person and are never
 *              AUTO; a lever still at the brain's default, shadow, is not settled). A lever stopped by a kill switch is not
 *              held (the brain writes nothing there): the rows that write it stay on, or come back — the rest are unchanged.
 *   rows       an enabled configuration row of a writer the brain replaces — an ads rule, a budget schedule, a budget pool, a
 *              classic dayparting schedule, a coverage set, a running autopilot plan. It RETIRES only when
 *                · everything it reaches is the product's own campaigns in this market: a row that also reaches another
 *                  product, a campaign the product shares, another market or the whole account stays — switching it off
 *                  would change campaigns the brain does not run ("not owned → unchanged");
 *                · every lever it writes is held on each of those campaigns — owned by the brain (PROPOSE or AUTO; the
 *                  keyword bids: the bid brain runs the campaign LIVE or HELD) or locked by the Owner — and none of them is
 *                  excluded from the brain;
 *                · it does nothing else: a rule's bid and placement asks are the bid brain's inputs there (BB-9 directives:
 *                  a ceiling, a floor, a goal), and a notification or any other action no lever of the brain replaces;
 *                · it owes nothing: a budget schedule whose campaign still sits at the budget it set, or a dayparting
 *                  schedule still holding the bids its window raised, gives them back first (its own give-back runs when
 *                  its window ends).
 *              Retired = switched off (`enabled` false) with a record; never deleted. A row that stays is listed with why, and
 *              the run-time skip (AB-6) keeps it off the brain's levers as before.
 *   rowless    auto-bid, Top-of-Search defense, the external bidding engine and the hourly bid plans have no configuration row
 *              of their own per campaign: nothing to switch off — each is named with what keeps it off the product.
 *   give back  every retired row is switched on again when the product is no longer ready (it left the brain, a lever went
 *              back to the brain's default, the server switch no longer live); each row whose own levers the brain no longer
 *              holds on its campaigns (a lever back from AUTO to a level the Owner chose, a kill switch, a campaign excluded or
 *              shared since); and any a person asks for — only if nobody changed the row since it was retired (its
 *              fingerprint is the one retirement left); otherwise it is LEFT as the person made it, and said so.
 */
import { createHash } from 'node:crypto'
import { BRAIN_LEVERS, type BrainLever } from './levers.js'
import type { BrainSettings } from './settings.js'

export const RETIRE_TOOL = 'retire-ads-writers'

export const RETIRE_WRITERS = ['rule', 'budgetSchedule', 'budgetPool', 'dayparting', 'coverageSet', 'autopilotPlan'] as const
export type RetireWriter = (typeof RETIRE_WRITERS)[number]
export const isRetireWriter = (v: unknown): v is RetireWriter => typeof v === 'string' && (RETIRE_WRITERS as readonly string[]).includes(v)

/** Each writer in the Owner's words. */
export const WRITER_WORDS: Record<RetireWriter, string> = {
  rule: 'ads rule',
  budgetSchedule: 'budget schedule',
  budgetPool: 'budget pool',
  dayparting: 'classic dayparting schedule',
  coverageSet: 'coverage set',
  autopilotPlan: 'autopilot plan',
}

/** RETIRED switched off · GIVEN_BACK switched on again · LEFT changed by a person since (left as it is) · GONE no longer exists. */
export const RETIREMENT_STATUSES = ['RETIRED', 'GIVEN_BACK', 'LEFT', 'GONE'] as const
export type RetirementStatus = (typeof RETIREMENT_STATUSES)[number]

/** A writer with no configuration row of its own per campaign: nothing to switch off, and what keeps it off the product. */
export interface RowlessWriter { writer: string; levers: BrainLever[]; why: string }

export const ROWLESS_WRITERS: readonly RowlessWriter[] = [
  {
    writer: 'auto-bid', levers: ['bids'],
    why: 'it has no row per campaign — it moves the keywords of every allowlisted campaign nobody else holds — and it leaves each campaign the bid brain runs (BB-6); its only switch per campaign, the live-write allowlist, is one the brain needs itself',
  },
  {
    writer: 'Top-of-Search defense', levers: ['placements'],
    why: 'it has no row per campaign (one server switch for the whole business); it leaves the campaigns the bid brain runs and every placement a product\'s brain owns (AB-6)',
  },
  {
    writer: 'the external bidding engine', levers: ['bids'],
    why: 'it has no row per campaign; it is never handed a keyword of a campaign the bid brain runs (BB-6)',
  },
  {
    writer: 'Hourly bid plans', levers: ['hours', 'placements'],
    why: 'an hourly bid plan is the brain\'s own input on its campaigns (BB-7: the bid brain runs it as hour factors and placements): never retired',
  },
]

// ── Readiness ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LeverReadiness {
  lever: BrainLever
  /** What the brain does with it: AUTO, PROPOSE, OBSERVE, OFF, LOCKED. */
  effective: string
  /** default · product · campaign — where the level comes from. */
  source: string
  ok: boolean
  why: string
}

export interface Readiness {
  ready: boolean
  /** One sentence. */
  why: string
  /** What keeps the product from being ready, one line each (empty when ready). */
  blockers: string[]
  levers: LeverReadiness[]
}

export interface ReadinessInput {
  enrolled: boolean
  /** NEXUS_BID_BRAIN_MODE is live. */
  ceilingLive: boolean
  /** The server switch's value, in words (off, shadow, live). */
  ceiling: string
  /** The product's own settings (no campaign); null when it is not enrolled. */
  settings: Pick<BrainSettings, 'excluded' | 'levers'> | null
  /** The kill switches standing on the product's levers, in words. */
  kills: Partial<Record<BrainLever, string>>
  ownCampaigns: number
}

/** Whether every lever of a product is settled, so its duplicate writers may retire. Pure. */
export function retireReadiness(input: ReadinessInput): Readiness {
  const blockers: string[] = []
  if (!input.enrolled || !input.settings) {
    return { ready: false, why: 'the product is not enrolled in the brain: today\'s engines run it, nothing retires', blockers: ['not enrolled in the brain (set-ads-brain op enroll)'], levers: [] }
  }
  const s = input.settings
  if (s.excluded.value) blockers.push('the Owner excluded the product from the brain: today\'s engines run it')
  if (!input.ceilingLive) blockers.push(`the server switch NEXUS_BID_BRAIN_MODE is ${input.ceiling || 'off'}, not live: the brain only plans in shadow, so today's engines keep their rows`)
  if (input.ownCampaigns === 0) blockers.push('the product has no campaign of its own in this market: nothing a writer of it could be retired from')
  const levers: LeverReadiness[] = BRAIN_LEVERS.map((lever) => {
    const l = s.levers[lever]
    const kill = input.kills[lever]
    const base = { lever, effective: String(l.effective), source: l.level.source }
    // A kill does not unsettle the lever: its rows are simply not held (they stay on, or come back) while it stands.
    const killed = kill ? `; stopped by a kill switch (${kill}): the writers of this lever stay on while it stands` : ''
    const settled = (why: string): LeverReadiness => ({ ...base, ok: true, why: `${why}${killed}` })
    if (l.effective === 'AUTO') return settled(`AUTO (${l.level.source === 'default' ? 'the brain\'s default' : `the Owner's ${l.level.source} choice`})`)
    if (l.effective === 'LOCKED') return settled('locked at the Owner\'s own value: the Owner\'s choice')
    if (l.effective === 'EXCLUDED' || l.effective === 'NOT_ENROLLED') return { ...base, ok: false, why: l.why }
    if (l.level.source !== 'default') return settled(`${l.effective}, the Owner's own choice (${l.why})`)
    return { ...base, ok: false, why: `${l.effective} by the brain's default: set it to AUTO, or choose its level yourself (set-ads-brain op set-level)` }
  })
  const unsettled = levers.filter((l) => !l.ok)
  if (unsettled.length) blockers.push(`${unsettled.length} lever${unsettled.length === 1 ? ' is' : 's are'} not settled: ${unsettled.map((l) => `${l.lever} (${l.why})`).join('; ')}`)
  const ready = blockers.length === 0
  return {
    ready,
    why: ready
      ? 'every lever is AUTO or the Owner\'s own choice, under the live server switch: the writers the brain replaces on its own campaigns may retire'
      : `not ready: ${blockers[0]}${blockers.length > 1 ? ` (and ${blockers.length - 1} more)` : ''}`,
    blockers,
    levers,
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One of the product's own campaigns: whether each lever is held there, and why. */
export interface CampaignHold {
  campaignId: string
  name: string
  /** The Owner keeps the campaign out of the brain: today's engines run it. Null when not. */
  excluded: string | null
  levers: Partial<Record<BrainLever, { held: boolean; why: string }>>
}

/**
 * Rule actions that are the bid brain's inputs on its campaigns (bid-brain/rule-directives.ts, BB-9): never a second writer
 * there, so a rule taking one stays (retiring it would drop the Owner's ceiling, floor or goal).
 */
export const DIRECTIVE_ACTIONS: readonly string[] = [
  'bid_apply', 'bid_down', 'bid_up', 'bid_to_target_acos', 'lower_bid_to_floor', 'raise_bids_for_rank_defense', 'set_placement_multiplier', 'placement_apply',
  'set_campaign_target_acos',
]
/** Rule actions that do nothing on a campaign the bid brain runs (BB-9: the hour factor and the order value carry them). */
export const ABSORBED_ACTIONS: readonly string[] = ['dayparting_apply', 'scale_bids_for_price_change']

/** One action of a rule, with the levers it moves (read-map.ts leversOfRuleAction). */
export interface RuleAction { type: string; target?: string | null; levers: BrainLever[] }

export type RuleActionClass = 'lever' | 'directive' | 'absorbed' | 'other'

/** How a rule action counts for retirement. Pure. */
export function classifyRuleAction(a: RuleAction): RuleActionClass {
  // An ad group's default bid has no directive: bid_down / bid_up there write the ad-group bids lever (AB-6 ruleActionLever).
  if ((a.type === 'bid_down' || a.type === 'bid_up') && String(a.target ?? '') === 'ad_group') return 'lever'
  if (DIRECTIVE_ACTIONS.includes(a.type)) return 'directive'
  if (ABSORBED_ACTIONS.includes(a.type)) return 'absorbed'
  return a.levers.length ? 'lever' : 'other'
}

/** The levers a rule action writes for retirement (an ad group's bid_down / bid_up: its default bids). Pure. */
export function ruleActionLevers(a: RuleAction): BrainLever[] {
  if ((a.type === 'bid_down' || a.type === 'bid_up') && String(a.target ?? '') === 'ad_group') return ['adGroupBids']
  if (ABSORBED_ACTIONS.includes(a.type)) return ['bids']
  return a.levers
}

/** One enabled configuration row that writes a lever of the product's campaigns. */
export interface RetireCandidate {
  writer: RetireWriter
  id: string
  name: string
  /** Its configuration as a hash (retireFingerprint): the plan's basis, and what a give-back checks. */
  fingerprint: string
  /** What it reaches: the campaigns, or why it reaches beyond any list (the whole account, a market, every market). */
  reach: { campaignIds: string[] } | { beyond: string }
  /** The levers it writes (a rule's: from its actions). */
  levers: BrainLever[]
  /** A rule's actions. */
  actions?: RuleAction[]
  /** It still owes a give-back (a budget it set, bids it raised): what, in words. */
  owes?: string | null
  /** How it is set up, in a few words (its scope, its level). */
  scope: string
}

export interface PlannedRow {
  writer: RetireWriter
  id: string
  name: string
  scope: string
  levers: BrainLever[]
  campaignIds: string[]
  fingerprint: string
  why: string
}

export interface RetirePlan {
  /** Exactly what a retirement switches off, each with why. */
  retire: PlannedRow[]
  /** What stays switched on, each with why. */
  keep: PlannedRow[]
  rowless: readonly RowlessWriter[]
  /** What the approval stands on: the rows to switch off and their configuration. */
  basis: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const listWords = (xs: readonly string[], max = 3) => `${xs.slice(0, max).join(', ')}${xs.length > max ? ` and ${xs.length - max} more` : ''}`

/** Where a row's levers are not held on one of its campaigns: the first such lever and campaign, in words; null when held. */
function notHeld(levers: readonly BrainLever[], ids: readonly string[], own: ReadonlyMap<string, CampaignHold>): string | null {
  for (const id of ids) {
    const c = own.get(id)
    if (!c) continue
    for (const lever of levers) {
      const h = c.levers[lever]
      if (!h?.held) return `it writes the ${lever} lever of "${c.name}" (${id}), which the brain does not hold there (${h?.why ?? 'not read'})`
    }
  }
  return null
}

/** The plan's basis: the rows to switch off with their configuration. Pure. */
export function retireBasis(rows: ReadonlyArray<Pick<PlannedRow, 'writer' | 'id' | 'fingerprint'>>): string {
  const key = rows.map((r) => `${r.writer}:${r.id}:${r.fingerprint}`).sort().join('|')
  return createHash('sha256').update(key || 'nothing').digest('hex').slice(0, 16)
}

/**
 * Which of the candidates retire and which stay, each with why (header rules). `own` holds the product's own campaigns in
 * the market; a candidate reaching none of them is not this product's writer and is left out. Pure.
 */
export function planRetirement(input: { own: ReadonlyMap<string, CampaignHold>; candidates: readonly RetireCandidate[] }): RetirePlan {
  const retire: PlannedRow[] = []
  const keep: PlannedRow[] = []
  for (const c of [...input.candidates].sort((a, b) => a.writer.localeCompare(b.writer) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const ids = 'campaignIds' in c.reach ? [...new Set(c.reach.campaignIds)].sort() : []
    const base = { writer: c.writer, id: c.id, name: c.name, scope: c.scope, levers: [...new Set(c.levers)].sort() as BrainLever[], campaignIds: ids, fingerprint: c.fingerprint }
    const stay = (why: string) => keep.push({ ...base, why: `stays: ${why}; the run-time skip (AB-6) keeps it off the brain's levers` })
    if ('beyond' in c.reach) { stay(`it reaches ${c.reach.beyond} — switching it off would change campaigns the brain does not run`); continue }
    if (!ids.length) continue
    const others = ids.filter((id) => !input.own.has(id))
    if (others.length === ids.length) continue
    if (others.length) { stay(`it also reaches ${plural(others.length, 'campaign')} that ${others.length === 1 ? 'is' : 'are'} not this product's own (${listWords(others)}) — switching it off would change ${others.length === 1 ? 'it' : 'them'}`); continue }
    const excluded = ids.map((id) => input.own.get(id)!).filter((h) => h.excluded)
    if (excluded.length) { stay(`campaign "${excluded[0].name}" is out of the brain (${excluded[0].excluded}): today's engines run it`); continue }
    if (c.writer === 'rule') {
      const actions = c.actions ?? []
      const directives = [...new Set(actions.filter((a) => classifyRuleAction(a) === 'directive').map((a) => a.type))]
      if (directives.length) { stay(`its ${listWords(directives)} ${directives.length === 1 ? 'action is an input' : 'actions are inputs'} the bid brain reads on these campaigns (BB-9: a ceiling, a floor or a goal), never a second writer — retiring it would drop ${directives.length === 1 ? 'it' : 'them'}`); continue }
      const other = [...new Set(actions.filter((a) => classifyRuleAction(a) === 'other').map((a) => a.type))]
      if (other.length) { stay(`it also does ${listWords(other)}, which no lever of the brain does`); continue }
    }
    if (!base.levers.length) { stay('it writes no lever the brain could hold'); continue }
    const held = notHeld(base.levers, ids, input.own)
    if (held) { stay(held); continue }
    if (c.owes) { stay(`it still holds ${c.owes}: its own give-back runs when its window ends — retire it after that`); continue }
    retire.push({ ...base, why: `every campaign it reaches is this product's own (${plural(ids.length, 'campaign')}) and the brain holds every lever it writes there (${base.levers.join(', ')}): a duplicate writer` })
  }
  return { retire, keep, rowless: ROWLESS_WRITERS, basis: retireBasis(retire) }
}

// ── Fingerprints and the give-back ───────────────────────────────────────────────────────────────────────────────

/** JSON with sorted keys and Dates as ISO strings: one configuration, one string (the loader passes a Decimal as its text). */
export function stableJson(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (v instanceof Date) return JSON.stringify(v.toISOString())
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * The configuration fingerprint of a row: only the fields a person sets (never the engines' own bookkeeping — counters,
 * last-run times, memos), so an engine's tick changes nothing and a person's edit always does. Pure.
 */
export function retireFingerprint(config: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(config)).digest('hex').slice(0, 16)
}

export type GiveBackAct = 'switchOn' | 'already' | 'left' | 'gone'

/**
 * What a give-back does with one retired row: switch it on (nobody changed it since), nothing (a person switched it on
 * already), leave it (a person changed it since — his edit wins) or nothing (the row is gone). `now` is the row as it is
 * (null: gone); `left` the fingerprint retirement left. Pure.
 */
export function giveBackDecision(retiredAt: string, left: string, now: { enabled: boolean; fingerprint: string } | null): { act: GiveBackAct; why: string } {
  if (!now) return { act: 'gone', why: 'the row no longer exists: nothing to switch on' }
  if (now.enabled) return { act: 'already', why: 'it is on again already (a person switched it on since it was retired)' }
  if (now.fingerprint !== left) return { act: 'left', why: `a person changed it after it was retired (${retiredAt.slice(0, 10)}): left as they made it — switch it on yourself if you want it back` }
  return { act: 'switchOn', why: 'switched on again exactly as it was before it was retired' }
}
