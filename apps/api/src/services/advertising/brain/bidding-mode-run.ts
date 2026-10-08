/**
 * ONE BRAIN AB-17 — one run of the bidding-strategy lever (brain/bidding-mode.ts decides, brain/bidding-mode-load.ts reads):
 * for every product whose biddingStrategy lever is OBSERVE or higher, each campaign's strategy decided and acted on at its
 * level, its switchback test followed, and logged (AdsBrainStrategyDecision). Run by the product cycle's weekly step
 * (brain/cycle-steps.ts biddingStep, after hours); `weekly` says whether new switches are decided this run.
 *
 *   clock     the N4 clock (AdsBrainLeverClock): started when the lever is first seen the brain's on the product (from the
 *             Owner's choice that made it so, never before the enrollment), removed when it is not — a later enrollment
 *             starts a new one
 *   follow    each open test followed to now (bidding-mode.ts followTest) and stored: a request approved and run starts the
 *             test (TESTING) or ends it switched back (REVERTED), one declined is DECLINED (a switch back declined: KEPT), a
 *             switch that did not land FAILED, one auto-undo put back or moved since ENDED
 *   OBSERVE   logged only (SHADOW): what the brain would switch, test and switch back
 *   PROPOSE   (and AUTO for the first strategyApprovalDays, or under ALWAYS_PROPOSE — N4) a request per switch through the
 *             normal approval gate: set-campaign-settings asked as "Nexus ads brain" (agent run ads-brain-strategy, its
 *             entity the test), never twice for one test; the person who approves it runs it as himself, and the switch
 *             is the brain's own (no STRATEGY hold: bid-brain/brain-holds.ts)
 *   AUTO      the strategy written as the brain (BRAIN_STRATEGY_ACTOR) through the normal campaign path —
 *             updateCampaignWithSync asks the write gate before anything is written (askGate), then the queue, the gate
 *             again at dispatch, the channel gateway (hard rule 4). The gate lets it through only where a product's brain
 *             owns the campaign's biddingStrategy lever and no stop holds the campaign
 *   tests     a switch made or asked for opens a test (AdsBrainStrategyTest); its verdict keeps it (KEPT) or switches it
 *             back — written at AUTO (REVERTED), asked otherwise (REVERT_ASKED)
 *   log       a row when a campaign's decision changes (decisionHash), plus the UTC day's first while a test runs or a
 *             request waits; a write or request refused today is tried again tomorrow (UTC). Log rows older than 30 days and
 *             closed tests older than 180 days are deleted at every run, also when nothing is watched (Neon cost); a test
 *             of a product no longer watched is closed ENDED
 * Each product is decided on its own; one that fails is named in the run and the others still run.
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { autoUndoThresholds } from '../ads-auto-undo-thresholds.js'
import { readEnginePosture } from '../ads-engine-guard.js'
import { BRAIN_STRATEGY_ACTOR } from '../ads-write-gate.js'
import { BRAIN_STRATEGY_AGENT_KEY } from '../bid-brain/brain-holds.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import {
  DECISION_DAYS_KEPT, decideMode, modeDecisionHash, modeRowKind, OPEN_TEST_STATUSES, TEST_DAYS_KEPT, weeklyRun, words,
  type ModeContext, type ModeDecision, type TestStatus,
} from './bidding-mode.js'
import { loadProductModeFacts, modeWatchProducts, type ModeWatched } from './bidding-mode-load.js'

const DAY_MS = 86_400_000
/** What the brain's requests are asked as, in Nexus's approval queue. */
export const STRATEGY_REQUESTER = 'Nexus ads brain'
/** The evidence layers of the lever's writes: a switch, a switch back after a test (never a stop's: AB-15 judges both). */
export const SWITCH_LAYER = 'bidding_mode'
export const REVERT_LAYER = 'switchback'
/** Amazon's names of the strategies, as set-campaign-settings takes them. */
export const TOOL_STRATEGY: Record<string, string> = { LEGACY_FOR_SALES: 'legacyForSales', AUTO_FOR_SALES: 'autoForSales', MANUAL: 'manual' }

export type ModeRunOutcome = 'shadow' | 'asked' | 'queued' | 'waiting' | 'held' | 'refused' | 'none'

/** Ask a person for one switch (its test's id the request's entity): the approval, or why it was not asked. */
export type AskFn = (entityId: string, args: { campaignIds: string[]; biddingStrategy: string; why: string }) => Promise<{ approvalId: string } | { error: string }>
/** Write one campaign's strategy as the brain (AUTO): queued with its action-log row, or why not. */
export type WriteFn = (w: { campaignId: string; to: string; reason: string; runId: string; layer: string; dataDay: string }) => Promise<{ queued: boolean; actionLogId: string | null; error: string | null }>

export interface ModeRunCampaign { campaignId: string; productId: string; market: string; action: string; outcome: ModeRunOutcome; to: string | null; stored: 'change' | 'snapshot' | null; why: string; approvalId?: string | null; testId?: string | null }

export interface ModeRun {
  runId: string
  ran: boolean
  why: string
  weekly: boolean
  campaigns: ModeRunCampaign[]
  /** Tests whose state moved this run (followed, closed, opened). */
  tests: Array<{ testId: string; campaignId: string; status: TestStatus; why: string }>
  failed: Array<{ productId: string; market: string; error: string }>
  pruned: { decisions: number; tests: number; ended: number }
}

/** The default ask: through the normal approval gate as "Nexus ads brain", always a request (forceAsk), once per entity. */
export const askThroughApprovals: AskFn = async (entityId, args) => {
  const earlier = await prisma.agentApproval.findFirst({ where: { agentRun: { agentKey: BRAIN_STRATEGY_AGENT_KEY, entityId } }, orderBy: { requestedAt: 'desc' }, select: { id: true } })
  if (earlier) return { approvalId: earlier.id }
  const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const tool = 'set-campaign-settings'
  const run = await prisma.agentRun.create({ data: { agentKey: BRAIN_STRATEGY_AGENT_KEY, entityId, trigger: 'schedule', status: 'running', input: { tool, args } as Prisma.InputJsonValue } })
  const asked = await runOrQueueTool(tool, args, systemPrincipal(STRATEGY_REQUESTER), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, endedAt: new Date(), output: { mode: 'queued', approvalId: asked.approvalId ?? null } } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: (asked.error ?? 'not queued').slice(0, 500) },
  })
  return queued ? { approvalId: asked.approvalId! } : { error: asked.error ?? 'the request was not queued' }
}

/** The default write: the campaign path as the brain, asking the gate before anything is written. */
export const writeAsTheBrain: WriteFn = async (w) => {
  const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
  const out = await updateCampaignWithSync({
    campaignId: w.campaignId,
    patch: { biddingStrategy: w.to as 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL' },
    actor: BRAIN_STRATEGY_ACTOR,
    reason: `The ads brain: ${w.reason}`.slice(0, 480),
    evidence: { metric: 'biddingStrategy', note: w.reason.slice(0, 1_000), source: { kind: 'ads-brain', id: w.runId }, brain: { runId: w.runId, layer: w.layer, dataDay: w.dataDay, goalBidCents: null } },
    askGate: true,
    changeSetId: w.runId,
  })
  if (out.ok && out.error !== 'no_changes') return { queued: true, actionLogId: out.actionLogId ?? null, error: null }
  return { queued: false, actionLogId: null, error: out.ok ? 'already at that strategy' : out.error ?? 'refused' }
}

/** Delete the log rows older than DECISION_DAYS_KEPT days and the closed tests older than TEST_DAYS_KEPT days. */
export async function pruneModeRows(now: Date): Promise<{ decisions: number; tests: number }> {
  const [decisions, tests] = await Promise.all([
    prisma.adsBrainStrategyDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DECISION_DAYS_KEPT * DAY_MS) } } }),
    prisma.adsBrainStrategyTest.deleteMany({ where: { status: { notIn: [...OPEN_TEST_STATUSES] }, updatedAt: { lt: new Date(now.getTime() - TEST_DAYS_KEPT * DAY_MS) } } }),
  ])
  return { decisions: decisions.count, tests: tests.count }
}

/** Close the open tests of products the lever no longer watches (it left the brain, or its lever went OFF everywhere). */
async function endUnwatchedTests(watched: readonly ModeWatched[], now: Date): Promise<number> {
  const keep = new Set(watched.map((w) => `${w.market}|${w.productId}`))
  const open = await prisma.adsBrainStrategyTest.findMany({ where: { status: { in: [...OPEN_TEST_STATUSES] } }, select: { id: true, productId: true, marketplace: true, why: true } })
  const gone = open.filter((t) => !keep.has(`${t.marketplace}|${t.productId}`))
  for (const t of gone) {
    await prisma.adsBrainStrategyTest.updateMany({ where: { id: t.id, status: { in: [...OPEN_TEST_STATUSES] } }, data: { status: 'ENDED', why: `${t.why} — ended ${now.toISOString().slice(0, 10)}: the product's bidding-strategy lever is no longer watched (OFF, or the product left the brain); the strategy stays as it is` } })
  }
  return gone.length
}

/** Keep the N4 clock of a product's lever: started when first seen owned, removed when not. The clock now (null: none). */
export async function keepClock(p: { productId: string; market: string; owned: boolean; ownedBy: { at: Date; by: string } | null; clock: { since: Date; by: string } | null; enrolledAt: Date | null }, now: Date, runId: string): Promise<Date | null> {
  const key = { product_market_lever: workspaceKey({ productId: p.productId, marketplace: p.market, lever: 'biddingStrategy' }) }
  if (!p.owned) {
    if (p.clock) await prisma.adsBrainLeverClock.deleteMany({ where: { productId: p.productId, marketplace: p.market, lever: 'biddingStrategy' } })
    return null
  }
  if (p.clock) {
    await prisma.adsBrainLeverClock.updateMany({ where: { productId: p.productId, marketplace: p.market, lever: 'biddingStrategy' }, data: { seenAt: now } })
    return p.clock.since
  }
  // The Owner's choice that made it the brain's (never before the enrollment, never in the future); else this run.
  const from = p.ownedBy ? new Date(Math.min(now.getTime(), Math.max(p.ownedBy.at.getTime(), p.enrolledAt?.getTime() ?? 0))) : now
  const row = await prisma.adsBrainLeverClock.upsert({
    where: key,
    create: { productId: p.productId, marketplace: p.market, lever: 'biddingStrategy', since: from, by: p.ownedBy?.by ?? `the brain's run ${runId}`, seenAt: now },
    update: { seenAt: now },
    select: { since: true },
  })
  return row.since
}

const utcDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10)
const append = (why: string, more: string) => `${why} | ${more}`.slice(-4_000)

/**
 * One run: the prunes (also when nothing is watched any more), then every watched product, market by market, each campaign
 * decided, acted on at its level and logged. `weekly` (default: Monday in Europe/Rome) decides new switches; `stopping` names
 * the campaigns the cycle's state step is pausing now (a stop). `ask` and `write` are seams for tests.
 */
export async function runBiddingModeOnce(opts: { now?: Date; products?: readonly ModeWatched[]; weekly?: boolean; stopping?: ReadonlyMap<string, string>; ask?: AskFn; write?: WriteFn } = {}): Promise<ModeRun> {
  const now = opts.now ?? new Date()
  const runId = `bm-${now.toISOString().slice(0, 16)}-${randomUUID().slice(0, 8)}`
  const ask = opts.ask ?? askThroughApprovals
  const write = opts.write ?? writeAsTheBrain
  const week = weeklyRun(now)
  const weekly = opts.weekly ?? week.weekly
  const allWatched = await modeWatchProducts()
  const products = opts.products ?? allWatched
  const pruned = await pruneModeRows(now)
  const out: ModeRun = { runId, ran: false, why: '', weekly, campaigns: [], tests: [], failed: [], pruned: { ...pruned, ended: await endUnwatchedTests(allWatched, now) } }
  if (!products.length) { out.why = 'no enrolled product has its bidding-strategy lever at OBSERVE or higher: nothing decided, nothing written'; return out }
  out.ran = true
  out.why = `${products.length} product${products.length === 1 ? '' : 's'} with the bidding-strategy lever at OBSERVE or higher${weekly ? ' (the weekly run: new switches decided)' : ' (verdicts and requests only: new switches on the weekly run)'}`
  const ceilingLive = brainLiveCeiling()
  const posture = await readEnginePosture()
  for (const p of products) {
    try {
      const loaded = await loadProductModeFacts(p.productId, p.market, { now, stopping: opts.stopping })
      if (!loaded) throw new Error(`product ${p.productId} has no family root in ${p.market}`)
      const market = loaded.market
      const clockSince = await keepClock({ productId: loaded.productId, market, owned: loaded.owned, ownedBy: loaded.ownedBy, clock: loaded.clock, enrolledAt: loaded.enrolledAt }, now, runId)
      // Each open test followed to now, stored before the decisions read it.
      for (const [campaignId, { record, followed }] of loaded.followed) {
        if (!followed.why) continue
        await prisma.adsBrainStrategyTest.update({
          where: { id: record.id },
          data: {
            status: followed.status, switchedAt: followed.switchedAt, actionLogId: followed.actionLogId,
            ...(followed.revertedAt ? { revertedAt: followed.revertedAt, revertActionLogId: followed.revertActionLogId } : {}),
            ...(followed.verdict ? { verdict: followed.verdict, verdictAt: now } : {}),
            why: append(record.why, followed.why),
          },
        })
        out.tests.push({ testId: record.id, campaignId, status: followed.status, why: followed.why })
      }
      const ctx: ModeContext = { now, ceilingLive, posture, weekly, nextWeekly: week.next, thresholds: autoUndoThresholds(market), settledThrough: loaded.settledThrough }
      const decisions: ModeDecision[] = loaded.facts.map((f) => decideMode({ ...f, clockSince: loaded.owned ? clockSince : null }, ctx))
      const final = new Map<string, { outcome: ModeRunOutcome; approvalId: string | null; testId: string | null; error: string | null }>()
      for (const d of decisions) {
        const prev = loaded.previous.get(d.campaignId)
        // A write or request refused today is tried again tomorrow (UTC), not every run: its refusal stands meanwhile.
        if ((d.outcome === 'ask' || d.outcome === 'write') && prev?.action === d.action && prev.outcome === 'refused' && utcDay(prev.createdAt) === utcDay(now)) {
          final.set(d.campaignId, { outcome: 'refused', approvalId: null, testId: d.testId, error: `refused at ${prev.createdAt.toISOString().slice(11, 16)} UTC — tried again tomorrow (UTC)` })
          continue
        }
        // A test closed by the decision (kept, ended, or the lever in shadow now).
        if (d.closeTest && d.testId) {
          const w = d.closeTest.window
          await prisma.adsBrainStrategyTest.update({
            where: { id: d.testId },
            data: {
              status: d.closeTest.status, why: append(loaded.followed.get(d.campaignId)?.record.why ?? '', d.closeTest.why),
              ...(d.closeTest.verdict ? { verdict: d.closeTest.verdict, verdictAt: now, figures: { before: d.closeTest.before ?? null, after: d.closeTest.after ?? null, weeks: w?.weeks ?? null } as unknown as Prisma.InputJsonValue } : {}),
              ...(w ? { baselineFrom: new Date(`${w.baseline.from}T00:00:00Z`), baselineTo: new Date(`${w.baseline.to}T00:00:00Z`), testFrom: new Date(`${w.test.from}T00:00:00Z`), testTo: new Date(`${w.test.to}T00:00:00Z`) } : {}),
            },
          })
          out.tests.push({ testId: d.testId, campaignId: d.campaignId, status: d.closeTest.status, why: d.closeTest.why })
        }
        if (d.outcome === 'ask' || d.outcome === 'write') final.set(d.campaignId, await actOn(d, { runId, now, ask, write, dataDay: loaded.settledThrough, testWhy: loaded.followed.get(d.campaignId)?.record.why ?? '' }, out))
      }
      // Log what changed (and the day's first while a test runs or a request waits).
      const data: Prisma.AdsBrainStrategyDecisionCreateManyInput[] = []
      for (const d of decisions) {
        const f = final.get(d.campaignId)
        const outcome: ModeRunOutcome = f?.outcome ?? (d.outcome === 'ask' || d.outcome === 'write' ? 'refused' : d.outcome)
        const approvalId = f?.approvalId ?? d.approvalId ?? null
        const testId = f?.testId ?? d.testId ?? null
        const why = f?.error ? `${d.why} — not done: ${f.error}` : d.why
        const testStatus = d.closeTest?.status ?? (outcome === 'queued' ? (d.action === 'revert' ? 'REVERTED' : 'TESTING') : outcome === 'asked' ? (d.action === 'revert' ? 'REVERT_ASKED' : 'ASKED') : d.test?.status ?? null)
        const hash = modeDecisionHash({ ...d, outcome, approvalId, testId, testStatus, refusedOn: outcome === 'refused' ? utcDay(now) : null })
        const carries = !!testStatus && (OPEN_TEST_STATUSES as readonly string[]).includes(testStatus)
        const kind = modeRowKind(hash, carries, loaded.previous.get(d.campaignId), now)
        out.campaigns.push({ campaignId: d.campaignId, productId: d.productId, market, action: d.action, outcome, to: d.to, stored: kind, why, approvalId, testId })
        if (!kind) continue
        const record = { ...d, outcome, approvalId, testId, testStatus, why }
        data.push({
          runId, mode: d.mode, kind, productId: d.productId, marketplace: market, campaignId: d.campaignId, level: d.level, action: d.action, outcome,
          rule: d.rule, fromStrategy: d.current, toStrategy: d.to, approvalId, testId, decisionHash: hash,
          decision: record as unknown as Prisma.InputJsonObject, why, createdAt: now,
        })
      }
      if (data.length) await prisma.adsBrainStrategyDecision.createMany({ data })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.error('[brain-bidding-mode] product run failed', { productId: p.productId, market: p.market, error })
      out.failed.push({ productId: p.productId, market: p.market, error })
    }
  }
  const acted = out.campaigns.filter((c) => c.outcome === 'queued' || c.outcome === 'asked')
  if (acted.length) logger.info('[brain-bidding-mode] the brain acted on bidding strategies', { runId, acted: acted.map((c) => ({ campaignId: c.campaignId, action: c.action, to: c.to, outcome: c.outcome, approvalId: c.approvalId ?? null })) })
  return out
}

/** Ask for, or write, one switch or switch back, and keep its test: opened (ASKED / TESTING) or moved (REVERT_ASKED / REVERTED). */
async function actOn(d: ModeDecision, x: { runId: string; now: Date; ask: AskFn; write: WriteFn; dataDay: string; testWhy: string }, out: ModeRun): Promise<{ outcome: ModeRunOutcome; approvalId: string | null; testId: string | null; error: string | null }> {
  const to = d.to!
  if (d.action === 'switch') {
    const test = await prisma.adsBrainStrategyTest.create({
      data: { productId: d.productId, marketplace: d.market, campaignId: d.campaignId, fromStrategy: d.current, toStrategy: to, rule: d.rule, level: d.level, status: 'ASKED', why: `${x.now.toISOString().slice(0, 10)}: ${d.why}`.slice(0, 4_000) },
      select: { id: true, why: true },
    })
    if (d.outcome === 'ask') {
      const r = await x.ask(test.id, { campaignIds: [d.campaignId], biddingStrategy: TOOL_STRATEGY[to] ?? to, why: `The ads brain: ${words(d.current)} → ${words(to)} — ${d.target?.why ?? d.why}`.slice(0, 300) })
      if ('approvalId' in r) {
        await prisma.adsBrainStrategyTest.update({ where: { id: test.id }, data: { approvalId: r.approvalId } })
        out.tests.push({ testId: test.id, campaignId: d.campaignId, status: 'ASKED', why: d.why })
        return { outcome: 'asked', approvalId: r.approvalId, testId: test.id, error: null }
      }
      await prisma.adsBrainStrategyTest.update({ where: { id: test.id }, data: { status: 'REFUSED', why: append(test.why, `not asked: ${r.error}`) } })
      return { outcome: 'refused', approvalId: null, testId: test.id, error: r.error }
    }
    const r = await x.write({ campaignId: d.campaignId, to, reason: d.why, runId: x.runId, layer: 'bidding_mode', dataDay: x.dataDay })
    if (r.queued) {
      await prisma.adsBrainStrategyTest.update({ where: { id: test.id }, data: { status: 'TESTING', switchedAt: x.now, actionLogId: r.actionLogId } })
      out.tests.push({ testId: test.id, campaignId: d.campaignId, status: 'TESTING', why: d.why })
      return { outcome: 'queued', approvalId: null, testId: test.id, error: null }
    }
    await prisma.adsBrainStrategyTest.update({ where: { id: test.id }, data: { status: 'REFUSED', why: append(test.why, `not written: ${r.error}`) } })
    return { outcome: 'refused', approvalId: null, testId: test.id, error: r.error }
  }
  // A switch back after a verdict to revert: its test moves on.
  const testId = d.testId!
  const verdict = { verdict: 'revert', verdictAt: x.now, figures: { before: d.test?.figures?.before ?? null, after: d.test?.figures?.after ?? null, weeks: d.test?.window?.weeks ?? null } as unknown as Prisma.InputJsonValue, ...(d.test?.window ? { baselineFrom: new Date(`${d.test.window.baseline.from}T00:00:00Z`), baselineTo: new Date(`${d.test.window.baseline.to}T00:00:00Z`), testFrom: new Date(`${d.test.window.test.from}T00:00:00Z`), testTo: new Date(`${d.test.window.test.to}T00:00:00Z`) } : {}) }
  if (d.outcome === 'ask') {
    const r = await x.ask(`${testId}:revert`, { campaignIds: [d.campaignId], biddingStrategy: TOOL_STRATEGY[to] ?? to, why: `The ads brain: back to ${words(to)} — ${d.why}`.slice(0, 300) })
    if ('approvalId' in r) {
      await prisma.adsBrainStrategyTest.update({ where: { id: testId }, data: { status: 'REVERT_ASKED', revertApprovalId: r.approvalId, ...verdict, why: append(x.testWhy, d.why) } })
      out.tests.push({ testId, campaignId: d.campaignId, status: 'REVERT_ASKED', why: d.why })
      return { outcome: 'asked', approvalId: r.approvalId, testId, error: null }
    }
    return { outcome: 'refused', approvalId: null, testId, error: r.error }
  }
  const r = await x.write({ campaignId: d.campaignId, to, reason: d.why, runId: x.runId, layer: REVERT_LAYER, dataDay: x.dataDay })
  if (r.queued) {
    await prisma.adsBrainStrategyTest.update({ where: { id: testId }, data: { status: 'REVERTED', revertedAt: x.now, revertActionLogId: r.actionLogId, ...verdict, why: append(x.testWhy, d.why) } })
    out.tests.push({ testId, campaignId: d.campaignId, status: 'REVERTED', why: d.why })
    return { outcome: 'queued', approvalId: null, testId, error: null }
  }
  return { outcome: 'refused', approvalId: null, testId, error: r.error }
}

/** The run's summary line: "STRATEGY IT: switch asked 1, keep 3, test 1 · tests TESTING 1 · pruned=<n>". */
export function modeSummaryLine(r: ModeRun): string {
  const pruned = `pruned=${r.pruned.decisions}/${r.pruned.tests}${r.pruned.ended ? ` ended=${r.pruned.ended}` : ''}`
  if (!r.ran) return `${r.why} · ${pruned}`
  const markets = [...new Set(r.campaigns.map((c) => c.market))]
  const parts = markets.map((m) => {
    const counts = new Map<string, number>()
    for (const c of r.campaigns.filter((x) => x.market === m)) {
      const key = c.action === 'switch' || c.action === 'revert' ? `${c.action} ${c.outcome}` : c.action
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return `${m}: ${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')}`
  })
  const tests = r.tests.length ? [`tests ${[...new Map(r.tests.map((t) => [t.status, r.tests.filter((x) => x.status === t.status).length])).entries()].map(([s, n]) => `${s} ${n}`).join(', ')}`] : []
  const failed = r.failed.map((f) => `${f.market} ${f.productId} failed: ${f.error}`)
  return `STRATEGY${r.weekly ? ' (weekly)' : ''} ${[...parts, ...tests, ...failed].join(' · ') || 'no campaign'} · ${pruned}`
}
