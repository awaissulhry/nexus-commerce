/**
 * NAF.AC.4 — scope is ENFORCED, not decoration: a worker scoped to one
 * marketplace never sees another market's candidates, and every drop is
 * counted rather than silent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({
  default: { campaign: { findMany: vi.fn() } },
}))

import prisma from '../../../db.js'
import { filterToMarketplace, singleMarketplace } from './scope-filter.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.campaign.findMany.mockResolvedValue([
    { externalCampaignId: 'it-1', marketplace: 'IT' },
    { externalCampaignId: 'de-1', marketplace: 'DE' },
  ] as never)
})

describe('filterToMarketplace', () => {
  it('keeps only the scoped market and counts what it dropped', async () => {
    const out = await filterToMarketplace(
      [
        { externalCampaignId: 'it-1', query: 'a' },
        { externalCampaignId: 'de-1', query: 'b' },
      ],
      'IT',
    )
    expect(out.kept.map((r) => r.query)).toEqual(['a'])
    expect(out.droppedOutOfScope).toBe(1)
  })

  it('a candidate whose campaign cannot be resolved is dropped and counted', async () => {
    const out = await filterToMarketplace(
      [{ externalCampaignId: 'ghost', query: 'x' }],
      'IT',
    )
    expect(out.kept).toHaveLength(0)
    expect(out.unresolved).toBe(1)
  })

  it('no scope → everything passes, and no query is made', async () => {
    const rows = [{ externalCampaignId: 'it-1', query: 'a' }]
    const out = await filterToMarketplace(rows, undefined)
    expect(out.kept).toBe(rows)
    expect(db.campaign.findMany).not.toHaveBeenCalled()
  })
})

describe('singleMarketplace', () => {
  it.each([
    [undefined, undefined],
    [[], undefined],
    [['IT'], 'IT'],
    [['IT', 'DE'], undefined], // multi-market is not enforced, so not claimed
  ])('%o → %o', (input, expected) => {
    expect(singleMarketplace(input as string[] | undefined)).toBe(expected)
  })
})
