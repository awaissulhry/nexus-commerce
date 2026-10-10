/**
 * Harvest fix B11 — every row of the `ads-brain` view harvest carries its harvestId, the id apply-brain-harvest asks for
 * (brain/harvest-read.ts harvestView, pure); a dry run's decision, never stored, carries none. Values are made up (public
 * repo).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

const { harvestView } = await import('./harvest-read.js')

const row = (over: Record<string, unknown> = {}) => ({
  id: 'hv-1', term: 'touring jacket', isAsin: false, status: 'PROPOSED', level: 'PROPOSE', destinationKind: 'EXISTING', destHow: 'own', destCampaignId: 'c-exact', destAdGroupId: 'g-exact',
  bidCents: 40, keywordTargetId: null, landedAt: null, sources: [], approvalId: 'ap-1', undoApprovalId: null, attempts: 0, lastError: null, heldBy: null, why: 'graduate it to exact',
  evidence: { clicks: 150, orders: 5 }, judgeAfter: null, judgedAt: null, verdict: null, judgement: null, decidedAt: new Date('2026-10-09T05:25:00Z'), changedAt: new Date('2026-10-09T05:25:00Z'),
  ...over,
})

describe('harvest fix B11 — the view names each harvest by the id apply-brain-harvest takes', () => {
  it('a stored row carries its harvestId', () => {
    expect(harvestView(row() as never)).toMatchObject({ harvestId: 'hv-1', term: 'touring jacket', status: 'PROPOSED', request: 'ap-1' })
  })

  it('a dry run\'s decision (not stored) carries none: there is nothing to ask for yet', () => {
    expect(harvestView(row({ id: null, status: 'SHADOW', approvalId: null }) as never)).toMatchObject({ harvestId: null, status: 'SHADOW' })
  })
})
