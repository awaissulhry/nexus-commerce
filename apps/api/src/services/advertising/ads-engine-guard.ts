/**
 * Group 1 (1c) — an ads engine's own brakes, read once per run: the account dial and its write caps.
 *
 * Review 2.3: only the rule evaluator and auto-bid read the dial; rank-defend and classic dayparting went on writing
 * under SUGGEST. Review 2.5: rank-defend had no cap per run or per day (9,256 Amazon writes in 7 days, 514 in one run).
 *
 * POSTURE (from the account automation state; anything unreadable is `stopped` — fail closed):
 *   auto     writes, inside the caps.
 *   suggest  computes and writes nothing new; the run summary says "would-apply=N". It may still give back its OWN
 *            state — restore the floors it set, revert its own deltas (Owner decision S2).
 *   stopped  (halt, dial OFF, kill switch) only bid floors may be queued. Restores, raises and placement moves WAIT —
 *            they are not attempted at all (Owner decision S1). This matters: the gate lets a floor pass a halt
 *            (2.2), but `restoreCampaignBids` moves Nexus's own bids and clears its memory BEFORE the gate refuses
 *            the write, which would leave Amazon at 2¢ while Nexus shows the old bid. Not calling it keeps
 *            `bidsSuppressedAt` set, so the first run after Resume restores.
 *
 * CAPS (`engineCaps(key)`, ads-engine-actors.ts): per run = one `*Once` call, counted in memory; per day = this
 * engine's action-log rows since 00:00 UTC, read once per run. Enforced HERE, inside the engine, before it queues —
 * not at the write gate, where a refusal comes after Nexus changed its own copy. A campaign is never split: the
 * engine asks once, before a campaign's first write, and a campaign that starts finishes, so a run overshoots by at
 * most one campaign and every campaign ends fully floored or fully normal. Give-backs are never refused by a cap,
 * only counted. A deferred campaign is simply decided again next run.
 *
 * ADS AUTONOMY W1-6 — CAPS PER MARKET: the Owner's "most actions per run" for a market (the ads strategy's market row,
 * `maxActionsPerRun`) narrows the engine's own cap inside that market. Read once per run with the rest; an engine that
 * names a campaign's market (`permit({ market })`) counts that campaign's changes against it, by the same rule (asked
 * once before a campaign's first write, never split, give-backs never refused). A strategy that cannot be read is
 * unknown, not "no cap": nothing new is written that run, as for an uncounted day.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { NON_CHANGE_ACTION_TYPES, engineActorWhere, engineCaps, type EngineKey } from './ads-engine-actors.js'
import { marketActionCaps, strategySourceWords } from './ads-strategy/effective.js'

export type EnginePosture = 'auto' | 'suggest' | 'stopped'

/** What one campaign may do this run, decided once before its first write. */
export interface CampaignPermit {
  /** New changes that are not floors: placement moves, raises, base-bid directives, bid multipliers. */
  forward: boolean
  /** Bid floors (Min bid, a closed window): the one new change allowed while stopped. */
  floor: boolean
  /** Give-backs: restoring its own floors, reverting its own deltas. Never refused by a cap. */
  restore: boolean
  /** True when the cap, not the dial, is what holds back `forward` / `floor`. */
  capped: boolean
  /** W1-6 — the campaign's market, when the engine named it: its changes count against that market's own cap. */
  market?: string
  /** W1-6 — the market's own cap (not the engine's) is what holds it back. */
  marketCapped?: boolean
}

/** The kinds of change a campaign wanted and did not make this run. */
export interface HeldBack { forward: boolean; floor: boolean; restore: boolean }
export type ChangeKind = keyof HeldBack
export const nothingHeld = (): HeldBack => ({ forward: false, floor: false, restore: false })

/** A dry run's permit: nothing is written and nothing counts as held back. */
export const DRY_RUN: CampaignPermit = Object.freeze({ forward: false, floor: false, restore: false, capped: false })

/**
 * May this kind of change be written? When it may not on a real run, it is noted as held back. On a dry run it is
 * neither written nor noted.
 */
export function allowChange(write: boolean, permit: CampaignPermit, held: HeldBack, kind: ChangeKind): boolean {
  if (!write) return false
  if (permit[kind]) return true
  held[kind] = true
  return false
}

/** W1-6 — a market's own cap on an engine's changes per run, and where it comes from ("ads strategy: … v3"). */
export interface MarketActionCap { perRun: number; source: string }

export interface EngineGuardReport {
  engine: EngineKey
  posture: EnginePosture
  /** Why the posture is what it is, in words ("halted: …", "the account ads dial is SUGGEST"). */
  why: string
  caps: { perRun: number | null; perDay: number | null }
  /**
   * W1-6 — each market with its own cap: the cap, its source, the changes this run made there and the campaigns it
   * moved to the next run. Null: the caps could not be read, so nothing new was written this run.
   */
  marketCaps?: Array<{ market: string; perRun: number; source: string; changes: number; deferred: number }> | null
  /** This engine's changes today (UTC) before this run; null when they could not be counted. */
  todayBefore: number | null
  /** Changes this run made (give-backs included). */
  changes: number
  /** suggest: campaigns with a change it would have made. */
  wouldApply: number
  /** stopped: campaigns with a restore, raise or placement move waiting for Resume. */
  waiting: number
  /** Campaigns whose new changes the cap moved to the next run. */
  deferredByCap: number
}

export interface EngineGuard {
  readonly posture: EnginePosture
  /** Ask once per campaign, before its first write. `market`: the campaign's, so that market's own cap applies (W1-6). */
  permit(opts?: { market?: string | null }): CampaignPermit
  /** After the campaign: what it wrote and what it held back. */
  settle(permit: CampaignPermit, changes: number, held: HeldBack): void
  report(): EngineGuardReport
}

/** The posture an engine runs under now. Never throws; anything it cannot read is `stopped`. */
export async function readEnginePosture(): Promise<{ posture: EnginePosture; why: string }> {
  try {
    const s = await getAutomationState()
    if (s.degraded) return { posture: 'stopped', why: 'the ads automation state could not be read' }
    if (process.env.NEXUS_ADS_AUTOMATION_KILL === '1') return { posture: 'stopped', why: 'NEXUS_ADS_AUTOMATION_KILL is set' }
    if (s.halted) return { posture: 'stopped', why: `halted: ${s.haltReason ?? 'no reason given'}` }
    if (s.autonomy === 'OFF') return { posture: 'stopped', why: 'the account ads dial is OFF' }
    if (s.autonomy === 'SUGGEST') return { posture: 'suggest', why: 'the account ads dial is SUGGEST' }
    if (s.autonomy === 'AUTO') return { posture: 'auto', why: 'the account ads dial is AUTO' }
    return { posture: 'stopped', why: `the account ads dial reads "${String(s.autonomy)}"` }
  } catch (err) {
    logger.error('[ads-engine-guard] posture read failed — this run only floors bids', { error: String(err) })
    return { posture: 'stopped', why: 'the ads automation state could not be read' }
  }
}

/** This engine's changes since 00:00 UTC (the breaker's rule: action-log rows, records of non-changes left out). */
async function changesToday(engine: EngineKey, now: Date): Promise<number | null> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  try {
    return await prisma.advertisingActionLog.count({
      where: { ...engineActorWhere(engine), createdAt: { gte: since }, actionType: { notIn: [...NON_CHANGE_ACTION_TYPES] } },
    })
  } catch (err) {
    // Unknown is not zero: with no count, the daily cap cannot be honoured, so nothing new is written this run.
    logger.warn('[ads-engine-guard] could not count today\'s changes — no new changes this run', { engine, error: String(err) })
    return null
  }
}

/** Pure: a guard over a known posture, caps and day count. */
export function makeEngineGuard(input: {
  engine: EngineKey; posture: EnginePosture; why: string
  caps: { perTick: number | null; perDay: number | null }
  /** null = could not be counted: no room for new changes this run. */
  todayBefore: number | null
  /** W1-6 — each market's own cap per run (absent: none). null = could not be read: no room for new changes this run. */
  marketCaps?: ReadonlyMap<string, MarketActionCap> | null
}): EngineGuard {
  const { engine, posture, why, caps, todayBefore } = input
  const marketCaps = input.marketCaps === undefined ? new Map<string, MarketActionCap>() : input.marketCaps
  let changes = 0, wouldApply = 0, waiting = 0, deferredByCap = 0
  const inMarket = new Map<string, { changes: number; deferred: number }>()
  const hasRoom = (): boolean => {
    if (caps.perDay != null && todayBefore == null) return false
    if (caps.perTick != null && changes >= caps.perTick) return false
    if (caps.perDay != null && (todayBefore ?? 0) + changes >= caps.perDay) return false
    return true
  }
  /** The market's own cap leaves room (no cap: room). Unread caps leave none, in every market. */
  const marketHasRoom = (market: string | undefined): boolean => {
    if (marketCaps === null) return false
    const cap = market ? marketCaps.get(market) : undefined
    return !cap || (inMarket.get(market!)?.changes ?? 0) < cap.perRun
  }
  return {
    posture,
    permit(opts = {}): CampaignPermit {
      const market = opts.market ? opts.market.trim().toUpperCase() || undefined : undefined
      const engineRoom = hasRoom()
      const marketRoom = marketHasRoom(market)
      const room = engineRoom && marketRoom
      const where = { ...(market ? { market } : {}), ...(engineRoom && !marketRoom ? { marketCapped: true } : {}) }
      if (posture === 'auto') return { forward: room, floor: room, restore: true, capped: !room, ...where }
      if (posture === 'suggest') return { forward: false, floor: false, restore: true, capped: false, ...(market ? { market } : {}) }
      return { forward: false, floor: room, restore: false, capped: !room, ...where }
    },
    settle(permit, n, held) {
      changes += Math.max(0, n)
      const mine = permit.market ? inMarket.get(permit.market) ?? { changes: 0, deferred: 0 } : null
      if (mine) { mine.changes += Math.max(0, n); inMarket.set(permit.market!, mine) }
      const deferred = () => { deferredByCap++; if (mine && permit.marketCapped) mine.deferred++ }
      if (posture === 'suggest') { if (held.forward || held.floor) wouldApply++; return }
      if (posture === 'stopped') {
        if (held.forward || held.restore) waiting++
        else if (held.floor && permit.capped) deferred()
        return
      }
      if ((held.forward || held.floor) && permit.capped) deferred()
    },
    report: () => ({
      engine, posture, why, caps: { perRun: caps.perTick, perDay: caps.perDay },
      marketCaps: marketCaps === null ? null : [...marketCaps].sort(([a], [b]) => (a < b ? -1 : 1)).map(([market, cap]) => ({
        market, perRun: cap.perRun, source: cap.source, changes: inMarket.get(market)?.changes ?? 0, deferred: inMarket.get(market)?.deferred ?? 0,
      })),
      todayBefore, changes, wouldApply, waiting, deferredByCap,
    }),
  }
}

/** W1-6 — every market's own cap per run (the ads strategy's market rows), or null when they cannot be read. */
async function readMarketCaps(engine: EngineKey): Promise<Map<string, MarketActionCap> | null> {
  try {
    const caps = await marketActionCaps()
    return new Map([...caps].map(([market, cap]) => [market, { perRun: cap.perRun, source: strategySourceWords(cap.source) }]))
  } catch (err) {
    // Unknown is not "no cap": the Owner may have capped a market, so nothing new is written this run.
    logger.warn('[ads-engine-guard] could not read the ads strategy\'s caps per market — no new changes this run', { engine, error: String(err) })
    return null
  }
}

/** Open a run's guard: read the posture, today's count and each market's own cap once. */
export async function openEngineGuard(engine: EngineKey, opts: { now?: Date } = {}): Promise<EngineGuard> {
  const { posture, why } = await readEnginePosture()
  const caps = engineCaps(engine)
  const [todayBefore, marketCaps] = await Promise.all([
    caps.perDay == null ? Promise.resolve(0) : changesToday(engine, opts.now ?? new Date()),
    readMarketCaps(engine),
  ])
  return makeEngineGuard({ engine, posture, why, caps, todayBefore, marketCaps })
}

const num = (n: number) => n.toLocaleString('en-GB')

/** The caps in words: "at most 600 changes a run and 3,000 a day". */
export function engineCapsText(engine: EngineKey): string {
  const { perTick, perDay } = engineCaps(engine)
  const parts = [perTick != null ? `${num(perTick)} changes a run` : null, perDay != null ? `${num(perDay)} a day` : null].filter(Boolean)
  return parts.length ? `at most ${parts.join(' and ')}` : 'no cap of its own'
}

/** 1d — what an engine still does under SUGGEST and while stopped, in its run summary. */
export interface EngineGuardWords { suggest: string; stopped: string }
const FLOOR_ENGINE_WORDS: EngineGuardWords = {
  suggest: 'nothing new is written; its own floors are still given back',
  stopped: 'only bid floors land; restores, raises and placement moves wait for Resume',
}

/**
 * What the run summary adds, in words. Empty for a normal AUTO run, so an ordinary day's summary is unchanged.
 * `words` (1d): an engine that is not a floors-and-restores engine says what it does instead.
 */
export function engineGuardNote(r: EngineGuardReport | null | undefined, words: EngineGuardWords = FLOOR_ENGINE_WORDS): string {
  if (!r) return ''
  const caps = `cap ${r.caps.perRun != null ? `${num(r.caps.perRun)} a run` : 'none a run'}, ${r.caps.perDay != null ? `${num(r.caps.perDay)} a day` : 'none a day'}`
  const uncounted = r.todayBefore == null && r.caps.perDay != null ? " — today's changes could not be counted, so nothing new was written" : ''
  // W1-6 — a market's own cap, named with its source, when it held something back (or could not be read).
  const unread = r.marketCaps === null ? " — the ads strategy's caps per market could not be read, so nothing new was written" : ''
  const byMarket = (r.marketCaps ?? []).filter((m) => m.deferred).map((m) => `${m.market} at most ${num(m.perRun)} a run (${m.source}), ${num(m.changes)} this run`)
  const markets = byMarket.length ? `; market caps: ${byMarket.join('; ')}` : ''
  const deferred = r.deferredByCap ? ` deferred-by-cap=${r.deferredByCap} (${caps}${markets}; ${num(r.changes)} this run${r.todayBefore != null ? `, ${num(r.todayBefore + r.changes)} today` : ''}${uncounted}${unread}; they go next run)` : ''
  if (r.posture === 'suggest') return ` would-apply=${r.wouldApply} (${r.why}: ${words.suggest})${deferred}`
  if (r.posture === 'stopped') return ` waiting=${r.waiting} (stopped — ${r.why}: ${words.stopped})${deferred}`
  return deferred
}
