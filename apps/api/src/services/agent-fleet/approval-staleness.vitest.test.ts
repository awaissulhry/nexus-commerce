/**
 * NAF.AP.6–AP.8 — staleness, precedent, and the track record.
 *
 * AP.6's contract is the sharp one: an approval describes a state of the
 * world, and if that state moved the approval no longer describes anything
 * real. It must refuse rather than act — and refusing must hand the decision
 * back, not throw it away.
 */
import { z } from 'zod'
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
    agentExemplar: { findMany: vi.fn() },
  },
}))
/* S9.4 — commitScheduledApproval now restamps `expiresAt` when it hands a
   decision back, so it imports EXPIRY_HOURS from the same module. A mock that
   omits it fails at import, not at assertion. */
vi.mock('../agents/approval-gate.service.js', () => ({
  decideApproval: vi.fn(),
  EXPIRY_HOURS: 24,
}))
vi.mock('../agents/tool-registry.js', () => ({ getTool: vi.fn() }))
vi.mock('./control-audit.service.js', () => ({ recordControlChange: vi.fn() }))
vi.mock('./exemplar.service.js', () => ({ mintExemplarFromDecision: vi.fn() }))
vi.mock('../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import prisma from '../../db.js'
import { decideApproval } from '../agents/approval-gate.service.js'
import { getTool } from '../agents/tool-registry.js'
import { recordControlChange } from './control-audit.service.js'
import { mintExemplarFromDecision } from './exemplar.service.js'
import {
  checkStaleness,
  commitScheduledApproval,
  recentPrecedents,
  trackRecords,
} from './approval-inbox.service.js'

const db = vi.mocked(prisma, true)
const gate = vi.mocked(decideApproval)
const tools = vi.mocked(getTool)
const audit = vi.mocked(recordControlChange)

/** MCP.3 — every tool parses its arguments; these fakes accept any. */
const ANY_ARGS = z.object({}).loose()

/** The stored preview the operator read when they approved. */
const STORED = { action: 'set-target-bid', currentBidCents: 42, proposedBidCents: 25 }

function toolReturning(preview: Record<string, unknown> | null, ok = true, error?: string) {
  return {
    name: 'set-target-bid',
    input: ANY_ARGS,
    handler: vi.fn().mockResolvedValue(ok ? { ok: true, preview } : { ok: false, error }),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  gate.mockResolvedValue({ ok: true, status: 'executed' })
  audit.mockResolvedValue(undefined)
  vi.mocked(mintExemplarFromDecision).mockResolvedValue(undefined as never)
  db.agentApproval.updateMany.mockResolvedValue({ count: 1 } as never)
  db.agentApproval.findUnique.mockResolvedValue({
    toolName: 'set-target-bid',
    args: { targetId: 't1' },
    preview: STORED,
  } as never)
  tools.mockReturnValue(toolReturning(STORED))
})

describe('AP.6 — checkStaleness', () => {
  it('passes when the world still matches the preview', async () => {
    expect(await checkStaleness('a1')).toEqual({ stale: false, why: null })
  })

  it('catches the starting value moving under the decision', async () => {
    tools.mockReturnValue(toolReturning({ ...STORED, currentBidCents: 60 }))
    const v = await checkStaleness('a1')
    expect(v.stale).toBe(true)
    // The operator gets the numbers, in money, not a diff of raw JSON.
    expect(v.why).toContain('currentBidCents changed from €0.42 to €0.60')
  })

  it("adopts the tool's own refusal verbatim", async () => {
    tools.mockReturnValue(toolReturning(null, false, 'authority pin: bids are held by hand'))
    expect(await checkStaleness('a1')).toEqual({
      stale: true,
      why: 'authority pin: bids are held by hand',
    })
  })

  it('treats a re-check that cannot run as stale, not as permission', async () => {
    tools.mockReturnValue({
      name: 'set-target-bid',
      input: ANY_ARGS,
      handler: vi.fn().mockRejectedValue(new Error('db down')),
    } as never)
    const v = await checkStaleness('a1')
    expect(v.stale).toBe(true)
    expect(v.why).toContain('could not be re-checked')
  })

  it('ignores fields that are not material', async () => {
    // A metrics window ticking over is noise, not a changed decision.
    tools.mockReturnValue(toolReturning({ ...STORED, someMetric: 999, effect: 'reworded' }))
    expect((await checkStaleness('a1')).stale).toBe(false)
  })

  it('says so when the request has vanished', async () => {
    db.agentApproval.findUnique.mockResolvedValue(null as never)
    expect(await checkStaleness('a1')).toEqual({
      stale: true,
      why: 'the request no longer exists',
    })
  })

  it('does not block a tool with no dry-run to re-check against', async () => {
    tools.mockReturnValue(undefined as never)
    expect(await checkStaleness('a1')).toEqual({ stale: false, why: null })
  })
})

/**
 * MCP.10 — the stored preview is jsonb, which re-orders an object's keys. The comparison must not care about key
 * order at any depth, and must still see every value, and every change of array order. (The real round trip through
 * jsonb is proven on PGlite in approval-staleness-jsonb.vitest.test.ts.)
 */
describe('MCP.10 — key order never counts, a value or an array order always does', () => {
  /** A fresh preview, keys in the order a tool builds them. */
  const FRESH = {
    action: 'set-price',
    changes: {
      'base price': { from: 10, to: 12 },
      listings: [{ channel: 'EBAY', market: 'IT', price: { from: 11, to: 13 } }, { channel: 'AMAZON', market: 'DE', price: null }],
    },
  }
  /** The same preview with its keys re-ordered at every depth, including inside the array, as jsonb returns it. */
  const REORDERED = {
    changes: {
      listings: [{ price: { to: 13, from: 11 }, market: 'IT', channel: 'EBAY' }, { price: null, market: 'DE', channel: 'AMAZON' }],
      'base price': { to: 12, from: 10 },
    },
    action: 'set-price',
  }
  const approvalWith = (stored: Record<string, unknown>) => {
    db.agentApproval.findUnique.mockResolvedValue({ toolName: 'set-price', args: {}, preview: stored } as never)
  }
  const freshIs = (preview: Record<string, unknown>) =>
    tools.mockReturnValue({ name: 'set-price', input: ANY_ARGS, execute: vi.fn(), handler: vi.fn().mockResolvedValue({ ok: true, preview }) } as never)

  it('the same preview with its keys in another order, nested and inside arrays, is not stale', async () => {
    approvalWith(REORDERED)
    freshIs(FRESH)
    expect(await checkStaleness('a1')).toEqual({ stale: false, why: null })
  })

  it('a changed value deep inside is stale', async () => {
    approvalWith(REORDERED)
    freshIs({ ...FRESH, changes: { ...FRESH.changes, listings: [{ ...FRESH.changes.listings[0], price: { from: 11, to: 14 } }, FRESH.changes.listings[1]] } })
    const v = await checkStaleness('a1')
    expect(v.stale).toBe(true)
    expect(v.why).toContain('changes changed')
  })

  it('the same items in another array order are stale', async () => {
    approvalWith(REORDERED)
    freshIs({ ...FRESH, changes: { ...FRESH.changes, listings: [FRESH.changes.listings[1], FRESH.changes.listings[0]] } })
    expect((await checkStaleness('a1')).stale).toBe(true)
  })

  it('a value that only changed type (12 → "12"), or that vanished, is stale', async () => {
    approvalWith(REORDERED)
    freshIs({ ...FRESH, changes: { ...FRESH.changes, 'base price': { from: 10, to: '12' } } })
    expect((await checkStaleness('a1')).stale).toBe(true)
    freshIs({ action: 'set-price' })
    expect((await checkStaleness('a1')).stale).toBe(true)
  })
})

describe('AP.6 — commit refuses a stale action', () => {
  beforeEach(() => {
    db.agentApproval.findUnique.mockResolvedValue({
      status: 'scheduled',
      executeAfter: new Date(Date.now() - 1000),
      decidedBy: 'Awais',
      toolName: 'set-target-bid',
      args: { targetId: 't1' },
      preview: STORED,
    } as never)
  })

  it('never executes when the facts moved', async () => {
    tools.mockReturnValue(toolReturning({ ...STORED, currentBidCents: 60 }))
    const out = await commitScheduledApproval('a1')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('not run')
    expect(gate).not.toHaveBeenCalled()
  })

  it('hands the decision back instead of throwing it away', async () => {
    tools.mockReturnValue(toolReturning({ ...STORED, currentBidCents: 60 }))
    await commitScheduledApproval('a1')
    const back = db.agentApproval.updateMany.mock.calls.find(
      (c) => (c[0]!.data as { status?: string }).status === 'pending',
    )
    expect(back).toBeDefined()
    const data = back![0]!.data as Record<string, unknown>
    // It returns to the queue for a fresh look, with the reason attached —
    // and with the old decision cleared, so nobody is credited with a
    // decision that never ran.
    expect(data.decidedBy).toBeNull()
    expect(data.executeAfter).toBeNull()
    expect(String(data.reason)).toContain('currentBidCents changed')
  })

  it('S9.4 — a hand-back restamps the expiry clock', async () => {
    tools.mockReturnValue(toolReturning({ ...STORED, currentBidCents: 60 }))
    const before = Date.now()
    await commitScheduledApproval('a1')
    const back = db.agentApproval.updateMany.mock.calls.find(
      (c) => (c[0]!.data as { status?: string }).status === 'pending',
    )
    const data = back![0]!.data as Record<string, unknown>
    /* Without this the row keeps the deadline it was created with, so one
       handed back after 24 hours is expired by the very next sweep — seconds
       after being handed to the operator with the fresh facts they were meant
       to judge. */
    expect(data.expiresAt).toBeInstanceOf(Date)
    expect((data.expiresAt as Date).getTime()).toBeGreaterThan(before)
  })

  it('records the refusal — a silent non-execution is worse than a failure', async () => {
    tools.mockReturnValue(toolReturning({ ...STORED, currentBidCents: 60 }))
    await commitScheduledApproval('a1')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'stale_refused' }),
    )
  })

  it('runs normally when nothing moved', async () => {
    const out = await commitScheduledApproval('a1')
    expect(out.ok).toBe(true)
    expect(gate).toHaveBeenCalledWith(
      'a1',
      'approve',
      expect.objectContaining({ kind: 'system', label: 'Awais' }),
    )
  })
})

describe('AP.7 — precedent is visible', () => {
  it('returns what each decision taught, newest first', async () => {
    db.agentExemplar.findMany.mockResolvedValue([
      {
        charterKey: 'amazon-negative-miner',
        label: 'rejected',
        operatorNote: 'too broad — this term converts on mobile',
        situation: { toolName: 'create-negative-keyword' },
        createdAt: new Date('2026-08-07T06:00:00Z'),
      },
    ] as never)
    expect(await recentPrecedents()).toEqual([
      {
        charterKey: 'amazon-negative-miner',
        label: 'rejected',
        note: 'too broad — this term converts on mobile',
        toolName: 'create-negative-keyword',
        createdAt: '2026-08-07T06:00:00.000Z',
      },
    ])
  })

  it('only reads live precedent', async () => {
    db.agentExemplar.findMany.mockResolvedValue([] as never)
    await recentPrecedents()
    expect(db.agentExemplar.findMany.mock.calls[0]![0]!.where).toEqual({ active: true })
  })
})

describe('AP.8 — the track record', () => {
  it('counts how this worker has fared with you, per action kind', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      { toolName: 'set-target-bid', status: 'rejected', agentRunId: 'r1' },
      { toolName: 'set-target-bid', status: 'rejected', agentRunId: 'r1' },
      { toolName: 'set-target-bid', status: 'executed', agentRunId: 'r1' },
      { toolName: 'create-negative-keyword', status: 'executed', agentRunId: 'r1' },
    ] as never)
    db.agentRun.findMany.mockResolvedValue([
      { id: 'r1', agentKey: 'amazon-bid-tuner' },
    ] as never)
    const r = await trackRecords()
    expect(r['amazon-bid-tuner::set-target-bid']).toEqual({
      approved: 1,
      rejected: 2,
      total: 3,
    })
    expect(r['amazon-bid-tuner::create-negative-keyword']).toEqual({
      approved: 1,
      rejected: 0,
      total: 1,
    })
  })
})
