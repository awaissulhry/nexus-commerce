/**
 * NAF.E — E1: nightly scorecards, deterministic and execution-honest.
 * Everything computable from OBSERVE/PROPOSE evidence is computed;
 * everything that needs EXECUTED actions (calibration, realised impact)
 * is null until Phase F — displayed as unknown, never zero impact.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: { findMany: vi.fn() },
    agentFinding: { findMany: vi.fn() },
    agentPlan: { findMany: vi.fn() },
    agentApproval: { findMany: vi.fn() },
    agentShadowGrade: { findMany: vi.fn() },
    agentStep: { findMany: vi.fn() },
    agentCharter: { findMany: vi.fn() },
    agentScorecard: { upsert: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { FLEET_CHARTERS } from './charter-registry.js'
import {
  computeScorecards,
  gradeScorecard,
  isPromotionEligible,
  readOutcomeAttribution,
  SCORECARD_WINDOWS,
} from './scorecard.service.js'

const db = vi.mocked(prisma, true)

const END = new Date('2026-08-06T00:00:00.000Z')
const daysAgo = (n: number) => new Date(END.getTime() - n * 24 * 3600_000)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentRun.findMany.mockResolvedValue([] as never)
  db.agentFinding.findMany.mockResolvedValue([] as never)
  db.agentPlan.findMany.mockResolvedValue([] as never)
  db.agentApproval.findMany.mockResolvedValue([] as never)
  db.agentShadowGrade.findMany.mockResolvedValue([] as never)
  db.agentStep.findMany.mockResolvedValue([] as never)
  db.agentCharter.findMany.mockResolvedValue([] as never)
  db.agentScorecard.upsert.mockResolvedValue({} as never)
})

describe('computeScorecards', () => {
  it('upserts one row per charter per window, keyed by the unique triple', async () => {
    const res = await computeScorecards(END)
    const charterCount = Object.keys(FLEET_CHARTERS).length
    expect(res.upserted).toBe(charterCount * SCORECARD_WINDOWS.length)
    expect(db.agentScorecard.upsert).toHaveBeenCalledTimes(res.upserted)
    const first = db.agentScorecard.upsert.mock.calls[0]![0]! as {
      where: { charterKey_periodStart_periodEnd: Record<string, unknown> }
    }
    expect(first.where.charterKey_periodStart_periodEnd).toBeDefined()
  })

  it('execution-dependent fields are honestly null/zero until Phase F', async () => {
    await computeScorecards(END)
    for (const call of db.agentScorecard.upsert.mock.calls) {
      const create = (call[0] as { create: Record<string, unknown> }).create
      expect(create.executed).toBe(0)
      expect(create.rolledBack).toBe(0)
      expect(create.calibrationError).toBeNull()
      expect(create.realisedImpactCents).toBeNull()
    }
  })

  it('computes findings/promoted/shadow-agreement for an analyst with evidence', async () => {
    db.agentFinding.findMany.mockImplementation((async (args: {
      where: { charterKey: string }
    }) => {
      if (args.where.charterKey === 'amazon-negative-miner') {
        return [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4' }, { id: 'f5' }]
      }
      return []
    }) as never)
    db.agentPlan.findMany.mockResolvedValue([
      { items: [{ findingId: 'f1' }, { findingId: 'f3' }, { findingId: 'other' }] },
    ] as never)
    db.agentShadowGrade.findMany.mockImplementation((async (args: {
      where: { findingId: { in: string[] } }
    }) => {
      if (args.where.findingId.in.includes('f1')) {
        return [
          { findingId: 'f1', agrees: true },
          { findingId: 'f2', agrees: true },
          { findingId: 'f3', agrees: true },
          { findingId: 'f4', agrees: false },
        ]
      }
      return []
    }) as never)

    await computeScorecards(END)
    const minerCalls = db.agentScorecard.upsert.mock.calls
      .map((c) => (c[0] as { create: Record<string, unknown> }).create)
      .filter((c) => c.charterKey === 'amazon-negative-miner')
    expect(minerCalls.length).toBe(SCORECARD_WINDOWS.length)
    const row = minerCalls[0]!
    expect(row.findings).toBe(5)
    expect(row.promoted).toBe(2) // f1 + f3 made it into a plan; 'other' is not ours
    expect(row.shadowAgreement).toBe(0.75)
  })

  it('acceptanceRate and costPerAcceptedAction are null without decisions', async () => {
    await computeScorecards(END)
    const row = (db.agentScorecard.upsert.mock.calls[0]![0] as {
      create: Record<string, unknown>
    }).create
    expect(row.acceptanceRate).toBeNull()
    expect(row.costPerAcceptedAction).toBeNull()
  })

  it('attributes approvals to the charter whose run queued them', async () => {
    db.agentRun.findMany.mockImplementation((async (args: {
      where: { agentKey: string }
    }) => {
      if (args.where.agentKey === 'amazon-ads-director') {
        return [{ id: 'run_dir', costUSD: '0.20' }]
      }
      return []
    }) as never)
    db.agentApproval.findMany.mockImplementation((async (args: {
      where: { agentRunId: { in: string[] } }
    }) => {
      if (args.where.agentRunId.in.includes('run_dir')) {
        return [
          { status: 'approved' },
          { status: 'approved' },
          { status: 'rejected' },
          { status: 'pending' },
        ]
      }
      return []
    }) as never)

    await computeScorecards(END)
    const dirRow = db.agentScorecard.upsert.mock.calls
      .map((c) => (c[0] as { create: Record<string, unknown> }).create)
      .find((c) => c.charterKey === 'amazon-ads-director')!
    expect(dirRow.approved).toBe(2)
    expect(dirRow.rejected).toBe(1)
    expect(dirRow.acceptanceRate).toBeCloseTo(2 / 3, 5)
    expect(dirRow.costUSD).toBeCloseTo(0.2, 5)
    expect(dirRow.costPerAcceptedAction).toBeCloseTo(0.1, 5)
  })
})

describe('gradeScorecard (policy v1, documented in the service)', () => {
  it('null with zero evidence', () => {
    expect(
      gradeScorecard({ findings: 0, runs: 0, validationFailureRate: null, shadowAgreement: null }),
    ).toBeNull()
  })
  it('F when validation failures exceed the 5% demotion line', () => {
    expect(
      gradeScorecard({ findings: 10, runs: 3, validationFailureRate: 0.06, shadowAgreement: 0.9 }),
    ).toBe('F')
  })
  it.each([
    [0.85, 'A'],
    [0.7, 'B'],
    [0.5, 'C'],
    [0.2, 'D'],
  ])('shadow agreement %f grades %s', (agreement, expected) => {
    expect(
      gradeScorecard({ findings: 10, runs: 3, validationFailureRate: 0, shadowAgreement: agreement }),
    ).toBe(expected)
  })
  it('C (unproven) when findings exist but nothing was shadow-graded', () => {
    expect(
      gradeScorecard({ findings: 4, runs: 2, validationFailureRate: 0, shadowAgreement: null }),
    ).toBe('C')
  })
})

describe('isPromotionEligible (Part 7 ladder, computable rungs only)', () => {
  const base = {
    grade: 'B' as string | null,
    validationFailureRate: 0 as number | null,
    trackDays: 20,
    acceptanceRate: null as number | null,
    calibrationError: null as number | null,
    rolledBack: 0,
  }
  it('OBSERVE → PROPOSE: 14 days + grade ≥ B', () => {
    expect(isPromotionEligible('OBSERVE', base)).toBe(true)
    expect(isPromotionEligible('OBSERVE', { ...base, grade: 'C' })).toBe(false)
    expect(isPromotionEligible('OBSERVE', { ...base, trackDays: 10 })).toBe(false)
    expect(isPromotionEligible('OBSERVE', { ...base, validationFailureRate: 0.08 })).toBe(false)
  })
  it('PROPOSE → AUTO: impossible without calibration evidence (null until F)', () => {
    expect(
      isPromotionEligible('PROPOSE', {
        ...base,
        trackDays: 40,
        acceptanceRate: 0.9,
        calibrationError: null,
      }),
    ).toBe(false)
  })
  it('PROPOSE → AUTO: the full bar when evidence exists', () => {
    const strong = {
      ...base,
      trackDays: 40,
      acceptanceRate: 0.75,
      calibrationError: 0.1,
    }
    expect(isPromotionEligible('PROPOSE', strong)).toBe(true)
    expect(isPromotionEligible('PROPOSE', { ...strong, acceptanceRate: 0.6 })).toBe(false)
    expect(isPromotionEligible('PROPOSE', { ...strong, calibrationError: 0.2 })).toBe(false)
    expect(isPromotionEligible('PROPOSE', { ...strong, rolledBack: 1 })).toBe(false)
  })
  it('OFF and AUTO are never eligible', () => {
    expect(isPromotionEligible('OFF', base)).toBe(false)
    expect(isPromotionEligible('AUTO', base)).toBe(false)
  })
})

describe('readOutcomeAttribution (null-honest until executions exist)', () => {
  it('returns unknown, never zero impact, with no executed actions', async () => {
    const out = await readOutcomeAttribution('amazon-ads-director', daysAgo(14), END)
    expect(out.executed).toBe(0)
    expect(out.realisedImpactCents).toBeNull()
    expect(out.calibrationError).toBeNull()
    expect(out.note).toMatch(/no executed/i)
  })
})
