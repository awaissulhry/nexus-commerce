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
  metaReadAll: vi.fn(async (_t: unknown, input: { path: string; query?: Record<string, unknown> }, onRows: (rows: unknown[]) => void) => {
    h.reads.push({ path: input.path, query: input.query ?? {} })
    const rows = ((h.answer(input.path, input.query ?? {}) as { data?: unknown[] }).data ?? [])
    onRows(rows)
    return { rows: rows.length, calls: 1, truncated: false }
  }),
}))

import { liveNewCopies, liveOpenStudies, livePageVideo, liveStudy, studyForeignProblem, type LiveStudy } from './live-optimize-changes.js'
import { metaPageReadOf } from '../../gateway/meta-page-reads.js'
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

describe('liveOpenStudies (round 2 B5)', () => {
  it('each open lift: does a cell measure the whole chosen account (read from its cells; null when Meta does not answer)', async () => {
    const lift = (id: string) => ({ id, name: `Lift ${id.slice(-2)}`, type: 'LIFT', start_time: iso(SINCE - 86400), end_time: iso(Math.floor(Date.now() / 1000) + 86400) })
    const { MetaReadError, localFailure } = await import('./errors.js')
    h.answer = (path) => {
      if (path.endsWith('/impacting_ad_studies')) return { data: [lift('120000000000041'), lift('120000000000042'), lift('120000000000043'), { id: '120000000000044', type: 'SPLIT_TEST', start_time: iso(SINCE), end_time: iso(Math.floor(Date.now() / 1000) + 86400) }] }
      if (path === '120000000000041/cells') return { data: [{ id: '1', adaccounts: ['act_1234567890'] }] }
      if (path === '120000000000042/cells') return { data: [{ id: '2', adaccounts: [], campaigns: { data: [{ id: C1 }] } }] }
      throw new MetaReadError(localFailure('Meta refused it.', 'X'), 'x', 1)
    }
    const out = await liveOpenStudies({ connectionId: 'm-1', adAccountId: '1234567890' } as MetaChosenAccount)
    expect(out.openLifts.map((l) => [l.studyId, l.wholeAccount])).toEqual([['120000000000041', true], ['120000000000042', false], ['120000000000043', null]])
  })
})

describe('follow-ups — lifts past the tenth; act_ account ids in a study\'s cells', () => {
  it('open lifts after the tenth count as not read (null), never dropped', async () => {
    const future = Math.floor(Date.now() / 1000) + 86400
    h.answer = (path) => {
      if (path.endsWith('/impacting_ad_studies')) return { data: Array.from({ length: 12 }, (_, i) => ({ id: String(120000000000060 + i), type: 'LIFT', start_time: iso(SINCE - 86400), end_time: iso(future) })) }
      return { data: [{ id: '1', adaccounts: [] }] }
    }
    const out = await liveOpenStudies({ connectionId: 'm-1', adAccountId: '1234567890' } as MetaChosenAccount)
    expect(out.openLifts).toHaveLength(12)
    expect(out.openLifts.slice(0, 10).every((l) => l.wholeAccount === false)).toBe(true)
    expect(out.openLifts.slice(10).map((l) => l.wholeAccount)).toEqual([null, null])
    expect(h.reads.filter((r) => r.path.endsWith('/cells'))).toHaveLength(10)
  })
  it('a study\'s cells read ad accounts written act_<id>, as numbers or as objects', async () => {
    h.answer = (path) => {
      if (path.endsWith('/impacting_ad_studies')) return { data: [{ id: '120000000000041', type: 'LIFT', start_time: iso(SINCE) }] }
      if (path === '120000000000041/cells') return { data: [{ id: '1', name: 'A', treatment_percentage: 90, control_percentage: 10, adaccounts: ['act_1234567890', 5555555555, { id: 'act_4444444444' }] }] }
      if (path.endsWith('/objectives') || path.endsWith('/viewers')) return { data: [] }
      return { id: '120000000000041', name: 'L', type: 'LIFT', business: { id: '120000000000090' } }
    }
    const s = await liveStudy({ connectionId: 'm-1', adAccountId: '1234567890' } as MetaChosenAccount, '120000000000041')
    expect(s.cells![0].adAccounts).toEqual(['1234567890', '5555555555', '4444444444'])
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

describe('gap 46b (re-review) — a Page video as a video test and a thumbnail read it', () => {
  it('one read of its exact list, the gateway\'s own Page-token read; another Page\'s video is refused', async () => {
    h.reads = []
    h.answer = (path) => ({ id: path, title: 'Clip A', published: true, from: { id: '120000000000010' } })
    expect(await livePageVideo({ connectionId: 'm-1', adAccountId: '1234567890' }, '120000000000010', '120000000000731')).toEqual({ id: '120000000000731', title: 'Clip A', published: true })
    expect(h.reads).toEqual([{ path: '120000000000731', query: { fields: 'id,title,published,from{id}' } }])
    expect(metaPageReadOf('120000000000731', ['120000000000731'], new URLSearchParams({ fields: 'id,title,published,from{id}' }), undefined)).toEqual({ pageId: null })
    h.answer = (path) => ({ id: path, title: 'Clip B', published: true, from: { id: '120000000000099' } })
    expect(await livePageVideo({ connectionId: 'm-1', adAccountId: '1234567890' }, '120000000000010', '120000000000732')).toEqual({ refusal: 'Video 120000000000732 is not one the chosen Facebook Page posted.' })
  })
})
