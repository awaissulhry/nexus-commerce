/**
 * NAF.B — shadow grading: pure matching of a finding against the engine
 * output in the observation it cites, plus the persistence pass. All
 * deterministic code — no model anywhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentFinding: { findMany: vi.fn() },
    agentObservation: { findUnique: vi.fn() },
    agentShadowGrade: { upsert: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { gradeFindings, matchFinding } from './shadow-grade.service.js'

const db = vi.mocked(prisma, true)

const NEG_PAYLOAD = {
  negatives: [
    { query: 'giacca pelle', externalCampaignId: 'ec1', costCents: 4000, orders: 0 },
  ],
  ngramWasteful: [{ gram: 'pelle', costCents: 900, orders: 0 }],
}
const HARVEST_PAYLOAD = {
  graduations: [
    { query: 'giacca moto estiva', externalCampaignId: 'ec2', orders: 4 },
  ],
  productGraduations: [{ query: 'b0abc12345', orders: 3 }],
}
const BID_PAYLOAD = {
  proposals: [
    { targetId: 't1', deltaCents: -20, currentBidCents: 80, proposedBidCents: 60 },
    { targetId: 't2', deltaCents: 15, currentBidCents: 40, proposedBidCents: 55 },
  ],
}

describe('matchFinding (pure)', () => {
  it('agrees when the engine lists the same negative term', () => {
    const v = matchFinding(
      { kind: 'waste_term', entityId: 'ec1:giacca pelle' },
      'negative-candidates',
      NEG_PAYLOAD,
    )
    expect(v).not.toBeNull()
    expect(v!.agrees).toBe(true)
    expect(v!.engineProposal).toHaveLength(1)
  })

  it('disagrees with a reason when the engine did not propose the entity', () => {
    const v = matchFinding(
      { kind: 'waste_term', entityId: 'ec9:unknown term' },
      'negative-candidates',
      NEG_PAYLOAD,
    )
    expect(v!.agrees).toBe(false)
    expect(v!.engineProposal).toHaveLength(0)
    expect(v!.disagreementReason).toMatch(/did not propose/i)
  })

  it('matches ngram themes by gram', () => {
    const v = matchFinding(
      { kind: 'waste_theme', entityId: 'ngram:pelle' },
      'negative-candidates',
      NEG_PAYLOAD,
    )
    expect(v!.agrees).toBe(true)
  })

  it('agrees on harvest candidates by composite id', () => {
    const v = matchFinding(
      { kind: 'harvest_candidate', entityId: 'ec2:giacca moto estiva' },
      'harvest-candidates',
      HARVEST_PAYLOAD,
    )
    expect(v!.agrees).toBe(true)
  })

  it('bids agree only when the DIRECTION matches the engine delta', () => {
    // engine lowers t1 (delta -20): 'bid_above_target' agrees…
    expect(
      matchFinding({ kind: 'bid_above_target', entityId: 't1' }, 'bid-proposals', BID_PAYLOAD)!.agrees,
    ).toBe(true)
    // …but 'bid_below_target' on the same target is a direction mismatch
    const v = matchFinding(
      { kind: 'bid_below_target', entityId: 't1' },
      'bid-proposals',
      BID_PAYLOAD,
    )
    expect(v!.agrees).toBe(false)
    expect(v!.disagreementReason).toMatch(/direction/i)
  })

  it('returns null for observations that are not engine evidence (cron-health)', () => {
    expect(
      matchFinding({ kind: 'cron_failing', entityId: 'cron:x' }, 'cron-health', { jobs: [] }),
    ).toBeNull()
  })
})

describe('gradeFindings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.agentShadowGrade.upsert.mockResolvedValue({} as never)
  })

  it('persists one grade per gradeable finding, keyed by findingId', async () => {
    db.agentFinding.findMany.mockResolvedValue([
      {
        id: 'f1',
        runId: 'r1',
        kind: 'waste_term',
        entityId: 'ec1:giacca pelle',
        evidenceRefs: ['obs_neg'],
      },
      {
        id: 'f2',
        runId: 'r1',
        kind: 'cron_failing',
        entityId: 'cron:x',
        evidenceRefs: ['obs_cron'],
      },
    ] as never)
    db.agentObservation.findUnique.mockImplementation(
      (args: never) =>
        Promise.resolve(
          (args as { where: { id: string } }).where.id === 'obs_neg'
            ? { id: 'obs_neg', key: 'negative-candidates', payload: NEG_PAYLOAD }
            : { id: 'obs_cron', key: 'cron-health', payload: { jobs: [] } },
        ) as never,
    )
    const r = await gradeFindings(['r1'])
    expect(r.graded).toBe(1) // cron-health finding is not gradeable
    expect(db.agentShadowGrade.upsert).toHaveBeenCalledTimes(1)
    const up = db.agentShadowGrade.upsert.mock.calls[0]![0]! as Record<string, never>
    expect((up.where as { findingId: string }).findingId).toBe('f1')
    expect((up.create as { agrees: boolean }).agrees).toBe(true)
  })
})
