/**
 * BID BRAIN BB-21 — the switchback probes' ledger (BidProbe) and what a run reads for them (probe.ts holds the rules).
 *
 *   ledger     one row per probe: the keyword, its pool (product key), the mode (SHADOW | LIVE), the arms around the
 *              brain's bid, the order and days, what each serving day recorded, then what it observed per arm, its
 *              reading of ε and its product's ε before and after. Unique per business, keyword and start day: two runs
 *              planning at once start one probe. Ended probes are kept a year (their readings are what ε rests on)
 *   a run      (response-explore.ts upgradesShadow, full runs only) reads the market's running and recent probes and the
 *              done LIVE readings once; steps every running probe; measures the ones whose last day's clicks are in (the
 *              keyword's daily rows over its days); plans new ones among the run's own keywords — reading for the
 *              candidates only their clicks of the last 14 days, their campaigns' budget-capped days, the Owner's brakes
 *              and the protected, brand and winner terms; writes only rows that changed; `on` turns a LIVE probe's arm
 *              into the decision (probe.ts applyProbeArm). A failure is logged and changes nothing (the decisions stand)
 *   the day    the serving day in the market's own zone (ads-market-time.ts), as Amazon's daily reports count it
 *   read       the bid-brain read tool's view `probes`: each probe with its arms, days and readings, and ε per pool
 *
 * Called inside a business (the run's or the tool's): row-level security keeps each to its own rows.
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { isoDayIn } from '../ads-local-day.js'
import { MARKET_TIME_ZONE } from '../ads-market-time.js'
import { normaliseTerm, protectedTermHit } from '../ads-negation-policy.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { ownerBrakes } from '../brain/owner-brakes.js'
import type { Decision, TargetFacts } from './decide.js'
import type { AdGroupRow, TargetRow } from './facts.js'
import { combineReadings, EPS_MEASURED_SD, EPS_PRIOR, isCapped, productEps, type CampaignSignal, type EpsPosterior, type EpsReading, type Normal } from './response.js'
import {
  ACTIVE_STATUSES, addDays, applyProbeArms, daysBetween, doneWords, finishProbe, KEEP_DAYS, measureProbe, planProbes, probeMode,
  probeOption, probeVerdict, productKeyOfGroup, productModeKey, REST_DAYS, restKey, scheduleDay, stepProbe,
  type DayRow, type PlanLedger, type ProbeArm, type ProbeCandidate, type ProbeLedgerMode, type ProbeMode, type ProbeRecord,
  type ProbeSummary, type ProbeDay, type ProbeObserved,
} from './probe.js'

const DAY_MS = 86_400_000
const isoOf = (d: Date) => d.toISOString().slice(0, 10)
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`)

/** The serving day in the market's own zone (the day Amazon's daily report counts). */
export const todayIn = (market: string, now: Date): string => isoDayIn(now, MARKET_TIME_ZONE[market] ?? null)

const PROBE_SELECT = {
  id: true, marketplace: true, campaignId: true, adGroupId: true, targetId: true, productKey: true, mode: true, status: true,
  centerCents: true, highCents: true, lowCents: true, amplitude: true, protection: true, sequence: true, startDay: true, endDay: true,
  days: true, observed: true, reading: true, epsPrior: true, epsPosterior: true, why: true, stoppedWhy: true, createdAt: true, updatedAt: true,
} as const

type ProbeRow = Prisma.BidProbeGetPayload<{ select: typeof PROBE_SELECT }>

const asNormal = (v: unknown): Normal | null => {
  const n = v as Partial<Normal> | null
  return n && typeof n.mean === 'number' && typeof n.sd === 'number' ? { mean: n.mean, sd: n.sd } : null
}
const asReading = (v: unknown): EpsReading | null => {
  const r = v as Partial<EpsReading> | null
  return r && typeof r.eps === 'number' && Number.isFinite(r.eps) && typeof r.variance === 'number' && r.variance > 0 ? { eps: r.eps, variance: r.variance } : null
}

/** A ledger row as probe.ts reads it. */
export function recordOf(r: ProbeRow): ProbeRecord & { createdAt: Date; updatedAt: Date } {
  return {
    id: r.id, marketplace: r.marketplace, campaignId: r.campaignId, adGroupId: r.adGroupId, targetId: r.targetId, productKey: r.productKey,
    mode: r.mode as ProbeLedgerMode, status: r.status as ProbeRecord['status'], centerCents: r.centerCents, highCents: r.highCents,
    lowCents: r.lowCents, amplitude: r.amplitude, protection: r.protection, sequence: r.sequence, startDay: isoOf(r.startDay), endDay: isoOf(r.endDay),
    days: (r.days && typeof r.days === 'object' && !Array.isArray(r.days) ? r.days : {}) as unknown as Record<string, ProbeDay>,
    observed: (r.observed ?? null) as unknown as ProbeObserved | null, reading: asReading(r.reading),
    epsPrior: asNormal(r.epsPrior), epsPosterior: asNormal(r.epsPosterior), why: r.why, stoppedWhy: r.stoppedWhy,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  }
}

const json = (v: unknown) => (v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue))

/** What a run writes back of a probe it changed (its identity and arms never change). */
const changeOf = (p: ProbeRecord) => ({
  status: p.status, days: p.days as unknown as Prisma.InputJsonValue, observed: json(p.observed), reading: json(p.reading),
  epsPrior: json(p.epsPrior), epsPosterior: json(p.epsPosterior), stoppedWhy: p.stoppedWhy,
})

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────

export interface LoadedLedger {
  /** The market's running probes and those that started or ended in the last 35 days. */
  records: Array<ProbeRecord & { createdAt: Date; updatedAt: Date }>
  plan: PlanLedger
}

/** The market's running probes, and the recent ones that rest a keyword or count toward a product's week. */
export async function loadProbeLedger(market: string, now: Date): Promise<LoadedLedger> {
  const since = new Date(now.getTime() - (REST_DAYS + 7) * DAY_MS)
  const rows = await prisma.bidProbe.findMany({
    where: { marketplace: market, OR: [{ status: { in: [...ACTIVE_STATUSES] } }, { updatedAt: { gte: since } }, { createdAt: { gte: since } }] },
    select: PROBE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const records = rows.map(recordOf)
  return { records, plan: planLedgerOf(records, todayIn(market, now), (at) => todayIn(market, at)) }
}

/** The planning view of the ledger: who is in a probe, who rests until when, and each product's starts. Pure. */
export function planLedgerOf(records: ReadonlyArray<ProbeRecord & { updatedAt: Date }>, today: string, dayOf: (at: Date) => string): PlanLedger {
  const active = new Set<string>()
  const restUntil = new Map<string, string>()
  const startsWeek = new Map<string, number>()
  const startsToday = new Map<string, number>()
  for (const p of records) {
    if ((ACTIVE_STATUSES as readonly string[]).includes(p.status)) active.add(p.targetId)
    else {
      const ended = p.status === 'DONE' ? p.endDay : dayOf(p.updatedAt)
      const until = addDays(ended, REST_DAYS)
      const key = restKey(p.targetId, p.mode)
      if (until > (restUntil.get(key) ?? '')) restUntil.set(key, until)
    }
    const age = daysBetween(p.startDay, today)
    const key = productModeKey(p.productKey, p.mode)
    if (age >= 0 && age < 7) startsWeek.set(key, (startsWeek.get(key) ?? 0) + 1)
    if (age === 0) startsToday.set(key, (startsToday.get(key) ?? 0) + 1)
  }
  return { active, restUntil, startsWeek, startsToday }
}

/** The DONE live probes' readings of the market (a year), by product key (null: no product known — the market's). */
export async function loadProbeReadings(market: string, now: Date): Promise<Map<string | null, EpsReading[]>> {
  const rows = await prisma.bidProbe.findMany({
    where: { marketplace: market, mode: 'LIVE', status: 'DONE', reading: { not: Prisma.DbNull }, updatedAt: { gte: new Date(now.getTime() - KEEP_DAYS * DAY_MS) } },
    select: { productKey: true, reading: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const out = new Map<string | null, EpsReading[]>()
  for (const r of rows) {
    const reading = asReading(r.reading)
    if (reading) out.set(r.productKey, [...(out.get(r.productKey) ?? []), reading])
  }
  return out
}

/**
 * Per keyword: protected-term (AdKeywordProtection, the market's or every market's, its campaign's or every campaign's),
 * else brand or winner (the one brain's term register for one of its ad group's products); absent: none.
 */
export async function loadProtections(market: string, items: ReadonlyArray<{ targetId: string; campaignId: string; text: string; families: readonly string[] }>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!items.length) return out
  const texts = [...new Set(items.map((i) => normaliseTerm(i.text)).filter(Boolean))]
  const [terms, register] = await Promise.all([
    prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, isPrefix: true, matchType: true, reason: true, marketplace: true, campaignId: true } }),
    texts.length ? prisma.adsBrainTerm.findMany({ where: { marketplace: market, protection: { not: null }, term: { in: texts } }, select: { productId: true, term: true, protection: true } }) : Promise.resolve([]),
  ])
  const here = terms.filter((t) => t.marketplace == null || strategyMarket(t.marketplace) === market)
  for (const i of items) {
    const mine = here.filter((t) => t.campaignId == null || t.campaignId === i.campaignId)
    if (protectedTermHit(i.text, 'EXACT', mine)) { out.set(i.targetId, 'protected-term'); continue }
    const text = normaliseTerm(i.text)
    const hit = register.find((r) => r.term === text && i.families.includes(r.productId))
    if (hit?.protection) out.set(i.targetId, hit.protection)
  }
  return out
}

/** Each keyword's daily rows (clicks, impressions, cost in cents, 7-day orders) over its probe's days. */
export async function loadProbeDaily(probes: ReadonlyArray<Pick<ProbeRecord, 'targetId' | 'startDay' | 'endDay'>>): Promise<Map<string, Map<string, DayRow>>> {
  const out = new Map<string, Map<string, DayRow>>()
  if (!probes.length) return out
  const ids = [...new Set(probes.map((p) => p.targetId))]
  const from = probes.map((p) => p.startDay).sort()[0]
  const to = probes.map((p) => p.endDay).sort().reverse()[0]
  const rows = await prisma.$queryRaw<Array<{ id: string; day: string; clicks: number; impressions: number; cost: number; orders: number }>>(Prisma.sql`
    SELECT p."localEntityId" AS id, to_char(p.date, 'YYYY-MM-DD') AS day, SUM(p.clicks)::float8 AS clicks, SUM(p.impressions)::float8 AS impressions,
           SUM(p."costMicros")::float8 / 10000 AS cost, SUM(COALESCE(p."orders7d", 0))::float8 AS orders
      FROM "AmazonAdsDailyPerformance" p
     WHERE p."entityType" = 'AD_TARGET' AND p."adProduct" = 'SPONSORED_PRODUCTS' AND p."localEntityId" = ANY(${ids}::text[])
       AND p.date BETWEEN ${from}::date AND ${to}::date
     GROUP BY 1, 2`)
  for (const r of rows) {
    const days = out.get(r.id) ?? new Map<string, DayRow>()
    days.set(r.day, { clicks: Number(r.clicks), impressions: Number(r.impressions), costCents: Number(r.cost), orders: Number(r.orders) })
    out.set(r.id, days)
  }
  return out
}

// ── One run ───────────────────────────────────────────────────────────────────────────────────────

export interface ProbeRun {
  /** The decisions to act on: the input's (the same array) unless `on` set a LIVE probe's arm. */
  decisions: Decision[]
  notes: Map<string, string>
  evidence: Map<string, Record<string, unknown>>
  /** Null when nothing ran, started, ended or was measured. */
  summary: ProbeSummary | null
}

/**
 * BB-21 — the probes of one market's run (probe.ts): step the running ones, measure the finished ones, plan new ones among
 * the run's own keywords, and with `on` set the LIVE ones' arms. `facts` / `decisions`: the run's own keywords (the
 * decisions after exploration). `posteriors`: each product's ε as the response found it (absent: the prior with the
 * probes' readings). Writes only BidProbe rows; never a bid.
 */
export async function probesShadow(
  m: { market: string; dataDay: string; targets: readonly TargetRow[]; adGroups: ReadonlyMap<string, AdGroupRow> },
  input: {
    facts: readonly TargetFacts[]; decisions: readonly Decision[]; campaignOf: (targetId: string) => string
    now: Date; mode: Exclude<ProbeMode, 'off'>; owned: ReadonlySet<string>; runId: string
    ledger: LoadedLedger; readings: ReadonlyMap<string | null, EpsReading[]>
    posteriors?: ReadonlyMap<string | null, EpsPosterior>
    signals?: ReadonlyMap<string, CampaignSignal>
    loadClicks: (targetIds: readonly string[]) => Promise<Map<string, number>>
    loadSignals: (campaignIds: readonly string[]) => Promise<Map<string, CampaignSignal>>
  },
): Promise<ProbeRun> {
  const today = todayIn(m.market, input.now)
  const notes = new Map<string, string>()
  const evidence = new Map<string, Record<string, unknown>>()
  const own = new Map(input.facts.map((f, i) => [f.targetId, { f, d: input.decisions[i] }]))
  const targetById = new Map(m.targets.map((t) => [t.id, t]))
  const groupOf = new Map(m.targets.map((t) => [t.id, t.adGroupId]))
  const posterior = (key: string | null): Normal => input.posteriors?.get(key) ?? productEps(new Map(), key, EPS_PRIOR, input.readings)
  const summary: ProbeSummary = { mode: input.mode, running: 0, live: 0, started: 0, armed: 0, measuring: 0, done: 0, stopped: 0 }
  const arms = new Map<string, ProbeArm>()
  const changed: ProbeRecord[] = []
  const say = (p: Pick<ProbeRecord, 'targetId'>, words: string | null, more?: Record<string, unknown>) => {
    if (!own.has(p.targetId)) return
    if (words) notes.set(p.targetId, words)
    if (more) evidence.set(p.targetId, { probe: more })
  }
  const probeFacts = (p: ProbeRecord, extra: Record<string, unknown> = {}) => ({ id: p.id, mode: p.mode, status: p.status, startDay: p.startDay, sequence: p.sequence, centerCents: p.centerCents, highCents: p.highCents, lowCents: p.lowCents, ...extra })

  // ── The running probes. ──
  const toMeasure: ProbeRecord[] = []
  const stoppedNow = new Set<string>()
  for (const p of input.ledger.records) {
    if (!(ACTIVE_STATUSES as readonly string[]).includes(p.status)) continue
    const mine = own.get(p.targetId)
    const step = stepProbe({ p, today, f: mine?.f, d: mine?.d, known: targetById.has(p.targetId), mode: input.mode, owned: input.owned.has(p.campaignId) })
    if (step.changed) changed.push(step.next)
    if (step.measure) { toMeasure.push(step.next); continue }
    if (step.next.status === 'STOPPED') { summary.stopped += 1; stoppedNow.add(restKey(p.targetId, p.mode)); say(p, step.note, probeFacts(step.next, { stoppedWhy: step.next.stoppedWhy })); continue }
    if (step.next.status === 'MEASURING') { summary.measuring += 1; continue }
    summary.running += 1
    if (p.mode === 'LIVE') summary.live += 1
    const s = scheduleDay(p.sequence, p.startDay, today)
    const armed = !!step.arm && p.mode === 'LIVE' && input.mode === 'on'
    // An arm that stands in says itself in the decision's why: no second note.
    say(p, armed ? null : step.note, s ? probeFacts(step.next, { day: s.index + 1, arm: s.arm, washout: s.washout, served: step.next.days[today]?.served ?? null }) : probeFacts(step.next))
    if (armed) arms.set(p.targetId, { p: step.next, bidCents: step.arm!.bidCents, words: step.note!.replace(/^probe: /, '') })
  }

  // ── The finished ones: measured, and their product's ε updated. ──
  if (toMeasure.length) {
    const daily = await loadProbeDaily(toMeasure)
    for (const p of toMeasure) {
      const done = finishProbe(p, measureProbe(p, daily.get(p.targetId) ?? new Map(), today), posterior(p.productKey))
      const at = changed.findIndex((c) => c.id === p.id)
      if (at >= 0) changed[at] = done
      else changed.push(done)
      if (done.status === 'DONE') summary.done += 1
      else summary.stopped += 1
      say(done, doneWords(done), probeFacts(done, { observed: done.observed, reading: done.reading, epsPosterior: done.epsPosterior }))
    }
  }

  // ── New probes among the run's own keywords. ──
  const busy = new Set(input.ledger.records.filter((p) => (ACTIVE_STATUSES as readonly string[]).includes(p.status) && !changed.some((c) => c.id === p.id && c.status === 'STOPPED')).map((p) => p.targetId))
  const open = input.facts.flatMap((f, i) => {
    const d = input.decisions[i]
    if (busy.has(f.targetId) || d.action !== 'hold' || (d.layer !== 'goal' && d.layer !== 'band') || d.goal == null || probeVerdict(f, d)) return []
    const campaignId = input.campaignOf(f.targetId)
    return campaignId ? [{ f, d, campaignId }] : []
  })
  const created: ProbeRecord[] = []
  if (open.length) {
    const campaigns = [...new Set(open.map((o) => o.campaignId))]
    const [clicks, signals, brakes, protections] = await Promise.all([
      input.loadClicks(open.map((o) => o.f.targetId)),
      input.signals ? Promise.resolve(input.signals) : input.loadSignals(campaigns),
      ownerBrakes(campaigns),
      loadProtections(m.market, open.map((o) => {
        const t = targetById.get(o.f.targetId)
        return { targetId: o.f.targetId, campaignId: o.campaignId, text: t?.expressionValue ?? '', families: m.adGroups.get(groupOf.get(o.f.targetId) ?? '')?.families ?? [] }
      })),
    ])
    const restUntil = new Map(input.ledger.plan.restUntil)
    for (const key of stoppedNow) restUntil.set(key, addDays(today, REST_DAYS))
    const candidates: ProbeCandidate[] = open.map(({ f, d, campaignId }) => {
      const adGroupId = groupOf.get(f.targetId) ?? ''
      const productKey = productKeyOfGroup(m.adGroups.get(adGroupId))
      return {
        f, d, campaignId, adGroupId, productKey, clicks14: clicks.get(f.targetId) ?? 0, eps: posterior(productKey),
        protection: protections.get(f.targetId) ?? null, capped: isCapped(signals.get(campaignId)), ownerBrake: brakes.get(campaignId) ?? null,
        mode: input.mode === 'on' && input.owned.has(campaignId) ? 'LIVE' : 'SHADOW',
      }
    })
    const options = candidates.map((c) => probeOption(c, { active: busy, restUntil }, today))
    const { started } = planProbes(options, input.ledger.plan, today)
    const byId = new Map(candidates.map((c) => [c.f.targetId, c]))
    for (const o of started) {
      const c = byId.get(o.targetId)!
      const p0: ProbeRecord = {
        id: `bp_${randomUUID()}`, marketplace: m.market, campaignId: o.campaignId, adGroupId: o.adGroupId, targetId: o.targetId, productKey: o.productKey,
        mode: o.mode, status: 'RUNNING', centerCents: o.centerCents, highCents: o.highCents, lowCents: o.lowCents, amplitude: o.amplitude,
        protection: o.protection, sequence: o.sequence, startDay: o.startDay, endDay: o.endDay, days: {}, observed: null, reading: null,
        epsPrior: null, epsPosterior: null, why: o.why, stoppedWhy: null,
      }
      // Day 1 is today: recorded at once, and a LIVE probe's first arm set in this very run.
      const step = stepProbe({ p: p0, today, f: c.f, d: c.d, known: true, mode: input.mode, owned: input.owned.has(o.campaignId) })
      if (step.next.status !== 'RUNNING') continue
      created.push(step.next)
      summary.started += 1
      summary.running += 1
      if (o.mode === 'LIVE') summary.live += 1
      const armed = !!step.arm && o.mode === 'LIVE' && input.mode === 'on'
      // The same words as any run of its day (a rerun's why is the first's); why it was picked: the evidence and the ledger.
      say(o, armed ? null : step.note, probeFacts(step.next, { day: 1, arm: o.sequence[0], washout: true, served: step.next.days[today]?.served ?? null, new: true, picked: o.why }))
      if (armed) arms.set(o.targetId, { p: step.next, bidCents: step.arm!.bidCents, words: step.note!.replace(/^probe: /, '') })
    }
  }

  // ── The ledger: new probes (one per keyword and start day, whoever planned it first), changed ones, the old pruned. ──
  if (created.length) {
    await prisma.bidProbe.createMany({
      skipDuplicates: true,
      data: created.map((p) => ({
        id: p.id, marketplace: p.marketplace, campaignId: p.campaignId, adGroupId: p.adGroupId, targetId: p.targetId, productKey: p.productKey,
        mode: p.mode, status: p.status, centerCents: p.centerCents, highCents: p.highCents, lowCents: p.lowCents, amplitude: p.amplitude,
        protection: p.protection, sequence: p.sequence, startDay: dateOf(p.startDay), endDay: dateOf(p.endDay),
        days: p.days as unknown as Prisma.InputJsonValue, why: p.why, runId: input.runId,
      })),
    })
  }
  for (const p of changed) await prisma.bidProbe.update({ where: { id: p.id }, data: { ...changeOf(p), runId: input.runId } })
  await prisma.bidProbe.deleteMany({ where: { status: { in: ['DONE', 'STOPPED'] }, updatedAt: { lt: new Date(input.now.getTime() - KEEP_DAYS * DAY_MS) } } })

  // ── `on`: a LIVE probe's arm is the decision. ──
  const decisions = applyProbeArms(input.decisions, input.facts, arms, input.mode)
  summary.armed = decisions === input.decisions ? 0 : decisions.filter((d, i) => d !== input.decisions[i]).length
  const nothing = !summary.running && !summary.started && !summary.measuring && !summary.done && !summary.stopped
  return { decisions, notes, evidence, summary: nothing ? null : summary }
}

// ── The read view ─────────────────────────────────────────────────────────────────────────────────

/**
 * The bid-brain read tool's view `probes`: the probes of a scope (keywords, or every probe of the markets), newest
 * first, and ε per pool from the probes' readings (the response pools the natural moves on top). Read only.
 */
export async function readProbes(scope: { ids: string[] | null; markets: string[] }, opts: { limit?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date()
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  const rows = scope.ids && !scope.ids.length ? [] : await prisma.bidProbe.findMany({
    where: scope.ids ? { targetId: { in: scope.ids } } : { marketplace: { in: scope.markets } },
    select: PROBE_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit,
  })
  const records = rows.map(recordOf)
  const words = records.length
    ? new Map((await prisma.adTarget.findMany({ where: { id: { in: [...new Set(records.map((r) => r.targetId))] } }, select: { id: true, expressionValue: true, expressionType: true } }))
      .map((t) => [t.id, `${t.expressionValue} (${t.expressionType})`]))
    : new Map<string, string>()
  const markets = [...new Set([...records.map((r) => r.marketplace), ...(scope.ids ? [] : scope.markets)])]
  const readingsBy = new Map(await Promise.all(markets.map(async (mk) => [mk, await loadProbeReadings(mk, now)] as const)))
  const pools: Array<{ market: string; productKey: string | null; eps: number; sd: number; probes: number; marketProbes: number; measured: boolean }> = []
  for (const mk of markets) {
    const readings = readingsBy.get(mk) ?? new Map()
    const keys = new Set<string | null>([...readings.keys(), ...records.filter((r) => r.marketplace === mk).map((r) => r.productKey)])
    for (const key of keys) {
      const e = productEps(new Map(), key, EPS_PRIOR, readings)
      pools.push({ market: mk, productKey: key, eps: round2(e.mean), sd: round2(e.sd), probes: e.ownProbes ?? 0, marketProbes: e.marketProbes ?? 0, measured: e.measured })
    }
  }
  const probes = records.map((p) => {
    const day = scheduleDay(p.sequence, p.startDay, todayIn(p.marketplace, now))
    const own = combineReadings(p.reading ? [p.reading] : [])
    return {
      id: p.id, targetId: p.targetId, keyword: words.get(p.targetId) ?? null, campaignId: p.campaignId, market: p.marketplace, productKey: p.productKey,
      mode: p.mode, status: p.status, sequence: p.sequence, startDay: p.startDay, endDay: p.endDay,
      today: day ? { day: day.index + 1, arm: day.arm, washout: day.washout } : null,
      centerCents: p.centerCents, highCents: p.highCents, lowCents: p.lowCents, amplitudePct: Math.round(p.amplitude * 1000) / 10, protection: p.protection,
      days: p.days, observed: p.observed, reading: own ? { eps: round2(own.eps), sd: round2(Math.sqrt(own.variance)) } : null,
      epsPrior: p.epsPrior, epsPosterior: p.epsPosterior, why: p.why, stoppedWhy: p.stoppedWhy,
      startedAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
    }
  })
  const mode = probeMode()
  return {
    data: {
      view: 'probes', probesMode: mode, markets: scope.markets, probes, pools,
      note: `Switchback probes measure how a keyword's clicks answer its bid (ε): 12 days of two bids around the brain's own (±15 %, ±5 % on a protected, brand or winner term), `
        + `in an order that cancels a steady drift, 6 days on each so the average is the brain's bid; the first day of each switch does not count. `
        + `A LIVE probe (NEXUS_BID_BRAIN_PROBES on, a campaign the brain owns) serves its bids and its reading updates its product's ε (epsPrior → epsPosterior); `
        + `a SHADOW one serves nothing — its measurement is a placebo (both sides the same bid) and feeds nothing. `
        + `pools: ε per product from the probes' readings (the market learns from the other products; measured when the sd is under ${EPS_MEASURED_SD}); the response model adds the natural bid moves. `
        + `Switch: ${mode}${mode === 'shadow' ? ' — planned and logged, no bid changes' : mode === 'on' ? ' — the arms are written for owned campaigns' : ' — nothing runs'}.`,
    },
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100

