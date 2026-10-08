/**
 * ONE BRAIN AB-12 — the state lever of a product's brain (design 2026-10-08-ads-one-brain/DESIGN.md §2.4, §2.10, §5,
 * §8 row AB-12; Owner D4 = A: "the brain may pause a campaign alone for a multi-day stop"). Pure: brain/state-load.ts
 * reads the facts, brain/state-run.ts logs, asks and writes, brain/state-read.ts shows them.
 *
 *   short stop   a stop expected to end within `pauseMinDays` (3 by default) stays on low bids — the stop recipe where the
 *                bid brain runs the campaign (3¢, every lane at 0 %, down only: bid-brain/stop-recipe.ts), else the floor of
 *                the stop's owner — and is never a pause: an ad serves again about a minute after its bids come back, but
 *                about an hour after a pause is lifted
 *   long stop    a stop expected to last `pauseMinDays` or more is a PAUSE. Its causes and their horizons:
 *                  stock        every enabled ad group of the campaign out of stock: the first product back ends it — a
 *                               dated inbound shipment or purchase order (restock date), else the replenishment lead time
 *                               (a reorder placed now lands no sooner: the forecast); units inbound with no date, or an
 *                               arrival already overdue, may land any day (short); nothing coming at all is open-ended
 *                  monthly cap  budget enforcement stopped it over the month's cap: it lifts on the 1st (UTC month)
 *                  playbook     a playbook STOP: open-ended, until a person starts it again
 *                  declared     the Owner's long stop (`longStopUntil`): through that day
 *                the stop ends when every cause has ended (the longest horizon decides); an open-ended stop pauses once
 *                the brain has seen it hold for OPEN_SETTLE_HOURS
 *   resume       when every cause of the brain's own pause has ended (stock: back above its restart line, the stock
 *                service's own hysteresis), the campaign goes back to the status it had (ENABLED). The pause writes
 *                nothing else, so the stop recipe's memory — the keywords' bids, the lanes and the bidding strategy it
 *                saved — is exactly as it was, and the stop's owner gives it back as the stop ends
 *   archive      a campaign without an impression for `archiveDeadWeeks` weeks (and older than that) is PROPOSED for
 *                archiving — never archived alone, whatever the level (archive-ads cannot be undone)
 *   holds        the brain pauses only an ENABLED campaign and resumes only a pause it made itself (its own write, or a
 *                request it asked for that a person approved). A status change by anyone else — a person in Nexus, Amazon
 *                (Seller Central), a rule — is a hold for HOLD_DAYS (design §2.10): the brain neither pauses nor resumes
 *                that campaign meanwhile, and never resumes a pause it did not make
 *   hysteresis   no flip-flop: a pause stands at least MIN_PAUSED_HOURS, a resumed campaign serves at least
 *                MIN_SERVING_HOURS before the brain pauses it again; a request a person declined is not asked again for
 *                DECLINE_DAYS; a pause or resume of its own that did not land (refused at dispatch, failed at Amazon) is not
 *                tried again for MIN_PAUSED_HOURS
 *   caps         at most MAX_PAUSES_PER_MARKET_DAY pauses a UTC day per market (design §5), each with its reason and
 *                expected end; the shadow counts its own so it shows what AUTO would do
 *   levels       OFF / not enrolled / excluded → nothing (a shared campaign too: D2 = A); LOCKED → nothing, the
 *                recommendation only; OBSERVE → SHADOW (logged); PROPOSE → an approval request; AUTO → written as the
 *                brain (BRAIN_STATE_ACTOR) through the normal status path, only under the live ceiling and while the
 *                account's ads automation runs — an archive is a request at AUTO too
 *   never        a bid, a budget, a lane, a strategy or a stock quantity (FBA included): the state lever writes the
 *                campaign's status and nothing else
 */
import { createHash } from 'node:crypto'

export const STATE_CAUSES = ['stock', 'monthly_cap', 'playbook', 'declared'] as const
export type StateCause = (typeof STATE_CAUSES)[number]
/** How a stop's end is known. */
export type HorizonSource = 'restock_date' | 'forecast' | 'month_end' | 'declared' | 'open' | 'soon'

/** The most pauses the brain makes a UTC day in one market (design §5). */
export const MAX_PAUSES_PER_MARKET_DAY = 3
/** A pause stands at least this long before the brain resumes it (no flip-flop). */
export const MIN_PAUSED_HOURS = 24
/** A campaign the brain resumed serves at least this long before it pauses it again. */
export const MIN_SERVING_HOURS = 24
/** An open-ended stop (nothing says when it ends) pauses once the brain has seen it hold this long. */
export const OPEN_SETTLE_HOURS = 24
/** A status change by anyone but the brain holds the campaign this long (design §2.10: a person's edit is a 60-day hold). */
export const HOLD_DAYS = 60
/** A request a person declined (rejected, or let expire) is not asked again for this long. */
export const DECLINE_DAYS: Record<'pause' | 'resume' | 'archive', number> = { pause: 1, resume: 1, archive: 30 }
/** The state brain's log is kept this long (Neon cost). */
export const STATE_DECISION_DAYS_KEPT = 30

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** What holds a stop that is not a pause (the brain writes no bid itself: the bid brain's stop recipe, or the stop owner's floor). */
const LOW_BIDS = 'low bids hold it (the stop recipe where the bid brain runs the campaign, else the floor of the stop\'s owner)'
const day = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10)
const hoursBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / HOUR_MS
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── Causes and horizons ────────────────────────────────────────────────────────────────────────────────────────────

/** One cause of a stop in force, with when it is expected to end (null: open-ended, or `soon` — any day). */
export interface StopCause {
  cause: StateCause
  endsAt: Date | null
  source: HorizonSource
  words: string
}

/** One advertised product of an out-of-stock ad group, as the stock horizon reads it. */
export interface StockProductFacts {
  productId: string
  sku: string | null
  units: number
  /** Units the replenishment suggestion counts inbound within the lead time (no date). */
  inboundUnits: number | null
  /** The replenishment lead time in days: a reorder placed now lands no sooner. */
  leadTimeDays: number | null
  /** The earliest date a dated inbound shipment or open purchase order brings it (null: none dated). */
  arrivalAt: Date | null
  /** Where that date comes from. */
  arrivalFrom?: 'inbound' | 'purchase_order' | null
}

/** One ad group of the campaign, as brain/state-load.ts reads it (ads-stock-risk.service.ts verdicts). */
export interface StockGroupFacts {
  status: string
  /** out-of-stock | low-stock | mixed | shared | ok | unknown | none */
  risk: string
  /** Every product back above its restart line (the stock service's hysteresis). */
  recovered: boolean
  products: StockProductFacts[]
}

/** One product's restock horizon: a date (restock_date, forecast), any day (soon), or open-ended. */
export function productRestock(p: StockProductFacts, now: Date): { endsAt: Date | null; source: HorizonSource; words: string } {
  const label = p.sku ?? p.productId
  if (p.arrivalAt) {
    if (p.arrivalAt.getTime() > now.getTime()) return { endsAt: p.arrivalAt, source: 'restock_date', words: `${label} back on ${day(p.arrivalAt)} (${p.arrivalFrom === 'purchase_order' ? 'a purchase order\'s date' : 'an inbound shipment\'s date'})` }
    return { endsAt: null, source: 'soon', words: `${label} was due on ${day(p.arrivalAt)} and has not arrived: it may land any day` }
  }
  if ((p.inboundUnits ?? 0) > 0) return { endsAt: null, source: 'soon', words: `${label} has ${plural(p.inboundUnits!, 'unit')} inbound with no date: it may land any day` }
  if ((p.leadTimeDays ?? 0) > 0) {
    return { endsAt: new Date(now.getTime() + p.leadTimeDays! * DAY_MS), source: 'forecast', words: `${label}: nothing inbound — a reorder placed now lands in ${plural(p.leadTimeDays!, 'day')} at the soonest (its lead time)` }
  }
  return { endsAt: null, source: 'open', words: `${label}: nothing inbound and no lead time known` }
}

/**
 * The stock side of a campaign. `stopped`: every enabled ad group with an ad is out of stock (an ad Nexus cannot tie to a
 * product, or another verdict, is no stop). `notRecovered`: no enabled ad group is back above its restart line — what a
 * pause for stock waits for (the stock service's own hysteresis, so one unit in does not resume it). The cause's horizon
 * is the first product back: any product that may land any day makes it `soon`; else the earliest date; else open.
 */
export function stockStop(groups: readonly StockGroupFacts[], now: Date): { stopped: boolean; notRecovered: boolean; cause: StopCause | null } {
  const considered = groups.filter((g) => g.status === 'ENABLED' && g.risk !== 'none')
  const notRecovered = considered.length > 0 && !considered.some((g) => g.recovered)
  const stopped = considered.length > 0 && considered.every((g) => g.risk === 'out-of-stock')
  if (!stopped) return { stopped, notRecovered, cause: null }
  const products = [...new Map(considered.flatMap((g) => g.products).map((p) => [p.productId, p])).values()]
  const horizons = products.map((p) => productRestock(p, now))
  const head = `out of stock (${plural(products.length, 'product')})`
  const soon = horizons.find((h) => h.source === 'soon')
  if (soon) return { stopped, notRecovered, cause: { cause: 'stock', endsAt: null, source: 'soon', words: `${head}: ${soon.words}` } }
  const dated = horizons.filter((h) => h.endsAt).sort((a, b) => a.endsAt!.getTime() - b.endsAt!.getTime())
  if (dated.length) return { stopped, notRecovered, cause: { cause: 'stock', endsAt: dated[0].endsAt, source: dated[0].source, words: `${head}: the first back — ${dated[0].words}` } }
  return { stopped, notRecovered, cause: { cause: 'stock', endsAt: null, source: 'open', words: `${head}: nothing inbound and no lead time known — no end in sight` } }
}

/** The start of the next UTC month: when budget enforcement gives a month's stop back (its month is the UTC month). */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

/** The budget engine's actor prefix (ads-budget-enforce.service.ts BUDGET_ACTOR_PREFIX): its floors are the month's cap. */
export const BUDGET_STOP_PREFIX = 'automation:budget-'

/** A stop over the month's cap: budget enforcement floored the campaign (or declared its stop over another owner's). */
export function monthlyCapStop(floor: { by: string | null; at: Date | null } | null, declaredBy: readonly string[], now: Date): StopCause | null {
  const by = floor?.at && floor.by?.startsWith(BUDGET_STOP_PREFIX) ? floor.by : declaredBy.find((b) => b.startsWith(BUDGET_STOP_PREFIX)) ?? null
  if (!by) return null
  const endsAt = nextMonthStart(now)
  const since = floor?.at && floor.by === by ? ` since ${day(floor.at)}` : ''
  return { cause: 'monthly_cap', endsAt, source: 'month_end', words: `the month's spend cap stopped it${since} (${by}): it lifts on ${day(endsAt)}` }
}

/** A playbook STOP on the campaign: open-ended, until a person starts the playbook again. */
export function playbookStop(label: string | null): StopCause | null {
  return label == null ? null : { cause: 'playbook', endsAt: null, source: 'open', words: `a playbook STOP (${label}): until it is started again` }
}

/** The Owner's long stop (`longStopUntil`, the last day of the stop, UTC): in force through that day. */
export function declaredStop(until: unknown, now: Date): StopCause | null {
  if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return null
  const endsAt = new Date(Date.parse(`${until}T00:00:00Z`) + DAY_MS)
  if (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= now.getTime()) return null
  return { cause: 'declared', endsAt, source: 'declared', words: `the Owner's long stop through ${until}` }
}

export type Horizon =
  | { kind: 'none' }
  /** Every cause may end any day (an undated arrival, an overdue one): short by nature. */
  | { kind: 'soon'; cause: StopCause }
  | { kind: 'short' | 'long'; hours: number; endsAt: Date; cause: StopCause }
  | { kind: 'open'; cause: StopCause }

/**
 * How long the stop lasts: until every cause has ended, so the longest decides — an open-ended cause makes it open, else
 * the latest end; `soon` only when nothing else is dated. Long from `pauseMinDays` days on.
 */
export function stopHorizon(causes: readonly StopCause[], now: Date, pauseMinDays: number): Horizon {
  if (!causes.length) return { kind: 'none' }
  const open = causes.find((c) => c.source === 'open')
  if (open) return { kind: 'open', cause: open }
  const dated = causes.filter((c) => c.endsAt).sort((a, b) => b.endsAt!.getTime() - a.endsAt!.getTime())
  if (!dated.length) return { kind: 'soon', cause: causes[0] }
  const hours = Math.max(0, hoursBetween(now, dated[0].endsAt!))
  return { kind: hours >= pauseMinDays * 24 ? 'long' : 'short', hours, endsAt: dated[0].endsAt!, cause: dated[0] }
}

// ── Facts and decision ─────────────────────────────────────────────────────────────────────────────────────────────

/** The stop recipe's memory on the campaign now: what the stop's owner gives back when the stop ends (never the brain's state). */
export interface StopMemorySnapshot {
  /** Campaign.suppressedFromPlacements: the lanes a stop saved when it set them to 0 % (null: none). */
  savedPlacements: unknown
  /** Campaign.suppressedFromBiddingStrategy: the strategy a stop switched to down only from (null: none). */
  savedStrategy: string | null
  /** Campaign.biddingStrategy now. */
  biddingStrategy: string | null
  /** Keywords holding a remembered bid (AdTarget.suppressedFromBidCents). */
  flooredKeywords: number
  /** Who floored the campaign (Campaign.bidsSuppressedBy), if anyone. */
  floorBy: string | null
}

/** The brain's memory of its own pause: carried on its log while the pause holds; a resume gives back `statusBefore`. */
export interface PauseMemory {
  pausedAt: string
  /** auto: the brain wrote it (AUTO); request: a request it asked for, which a person approved (PROPOSE). */
  via: 'auto' | 'request'
  approvalId: string | null
  statusBefore: 'ENABLED'
  /** Every cause seen while it holds (the resume waits for all of them). */
  causes: StateCause[]
  expectedEndAt: string | null
  /** The stop recipe's memory when it paused: unchanged by the pause, given back by the stop's owner. */
  stop: StopMemorySnapshot
}

/** Who made the last status change on record. */
export type StatusChanger = 'brain' | 'person' | 'automation' | 'outside'

export interface StateFacts {
  campaignId: string
  name: string
  productId: string
  market: string
  status: string
  /** product: the brain's own campaign; shared: it advertises another product too (D2 = A: no brain's). */
  owner: 'product' | 'shared'
  /** The state lever on this campaign (brain/settings.ts LeverSettings.effective and why). */
  lever: { effective: string; why: string }
  pauseMinDays: number
  archiveDeadWeeks: number
  /** The causes of a stop in force now. */
  causes: StopCause[]
  /** The stock side as a resume reads it (stockStop.notRecovered). */
  stockNotRecovered: boolean
  /** When the brain first saw the stop in force (carried on its log); null: not seen before. */
  stopSince: Date | null
  /**
   * The last status change on record: Nexus's action log, or Amazon's report of a change made outside Nexus. The brain's
   * own: its writer's (`via` auto) or a request it asked for that a person approved (`via` request, its approval).
   */
  lastStatusChange: { to: string; at: Date; by: StatusChanger; who: string; via?: 'auto' | 'request'; approvalId?: string | null } | null
  /** The brain's memory of its own pause, when the last status change is that pause (null: none, or not carried). */
  memory: PauseMemory | null
  /** The stop recipe's memory now. */
  stopMemory: StopMemorySnapshot
  /** The newest request the brain asked for on this campaign: waiting, done, or declined (rejected / expired) and when. */
  asked: { action: 'pause' | 'resume' | 'archive'; approvalId: string; state: 'waiting' | 'done' | 'declined'; at: Date } | null
  /** Impressions over the last `archiveDeadWeeks` weeks when the daily report covers them; null: cannot judge. */
  impressions: number | null
  /** The shadow already counts this campaign as paused (its newest logged decision is a shadow pause): no new pause of the day's cap. */
  shadowPaused?: boolean
  /**
   * The brain's own status write of the last MIN_PAUSED_HOURS that did not land (refused at Amazon's door, failed,
   * cancelled), newer than the last change that did: the brain waits before asking again — no hourly loop against Amazon.
   */
  brainMiss?: { to: string; at: Date; result: string } | null
  /** Days since the campaign started (its start date, or when Nexus first saw it). */
  ageDays: number
}

export interface StateContext {
  now: Date
  /** NEXUS_BID_BRAIN_MODE is live: the gate judges the brain's writes only then, so AUTO writes only then. */
  ceilingLive: boolean
  /** The account's ads automation (ads-engine-guard.ts readEnginePosture): AUTO writes only at `auto`. */
  posture: { posture: 'auto' | 'suggest' | 'stopped'; why: string }
  /** Pauses left this UTC day in the market: for pauses that act (asked or written) and for the shadow's apart. */
  pausesLeft: { acting: number; shadow: number }
}

export type StateAction = 'pause' | 'resume' | 'archive' | 'keep' | 'hold' | 'skip'
export type StateMode = 'SHADOW' | 'PROPOSE' | 'LIVE'
/** What the decision asks the runner to do: log only, ask a person, write, or nothing (and why not). */
export type PlannedOutcome = 'shadow' | 'ask' | 'write' | 'waiting' | 'capped' | 'held' | 'none'

export interface StateDecision {
  campaignId: string
  name: string
  productId: string
  market: string
  /** The state lever's effective level here. */
  level: string
  status: string
  action: StateAction
  /** What the brain itself would do here, before its level: the recommendation a locked or watching lever shows. */
  wouldDo: 'pause' | 'resume' | 'archive' | 'keep' | 'hold' | 'skip'
  mode: StateMode
  outcome: PlannedOutcome
  /** The deciding cause (dead: an archive proposal). */
  cause: StateCause | 'dead' | 'none'
  causes: Array<{ cause: StateCause; endsAt: string | null; source: HorizonSource; words: string }>
  expectedEndAt: string | null
  horizonHours: number | null
  /** When the brain first saw the stop in force (carried to the next run). */
  stopSince: string | null
  /** The status a resume writes; the status a pause leaves (ENABLED). */
  to: 'PAUSED' | 'ENABLED' | 'ARCHIVED' | null
  /** The brain's memory of its own pause IN FORCE, carried on the log while it holds (null: no pause of the brain's holds). */
  memory: PauseMemory | null
  /** A pause decided here: the memory it starts once it lands (written at AUTO; carried on the request at PROPOSE). */
  startsMemory: PauseMemory | null
  /**
   * A resume of the brain's own AUTO pause asked through enable-ads: Nexus's own request (the system door) lifts the brain's
   * pause with a person's normal approval (batch 2 fix, ads-status.tools.ts); anyone else's request needs the approver's code.
   */
  liftsAutomationPause?: boolean
  /** The request this decision waits for (a waiting one, or the one it would ask about again). */
  approvalId: string | null
  /** Who holds the campaign (a person's or another writer's status change), in words. */
  hold: string | null
  /** What a person should know: a pause the brain made that it can no longer give back at this level. */
  attention: string | null
  why: string
}

const CAUSE_WORDS: Record<StateCause, string> = { stock: 'out of stock', monthly_cap: 'the monthly cap', playbook: 'a playbook STOP', declared: 'the Owner\'s long stop' }
const WHO_WORDS: Record<StatusChanger, string> = { brain: 'the brain', person: 'a person', automation: 'an automation', outside: 'a change outside Nexus (Amazon, Seller Central)' }
const changerWords = (c: NonNullable<StateFacts['lastStatusChange']>) => (c.by === 'person' || c.by === 'automation' ? `${WHO_WORDS[c.by]} (${c.who})` : WHO_WORDS[c.by])
const causeList = (causes: readonly StateCause[]) => [...new Set(causes)].map((c) => CAUSE_WORDS[c]).join(' and ')
const horizonWords = (h: Horizon): string =>
  h.kind === 'none' ? 'no stop' : h.kind === 'open' ? `${h.cause.words} — open-ended` : h.kind === 'soon' ? `${h.cause.words} — it may end any day` : `${h.cause.words} — expected to end ${day(h.endsAt)} (in ${Math.round(h.hours)} h)`

interface Core {
  wouldDo: StateDecision['wouldDo']
  cause: StateDecision['cause']
  horizon: Horizon
  to: StateDecision['to']
  memory: PauseMemory | null
  liftsAutomationPause?: boolean
  hold: string | null
  why: string
  /** The brain's own pause holds the campaign (its memory carried). */
  brainPause: boolean
}

/** The brain's memory of its own pause in force: carried, else rebuilt from the status change on record. */
function pauseMemoryOf(f: StateFacts): PauseMemory {
  if (f.memory) return f.memory
  const c = f.lastStatusChange!
  return {
    pausedAt: c.at.toISOString(), via: c.via ?? 'auto', approvalId: c.approvalId ?? null,
    statusBefore: 'ENABLED', causes: f.causes.map((x) => x.cause), expectedEndAt: null, stop: f.stopMemory,
  }
}

function stopMemoryWords(s: StopMemorySnapshot): string {
  const parts = [
    s.flooredKeywords ? `${plural(s.flooredKeywords, 'keyword bid')} remembered` : null,
    Array.isArray(s.savedPlacements) ? 'the lanes saved' : null,
    s.savedStrategy ? `the ${s.savedStrategy} strategy saved` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'no stop memory'
}

/** What the brain itself would do with this campaign, whatever its level. */
export function coreStateDecision(f: StateFacts, now: Date): Core {
  const horizon = stopHorizon(f.causes, now, f.pauseMinDays)
  const nothing = (wouldDo: Core['wouldDo'], why: string, hold: string | null = null): Core => ({ wouldDo, cause: horizon.kind === 'none' ? 'none' : horizon.cause.cause, horizon, to: null, memory: null, hold, why, brainPause: false })
  if (f.status === 'ARCHIVED') return nothing('skip', 'archived: nothing to decide')
  if (f.owner === 'shared') return nothing('skip', 'it advertises another product too: no brain pauses a shared campaign (D2 = A — the brain proposes a split)')
  const last = f.lastStatusChange
  const brainPause = f.status === 'PAUSED' && last?.by === 'brain' && last.to === 'PAUSED'
  // The brain's own pause or resume that did not land: no new try before MIN_PAUSED_HOURS (no loop against Amazon).
  const missed = f.brainMiss && hoursBetween(f.brainMiss.at, now) < MIN_PAUSED_HOURS ? f.brainMiss : null
  const missWords = (m: NonNullable<StateFacts['brainMiss']>) => `the brain's ${m.to === 'PAUSED' ? 'pause' : 'resume'} at ${m.at.toISOString().slice(11, 16)} UTC did not land (${m.result}): it tries again ${MIN_PAUSED_HOURS} h after it`

  if (brainPause) {
    const memory = pauseMemoryOf(f)
    const stockStill = memory.causes.includes('stock') && f.stockNotRecovered
    const carried: PauseMemory = { ...memory, causes: [...new Set([...memory.causes, ...f.causes.map((c) => c.cause)])] }
    if (f.causes.length || stockStill) {
      const why = f.causes.length
        ? `the stop goes on — ${horizonWords(horizon)}: it stays paused`
        : 'its products are back in stock but not above their restart line yet (the stock service\'s own line, so one unit in does not resume it): it stays paused'
      return { wouldDo: 'keep', cause: horizon.kind === 'none' ? 'stock' : horizon.cause.cause, horizon, to: null, memory: { ...carried, expectedEndAt: horizon.kind === 'short' || horizon.kind === 'long' ? horizon.endsAt.toISOString() : null }, hold: null, why, brainPause: true }
    }
    const pausedHours = hoursBetween(new Date(memory.pausedAt), now)
    if (missed?.to === 'ENABLED') return { wouldDo: 'keep', cause: 'none', horizon, to: null, memory: carried, hold: null, why: `the stop has ended, but ${missWords(missed)}`, brainPause: true }
    if (pausedHours < MIN_PAUSED_HOURS) {
      return { wouldDo: 'keep', cause: 'none', horizon, to: null, memory: carried, hold: null, why: `the stop has ended (${causeList(carried.causes)}), but it was paused ${Math.floor(pausedHours)} h ago: it resumes once the pause has stood ${MIN_PAUSED_HOURS} h (no flip-flop)`, brainPause: true }
    }
    return {
      wouldDo: 'resume', cause: 'none', horizon, to: memory.statusBefore, memory: carried, hold: null, brainPause: true,
      liftsAutomationPause: carried.via === 'auto',
      why: `the stop has ended (${causeList(carried.causes) || 'its cause'}): back to ${memory.statusBefore}, as before the pause on ${day(memory.pausedAt)}. The pause changed nothing else: the stop's memory (${stopMemoryWords(f.stopMemory)}) is given back by its owner as the stop ends`,
    }
  }

  const heldBy = last && last.by !== 'brain' && hoursBetween(last.at, now) < HOLD_DAYS * 24
    ? `${changerWords(last)} set it ${last.to} on ${day(last.at)}: a hold until ${day(new Date(last.at.getTime() + HOLD_DAYS * DAY_MS))}`
    : null
  const deadWeeks = f.archiveDeadWeeks
  const dead = f.impressions === 0 && f.ageDays >= deadWeeks * 7 && horizon.kind === 'none'
  const archive = (who: string): Core => ({
    wouldDo: 'archive', cause: 'dead', horizon, to: 'ARCHIVED', memory: null, hold: null, brainPause: false,
    why: `no impression for ${plural(deadWeeks, 'week')}${who}: proposed for archiving — only ever a proposal, a person decides (Amazon cannot switch an archived campaign on again)`,
  })

  if (f.status === 'PAUSED') {
    if (heldBy) return nothing('hold', `paused by ${changerWords(last!)} on ${day(last!.at)}: a pause the brain did not make is a hold — it never resumes it`, heldBy)
    if (dead) return archive(` (paused${last ? ` by ${changerWords(last)} on ${day(last.at)}` : ', with no pause on record'})`)
    return nothing('hold', `paused${last ? ` by ${changerWords(last)} on ${day(last.at)}` : ' outside any record Nexus keeps (Amazon, or before Nexus)'}: the brain never resumes a pause it did not make`)
  }
  if (f.status !== 'ENABLED') return nothing('skip', `status ${f.status}: nothing to decide`)
  if (heldBy) return nothing('hold', `${heldBy}: the brain does not pause it meanwhile`, heldBy)

  if (horizon.kind === 'long' || horizon.kind === 'open') {
    const since = f.stopSince ?? now
    if (horizon.kind === 'open' && hoursBetween(since, now) < OPEN_SETTLE_HOURS) {
      return nothing('keep', `${horizonWords(horizon)}: first seen ${day(since)} — an open-ended stop pauses once it has held ${OPEN_SETTLE_HOURS} h; until then ${LOW_BIDS}`)
    }
    if (missed?.to === 'PAUSED') return nothing('keep', `${horizonWords(horizon)}, but ${missWords(missed)}; meanwhile ${LOW_BIDS}`)
    if (last?.by === 'brain' && last.to === 'ENABLED' && hoursBetween(last.at, now) < MIN_SERVING_HOURS) {
      return nothing('keep', `${horizonWords(horizon)}, but the brain resumed it ${Math.floor(hoursBetween(last.at, now))} h ago: it pauses again only after ${MIN_SERVING_HOURS} h serving (no flip-flop); meanwhile ${LOW_BIDS}`)
    }
    const endsAt = horizon.kind === 'long' ? horizon.endsAt.toISOString() : null
    return {
      wouldDo: 'pause', cause: horizon.cause.cause, horizon, to: 'PAUSED', hold: null, brainPause: false,
      memory: { pausedAt: now.toISOString(), via: 'auto', approvalId: null, statusBefore: 'ENABLED', causes: f.causes.map((c) => c.cause), expectedEndAt: endsAt, stop: f.stopMemory },
      why: `${horizonWords(horizon)}: a stop of ${horizon.kind === 'open' ? 'no known end' : `${plural(f.pauseMinDays, 'day')} or more`} is a pause (D4); it resumes when the stop ends, and the stop's memory (${stopMemoryWords(f.stopMemory)}) stays as it is`,
    }
  }
  if (horizon.kind === 'short' || horizon.kind === 'soon') {
    return nothing('keep', `a short stop — ${horizonWords(horizon)}: ${LOW_BIDS} — never a pause`)
  }
  if (dead) return archive(' while enabled')
  return nothing('keep', 'serving: no stop holds it')
}

const ACTS: ReadonlySet<string> = new Set(['pause', 'resume', 'archive'])

/** The state brain's decision for one campaign at its level. Pure. */
export function decideState(f: StateFacts, ctx: StateContext): StateDecision {
  const now = ctx.now
  const core = coreStateDecision(f, now)
  const h = core.horizon
  const level = f.lever.effective
  const base: StateDecision = {
    campaignId: f.campaignId, name: f.name, productId: f.productId, market: f.market, level, status: f.status,
    action: core.wouldDo, wouldDo: core.wouldDo, mode: 'SHADOW', outcome: 'none', cause: core.cause,
    causes: f.causes.map((c) => ({ cause: c.cause, endsAt: c.endsAt?.toISOString() ?? null, source: c.source, words: c.words })),
    expectedEndAt: h.kind === 'short' || h.kind === 'long' ? h.endsAt.toISOString() : null,
    horizonHours: h.kind === 'short' || h.kind === 'long' ? Math.round(h.hours) : null,
    stopSince: f.causes.length ? (f.stopSince ?? now).toISOString() : null,
    to: core.to, memory: core.brainPause ? core.memory : null, startsMemory: core.wouldDo === 'pause' ? core.memory : null,
    ...(core.liftsAutomationPause ? { liftsAutomationPause: true } : {}),
    approvalId: null, hold: core.hold, attention: null, why: core.why,
  }
  const acts = ACTS.has(core.wouldDo)
  const watching = level === 'OBSERVE' || level === 'PROPOSE' || level === 'AUTO'
  // A pause the brain made holds, but its lever no longer lets it give it back: a person should know.
  if (core.brainPause && level !== 'PROPOSE' && level !== 'AUTO') {
    base.attention = `the brain paused it on ${day(core.memory!.pausedAt)}${core.memory!.via === 'request' ? ' (a request a person approved)' : ''} and its state lever is ${level} now: the brain will not resume it — enable-ads, or the lever back to PROPOSE or AUTO, does`
  }
  if (!watching) {
    if (level === 'LOCKED') return { ...base, action: 'hold', outcome: 'held', why: `${f.lever.why}${acts ? ` — the brain would ${core.wouldDo} it: ${core.why}` : ''}` }
    return { ...base, action: 'skip', outcome: 'none', why: f.lever.why }
  }
  if (!acts) return base
  // The level decides how it acts. An archive is a request at PROPOSE and at AUTO alike: never alone. AUTO writes only
  // under the live ceiling (the gate judges the brain's writes only there); otherwise it watches.
  const asks = level === 'PROPOSE' || (level === 'AUTO' && core.wouldDo === 'archive')
  const mode: StateMode = asks ? 'PROPOSE' : level === 'AUTO' && ctx.ceilingLive ? 'LIVE' : 'SHADOW'
  // A pause asked for becomes the brain's once a person approves it: its memory says so.
  const decided: StateDecision = { ...base, mode, ...(asks && base.startsMemory ? { startsMemory: { ...base.startsMemory, via: 'request' as const } } : {}) }
  const counted = !(mode === 'SHADOW' && f.shadowPaused)
  if (core.wouldDo === 'pause' && counted && (mode === 'SHADOW' ? ctx.pausesLeft.shadow : ctx.pausesLeft.acting) <= 0) {
    return { ...decided, outcome: 'capped', why: `${core.why} — but ${MAX_PAUSES_PER_MARKET_DAY} pauses a day is the most in ${f.market} (design §5): it waits for the next UTC day` }
  }
  if (mode === 'SHADOW') {
    const note = level === 'AUTO' ? 'AUTO, but the brain\'s server switch (NEXUS_BID_BRAIN_MODE) is not live: SHADOW' : 'SHADOW (OBSERVE)'
    return { ...decided, outcome: 'shadow', why: `${note} — would ${core.wouldDo}: ${core.why}` }
  }
  if (asks) {
    const action = core.wouldDo as 'pause' | 'resume' | 'archive'
    const a = f.asked?.action === action ? f.asked : null
    if (a?.state === 'waiting') return { ...decided, outcome: 'waiting', approvalId: a.approvalId, why: `a request to ${action} it waits for a person (${a.approvalId}) — ${core.why}` }
    if (a?.state === 'declined' && hoursBetween(a.at, now) < DECLINE_DAYS[action] * 24) {
      return { ...decided, outcome: 'held', approvalId: a.approvalId, why: `a person declined the request to ${action} it on ${day(a.at)}: asked again after ${plural(DECLINE_DAYS[action], 'day')} — ${core.why}` }
    }
    const lift = core.liftsAutomationPause ? ' (the brain paused it alone: its own resume, a person\'s normal approval lifts it)' : ''
    return { ...decided, outcome: 'ask', why: `${level === 'AUTO' ? 'AUTO, but an archive is only ever a proposal' : 'PROPOSE'}: asks a person to ${action} it${lift} — ${core.why}` }
  }
  if (ctx.posture.posture !== 'auto') return { ...decided, outcome: 'held', why: `AUTO, but the account's ads automation is not running (${ctx.posture.why}): nothing written now — would ${core.wouldDo}: ${core.why}` }
  return { ...decided, outcome: 'write', why: `AUTO: ${core.wouldDo === 'pause' ? 'paused' : 'resumed'} by the brain — ${core.why}` }
}

/**
 * What makes two decisions the same for the log: a rerun on unchanged facts writes no row. A refusal counts once a UTC day
 * (`refusedOn`): the brain tries a refused write or request again at most once a day, and logs each try.
 */
export function stateDecisionHash(d: Pick<StateDecision, 'action' | 'level' | 'status' | 'cause' | 'expectedEndAt' | 'approvalId' | 'hold' | 'attention'> & { outcome: string; refusedOn?: string | null }): string {
  return createHash('sha256').update(JSON.stringify([d.action, d.outcome, d.level, d.status, d.cause, d.expectedEndAt ? day(d.expectedEndAt) : null, d.approvalId, d.hold, d.attention, d.refusedOn ?? null])).digest('base64url').slice(0, 22)
}

/** Whether a decision is worth a row: it changed, or it is the UTC day's first for a pause or a request the brain carries. */
export function stateRowKind(hash: string, carries: boolean, prev: { decisionHash: string; createdAt: Date } | undefined, now: Date): 'change' | 'snapshot' | null {
  if (!prev || prev.decisionHash !== hash) return 'change'
  return carries && day(prev.createdAt) !== day(now) ? 'snapshot' : null
}
