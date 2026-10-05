/**
 * CC-6 — bid suggestions follow the launch market. `suggestBids` accepted `marketplace` and ignored it, so every
 * market's builder read one account-wide median (and every builder asked for Italy's).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ adTarget: { findMany: vi.fn() } }))
vi.mock('../../db.js', () => ({ default: db }))

import { suggestBids } from './ads-bid-suggest.service.js'

beforeEach(() => { db.adTarget.findMany.mockReset(); db.adTarget.findMany.mockResolvedValue([]) })

describe('CC-6 — suggestBids reads the asked market only', () => {
  it('🔴 a marketplace narrows the CPC corpus to that market\'s campaigns', async () => {
    await suggestBids({ keywords: [], marketplace: 'DE' })
    expect(db.adTarget.findMany.mock.calls[0][0].where).toMatchObject({ kind: 'KEYWORD', adGroup: { campaign: { marketplace: 'DE' } } })
  })

  it('no marketplace → the whole account, as before', async () => {
    await suggestBids({ keywords: [] })
    expect(db.adTarget.findMany.mock.calls[0][0].where).not.toHaveProperty('adGroup')
  })

  it('a market with no CPC data answers with the default and says it measured nothing', async () => {
    const r = await suggestBids({ keywords: [], marketplace: 'FR' })
    expect(r).toMatchObject({ accountMedianCpcCents: null, defaultBidCents: 50 })
  })
})
