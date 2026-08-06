/**
 * NAF.E — E3: the demotion machine (Part 7: automatic and immediate) and
 * the server-side AUTO gate. Demotion triggers computable today are LIVE
 * (validation >5%, critic double-block, acceptance <40% over ≥10);
 * rollback is armed but structurally inert until Phase F executes
 * anything. Includes the spec's seeded demotion test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentCharter: { findMany: vi.fn(), updateMany: vi.fn() },
    agentRun: { findMany: vi.fn() },
    agentStep: { findMany: vi.fn() },
    agentPlan: { count: vi.fn() },
    agentApproval: { findMany: vi.fn() },
    agentScorecard: { findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import {
  demoteLevel,
  evaluateDemotions,
  isAutoPromotionAllowed,
} from './promotion.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentCharter.findMany.mockResolvedValue([] as never)
  db.agentCharter.updateMany.mockResolvedValue({ count: 1 } as never)
  db.agentRun.findMany.mockResolvedValue([] as never)
  db.agentStep.findMany.mockResolvedValue([] as never)
  db.agentPlan.count.mockResolvedValue(0 as never)
  db.agentApproval.findMany.mockResolvedValue([] as never)
  db.agentScorecard.findMany.mockResolvedValue([] as never)
})

describe('demoteLevel', () => {
  it.each([
    ['AUTO', 'PROPOSE'],
    ['PROPOSE', 'OBSERVE'],
    ['OBSERVE', 'OFF'],
    ['OFF', 'OFF'],
  ])('%s → %s', (from, to) => {
    expect(demoteLevel(from)).toBe(to)
  })
})

describe('evaluateDemotions', () => {
  it('SEEDED: validation-failure rate above 5% demotes one rung', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      { key: 'amazon-negative-miner', enabled: true, autonomyLevel: 'OBSERVE' },
    ] as never)
    db.agentRun.findMany.mockResolvedValue([{ id: 'r1' }] as never)
    db.agentStep.findMany.mockResolvedValue([
      { ok: false },
      { ok: true },
      { ok: true },
    ] as never) // 33% failure rate
    const out = await evaluateDemotions()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      charterKey: 'amazon-negative-miner',
      from: 'OBSERVE',
      to: 'OFF',
      trigger: 'validation_failures',
    })
    expect(db.agentCharter.updateMany).toHaveBeenCalledWith({
      where: { key: 'amazon-negative-miner' },
      data: { autonomyLevel: 'OFF' },
    })
  })

  it('a director blocked twice by the critic in a week is demoted', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      { key: 'amazon-ads-director', enabled: true, autonomyLevel: 'PROPOSE' },
    ] as never)
    db.agentPlan.count.mockResolvedValue(2 as never)
    const out = await evaluateDemotions()
    expect(out[0]).toMatchObject({
      charterKey: 'amazon-ads-director',
      to: 'OBSERVE',
      trigger: 'critic_double_block',
    })
  })

  it('acceptance below 40% over at least 10 decisions demotes', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      { key: 'amazon-ads-director', enabled: true, autonomyLevel: 'PROPOSE' },
    ] as never)
    db.agentRun.findMany.mockResolvedValue([{ id: 'r1' }] as never)
    db.agentApproval.findMany.mockImplementation((async (args: {
      where: { status?: unknown }
    }) => {
      if (args.where.status === 'rolled_back') return []
      return [
        ...Array.from({ length: 3 }, () => ({ status: 'approved' })),
        ...Array.from({ length: 7 }, () => ({ status: 'rejected' })),
      ]
    }) as never)
    const out = await evaluateDemotions()
    expect(out[0]).toMatchObject({ trigger: 'low_acceptance' })
  })

  it('nine decisions is not enough evidence to demote on acceptance', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      { key: 'amazon-ads-director', enabled: true, autonomyLevel: 'PROPOSE' },
    ] as never)
    db.agentRun.findMany.mockResolvedValue([{ id: 'r1' }] as never)
    db.agentApproval.findMany.mockImplementation((async (args: {
      where: { status?: unknown }
    }) => {
      if (args.where.status === 'rolled_back') return []
      return [
        ...Array.from({ length: 2 }, () => ({ status: 'approved' })),
        ...Array.from({ length: 7 }, () => ({ status: 'rejected' })),
      ]
    }) as never)
    const out = await evaluateDemotions()
    expect(out).toHaveLength(0)
    expect(db.agentCharter.updateMany).not.toHaveBeenCalled()
  })

  it('OFF charters are never touched, whatever the signals say', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      { key: 'amazon-negative-miner', enabled: false, autonomyLevel: 'OFF' },
    ] as never)
    db.agentStep.findMany.mockResolvedValue([{ ok: false }] as never)
    const out = await evaluateDemotions()
    expect(out).toHaveLength(0)
    expect(db.agentCharter.updateMany).not.toHaveBeenCalled()
  })
})

describe('isAutoPromotionAllowed (the E acceptance: server-side, not UI)', () => {
  it('refuses when no scorecard exists — no evidence, no AUTO', async () => {
    expect(await isAutoPromotionAllowed('amazon-ads-director')).toBe(false)
  })
  it('refuses when the latest scorecard says not eligible', async () => {
    db.agentScorecard.findMany.mockResolvedValue([
      { promotionEligible: false },
    ] as never)
    expect(await isAutoPromotionAllowed('amazon-ads-director')).toBe(false)
  })
  it('allows only on an eligible latest scorecard', async () => {
    db.agentScorecard.findMany.mockResolvedValue([
      { promotionEligible: true },
    ] as never)
    expect(await isAutoPromotionAllowed('amazon-ads-director')).toBe(true)
  })
})
