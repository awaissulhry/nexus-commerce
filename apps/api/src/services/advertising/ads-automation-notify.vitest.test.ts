/**
 * CAP — the notification dedupe, and the one case that must never be deduped.
 *
 * Context: 41,466 notifications in 24h before the caps were armed, 70.6% of every notification
 * this account has ever created landing in a single week, against 260 reviewable suggestions.
 * The dedupe closes what the caps did not — but this service also carries the circuit-breaker,
 * the halt event and ad-rank-defend's blast-radius guard, and collapsing a second incident into
 * the first would be a far worse defect than the volume it fixes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const userFindMany = vi.fn(async () => [{ id: 'u1' }, { id: 'u2' }])
const notifFindFirst = vi.fn(async (): Promise<{ id: string } | null> => null)
const notifCreateMany = vi.fn(async () => ({ count: 2 }))

vi.mock('../../db.js', () => ({
  default: {
    userProfile: { get findMany() { return userFindMany } },
    notification: {
      get findFirst() { return notifFindFirst },
      get createMany() { return notifCreateMany },
    },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { notifyAutomationDetailed, notifyAutomation } = await import('./ads-automation-notify.service.js')

beforeEach(() => {
  userFindMany.mockClear(); notifFindFirst.mockClear(); notifCreateMany.mockClear()
  notifFindFirst.mockResolvedValue(null)
})

describe('notification dedupe', () => {
  it('creates one row per user when nothing matching is unread', async () => {
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'Low CTR detected' })
    expect(r).toEqual({ created: 2, deduped: false, wouldHaveReached: 2 })
    expect(notifCreateMany).toHaveBeenCalledTimes(1)
  })

  it('suppresses an identical UNREAD notice inside the window', async () => {
    notifFindFirst.mockResolvedValueOnce({ id: 'existing' })
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'Low CTR detected' })
    expect(r.deduped).toBe(true)
    expect(r.created).toBe(0)
    expect(notifCreateMany).not.toHaveBeenCalled()
  })

  it('🔴 a suppressed notice reports wouldHaveReached — deduped is not "reached nobody"', async () => {
    notifFindFirst.mockResolvedValueOnce({ id: 'existing' })
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'x' })
    // created:0 and deduped:true is a suppression; created:0 and deduped:false is a failure.
    // Same number, opposite facts — the conflation that hid alert_operator for months.
    expect(r.wouldHaveReached).toBe(2)
    expect(r.deduped).toBe(true)
  })

  it('🔴 NEVER dedupes severity=danger — the circuit-breaker and blast-radius guard use this', async () => {
    notifFindFirst.mockResolvedValue({ id: 'existing' }) // an identical unread alarm IS present
    const r = await notifyAutomationDetailed({
      type: 'rank_plan_mistarget', severity: 'danger', title: 'Rank plan auto-paused — blast-radius guard',
    })
    expect(r.deduped).toBe(false)
    expect(r.created).toBe(2)
    expect(notifCreateMany).toHaveBeenCalledTimes(1)
    // It must not even ask: a second incident is never a duplicate of the first.
    expect(notifFindFirst).not.toHaveBeenCalled()
  })

  it('keys on body as well as title, so distinct entities are not collapsed', async () => {
    await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'Low CTR detected', body: 'Target: giacca moto' })
    const where = notifFindFirst.mock.calls[0]?.[0]?.where
    expect(where?.title).toBe('Low CTR detected')
    expect(where?.body).toBe('Target: giacca moto')
    // Unread only: once an operator has seen it, a recurrence is new information.
    expect(where?.readAt).toBeNull()
  })

  it('a missing body is keyed as null, not as absent — or the filter would match any body', async () => {
    await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'no body' })
    expect(notifFindFirst.mock.calls[0]?.[0]?.where?.body).toBeNull()
  })

  it('the legacy notifyAutomation signature still returns rows created', async () => {
    const n = await notifyAutomation({ type: 'ads-automation-halt', severity: 'danger', title: 'Ad automation halted' })
    expect(n).toBe(2)
  })

  it('no users: creates nothing and claims nothing', async () => {
    userFindMany.mockResolvedValueOnce([])
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'x' })
    expect(r).toEqual({ created: 0, deduped: false, wouldHaveReached: 0 })
    expect(notifCreateMany).not.toHaveBeenCalled()
  })
})
