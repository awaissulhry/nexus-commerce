/**
 * BID BRAIN BB-6 — the live writer and its small pure parts.
 *
 *   writer     only `write` decisions that move a bid are sent; each through updateAdTargetWithSync with askGate as
 *              automation:bid-brain, with its evidence; a floor is forced; a refusal is counted with its reason
 *   dial       SUGGEST sends nothing and counts would-apply; a used cap defers the rest of the run; a give-back after
 *              a floor (restore) is forced and lands under SUGGEST and with the caps used up (Owner decision S2)
 *   ceiling    `live` only (live.ts); BRAIN_HOLD_DAYS stays the person's 60 days (bid-grid.service.ts)
 *   modes      what each enrollment op leads to, and from where it is refused
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const update = vi.fn()
const enrollmentFindMany = vi.fn(async () => [] as Array<{ campaignId: string }>)
const adGroupFindUnique = vi.fn()
vi.mock('../ads-mutation.service.js', () => ({ updateAdTargetWithSync: (...a: unknown[]) => update(...a) }))
vi.mock('../../../db.js', () => ({
  default: {
    bidBrainEnrollment: { get findMany() { return enrollmentFindMany } },
    adGroup: { get findUnique() { return adGroupFindUnique } },
    adTarget: { findUnique: vi.fn(async () => null) },
  },
}))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { writeOwnedDecisions, isFloorWrite, writeEvidence, writeKind, writeReportWords } = await import('./live-writer.js')
const { makeEngineGuard } = await import('../ads-engine-guard.js')
const { brainLiveCeiling, BRAIN_ACTOR } = await import('./live.js')
const { BRAIN_HOLD_DAYS } = await import('./brain-holds.js')
const { nextMode } = await import('./enrollment.js')
import type { Decision } from './decide.js'

const decision = (over: Partial<Decision> = {}): Decision => ({
  targetId: 't1', action: 'write', layer: 'goal', currentCents: 30, bidCents: 36, goalBidCents: 40, expectedAcos: 0.21,
  goal: { aim: 0.35, lo: 0.315, hi: 0.403 }, confidence: 0.9, dataDay: '2026-10-01', step: { dataDay: '2026-10-01', fromCents: 30, toCents: 36 },
  placements: [], clash: null, why: 'goal: aim 35%; 30¢ → 36¢', ...over,
})
const guard = (posture: 'auto' | 'suggest' | 'stopped' = 'auto', perTick: number | null = null) =>
  makeEngineGuard({ engine: 'bid-brain', posture, why: posture === 'suggest' ? 'the account ads dial is SUGGEST' : 'the account ads dial is AUTO', caps: { perTick, perDay: null }, todayBefore: 0, marketCaps: new Map() })

beforeEach(() => {
  update.mockReset().mockResolvedValue({ ok: true, outboundQueueId: 'q1', actionLogId: 'l1', bidHistoryIds: [], error: null })
  enrollmentFindMany.mockReset().mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe('writeOwnedDecisions', () => {
  it('sends each moving write once, as the brain, with its evidence and askGate', async () => {
    const r = await writeOwnedDecisions([
      { campaignId: 'c1', market: 'IT', decision: decision() },
      { campaignId: 'c1', market: 'IT', decision: decision({ targetId: 't2', action: 'hold', layer: 'band', bidCents: 30 }) },
    ], { runId: 'run-1', guard: guard() })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0]).toMatchObject({
      adTargetId: 't1', patch: { bidCents: 36 }, actor: BRAIN_ACTOR, askGate: true,
      evidence: { source: { kind: 'bid-brain', id: 'run-1' }, brain: { runId: 'run-1', layer: 'goal', dataDay: '2026-10-01', goalBidCents: 40 } },
    })
    expect(update.mock.calls[0][0].force).toBeUndefined()
    expect(r).toMatchObject({ queued: 1, refused: 0 })
    expect(r.byTarget.get('t1')).toEqual({ sent: 'queued', outboundQueueId: 'q1', actionLogId: 'l1' })
    expect(writeReportWords(r)).toBe('queued=1')
  })

  it('forces a floor (a lowering by a stop, stock, the phase or a Min-bid hour) and never a raise', async () => {
    await writeOwnedDecisions([{ campaignId: 'c1', market: 'IT', decision: decision({ layer: 'stop', bidCents: 2, currentCents: 30 }) }], { runId: 'r', guard: guard() })
    expect(update.mock.calls[0][0]).toMatchObject({ patch: { bidCents: 2 }, force: true })
    expect(isFloorWrite({ layer: 'min_bid_hour', bidCents: 2, currentCents: 20 })).toBe(true)
    expect(isFloorWrite({ layer: 'stock', bidCents: 25, currentCents: 20 })).toBe(false)
    expect(isFloorWrite({ layer: 'goal', bidCents: 10, currentCents: 20 })).toBe(false)
  })

  it('BB-7 — forces a give-back after a floor, so the step clamp does not bring it back 25 % a write', async () => {
    await writeOwnedDecisions([{ campaignId: 'c1', market: 'IT', decision: decision({ layer: 'restore' as Decision['layer'], currentCents: 3, bidCents: 45 }) }], { runId: 'r', guard: guard() })
    expect(update.mock.calls[0][0]).toMatchObject({ patch: { bidCents: 45 }, force: true })
    update.mockClear()
    // An ordinary raise is not forced: the mutation layer's step clamp still holds it.
    await writeOwnedDecisions([{ campaignId: 'c1', market: 'IT', decision: decision({ currentCents: 30, bidCents: 36 }) }], { runId: 'r', guard: guard() })
    expect(update.mock.calls[0][0].force).toBeUndefined()
  })

  it('counts a refusal with its reason, and a write with nothing to change as unchanged', async () => {
    update.mockResolvedValueOnce({ ok: false, outboundQueueId: null, actionLogId: null, bidHistoryIds: [], error: 'Not sent to Amazon: refused' })
      .mockResolvedValueOnce({ ok: true, outboundQueueId: null, actionLogId: null, bidHistoryIds: [], error: null })
    const r = await writeOwnedDecisions([
      { campaignId: 'c1', market: 'IT', decision: decision() },
      { campaignId: 'c1', market: 'IT', decision: decision({ targetId: 't2' }) },
    ], { runId: 'r', guard: guard() })
    expect(r).toMatchObject({ queued: 0, refused: 1, unchanged: 1, refusedReasons: ['Not sent to Amazon: refused'] })
  })

  it('SUGGEST sends nothing and counts would-apply; a used cap defers the rest to the next run', async () => {
    const s = await writeOwnedDecisions([{ campaignId: 'c1', market: 'IT', decision: decision() }], { runId: 'r', guard: guard('suggest') })
    expect(update).not.toHaveBeenCalled()
    expect(s).toMatchObject({ wouldApply: 1, queued: 0 })
    const g = guard('auto', 1)
    const c = await writeOwnedDecisions([
      { campaignId: 'c1', market: 'IT', decision: decision() },
      { campaignId: 'c2', market: 'IT', decision: decision({ targetId: 't9' }) },
    ], { runId: 'r', guard: g })
    expect(c).toMatchObject({ queued: 1, deferred: 1 })
    expect(c.byTarget.get('t9')).toMatchObject({ sent: 'deferred' })
    expect(g.report().deferredByCap).toBe(1)
  })

  it('a give-back after a floor is a restore: forced, and it lands under SUGGEST and with the caps used up', async () => {
    const back = decision({ targetId: 'tb', layer: 'restore' as Decision['layer'], currentCents: 3, bidCents: 45 })
    expect(writeKind(back)).toBe('restore')
    expect(writeKind(decision({ layer: 'min_bid_hour', currentCents: 45, bidCents: 3 }))).toBe('floor')
    expect(writeKind(decision())).toBe('forward')
    // SUGGEST: the raise waits, the give-back goes.
    const s = await writeOwnedDecisions([
      { campaignId: 'c1', market: 'IT', decision: decision() },
      { campaignId: 'c1', market: 'IT', decision: back },
    ], { runId: 'r', guard: guard('suggest') })
    expect(s).toMatchObject({ wouldApply: 1, queued: 1 })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0]).toMatchObject({ adTargetId: 'tb', patch: { bidCents: 45 }, force: true })
    update.mockClear()
    // The run's cap used up by c1: c2's raise is deferred, c3's give-back still lands.
    const g = guard('auto', 1)
    const c = await writeOwnedDecisions([
      { campaignId: 'c1', market: 'IT', decision: decision() },
      { campaignId: 'c2', market: 'IT', decision: decision({ targetId: 't9' }) },
      { campaignId: 'c3', market: 'IT', decision: { ...back, targetId: 'tc' } },
    ], { runId: 'r', guard: g })
    expect(c).toMatchObject({ queued: 2, deferred: 1 })
    expect(c.byTarget.get('tc')).toMatchObject({ sent: 'queued' })
    // An ordinary raise is not forced: the mutation layer's step clamp still holds it.
    expect(update.mock.calls.find((call) => call[0].adTargetId === 't1')?.[0].force).toBeUndefined()
  })

  it('writeEvidence rounds the expected ACoS and keeps the why', () => {
    expect(writeEvidence(decision({ expectedAcos: 0.212345 }), 'r')).toMatchObject({ metric: 'expectedAcos', observed: 0.2123, threshold: 0.35, note: 'goal: aim 35%; 30¢ → 36¢' })
  })
})

describe('the ceiling, the hold days and the enrollment modes', () => {
  it('live only when the env says live', () => {
    expect(brainLiveCeiling('live')).toBe(true)
    expect(brainLiveCeiling(' LIVE ')).toBe(true)
    for (const v of [undefined, '', 'shadow', 'off', 'on', '1']) expect(brainLiveCeiling(v), String(v)).toBe(false)
  })

  it('a person\'s hold lasts as long as a person\'s bid does today', async () => {
    const { PERSON_BID_HOLD_DAYS } = await vi.importActual<typeof import('../bid-grid.service.js')>('../bid-grid.service.js')
    expect(BRAIN_HOLD_DAYS).toBe(PERSON_BID_HOLD_DAYS)
  })

  it('each op leads to one mode, and is refused where it cannot start', () => {
    expect(nextMode('live', null)).toEqual({ to: 'LIVE' })
    expect(nextMode('live', 'LIVE')).toEqual({ refusal: 'it is already LIVE' })
    expect(nextMode('live', 'HELD')).toMatchObject({ refusal: expect.stringMatching(/release the hold/) })
    expect(nextMode('hold', 'LIVE')).toEqual({ to: 'HELD' })
    expect(nextMode('hold', 'SHADOW')).toMatchObject({ refusal: expect.any(String) })
    expect(nextMode('release', 'HELD')).toEqual({ to: 'LIVE' })
    expect(nextMode('shadow', 'HELD')).toEqual({ to: 'SHADOW' })
    expect(nextMode('give-back', 'LIVE')).toEqual({ to: 'SHADOW' })
    expect(nextMode('give-back', null)).toMatchObject({ refusal: expect.stringMatching(/nothing to give back/) })
  })
})
