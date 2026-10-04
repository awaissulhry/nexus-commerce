/**
 * CAP — the notification dedupe, and the one case that must never be deduped.
 *
 * Context: 41,466 notifications in 24h before the caps were armed, 70.6% of every notification
 * this account has ever created landing in a single week, against 260 reviewable suggestions.
 * The dedupe closes what the caps did not — but this service also carries the circuit-breaker,
 * the halt event and ad-rank-defend's blast-radius guard, and collapsing a second incident into
 * the first would be a far worse defect than the volume it fixes.
 *
 * 2026-09-16 — recipients and the dedupe are now PER PERSON and PER BUSINESS; see the service's
 * `recipients()`. Every assertion that existed before is kept below, moved to the new query shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const userFindMany = vi.fn(async (_args?: unknown) => [{ id: 'u1' }, { id: 'u2' }])
const memberFindMany = vi.fn(async (_args?: unknown) => [{ userId: 'm1' }, { userId: 'm2' }])
/** Rows that ALREADY hold an identical unread notice. Empty = nobody does. */
const notifFindMany = vi.fn(async (_args?: unknown): Promise<Array<{ userId: string }>> => [])
const notifCreateMany = vi.fn(async (_args?: unknown) => ({ count: 2 }))
let context: { workspaceId: string } | undefined

vi.mock('../../db.js', () => ({
  default: {
    userProfile: { get findMany() { return userFindMany } },
    workspaceMembership: { get findMany() { return memberFindMany } },
    notification: {
      get findMany() { return notifFindMany },
      get createMany() { return notifCreateMany },
    },
  },
}))
vi.mock('../../lib/workspace-context.js', () => ({ workspaceContext: () => context }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { notifyAutomationDetailed, notifyAutomation } = await import('./ads-automation-notify.service.js')

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
beforeEach(() => {
  userFindMany.mockClear(); memberFindMany.mockClear(); notifFindMany.mockClear(); notifCreateMany.mockClear()
  notifFindMany.mockResolvedValue([])
  context = undefined
  delete process.env.NEXUS_WORKSPACES_ENABLED
})
afterEach(() => {
  if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
  else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
})

const createdFor = () => (notifCreateMany.mock.calls[0]?.[0] as { data: Array<{ userId: string }> } | undefined)?.data.map(d => d.userId) ?? []

describe('notification dedupe', () => {
  it('creates one row per user when nothing matching is unread', async () => {
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'Low CTR detected' })
    expect(r).toEqual({ created: 2, deduped: false, wouldHaveReached: 2 })
    expect(notifCreateMany).toHaveBeenCalledTimes(1)
  })

  it('suppresses an identical UNREAD notice inside the window', async () => {
    notifFindMany.mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }])
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'Low CTR detected' })
    expect(r.deduped).toBe(true)
    expect(r.created).toBe(0)
    expect(notifCreateMany).not.toHaveBeenCalled()
  })

  it('🔴 a suppressed notice reports wouldHaveReached — deduped is not "reached nobody"', async () => {
    notifFindMany.mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }])
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'x' })
    // created:0 and deduped:true is a suppression; created:0 and deduped:false is a failure.
    // Same number, opposite facts — the conflation that hid alert_operator for months.
    expect(r.wouldHaveReached).toBe(2)
    expect(r.deduped).toBe(true)
  })

  it('🔴 NEVER dedupes severity=danger — the circuit-breaker and blast-radius guard use this', async () => {
    notifFindMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]) // an identical unread alarm IS present
    const r = await notifyAutomationDetailed({
      type: 'rank_plan_mistarget', severity: 'danger', title: 'Rank plan auto-paused — blast-radius guard',
    })
    expect(r.deduped).toBe(false)
    expect(r.created).toBe(2)
    expect(notifCreateMany).toHaveBeenCalledTimes(1)
    // It must not even ask: a second incident is never a duplicate of the first.
    expect(notifFindMany).not.toHaveBeenCalled()
  })

  it('keys on body as well as title, so distinct entities are not collapsed', async () => {
    await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'Low CTR detected', body: 'Target: giacca moto' })
    const where = (notifFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> } | undefined)?.where
    expect(where?.title).toBe('Low CTR detected')
    expect(where?.body).toBe('Target: giacca moto')
    // Unread only: once an operator has seen it, a recurrence is new information.
    expect(where?.readAt).toBeNull()
  })

  it('a missing body is keyed as null, not as absent — or the filter would match any body', async () => {
    await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'no body' })
    expect((notifFindMany.mock.calls[0]?.[0] as { where: { body: unknown } }).where.body).toBeNull()
  })

  it('the legacy notifyAutomation signature still returns rows created', async () => {
    const n = await notifyAutomation({ type: 'ads-automation-halt', severity: 'danger', title: 'Ad automation halted' })
    expect(n).toBe(2)
  })

  it('7d — a notice with no href links to the Control Room, not the old page that does not exist', async () => {
    await notifyAutomation({ type: 'ads-automation-halt', severity: 'danger', title: 'Ad automation halted' })
    const data = (notifCreateMany.mock.calls[0]?.[0] as { data: Array<{ href: string }> }).data
    expect(data.map((d) => d.href)).toEqual(['/marketing/ads/rules-automation/control-room', '/marketing/ads/rules-automation/control-room'])
  })

  it('no users: creates nothing and claims nothing', async () => {
    userFindMany.mockResolvedValueOnce([])
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'x' })
    expect(r).toEqual({ created: 0, deduped: false, wouldHaveReached: 0 })
    expect(notifCreateMany).not.toHaveBeenCalled()
  })
})

describe('2026-09-16 — who a notice is for', () => {
  it('🔴 the dedupe is PER PERSON: one person’s unread copy no longer silences everyone', async () => {
    notifFindMany.mockResolvedValueOnce([{ userId: 'u1' }]) // only u1 already holds it
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'Low CTR detected' })
    expect(r).toEqual({ created: 1, deduped: false, wouldHaveReached: 2 })
    expect(createdFor()).toEqual(['u2'])
  })

  it('the dedupe only looks at the people being notified', async () => {
    await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'x' })
    expect((notifFindMany.mock.calls[0]?.[0] as { where: { userId: unknown } }).where.userId).toEqual({ in: ['u1', 'u2'] })
  })

  it('🔴 profiles OFF: every ACTIVE user — never a deactivated one, and never capped', async () => {
    await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'x' })
    const args = userFindMany.mock.calls[0]?.[0] as { where?: unknown; take?: unknown }
    expect(args.where).toEqual({ status: 'active' })
    // `take: 100` silently dropped real people once a system passed a hundred users.
    expect(args.take).toBeUndefined()
    expect(memberFindMany).not.toHaveBeenCalled()
  })

  it('🔴 profiles ON: the active members of THE business the automation ran in, and no one else', async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    context = { workspaceId: 'ws_ads' }
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', title: 'x' })
    expect(memberFindMany.mock.calls[0]?.[0]).toEqual({
      where: { workspaceId: 'ws_ads', status: 'active', user: { status: 'active' } },
      select: { userId: true },
    })
    // the system-wide user list is never consulted when a business is known
    expect(userFindMany).not.toHaveBeenCalled()
    expect(createdFor()).toEqual(['m1', 'm2'])
    expect(r.created).toBe(2)
  })

  it('🔴 profiles ON with NO business in context: nobody — never a guessed fan-out', async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    context = undefined
    const r = await notifyAutomationDetailed({ type: 'ads-automation-halt', severity: 'danger', title: 'halted' })
    expect(r).toEqual({ created: 0, deduped: false, wouldHaveReached: 0 })
    expect(userFindMany).not.toHaveBeenCalled()
    expect(memberFindMany).not.toHaveBeenCalled()
    expect(notifCreateMany).not.toHaveBeenCalled()
  })
})
