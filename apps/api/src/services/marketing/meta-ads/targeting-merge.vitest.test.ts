/**
 * Q7 — the targeting merge: one live read of the ad set (its targeting and the caller's fields), refused in words when Meta
 * answers none or one holding a number JavaScript cannot carry; the spec sent keeps every other key exactly as read, in
 * place, drops Meta's read-only `effective_…` keys, sets only the named keys (null removes one) and says each one's
 * before → after. Made-up ids.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ body: null as unknown, reads: [] as unknown[] }))
vi.mock('./read-client.js', () => ({ metaReadOne: vi.fn(async (_t: unknown, req: unknown) => { h.reads.push(req); return { body: h.body, calls: 1 } }) }))

import { mergeTargeting, readAdSetTargeting } from './targeting-merge.js'
import { MetaLiveRefusal } from './live.js'

const LIVE = { geo_locations: { countries: ['IT'] }, effective_publisher_platforms: ['facebook'], age_min: 18, brand_safety_content_filter_levels: ['FEED_STANDARD'] }

describe('mergeTargeting', () => {
  it('sets only the named keys, keeps the rest exactly and in place, leaves read-only keys out, says what moved', () => {
    const m = mergeTargeting(LIVE, { brand_safety_content_filter_levels: ['FEED_STRICT'], excluded_publisher_categories: ['gambling'] })
    expect(m.spec).toEqual({ geo_locations: { countries: ['IT'] }, age_min: 18, brand_safety_content_filter_levels: ['FEED_STRICT'], excluded_publisher_categories: ['gambling'] })
    expect(Object.keys(m.spec)).toEqual(['geo_locations', 'age_min', 'brand_safety_content_filter_levels', 'excluded_publisher_categories'])
    expect(m.sent).toBe(JSON.stringify(m.spec))
    expect(m.changed).toEqual([
      { key: 'brand_safety_content_filter_levels', from: ['FEED_STANDARD'], to: ['FEED_STRICT'] },
      { key: 'excluded_publisher_categories', from: null, to: ['gambling'] },
    ])
  })
  it('null removes a key; a key set to what it is moves nothing; a read-only key is never set', () => {
    expect(mergeTargeting(LIVE, { brand_safety_content_filter_levels: null })).toMatchObject({ spec: { geo_locations: { countries: ['IT'] }, age_min: 18 }, changed: [{ key: 'brand_safety_content_filter_levels', to: null }] })
    expect(mergeTargeting(LIVE, { brand_safety_content_filter_levels: ['FEED_STANDARD'] }).changed).toEqual([])
    expect(() => mergeTargeting(LIVE, { effective_publisher_platforms: ['instagram'] })).toThrow(MetaLiveRefusal)
  })
  it('review B1 — subscriber_universe (read-only, placement-targeting.md) is left out like effective_ keys, never set', () => {
    const m = mergeTargeting({ ...LIVE, subscriber_universe: { messaging_customer_base_for_whatsapp: { id: '1', name: 'Base A' } } }, { excluded_publisher_categories: ['dating'] })
    expect(m.spec).not.toHaveProperty('subscriber_universe')
    expect(() => mergeTargeting(LIVE, { subscriber_universe: {} })).toThrow(MetaLiveRefusal)
  })
})

describe('readAdSetTargeting', () => {
  it('one read of the ad set with its targeting and the caller\'s fields', async () => {
    h.body = { id: '120000000000002', name: 'Ad set B', targeting: LIVE }
    const read = await readAdSetTargeting('m-1', '120000000000002', ['id', 'name', 'targeting'])
    expect(h.reads).toEqual([{ operation: 'targeting.read', path: '120000000000002', query: { fields: 'id,name,targeting' } }])
    expect(read).toEqual({ node: h.body, targeting: LIVE })
  })
  it('refused in words: no targeting, or a number Nexus cannot carry exactly', async () => {
    h.body = { id: '120000000000002' }
    await expect(readAdSetTargeting('m-1', '120000000000002')).rejects.toThrow(/answered no targeting/)
    h.body = JSON.parse('{"targeting":{"custom_audiences":[{"id":123456789012345678}]}}')
    await expect(readAdSetTargeting('m-1', '120000000000002')).rejects.toThrow(/cannot carry exactly/)
  })
})
