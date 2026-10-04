/**
 * Pre-F fix (NAF V8): the local dedupe probe must match BOTH negative
 * spellings. The v1 sync stores negatives as expressionType 'EXACT' /
 * 'PHRASE' with isNegative=true (1,068 such rows on prod — see
 * reference_adtarget_isnegative_not_expressiontype); locally-minted
 * mirror rows store 'NEGATIVE_EXACT' / 'NEGATIVE_PHRASE'. A probe that
 * matches only the NEGATIVE_* spelling misses every synced negative and
 * re-POSTs it to Amazon the moment an execute path exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findFirst: vi.fn() },
    adGroup: { findFirst: vi.fn() },
    adTarget: { findFirst: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { negativeExistsLocally } from './ads-negative-kw.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.campaign.findFirst.mockResolvedValue({ id: 'c1' } as never)
  db.adGroup.findFirst.mockResolvedValue({ id: 'g1' } as never)
  db.adTarget.findFirst.mockResolvedValue(null as never)
})

const baseArgs = {
  profileId: 'p1',
  marketplace: 'IT',
  externalCampaignId: 'ext1',
  keywordText: 'giacca moto',
  matchType: 'NEGATIVE_EXACT' as const,
}

describe('negativeExistsLocally — both spellings', () => {
  it('CAMPAIGN scope probes NEGATIVE_EXACT and the synced EXACT spelling', async () => {
    await negativeExistsLocally({ ...baseArgs, scope: 'CAMPAIGN' })
    const where = (db.adTarget.findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>
    }).where
    expect(where.isNegative).toBe(true)
    expect(where.expressionType).toEqual({ in: ['NEGATIVE_EXACT', 'EXACT'] })
  })

  it('AD_GROUP scope probes both spellings too', async () => {
    await negativeExistsLocally({
      ...baseArgs,
      scope: 'AD_GROUP',
      externalAdGroupId: 'eag1',
      matchType: 'NEGATIVE_PHRASE',
    })
    const where = (db.adTarget.findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>
    }).where
    expect(where.expressionType).toEqual({ in: ['NEGATIVE_PHRASE', 'PHRASE'] })
  })

  it('a synced-shape row short-circuits the create', async () => {
    db.adTarget.findFirst.mockResolvedValue({ id: 't-synced' } as never)
    expect(await negativeExistsLocally({ ...baseArgs, scope: 'CAMPAIGN' })).toBe(true)
  })
})

/**
 * 5b (review 7.6) — a retired negative could never be added again: the probe ignored status and compared the text
 * case-sensitively. An ARCHIVED row is absent now, and the text matches whatever its case.
 */
describe('negativeExistsLocally — retired is absent, case does not matter', () => {
  it('skips ARCHIVED rows and compares the text case-insensitively', async () => {
    await negativeExistsLocally({ ...baseArgs, keywordText: '  Giacca Moto ', scope: 'CAMPAIGN' })
    const where = (db.adTarget.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.status).toEqual({ not: 'ARCHIVED' })
    expect(where.expressionValue).toEqual({ equals: 'Giacca Moto', mode: 'insensitive' })
    expect(where.negativeLevel).toBe('CAMPAIGN')
  })

  it('AD_GROUP scope takes the ad-group rows, and the v1 sync\'s rows that carry no level', async () => {
    await negativeExistsLocally({ ...baseArgs, scope: 'AD_GROUP', externalAdGroupId: 'eag1' })
    const where = (db.adTarget.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.adGroupId).toBe('g1')
    expect(where.OR).toEqual([{ negativeLevel: 'AD_GROUP' }, { negativeLevel: null }])
    expect(where.status).toEqual({ not: 'ARCHIVED' })
  })
})
