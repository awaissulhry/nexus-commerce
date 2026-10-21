/**
 * Meta step 28 — the reads step 28's changes stand on (Meta is a stand-in): the copies an apply made are found by Meta's
 * own source field in the account's objects changed since the run started (one with no source is kept apart, found by its
 * time only; one made before the run is never a copy); a study change is refused when the study is not the chosen
 * account's portfolio's, or holds another account. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ reads: [] as Array<{ path: string; query: Record<string, unknown> }>, answer: (_path: string, _query: Record<string, unknown>): unknown => ({}) }))
vi.mock('../../../db.js', () => ({ default: {} }))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, input: { path: string; query?: Record<string, unknown> }) => {
    h.reads.push({ path: input.path, query: input.query ?? {} })
    return { body: h.answer(input.path, input.query ?? {}), calls: 1 }
  }),
  metaReadAll: vi.fn(),
}))

import { liveNewCopies, studyForeignProblem, type LiveStudy } from './live-optimize-changes.js'
import type { MetaChosenAccount } from './live.js'

const T = { connectionId: 'm-1', adAccountId: '1234567890' }
const SINCE = 4_102_444_800
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', '+0000')
const S1 = '120000000000201'
const C1 = '120000000000101'

beforeEach(() => { h.reads = [] })

describe('liveNewCopies (review A4)', () => {
  it('by Meta\'s source field, among the account\'s ad sets changed since the run started; time-only finds kept apart', async () => {
    h.answer = () => ({
      data: [
        { id: '120000000000209', name: 'Copy', status: 'ACTIVE', created_time: iso(SINCE + 5), source_adset_id: S1, campaign_id: C1 },
        { id: '120000000000210', name: 'No source', status: 'ACTIVE', created_time: iso(SINCE + 9), campaign_id: C1 },
        { id: '120000000000211', name: 'Older', status: 'ACTIVE', created_time: iso(SINCE - 60), source_adset_id: S1, campaign_id: C1 },
        { id: '120000000000212', name: 'Other source', status: 'ACTIVE', created_time: iso(SINCE + 9), source_adset_id: '120000000000299', campaign_id: C1 },
        { id: '120000000000213', name: 'Elsewhere', status: 'ACTIVE', created_time: iso(SINCE + 9), campaign_id: '120000000000199' },
        { id: S1, name: 'The source itself', status: 'ACTIVE', created_time: iso(SINCE + 9), campaign_id: C1 },
      ],
    })
    const found = await liveNewCopies(T, 'adset', new Set([S1]), new Set([C1]), SINCE)
    expect(found).toEqual([
      { kind: 'adset', id: '120000000000209', name: 'Copy', status: 'ACTIVE', sourceId: S1, foundBy: 'source' },
      { kind: 'adset', id: '120000000000210', name: 'No source', status: 'ACTIVE', sourceId: null, foundBy: 'time' },
    ])
    expect(h.reads[0]).toMatchObject({ path: 'act_1234567890/adsets', query: { fields: 'id,name,status,created_time,source_adset_id,campaign_id', updated_since: SINCE } })
  })
  it('ads by source_ad_id in the ad set; a list Meta does not answer is null (said, nothing paused)', async () => {
    h.answer = () => ({ data: [{ id: '120000000000309', status: 'PAUSED', created_time: iso(SINCE + 1), source_ad_id: '120000000000301', adset_id: S1 }] })
    expect(await liveNewCopies(T, 'ad', new Set(['120000000000301']), new Set([S1]), SINCE)).toEqual([{ kind: 'ad', id: '120000000000309', name: null, status: 'PAUSED', sourceId: '120000000000301', foundBy: 'source' }])
    expect(h.reads[0].path).toBe('act_1234567890/ads')
    const { MetaReadError } = await import('./errors.js')
    const { localFailure } = await import('./errors.js')
    h.answer = () => { throw new MetaReadError(localFailure('Meta refused it.', 'X'), 'x', 1) }
    expect(await liveNewCopies(T, 'ad', new Set(['1']), new Set(), SINCE)).toBeNull()
  })
})

describe('studyForeignProblem (review A8)', () => {
  const account = { connectionId: 'm-1', adAccountId: '1234567890' } as MetaChosenAccount
  const study = (o: Partial<LiveStudy> = {}): LiveStudy => ({
    id: '120000000000041', name: 'T', description: null, type: 'SPLIT_TEST', businessId: '120000000000090', startTime: null, endTime: null,
    observationEndTime: null, cooldownStartTime: null, canceled: false, state: 'running', cells: [{ id: '1', name: 'A', treatment: 50, control: null, adAccounts: ['1234567890'], campaigns: [], adSets: [], ads: [] }],
    cellsNote: null, objectives: [], viewers: [], ...o,
  })
  it('a study of another portfolio is refused, as the gateway does; another ad account in a cell too', async () => {
    h.answer = () => ({ id: 'act_1234567890', business: { id: '120000000000090' } })
    expect(await studyForeignProblem(account, study({ businessId: '120000000000099' }))).toMatch(/not owned by the business portfolio/)
    expect(h.reads[0]).toMatchObject({ path: 'act_1234567890', query: { fields: 'business{id}' } })
    expect(await studyForeignProblem(account, study({ cells: [{ id: '1', name: 'A', treatment: 50, control: 10, adAccounts: ['5555555555'], campaigns: [], adSets: [], ads: [] }] }))).toMatch(/another ad account/)
    expect(await studyForeignProblem(account, study())).toBeNull()
  })
})
