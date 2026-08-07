/**
 * NAF.AP.1–AP.2 — attribution and memory.
 *
 * The bugs these lock down are all "the record does not say what happened":
 * every decision recorded the literal string 'operator', nothing was ever
 * written to the control audit, and the inbox could only see pending rows.
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
  decideFleetApproval,
  inboxCounts,
  listInbox,
  rejectAllForCharter,
  resolveActor,
} from './approval-inbox.service.js'

const db = vi.mocked(prisma, true)
const gate = vi.mocked(decideApproval)
const audit = vi.mocked(recordControlChange)
const mint = vi.mocked(mintExemplarFromDecision)

beforeEach(() => {
  vi.clearAllMocks()
  gate.mockResolvedValue({ ok: true, status: 'rejected' })
  mint.mockResolvedValue(undefined as never)
  audit.mockResolvedValue(undefined)
  db.agentApproval.findUnique.mockResolvedValue({
    agentRun: { agentKey: 'amazon-negative-miner' },
  } as never)
  db.agentRun.findMany.mockResolvedValue([
    { id: 'run1', agentKey: 'amazon-negative-miner', orchestrationId: 'orch1' },
  ] as never)
  db.agentApproval.findMany.mockResolvedValue([
    {
      id: 'a1', agentRunId: 'run1', toolName: 'create-negative-keyword', riskTier: 'medium',
      status: 'pending', args: {}, preview: null, requestedAt: new Date('2026-08-06T06:00:00Z'),
      decidedBy: null, decidedAt: null, reason: null, expiresAt: null,
    },
  ] as never)
  db.agentApproval.count.mockResolvedValue(0 as never)
  db.agentApproval.updateMany.mockResolvedValue({ count: 1 } as never)
})

describe('resolveActor — AP.1', () => {
  it('prefers the display name a person would recognise', () => {
    expect(resolveActor({ id: 'u1', email: 'a@b.c', displayName: 'Awais' })).toEqual({
      label: 'Awais',
      userId: 'u1',
    })
  })

  it('falls back to email, then to the id', () => {
    expect(resolveActor({ id: 'u1', email: 'a@b.c' }).label).toBe('a@b.c')
    expect(resolveActor({ id: 'u1' }).label).toBe('u1')
  })

  it('says "unattributed" rather than inventing an operator', () => {
    // The old code wrote the literal string 'operator' unconditionally,
    // which is how 18 rows ended up claiming a decider that never existed.
    expect(resolveActor(undefined)).toEqual({ label: 'unattributed', userId: null })
    expect(resolveActor({})).toEqual({ label: 'unattributed', userId: null })
  })

  it('ignores a whitespace-only display name', () => {
    expect(resolveActor({ id: 'u1', email: 'a@b.c', displayName: '   ' }).label).toBe('a@b.c')
  })
})

describe('decideFleetApproval — AP.1', () => {
  const actor = { label: 'Awais', userId: 'u1' }

  it('passes the real person through to the gate, not a hardcoded string', async () => {
    await decideFleetApproval({ id: 'a1', decision: 'reject', reason: 'too broad', actor })
    expect(gate).toHaveBeenCalledWith('a1', 'reject', 'Awais', 'too broad')
  })

  it('writes an audit row naming who, what and why', async () => {
    await decideFleetApproval({ id: 'a1', decision: 'reject', reason: 'too broad', actor })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        charterKey: 'amazon-negative-miner',
        action: 'reject_action',
        note: 'too broad',
        actor: 'Awais',
      }),
    )
  })

  // AP.4 changed what an approve DOES (it parks for the undo window), not
  // what it records: the decision is still attributed the moment it is taken.
  it('records approvals under their own action', async () => {
    await decideFleetApproval({ id: 'a1', decision: 'approve', actor })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve_action', actor: 'Awais' }),
    )
  })

  it('does not audit or mint when the decision itself failed', async () => {
    gate.mockResolvedValue({ ok: false, error: 'already rejected' })
    const out = await decideFleetApproval({ id: 'a1', decision: 'reject', reason: 'x', actor })
    expect(out.ok).toBe(false)
    expect(audit).not.toHaveBeenCalled()
    expect(mint).not.toHaveBeenCalled()
  })

  it('an approve that cannot be parked audits nothing', async () => {
    db.agentApproval.updateMany.mockResolvedValue({ count: 0 } as never)
    db.agentApproval.findUnique.mockResolvedValue({ status: 'expired' } as never)
    const out = await decideFleetApproval({ id: 'a1', decision: 'approve', actor })
    expect(out.ok).toBe(false)
    expect(audit).not.toHaveBeenCalled()
  })

  it('still succeeds when the side records fail — the decision already committed', async () => {
    mint.mockRejectedValue(new Error('mint down'))
    audit.mockRejectedValue(new Error('audit down'))
    await expect(
      decideFleetApproval({ id: 'a1', decision: 'reject', reason: 'x', actor }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('rejectAllForCharter — AP.1', () => {
  it('attributes and audits every row it rejects', async () => {
    db.agentApproval.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as never)
    const out = await rejectAllForCharter({
      charterKey: 'amazon-negative-miner',
      reason: 'all too broad',
      actor: { label: 'Awais', userId: 'u1' },
    })
    expect(out).toEqual({ ok: true, rejected: 2, of: 2 })
    expect(audit).toHaveBeenCalledTimes(2)
    expect(gate).toHaveBeenNthCalledWith(1, 'a1', 'reject', 'Awais', 'all too broad')
  })

  it('reports honestly when some rows could not be rejected', async () => {
    db.agentApproval.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as never)
    gate.mockResolvedValueOnce({ ok: true, status: 'rejected' })
    gate.mockResolvedValueOnce({ ok: false, error: 'already taken' })
    const out = await rejectAllForCharter({
      charterKey: 'k',
      reason: 'r',
      actor: { label: 'Awais', userId: 'u1' },
    })
    expect(out).toEqual({ ok: true, rejected: 1, of: 2 })
  })
})

describe('listInbox — AP.2', () => {
  // AP.4 — a parked approve stays in `waiting` so its Undo is still
  // reachable after a reload; it is not "decided" until it has actually run.
  it('waiting shows fleet tools that are pending or parked', async () => {
    await listInbox('waiting')
    expect(db.agentApproval.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ['pending', 'scheduled'] },
          toolName: { in: expect.any(Array) },
        },
        orderBy: { requestedAt: 'asc' },
      }),
    )
  })

  it('decided covers every decided status, including the transient claim', async () => {
    await listInbox('decided')
    const where = db.agentApproval.findMany.mock.calls[0]![0]!.where as {
      status: { in: string[] }
      toolName?: unknown
    }
    expect(where.status.in).toEqual(
      expect.arrayContaining(['approved', 'executed', 'rejected', 'executing']),
    )
    // No tool filter — the pre-fleet history is shown, flagged, not hidden.
    expect(where.toolName).toBeUndefined()
  })

  it('flags pre-fleet rows so the UI can label rather than hide them', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      { id: 'a1', agentRunId: 'run1', toolName: 'create-negative-keyword', args: {} },
      { id: 'a2', agentRunId: 'run1', toolName: 'apply-content', args: {} },
    ] as never)
    const rows = await listInbox('decided')
    expect(rows.map((r) => r.isFleet)).toEqual([true, false])
  })

  it('resolves the worker name source instead of leaving a bare id', async () => {
    const rows = await listInbox('waiting')
    expect(rows[0]!.charterKey).toBe('amazon-negative-miner')
  })

  it('oldest-first while waiting — the thing kept waiting longest is first', async () => {
    await listInbox('waiting')
    expect(db.agentApproval.findMany.mock.calls[0]![0]!.orderBy).toEqual({ requestedAt: 'asc' })
  })

  it('caps the page rather than letting a caller ask for everything', async () => {
    await listInbox('decided', 9999)
    expect(db.agentApproval.findMany.mock.calls[0]![0]!.take).toBe(200)
  })
})

describe('inboxCounts — AP.2', () => {
  it('counts all three views so the tabs can show real numbers', async () => {
    db.agentApproval.count
      .mockResolvedValueOnce(2 as never)
      .mockResolvedValueOnce(18 as never)
      .mockResolvedValueOnce(0 as never)
    expect(await inboxCounts()).toEqual({ waiting: 2, decided: 18, expired: 0 })
  })
})
