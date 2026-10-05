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
      /* S9.5 — decideFleetApproval writes the operator's note to its own
         column after a decision. A mock without `update` throws a TypeError
         synchronously, before any .catch() can attach. */
      update: vi.fn(),
    },
    agentRun: { findMany: vi.fn() },
    // The person who approved, looked up again at commit (login roles with business profiles off, the membership on).
    userProfile: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))
vi.mock('../agents/approval-gate.service.js', () => ({ decideApproval: vi.fn(), EXPIRY_HOURS: 24 }))
vi.mock('./control-audit.service.js', () => ({ recordControlChange: vi.fn() }))
vi.mock('./exemplar.service.js', () => ({ mintExemplarFromDecision: vi.fn() }))
vi.mock('../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
/*
 * The bulk cases use the real tool registry. (Under S8.4 they needed a preview-only stand-in of `set-target-bid`, since
 * any executable row blocked a bulk approve; the Owner's decision 1 = A of 2026-10-05 replaced S8.4, so the real,
 * executable tools are what a bulk approve is about now.)
 */

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
const actor = {
  kind: 'user' as const,
  label: 'Awais',
  userId: 'u1',
  permissions: { isOwner: true, permissions: new Set<string>() },
  via: 'app' as const,
}

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
  // The person who approved (u1, "Awais") still owns the business: these tests are about the window, not the person.
  db.userProfile.findUnique.mockResolvedValue({ id: 'u1', status: 'active', permissionsVersion: 1, roleAssignments: [{ role: { key: 'OWNER' } }] } as never)
  db.$queryRaw.mockResolvedValue([{
    id: 'm1', status: 'active', version: 1, userId: 'u1', createdAt: new Date(), user: { status: 'active' },
    workspace: { id: 'ws_alpha_0001', name: 'Alpha', status: 'active', version: 1 },
    roles: [{ role: { id: 'r1', key: 'OWNER', name: 'Owner', permissions: [] } }],
  }] as never)
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
      // Not past its expiry, inside the same claim (MCP review 2026-10-01).
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    })
  })

  it('MCP.1 — refuses a person who could not make the change, inside the claim itself', async () => {
    const viewer = {
      ...actor,
      permissions: { isOwner: false, permissions: new Set(['ai.run', 'ads.view']) },
    }
    db.agentApproval.updateMany.mockResolvedValue({ count: 0 } as never)
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'pending',
      toolName: 'set-target-bid',
    } as never)
    const out = await scheduleApproval({ id: 'a1', actor: viewer })
    expect(out).toMatchObject({ ok: false, code: 'forbidden' })
    expect(out.error).toContain('ads.bids.edit')
    const where = db.agentApproval.updateMany.mock.calls[0]![0]!.where as {
      toolName: { in: string[] }
    }
    expect(where.toolName.in).not.toContain('set-target-bid')
  })

  it('MCP.1 — a person with the permission may park it', async () => {
    const bidder = {
      ...actor,
      permissions: {
        isOwner: false,
        permissions: new Set(['ai.run', 'ads.bids.edit', 'financials.adspend.view']),
      },
    }
    const out = await scheduleApproval({ id: 'a1', actor: bidder })
    expect(out).toMatchObject({ ok: true, status: 'scheduled' })
    const where = db.agentApproval.updateMany.mock.calls[0]![0]!.where as {
      toolName: { in: string[] }
    }
    expect(where.toolName.in).toContain('set-target-bid')
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
    expect(gate).toHaveBeenCalledWith('a1', 'reject', actor, 'too broad')
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
      decidedByUserId: 'u1',
      workspaceId: 'ws_alpha_0001',
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
        decidedByUserId: 'u1',
        workspaceId: 'ws_alpha_0001',
      } as never)
      .mockResolvedValue({ agentRun: { agentKey: 'amazon-bid-tuner' } } as never)
    const out = await commitScheduledApproval('a1')
    expect(out.ok).toBe(true)
    // Attribution survives the delay — the sweep does not become the decider.
    // The sweep runs the decision AS the person who took it: their id, under their name.
    expect(gate).toHaveBeenCalledWith(
      'a1',
      'approve',
      expect.objectContaining({ kind: 'user', userId: 'u1', label: 'Awais' }),
    )
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
      decidedByUserId: 'u1',
      workspaceId: 'ws_alpha_0001',
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
      decidedByUserId: 'u1',
      workspaceId: 'ws_alpha_0001',
    } as never)
    db.agentApproval.updateMany.mockResolvedValue({ count: 1 } as never)
    const r = await runApprovalMaintenance()
    expect(r.committed).toBe(2)
    if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
      expect(db.$queryRaw).toHaveBeenCalledWith(expect.anything(), 'ws_alpha_0001', 'u1')
    } else expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('one failing commit does not stop the rest', async () => {
    db.agentApproval.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as never)
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'scheduled',
      executeAfter: new Date(Date.now() - 1000),
      decidedBy: 'Awais',
      decidedByUserId: 'u1',
      workspaceId: 'ws_alpha_0001',
    } as never)
    gate.mockResolvedValueOnce({ ok: false, error: 'boom' })
    gate.mockResolvedValueOnce({ ok: true, status: 'executed' })
    const r = await runApprovalMaintenance()
    expect(r.committed).toBe(1)
    expect(r.failed).toBe(1)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'execution_failed' }))
    expect(db.agentApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1', status: 'pending' },
      data: expect.objectContaining({ decidedBy: null, decidedAt: null, expiresAt: expect.any(Date) }),
    }))
  })
})

describe('AP.4 / AQ.6 — the blast radius is stated before it fires', () => {
  /* S8.1 — the worker is part of homogeneity now, so a fixture has to carry
     one. Defaults to a single worker so the existing cases keep testing what
     they were written to test; the mixed-worker case passes its own. */
  const pending = (
    toolName: string,
    riskTier: string,
    preview: unknown = {},
    agentKey = 'amazon-bid-tuner',
  ) => ({
    toolName,
    riskTier,
    preview,
    status: 'pending',
    agentRun: { agentKey },
  })

  it('names the count and the kinds', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'low'),
      pending('set-target-bid', 'low'),
      pending('set-target-bid', 'high'),
    ] as never)
    const p = await previewBulk(['a', 'b', 'c'], 'approve')
    expect(p.count).toBe(3)
    expect(p.sentence).toContain('approves 3 actions')
    expect(p.sentence).toContain('3 × set target bid')
  })

  it('S8.1 — blocks an approve that spans two workers, even at one action kind', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'high', {}, 'amazon-bid-tuner'),
      pending('set-target-bid', 'high', {}, 'amazon-keyword-harvester'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    expect(p.homogeneous).toBe(false)
    expect(p.blockedReason).toContain('2 different workers')
    // Same KIND, so the old kind-only check would have waved this through.
    expect(p.blockedReason).not.toContain('different kinds')
  })

  it('S8.1 — a rejection is never blocked by homogeneity', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'high', {}, 'amazon-bid-tuner'),
      pending('create-negative-keyword', 'high', {}, 'amazon-negative-miner'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'reject')
    expect(p.blockedReason).toBeNull()
  })

  it('S8.1 — states reversibility either way, not only when it is bad', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'low'),
      pending('set-target-bid', 'low'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    expect(p.sentence).toContain('All of these can be put back')
  })

  /*
   * Owner decision 1 = A (2026-10-05) replaced S8.4, deliberately: rows of the SAME kind and worker may be approved
   * together even when they execute; each still goes through the stop window and the commit's re-checks. The cases
   * below used to pin S8.4's block; they now pin the new rule.
   */
  it('S8.1 / decision 1 = A — counts a partly-reversible row and says so, now that it may be approved together', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('publish-listing', 'high', {}, 'listing-quality-keeper'),
    ] as never)
    const p = await previewBulk(['a'], 'approve')
    expect(p.partlyReversible).toBe(1)
    // Unreachable under S8.4 (every partly-reversible tool executes); reachable now, and already correct.
    expect(p.blockedReason).toBeNull()
    expect(p.sentence).toContain('1 of them can only be partly undone')
  })

  it('decision 1 = A — same-kind executable rows from one worker may be bulk-approved (S8.4 refused them)', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-price', 'high', {}, 'pricing-watchdog'),
      pending('set-price', 'high', {}, 'pricing-watchdog'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    expect(p.blockedReason).toBeNull()
    expect(p.homogeneous).toBe(true)
    expect(p.count).toBe(2)
    expect(p.sentence).toContain('approves 2 actions: 2 × set price')
    expect(p.sentence).toContain('20 seconds')
  })

  it('decision 1 = A — a kind that cannot be undone is still never approved together', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('send-customer-message', 'high', {}, 'claude'),
      pending('send-customer-message', 'high', {}, 'claude'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    expect(p.homogeneous).toBe(true)
    expect(p.blockedReason).toBe('A message to a buyer cannot be recalled once it is sent, so each one is approved on its own.')
    expect(p.sentence).toBe(p.blockedReason)
  })

  it('still allows a bulk REJECT of executable rows', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-price', 'high', {}, 'pricing-watchdog'),
    ] as never)
    const p = await previewBulk(['a'], 'reject')
    expect(p.blockedReason).toBeNull()
  })

  it('calls out the high-risk share and the undo window on approve', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'low'),
      pending('set-target-bid', 'high'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    expect(p.highRisk).toBe(1)
    expect(p.sentence).toContain('1 of them high risk')
    expect(p.sentence).toContain('20 seconds')
  })

  it('does not promise an undo window on a reject', async () => {
    db.agentApproval.findMany.mockResolvedValue([pending('set-target-bid', 'low')] as never)
    const p = await previewBulk(['a'], 'reject')
    expect(p.sentence).not.toContain('20 seconds')
  })

  /* ── AQ.6 ────────────────────────────────────────────────────────────── */

  it('REFUSES a bulk approve spanning two kinds of action', async () => {
    // UiPath's homogeneity rule. A single yes must never span two different
    // consequences — this is what stops "approve all" covering a €0.02 bid
    // nudge and a customer email in one click.
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'low'),
      pending('create-negative-keyword', 'high'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    expect(p.homogeneous).toBe(false)
    expect(p.blockedReason).toContain('Approve one kind at a time')
    expect(p.sentence).toBe(p.blockedReason)
  })

  it('ALLOWS a mixed bulk reject — saying no to many things cannot hurt', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'low'),
      pending('create-negative-keyword', 'high'),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'reject')
    expect(p.blockedReason).toBeNull()
    expect(p.sentence).toContain('rejects 2 actions')
  })

  it('puts the MONEY in the sentence when it can be computed honestly', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'low', { currentBidCents: 31, proposedBidCents: 84 }),
      pending('set-target-bid', 'low', { currentBidCents: 50, proposedBidCents: 60 }),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    // 53c + 10c
    expect(p.euro?.amount).toBe(63)
    expect(p.sentence).toContain('€0.63')
    // "per click", never "per day" — a bid is a ceiling on one click, and
    // calling it daily spend would invent a volume nobody knows.
    expect(p.sentence).toContain('per click')
  })

  it('says NOTHING about money when it cannot be computed honestly', async () => {
    // A negative keyword saves money in a way nobody can put a number on
    // before the fact. "€0.00" would be a lie of precision.
    db.agentApproval.findMany.mockResolvedValue([
      pending('create-negative-keyword', 'high', { term: 'x' }),
    ] as never)
    const p = await previewBulk(['a'], 'approve')
    expect(p.euro).toBeNull()
    expect(p.sentence).not.toContain('€')
  })

  it('counts only what this decision will DO, and names what it skipped', async () => {
    // Corrected in AQ.6 after this test caught the first attempt. A parked row
    // is already approved and counting down: it is not part of THIS decision,
    // so counting it over-reports exactly as badly as dropping it silently
    // under-reported. Count the pending ones; say what was left out.
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'low'),
      { toolName: 'set-target-bid', riskTier: 'low', preview: {}, status: 'scheduled' },
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    expect(p.count).toBe(1)
    expect(p.sentence).toContain('approves 1 action')
    expect(p.sentence).toContain('already decided or counting down')
  })

  it('A4 / decision 1 = A — bid changes that execute may be approved together, and their money is stated', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'high', { currency: 'EUR', currentBidCents: 31, proposedBidCents: 84 }),
      pending('set-target-bid', 'high', { currency: 'EUR', currentBidCents: 50, proposedBidCents: 60, effectiveBidCents: 55 }),
    ] as never)
    const p = await previewBulk(['a', 'b'], 'approve')
    // S8.4 refused this ("decided one at a time"); the Owner's decision 1 = A (2026-10-05) allows it.
    expect(p.blockedReason).toBeNull()
    // The bid that lands (after the clamps) is what is counted: 53c + 5c.
    expect(p.euro?.amount).toBe(58)
    expect(p.sentence).toContain('raises what you pay per click by €0.58 in total across 2 keywords')
    // A bid in another currency is not added to euros.
    db.agentApproval.findMany.mockResolvedValue([
      pending('set-target-bid', 'high', { currency: 'GBP', currentBidCents: 31, proposedBidCents: 84 }),
    ] as never)
    expect((await previewBulk(['a'], 'approve')).euro).toBeNull()
  })

  it('says so plainly when nothing is selected', async () => {
    db.agentApproval.findMany.mockResolvedValue([] as never)
    expect((await previewBulk([], 'approve')).sentence).toBe('Nothing is selected.')
  })
})
