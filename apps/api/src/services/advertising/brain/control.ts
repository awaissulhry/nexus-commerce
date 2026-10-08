/**
 * ONE BRAIN — the Owner's control of a product's brain (design 2026-10-08-ads-one-brain/DESIGN.md §6, §2.10, §10:
 * "I should be able to control it individually as well"; code rule A). The backend of the `set-ads-brain` MCP tool and
 * of the Owner's own page (§10: Claude builds no screen). Every op is a PLAN first (previewControl: what changes, from →
 * to, on which campaigns, what the brain starts doing, what can add spend, whether it is a big door), then — once a person
 * approved it — the same plan run on the same basis (runControl). Every default is the brain's; the Owner's setting
 * always wins (brain/settings.ts resolves it, with who set it, when and why).
 *
 *   enroll     a product × market enters the brain (enrollProduct): every lever starts OBSERVE unless `levels` names
 *              another level the lever takes today (levers.ts LEVER_LEVELS_NOW). The bids lever is ADOPTED from the
 *              campaigns as they are (AUTO when the bid brain already runs one of them LIVE or HELD) and is never moved
 *              here: enrolling moves no campaign, so it writes nothing at Amazon. Choices left open from an earlier
 *              enrollment (levels, values) are ended first; the Owner's locks and exclusions stay and apply.
 *   set-level  a lever's level for the product or one campaign (`reset`: end it — the campaign follows the product again,
 *              the product the brain's default). The bids lever moves the BidBrainEnrollment rows of the campaigns it
 *              reaches (AB-1's rules: a campaign that may go LIVE does, one that may not is a named skip).
 *   lock       a lever held at the Owner's own value — the whole lever, or one thing in it (an hour cell, a lane, a term,
 *   / unlock   an ad group, a keyword) — on the product or one campaign: the brain writes nothing there and only recommends.
 *   exclude    the product or one campaign out of the brain: today's engines run it.
 *   / include
 *   set-value  one of the brain's settings (levers.ts BRAIN_SETTINGS, inside its bounds), per product or, where it means
 *              something for one campaign, per campaign (`reset`: back to the product's value or the default).
 *   leave      the product out of the brain: the enrollment goes, its levels and values end (every lever back to OFF:
 *              today's engines run it), the Owner's locks and exclusions stay. Its own campaigns the bid brain runs LIVE or
 *              HELD are given back (default: their bids and placements as they were when they went LIVE — the bid brain's
 *              own give-back), taken back to shadow with their bids where they are, or kept running one by one. Batch 2
 *              fix — what the brain still holds goes with it: every request it asked for that still waits for a person
 *              (its budgets, cap, pauses, negatives, harvests, painted hourly plans) is withdrawn in the same transaction (an
 *              approved one would run as the approver after the product left), and each campaign its own pause holds is
 *              resumed after the commit, as the approver (`pauses`: resume, the default — lifting an automation's pause is a
 *              big door under code rule A, so the approver's code; or keep: they stay paused, each named, a normal approval).
 *
 *   big door   code rule A: a change that takes any lever to AUTO — on the product or one of its own campaigns, by a level,
 *              an unlock, an include, a reset or an enrollment (an adopted AUTO included) — or that puts a campaign under
 *              the bid brain, needs the approver's authenticator code (`needsCode`, with each reason in `bigDoor`). Batch 2
 *              review fix (lead decision) — so does a value that RAISES the product's portfolio cap limit
 *              (portfolioCapLimitCents, the limit in force before → after, the server's where none is set: limitRaise).
 *              Everything else (OBSERVE, PROPOSE, OFF, locks, exclusions, other values, a lower limit, leave) is a normal
 *              approval; what can add spend is listed in `raises` and said in the effect, never silently.
 *   refusals   a level a lever does not take yet, a value outside its bounds or the wrong scope, a lock ref the lever has
 *              no such thing for, a lever to AUTO while one of Amazon's own rules acts on it there (AB-4), a campaign that
 *              does not advertise the product, and a change that changes nothing — each said, nothing queued.
 *   basis      what the approval is made on: the enrollment's version and the plan's basis (AB-1 planBasis, or this op's
 *              own fingerprint). A change runs only on the same ones; anything moved since refuses it ("preview it again").
 *
 * Nothing here writes to Amazon itself. A campaign put LIVE is written by the bid brain's own runs (while the server switch
 * NEXUS_BID_BRAIN_MODE is live); a campaign taken back to shadow gets what a stop saved back (AB-1 runChange, after the
 * commit); op leave's give-back is the tool's, after the commit (set-bid-brain-enrollment's putBack).
 */
import { createHash } from 'node:crypto'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { LEVER_WORDS } from '../ads-write-gate.js'
import { enrollmentFacts, enrollRefusal, giveBackPlan, PLANS_JOIN_THE_BRAIN, setEnrollment, stopMemoryOf, type EnrollMode } from '../bid-brain/enrollment.js'
import { bidBrainMode } from '../bid-brain/shadow.js'
import { adoptedBidsLevel, BrainRefusal, campaignsOf, endOverride, enrollProduct, openOverrides, planOverride, setOverride, type OverridePlan } from './enrollment.js'
import { forgetLeverOwners, GATE_LEVERS } from './lever-owners.js'
import {
  BRAIN_LEVERS, BRAIN_SETTINGS, isLever, isLevel, isSetting, LEVER_LEVELS_NOW, levelRefusal, lockRef, type BrainLever, type BrainLevel, type BrainSetting,
  type SettingValue,
} from './levers.js'
import { loadNativeRules, nativeAutoRefusal, nativeRuleLines } from './native-rules.js'
import { productFamily } from './ownership.js'
import {
  describeProvenance, EXCLUDE_KEY, overrideIdentity, resolveBrainSettings, type BrainSettings, type LeverSettings, type OverrideInput, type OverrideKind,
  type OverrideRow, type Provenance,
} from './settings.js'
import { brainPausesInForce } from './state-load.js'
import { PORTFOLIO_CAP_LIMIT_SETTING, serverPortfolioCapLimitCents } from './portfolio-cap-limit.js'

export const CONTROL_TOOL = 'set-ads-brain'
export const CONTROL_OPS = ['enroll', 'set-level', 'lock', 'unlock', 'exclude', 'include', 'set-value', 'leave'] as const
export type ControlOp = (typeof CONTROL_OPS)[number]
/** op leave — what happens to the product's own campaigns the bid brain runs LIVE or HELD. */
export const LEAVE_BIDS = ['give-back', 'shadow', 'keep'] as const
export type LeaveBids = (typeof LEAVE_BIDS)[number]
/** op leave — what happens to the campaigns the brain's own pause holds: resumed as the approver, or kept paused. */
export const LEAVE_PAUSES = ['resume', 'keep'] as const
export type LeavePauses = (typeof LEAVE_PAUSES)[number]
/** The reason a request the brain asked for carries when leaving withdraws it (approval.tools.ts reads `withdrawn:`). */
export const LEAVE_WITHDRAWN = 'withdrawn: the product left the ads brain (set-ads-brain op leave)'
/** MCP.12 — the words every tool uses for a product that is deleted or not in this business. */
export const PRODUCT_NOT_FOUND = 'Product not found'

export interface ControlInput {
  op: ControlOp
  productId: string
  market: string
  campaignId?: string | null
  lever?: string | null
  level?: string | null
  /** enroll: the starting level per lever (every lever not named starts OBSERVE; bids follows its campaigns). */
  levels?: Partial<Record<string, string | null | undefined>> | null
  ref?: string | null
  key?: string | null
  value?: unknown
  reset?: boolean | null
  bids?: LeaveBids | null
  /** leave: the campaigns the brain's own pause holds — resumed (default) or kept paused. */
  pauses?: LeavePauses | null
}

type Effective = LeverSettings['effective']
type Camp = { campaignId: string; name: string; status: string; mode: EnrollMode | null; owner: 'own' | 'shared' }

/** One campaign the op reaches (or does not), with what changes on it in plain words. */
export interface CampaignReach {
  campaignId: string
  name: string
  owner: 'own' | 'shared'
  status: string
  /** What changes there: a lever's effective level (several levers with the same move in one line), a setting, the bid brain. */
  changes: Array<{ what: string; from: string; to: string }>
  reached: boolean
  why: string
}

export interface ControlPreview {
  action: typeof CONTROL_TOOL
  op: ControlOp
  /** The card's first line (PreviewConvention). */
  summary: string
  /** The product's name and SKU (PreviewConvention). */
  product: string
  sku: string
  brain: { productId: string; market: string; enrolled: boolean; version: number | null }
  scope: { level: 'product' } | { level: 'campaign'; campaignId: string; name: string; owner: 'own' | 'shared' }
  /** override ops: the Owner's choice from → to (the value that applies now with its source, and after). */
  change?: { kind: OverrideKind; key: string; ref: string; from: string; to: string }
  /** The before → after table the Approvals page shows (≤ 20 lines). */
  changes: Record<string, { from: unknown; to: unknown }>
  totals: Record<string, number>
  campaigns: CampaignReach[]
  notReached: Array<{ campaignId: string; name: string; why: string }>
  /** The bids lever: what happens to each campaign's place in the bid brain. */
  bids?: Array<{ campaignId: string; name: string; op: string; why?: string }>
  /** Where a lever goes to AUTO (the product, campaignId null, or one of its own campaigns): a big door. */
  turnsAuto: Array<{ where: string; campaignId: string | null; lever: BrainLever }>
  /** What the brain will start (or stop) doing, lever by lever. */
  starts: string[]
  raises: string[]
  warnings: string[]
  needsCode: boolean
  /** Why it is a big door (each reason). */
  bigDoor: string[]
  ceiling: 'off' | 'shadow' | 'live'
  basis: string
  version: number | null
  reachNote: string
  undoNote: string
  enroll?: { adoptedBids: 'AUTO' | 'OBSERVE'; adoptedLive: string[]; keptInShadow: string[]; levels: Partial<Record<BrainLever, BrainLevel>>; ends: string[] }
  leave?: {
    bids: LeaveBids
    ends: Array<{ id: string; scope: string; campaignId: string | null; kind: string; key: string; value: unknown }>
    keeps: Array<{ id: string; scope: string; campaignId: string | null; kind: string; key: string; ref: string }>
    giveBack: Array<{ campaignId: string; name: string; keywordBids: number; adGroupBids: number; placements: boolean; raises: number }>
    toShadow: Array<{ campaignId: string; name: string; stopMemory: string | null }>
    keepLive: Array<{ campaignId: string; name: string; mode: string }>
    /** The campaigns the brain's own pause holds now, each resumed (`pauses: resume`) or kept paused, with the pause's causes. */
    pauses: LeavePauses
    brainPauses: Array<{ campaignId: string; name: string; since: string | null; causes: string[]; expectedEnd: string | null; resumes: boolean }>
    /** The requests the brain asked for that still wait for a person: withdrawn by leaving. */
    withdraws: Array<{ approvalId: string; tool: string; lever: string; requestedAt: string }>
  }
}

/** What the run needs beside the preview (never shown, never stored). */
interface Exec {
  root: string
  market: string
  change?: { op: 'set'; input: OverrideInput } | { op: 'end'; input: Omit<OverrideInput, 'value'> }
  /** The Owner's choice before (override ops): its identity, and whether one was open with which value. */
  before?: { scope: string; campaignId: string | null; kind: OverrideKind; key: string; ref: string; open: boolean; value: unknown }
  after?: { open: boolean; value: unknown }
  enrollLevels?: Array<{ lever: BrainLever; level: BrainLevel }>
  enrollEnds?: string[]
  leave?: {
    ends: string[]; moves: Array<{ campaignId: string; op: 'shadow' | 'give-back' }>; productLevels: Partial<Record<BrainLever, BrainLevel>>
    /** Batch 2 fix — the brain's waiting requests withdrawn in the transaction, and the pauses resumed after the commit. */
    withdraws: string[]
    resumes: Array<{ campaignId: string; statusBefore: string }>
  }
}

export type ControlOutcome = { ok: true; preview: ControlPreview; exec: Exec } | { ok: false; refusal: string }

const no = (refusal: string): ControlOutcome => ({ ok: false, refusal })
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (list: ReadonlyArray<{ name: string }>, shown = 4) => `${list.slice(0, shown).map((c) => c.name).join(', ')}${list.length > shown ? ` and ${list.length - shown} more` : ''}`
const hash = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16)
const isOwnedMode = (m: EnrollMode | null) => m === 'LIVE' || m === 'HELD'
const leverWord = (l: BrainLever) => LEVER_WORDS[l]

/** The market as enrollments store it ('IT'); null when it is not a market code. */
export function marketCode(market: string): string | null {
  const m = strategyMarket(market)
  return m && /^[A-Z]{2}$/.test(m) ? m : null
}

/** An effective level in a person's words. */
export function effectiveWord(e: Effective): string {
  return e === 'NOT_ENROLLED' ? 'OFF (not enrolled)' : e === 'OBSERVE' ? 'OBSERVE (shadow)' : e
}

/** What the brain decides on each lever when it runs it (the design's §2 line), in a person's words. */
export const LEVER_DECIDES: Record<BrainLever, string> = {
  bids: 'each keyword bid toward the goal, at most once per new data day, inside the strategy\'s limits',
  adGroupBids: 'each ad group\'s default bid',
  hours: 'the market\'s hours each week and the hourly plan it paints from them (a plan change always asks a person, D3)',
  placements: 'the placement % of each hour, with the painted hourly plan',
  state: 'a pause for a stop of 3 days or more and its resume (an archive is only ever proposed)',
  budgets: 'each campaign\'s daily budget inside the pace, and the intraday ladder',
  portfolioCap: 'the Amazon portfolio cap, monthly, never below this month\'s spend',
  negatives: 'where and what to negate (waste, the product set, isolation) inside each campaign\'s negative budget, and revives',
  harvest: 'converting search terms graduated to exact keywords, each with its source negatives',
  structure: 'new campaigns, built as proposals',
  biddingStrategy: 'each campaign\'s Amazon bidding strategy',
  offAmazon: 'the off-Amazon setting',
}

/**
 * What the brain does with a lever at this effective level, in plain words — "what it will start doing". `ceiling` is
 * the server switch: the brain owns a lever (PROPOSE, AUTO) only under a live one. Each line ends with what the lever's
 * own code does today (levers.ts LEVER_LEVELS_NOW), so a lever whose writer is not built yet never reads as live.
 */
export function leverDoes(lever: BrainLever, e: Effective, ceiling: 'off' | 'shadow' | 'live'): string {
  const others = `today: ${LEVER_LEVELS_NOW[lever].others}`
  const decides = LEVER_DECIDES[lever]
  const notLive = ceiling !== 'live' ? `; while the server switch NEXUS_BID_BRAIN_MODE is ${ceiling}, it decides in shadow and today's engines keep writing` : ''
  switch (e) {
    case 'NOT_ENROLLED': return 'the brain leaves it: today\'s engines run it'
    case 'EXCLUDED': return 'excluded by the Owner: the brain leaves it completely and today\'s engines run it'
    case 'LOCKED':
      return `held at the Owner's own value: the brain writes nothing there and only recommends${GATE_LEVERS.includes(lever) ? '; under a live server switch the write gate refuses every other automatic writer on it too (a person still passes)' : lever === 'bids' ? '; the bid brain leaves its keyword bids (a LIVE campaign goes back to shadow) — pin the campaign\'s bids to hold them from every engine' : ''}`
    case 'OFF': return 'OFF: the brain leaves it to today\'s engines and logs nothing'
    case 'OBSERVE': return `shadow: the brain decides ${decides} and logs it, and writes nothing (${others})`
    case 'PROPOSE': return `the brain decides ${decides} and asks a person for each change in the Approvals page${notLive} (${others})`
    case 'AUTO': return `the brain decides ${decides} and is its one automatic writer, inside the caps; every other automatic writer is refused on it${notLive} (${others})`
  }
}

/**
 * What the brain will start (or stop) doing on these levers, one line per move: levers with the same move to OBSERVE,
 * EXCLUDED or OFF share a line (the same words); a lever going to PROPOSE, AUTO or LOCKED gets its own (its own words). Pure.
 */
export function startLines(levers: readonly BrainLever[], from: (l: BrainLever) => Effective, to: (l: BrainLever) => Effective, ceiling: 'off' | 'shadow' | 'live', where = ''): string[] {
  const shared = new Map<string, BrainLever[]>()
  const out: string[] = []
  const on = where ? ` on ${where}` : ''
  for (const l of levers) {
    const f = from(l)
    const t = to(l)
    if (f === t) continue
    if (t === 'OBSERVE' || t === 'EXCLUDED' || t === 'OFF' || t === 'NOT_ENROLLED') shared.set(`${f}\u0000${t}`, [...(shared.get(`${f}\u0000${t}`) ?? []), l])
    else out.push(`${leverWord(l)}${on}: ${effectiveWord(f)} → ${effectiveWord(t)} — ${leverDoes(l, t, ceiling)}`)
  }
  for (const [k, ls] of shared) {
    const [f, t] = k.split('\u0000') as [Effective, Effective]
    const what = ls.length === BRAIN_LEVERS.length ? 'every lever' : ls.map(leverWord).join(', ')
    const words = ls.length === 1 ? leverDoes(ls[0], t, ceiling)
      : t === 'OBSERVE' ? 'shadow: the brain decides and logs each of them, and writes nothing' : leverDoes(ls[0], t, ceiling)
    out.unshift(`${what}${on}: ${effectiveWord(f)} → ${effectiveWord(t)} — ${words}`)
  }
  return out
}

/** What going to AUTO can add in spend, per lever (said, never silent). A lever not listed adds none by itself. */
const AUTO_RAISES: Partial<Record<BrainLever, string>> = {
  bids: 'the bid brain may raise keyword bids toward the goal, inside the strategy\'s limits',
  budgets: 'the brain may raise campaign budgets inside the pace and the day\'s move limit, and add the intraday ladder',
  state: 'the brain may resume campaigns it paused once their stop ends (spend restarts)',
  harvest: 'the brain may add new exact keywords from converting search terms, each starting to spend',
}

/**
 * How a change of each setting can add spend: `up` (a higher value), `down` (a lower one), `off` (true → false), `on`
 * (false → true), a value change of an enum, or never. Every setting is rated (a test holds it); one a later PR adds and
 * forgets is said as not rated, never as safe.
 */
type Rating = { when: 'up' | 'up-or-cleared' | 'down' | 'off' | 'never' | 'cleared-or-earlier' | { from: string; to: string }; words: string }
export const SPEND_RATINGS: Partial<Record<BrainSetting, Rating>> = {
  negativesPerDay: { when: 'down', words: 'fewer new negatives a day: wasted clicks may run longer' },
  negativesPerEntityWarn: { when: 'never', words: 'a warning level only' },
  negativesPerEntityMax: { when: 'down', words: 'fewer negatives fit in a campaign or ad group: wasted clicks may run longer' },
  negativesShadowDays: { when: 'never', words: 'how long the negatives lever stays in shadow before it acts' },
  harvestPerDay: { when: 'up', words: 'more new keywords a day, each starting to spend' },
  newCampaignsPerWeek: { when: 'up', words: 'more new campaigns a week, each with its own budget' },
  skcMax: { when: 'up', words: 'more single-keyword campaigns, each with its own budget' },
  firstBudgetPctOfEnvelope: { when: 'up', words: 'a new campaign starts with a larger budget' },
  minBidEntriesPerDay: { when: 'down', words: 'fewer Min-bid hours a day: campaigns bid normally in more hours' },
  hourCellMovePct: { when: 'up', words: 'a painted hour may move further, raises included' },
  hourProposalsPerWeek: { when: 'never', words: 'how often the brain asks; each plan still waits for a person' },
  hourResearchWeeks: { when: 'never', words: 'how much history the research reads' },
  hourPlanAsLimits: { when: 'off', words: 'the brain may raise an hour above the Owner\'s own painted plan' },
  biddingStrategySwitchDays: { when: 'down', words: 'bidding-strategy switches (up and down lets Amazon raise a bid up to +100 %) may come more often' },
  budgetUsePct: { when: 'down', words: 'a campaign budget is sized for a lower use, so budgets come out larger' },
  intradayLadderMaxPct: { when: 'up', words: 'a larger intraday budget raise' },
  paceTargetPct: { when: 'up', words: 'the pace aims at more of the month\'s budget by month end' },
  portfolioCapOn: { when: 'off', words: 'the Amazon portfolio cap — the only hard limit Amazon enforces — is no longer set by the brain' },
  portfolioCapPct: { when: 'up', words: 'a higher Amazon portfolio cap (the hard backstop)' },
  portfolioCapCents: { when: 'up', words: 'a higher Amazon portfolio cap (the hard backstop)' },
  // Empty means the server's limit, which may be higher than the value it replaces: a reset is said as a possible raise too.
  portfolioCapLimitCents: { when: 'up-or-cleared', words: 'a higher limit for this product\'s Amazon portfolio caps: a larger cap may be asked for, written by the brain or set by a person (empty = the server\'s limit, which may be higher)' },
  ownPortfolio: { when: 'never', words: 'where the brain proposes to put the product\'s campaigns' },
  strategySwitchMode: { when: { from: 'ALWAYS_PROPOSE', to: 'PROPOSE_THEN_AUTO' }, words: 'bidding-strategy switches may run alone after 30 days (up and down lets Amazon raise a bid up to +100 %)' },
  pauseMinDays: { when: 'never', words: 'a shorter stop stays on low bids instead of a pause' },
  archiveDeadWeeks: { when: 'never', words: 'an archive is only ever a proposal' },
  longStopUntil: { when: 'cleared-or-earlier', words: 'the Owner\'s long stop ends sooner: the brain resumes the campaigns sooner' },
}

/**
 * Batch 2 review fix (lead decision, code rule A) — a change of the product's portfolio cap limit that RAISES the limit in
 * force: from → to as the gate reads them (a value that is not a whole number above 0 is the server's limit,
 * NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS). Its big-door words, or null (lower, the same, or another setting). Pure but for
 * the env.
 */
export function limitRaise(key: string, from: SettingValue, to: SettingValue): string | null {
  if (key !== PORTFOLIO_CAP_LIMIT_SETTING) return null
  const server = serverPortfolioCapLimitCents()
  const inForce = (v: SettingValue) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : server)
  const [was, will] = [inForce(from), inForce(to)]
  return will > was ? `the product's portfolio cap limit raised from ${was}¢ to ${will}¢ a month${to === null ? ' (the server\'s limit)' : ''}: a larger Amazon portfolio cap may then be written` : null
}

/** The raise line of a setting changed from → to; null when it adds no spend. Pure. */
export function settingRaise(key: string, from: SettingValue, to: SettingValue): string | null {
  if (!isSetting(key)) return null
  const r = SPEND_RATINGS[key]
  const label = `${key} ${JSON.stringify(from)} → ${JSON.stringify(to)}`
  if (!r) return `${label}: Nexus does not rate this setting's effect on spend yet — read what it does (${BRAIN_SETTINGS[key].what})`
  const num = (v: SettingValue) => (typeof v === 'number' ? v : null)
  let raises = false
  if (r.when === 'up') raises = num(from) == null || num(to) == null ? from !== to && to !== null : num(to)! > num(from)!
  else if (r.when === 'up-or-cleared') raises = from !== to && (num(from) == null || num(to) == null || num(to)! > num(from)!)
  else if (r.when === 'down') raises = num(from) != null && num(to) != null && num(to)! < num(from)!
  else if (r.when === 'off') raises = from === true && to === false
  else if (r.when === 'cleared-or-earlier') raises = typeof from === 'string' && (to === null || (typeof to === 'string' && to < from))
  else if (typeof r.when === 'object') raises = from === r.when.from && to === r.when.to
  return raises ? `${label}: ${r.words}` : null
}

/** The open overrides after a plan: the one it ends gone, the one it stores added (as `by`, now). Pure. */
export function overridesAfter(before: readonly OverrideRow[], plan: Pick<OverridePlan, 'set' | 'ends'>, root: string, market: string, by = 'this request'): OverrideRow[] {
  const kept = before.filter((o) => o.id !== plan.ends)
  return plan.set ? [...kept, { ...plan.set, id: 'new', productId: root, marketplace: market, by, reason: null, createdAt: new Date(8.64e15), endedAt: null }] : kept
}

/** Group a campaign's lever moves by their from → to: "bids, budgets: OBSERVE (shadow) → EXCLUDED". Pure. */
export function leverMoves(levers: readonly BrainLever[], before: BrainSettings, after: BrainSettings): Array<{ what: string; from: string; to: string }> {
  const groups = new Map<string, { levers: BrainLever[]; from: string; to: string }>()
  for (const l of levers) {
    const from = effectiveWord(before.levers[l].effective)
    const to = effectiveWord(after.levers[l].effective)
    if (from === to) continue
    const k = `${from}\u0000${to}`
    const g = groups.get(k) ?? { levers: [], from, to }
    g.levers.push(l)
    groups.set(k, g)
  }
  return [...groups.values()].map((g) => ({ what: g.levers.length === BRAIN_LEVERS.length ? 'every lever' : g.levers.join(', '), from: g.from, to: g.to }))
}

/** Where a lever goes to AUTO: on the product, or on one of its own campaigns (a shared one is no brain's, D2). Pure. */
export function turnsAutoOf(before: (campaignId: string | null) => BrainSettings, after: (campaignId: string | null) => BrainSettings, own: ReadonlyArray<{ campaignId: string; name: string }>): Array<{ where: string; campaignId: string | null; lever: BrainLever }> {
  const out: Array<{ where: string; campaignId: string | null; lever: BrainLever }> = []
  for (const at of [{ campaignId: null as string | null, name: 'the product' }, ...own]) {
    const b = before(at.campaignId)
    const a = after(at.campaignId)
    for (const l of BRAIN_LEVERS) if (a.levers[l].effective === 'AUTO' && b.levers[l].effective !== 'AUTO') out.push({ where: at.name, campaignId: at.campaignId, lever: l })
  }
  return out
}

/** A lock's value in words. */
function lockValueWords(value: unknown): string {
  if (value === null || value === undefined) return 'as it is now'
  if (typeof value === 'string') return value
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k} ${v}`).join(', ')
}
const prov = (p: Provenance) => describeProvenance(p)

/** The Owner's choice before → after on the scope it is set at, in words. Pure. */
function choiceWords(kind: OverrideKind, key: string, ref: string, s: BrainSettings): string {
  if (kind === 'EXCLUDE') return s.excluded.value ? `excluded (${prov(s.excluded)})` : 'in the brain'
  if (kind === 'VALUE') {
    const v = s.values[key as BrainSetting]
    return `${JSON.stringify(v.value)} (${prov(v)})`
  }
  const l = s.levers[key as BrainLever]
  if (kind === 'LEVEL') return `${l.level.value} (${prov(l.level)})${l.effective !== l.level.value ? `, ${effectiveWord(l.effective)} in effect` : ''}`
  if (ref) {
    const lock = l.locks.find((x) => x.ref === ref && x.source !== 'default')
    return lock ? `locked (${prov(lock)})` : 'not locked'
  }
  return l.lock ? `locked at ${lockValueWords(l.lock.value)} (${prov(l.lock)})` : 'not locked'
}

/** Why the op's arguments do not make one change of this op; null when they do. Pure. */
export function shapeRefusal(input: ControlInput): string | null {
  const has = (v: unknown) => v !== undefined && v !== null && v !== ''
  const { op } = input
  if (!(CONTROL_OPS as readonly string[]).includes(op)) return `op is ${CONTROL_OPS.join(', ')}, not ${String(op)}`
  if ((op === 'enroll' || op === 'leave') && has(input.campaignId)) return `${op} is for the whole product in the market: name no campaignId (exclude keeps one campaign out of the brain; set-level, lock and set-value take one campaign)`
  if (op !== 'enroll' && input.levels && Object.keys(input.levels).length) return 'levels are the starting levels of op enroll; set-level sets one lever'
  if (op !== 'leave' && has(input.bids)) return 'bids says what op leave does with the campaigns the bid brain runs; it is not an argument of this op'
  if (op !== 'leave' && has(input.pauses)) return 'pauses says what op leave does with the campaigns the brain\'s own pause holds; it is not an argument of this op'
  if (op !== 'set-level' && op !== 'set-value' && input.reset) return `reset ends a level (set-level) or a value (set-value); ${op === 'lock' ? 'unlock ends a lock' : op === 'exclude' ? 'include ends an exclusion' : `op ${op} takes no reset`}`
  switch (op) {
    case 'set-level':
      if (!has(input.lever)) return 'set-level names the lever (lever)'
      if (input.reset && has(input.level)) return 'set-level takes a level or reset: true (end the level so the next one applies), not both'
      if (!input.reset && !has(input.level)) return 'set-level names the level (OFF, OBSERVE, PROPOSE or AUTO), or reset: true to end the level set here'
      return null
    case 'lock':
    case 'unlock':
      if (!has(input.lever)) return `${op} names the lever (lever)`
      if (op === 'unlock' && input.value !== undefined) return 'unlock takes no value: it ends the lock (the brain may write the lever again)'
      return null
    case 'exclude':
    case 'include':
      if (has(input.lever) || has(input.level) || has(input.ref)) return `${op} takes the whole ${input.campaignId ? 'campaign' : 'product'} ${op === 'exclude' ? 'out of' : 'back into'} the brain: no lever (to hold one lever, lock it)`
      if (input.value !== undefined) return `${op} takes no value`
      return null
    case 'set-value':
      if (!has(input.key)) return 'set-value names the setting (key)'
      if (input.reset && input.value !== undefined) return 'set-value takes a value or reset: true (back to the product\'s value or the brain\'s default), not both'
      if (!input.reset && input.value === undefined) return `set-value names the value of ${input.key} (value), or reset: true to go back to the product's value or the brain's default`
      return null
    default:
      return null
  }
}

/** The facts every op reads. */
interface Ctx {
  input: ControlInput
  root: string
  market: string
  name: string
  sku: string
  own: Camp[]
  shared: Camp[]
  enrollment: { id: string; version: number; enrolledBy: string; createdAt: Date } | null
  overrides: OverrideRow[]
  ceiling: 'off' | 'shadow' | 'live'
}

async function readCtx(input: ControlInput): Promise<Ctx | { refusal: string }> {
  if (!(await prisma.product.count({ where: { id: input.productId, deletedAt: null } }))) return { refusal: PRODUCT_NOT_FOUND }
  const market = marketCode(input.market)
  if (!market) return { refusal: `${input.market} is not a market code: name one Amazon market, such as IT or DE (business-overview lists them)` }
  const family = await productFamily(input.productId)
  if (!family) return { refusal: `product ${input.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
  const [row, camps, enrollment] = await Promise.all([
    prisma.product.findFirst({ where: { id: family.root }, select: { name: true, sku: true } }),
    campaignsOf(family.root, market),
    prisma.adsBrainEnrollment.findFirst({ where: { productId: family.root, marketplace: market }, select: { id: true, version: true, enrolledBy: true, createdAt: true } }),
  ])
  if (!row || !camps) return { refusal: PRODUCT_NOT_FOUND }
  const camp = (owner: 'own' | 'shared') => (c: { campaignId: string; name: string; status: string; mode: EnrollMode | null }): Camp => ({ campaignId: c.campaignId, name: c.name, status: c.status, mode: c.mode, owner })
  const own = camps.own.map(camp('own'))
  const shared = camps.shared.map(camp('shared'))
  const overrides = await openOverrides(family.root, market, [...own, ...shared].map((c) => c.campaignId))
  return { input, root: family.root, market, name: row.name, sku: row.sku, own, shared, enrollment, overrides, ceiling: bidBrainMode() }
}

/** What any op previews: the facts read, then the op's own plan. */
export async function previewControl(input: ControlInput): Promise<ControlOutcome> {
  const shape = shapeRefusal(input)
  if (shape) return no(shape)
  const ctx = await readCtx(input)
  if ('refusal' in ctx) return no(ctx.refusal)
  if (input.op === 'enroll') return previewEnroll(ctx)
  if (input.op === 'leave') return previewLeave(ctx)
  return previewOverride(ctx)
}

// ── set-level · lock · unlock · exclude · include · set-value ──────────────────────────────────────────────────────

function changeOf(input: ControlInput, campaignId: string | null): { op: 'set'; input: OverrideInput } | { op: 'end'; input: Omit<OverrideInput, 'value'> } {
  const scope = campaignId ? 'CAMPAIGN' as const : 'PRODUCT' as const
  const base = { scope, campaignId }
  switch (input.op) {
    case 'set-level': return input.reset ? { op: 'end', input: { ...base, kind: 'LEVEL', key: String(input.lever) } } : { op: 'set', input: { ...base, kind: 'LEVEL', key: String(input.lever), value: input.level } }
    case 'lock': return { op: 'set', input: { ...base, kind: 'LOCK', key: String(input.lever), ref: input.ref ?? '', value: input.value ?? null } }
    case 'unlock': return { op: 'end', input: { ...base, kind: 'LOCK', key: String(input.lever), ref: input.ref ?? '' } }
    case 'exclude': return { op: 'set', input: { ...base, kind: 'EXCLUDE', key: EXCLUDE_KEY } }
    case 'include': return { op: 'end', input: { ...base, kind: 'EXCLUDE', key: EXCLUDE_KEY } }
    default: return input.reset ? { op: 'end', input: { ...base, kind: 'VALUE', key: String(input.key) } } : { op: 'set', input: { ...base, kind: 'VALUE', key: String(input.key), value: input.value } }
  }
}

/** The card's first words of an override op. */
function opWords(op: ControlOp, label: string, where: string): string {
  switch (op) {
    case 'set-level': return `Sets the ${label} of ${where}`
    case 'lock': return `Locks the ${label.replace(/ lock$/, '')} of ${where}`
    case 'unlock': return `Unlocks the ${label.replace(/ lock$/, '')} of ${where}`
    case 'exclude': return `Excludes ${where} from the brain`
    case 'include': return `Takes ${where} back into the brain`
    default: return `Sets ${label} of ${where}`
  }
}

async function previewOverride(ctx: Ctx): Promise<ControlOutcome> {
  const { input, root, market } = ctx
  if (!ctx.enrollment) return no(`${ctx.name} is not enrolled in the brain for ${market} yet: enroll it first (op enroll; every lever starts OBSERVE)`)
  const campaignId = input.campaignId?.trim() || null
  const all = [...ctx.own, ...ctx.shared]
  const target = campaignId ? all.find((c) => c.campaignId === campaignId) ?? null : null
  if (campaignId && !target && input.op !== 'unlock' && input.op !== 'include' && !input.reset) {
    return no(`campaign ${campaignId} does not advertise ${ctx.name} in ${market} (archived campaigns and other ad products are left out): ad-campaigns names its campaigns`)
  }
  const change = changeOf(input, campaignId)
  const planned = await planOverride({ productId: root, market, ...(change.op === 'set' ? { set: change.input } : { end: change.input }) })
  if ('refusal' in planned) return no(planned.refusal)
  const { plan, version } = planned
  const before = ctx.overrides
  const after = overridesAfter(before, plan, root, market)
  const resolveWith = (rows: readonly OverrideRow[]) => (cid: string | null) => resolveBrainSettings({ productId: root, market, campaignId: cid, enrolled: true, overrides: rows })
  const b = resolveWith(before)
  const a = resolveWith(after)
  const kind = change.input.kind
  const key = change.input.key
  const normal = kind === 'LOCK' && isLever(key) ? lockRef(key, change.input.ref) : { ref: '' }
  const ref = plan.set?.ref ?? ('ref' in normal ? normal.ref : '')
  const scopeId = campaignId
  const fromWords = choiceWords(kind, key, ref, b(scopeId))
  const toWords = choiceWords(kind, key, ref, a(scopeId))
  const label = kind === 'EXCLUDE' ? (campaignId ? 'the campaign' : 'the product')
    : kind === 'VALUE' ? key
      : `${leverWord(key as BrainLever)}${kind === 'LOCK' ? (ref ? ` (${ref}) lock` : ' lock') : ' level'}`
  const where = target ? `campaign ${target.name}` : campaignId ? `campaign ${campaignId}` : `${ctx.name} (${market})`
  if (plan.unchanged) return no(`Not queued: nothing would change — ${label} on ${where} is already ${fromWords}`)

  // Every campaign the change reaches, and what it does there.
  const levers: BrainLever[] = kind === 'EXCLUDE' ? [...BRAIN_LEVERS] : kind === 'VALUE' ? [] : [key as BrainLever]
  const steps = new Map((plan.steps ?? []).map((s) => [s.campaignId, s]))
  const reachOne = (c: Camp): CampaignReach => {
    const bc = b(c.campaignId)
    const ac = a(c.campaignId)
    const changes = leverMoves(levers, bc, ac)
    if (kind === 'VALUE' && BRAIN_SETTINGS[key as BrainSetting].scopes.includes('CAMPAIGN')) {
      const vb = bc.values[key as BrainSetting].value
      const va = ac.values[key as BrainSetting].value
      if (JSON.stringify(vb) !== JSON.stringify(va)) changes.push({ what: key, from: JSON.stringify(vb), to: JSON.stringify(va) })
    }
    const s = steps.get(c.campaignId)
    if (s && s.op !== 'keep') changes.push({ what: 'bid brain', from: c.mode ?? 'SHADOW', to: s.op === 'live' ? 'LIVE' : s.op === 'shadow' ? 'SHADOW' : s.op === 'wait' ? 'HELD (waits for its floor)' : `${c.mode ?? 'SHADOW'} (skipped)` })
    // A shared campaign is no product's brain's (D2): it is reached only when the bid brain moves it (back to shadow).
    const reached = c.owner === 'own' ? changes.some((x) => !x.to.endsWith('(skipped)')) : !!s && (s.op === 'shadow' || (s.op === 'wait' && s.hold))
    const firstLever = levers[0]
    const why = c.owner === 'shared'
      ? `a shared campaign: no product's brain owns its levers (D2: the brain proposes a split)${reached ? '; the bid brain lets it go back to shadow' : ''}`
      : reached ? (campaignId ? 'the campaign this change names' : 'it follows the product') : s?.op === 'skip' ? s.why
        : firstLever ? ac.levers[firstLever].why : kind === 'VALUE' ? `its own value ${JSON.stringify(ac.values[key as BrainSetting].value)} (${prov(ac.values[key as BrainSetting])})` : 'nothing changes there'
    return { campaignId: c.campaignId, name: c.name, owner: c.owner, status: c.status, changes, reached, why }
  }
  const productOnlySetting = kind === 'VALUE' && !BRAIN_SETTINGS[key as BrainSetting].scopes.includes('CAMPAIGN')
  const campaigns = productOnlySetting ? [] : (target ? [target] : campaignId ? [] : all).map(reachOne)
  const notReached = [
    ...plan.notReached,
    ...campaigns.filter((c) => !c.reached && !plan.notReached.some((n) => n.campaignId === c.campaignId)).map((c) => ({ campaignId: c.campaignId, name: c.name, why: c.why })),
  ]
  const own = ctx.own.map((c) => ({ campaignId: c.campaignId, name: c.name }))
  const turnsAuto = turnsAutoOf(b, a, own)
  const live = plan.goesLive
  const raisedLimit = kind === 'VALUE' ? limitRaise(key, b(scopeId).values[key as BrainSetting].value, a(scopeId).values[key as BrainSetting].value) : null
  const bigDoor = [
    ...turnsAuto.map((t) => `${leverWord(t.lever)} to AUTO on ${t.where}`),
    ...(live.length ? [`${plural(live.length, 'campaign')} under the bid brain (${names(all.filter((c) => live.includes(c.campaignId)))})`] : []),
    ...(raisedLimit ? [raisedLimit] : []),
  ]
  const needsCode = bigDoor.length > 0

  // What the brain will start (or stop) doing.
  const scopeB = b(scopeId)
  const scopeA = a(scopeId)
  const starts = startLines(levers, (l) => scopeB.levers[l].effective, (l) => scopeA.levers[l].effective, ctx.ceiling, campaignId ? where : '')
  if (kind === 'LOCK' && ref) starts.push(`${leverWord(key as BrainLever)}: ${change.op === 'set' ? `the brain leaves ${ref} as it is, and writes the rest of the lever at its level` : `the brain may write ${ref} again, at the lever's level`}`)
  if (kind === 'VALUE') starts.push(`${key} (${BRAIN_SETTINGS[key as BrainSetting].what}): ${fromWords} → ${toWords}`)
  if (!starts.length && kind !== 'VALUE') starts.push(`${label}: saved as ${toWords}; what the brain does on ${where} stays the same (${firstWhy(scopeA, levers)})`)

  // Spend: what can add it (said, never silent), and the warnings.
  const raises: string[] = []
  const warnings: string[] = []
  for (const l of [...new Set(turnsAuto.map((t) => t.lever))]) if (AUTO_RAISES[l]) raises.push(`${AUTO_RAISES[l]} (${names(turnsAuto.filter((t) => t.lever === l).map((t) => ({ name: t.where })))})`)
  if (live.length && !turnsAuto.some((t) => t.lever === 'bids')) raises.push(`${AUTO_RAISES.bids} on ${plural(live.length, 'campaign')} it puts under the bid brain`)
  const leaving = (plan.steps ?? []).filter((s) => s.op === 'shadow')
  if (leaving.length) {
    const owed = await owedStopMemory(leaving.map((s) => s.campaignId))
    if (owed.length) raises.push(`what a stop saved goes back on ${names(owed)} (${owed.map((o) => o.words).join('; ')}), as the person who approves it`)
    warnings.push(`${names(leaving)} ${leaving.length === 1 ? 'goes' : 'go'} back to shadow: the bid brain stops writing ${leaving.length === 1 ? 'its' : 'their'} keyword bids (they stay where they are) and today's engines (auto-bid, rules) may move them again, raises included.`)
  }
  if (kind === 'VALUE') {
    const r = settingRaise(key, b(scopeId).values[key as BrainSetting].value, a(scopeId).values[key as BrainSetting].value)
    if (r) raises.push(r)
  }
  const released = releasedLevers(b, a, [{ campaignId: null, name: 'the product' }, ...own])
  if (released.length) warnings.push(`Today's engines may write these levers again (whatever is set up there, raises included): ${released.join('; ')}.`)
  const becomesOwned = [null, ...own.map((c) => c.campaignId)].some((cid) => BRAIN_LEVERS.some((l) => a(cid).levers[l].owned && !b(cid).levers[l].owned))
  if (becomesOwned && ctx.ceiling !== 'live') warnings.push(`The server switch NEXUS_BID_BRAIN_MODE is ${ctx.ceiling}: the brain owns a lever only once that switch is live — until then it decides in shadow and today's engines keep writing.`)
  if (target?.owner === 'shared') warnings.push(`${target.name} is a shared campaign (it advertises another product too): no product's brain owns its levers until it is split (D2). The choice is kept and applies once it advertises ${ctx.name} alone.`)
  if (campaignId && !target) warnings.push(`campaign ${campaignId} no longer advertises ${ctx.name} in ${market}: its override is ended all the same.`)
  for (const s of plan.steps ?? []) {
    if (s.op === 'skip') warnings.push(`${s.name} stays in shadow: ${s.why}`)
    if (s.op === 'wait') warnings.push(`${s.name}: ${s.why}`)
  }
  if (kind === 'LOCK' && change.op === 'set' && !ref && (input.value === undefined || input.value === null)) warnings.push(`The lock holds the ${leverWord(key as BrainLever)} as it is now: the brain leaves it there.`)
  const ignored = a(scopeId).ignored
  if (ignored.length) warnings.push(`${plural(ignored.length, 'stored override no longer validates and is', 'stored overrides no longer validate and are')} ignored: ${ignored.map((i) => i.why).join('; ')}.`)

  const changes: Record<string, { from: unknown; to: unknown }> = { [`${label} — ${campaignId ? where : 'product'}`]: { from: fromWords, to: toWords } }
  for (const c of campaigns.filter((x) => x.reached)) {
    for (const ch of c.changes) {
      if (Object.keys(changes).length >= 20) break
      changes[`${ch.what} on ${c.name}`] = { from: ch.from, to: ch.to }
    }
  }
  const goLive = (plan.steps ?? []).filter((s) => s.op === 'live')
  const back = (plan.steps ?? []).filter((s) => s.op === 'shadow' || (s.op === 'wait' && s.hold))
  const notReachedWords = notReached.length ? `; ${plural(notReached.length, 'campaign')} ${notReached.length === 1 ? 'is' : 'are'} not reached (${names(notReached)})` : ''
  const reachWords = campaignId ? '' : productOnlySetting ? ' It is a setting of the whole product.' : campaigns.length
    ? ` It reaches ${plural(campaigns.filter((c) => c.reached).length, 'campaign')} of ${campaigns.length}${notReachedWords}.`
    : ' The product has no Sponsored Products campaign in this market yet: it applies to every campaign it gets.'
  const moveWords = [
    goLive.length ? `${plural(goLive.length, 'campaign')} ${goLive.length === 1 ? 'goes' : 'go'} LIVE under the bid brain` : '',
    back.length ? `${plural(back.length, 'campaign')} ${back.length === 1 ? 'goes' : 'go'} back to shadow` : '',
  ].filter(Boolean).join(', ')
  const summary = `${opWords(input.op, label, where)}: ${fromWords} → ${toWords}.${reachWords}${moveWords ? ` ${moveWords[0].toUpperCase()}${moveWords.slice(1)}.` : ''}`
  const writesAtAmazon = leaving.length > 0
  return {
    ok: true,
    exec: {
      root, market, change,
      before: { scope: change.input.scope, campaignId, kind, key, ref, open: !!openAt(before, change.input, ref), value: openAt(before, change.input, ref)?.value ?? null },
      after: { open: change.op === 'set', value: change.op === 'set' ? (plan.set?.value ?? (change.input as OverrideInput).value ?? null) : null },
    },
    preview: {
      action: CONTROL_TOOL, op: input.op, summary, product: ctx.name, sku: ctx.sku,
      brain: { productId: root, market, enrolled: true, version },
      scope: target ? { level: 'campaign', campaignId: target.campaignId, name: target.name, owner: target.owner } : campaignId ? { level: 'campaign', campaignId, name: campaignId, owner: 'own' } : { level: 'product' },
      change: { kind, key, ref, from: fromWords, to: toWords },
      changes,
      totals: { campaigns: campaigns.length, reached: campaigns.filter((c) => c.reached).length, notReached: notReached.length, goLive: live.length, toShadow: leaving.length },
      campaigns, notReached,
      ...(plan.steps ? { bids: plan.steps.map((s) => ({ campaignId: s.campaignId, name: s.name, op: s.op === 'keep' ? `keep ${s.mode ?? 'SHADOW'}` : s.op, ...('why' in s ? { why: s.why } : {}) })) } : {}),
      turnsAuto, starts, raises, warnings, needsCode, bigDoor, ceiling: ctx.ceiling, basis: plan.basis, version,
      reachNote: writesAtAmazon
        ? 'It records the change in Nexus; each campaign going back to shadow gets what a stop saved back at Amazon, as the approver (the write gate judges each). The brain\'s own runs write afterwards.'
        : 'Nexus only: nothing is sent to Amazon by this change; the brain acts in its own runs, at the level set here.',
      undoNote: undoWords(kind, change.op === 'set'),
    },
  }
}

const firstWhy = (s: BrainSettings, levers: readonly BrainLever[]) => (levers.length ? s.levers[levers[0]].why : s.excluded.value ? `excluded by ${prov(s.excluded)}` : 'unchanged')

function openAt(rows: readonly OverrideRow[], input: Pick<OverrideInput, 'scope' | 'campaignId' | 'kind' | 'key'>, ref: string): OverrideRow | undefined {
  const id = overrideIdentity({ scope: input.scope, campaignId: input.campaignId ?? null, kind: input.kind, key: input.kind === 'EXCLUDE' ? EXCLUDE_KEY : input.key, ref })
  return rows.filter((o) => overrideIdentity(o) === id).sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())[0]
}

function undoWords(kind: OverrideKind, set: boolean): string {
  const back = kind === 'LEVEL' ? 'the level it replaced (or ends this one)' : kind === 'LOCK' ? (set ? 'an unlock (or the lock it replaced)' : 'the lock again') : kind === 'EXCLUDE' ? (set ? 'an include' : 'the exclusion again') : 'the value it replaced (or ends this one)'
  return `undo-change asks set-ads-brain for ${back}, a request of its own (a big door again if that takes a lever to AUTO); what the brain wrote at Amazon meanwhile stays.`
}

/**
 * Levers the brain held (PROPOSE, AUTO) before and not after, where — today's engines may write them again. A lever the
 * Owner locks is not one of them where the write gate holds it (lever-owners.ts GATE_LEVERS: every automatic writer is
 * refused on a locked lever); the keyword bids lock only holds the bid brain off. Pure.
 */
export function releasedLevers(b: (c: string | null) => BrainSettings, a: (c: string | null) => BrainSettings, at: ReadonlyArray<{ campaignId: string | null; name: string }>): string[] {
  const byLever = new Map<BrainLever, string[]>()
  for (const x of at) {
    for (const l of BRAIN_LEVERS) {
      const now = a(x.campaignId).levers[l]
      if (now.effective === 'LOCKED' && GATE_LEVERS.includes(l)) continue
      if (b(x.campaignId).levers[l].owned && !now.owned) byLever.set(l, [...(byLever.get(l) ?? []), x.name])
    }
  }
  return [...byLever].map(([l, where]) => `${leverWord(l)} on ${names(where.map((name) => ({ name })))}`)
}

/** The campaigns among these whose stop memory still owes them something (the lanes at 0 %, down only), in words. */
async function owedStopMemory(campaignIds: readonly string[]): Promise<Array<{ campaignId: string; name: string; words: string }>> {
  if (!campaignIds.length) return []
  const rows = await prisma.campaign.findMany({
    where: { id: { in: [...campaignIds] } },
    select: { id: true, name: true, dynamicBidding: true, biddingStrategy: true, suppressedFromPlacements: true, suppressedFromBiddingStrategy: true },
  })
  return rows.flatMap((c) => {
    const owed = stopMemoryOf(c)
    return owed ? [{ campaignId: c.id, name: c.name, words: owed.words }] : []
  })
}

// ── enroll ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function previewEnroll(ctx: Ctx): Promise<ControlOutcome> {
  const { root, market, input } = ctx
  if (ctx.enrollment) return no(`${ctx.name} is already enrolled in the brain for ${market} (by ${ctx.enrollment.enrolledBy}, ${ctx.enrollment.createdAt.toISOString().slice(0, 10)}): set-level, lock, exclude and set-value change it; leave takes it out`)
  const adopted = adoptedBidsLevel(ctx.own)
  const adoptedLive = ctx.own.filter((c) => isOwnedMode(c.mode))
  const keptInShadow = adopted === 'AUTO' ? ctx.own.filter((c) => !isOwnedMode(c.mode)) : []
  const refusals: string[] = []
  const asked: Array<{ lever: BrainLever; level: BrainLevel }> = []
  for (const [lever, level] of Object.entries(input.levels ?? {})) {
    if (level === undefined || level === null) continue
    if (!isLever(lever)) { refusals.push(`${lever} is not a lever of the brain (levers: ${BRAIN_LEVERS.join(', ')})`); continue }
    if (!isLevel(level)) { refusals.push(`${lever}: a level is OFF, OBSERVE, PROPOSE or AUTO, not ${JSON.stringify(level)}`); continue }
    if (lever === 'bids' && level !== adopted) {
      refusals.push(adopted === 'AUTO'
        ? `bids: enrolling adopts the bids lever as its campaigns hold it — AUTO, because the bid brain already runs ${names(adoptedLive)} LIVE; it never moves a campaign. Enroll first, then set-level bids ${level} (it takes those campaigns back to shadow)`
        : `bids: enrolling adopts the bids lever as its campaigns hold it — OBSERVE, because the bid brain runs none of them LIVE; it never moves a campaign. Enroll first, then set-level bids ${level} (it puts the campaigns that may go LIVE under the bid brain, a big door)`)
      continue
    }
    const r = levelRefusal(lever, level)
    if (r) { refusals.push(r); continue }
    asked.push({ lever, level })
  }
  if (refusals.length) return no(refusalList(refusals))

  // Choices left open from an earlier enrollment of this product × market: its levels and values end, its locks and
  // exclusions stay (the Owner's brakes hold whether or not the product is enrolled).
  const leftovers = await prisma.adsBrainOverride.findMany({ where: { endedAt: null, productId: root, marketplace: market, kind: { in: ['LEVEL', 'VALUE'] } }, select: { id: true, kind: true, key: true, scope: true, campaignId: true } })
  const leftoverIds = new Set(leftovers.map((o) => o.id))
  const kept = ctx.overrides.filter((o) => !leftoverIds.has(o.id))
  const epoch = new Date(8.64e15)
  const row = (o: Omit<OverrideRow, 'id' | 'productId' | 'marketplace' | 'by' | 'reason' | 'createdAt' | 'endedAt' | 'ref'> & { ref?: string }, idx: string): OverrideRow => ({ id: `new-${idx}`, productId: root, marketplace: market, ref: '', by: 'this request', reason: null, createdAt: epoch, endedAt: null, ...o })
  const adoption: OverrideRow[] = adopted === 'AUTO'
    ? [row({ scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key: 'bids', value: 'AUTO' }, 'adopt'), ...keptInShadow.map((c) => row({ scope: 'CAMPAIGN', campaignId: c.campaignId, kind: 'LEVEL', key: 'bids', value: 'OBSERVE' }, `adopt-${c.campaignId}`))]
    : []
  const afterAdoption = [...kept, ...adoption]
  const resolveAt = (rows: readonly OverrideRow[], enrolled: boolean) => (cid: string | null) => resolveBrainSettings({ productId: root, market, campaignId: cid, enrolled, overrides: rows })
  const adoptedProduct = resolveAt(afterAdoption, true)(null)
  // Only a level that differs from what the product resolves to after adoption is stored (the default needs no override).
  const toSet = asked.filter((x) => x.lever !== 'bids' && adoptedProduct.levers[x.lever].level.value !== x.level)
  const after = [...afterAdoption, ...toSet.map((x) => row({ scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key: x.lever, value: x.level }, x.lever))]
  const b = resolveAt(ctx.overrides, false)
  const a = resolveAt(after, true)
  const own = ctx.own.map((c) => ({ campaignId: c.campaignId, name: c.name }))
  const turnsAuto = turnsAutoOf(b, a, own)

  // AB-4 — a lever the Owner asks AUTO is refused while one of Amazon's own rules acts on it on an own campaign (the
  // adopted bids lever refuses nothing: it adopts what already runs, and the map shows the clash).
  const asks = turnsAuto.flatMap((t) => (t.lever !== 'bids' && t.campaignId ? [{ campaignId: t.campaignId, name: t.where, lever: t.lever }] : []))
  const rules = await loadNativeRules([...new Set([...asks.map((x) => x.campaignId), ...adoptedLive.map((c) => c.campaignId)])])
  const native = asks.length ? nativeAutoRefusal(asks, rules) : null
  if (native) return no(native)

  const bigDoor = turnsAuto.length
    ? [...new Set(turnsAuto.map((t) => t.lever))].map((l) => `${leverWord(l)} AUTO${l === 'bids' && adopted === 'AUTO' && !asked.some((x) => x.lever === 'bids') ? ` (adopted: the bid brain already runs ${names(adoptedLive)} LIVE)` : ''}`)
    : []
  const needsCode = bigDoor.length > 0
  const productAfter = a(null)
  const byLevel = new Map<string, BrainLever[]>()
  for (const l of BRAIN_LEVERS) byLevel.set(productAfter.levers[l].effective, [...(byLevel.get(productAfter.levers[l].effective) ?? []), l])
  const starts = startLines(BRAIN_LEVERS, () => 'NOT_ENROLLED', (l) => productAfter.levers[l].effective, ctx.ceiling)
  const raises: string[] = []
  for (const l of [...new Set(turnsAuto.map((t) => t.lever))]) {
    if (l === 'bids' && adopted === 'AUTO') continue // adopted: the bid brain already runs them; nothing new
    if (AUTO_RAISES[l]) raises.push(AUTO_RAISES[l]!)
  }
  const warnings: string[] = []
  if (adopted === 'AUTO') {
    warnings.push(`The bids lever is adopted AUTO: the bid brain keeps running ${names(adoptedLive)} LIVE exactly as now${keptInShadow.length ? `; ${names(keptInShadow)} ${keptInShadow.length === 1 ? 'stays' : 'stay'} in shadow by an "adopted" campaign OBSERVE (ending it later puts ${keptInShadow.length === 1 ? 'it' : 'them'} LIVE: a big door)` : ''}.`)
    for (const c of adoptedLive) {
      const lines = nativeRuleLines(rules.get(c.campaignId), 'bids')
      if (lines.length) warnings.push(`${c.name}: an Amazon rule acts on its bids (${lines.join('; ')}) — two brains on one lever; the ads-brain map shows the clash.`)
    }
  }
  if (ctx.shared.length) warnings.push(`${names(ctx.shared)} ${ctx.shared.length === 1 ? 'is a shared campaign' : 'are shared campaigns'} (another product is advertised there too): no product's brain owns ${ctx.shared.length === 1 ? 'its' : 'their'} levers until split (D2).`)
  const becomesOwned = [null, ...own.map((c) => c.campaignId)].some((cid) => BRAIN_LEVERS.some((l) => a(cid).levers[l].owned))
  if (becomesOwned && ctx.ceiling !== 'live') warnings.push(`The server switch NEXUS_BID_BRAIN_MODE is ${ctx.ceiling}: the brain owns a lever only once that switch is live — until then it decides in shadow and today's engines keep writing.`)
  if (leftovers.length) warnings.push(`${plural(leftovers.length, 'choice')} left open from an earlier enrollment of this product ${leftovers.length === 1 ? 'ends' : 'end'} first (${leftovers.map((o) => `${o.kind.toLowerCase()} ${o.key}${o.campaignId ? ` on campaign ${o.campaignId}` : ''}`).join(', ')}).`)
  const brakes = kept.filter((o) => o.kind === 'LOCK' || o.kind === 'EXCLUDE')
  if (brakes.length) warnings.push(`The Owner's ${plural(brakes.length, 'lock or exclusion', 'locks and exclusions')} already set ${brakes.length === 1 ? 'applies' : 'apply'} at once: ${brakes.map((o) => `${o.kind === 'EXCLUDE' ? 'exclusion' : `lock of ${o.key}${o.ref ? ` (${o.ref})` : ''}`}${o.campaignId ? ` on campaign ${o.campaignId}` : ''}`).join(', ')}.`)
  const campaigns: CampaignReach[] = [...ctx.own, ...ctx.shared].map((c) => {
    const ac = a(c.campaignId)
    const moves = leverMoves(BRAIN_LEVERS.filter((l) => ac.levers[l].effective !== 'OBSERVE'), b(c.campaignId), ac)
    const rest = BRAIN_LEVERS.filter((l) => ac.levers[l].effective === 'OBSERVE').length
    return {
      campaignId: c.campaignId, name: c.name, owner: c.owner, status: c.status,
      changes: [...moves, ...(rest ? [{ what: rest === BRAIN_LEVERS.length ? 'every lever' : `${plural(rest, 'other lever')}`, from: effectiveWord('NOT_ENROLLED'), to: effectiveWord('OBSERVE') }] : [])],
      reached: c.owner === 'own',
      why: c.owner === 'shared' ? 'a shared campaign: no product\'s brain owns its levers (D2: the brain proposes a split)' : 'its own campaign: the product\'s brain speaks for it',
    }
  })
  const levelsWords = toSet.map((x) => `${leverWord(x.lever)} ${x.level}`)
  const summary = `Enrolls ${ctx.name} (${ctx.sku}) in the brain for ${market}: every lever starts OBSERVE (shadow)${adopted === 'AUTO' ? `, the keyword bids AUTO as the bid brain already runs ${plural(adoptedLive.length, 'campaign')} LIVE (adopted)` : ''}${levelsWords.length ? `, and ${levelsWords.join(', ')}` : ''}. ${ctx.own.length ? `It speaks for ${plural(ctx.own.length, 'own campaign')}${ctx.shared.length ? ` (${plural(ctx.shared.length, 'shared campaign')} named, owned by no brain)` : ''}` : 'It has no Sponsored Products campaign in this market yet'}; no campaign moves.`
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const [e, ls] of byLevel) changes[ls.length === BRAIN_LEVERS.length ? 'every lever' : ls.join(', ')] = { from: effectiveWord('NOT_ENROLLED'), to: effectiveWord(e as Effective) }
  const basis = hash(['enroll', root, market, adopted, adoptedLive.map((c) => c.campaignId), keptInShadow.map((c) => c.campaignId), toSet, [...leftoverIds].sort(), brakes.map((o) => o.id).sort()])
  return {
    ok: true,
    exec: { root, market, enrollLevels: toSet, enrollEnds: [...leftoverIds] },
    preview: {
      action: CONTROL_TOOL, op: 'enroll', summary, product: ctx.name, sku: ctx.sku,
      brain: { productId: root, market, enrolled: false, version: null }, scope: { level: 'product' },
      changes, totals: { campaigns: campaigns.length, ownCampaigns: ctx.own.length, sharedCampaigns: ctx.shared.length, adoptedLive: adoptedLive.length },
      campaigns, notReached: campaigns.filter((c) => !c.reached).map((c) => ({ campaignId: c.campaignId, name: c.name, why: c.why })),
      turnsAuto, starts, raises, warnings, needsCode, bigDoor, ceiling: ctx.ceiling, basis, version: null,
      reachNote: 'Nexus only: enrolling moves no campaign and sends nothing to Amazon; the brain acts in its own runs, at each lever\'s level.',
      undoNote: 'undo-change asks set-ads-brain op leave keeping the bid brain\'s campaigns and the brain\'s pauses as they are (bids: keep, pauses: keep): the product leaves the brain again; what the brain did meanwhile stays.',
      enroll: { adoptedBids: adopted, adoptedLive: adoptedLive.map((c) => c.campaignId), keptInShadow: keptInShadow.map((c) => c.campaignId), levels: Object.fromEntries(toSet.map((x) => [x.lever, x.level])), ends: [...leftoverIds] },
    },
  }
}

const refusalList = (r: readonly string[]) => (r.length === 1 ? `Not queued: ${r[0]}` : `Not queued — ${r.length} refusals: ${r.map((x, i) => `(${i + 1}) ${x}`).join(' ')}`)

// ── leave ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Batch 2 fix — the requests the product's brain asked for in this market that still wait for a person: its money asks
 * (budgets, cap), its state, negatives and harvest requests (a harvest's undo too) and its painted hourly plans. Read from
 * each lever's own log (they hold the approval ids), then the approvals still pending.
 */
export async function brainRequestsWaiting(productId: string, market: string): Promise<Array<{ approvalId: string; tool: string; lever: string; requestedAt: string }>> {
  const where = { productId, marketplace: market }
  const [asks, negatives, states, harvests, hours] = await Promise.all([
    prisma.adsBrainAsk.findMany({ where: { ...where, approvalId: { not: null } }, select: { approvalId: true, kind: true } }),
    prisma.adsBrainNegative.findMany({ where: { ...where, approvalId: { not: null } }, select: { approvalId: true } }),
    prisma.adsBrainStateDecision.findMany({ where: { ...where, approvalId: { not: null } }, select: { approvalId: true } }),
    prisma.adsBrainHarvest.findMany({ where: { ...where, OR: [{ approvalId: { not: null } }, { undoApprovalId: { not: null } }] }, select: { approvalId: true, undoApprovalId: true } }),
    prisma.adsBrainHourProposal.findMany({ where: { ...where, approvalId: { not: null } }, select: { approvalId: true } }),
  ])
  const lever = new Map<string, string>()
  for (const a of asks) lever.set(a.approvalId!, a.kind === 'portfolioCap' ? 'portfolioCap' : 'budgets')
  for (const n of negatives) lever.set(n.approvalId!, 'negatives')
  for (const s of states) lever.set(s.approvalId!, 'state')
  for (const h of harvests) for (const id of [h.approvalId, h.undoApprovalId]) if (id) lever.set(id, 'harvest')
  for (const h of hours) lever.set(h.approvalId!, 'hours')
  if (!lever.size) return []
  const pending = await prisma.agentApproval.findMany({ where: { id: { in: [...lever.keys()] }, status: 'pending' }, select: { id: true, toolName: true, requestedAt: true }, orderBy: { requestedAt: 'asc' } })
  return pending.map((a) => ({ approvalId: a.id, tool: a.toolName, lever: lever.get(a.id)!, requestedAt: a.requestedAt.toISOString() }))
}

async function previewLeave(ctx: Ctx): Promise<ControlOutcome> {
  const { root, market, input } = ctx
  if (!ctx.enrollment) return no(`${ctx.name} is not enrolled in the brain for ${market}: there is nothing to leave`)
  const bids: LeaveBids = input.bids ?? 'give-back'
  // Every choice set under this product's brain (also on a campaign that no longer advertises it).
  const mine = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, productId: root, marketplace: market },
    select: { id: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true },
    orderBy: { createdAt: 'asc' },
  })
  const ends = mine.filter((o) => o.kind === 'LEVEL' || o.kind === 'VALUE')
  const keeps = mine.filter((o) => o.kind === 'LOCK' || o.kind === 'EXCLUDE')
  const running = ctx.own.filter((c) => isOwnedMode(c.mode))
  const refusals: string[] = []
  const giveBack: NonNullable<ControlPreview['leave']>['giveBack'] = []
  const toShadow: NonNullable<ControlPreview['leave']>['toShadow'] = []
  const moves: Array<{ campaignId: string; op: 'shadow' | 'give-back' }> = []
  if (bids !== 'keep') {
    for (const c of running) {
      const op = bids === 'give-back' ? 'give-back' as const : 'shadow' as const
      const f = await enrollmentFacts(c.campaignId, { plansJoin: PLANS_JOIN_THE_BRAIN })
      const r = f ? enrollRefusal(f, op) : `${c.name} is no longer in this business`
      if (r) { refusals.push(`${r}${op === 'shadow' ? ' — or leave with bids: "give-back"' : ' — or leave with bids: "shadow" (bids stay where they are)'}`); continue }
      moves.push({ campaignId: c.campaignId, op })
      if (op === 'give-back' && f?.enrollment?.snapshot) {
        const back = await giveBackPlan(c.campaignId, f.enrollment.snapshot)
        giveBack.push({ campaignId: c.campaignId, name: c.name, keywordBids: back.targets.length, adGroupBids: back.adGroups.length, placements: !!back.placements, raises: back.raises })
      } else toShadow.push({ campaignId: c.campaignId, name: c.name, stopMemory: f?.stopMemory?.words ?? null })
    }
  }
  if (refusals.length) return no(refusalList(refusals))

  const b = (cid: string | null) => resolveBrainSettings({ productId: root, market, campaignId: cid, enrolled: true, overrides: ctx.overrides })
  const a = (cid: string | null) => resolveBrainSettings({ productId: root, market, campaignId: cid, enrolled: false, overrides: ctx.overrides })
  const pb = b(null)
  const productLevels = Object.fromEntries(ends.filter((o) => o.scope === 'PRODUCT' && o.kind === 'LEVEL' && isLever(o.key) && isLevel(o.value)).map((o) => [o.key, o.value as BrainLevel])) as Partial<Record<BrainLever, BrainLevel>>
  const own = ctx.own.map((c) => ({ campaignId: c.campaignId, name: c.name }))
  const released = releasedLevers(b, a, [{ campaignId: null, name: 'the product' }, ...own])

  // Batch 2 fix — what the brain still holds goes with it: its pauses in force (resumed, or kept with their names), and
  // every request it asked for that still waits for a person (withdrawn: approved later, it would run without the brain).
  const pauses: LeavePauses = input.pauses ?? 'resume'
  const inForce = await brainPausesInForce(ctx.own.map((c) => c.campaignId))
  const brainPauses = inForce.map((p) => ({
    campaignId: p.campaignId, name: p.name, since: p.memory.pausedAt ? String(p.memory.pausedAt) : null,
    causes: [...(p.memory.causes ?? [])].map(String), expectedEnd: p.memory.expectedEndAt ?? null, resumes: pauses === 'resume',
  }))
  const resumes = pauses === 'resume' ? inForce.map((p) => ({ campaignId: p.campaignId, statusBefore: p.memory.statusBefore ?? 'ENABLED' })) : []
  const withdraws = await brainRequestsWaiting(root, market)

  const raises: string[] = []
  const gbRaises = giveBack.reduce((n, g) => n + g.raises, 0)
  if (gbRaises) raises.push(`${plural(gbRaises, 'bid or placement')} back up to ${gbRaises === 1 ? 'its' : 'their'} value when ${giveBack.length === 1 ? 'the campaign' : 'each campaign'} went LIVE (${names(giveBack)}), as the person who approves it`)
  const owed = toShadow.filter((t) => t.stopMemory)
  if (owed.length) raises.push(`what a stop saved goes back on ${names(owed)} (${owed.map((t) => t.stopMemory).join('; ')}), as the person who approves it`)
  const warnings: string[] = []
  if (released.length) warnings.push(`Today's engines may write these levers again (whatever is set up there, raises included): ${released.join('; ')}.`)
  if (running.length && bids === 'keep') warnings.push(`The bid brain keeps running ${names(running)} one by one, as before the product was enrolled (set-bid-brain-enrollment moves each); nothing else of the product's brain acts.`)
  if (running.length && bids !== 'keep') warnings.push(`${names(running)} ${running.length === 1 ? 'leaves' : 'leave'} the bid brain (${bids === 'give-back' ? 'bids and placements back as they were when each went LIVE' : 'bids stay where they are'}): today's engines (auto-bid, rules) may move ${running.length === 1 ? 'its' : 'their'} keyword bids again.`)
  const sharedLive = ctx.shared.filter((c) => isOwnedMode(c.mode))
  if (sharedLive.length) warnings.push(`${names(sharedLive)} ${sharedLive.length === 1 ? 'is a shared campaign' : 'are shared campaigns'} the bid brain runs by a per-campaign enrollment: leaving does not move ${sharedLive.length === 1 ? 'it' : 'them'} (set-bid-brain-enrollment does).`)
  const pauseCauses = (p: (typeof brainPauses)[number]) => `${p.name}: paused${p.since ? ` since ${p.since.slice(0, 10)}` : ''} for ${p.causes.length ? p.causes.join(', ') : 'a stop'}${p.expectedEnd ? `, expected to end ${p.expectedEnd.slice(0, 10)}` : ''}`
  if (brainPauses.length && pauses === 'resume') {
    raises.push(`the brain's own ${brainPauses.length === 1 ? 'pause' : 'pauses'} lifted on ${names(brainPauses)} (spend restarts), as the person who approves it`)
    warnings.push(`${names(brainPauses)} ${brainPauses.length === 1 ? 'is' : 'are'} resumed after the product leaves (${brainPauses.map(pauseCauses).join('; ')}): the brain would no longer resume ${brainPauses.length === 1 ? 'it' : 'them'}. If a stop still holds (stock, a long stop), leave with pauses: "keep" — today's engines (the retail guard) then decide.`)
  }
  if (brainPauses.length && pauses === 'keep') warnings.push(`${names(brainPauses)} ${brainPauses.length === 1 ? 'stays' : 'stay'} paused (${brainPauses.map(pauseCauses).join('; ')}): the brain paused ${brainPauses.length === 1 ? 'it' : 'them'} for a stop and no longer resumes ${brainPauses.length === 1 ? 'it' : 'them'} once the product leaves — a person enables ${brainPauses.length === 1 ? 'it' : 'them'} in the campaign manager, or leaves with pauses: "resume".`)
  if (withdraws.length) warnings.push(`${plural(withdraws.length, 'request')} the brain asked for still ${withdraws.length === 1 ? 'waits' : 'wait'} for a person (${withdraws.map((w) => `${w.tool} ${w.approvalId}`).join(', ')}): withdrawn as the product leaves — approved later, ${withdraws.length === 1 ? 'it' : 'each'} would run as the approver without the brain.`)
  if (keeps.length) warnings.push(`The Owner's ${plural(keeps.length, 'lock or exclusion', 'locks and exclusions')} stay${keeps.length === 1 ? 's' : ''} (${keeps.map((o) => `${o.kind === 'EXCLUDE' ? 'exclusion' : `lock of ${o.key}${o.ref ? ` (${o.ref})` : ''}`}${o.campaignId ? ` on campaign ${o.campaignId}` : ''}`).join(', ')}): they still keep the bid brain and the stop recipe off what they hold, and apply again if the product is enrolled later; unlock and include end them.`)

  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const groups = new Map<string, BrainLever[]>()
  for (const l of BRAIN_LEVERS) groups.set(pb.levers[l].effective, [...(groups.get(pb.levers[l].effective) ?? []), l])
  for (const [e, ls] of groups) changes[ls.length === BRAIN_LEVERS.length ? 'every lever' : ls.join(', ')] = { from: effectiveWord(e as Effective), to: effectiveWord('NOT_ENROLLED') }
  if (moves.length) changes['bid brain'] = { from: `${plural(running.length, 'campaign')} LIVE or HELD`, to: bids === 'give-back' ? 'shadow, bids given back' : 'shadow, bids where they are' }
  if (withdraws.length) changes['brain requests waiting'] = { from: plural(withdraws.length, 'request'), to: 'withdrawn' }
  if (resumes.length) changes['brain pauses'] = { from: `${plural(resumes.length, 'campaign')} PAUSED by the brain`, to: 'ENABLED (resumed as the approver)' }
  const campaigns: CampaignReach[] = [...ctx.own, ...ctx.shared].map((c) => {
    const changes = leverMoves(BRAIN_LEVERS, b(c.campaignId), a(c.campaignId))
    const m = moves.find((x) => x.campaignId === c.campaignId)
    if (m) changes.push({ what: 'bid brain', from: c.mode ?? 'SHADOW', to: m.op === 'give-back' ? 'SHADOW (bids given back)' : 'SHADOW (bids stay)' })
    if (c.owner === 'own' && isOwnedMode(c.mode) && bids === 'keep') changes.push({ what: 'bid brain', from: c.mode!, to: `${c.mode} (kept, one by one)` })
    const r = resumes.find((x) => x.campaignId === c.campaignId)
    if (r) changes.push({ what: 'state', from: 'PAUSED (the brain\'s pause)', to: `${r.statusBefore} (resumed)` })
    return { campaignId: c.campaignId, name: c.name, owner: c.owner, status: c.status, changes, reached: c.owner === 'own', why: c.owner === 'shared' ? 'a shared campaign: no product\'s brain owned its levers' : 'its own campaign' }
  })
  const summary = `Takes ${ctx.name} (${ctx.sku}) out of the brain for ${market}: every lever back to OFF (today's engines run it), ${plural(ends.length, 'level or value', 'levels and values')} of its brain ended${keeps.length ? `, the Owner's ${plural(keeps.length, 'lock or exclusion', 'locks and exclusions')} kept` : ''}.${running.length ? ` ${bids === 'keep' ? `The bid brain keeps running ${plural(running.length, 'campaign')} one by one.` : `${plural(running.length, 'campaign')} the bid brain runs ${running.length === 1 ? 'goes' : 'go'} back to shadow${bids === 'give-back' ? ', bids and placements given back as they were when each went LIVE' : ', bids where they are'}.`}` : ''}${withdraws.length ? ` ${plural(withdraws.length, 'request')} the brain asked for ${withdraws.length === 1 ? 'is' : 'are'} withdrawn.` : ''}${brainPauses.length ? ` ${plural(brainPauses.length, 'campaign')} the brain paused ${pauses === 'resume' ? `${brainPauses.length === 1 ? 'is' : 'are'} resumed` : `${brainPauses.length === 1 ? 'stays' : 'stay'} paused`}.` : ''}`
  // The pauses it resumes are part of what is approved (spend restarts); the requests it withdraws are whichever still wait.
  const basis = hash(['leave', ctx.enrollment.version, ends.map((o) => o.id), keeps.map((o) => o.id), running.map((c) => [c.campaignId, c.mode]), moves, bids, resumes])
  // Code rule A — lifting a pause an automation made (the brain is one, now going off) is a big door: the approver's code.
  const bigDoor = resumes.length ? [`lifts the brain's own ${resumes.length === 1 ? 'pause' : 'pauses'} on ${names(brainPauses)} (an automation's pause, the brain leaving)`] : []
  return {
    ok: true,
    exec: { root, market, leave: { ends: ends.map((o) => o.id), moves, productLevels, withdraws: withdraws.map((w) => w.approvalId), resumes } },
    preview: {
      action: CONTROL_TOOL, op: 'leave', summary, product: ctx.name, sku: ctx.sku,
      brain: { productId: root, market, enrolled: true, version: ctx.enrollment.version }, scope: { level: 'product' },
      changes, totals: { campaigns: campaigns.length, endsChoices: ends.length, keepsChoices: keeps.length, givenBack: giveBack.length, toShadow: toShadow.length, keptLive: bids === 'keep' ? running.length : 0, withdrawn: withdraws.length, resumed: resumes.length },
      campaigns, notReached: campaigns.filter((c) => !c.reached).map((c) => ({ campaignId: c.campaignId, name: c.name, why: c.why })),
      turnsAuto: [], starts: [`every lever: ${effectiveWord('NOT_ENROLLED')} — the brain leaves the product; nothing of it decides, logs, asks or writes, and today's engines run every lever`],
      raises, warnings, needsCode: bigDoor.length > 0, bigDoor, ceiling: ctx.ceiling, basis, version: ctx.enrollment.version,
      reachNote: moves.length || resumes.length
        ? `It records the change in Nexus${withdraws.length ? ' and withdraws the brain\'s waiting requests' : ''}, then ${[moves.length ? (bids === 'give-back' ? 'puts back each campaign\'s bids and placements at Amazon' : 'gives back at Amazon what a stop saved') : '', resumes.length ? `resumes ${plural(resumes.length, 'campaign')} the brain paused` : ''].filter(Boolean).join(' and ')}, as the approver (the write gate judges each write).`
        : `Nexus only: nothing is sent to Amazon by this change${withdraws.length ? ' (the brain\'s waiting requests are withdrawn in Nexus)' : ''}.`,
      undoNote: `undo-change asks set-ads-brain op enroll again with the product's earlier lever levels (the bids lever as its campaigns hold it then): a request of its own, a big door if any lever is AUTO; what was given back at Amazon stays, resumed campaigns stay on and withdrawn requests stay withdrawn.`,
      leave: {
        bids, ends: ends.map((o) => ({ id: o.id, scope: o.scope, campaignId: o.campaignId, kind: o.kind, key: o.key, value: o.value })),
        keeps: keeps.map((o) => ({ id: o.id, scope: o.scope, campaignId: o.campaignId, kind: o.kind, key: o.key, ref: o.ref })),
        giveBack, toShadow, keepLive: bids === 'keep' ? running.map((c) => ({ campaignId: c.campaignId, name: c.name, mode: c.mode! })) : [],
        pauses, brainPauses, withdraws,
      },
    },
  }
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ControlRunArgs {
  by: string
  reason?: string | null
  /** What the approval was made on: the op runs only on the same basis and version. */
  approved?: { basis?: unknown; version?: unknown } | null
  now?: Date
}

export type ControlRunResult =
  | { ok: false; refusal: string }
  | {
    ok: true
    preview: ControlPreview
    version: number | null
    before: Record<string, unknown>
    after: Record<string, unknown>
    /** op leave: the campaigns whose bids and placements the tool gives back, and those whose stop memory it gives back. */
    giveBack: string[]
    toShadow: string[]
    /** op leave (batch 2 fix): the campaigns the brain paused that the tool resumes after the commit, and the requests withdrawn. */
    resumes?: Array<{ campaignId: string; statusBefore: string }>
    withdrawn?: string[]
  }

/** Run one approved op on the basis it was approved on. All or nothing (one Serializable transaction). */
export async function runControl(input: ControlInput, args: ControlRunArgs): Promise<ControlRunResult> {
  const now = args.now ?? new Date()
  const fresh = await previewControl(input)
  if ('refusal' in fresh) return { ok: false, refusal: fresh.refusal }
  const { preview, exec } = fresh
  const approved = args.approved ?? null
  if (approved && approved.basis !== undefined && approved.basis !== preview.basis) {
    return { ok: false, refusal: `what this change would do changed since it was approved (the product's brain, a campaign's place in the bid brain or an override moved): nothing changed, preview it again` }
  }
  if (approved && approved.version !== undefined && (approved.version ?? null) !== preview.version) {
    return { ok: false, refusal: `the product's brain changed since this was approved (version ${preview.version ?? 'none'}, not ${approved.version ?? 'none'}): nothing changed, preview it again` }
  }
  const common = { productId: exec.root, market: exec.market, by: args.by, reason: args.reason ?? null, now }
  const identity = { op: input.op, productId: exec.root, market: exec.market }
  if (exec.change && exec.before) {
    const run = exec.change.op === 'set'
      ? await setOverride({ ...common, expectVersion: preview.version ?? undefined, expectBasis: preview.basis, override: exec.change.input })
      : await endOverride({ ...common, expectVersion: preview.version ?? undefined, expectBasis: preview.basis, override: exec.change.input })
    if ('refusal' in run) return { ok: false, refusal: run.refusal }
    const { open: wasOpen, value: wasValue, ...who } = exec.before
    return {
      ok: true, preview, version: run.version, giveBack: [], toShadow: [],
      before: { ...identity, ...who, open: wasOpen, value: wasValue },
      // The override's own state only (no version): undo is refused when THIS choice moved since, not any other.
      after: { ...identity, ...who, open: exec.after!.open, value: exec.after!.value },
    }
  }
  if (input.op === 'enroll') {
    try {
      const version = await inDatabaseTransaction(prisma, async () => {
        if (exec.enrollEnds?.length) {
          const ended = await prisma.adsBrainOverride.updateMany({ where: { id: { in: exec.enrollEnds }, endedAt: null }, data: { endedAt: now, endedBy: args.by } })
          if (ended.count !== exec.enrollEnds.length) throw new BrainRefusal('an earlier choice of this product\'s brain changed while this ran: nothing changed, preview it again')
        }
        const done = await enrollProduct({ productId: exec.root, market: exec.market, by: args.by, now })
        if ('refusal' in done) throw new BrainRefusal(done.refusal)
        let v = done.version
        for (const x of exec.enrollLevels ?? []) {
          const set = await setOverride({ ...common, override: { scope: 'PRODUCT', kind: 'LEVEL', key: x.lever, value: x.level } })
          if ('refusal' in set) throw new BrainRefusal(set.refusal)
          v = set.version
        }
        return v
      }, { isolationLevel: 'Serializable' })
      forgetLeverOwners()
      logger.info('[ads-brain] enrolled by the Owner', { productId: exec.root, market: exec.market, by: args.by, levels: exec.enrollLevels, version })
      return {
        ok: true, preview, version, giveBack: [], toShadow: [],
        before: { ...identity, enrolled: false },
        after: { ...identity, enrolled: true, version, levels: Object.fromEntries((exec.enrollLevels ?? []).map((x) => [x.lever, x.level])) },
      }
    } catch (e) {
      if (e instanceof BrainRefusal) return { ok: false, refusal: e.message }
      throw e
    }
  }
  // leave
  const leave = exec.leave!
  let withdrawn = 0
  try {
    await inDatabaseTransaction(prisma, async () => {
      const row = await prisma.adsBrainEnrollment.findFirst({ where: { productId: exec.root, marketplace: exec.market }, select: { id: true, version: true } })
      if (!row || row.version !== preview.version) throw new BrainRefusal('the product\'s brain changed while this ran: nothing changed, preview it again')
      if (leave.ends.length) {
        const ended = await prisma.adsBrainOverride.updateMany({ where: { id: { in: leave.ends }, endedAt: null }, data: { endedAt: now, endedBy: args.by } })
        if (ended.count !== leave.ends.length) throw new BrainRefusal('a choice of this product\'s brain changed while this ran: nothing changed, preview it again')
      }
      const gone = await prisma.adsBrainEnrollment.deleteMany({ where: { id: row.id, version: row.version } })
      if (gone.count !== 1) throw new BrainRefusal('the product\'s brain changed while this ran: nothing changed, preview it again')
      for (const m of leave.moves) {
        await setEnrollment({ campaignId: m.campaignId, marketplace: exec.market, op: m.op, by: args.by, reason: `the product left the brain — ${args.reason ?? 'set-ads-brain op leave'}`, now })
      }
      // Batch 2 fix — the brain's requests that still wait are withdrawn with it (one a person decided meanwhile is his).
      if (leave.withdraws.length) {
        const out = await prisma.agentApproval.updateMany({ where: { id: { in: leave.withdraws }, status: 'pending' }, data: { status: 'rejected', reason: LEAVE_WITHDRAWN, decidedAt: now } })
        withdrawn = out.count
      }
    }, { isolationLevel: 'Serializable' })
  } catch (e) {
    if (e instanceof BrainRefusal) return { ok: false, refusal: e.message }
    throw e
  }
  forgetLeverOwners()
  logger.info('[ads-brain] product left the brain', { productId: exec.root, market: exec.market, by: args.by, ended: leave.ends.length, moved: leave.moves.length, withdrawn, resumes: leave.resumes.length })
  return {
    ok: true, preview, version: null,
    giveBack: leave.moves.filter((m) => m.op === 'give-back').map((m) => m.campaignId),
    toShadow: leave.moves.filter((m) => m.op === 'shadow').map((m) => m.campaignId),
    resumes: leave.resumes,
    withdrawn: withdrawn ? leave.withdraws : [],
    before: { ...identity, enrolled: true, version: preview.version, levels: leave.productLevels, ended: leave.ends },
    after: { ...identity, enrolled: false },
  }
}

/** What is stored now for a change of this tool, in the shape of its `after` (undo refuses when it moved since). */
export async function controlStateNow(after: Record<string, unknown>): Promise<Record<string, unknown>> {
  const productId = String(after.productId ?? '')
  const market = String(after.market ?? '')
  const op = String(after.op ?? '')
  const identity = { op, productId, market }
  if (op === 'enroll' || op === 'leave') {
    const row = await prisma.adsBrainEnrollment.findFirst({ where: { productId, marketplace: market }, select: { version: true } })
    // An enrollment is undone only while nothing changed it since (its version): leaving would end those later choices too.
    return op === 'enroll' ? { ...identity, enrolled: !!row, version: row?.version ?? null, levels: after.levels } : { ...identity, enrolled: !!row }
  }
  const scope = String(after.scope ?? 'PRODUCT')
  const campaignId = (after.campaignId as string | null) ?? null
  const kind = String(after.kind ?? '') as OverrideKind
  const key = String(after.key ?? '')
  const ref = String(after.ref ?? '')
  const open = await prisma.adsBrainOverride.findFirst({
    where: { endedAt: null, scope, kind, key, ref, ...(scope === 'CAMPAIGN' ? { campaignId } : { productId, marketplace: market, campaignId: null }) },
    orderBy: { createdAt: 'desc' },
    select: { value: true },
  })
  return { ...identity, scope, campaignId, kind, key, ref, open: !!open, value: open?.value ?? null }
}

/** The request that puts a change of this tool back (pure): the op that restores `before`, or why it cannot. */
export function controlUndoRequest(before: Record<string, unknown>): { args: Record<string, unknown> } | { refusal: string } {
  const op = String(before.op ?? '')
  const base = { productId: String(before.productId ?? ''), market: String(before.market ?? ''), why: 'undo of an earlier set-ads-brain change' }
  if (!base.productId || !base.market) return { refusal: 'This change does not record the product and market it changed.' }
  if (op === 'enroll') return { args: { ...base, op: 'leave', bids: 'keep', pauses: 'keep' } }
  if (op === 'leave') {
    const levels = Object.fromEntries(Object.entries((before.levels ?? {}) as Record<string, unknown>).filter(([l, v]) => l !== 'bids' && isLever(l) && isLevel(v)))
    return { args: { ...base, op: 'enroll', ...(Object.keys(levels).length ? { levels } : {}) } }
  }
  const campaignId = typeof before.campaignId === 'string' && before.campaignId ? { campaignId: before.campaignId } : {}
  const open = before.open === true
  const value = before.value
  switch (String(before.kind)) {
    case 'LEVEL': return { args: { ...base, ...campaignId, op: 'set-level', lever: before.key, ...(open ? { level: value } : { reset: true }) } }
    case 'LOCK': return { args: { ...base, ...campaignId, op: open ? 'lock' : 'unlock', lever: before.key, ...(before.ref ? { ref: before.ref } : {}), ...(open && value !== null && value !== undefined ? { value } : {}) } }
    case 'EXCLUDE': return { args: { ...base, ...campaignId, op: open ? 'exclude' : 'include' } }
    case 'VALUE': return { args: { ...base, ...campaignId, op: 'set-value', key: before.key, ...(open ? { value: value ?? null } : { reset: true }) } }
    default: return { refusal: 'This change does not record what it changed.' }
  }
}

