/**
 * Review fix 10-10 (2) — a give-back that carries the goal's raise above the bid before it is a forward move.
 *
 * The give-back after a floor was written as a `restore` whatever its bid: so the goal's raise it carries (one step above
 * the bid before, decided with evidence) passed the SUGGEST dial and was never refused by the run's or the market's caps.
 * Now: up to the bid before it is a give-back (exact, passes the dial and the caps, as Owner decision S2 wants); above it,
 * a forward move — the dial and the caps judge it, and when they hold it only the bid before goes back (stored as such,
 * with no step taken). It stays exact: decide() took the step from the bid before; the mutation's step clamp would
 * measure it from the floor.
 *
 * Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const update = vi.fn()
vi.mock('../ads-mutation.service.js', () => ({ updateAdTargetWithSync: (...a: unknown[]) => update(...a) }))
vi.mock('../../../db.js', () => ({ default: {} }))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { writeOwnedDecisions, writeKind, isExactWrite } = await import('./live-writer.js')
const { storedDecision } = await import('./shadow.js')
const { decide } = await import('./decide.js')
const { makeEngineGuard } = await import('../ads-engine-guard.js')
import type { Decision, GiveBack } from './decide.js'

/** The give-back after the night floor: from 2¢, the bid before it 12¢, the goal's raise to 15¢. */
const giveBack = (over: Partial<Decision> = {}): Decision => ({
  targetId: 't1', action: 'write', layer: 'restore', currentCents: 2, bidCents: 15, goalBidCents: 16, expectedAcos: null, goal: null, confidence: null,
  dataDay: '2026-10-01', step: { dataDay: '2026-10-01', fromCents: 12, toCents: 15 }, placements: [], clash: null,
  why: 'restore: the min-bid_hour layer no longer applies → back to 15¢', restoreBeforeCents: 12, ...over,
})
const guard = (posture: 'auto' | 'suggest' = 'auto', perTick: number | null = null) =>
  makeEngineGuard({ engine: 'bid-brain', posture, why: posture === 'suggest' ? 'the account ads dial is SUGGEST' : 'the account ads dial is AUTO', caps: { perTick, perDay: null }, todayBefore: 0, marketCaps: new Map() })

beforeEach(() => { update.mockReset().mockResolvedValue({ ok: true, outboundQueueId: 'q1', actionLogId: 'l1', bidHistoryIds: [], error: null }) })

describe('a give-back above the bid before it', () => {
  it('is a forward move (the dial and the caps judge it); up to the bid before, a give-back; both exact', () => {
    expect(writeKind(giveBack())).toBe('forward')
    expect(writeKind(giveBack({ bidCents: 12 }))).toBe('restore')
    expect(writeKind(giveBack({ bidCents: 10 }))).toBe('restore')
    expect(isExactWrite(giveBack())).toBe(true)
  })

  it('under AUTO it is written whole', async () => {
    const r = await writeOwnedDecisions([{ campaignId: 'c1', market: 'IT', decision: giveBack() }], { runId: 'r', guard: guard() })
    expect(update.mock.calls[0][0]).toMatchObject({ patch: { bidCents: 15 }, force: true })
    expect(r.byTarget.get('t1')).toEqual({ sent: 'queued', outboundQueueId: 'q1', actionLogId: 'l1' })
  })

  it('under SUGGEST only the bid before goes back; the raise waits and says why', async () => {
    const r = await writeOwnedDecisions([{ campaignId: 'c1', market: 'IT', decision: giveBack() }], { runId: 'r', guard: guard('suggest') })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0]).toMatchObject({ patch: { bidCents: 12 }, force: true })
    expect(r.byTarget.get('t1')).toEqual({ sent: 'queued', outboundQueueId: 'q1', actionLogId: 'l1', heldAt: { cents: 12, why: 'the account ads dial is SUGGEST' } })
  })

  it('with the run\'s cap used up, the same: the bid before goes back, the raise waits for the next run', async () => {
    const ordinary = { targetId: 't0', action: 'write' as const, layer: 'goal' as const, currentCents: 20, bidCents: 24, goalBidCents: 24, expectedAcos: null, goal: null, confidence: null, dataDay: '2026-10-01', step: null, placements: [], clash: null, why: 'goal' }
    const r = await writeOwnedDecisions([
      { campaignId: 'c0', market: 'IT', decision: ordinary },
      { campaignId: 'c1', market: 'IT', decision: giveBack() },
    ], { runId: 'r', guard: guard('auto', 1) })
    expect(update.mock.calls.map((c) => c[0].patch.bidCents)).toEqual([24, 12])
    expect(r.byTarget.get('t1')).toMatchObject({ sent: 'queued', heldAt: { cents: 12, why: expect.stringMatching(/caps for this run are used/) } })
  })
})

describe('decided and stored', () => {
  it('decide() says the bid before on every give-back', () => {
    const memo: GiveBack = { dataDay: '2026-10-01', fromCents: 12, cents: 15, goalBidCents: 16, step: { dataDay: '2026-10-01', fromCents: 12, toCents: 15 }, why: 'goal: test' }
    const d = decide({
      targetId: 't1', currentCents: 2, dataDay: '2026-10-01', chain: [], goal: { target: { kind: 'ACOS', pct: 20 }, band: null, phase: 'PROFIT' }, limits: { maxBidCents: 80, maxChangePct: 25 },
      restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 12, foundCents: 12, giveBack: memo },
    })
    expect([d.layer, d.bidCents, d.restoreBeforeCents]).toEqual(['restore', 15, 12])
    expect(writeKind(d)).toBe('forward')
  })

  it('only the bid before went back: stored as written, no step taken, and why', () => {
    const s = storedDecision(giveBack(), { sent: 'queued', outboundQueueId: 'q1', actionLogId: 'l1', heldAt: { cents: 12, why: 'the account ads dial is SUGGEST' } })
    expect([s.bidCents, s.step]).toEqual([12, { dataDay: '2026-10-01', fromCents: 12, toCents: 12 }])
    expect(s.why).toMatch(/only the bid before it went back: the raise to 15¢ waits \(the account ads dial is SUGGEST\)$/)
    expect(storedDecision(giveBack(), { sent: 'queued', outboundQueueId: 'q1', actionLogId: 'l1' })).toEqual(giveBack())
  })

  it('re-review minor — a plan raise the caps deferred keeps the brain\'s own bid in memory (the next tick asks again)', () => {
    const raise: Decision = { ...giveBack(), layer: 'plan_hour', currentCents: 15, bidCents: 25, restoreBeforeCents: null, why: 'plan hour: back to the brain\'s own bid 25¢' }
    expect(storedDecision(raise, { sent: 'deferred', why: 'the bid brain\'s caps for this run are used: it goes next run' }).beforeHour).toBe(25)
    expect(storedDecision(raise, { sent: 'would-apply', why: 'the account ads dial is SUGGEST' }).beforeHour).toBe(25)
    expect(storedDecision(raise, { sent: 'queued', outboundQueueId: 'q1', actionLogId: 'l1' }).beforeHour ?? null).toBeNull()
  })
})

