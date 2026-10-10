/**
 * Ads brain page A2a — what the brain REALLY does with one lever right now, and why, in words:
 *
 *   acts     it changes Amazon by itself
 *   asks     a person approves each change (the Approvals page)
 *   watches  it decides and logs, and writes and asks nothing (shadow)
 *   off      it does nothing with the lever (not enrolled, excluded, locked at the Owner's value, OFF, or nothing runs it)
 *
 * A level alone does not say it: AUTO on a lever still watches under a shadow server switch, before its shadow days are
 * run, while its N4 approval clock runs, under the Owner's kill switch or a halted account. brainLeverState combines the
 * resolved level (brain/settings.ts) with each of those and with the lever's real writer, one row per lever. The map
 * (read-map.ts), the switchboard and the Control Room's brain rows read it, so they never disagree.
 *
 * Pure: brainLeverState imports nothing but the lever list. What it needs from the server, the account and the database
 * is read by loadLeverRuntime / loadLeverFacts (lazy imports, so this module stays a leaf), and each lever's own gate is
 * decided by the lever's own code (negatives.ts shadowState, bidding-mode.ts asksWhy) and passed in — never copied here.
 *
 * Rows: a lever that takes only OFF and OBSERVE today (adGroupBids, placements, offAmazon) has no PROPOSE or AUTO row; a
 * lever's own PR widens its row when it gets a writer (lane B edits these rows after A2a).
 */
import { BRAIN_LEVERS, LEVER_LEVELS_NOW, type BrainLever, type BrainLevel } from './levers.js'
import type { BrainSettings, OverrideRow } from './settings.js'
import type { BrainKill } from './kill-switch.js'

export type LeverActing = 'acts' | 'asks' | 'watches' | 'off'
export interface LeverState { state: LeverActing; why: string }

/** The resolved level of a lever here (brain/settings.ts LeverSettings.effective). */
export type LeverEffective = BrainLevel | 'LOCKED' | 'EXCLUDED' | 'NOT_ENROLLED'

/** The account's ads automation as the engines read it (ads-engine-guard.ts readEnginePosture). */
export interface LeverPosture { posture: 'auto' | 'suggest' | 'stopped'; why: string }

/** What the server and the account say, read once per request (loadLeverRuntime). */
export interface LeverRuntime {
  /** NEXUS_BID_BRAIN_MODE as the bid brain reads it: off | shadow | live. */
  ceiling: string
  /** The brain's server switch is live: its writers may write and ask. */
  ceilingLive: boolean
  /** The harvest's own ceiling (harvest-load.ts harvestCeiling: NEXUS_BID_BRAIN_MODE and NEXUS_ADS_BRAIN_HARVEST_MODE live). */
  harvest: { live: boolean; why: string }
  /** The structure's own ceiling (structure-load.ts structureCeiling: NEXUS_BID_BRAIN_MODE and NEXUS_ADS_BRAIN_STRUCTURE_MODE live). */
  structure: { live: boolean; why: string }
  /** NEXUS_ADS_BRAIN_CYCLE is on: the product cycle runs every enrolled product (the bidding strategy runs only there). */
  cycleOn: boolean
  /** NEXUS_ADS_BRAIN_HOURS is not 0: the hours cron researches and paints. */
  hoursOn: boolean
  /** The account's ads automation: halted, OFF or SUGGEST holds the writers that read it. */
  posture: LeverPosture
}

/** One lever of one product (or of one of its campaigns), with the gates its own code decided. */
export interface LeverFacts {
  lever: BrainLever
  effective: LeverEffective
  /** The Owner's kill switch on this lever here, in words (kill-switch.ts killWords); null or absent: none. */
  killed?: string | null
  /** negatives: its shadow gate as the negatives module decides it (negatives.ts shadowState); absent: not measured. */
  negativesShadow?: { inShadow: boolean; why: string | null } | null
  /** biddingStrategy at AUTO: N4 as bidding-mode.ts asksWhy decides it — why a switch still asks a person; null: it may switch alone; absent: not measured. */
  strategyAsks?: { why: string } | null
}

const acts = (why: string): LeverState => ({ state: 'acts', why })
const asks = (why: string): LeverState => ({ state: 'asks', why })
const watches = (why: string): LeverState => ({ state: 'watches', why })
const off = (why: string): LeverState => ({ state: 'off', why })

/** An AUTO writer that reads the account's posture (the bid brain, the money, state and bidding-strategy writers) holds unless it is auto. */
const postureHolds = (rt: LeverRuntime): string | null => (rt.posture.posture === 'auto' ? null : `the account's ads automation is not running (${rt.posture.why})`)
/** A halted or OFF account: the write gate refuses every automatic write but a lowering, whoever reads the posture. */
const gateHolds = (rt: LeverRuntime): string | null => (rt.posture.posture === 'stopped' ? `the account's ads automation is stopped (${rt.posture.why}): the write gate refuses the brain's writes` : null)
const shadowSwitch = (rt: LeverRuntime) => `NEXUS_BID_BRAIN_MODE is ${rt.ceiling}`

type Row = (level: 'PROPOSE' | 'AUTO', f: LeverFacts, rt: LeverRuntime) => LeverState

/** A lever with no writer of the brain at PROPOSE or AUTO yet (its levels stop at OBSERVE). */
const noWriter: Row = (level, f) => watches(`${level}, but the ${f.lever} lever has no writer of the brain yet: ${LEVER_LEVELS_NOW[f.lever].others}`)

/** The money writer (AB-8): budgets and portfolio caps, under the live switch, holding while the account is not running. */
const money: Row = (level, _f, rt) => {
  if (!rt.ceilingLive) return watches(`${level}, but ${shadowSwitch(rt)}: the brain plans it in shadow`)
  if (level === 'PROPOSE') return asks('PROPOSE: the brain asks a person for each change in the Approvals page (AB-8)')
  const held = postureHolds(rt)
  return held ? watches(`AUTO, but ${held}: the money writer holds every change`) : acts('AUTO: the brain\'s money writer sets it inside the pace (AB-8)')
}

const ROWS: Record<BrainLever, Row> = {
  bids: (level, f, rt) => {
    if (level !== 'AUTO') return noWriter(level, f, rt)
    if (!rt.ceilingLive) return watches(`AUTO, but ${shadowSwitch(rt)}: the bid brain decides in shadow`)
    const held = postureHolds(rt)
    return held ? watches(`AUTO, but ${held}: the bid brain holds every write`) : acts('AUTO: the bid brain writes the keyword bids of the campaigns enrolled LIVE (set-bid-brain-enrollment)')
  },
  adGroupBids: noWriter,
  // AB-13 — a painted plan always asks (D3): PROPOSE is the top level. Its own cron, or the product cycle, paints it.
  hours: (level, f, rt) => {
    if (!rt.hoursOn && !rt.cycleOn) return off(`${level}, but NEXUS_ADS_BRAIN_HOURS=0 stops the hours research and the product cycle is off (NEXUS_ADS_BRAIN_CYCLE): nothing paints the plan`)
    return level === 'PROPOSE' ? asks(`PROPOSE: ${LEVER_LEVELS_NOW.hours.others}`) : noWriter(level, f, rt)
  },
  placements: noWriter,
  // AB-12 — PROPOSE asks whatever the switch; AUTO pauses and resumes alone under the live switch and a running account.
  state: (level, _f, rt) => {
    if (level === 'PROPOSE') return asks(`PROPOSE: ${LEVER_LEVELS_NOW.state.others}`)
    if (!rt.ceilingLive) return watches(`AUTO, but ${shadowSwitch(rt)}: the brain decides its pauses in shadow`)
    const held = postureHolds(rt)
    return held ? watches(`AUTO, but ${held}: the state writer holds every pause and resume`) : acts('AUTO: the brain pauses a campaign for a stop of 3 days or more and resumes it when the stop ends, alone inside the caps (AB-12); it never archives')
  },
  budgets: money,
  portfolioCap: money,
  // AB-10 — the negatives module's own gate: the live switch and its shadow days (negativesShadowDays) first.
  negatives: (level, f, rt) => {
    if (f.negativesShadow === undefined) return watches(`${level}, but could not measure the negatives lever's shadow days: counted as still in shadow`)
    if (f.negativesShadow?.inShadow) return watches(`${level}, but in shadow for now: ${f.negativesShadow.why}`)
    if (level === 'PROPOSE') return asks('PROPOSE: the brain asks a person once a day for the day\'s negatives in one change plan (AB-10)')
    const held = gateHolds(rt)
    return held ? watches(`AUTO, but ${held}`) : acts('AUTO: the brain writes the day\'s negatives alone through the one negative write service, inside the caps (AB-10)')
  },
  // AB-11 — the harvest's own ceiling: under it every level only logs.
  harvest: (level, _f, rt) => {
    if (!rt.harvest.live) return watches(`${level}, but ${rt.harvest.why}: the harvest run logs each harvest in shadow, and writes and asks nothing`)
    if (level === 'PROPOSE') return asks('PROPOSE: the brain asks a person for each harvest — the keyword and its source negatives as one change set (AB-11)')
    const held = gateHolds(rt)
    return held ? watches(`AUTO, but ${held}`) : acts('AUTO: the brain writes each harvest — the keyword and its source negatives as one change set (AB-11); a new campaign is always a request a person approves')
  },
  // AB-16 — never AUTO; PROPOSE asks only under the structure's own ceiling.
  structure: (level, f, rt) => {
    if (level !== 'PROPOSE') return noWriter(level, f, rt)
    return rt.structure.live ? asks(`PROPOSE: ${LEVER_LEVELS_NOW.structure.others}`) : watches(`PROPOSE, but ${rt.structure.why}: each proposal is logged in shadow, nothing asked`)
  },
  // AB-17 — decided only in the product cycle; N4 asks first at AUTO; then the live switch and a running account.
  biddingStrategy: (level, f, rt) => {
    if (!rt.cycleOn) return off(`${level}, but the bidding-strategy lever runs only in the product cycle and NEXUS_ADS_BRAIN_CYCLE is off: nothing decides it`)
    if (level === 'PROPOSE') return asks('PROPOSE: every bidding-strategy switch asks a person (AB-17)')
    if (f.strategyAsks === undefined) return asks('AUTO, but could not measure the N4 approval clock: counted as asking a person for each switch')
    if (f.strategyAsks) return asks(f.strategyAsks.why)
    if (!rt.ceilingLive) return watches(`AUTO, but ${shadowSwitch(rt)}: it logs each switch in shadow`)
    const held = postureHolds(rt)
    return held ? watches(`AUTO, but ${held}: no switch is written now`) : acts('AUTO: the brain switches each campaign\'s Amazon bidding strategy alone — at most one switch per 14 days, each one tested and kept or switched back (AB-17)')
  },
  offAmazon: noWriter,
}

/** What the brain does with one lever here now, and why. Pure. */
export function brainLeverState(f: LeverFacts, rt: LeverRuntime): LeverState {
  switch (f.effective) {
    case 'NOT_ENROLLED': return off('the product is not enrolled in the brain: today\'s engines run it')
    case 'EXCLUDED': return off('excluded from the brain by the Owner: today\'s engines run it')
    case 'LOCKED': return off('locked at the Owner\'s own value: the brain writes nothing and only recommends')
    case 'OFF': return off('OFF: the brain leaves the lever to today\'s engines')
    case 'OBSERVE': return watches(`OBSERVE: ${LEVER_LEVELS_NOW[f.lever].others}`)
    default:
      if (f.killed) return watches(`${f.effective}, but ${f.killed}: the brain decides and logs, and writes and asks nothing`)
      return ROWS[f.lever](f.effective, f, rt)
  }
}

// ── Loads (the request's business) ──────────────────────────────────────────────────────────────────────────────

/** The server switches and the account's posture, read now, each by its own reader. */
export async function loadLeverRuntime(): Promise<LeverRuntime> {
  const [{ bidBrainMode }, { brainLiveCeiling }, { harvestCeiling }, { structureCeiling }, { cycleOn }, { brainHoursEnabled }, { readEnginePosture }] = await Promise.all([
    import('../bid-brain/shadow.js'), import('../bid-brain/live.js'), import('./harvest-load.js'), import('./structure-load.js'), import('./cycle-switch.js'),
    import('../../../jobs/ads-brain-hours.job.js'), import('../ads-engine-guard.js'),
  ])
  return {
    ceiling: bidBrainMode(),
    ceilingLive: brainLiveCeiling(),
    harvest: harvestCeiling(),
    structure: structureCeiling(),
    cycleOn: cycleOn(),
    hoursOn: brainHoursEnabled(),
    posture: await readEnginePosture(),
  }
}

/** The per-product facts the levers' own gates read: the enrollment's start, the negatives lever's level history, the N4 clock. */
export interface ProductLeverFacts {
  enrolledAt: Date | null
  /** The product's negatives LEVEL overrides, open and ended (negatives.ts shadowSinceOf reads them). */
  negativesLevels: Array<{ value: unknown; createdAt: Date; endedAt: Date | null }>
  /** The N4 clock of the bidding-strategy lever (AdsBrainLeverClock), null: not started. */
  strategyClockSince: Date | null
}

const productKey = (productId: string, market: string) => `${productId}\u0000${market}`

/** ProductLeverFacts for these products × markets (family roots, short market codes), in three reads. */
export async function loadLeverFacts(products: ReadonlyArray<{ productId: string; market: string }>): Promise<Map<string, ProductLeverFacts>> {
  const out = new Map<string, ProductLeverFacts>()
  if (!products.length) return out
  const { default: prisma } = await import('../../../db.js')
  const ids = [...new Set(products.map((p) => p.productId))]
  const [enrollments, levels, clocks] = await Promise.all([
    prisma.adsBrainEnrollment.findMany({ where: { productId: { in: ids } }, select: { productId: true, marketplace: true, createdAt: true } }),
    prisma.adsBrainOverride.findMany({ where: { scope: 'PRODUCT', kind: 'LEVEL', key: 'negatives', productId: { in: ids } }, select: { productId: true, marketplace: true, value: true, createdAt: true, endedAt: true } }),
    prisma.adsBrainLeverClock.findMany({ where: { lever: 'biddingStrategy', productId: { in: ids } }, select: { productId: true, marketplace: true, since: true } }),
  ])
  for (const p of products) {
    const k = productKey(p.productId, p.market)
    out.set(k, {
      enrolledAt: enrollments.find((e) => e.productId === p.productId && e.marketplace === p.market)?.createdAt ?? null,
      negativesLevels: levels.filter((l) => l.productId === p.productId && l.marketplace === p.market).map((l) => ({ value: l.value, createdAt: l.createdAt, endedAt: l.endedAt })),
      strategyClockSince: clocks.find((c) => c.productId === p.productId && c.marketplace === p.market)?.since ?? null,
    })
  }
  return out
}

/** The facts of one product × market from loadLeverFacts (none loaded: nothing known). */
export function leverFactsOf(facts: ReadonlyMap<string, ProductLeverFacts>, productId: string, market: string): ProductLeverFacts {
  return facts.get(productKey(productId, market)) ?? { enrolledAt: null, negativesLevels: [], strategyClockSince: null }
}

// ── The levers' own gates and every lever of a product (wave 2: shared by the map, the switchboard, the engine board) ──

/** The negatives' shadow gate and N4 of one product (or one of its campaigns), each decided by its lever's own code. */
export interface LeverGates {
  negativesShadow: { inShadow: boolean; why: string | null }
  strategyAsks: { why: string } | null
}

export type GateDecider = (facts: ProductLeverFacts, settings: Pick<BrainSettings, 'levers' | 'values'>, ceilingLive: boolean, now: Date) => LeverGates

/**
 * The levers' own gate deciders — negatives.ts shadowState / shadowSinceOf and bidding-mode.ts asksWhy — imported lazily
 * (they pull in the database layer; this module stays a leaf). Never a copy of their rules.
 */
export async function loadGateDecider(): Promise<GateDecider> {
  const [{ shadowState, shadowSinceOf }, { asksWhy }] = await Promise.all([import('./negatives.js'), import('./bidding-mode.js')])
  return (facts, settings, ceilingLive, now) => {
    const strategy = settings.levers.biddingStrategy
    return {
      negativesShadow: shadowState({ ceilingLive, shadowSince: shadowSinceOf(facts.enrolledAt, facts.negativesLevels, now), shadowDays: Number(settings.values.negativesShadowDays.value) }, now),
      strategyAsks: asksWhy({ lever: { effective: strategy.effective, why: strategy.why, lock: null }, switchMode: String(settings.values.strategySwitchMode.value), approvalDays: Number(settings.values.strategyApprovalDays.value), clockSince: facts.strategyClockSince }, now),
    }
  }
}

/** Every lever of one product (product level) now, and why. Pure. */
export function productLeverStates(settings: Pick<BrainSettings, 'levers'>, killed: Partial<Record<BrainLever, string>>, gates: LeverGates, rt: LeverRuntime): Record<BrainLever, LeverState> {
  return Object.fromEntries(BRAIN_LEVERS.map((lever) => [lever, brainLeverState({
    lever, effective: settings.levers[lever].effective, killed: killed[lever] ?? null, negativesShadow: gates.negativesShadow, strategyAsks: gates.strategyAsks,
  }, rt)])) as Record<BrainLever, LeverState>
}

/** One enrolled product × market, product level: its settings, the kills that reach it and every lever's state now. */
export interface ProductLevers {
  productId: string
  market: string
  enrolledAt: Date | null
  settings: BrainSettings
  killed: Partial<Record<BrainLever, BrainKill>>
  states: Record<BrainLever, LeverState>
}

/**
 * The enrolled products of a scope (a market, one product — its family root — or every one), each with every lever's
 * state now; the runtime and the open kills read once. A fixed number of reads, whatever the number of products.
 */
export async function loadProductLevers(scope: { market?: string | null; productId?: string | null } = {}, now: Date = new Date()): Promise<{ runtime: LeverRuntime; kills: BrainKill[]; products: ProductLevers[] }> {
  const [{ default: prisma }, { resolveBrainSettings }, { openKills, killsOfProduct, killWords }, runtime, decide] = await Promise.all([
    import('../../../db.js'), import('./settings.js'), import('./kill-switch.js'), loadLeverRuntime(), loadGateDecider(),
  ])
  const [enrollments, kills] = await Promise.all([
    prisma.adsBrainEnrollment.findMany({
      where: { ...(scope.market ? { marketplace: scope.market } : {}), ...(scope.productId ? { productId: scope.productId } : {}) },
      select: { productId: true, marketplace: true }, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }], take: 200,
    }),
    openKills(),
  ])
  if (!enrollments.length) return { runtime, kills, products: [] }
  const ids = [...new Set(enrollments.map((e) => e.productId))]
  const [overrides, facts] = await Promise.all([
    prisma.adsBrainOverride.findMany({
      where: { endedAt: null, scope: 'PRODUCT', productId: { in: ids } },
      select: { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true },
    }) as Promise<OverrideRow[]>,
    loadLeverFacts(enrollments.map((e) => ({ productId: e.productId, market: e.marketplace }))),
  ])
  const products = enrollments.map((e) => {
    const settings = resolveBrainSettings({ productId: e.productId, market: e.marketplace, enrolled: true, overrides })
    const f = leverFactsOf(facts, e.productId, e.marketplace)
    const killed = killsOfProduct(kills, e.productId, e.marketplace)
    const words = Object.fromEntries(Object.entries(killed).map(([lever, k]) => [lever, killWords(k!)])) as Partial<Record<BrainLever, string>>
    return { productId: e.productId, market: e.marketplace, enrolledAt: f.enrolledAt, settings, killed, states: productLeverStates(settings, words, decide(f, settings, runtime.ceilingLive, now), runtime) }
  })
  return { runtime, kills, products }
}

