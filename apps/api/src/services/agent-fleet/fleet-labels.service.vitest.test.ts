/**
 * FX.1 — names, not IDs: the server resolves every entity reference the
 * fleet UI might show (external campaign ids in args and entityIds,
 * AdTarget cuids from bid findings) into human labels. Unknown ids are
 * omitted — the client falls back to the id rather than a wrong name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn() },
    adTarget: { findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { resolveFleetLabels } from './fleet-labels.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.campaign.findMany.mockResolvedValue([
    { externalCampaignId: '218394170642485', name: 'XAVIA IT Broad', marketplace: 'IT' },
    { externalCampaignId: '242957913137679', name: 'XAVIA FR Auto', marketplace: 'FR' },
  ] as never)
  db.adTarget.findMany.mockResolvedValue([
    {
      id: 'cms1f56301abfqp01vucd4133',
      expressionValue: 'motorrad jacke',
      expressionType: 'EXACT',
      adGroup: { campaign: { name: 'XAVIA DE Exact', marketplace: 'DE' } },
    },
  ] as never)
})

describe('resolveFleetLabels', () => {
  it('resolves campaign ids from args and entityIds, and target cuids', async () => {
    const labels = await resolveFleetLabels({
      args: [
        { externalCampaignId: '218394170642485', keywordText: 'x' },
        { sourceExternalCampaignId: '242957913137679' },
        { targetId: 'cms1f56301abfqp01vucd4133', proposedBidCents: 98 },
      ],
      entityIds: ['218394170642485:giacca moto uomo', 'ngram:protezioni'],
    })
    expect(labels.campaigns['218394170642485']).toEqual({
      name: 'XAVIA IT Broad',
      marketplace: 'IT',
    })
    expect(labels.campaigns['242957913137679']).toEqual({
      name: 'XAVIA FR Auto',
      marketplace: 'FR',
    })
    expect(labels.targets['cms1f56301abfqp01vucd4133']).toEqual({
      text: 'motorrad jacke',
      matchType: 'EXACT',
      campaignName: 'XAVIA DE Exact',
      marketplace: 'DE',
    })
  })

  it('unknown ids are omitted, never guessed', async () => {
    db.campaign.findMany.mockResolvedValue([] as never)
    db.adTarget.findMany.mockResolvedValue([] as never)
    const labels = await resolveFleetLabels({
      args: [{ externalCampaignId: '999999999999999' }],
      entityIds: [],
    })
    expect(labels.campaigns).toEqual({})
    expect(labels.targets).toEqual({})
  })

  it('nothing to resolve → no queries at all', async () => {
    const labels = await resolveFleetLabels({ args: [{ keywordText: 'solo' }], entityIds: ['ngram:x'] })
    expect(labels).toEqual({ campaigns: {}, targets: {} })
    expect(db.campaign.findMany).not.toHaveBeenCalled()
    expect(db.adTarget.findMany).not.toHaveBeenCalled()
  })
})
