/**
 * The keyword feed on a real PostgreSQL (PGlite, production schema, business scoping): Brand Analytics weeks in
 * SearchQueryPerformance become KeywordRank rows for the keywords this business bids on — search volume only — once
 * per week however often it runs, never another business's, and the evaluator hands a Keyword Tracker rule the volume.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { runKeywordRankFeed, KEYWORD_RANK_FEED_SOURCE } from './keyword-rank-feed.service.js'
import { buildKeywordRankBidContexts } from '../../jobs/advertising-rule-evaluator.job.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_krf_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client

const WEEK = new Date('2026-09-27T00:00:00Z')
const sqp = (searchQuery: string, searchQueryVolume: number, asin: string | null, startDate = WEEK, marketplace = 'IT') => ({
  marketplace, reportPeriod: 'WEEK', startDate, searchQuery, asin, searchQueryVolume,
})

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    await db().campaign.create({ data: { id: 'krf-c', name: 'GALE IT', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'KRF-C' } })
    await db().adGroup.create({ data: { id: 'krf-g', campaignId: 'krf-c', name: 'GALE IT', externalAdGroupId: 'KRF-G', defaultBidCents: 40 } as never })
    await db().adTarget.createMany({ data: [
      { id: 'krf-t1', adGroupId: 'krf-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'Giacca Moto', bidCents: 30 },
      { id: 'krf-t2', adGroupId: 'krf-g', kind: 'KEYWORD', expressionType: 'PHRASE', expressionValue: 'giacca moto uomo', bidCents: 25 },
      { id: 'krf-neg', adGroupId: 'krf-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'giacca moto donna', isNegative: true, bidCents: 0 },
    ] as never })
    await db().searchQueryPerformance.createMany({ data: [
      sqp('giacca moto', 6150, 'B0GALE1'), sqp('giacca moto', 6150, 'B0GALE2'), sqp('giacca moto', 6150, null),
      sqp('giacca moto uomo', 2210, 'B0GALE1'),
      sqp('giacca moto donna', 900, 'B0GALE1'), // negative target: not a keyword we bid on
      sqp('casco integrale', 12000, 'B0GALE1'), // not bid on at all
      sqp('giacca moto', 5800, 'B0GALE1', new Date('2026-09-20T00:00:00Z')),
    ] as never })
  })
  // Another business holds the same keyword: it must never reach this one's feed.
  await inside(() => db().searchQueryPerformance.create({ data: sqp('giacca moto uomo', 99999, 'B0OTHER', new Date('2026-09-20T00:00:00Z')) as never }), OTHER)
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('keyword feed — real PostgreSQL', () => {
  it('writes one search-volume reading per bid-on keyword and week, every rank NULL, and nothing twice', async () => {
    const now = new Date('2026-10-07T06:40:00Z')
    const first = await inside(() => runKeywordRankFeed(now))
    expect(first.created).toBe(3)
    const rows = await inside(() => db().keywordRank.findMany({ orderBy: [{ capturedAt: 'asc' }, { keyword: 'asc' }] }))
    expect(rows.map((r) => [r.keyword, r.marketplace, r.searchVolume, r.capturedAt.toISOString().slice(0, 10), r.organicRank, r.sponsoredRank, r.asin, r.source, r.workspaceId])).toEqual([
      ['giacca moto', 'IT', 5800, '2026-09-27', null, null, null, KEYWORD_RANK_FEED_SOURCE, A],
      ['giacca moto', 'IT', 6150, '2026-10-04', null, null, null, KEYWORD_RANK_FEED_SOURCE, A],
      ['giacca moto uomo', 'IT', 2210, '2026-10-04', null, null, null, KEYWORD_RANK_FEED_SOURCE, A],
    ])
    const again = await inside(() => runKeywordRankFeed(now))
    expect(again.created).toBe(0)
    expect(again.plan.alreadyWritten).toBe(3)
    expect(await inside(() => db().keywordRank.count())).toBe(3)
    expect(await inside(() => db().keywordRank.count(), OTHER)).toBe(0)
  })

  it('the Keyword Tracker context carries the volume and no rank', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T07:00:00Z'))
    try {
      const ctxs = await inside(() => buildKeywordRankBidContexts()) as Array<{ adTarget: Record<string, unknown> }>
      const byId = Object.fromEntries(ctxs.map((c) => [c.adTarget.id, c.adTarget]))
      expect(byId['krf-t1']).toMatchObject({ searchVolume: 6150 })
      expect(byId['krf-t2']).toMatchObject({ searchVolume: 2210 })
      for (const t of [byId['krf-t1'], byId['krf-t2']]) for (const k of ['organicRank', 'sponsoredRank', 'rankDelta']) expect(k in t).toBe(false)
      expect(byId['krf-neg']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
