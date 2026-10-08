/**
 * ONE BRAIN AB-14 — the product cycle, its order and its report (design 2026-10-08-ads-one-brain/DESIGN.md §4 "the
 * decision loop", §5, §6, §8 row AB-14). Pure: the steps, which step waits for which, the change set id, and the day's
 * product report in words. brain/cycle-steps.ts runs each lever's module for one product; brain/cycle-run.ts claims the
 * day's cycle, runs the steps in this order and stores what happened (AdsBrainCycle).
 *
 *   order       one product × market, once per new settled data day, in the design's order (a higher step fixes the
 *               facts for the lower ones): ① stops and state → ② the term ledger → ③ negatives → ④ harvest (negatives
 *               first: a term is never harvested and negated at once) → structure (AB-16, §4 ③: weekly, the structure
 *               module says when it decides; its requests every day) → ⑤ money: budgets and the portfolio cap (budget
 *               before bid: a bid raise never fights a budget cut) → ⑥ bids (the bid brain on the product's own
 *               campaigns) → ⑦ hours (the painted hourly plan; weekly, the hours module says when it is due) → ⑧ the
 *               bidding strategy (AB-17: new switches on the weekly run, a switchback test's verdict any day).
 *   sees        each step gets what the steps before it decided: a pause the state step makes and a budget the money step
 *               cuts (or its brake) hold the bid raises on those campaigns (`holds` → the bid brain's raise cap); the
 *               negatives are logged before the harvest reads them.
 *   waits       a step runs only when every earlier step it depends on ended (done, off or skipped). It depends on
 *                 · the steps whose output it reads, at any level: negatives and harvest read the term ledger, harvest
 *                   reads the day's negatives (the harvest + negate pair is never half applied: no harvest while the
 *                   negatives step failed);
 *                 · every earlier step that ACTS on the product (its lever at PROPOSE or AUTO): an acting step changes
 *                   what Amazon holds, so a step after it decides on facts that are not known when it failed.
 *               An earlier step in shadow (OBSERVE) or OFF writes nothing at Amazon: its failure is reported and the later
 *               steps still run. A step that waits is `blocked`, with the step it waits for and why.
 *   change set  one per product × market × data day: cyc-<market>-<data day>-<product>. Every write of the cycle carries
 *               it in its evidence (ads-evidence.ts inBrainCycle).
 *   idempotent  a step that ended is never run again on that data day: a rerun writes nothing. A failed or blocked step is
 *               tried again on a later tick (and the steps after it that waited), at most MAX_CYCLE_ATTEMPTS runs a day.
 */
import type { BrainLever } from './levers.js'

export const CYCLE_STEPS = ['state', 'terms', 'negatives', 'harvest', 'structure', 'money', 'bids', 'hours', 'bidding'] as const
export type CycleStep = (typeof CYCLE_STEPS)[number]
export const isCycleStep = (v: unknown): v is CycleStep => typeof v === 'string' && (CYCLE_STEPS as readonly string[]).includes(v)

/** Each step in the Owner's words. */
export const STEP_WORDS: Record<CycleStep, string> = {
  state: 'stops and state',
  terms: 'the term ledger',
  negatives: 'negatives',
  harvest: 'harvest',
  structure: 'structure (new campaigns, splits and portfolio moves)',
  money: 'money (campaign budgets and the portfolio cap)',
  bids: 'bids',
  hours: 'the hourly plan',
  bidding: 'the bidding strategy',
}

/**
 * The levers whose level says whether a step acts (owns the lever: PROPOSE or AUTO). The term ledger never acts. AB-16 —
 * neither does structure here: every build, go-live and move it asks waits for a person, so nothing it does changes what
 * Amazon holds this data day, and its failure never holds the money, bids or hours after it.
 */
export const STEP_LEVERS: Record<CycleStep, readonly BrainLever[]> = {
  state: ['state'], terms: [], negatives: ['negatives'], harvest: ['harvest'], structure: [], money: ['budgets', 'portfolioCap'], bids: ['bids'], hours: ['hours'],
  bidding: ['biddingStrategy'],
}

/** What a step reads from an earlier one: it never runs without it, at any level. */
export const STEP_READS: Record<CycleStep, readonly CycleStep[]> = {
  state: [], terms: [], negatives: ['terms'], harvest: ['terms', 'negatives'], structure: [], money: [], bids: [], hours: [],
  // AB-17 — the pauses the state step makes are stops: the bidding strategy never switches under one.
  bidding: ['state'],
}

/** A data day's cycle runs at most this many times (the first and two retries of what failed). */
export const MAX_CYCLE_ATTEMPTS = 3
/** A run holds its cycle this long (under the hourly cadence); a run that died frees it for the next tick. */
export const CYCLE_LEASE_MS = 50 * 60_000
/** Cycle rows are kept this long (Neon cost). */
export const CYCLE_DAYS_KEPT = 90

/**
 *   done     the module ran for the product (in shadow it decided and logged; acting, it asked or wrote)
 *   off      nothing to run: the lever is OFF, locked or excluded, the module is not in this build, or it is not due
 *   skipped  the module had nothing to decide (no campaign of its own in the market, the bid brain not in this market)
 *   blocked  waits for an earlier step it depends on that did not end (tried again on a later tick)
 *   failed   the module failed for the product (tried again on a later tick)
 */
export type StepStatus = 'done' | 'off' | 'skipped' | 'blocked' | 'failed'
export const ENDED: readonly StepStatus[] = ['done', 'off', 'skipped']
export const stepEnded = (r: Pick<StepRecord, 'status'> | undefined): boolean => !!r && ENDED.includes(r.status)

/** A request a step asked a person for (or still carries), waiting in Nexus's approvals. */
export interface Waiting { what: string; approvalId: string | null }

/** What a step did, for the report. Amounts and sentences naming one stay under `money`. */
export interface StepDid {
  /** Plain words, no amounts. */
  lines: string[]
  counts?: Record<string, number>
  /** The campaigns a step in SHADOW would hold raises on (campaignId → why): a clash when the bids raise there. */
  shadowHolds?: Array<[string, string]>
  clashes?: string[]
  money?: { lines: string[] }
}

/** One step of one cycle, as stored (AdsBrainCycle.steps). */
export interface StepRecord {
  status: StepStatus
  /** One line: what it did, or why it did nothing. No amounts. */
  why: string
  /** Its lever acts on the product (PROPOSE or AUTO): a failure then holds every later step. */
  acts: boolean
  /** The module's own run id (its log rows carry it). */
  runId?: string | null
  /** The raises it holds for the bids: campaignId → why. Only an acting step holds one. */
  holds?: Array<[string, string]>
  did?: StepDid
  waiting?: Waiting[]
  /** The cycle's run it ended (or failed) in. */
  attempt: number
  at: string
}

/** What a step's module hands back: its record without the cycle's own fields. */
export type StepOutcome = Omit<StepRecord, 'acts' | 'attempt' | 'at'>

export type StepRecords = Partial<Record<CycleStep, StepRecord>>

/** Steps as stored (AdsBrainCycle.steps), the well-formed ones only. */
export function readSteps(raw: unknown): StepRecords {
  const out: StepRecords = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const step of CYCLE_STEPS) {
    const r = (raw as Record<string, unknown>)[step] as Partial<StepRecord> | undefined
    if (r && typeof r.status === 'string' && typeof r.why === 'string') out[step] = r as StepRecord
  }
  return out
}

/** The change set of one product's cycle on one data day. */
export const changeSetIdOf = (productId: string, market: string, dataDay: string): string => `cyc-${market}-${dataDay}-${productId}`

/**
 * The earlier step a step waits for, or null when it may run: the first earlier step it reads, or the first earlier step
 * that acts on the product, which has not ended. Pure.
 */
export function waitsFor(step: CycleStep, records: StepRecords, acts: Readonly<Record<CycleStep, boolean>>): { step: CycleStep; why: string } | null {
  for (const earlier of CYCLE_STEPS.slice(0, CYCLE_STEPS.indexOf(step))) {
    const r = records[earlier]
    if (stepEnded(r)) continue
    const state = r ? `${r.status}${r.why ? ` (${r.why})` : ''}` : 'has not run'
    if (STEP_READS[step].includes(earlier)) return { step: earlier, why: `it reads what ${STEP_WORDS[earlier]} decides, and that step ${state}` }
    if (acts[earlier] || r?.acts) return { step: earlier, why: `${STEP_WORDS[earlier]} acts on this product (PROPOSE or AUTO) and ${state}: a higher step fixes the facts for the lower ones` }
  }
  return null
}

/** The steps a run of the cycle still has to try, in order (the ones that did not end). Pure. */
export const stepsToRun = (records: StepRecords): CycleStep[] => CYCLE_STEPS.filter((s) => !stepEnded(records[s]))

/** DONE when every step ended; PARTIAL otherwise. */
export const cycleStatusOf = (records: StepRecords): 'DONE' | 'PARTIAL' => (CYCLE_STEPS.every((s) => stepEnded(records[s])) ? 'DONE' : 'PARTIAL')

/** The raises the earlier steps hold for the bids (campaignId → why, joined when two hold one). Pure. */
export function raiseHoldsFor(records: StepRecords, own: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const step of CYCLE_STEPS.slice(0, CYCLE_STEPS.indexOf('bids'))) {
    for (const [campaignId, why] of records[step]?.holds ?? []) {
      if (!own.has(campaignId)) continue
      const words = `the product cycle's ${STEP_WORDS[step]} step: ${why}`
      out.set(campaignId, out.has(campaignId) ? `${out.get(campaignId)}; ${words}` : words)
    }
  }
  return out
}

// ── The day's product report ─────────────────────────────────────────────────────────────────────────────────────

/** Ad sales in against ad spend out, for the product's own campaigns. Cents; null when no report row exists. */
export interface MoneyInOut {
  currency: string
  day: { spendCents: number; salesCents: number; orders: number } | null
  week: { spendCents: number; salesCents: number; orders: number; days: number } | null
  /** This month, from the money step's plan (null: no plan). */
  month: { spentCents: number; envelopeCents: number | null; projectedCents: number | null; pacePct: number | null; brake: string } | null
}

/** One thing the Owner's choices hold: a lock, an exclusion. */
export interface OwnerHold { lever: string; scope: 'product' | 'campaign'; campaignId: string | null; ref: string; by: string | null; at: string | null; reason: string | null }

export interface ReportInput {
  productId: string
  name: string | null
  market: string
  dataDay: string
  changeSetId: string
  status: 'DONE' | 'PARTIAL' | 'RUNNING'
  attempts: number
  now: Date
  records: StepRecords
  excluded: { by: string | null; reason: string | null } | null
  holds: OwnerHold[]
  moneyInOut: MoneyInOut | null
  /** Hourly state passes after the cycle that did something, oldest first. */
  later: Array<{ at: string; line: string }>
  /** AB-20 — one line about the A/B proof of the brain on this product (brain/proof-read.ts proofLine): no amounts. */
  proof?: string | null
}

export interface ProductReport {
  v: 1
  productId: string
  name: string | null
  market: string
  dataDay: string
  changeSetId: string
  status: 'DONE' | 'PARTIAL' | 'RUNNING'
  attempts: number
  at: string
  /** One sentence. */
  headline: string
  /** Per step, in the cycle's order: its status, what it did (or would do, in shadow) and why. */
  levers: Array<{ step: CycleStep; title: string; status: StepStatus; acts: boolean; did: string[]; why: string }>
  waitsForOwner: Waiting[]
  heldByOwner: string[]
  clashes: string[]
  problems: string[]
  later: Array<{ at: string; line: string }>
  /** AB-20 — the A/B proof's status in one line, no amounts (null: not read). */
  proof: string | null
  /** Every amount, and every sentence naming one (ad-spend money: hidden whole without the permission). */
  money: { currency: string | null; inOut: MoneyInOut | null; lines: string[] }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** An amount in the market's currency: "€12.50". */
export function amount(cents: number, currency: string | null): string {
  const value = (cents / 100).toFixed(2)
  return currency === 'EUR' || !currency ? `€${value}` : currency === 'GBP' ? `£${value}` : `${value} ${currency}`
}

const acos = (spend: number, sales: number) => (sales > 0 ? `${Math.round((spend / sales) * 1000) / 10} %` : 'no sales')

/** The money lines of the report: ad sales against spend for the data day and its week, and the month's pace. Pure. */
export function moneyLines(m: MoneyInOut | null, dataDay: string): string[] {
  if (!m) return ['No ad report row for the product\'s own campaigns yet: ad sales and spend unknown.']
  const out: string[] = []
  const c = m.currency
  if (m.day) out.push(`${dataDay}: ad sales ${amount(m.day.salesCents, c)} in, ad spend ${amount(m.day.spendCents, c)} out (ACoS ${acos(m.day.spendCents, m.day.salesCents)}, ${plural(m.day.orders, 'order')}).`)
  else out.push(`${dataDay}: no ad report row for the product's own campaigns.`)
  if (m.week) out.push(`The ${plural(m.week.days, 'settled day')} to ${dataDay}: ad sales ${amount(m.week.salesCents, c)} in, ad spend ${amount(m.week.spendCents, c)} out (ACoS ${acos(m.week.spendCents, m.week.salesCents)}, ${plural(m.week.orders, 'order')}).`)
  if (m.month) {
    const env = m.month.envelopeCents != null ? ` of the ${amount(m.month.envelopeCents, c)} monthly envelope` : ' (no monthly envelope set)'
    const heading = m.month.projectedCents != null ? `, heading for ${amount(m.month.projectedCents, c)}` : ''
    const pace = m.month.pacePct != null ? ` (pace ${m.month.pacePct} %)` : ''
    out.push(`This month: ${amount(m.month.spentCents, c)} spent${env}${heading}${pace}; money brake: ${m.month.brake}.`)
  }
  return out
}

/** The day's product report, and the same in plain words without amounts (AdsBrainCycle.summary). Pure. */
export function buildReport(input: ReportInput): { report: ProductReport; summary: string } {
  const levers = CYCLE_STEPS.map((step) => {
    const r = input.records[step]
    const did = r?.did?.lines?.length ? r.did.lines : [r?.why ?? 'not run yet']
    return { step, title: STEP_WORDS[step], status: r?.status ?? 'blocked' as StepStatus, acts: !!r?.acts, did, why: r?.why ?? 'not run yet' }
  })
  const waitsForOwner = CYCLE_STEPS.flatMap((s) => input.records[s]?.waiting ?? [])
  const heldByOwner: string[] = []
  if (input.excluded) heldByOwner.push(`The product is excluded from the brain${input.excluded.by ? ` by ${input.excluded.by}` : ''}${input.excluded.reason ? `: "${input.excluded.reason}"` : ''} — today's engines run it.`)
  for (const h of input.holds) {
    const what = h.ref ? `${h.lever} (${h.ref})` : `the whole ${h.lever} lever`
    const where = h.scope === 'campaign' ? ` on campaign ${h.campaignId}` : ''
    heldByOwner.push(`Locked by ${h.by ?? 'the Owner'}${h.at ? ` on ${h.at.slice(0, 10)}` : ''}: ${what}${where}${h.reason ? ` — "${h.reason}"` : ''}. The brain writes nothing there and only recommends.`)
  }
  const clashes = CYCLE_STEPS.flatMap((s) => input.records[s]?.did?.clashes ?? [])
  const problems = CYCLE_STEPS.flatMap((s) => {
    const r = input.records[s]
    return r && (r.status === 'failed' || r.status === 'blocked') ? [`${STEP_WORDS[s]} ${r.status}: ${r.why}`] : []
  })
  const ran = levers.filter((l) => l.status === 'done').length
  const acting = levers.filter((l) => l.status === 'done' && l.acts).map((l) => l.title)
  const statusWords = input.status === 'DONE' ? 'cycle done' : input.status === 'RUNNING' ? 'cycle running' : `cycle not finished (run ${input.attempts} of ${MAX_CYCLE_ATTEMPTS})`
  const headline = `${input.name ?? input.productId} in ${input.market}, data day ${input.dataDay}: ${statusWords} — ${plural(ran, 'lever')} decided`
    + `${acting.length ? `, acting on ${acting.join(', ')}` : ', all in shadow or off'}; ${plural(waitsForOwner.length, 'request')} waiting for you`
    + `${clashes.length ? `; ${plural(clashes.length, 'clash', 'clashes')}` : ''}${problems.length ? `; ${plural(problems.length, 'problem')}` : ''}.`
  const money = { currency: input.moneyInOut?.currency ?? null, inOut: input.moneyInOut, lines: [...moneyLines(input.moneyInOut, input.dataDay), ...CYCLE_STEPS.flatMap((s) => input.records[s]?.did?.money?.lines ?? [])] }
  const report: ProductReport = {
    v: 1, productId: input.productId, name: input.name, market: input.market, dataDay: input.dataDay, changeSetId: input.changeSetId, status: input.status,
    attempts: input.attempts, at: input.now.toISOString(), headline, levers, waitsForOwner, heldByOwner, clashes, problems, later: input.later, proof: input.proof ?? null, money,
  }
  const lines = [
    headline,
    ...levers.map((l) => `${capital(l.title)}${l.status === 'done' ? '' : ` (${l.status})`}: ${l.did.join(' ')}`),
    waitsForOwner.length ? `Waiting for you: ${waitsForOwner.map((w) => `${w.what}${w.approvalId ? ` (approval ${w.approvalId})` : ''}`).join('; ')}.` : 'Nothing waits for you.',
    ...(clashes.length ? [`Clashes: ${clashes.join(' ')}`] : []),
    ...(heldByOwner.length ? [`Held by your choices: ${heldByOwner.join(' ')}`] : []),
    ...input.later.map((l) => `Later (${l.at.slice(11, 16)} UTC): ${l.line}`),
    ...(input.proof ? [input.proof] : []),
    `Change set ${input.changeSetId}: every write of this cycle carries it.`,
  ]
  return { report, summary: lines.join('\n') }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
