/**
 * NAF.AC.8 — A/B: alternate runs take the candidate arm, a broken split
 * falls back to the live charter rather than failing, and a comparison
 * refuses to name a winner from too few runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentCharter: { findFirst: vi.fn() },
    agentCharterRevision: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    agentRun: { count: vi.fn(), findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { compareAbArms, pickRevisionForRun } from './charter-revisions.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentCharter.findFirst.mockResolvedValue({
    abEnabled: true,
    candidateRevisionId: 'cand',
  } as never)
  db.agentCharterRevision.findFirst.mockResolvedValue({
    id: 'active',
    charterKey: 'w',
    systemPrompt: 'LIVE',
  } as never)
  db.agentCharterRevision.findUnique.mockResolvedValue({
    id: 'cand',
    charterKey: 'w',
    systemPrompt: 'CANDIDATE',
  } as never)
  db.agentRun.findMany.mockResolvedValue([] as never)
})

describe('pickRevisionForRun', () => {
  it('alternates: even run counts take the live charter, odd the candidate', async () => {
    db.agentRun.count.mockResolvedValue(4 as never)
    expect((await pickRevisionForRun('w')).arm).toBe('active')
    db.agentRun.count.mockResolvedValue(5 as never)
    const odd = await pickRevisionForRun('w')
    expect(odd.arm).toBe('candidate')
    expect(odd.systemPrompt).toBe('CANDIDATE')
  })

  it('no split configured → always the live charter', async () => {
    db.agentCharter.findFirst.mockResolvedValue({ abEnabled: false, candidateRevisionId: null } as never)
    db.agentRun.count.mockResolvedValue(5 as never)
    expect((await pickRevisionForRun('w')).arm).toBe('active')
  })

  it("a candidate belonging to another charter is ignored, not run", async () => {
    db.agentRun.count.mockResolvedValue(5 as never)
    db.agentCharterRevision.findUnique.mockResolvedValue({
      id: 'cand', charterKey: 'someone-else', systemPrompt: 'X',
    } as never)
    expect((await pickRevisionForRun('w')).arm).toBe('active')
  })
})

describe('compareAbArms', () => {
  it('refuses to call a winner from too few runs', async () => {
    db.agentRun.findMany.mockResolvedValue([{ ok: true, findingCount: 3, costUSD: '0.01' }] as never)
    const c = await compareAbArms('w')
    expect(c.callable).toBe(false)
    expect(c.note).toMatch(/at least 5/)
  })

  it('reports per-arm rates once both arms have enough runs', async () => {
    db.agentRun.findMany.mockResolvedValue(
      Array.from({ length: 6 }, () => ({ ok: true, findingCount: 2, costUSD: '0.02' })) as never,
    )
    const c = await compareAbArms('w')
    expect(c.callable).toBe(true)
    expect(c.arms[0]!.okRate).toBe(1)
    expect(c.arms[0]!.findingsPerRun).toBe(2)
    expect(c.arms[0]!.costPerRun).toBeCloseTo(0.02, 6)
  })
})
