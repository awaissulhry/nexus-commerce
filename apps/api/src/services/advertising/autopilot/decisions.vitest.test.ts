/**
 * SG.8 — the A.I. Bids verbs. Pins the contract the tab relies on:
 *   · approve executes through applyPlanActions (the AUTO engine) and maps its outcome
 *     honestly: APPLIED settles the row, DENIED keeps it PROPOSED (a governed stop),
 *     an empty result settles it SKIPPED ("nothing to change" is not a failure).
 *   · a disabled plan's proposals are stale — approve refuses BEFORE touching the engine
 *     (this is also what protects seeded preview rows).
 *   · the tick's delete race cannot lose an audit row: if the write landed but the row was
 *     superseded mid-apply, a fresh decided row is created.
 *   · dismissal is sticky by fingerprint (module|campaignId|action), not by value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { db, applyMock, gatherMock } = vi.hoisted(() => {
  const db = {
    autopilotDecision: {
      findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(),
      create: vi.fn(), deleteMany: vi.fn(),
    },
    campaign: { findMany: vi.fn() },
    outboundSyncQueue: { findMany: vi.fn() },
    advertisingActionLog: { findMany: vi.fn() },
    adsSuggestionMute: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  }
  return { db, applyMock: vi.fn(), gatherMock: vi.fn(async () => []) }
})
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./apply.js', () => ({ applyPlanActions: applyMock }))
vi.mock('../../../jobs/ad-autopilot.job.js', () => ({ gatherSignals: gatherMock }))

import {
  approveDecision, dismissDecision, restoreDecision, bulkDecide,
  actionFromDecision, suppressDismissed, listAiDecisions,
} from './decisions.js'

const PLAN = { id: 'p1', enabled: true, autonomy: 'SUGGEST', goal: 'BALANCED', marketplace: 'IT', guardrails: {} }
const ROW = {
  id: 'd1', planId: 'p1', cycle: 'fast', module: 'budget', campaignId: 'c1', action: 'BUDGET_UP',
  before: { cents: 500 }, after: { cents: 650 }, reason: 'Out of budget', status: 'PROPOSED',
  source: 'autopilot', plan: PLAN,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.autopilotDecision.updateMany.mockResolvedValue({ count: 1 })
})

describe('actionFromDecision', () => {
  it('reconstructs the conductor action with cents unpacked', () => {
    const a = actionFromDecision(ROW)
    expect(a).toMatchObject({ module: 'budget', campaignId: 'c1', action: 'BUDGET_UP', beforeCents: 500, afterCents: 650 })
  })
  it('refuses a row with no campaign, and an unapplyable module', () => {
    expect(actionFromDecision({ ...ROW, campaignId: null })).toHaveProperty('error')
    expect(actionFromDecision({ ...ROW, module: 'safety' })).toHaveProperty('error')
  })
})

describe('approveDecision', () => {
  it('applies through the AUTO engine and settles the row with the executor outcome', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue(ROW)
    applyMock.mockResolvedValue({ applied: 1, denied: 0, decisions: [{ module: 'budget', campaignId: 'c1', action: 'BUDGET_UP', before: { cents: 500 }, after: { cents: 650 }, reason: 'Budget €5.00 → €6.50', status: 'APPLIED' }] })
    const res = await approveDecision('d1')
    expect(res).toMatchObject({ ok: true, outcome: 'applied' })
    expect(applyMock).toHaveBeenCalledWith(expect.objectContaining({ planId: 'p1', actions: [expect.objectContaining({ campaignId: 'c1' })] }))
    expect(db.autopilotDecision.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'd1', status: 'PROPOSED' },
      data: expect.objectContaining({ status: 'APPLIED', reason: 'Budget €5.00 → €6.50' }),
    }))
  })
  it('a gate DENIED keeps the row proposed and returns the refusal in the gate’s words', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue(ROW)
    applyMock.mockResolvedValue({ applied: 0, denied: 1, decisions: [{ module: 'budget', campaignId: 'c1', action: 'BUDGET_UP', reason: 'Out of budget — blocked: campaign is not live-write enabled', status: 'DENIED' }] })
    const res = await approveDecision('d1')
    expect(res).toMatchObject({ ok: false, refused: true })
    expect(res.error).toContain('blocked')
    expect(db.autopilotDecision.updateMany).not.toHaveBeenCalled()
  })
  it('refuses a disabled plan BEFORE touching the engine (stale proposals; preview-row guard)', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue({ ...ROW, plan: { ...PLAN, enabled: false, autonomy: 'OFF' } })
    const res = await approveDecision('d1')
    expect(res).toMatchObject({ ok: false, refused: true })
    expect(res.error).toContain('disabled')
    expect(applyMock).not.toHaveBeenCalled()
  })
  it('refuses an unapplyable module without touching the engine', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue({ ...ROW, module: 'safety', action: 'SUPPRESS' })
    const res = await approveDecision('d1')
    expect(res).toMatchObject({ ok: false, refused: true })
    expect(applyMock).not.toHaveBeenCalled()
  })
  it('a decided row answers "already", a vanished row answers "superseded"', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue({ ...ROW, status: 'APPLIED' })
    expect((await approveDecision('d1')).error).toContain('Already')
    db.autopilotDecision.findUnique.mockResolvedValue(null)
    expect((await approveDecision('d1')).error).toContain('superseded')
  })
  it('the tick race cannot lose the audit: landed write + deleted row → fresh decided row', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue(ROW)
    applyMock.mockResolvedValue({ applied: 1, denied: 0, decisions: [{ module: 'budget', campaignId: 'c1', action: 'BUDGET_UP', reason: 'r', status: 'APPLIED' }] })
    db.autopilotDecision.updateMany.mockResolvedValue({ count: 0 })
    const res = await approveDecision('d1')
    expect(res.ok).toBe(true)
    expect(db.autopilotDecision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: 'p1', status: 'APPLIED', source: 'autopilot' }),
    }))
  })
  it('a bid approve with nothing to move settles SKIPPED — not a failure, not a live verb', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue({ ...ROW, module: 'bid', action: 'BID_RAISE' })
    applyMock.mockResolvedValue({ applied: 0, denied: 0, decisions: [] })
    const res = await approveDecision('d1')
    expect(res).toMatchObject({ ok: true, outcome: 'skipped' })
    expect(db.autopilotDecision.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'SKIPPED' }),
    }))
  })
  it('a budget approve whose write threw (empty executor result) keeps the row proposed', async () => {
    db.autopilotDecision.findUnique.mockResolvedValue(ROW)
    applyMock.mockResolvedValue({ applied: 0, denied: 0, decisions: [] })
    const res = await approveDecision('d1')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('did not complete')
    expect(db.autopilotDecision.updateMany).not.toHaveBeenCalled()
  })
})

describe('dismiss / restore', () => {
  it('dismiss flips PROPOSED → DISMISSED and stamps the suppression clock', async () => {
    expect((await dismissDecision('d1')).ok).toBe(true)
    expect(db.autopilotDecision.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'd1', status: 'PROPOSED' },
      data: expect.objectContaining({ status: 'DISMISSED', at: expect.any(Date) }),
    }))
  })
  it('both verbs answer honestly when the row is not in the state they need', async () => {
    db.autopilotDecision.updateMany.mockResolvedValue({ count: 0 })
    expect((await dismissDecision('d1')).ok).toBe(false)
    expect((await restoreDecision('d1')).ok).toBe(false)
  })
})

describe('suppressDismissed (the conductor’s sticky-dismissal cut)', () => {
  const act = (module: string, campaignId: string, action: string) => ({ module, campaignId, action })
  it('drops re-proposals matching a dismissed fingerprint — value wobble does not resurrect', () => {
    const out = suppressDismissed(
      [act('budget', 'c1', 'BUDGET_UP'), act('bid', 'c1', 'BID_RAISE')],
      [{ module: 'budget', campaignId: 'c1', action: 'BUDGET_UP' }],
    )
    expect(out).toEqual([act('bid', 'c1', 'BID_RAISE')])
  })
  it('a different campaign or action is a NEW decision and passes', () => {
    const out = suppressDismissed(
      [act('budget', 'c2', 'BUDGET_UP'), act('budget', 'c1', 'BUDGET_DOWN')],
      [{ module: 'budget', campaignId: 'c1', action: 'BUDGET_UP' }],
    )
    expect(out).toHaveLength(2)
  })
})

describe('bulkDecide', () => {
  it('runs ops sequentially and reports per-row outcomes', async () => {
    db.autopilotDecision.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const r = await bulkDecide([{ id: 'a', kind: 'dismiss' }, { id: 'b', kind: 'dismiss' }])
    expect(r.okCount).toBe(1)
    expect(r.results[0]).toMatchObject({ id: 'a', ok: true })
    expect(r.results[1]).toMatchObject({ id: 'b', ok: false })
  })
})

describe('listAiDecisions — delivery + undo handles (SG.9/SG.10)', () => {
  const base = {
    id: 'd1', at: new Date(), module: 'budget', cycle: 'fast', action: 'BUDGET_UP',
    campaignId: 'c1', before: null, after: null, reason: 'r', planId: 'p1',
    status: 'APPLIED', plan: { id: 'p1', name: 'Plan', enabled: true },
  }
  beforeEach(() => {
    db.campaign.findMany.mockResolvedValue([{ id: 'c1', name: 'Camp' }])
    db.outboundSyncQueue.findMany.mockResolvedValue([])
    db.advertisingActionLog.findMany.mockResolvedValue([])
  })

  it('a SKIPPED queue row is REFUSED in the gate\'s words, never a silent success', async () => {
    db.autopilotDecision.findMany.mockResolvedValue([{ ...base, outboundQueueId: 'q1', executionId: null }])
    db.outboundSyncQueue.findMany.mockResolvedValue([{ id: 'q1', syncStatus: 'SKIPPED', errorCode: 'WRITE_GATE_DENIED', errorMessage: null, isDead: false }])
    const { items } = await listAiDecisions('applied')
    expect((items[0] as any).delivery).toMatchObject({ state: 'refused' })
    expect((items[0] as any).delivery.detail).toContain('write gate')
  })

  it('APPLIED with no queue handle is delivery-null — not a confident "delivered"', async () => {
    db.autopilotDecision.findMany.mockResolvedValue([{ ...base, outboundQueueId: null, executionId: null }])
    const { items } = await listAiDecisions('applied')
    expect((items[0] as any).delivery).toBeNull()
  })

  it('the undo handle reports whether it was ALREADY used', async () => {
    db.autopilotDecision.findMany.mockResolvedValue([{ ...base, outboundQueueId: null, executionId: 'log1' }])
    db.advertisingActionLog.findMany.mockResolvedValue([{ id: 'log1', rolledBackAt: new Date() }])
    const { items } = await listAiDecisions('applied')
    expect((items[0] as any).undo).toMatchObject({ actionLogId: 'log1', rolledBack: true })
  })

  it('a handle whose log has vanished offers NO undo rather than a doomed request', async () => {
    db.autopilotDecision.findMany.mockResolvedValue([{ ...base, outboundQueueId: null, executionId: 'gone' }])
    db.advertisingActionLog.findMany.mockResolvedValue([])
    const { items } = await listAiDecisions('applied')
    expect((items[0] as any).undo).toBeNull()
  })
})
