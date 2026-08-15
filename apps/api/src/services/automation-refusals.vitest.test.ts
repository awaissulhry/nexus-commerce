/**
 * AUTO.P0 — the durable refusal record.
 *
 * The lesson this session exists to encode is that a refusal surface can be confidently wrong.
 * `automation-rule-cap.vitest.test.ts` used to assert the SHAPE of a where-clause, so it passed
 * for four months while the clause it described matched nothing. These tests assert behaviour:
 * what is written, under which key, and — the part that matters most — that a refusal never
 * becomes a failure and the three families never collapse into one number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsert = vi.fn(async () => ({}))
const findMany = vi.fn(async () => [] as unknown[])
const loggerError = vi.fn()

vi.mock('../db.js', () => ({
  default: { automationRefusalDaily: { get upsert() { return upsert }, get findMany() { return findMany } } },
}))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: loggerError } }))

const { recordAutomationRefusal, refusalCountsByActor, refusalDayUtc } = await import('./automation-refusals.service.js')

beforeEach(() => { vi.clearAllMocks(); upsert.mockResolvedValue({}); findMany.mockResolvedValue([]) })

describe('AUTO.P0 — recording a refusal', () => {
  it('keys the counter by (actorKind, actorId, dayUtc, reason) and increments', async () => {
    await recordAutomationRefusal({
      actorId: 'rule-1', reason: 'DAILY_CAP_EXCEEDED', detail: 'hit its cap of 10',
      entityType: 'CAMPAIGN', entityId: 'camp-1', at: new Date('2026-08-16T09:30:00.000Z'),
    })
    const arg = upsert.mock.calls[0]?.[0] as Record<string, any>
    expect(arg.where.actorKind_actorId_dayUtc_reason).toEqual({
      actorKind: 'rule', actorId: 'rule-1', dayUtc: '2026-08-16', reason: 'DAILY_CAP_EXCEEDED',
    })
    expect(arg.update.count).toEqual({ increment: 1 })
    expect(arg.create.count).toBe(1)
  })

  it('stores the operator-facing reason VERBATIM', async () => {
    // SUB §5.5: the UI quotes the reason unparaphrased. A counter that kept only a code would
    // force every surface to re-invent the sentence, and they would not agree.
    const detail = 'Trim budget on weak ACOS reached its daily cap of 3 and was refused. Further matches today are refused, not queued.'
    await recordAutomationRefusal({ actorId: 'rule-1', reason: 'DAILY_CAP_EXCEEDED', detail })
    const arg = upsert.mock.calls[0]?.[0] as Record<string, any>
    expect(arg.create.lastReason).toBe(detail)
    expect(arg.update.lastReason).toBe(detail)
  })

  /**
   * 🔴 The three families must stay countable apart. A demotion is not a refusal to run, and a
   * value-cap refusal is currently recorded as a FAILED execution — 1,029 of them in eight days
   * from one rule. Collapsing any two of these reproduces the exact conflation that made a
   * switched-off rule read as a catastrophically broken one.
   */
  it('keeps the three refusal reasons under separate keys', async () => {
    const at = new Date('2026-08-16T09:30:00.000Z')
    await recordAutomationRefusal({ actorId: 'r', reason: 'DAILY_CAP_EXCEEDED', detail: 'a', at })
    await recordAutomationRefusal({ actorId: 'r', reason: 'WRITE_CAP_REACHED', detail: 'b', at })
    await recordAutomationRefusal({ actorId: 'r', reason: 'VALUE_CAP_EXCEEDED', detail: 'c', at })
    const reasons = upsert.mock.calls.map((c) => (c[0] as any).where.actorKind_actorId_dayUtc_reason.reason)
    expect(new Set(reasons).size).toBe(3)
  })

  it('buckets by UTC day, matching the cap counter it describes', async () => {
    // 23:30 UTC on the 16th is the 17th in Europe/Rome. A local bucket here would disagree with
    // the engine's own setUTCHours(0,0,0,0) window — invisible to tsc and to the eye.
    expect(refusalDayUtc(new Date('2026-08-16T23:30:00.000Z'))).toBe('2026-08-16')
    expect(refusalDayUtc(new Date('2026-08-17T00:10:00.000Z'))).toBe('2026-08-17')
  })

  /**
   * A refusal record that throws would turn a governed stop into an incident on the engine's hot
   * path — strictly worse than the under-counting it would be reporting.
   */
  it('never throws when the write fails, and says so loudly', async () => {
    upsert.mockRejectedValue(new Error('unique constraint'))
    await expect(recordAutomationRefusal({ actorId: 'r', reason: 'DAILY_CAP_EXCEEDED', detail: 'x' })).resolves.toBeUndefined()
    expect(loggerError).toHaveBeenCalled()
  })

  it('omits the entity for an account-grain trigger rather than inventing one', async () => {
    await recordAutomationRefusal({ actorId: 'r', reason: 'DAILY_CAP_EXCEEDED', detail: 'x' })
    const arg = upsert.mock.calls[0]?.[0] as Record<string, any>
    expect(arg.create.lastEntityId).toBeNull()
    expect(arg.create.lastEntityType).toBeNull()
  })
})

describe('AUTO.P0 — reading refusal counts', () => {
  it('sums across days and reasons per actor, keeping the newest reason', async () => {
    findMany.mockResolvedValue([
      { actorId: 'r1', reason: 'DAILY_CAP_EXCEEDED', count: 100, lastAt: new Date('2026-08-15T10:00:00Z'), lastReason: 'older' },
      { actorId: 'r1', reason: 'DAILY_CAP_EXCEEDED', count: 50, lastAt: new Date('2026-08-16T10:00:00Z'), lastReason: 'newest' },
      { actorId: 'r1', reason: 'WRITE_CAP_REACHED', count: 7, lastAt: new Date('2026-08-14T10:00:00Z'), lastReason: 'oldest' },
      { actorId: 'r2', reason: 'VALUE_CAP_EXCEEDED', count: 3, lastAt: new Date('2026-08-16T11:00:00Z'), lastReason: 'other' },
    ])
    const out = await refusalCountsByActor(7)
    expect(out.get('r1')?.total).toBe(157)
    expect(out.get('r1')?.byReason).toEqual({ DAILY_CAP_EXCEEDED: 150, WRITE_CAP_REACHED: 7 })
    expect(out.get('r1')?.lastReason).toBe('newest')
    expect(out.get('r2')?.total).toBe(3)
  })

  it('asks for a window of calendar days, compared as strings', async () => {
    await refusalCountsByActor(7)
    const where = (findMany.mock.calls[0]?.[0] as any).where
    expect(typeof where.dayUtc.gte).toBe('string')
    expect(where.dayUtc.gte).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
