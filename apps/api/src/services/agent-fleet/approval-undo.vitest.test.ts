/**
 * NAF.AP.4–AP.5 — the brake and the single clock.
 *
 * The invariants worth locking down: nothing reaches Amazon inside the undo
 * window, an early commit is refused rather than trusted, an undo after
 * execution fails honestly instead of pretending, and expiry is driven by
 * `expiresAt` for every tool rather than by a council that runs twice a year.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentApproval: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    agentRun: { findMany: vi.fn() },
  },
}))
vi.mock('../agents/approval-gate.service.js', () => ({ decideApproval: vi.fn() }))
vi.mock('./control-audit.service.js', () => ({ recordControlChange: vi.fn() }))
vi.mock('./exemplar.service.js', () => ({ mintExemplarFromDecision: vi.fn() }))
vi.mock('../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import prisma from '../../db.js'
import { decideApproval } from '../agents/approval-gate.service.js'
import { recordControlChange } from './control-audit.service.js'
import { mintExemplarFromDecision } from './exemplar.service.js'
import {
  UNDO_WINDOW_MS,
  commitScheduledApproval,
  decideFleetApproval,
  previewBulk,
  runApprovalMaintenance,
  scheduleApproval,
  undoScheduledApproval,
} from './approval-inbox.service.js'

const db = vi.mocked(prisma, true)
const gate = vi.mocked(decideApproval)
const audit = vi.mocked(recordControlChange)
const mint = vi.mocked(mintExemplarFromDecision)
const actor = { label: 'Awais', userId: 'u1' }

beforeEach(() => {
  vi.clearAllMocks()
  gate.mockResolvedValue({ ok: true, status: 'executed' })
  audit.mockResolvedValue(undefined)
  mint.mockResolvedValue(undefined as never)
  db.agentApproval.updateMany.mockResolvedValue({ count: 1 } as never)
  db.agentApproval.findUnique.mockResolvedValue({
    agentRun: { agentKey: 'amazon-bid-tuner' },
  } as never)
  db.agentApproval.findMany.mockResolvedValue([] as never)
})

describe('AP.4 — approving parks instead of firing', () => {
  it('never calls the execution gate when an approve is taken', async () => {
    const out = await decideFleetApproval({ id: 'a1', decision: 'approve', actor })
    expect(out).toMatchObject({ ok: true, status: 'scheduled' })
    // The whole point: nothing reaches Amazon inside the window.
    expect(gate).not.toHaveBeenCalled()
  })

  it('records the decision immediately, so closing the tab cannot lose it', async () => {
    await scheduleApproval({ id: 'a1', actor })
    const data = db.agentApproval.updateMany.mock.calls[0]![0]!.data as Record<string, unknown>
    expect(data.status).toBe('scheduled')
    expect(data.decidedBy).toBe('Awais')
    expect(data.decidedAt).toBeInstanceOf(Date)
    expect((data.executeAfter as Date).getTime()).toBeGreaterThan(Date.now() + UNDO_WINDOW_MS - 2000)
  })

  it('claims pending→scheduled atomically so two tabs cannot both schedule it', async () => {
    await scheduleApproval({ id: 'a1', actor })
    expect(db.agentApproval.updateMany.mock.calls[0]![0]!.where).toEqual({
      id: 'a1',
      status: 'pending',
    })
  })

  it('refuses to park something that is not pending', async () => {
    db.agentApproval.updateMany.mockResolvedValue({ count: 0 } as never)
    db.agentApproval.findUnique.mockResolvedValue({ status: 'executed' } as never)
    expect(await scheduleApproval({ id: 'a1', actor })).toMatchObject({
      ok: false,
      error: 'already executed',
    })
  })

  it('still audits the approve at the moment it is taken', async () => {
    await decideFleetApproval({ id: 'a1', decision: 'approve', actor })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve_action', actor: 'Awais' }),
    )
  })

  it('a reject still fires straight through — there is nothing to take back', async () => {
    gate.mockResolvedValue({ ok: true, status: 'rejected' })
    await decideFleetApproval({ id: 'a1', decision: 'reject', reason: 'too broad', actor })
    expect(gate).toHaveBeenCalledWith('a1', 'reject', 'Awais', 'too broad')
  })
})

describe('AP.4 — undo', () => {
  it('returns a parked action to pending and clears the decision', async () => {
    expect(await undoScheduledApproval({ id: 'a1', actor })).toEqual({ ok: true })
    const call = db.agentApproval.updateMany.mock.calls[0]![0]!
    expect(call.where).toEqual({ id: 'a1', status: 'scheduled' })
    expect(call.data).toMatchObject({
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      executeAfter: null,
    })
  })

  it('fails honestly once the action has already run', async () => {
    db.agentApproval.updateMany.mockResolvedValue({ count: 0 } as never)
    db.agentApproval.findUnique.mockResolvedValue({ status: 'executed' } as never)
    expect(await undoScheduledApproval({ id: 'a1', actor })).toEqual({
      ok: false,
      error: 'too late — this action is already executed',
    })
  })

  it('audits the undo', async () => {
    await undoScheduledApproval({ id: 'a1', actor })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'undo_approval', actor: 'Awais' }),
    )
  })
})

describe('AP.4 — commit enforces the window server-side', () => {
  it('refuses a client that calls before the window closes', async () => {
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'scheduled',
      executeAfter: new Date(Date.now() + 10_000),
      decidedBy: 'Awais',
    } as never)
    expect(await commitScheduledApproval('a1')).toEqual({
      ok: false,
      error: 'still inside the undo window',
    })
    expect(gate).not.toHaveBeenCalled()
  })

  it('runs it once the window has closed, under the original decider', async () => {
    db.agentApproval.findUnique
      .mockResolvedValueOnce({
        status: 'scheduled',
        executeAfter: new Date(Date.now() - 1000),
        decidedBy: 'Awais',
      } as never)
      .mockResolvedValue({ agentRun: { agentKey: 'amazon-bid-tuner' } } as never)
    const out = await commitScheduledApproval('a1')
    expect(out.ok).toBe(true)
    // Attribution survives the delay — the sweep does not become the decider.
    expect(gate).toHaveBeenCalledWith('a1', 'approve', 'Awais')
  })

  it('refuses anything that is not parked', async () => {
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'pending',
      executeAfter: null,
      decidedBy: null,
    } as never)
    expect(await commitScheduledApproval('a1')).toMatchObject({ ok: false })
    expect(gate).not.toHaveBeenCalled()
  })

  it('does not double-run when another worker took it first', async () => {
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'scheduled',
      executeAfter: new Date(Date.now() - 1000),
      decidedBy: 'Awais',
    } as never)
    db.agentApproval.updateMany.mockResolvedValue({ count: 0 } as never)
    expect(await commitScheduledApproval('a1')).toEqual({ ok: false, error: 'already taken' })
    expect(gate).not.toHaveBeenCalled()
  })
})

describe('AP.5 — one expiry clock', () => {
  it('expires by expiresAt, for every tool, not by requestedAt for fleet ones', async () => {
    db.agentApproval.updateMany.mockResolvedValue({ count: 3 } as never)
    const r = await runApprovalMaintenance()
    expect(r.expired).toBe(3)
    const where = db.agentApproval.updateMany.mock.calls[0]![0]!.where as Record<string, unknown>
    expect(where.status).toBe('pending')
    expect(where.expiresAt).toEqual({ not: null, lt: expect.any(Date) })
    // No tool restriction — the council's sweep only ever covered fleet tools.
    expect(where.toolName).toBeUndefined()
    expect(where.requestedAt).toBeUndefined()
  })

  it('commits parked actions whose window has closed', async () => {
    db.agentApproval.updateMany.mockResolvedValue({ count: 0 } as never)
    db.agentApproval.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as never)
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'scheduled',
      executeAfter: new Date(Date.now() - 1000),
      decidedBy: 'Awais',
    } as never)
    db.agentApproval.updateMany.mockResolvedValue({ count: 1 } as never)
    const r = await runApprovalMaintenance()
    expect(r.committed).toBe(2)
  })

  it('one failing commit does not stop the rest', async () => {
    db.agentApproval.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as never)
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'scheduled',
      executeAfter: new Date(Date.now() - 1000),
      decidedBy: 'Awais',
    } as never)
    gate.mockResolvedValueOnce({ ok: false, error: 'boom' })
    gate.mockResolvedValueOnce({ ok: true, status: 'executed' })
    const r = await runApprovalMaintenance()
    expect(r.committed).toBe(1)
    expect(r.failed).toBe(1)
  })
})

describe('AP.4 — the blast radius is stated before it fires', () => {
  beforeEach(() => {
    db.agentApproval.findMany.mockResolvedValue([
      { toolName: 'set-target-bid', riskTier: 'low' },
      { toolName: 'set-target-bid', riskTier: 'low' },
      { toolName: 'create-negative-keyword', riskTier: 'high' },
    ] as never)
  })

  it('names the count and the kinds', async () => {
    const p = await previewBulk(['a', 'b', 'c'], 'approve')
    expect(p.count).toBe(3)
    expect(p.sentence).toContain('approves 3 actions')
    expect(p.sentence).toContain('2 × set target bid')
    expect(p.sentence).toContain('1 × create negative keyword')
  })

  it('calls out the high-risk share and the undo window on approve', async () => {
    const p = await previewBulk(['a', 'b', 'c'], 'approve')
    expect(p.highRisk).toBe(1)
    expect(p.sentence).toContain('1 of them high risk')
    expect(p.sentence).toContain('20 seconds')
  })

  it('does not promise an undo window on a reject', async () => {
    const p = await previewBulk(['a', 'b', 'c'], 'reject')
    expect(p.sentence).toContain('rejects 3 actions')
    expect(p.sentence).not.toContain('20 seconds')
  })

  it('counts only rows that are still pending', async () => {
    await previewBulk(['a'], 'approve')
    expect(db.agentApproval.findMany.mock.calls[0]![0]!.where).toMatchObject({ status: 'pending' })
  })

  it('says so plainly when nothing is selected', async () => {
    db.agentApproval.findMany.mockResolvedValue([] as never)
    expect((await previewBulk([], 'approve')).sentence).toBe('Nothing is selected.')
  })
})
