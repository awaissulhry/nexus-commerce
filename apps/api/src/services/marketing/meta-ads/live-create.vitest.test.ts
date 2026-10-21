/**
 * Meta step 19 — the undo's live read of what a create or copy made (live-create.ts liveMadeObject): an ad of an ad set
 * with ANY ad sequence, or a dynamic creative ad, is one Meta refuses to delete (reference/adgroup.md; error 1340029); its
 * account and status are read; a day in the ad account's time zone. Meta is a stand-in; made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ body: {} as Record<string, unknown>, reads: [] as Array<Record<string, unknown>> }))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Record<string, unknown>) => { h.reads.push(req); return { body: h.body, calls: 1 } }),
  metaReadAll: vi.fn(async () => ({ rows: 0, calls: 1, truncated: false })),
}))

import { dayIn, liveMadeObject } from './live-create.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const AD = '120000000000013'
const ad = (adSet: Record<string, unknown>) => ({ id: AD, account_id: '1234567890', status: 'PAUSED', effective_status: 'ADSET_PAUSED', adset_id: '120000000000002', creative: { id: '1' }, insights: { data: [] }, adset: { id: '120000000000002', ...adSet } })

beforeEach(() => { h.reads = []; h.body = {} })

describe('liveMadeObject — an ad Meta refuses to delete', () => {
  it('any ad of an ad set with an ad sequence, even one the sequence does not list', async () => {
    h.body = ad({ creative_sequence: ['120000000000077'] })
    const now = await liveMadeObject(target, 'ad', AD, '2026-10-21T08:00:00.000Z')
    expect(now.undeletable).toMatch(/ad set with an ad sequence/)
    expect(String(h.reads[0].query && (h.reads[0].query as Record<string, unknown>).fields)).toMatch(/adset\{id,creative_sequence,is_dynamic_creative\}/)
  })
  it('a dynamic creative ad (only its ad set can be deleted: 1340029)', async () => {
    h.body = ad({ is_dynamic_creative: true })
    expect((await liveMadeObject(target, 'ad', AD, '2026-10-21T08:00:00.000Z')).undeletable).toMatch(/dynamic creative ad/)
  })
  it('an ordinary ad: deletable, its spend and statuses as Meta read them', async () => {
    h.body = ad({ creative_sequence: [], is_dynamic_creative: false })
    expect(await liveMadeObject(target, 'ad', AD, '2026-10-21T08:00:00.000Z')).toMatchObject({ there: true, status: 'PAUSED', effectiveStatus: 'ADSET_PAUSED', spend: 0, undeletable: null })
  })
  it('another account\'s object is refused; a deleted one is gone', async () => {
    h.body = { ...ad({}), account_id: '5555555555' }
    await expect(liveMadeObject(target, 'ad', AD, '2026-10-21T08:00:00.000Z')).rejects.toThrow(/not of the Meta ad account this business chose/)
    h.body = { ...ad({}), status: 'DELETED' }
    expect(await liveMadeObject(target, 'ad', AD, '2026-10-21T08:00:00.000Z')).toMatchObject({ there: false })
  })
})

describe('dayIn', () => {
  it('the ad account\'s date, UTC when the zone is unknown', () => {
    const lateUtc = Date.UTC(2026, 9, 21, 23, 30)
    expect(dayIn(lateUtc, 'Europe/Rome')).toBe('2026-10-22')
    expect(dayIn(lateUtc, 'America/Los_Angeles')).toBe('2026-10-21')
    expect(dayIn(lateUtc, null)).toBe('2026-10-21')
    expect(dayIn(lateUtc, 'Not/AZone')).toBe('2026-10-21')
  })
})
