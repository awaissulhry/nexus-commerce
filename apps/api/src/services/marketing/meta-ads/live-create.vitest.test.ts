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

import { dayIn, liveCopySource, liveMadeObject } from './live-create.js'

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

/** Top-level names of a Graph `fields` value (nested {…} and modifier (…) skipped). */
function topLevel(fields: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of fields) {
    if (c === '{' || c === '(') depth++
    else if (c === '}' || c === ')') depth--
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    if (depth === 0) cur += c
  }
  out.push(cur)
  return out.map((n) => n.split('.')[0].trim()).filter(Boolean)
}
const twice = (fields: string) => topLevel(fields).filter((n, i, all) => all.indexOf(n) !== i)
const fieldsOf = (r: Record<string, unknown>) => String((r.query as Record<string, unknown> | undefined)?.fields ?? '')

describe('every read names each field once (Graph 2500 "Field … specified more than once", live 2026-10-22)', () => {
  const C = '120000000000001'
  const S = '120000000000002'
  const campaign = { id: C, account_id: '1234567890', name: 'C', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: [] }
  it('the undo read of a campaign, an ad set and an ad', async () => {
    for (const [kind, body] of [['campaign', campaign], ['adset', { ...campaign, objective: undefined, optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS' }], ['ad', ad({})]] as const) {
      h.reads = []
      h.body = body as Record<string, unknown>
      await liveMadeObject(target, kind, C, '2026-10-21T08:00:00.000Z')
      for (const r of h.reads) expect(twice(fieldsOf(r)), `${kind} ${String(r.operation)}`).toEqual([])
    }
    h.reads = []
    h.body = campaign
    await liveMadeObject(target, 'campaign', C, '2026-10-21T08:00:00.000Z')
    expect(fieldsOf(h.reads[0])).toBe('id,account_id,status,effective_status,objective,insights.date_preset(maximum){spend}')
  })
  it('what a copy reads: the source and its parent campaign', async () => {
    h.body = { ...campaign, campaign_id: C, optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS', adset_id: S, creative: { id: '1' } }
    for (const kind of ['campaign', 'adset', 'ad'] as const) {
      h.reads = []
      await liveCopySource(target, kind, S, false)
      expect(h.reads.length).toBeGreaterThan(0)
      for (const r of h.reads) expect(twice(fieldsOf(r)), `${kind} ${String(r.operation)}`).toEqual([])
    }
  })
})
