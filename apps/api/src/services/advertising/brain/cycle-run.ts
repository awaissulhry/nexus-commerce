/**
 * ONE BRAIN AB-14 — the product cycle's run (design 2026-10-08-ads-one-brain/DESIGN.md §4, §5, §6, §8 row AB-14). One tick
 * (jobs/ads-brain-cycle.job.ts, hourly), inside one business, while NEXUS_ADS_BRAIN_CYCLE=on (brain/cycle-switch.ts):
 *
 *   who         every enrolled product × market (AdsBrainEnrollment). Each lever's own cron leaves them meanwhile.
 *   data day    the newest settled Sponsored Products day (ads-settled-window.ts settledEnd, BB-14). A product's cycle for a
 *               new data day starts at the first tick from CYCLE_START_HOUR_UTC (the night's reads are in: the reports by
 *               03:30, Amazon's own rules at 04:35, the lag curve at 05:10), at once for a product that never had one, and
 *               never for a day older than its newest cycle.
 *   claim       one AdsBrainCycle row per product × market × data day (unique): created RUNNING with a lease, so two ticks
 *               never run one cycle; a PARTIAL one is claimed again (compare-and-set on the lease) while below
 *               MAX_CYCLE_ATTEMPTS runs.
 *   order       market by market, step by step (brain/cycle.ts): every product's state, then the term ledger of the
 *               market (once, for all of them), then each product's negatives, harvest, money, bids, hours. A step that
 *               ended is never run again that data day; one that waits for a failed step it depends on is `blocked`. Each
 *               step of a product runs inside its change set (ads-evidence.ts inBrainCycle): every write it makes carries
 *               it. After each step the steps are stored, so a run that dies keeps what ended.
 *   report      when the run ends: the day's product report (what each lever did or would do in shadow and why, ad sales
 *               against spend, what waits for the Owner, clashes, his locks) on the row, in words without amounts too.
 *   hourly      a product whose cycle is not run this tick gets its state step on its own (the design's stops are
 *               hourly: a stop that ends is resumed within the hour), in the change set of its newest cycle; what it did
 *               joins that cycle's report as "later". A pass that decided nothing new writes nothing.
 *   kept        rows older than CYCLE_DAYS_KEPT days are deleted at every tick.
 * Off (the default): the tick returns at once, reading nothing.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { settledEnd } from '../ads-settled-window.js'
import { inBrainCycle } from '../ads-evidence.js'
import { brainLiveCeiling, brainOwnedCampaignIds } from '../bid-brain/live.js'
import { cycleKey, cycleOn } from './cycle-switch.js'
import {
  buildReport, changeSetIdOf, CYCLE_DAYS_KEPT, CYCLE_LEASE_MS, CYCLE_STEPS, cycleStatusOf, MAX_CYCLE_ATTEMPTS, readSteps, STEP_LEVERS, STEP_WORDS, stepEnded, waitsFor,
  type CycleStep, type MoneyInOut, type OwnerHold, type ProductReport, type StepOutcome, type StepRecord, type StepRecords, type StepStatus,
} from './cycle.js'
import { CYCLE_RUNNERS, readMoneyInOut, type CycleRunners, type StepContext, type TickFacts } from './cycle-steps.js'
import { resolveBrainSettings, describeProvenance, type BrainSettings, type OverrideRow } from './settings.js'

/** A new data day's cycle starts at the first tick from this UTC hour (the tick runs at :55: 05:55 UTC). */
export const CYCLE_START_HOUR_UTC = 5
const DAY_MS = 86_400_000
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
const ROW_SELECT = { id: true, productId: true, marketplace: true, dataDay: true, changeSetId: true, status: true, attempts: true, leaseUntil: true, steps: true, report: true, summary: true } as const

const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err))

export interface CycleTickSummary {
  ran: boolean
  why: string
  dataDay?: string
  cycles: Array<{ productId: string; market: string; changeSetId: string; status: 'DONE' | 'PARTIAL'; attempt: number; steps: Record<CycleStep, StepStatus> }>
  statePasses: Array<{ productId: string; market: string; status: StepStatus; stored: boolean }>
  /** Product × markets the tick left: another run holds the cycle, or it ran its attempts today. */
  left: Array<{ productId: string; market: string; why: string }>
  pruned: number
}

type CycleRow = { id: string; productId: string; marketplace: string; dataDay: Date; changeSetId: string; status: string; attempts: number; leaseUntil: Date | null; steps: unknown; report: unknown; summary: string | null }

/** Whether the lever behind a step acts on the product (PROPOSE or AUTO — the product's level, or one campaign's). */
export function stepActs(step: CycleStep, s: BrainSettings, productId: string, market: string, overrides: readonly OverrideRow[]): boolean {
  return STEP_LEVERS[step].some((lever) => s.levers[lever].owned || overrides.some((o) =>
    !o.endedAt && o.scope === 'CAMPAIGN' && o.kind === 'LEVEL' && o.key === lever && o.productId === productId && o.marketplace === market && (o.value === 'PROPOSE' || o.value === 'AUTO')))
}

/** The Owner's locks and campaign exclusions on the product, for the report. */
export function ownerHoldsOf(productId: string, market: string, overrides: readonly OverrideRow[]): OwnerHold[] {
  return overrides
    .filter((o) => !o.endedAt && o.productId === productId && o.marketplace === market && (o.kind === 'LOCK' || (o.kind === 'EXCLUDE' && o.scope === 'CAMPAIGN')))
    .map((o) => ({
      lever: o.kind === 'EXCLUDE' ? 'every' : o.key, scope: o.scope === 'CAMPAIGN' ? 'campaign' as const : 'product' as const, campaignId: o.campaignId, ref: o.kind === 'EXCLUDE' ? 'excluded from the brain' : o.ref,
      by: o.by, at: new Date(o.createdAt).toISOString(), reason: o.reason,
    }))
    .sort((a, b) => a.lever.localeCompare(b.lever) || (a.campaignId ?? '').localeCompare(b.campaignId ?? ''))
}

interface Claimed {
  row: { id: string; changeSetId: string; attempts: number; laterOf: ProductReport['later'] }
  productId: string
  market: string
  settings: BrainSettings
  records: StepRecords
  acts: Record<CycleStep, boolean>
  ctx: StepContext
  dirty: boolean
}

/** Delete the cycles older than CYCLE_DAYS_KEPT days. */
export async function pruneCycles(now: Date): Promise<number> {
  return (await prisma.adsBrainCycle.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - CYCLE_DAYS_KEPT * DAY_MS) } } })).count
}

/** One tick in the business the caller is in. `runners` and `startHourUtc` are seams for tests. */
export async function runCycleTick(opts: { now?: Date; runners?: Partial<CycleRunners>; startHourUtc?: number } = {}): Promise<CycleTickSummary> {
  const out: CycleTickSummary = { ran: false, why: '', cycles: [], statePasses: [], left: [], pruned: 0 }
  if (!cycleOn()) { out.why = 'the product cycle is off (NEXUS_ADS_BRAIN_CYCLE): each lever runs on its own cron'; return out }
  const now = opts.now ?? await (await import('../../../jobs/ad-rank-defend.job.js')).dbNow()
  const runners: CycleRunners = { ...CYCLE_RUNNERS, ...(opts.runners ?? {}) }
  out.pruned = await pruneCycles(now)
  const enrollments = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true }, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }] })
  if (!enrollments.length) { out.why = 'no product is enrolled in the brain: no cycle to run'; return out }
  const dataDay = isoDay(settledEnd('SPONSORED_PRODUCTS', { now }).until)
  out.dataDay = dataDay
  out.ran = true
  out.why = `${enrollments.length} enrolled product × market${enrollments.length === 1 ? '' : 's'}, data day ${dataDay}`
  const productIds = [...new Set(enrollments.map((e) => e.productId))]
  const { stateWatchProducts } = await import('./state-load.js')
  const { moneyShadowProducts } = await import('./budget-shadow.js')
  const { termsDue } = await import('./terms-shadow.js')
  const [overrides, rows, stateWatch, moneyWatch, terms] = await Promise.all([
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, productId: { in: productIds } }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
    prisma.adsBrainCycle.findMany({ where: { productId: { in: productIds }, dataDay: { gte: new Date(Date.parse(`${dataDay}T00:00:00Z`) - 7 * DAY_MS) } }, orderBy: { dataDay: 'desc' }, select: ROW_SELECT }) as Promise<CycleRow[]>,
    stateWatchProducts(),
    moneyShadowProducts(),
    termsDue({ includeOrchestrated: true }),
  ])
  const tick: TickFacts = {
    now, dataDay,
    stateWatch: new Map(stateWatch.map((w) => [cycleKey(w.productId, w.market), w])),
    moneyWatch: new Map(moneyWatch.map((m) => [cycleKey(m.productId, m.market), m])),
    termsDue: terms.products,
  }
  const startHour = opts.startHourUtc ?? CYCLE_START_HOUR_UTC
  const claimed: Claimed[] = []
  const passes: Array<{ productId: string; market: string; row: CycleRow }> = []

  for (const e of enrollments) {
    const market = e.marketplace
    const mine = rows.filter((r) => r.productId === e.productId && r.marketplace === market)
    const newest = mine[0]
    const today = mine.find((r) => isoDay(r.dataDay) === dataDay)
    const held = (r: CycleRow | undefined) => !!r && r.status === 'RUNNING' && !!r.leaseUntil && r.leaseUntil.getTime() > now.getTime()
    try {
      if (today) {
        if (held(today)) { out.left.push({ productId: e.productId, market, why: 'another run holds its cycle' }); continue }
        if (today.status === 'DONE' || today.attempts >= MAX_CYCLE_ATTEMPTS) {
          // A run that died on its last attempt: the cycle ends PARTIAL, its report as far as it got.
          if (today.status === 'RUNNING') await prisma.adsBrainCycle.updateMany({ where: { id: today.id, status: 'RUNNING' }, data: { status: 'PARTIAL', leaseUntil: null } })
          passes.push({ productId: e.productId, market, row: today })
          continue
        }
        const got = await prisma.adsBrainCycle.updateMany({
          where: { id: today.id, status: { not: 'DONE' }, attempts: { lt: MAX_CYCLE_ATTEMPTS }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          data: { status: 'RUNNING', attempts: { increment: 1 }, leaseUntil: new Date(now.getTime() + CYCLE_LEASE_MS) },
        })
        if (!got.count) { out.left.push({ productId: e.productId, market, why: 'another run claimed its cycle' }); continue }
        claimed.push(await prepare(e.productId, market, { id: today.id, changeSetId: today.changeSetId, attempts: today.attempts + 1, laterOf: laterOf(today.report) }, readSteps(today.steps)))
        continue
      }
      // Never a data day older than the newest cycle; a new one from the start hour, or at once for a first cycle.
      if (newest && isoDay(newest.dataDay) >= dataDay) { if (!held(newest)) passes.push({ productId: e.productId, market, row: newest }); continue }
      if (newest && now.getUTCHours() < startHour) { if (!held(newest)) passes.push({ productId: e.productId, market, row: newest }); continue }
      const changeSetId = changeSetIdOf(e.productId, market, dataDay)
      let created: { id: string } | null = null
      try {
        created = await prisma.adsBrainCycle.create({
          data: { productId: e.productId, marketplace: market, dataDay: new Date(`${dataDay}T00:00:00Z`), changeSetId, status: 'RUNNING', attempts: 1, leaseUntil: new Date(now.getTime() + CYCLE_LEASE_MS), steps: {} },
          select: { id: true },
        })
      } catch (err) {
        if ((err as { code?: string } | null)?.code !== 'P2002') throw err
      }
      if (!created) { out.left.push({ productId: e.productId, market, why: 'another run started its cycle' }); continue }
      claimed.push(await prepare(e.productId, market, { id: created.id, changeSetId, attempts: 1, laterOf: [] }, {}))
    } catch (err) {
      logger.error('[brain-cycle] could not start a product\'s cycle', { productId: e.productId, market, error: msg(err) })
      out.left.push({ productId: e.productId, market, why: `its cycle could not start: ${msg(err)}` })
    }
  }

  async function prepare(productId: string, market: string, row: Claimed['row'], records: StepRecords): Promise<Claimed> {
    const settings = resolveBrainSettings({ productId, market, campaignId: null, enrolled: true, overrides })
    const { productCampaigns } = await import('./ownership.js')
    const campaigns = await productCampaigns(productId, market)
    const own = new Map((campaigns?.owned ?? []).map((c) => [c.campaignId, c.name]))
    const acts = Object.fromEntries(CYCLE_STEPS.map((s) => [s, stepActs(s, settings, productId, market, overrides)])) as Record<CycleStep, boolean>
    // The bids act too where the bid brain already runs one of its own campaigns LIVE or HELD (adopted, BB-6).
    if (!acts.bids && brainLiveCeiling() && own.size) acts.bids = (await brainOwnedCampaignIds([...own.keys()])).size > 0
    const c: Claimed = {
      row, productId, market, settings, records, acts, dirty: false,
      ctx: { productId, market, key: cycleKey(productId, market), changeSetId: row.changeSetId, own, records, acts, tick },
    }
    if (!campaigns) {
      // No family root in the market (a deleted product): nothing to run, said once per step.
      for (const s of CYCLE_STEPS) if (!stepEnded(records[s])) records[s] = recordOf(c, s, { status: 'skipped', why: 'the product has no family root in this market (deleted, or an ASIN two families carry): nothing to decide' })
    }
    return c
  }

  function recordOf(c: Claimed, step: CycleStep, outcome: StepOutcome): StepRecord {
    c.dirty = true
    return { ...outcome, why: outcome.why.slice(0, 1_000), acts: c.acts[step], attempt: c.row.attempts, at: now.toISOString() }
  }

  // Market by market, step by step: what a step decides is known to the next before it runs.
  for (const market of [...new Set(claimed.map((c) => c.market))].sort()) {
    const group = claimed.filter((c) => c.market === market)
    for (const step of CYCLE_STEPS) {
      const runnable: Claimed[] = []
      for (const c of group) {
        if (stepEnded(c.records[step])) continue
        const w = waitsFor(step, c.records, c.acts)
        if (w) { c.records[step] = recordOf(c, step, { status: 'blocked', why: `waits for ${STEP_WORDS[w.step]}: ${w.why}` }); continue }
        runnable.push(c)
      }
      if (step === 'terms' && runnable.length) {
        let outcomes: Map<string, StepOutcome>
        try {
          outcomes = await runners.terms(market, runnable.map((c) => c.ctx))
        } catch (err) {
          logger.error('[brain-cycle] the term ledger failed for a market', { market, error: msg(err) })
          outcomes = new Map(runnable.map((c) => [c.productId, { status: 'failed' as const, why: `the term ledger failed: ${msg(err)}` }]))
        }
        for (const c of runnable) c.records.terms = recordOf(c, 'terms', outcomes.get(c.productId) ?? { status: 'failed', why: 'the term ledger said nothing about the product' })
      } else if (step !== 'terms') {
        for (const c of runnable) {
          let outcome: StepOutcome
          try {
            outcome = await inBrainCycle({ changeSetId: c.row.changeSetId, step }, () => runners[step](c.ctx))
          } catch (err) {
            logger.error('[brain-cycle] a step failed', { productId: c.productId, market, step, error: msg(err) })
            outcome = { status: 'failed', why: `${STEP_WORDS[step]} failed: ${msg(err)}` }
          }
          c.records[step] = recordOf(c, step, outcome)
        }
      }
      // What ended is kept before the next step runs: a run that dies here keeps it.
      for (const c of group) {
        if (!c.dirty) continue
        c.dirty = false
        await prisma.adsBrainCycle.update({ where: { id: c.row.id }, data: { steps: c.records as unknown as Prisma.InputJsonObject } })
      }
    }
  }

  // Each cycle's end: its status, the day's product report, the lease freed.
  for (const c of claimed) {
    const status = cycleStatusOf(c.records)
    try {
      const { report, summary } = await reportOf(c, status)
      await prisma.adsBrainCycle.update({
        where: { id: c.row.id },
        data: { status, steps: c.records as unknown as Prisma.InputJsonObject, report: report as unknown as Prisma.InputJsonObject, summary, finishedAt: now, leaseUntil: null },
      })
    } catch (err) {
      logger.error('[brain-cycle] the report could not be stored', { productId: c.productId, market: c.market, error: msg(err) })
      await prisma.adsBrainCycle.update({ where: { id: c.row.id }, data: { status, steps: c.records as unknown as Prisma.InputJsonObject, finishedAt: now, leaseUntil: null } })
    }
    out.cycles.push({ productId: c.productId, market: c.market, changeSetId: c.row.changeSetId, status, attempt: c.row.attempts, steps: Object.fromEntries(CYCLE_STEPS.map((s) => [s, c.records[s]?.status ?? 'blocked'])) as Record<CycleStep, StepStatus> })
  }

  async function reportOf(c: Claimed, status: 'DONE' | 'PARTIAL'): Promise<{ report: ProductReport; summary: string }> {
    const [product, money] = await Promise.all([
      prisma.product.findFirst({ where: { id: c.productId }, select: { name: true } }),
      c.records.money?.status === 'done' ? import('./budget-shadow.js').then((m) => m.newestMoneyDecisions(c.market, [c.productId])) : Promise.resolve(new Map()),
    ])
    const plan = money.get(c.productId)?.plan ?? null
    const month: MoneyInOut['month'] = plan ? { spentCents: plan.pace.spentNowCents, envelopeCents: plan.envelope.cents, projectedCents: plan.pace.projectedCents, pacePct: plan.pace.pacePct, brake: plan.brake.level } : null
    const inOut = await readMoneyInOut([...c.ctx.own.keys()], dataDay, month, plan?.currency ?? null)
    const excluded = c.settings.excluded.value ? { by: c.settings.excluded.by ? describeProvenance(c.settings.excluded) : null, reason: c.settings.excluded.reason } : null
    return buildReport({
      productId: c.productId, name: product?.name ?? null, market: c.market, dataDay, changeSetId: c.row.changeSetId, status, attempts: c.row.attempts, now,
      records: c.records, excluded, holds: ownerHoldsOf(c.productId, c.market, overrides), moneyInOut: inOut, later: c.row.laterOf,
    })
  }

  // The hourly state pass of every product whose cycle did not run this tick, in its newest cycle's change set.
  for (const p of passes) {
    const settings = resolveBrainSettings({ productId: p.productId, market: p.market, campaignId: null, enrolled: true, overrides })
    const key = cycleKey(p.productId, p.market)
    if (!tick.stateWatch.has(key)) continue
    const records = readSteps(p.row.steps)
    const acts = Object.fromEntries(CYCLE_STEPS.map((s) => [s, stepActs(s, settings, p.productId, p.market, overrides)])) as Record<CycleStep, boolean>
    const ctx: StepContext = { productId: p.productId, market: p.market, key, changeSetId: p.row.changeSetId, own: new Map(), records, acts, tick }
    let outcome: StepOutcome
    try {
      const { productCampaigns } = await import('./ownership.js')
      ctx.own = new Map(((await productCampaigns(p.productId, p.market))?.owned ?? []).map((c) => [c.campaignId, c.name]))
      outcome = await inBrainCycle({ changeSetId: p.row.changeSetId, step: 'state' }, () => runners.state(ctx))
    } catch (err) {
      logger.error('[brain-cycle] the hourly state pass failed', { productId: p.productId, market: p.market, error: msg(err) })
      outcome = { status: 'failed', why: `the hourly state pass failed: ${msg(err)}` }
    }
    const counts = outcome.did?.counts ?? {}
    const changed = (counts.stored ?? 0) > 0 || (counts.acted ?? 0) > 0
    const line = outcome.status === 'failed' ? outcome.why : changed ? `stops and state: ${(outcome.did?.lines ?? [outcome.why]).join(' ')}` : null
    const stored = !!line && await addLater(p.row, now, line)
    out.statePasses.push({ productId: p.productId, market: p.market, status: outcome.status, stored })
  }
  return out
}

const laterOf = (report: unknown): ProductReport['later'] => {
  const later = (report as { later?: unknown } | null)?.later
  return Array.isArray(later) ? later.filter((l): l is { at: string; line: string } => !!l && typeof l.at === 'string' && typeof l.line === 'string') : []
}

/** Add an hourly pass to its cycle's report ("later"), unless it says what the last one said. Whether it was stored. */
async function addLater(row: CycleRow, now: Date, line: string): Promise<boolean> {
  const fresh = await prisma.adsBrainCycle.findFirst({ where: { id: row.id }, select: { report: true, summary: true } })
  const report = (fresh?.report ?? null) as (ProductReport & Record<string, unknown>) | null
  const later = laterOf(report)
  if (later.at(-1)?.line === line) return false
  const entry = { at: now.toISOString(), line: line.slice(0, 1_000) }
  const nextReport = report ? { ...report, later: [...later, entry] } : null
  await prisma.adsBrainCycle.update({
    where: { id: row.id },
    data: { ...(nextReport ? { report: nextReport as unknown as Prisma.InputJsonObject } : {}), summary: `${fresh?.summary ?? ''}\nLater (${entry.at.slice(11, 16)} UTC): ${entry.line}`.trim() },
  })
  return true
}

/** The tick in one line (the cron's record). */
export function cycleSummaryLine(s: CycleTickSummary): string {
  if (!s.ran) return s.why
  const cycles = s.cycles.map((c) => `${c.market} ${c.productId} ${c.status}${c.attempt > 1 ? ` (run ${c.attempt})` : ''}: ${CYCLE_STEPS.map((st) => `${st}=${c.steps[st]}`).join(' ')}`)
  const passes = s.statePasses.filter((p) => p.stored).map((p) => `${p.market} ${p.productId} state ${p.status}`)
  const left = s.left.map((l) => `${l.market} ${l.productId} left: ${l.why}`)
  return `CYCLE ${s.dataDay}: ${[...cycles, ...passes, ...left].join(' · ') || 'no cycle due; hourly state passes wrote nothing'} · pruned=${s.pruned}`
}
