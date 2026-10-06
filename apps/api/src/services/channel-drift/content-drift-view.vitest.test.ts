import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * E5a — the sheet's view of a content read-back (`contentDriftByListing`). The rows are written by the ONE writer
 * (`recordChannelReadback`) into an in-memory table, so what is pinned is the round trip: "Differs on Etsy" exactly when
 * the stored row says the source's LAST read compared and differed — never for a listing not read, read without a
 * comparison, or read clean — in one query for the whole sheet. Every id is invented.
 */
const m = vi.hoisted(() => ({
  rows: [] as Array<Record<string, any>>,
  findMany: vi.fn(),
}))
vi.mock('../../db.js', () => {
  const channelDrift = {
    findFirst: async ({ where }: any) => m.rows.find(row => row.channelListingId === where.channelListingId) ?? null,
    create: async ({ data }: any) => { m.rows.push({ id: `drift-${m.rows.length + 1}`, ...data }); return data },
    update: async ({ where, data }: any) => { Object.assign(m.rows.find(row => row.id === where.id)!, data); return data },
    findMany: m.findMany,
  }
  return { default: { channelDrift } }
})

import { recordChannelReadback } from '../channel-drift.service.js'
import { contentDriftByListing, contentDriftFieldLabel, contentDriftView, SHEET_DRIFT_FIELDS_SHOWN } from './content-drift-view.js'
import { ETSY_CONTENT_SOURCE, PHOTO_COUNT_FIELD } from './etsy-content-compare.js'

const AT = new Date('2026-10-06T08:20:00.000Z')
const LATER = new Date('2026-10-06T12:20:00.000Z')
const read = (listingId: string, input: { compared?: string[]; differing?: Array<{ field: string; ours: unknown; theirs: unknown }>; at?: Date; outcome?: 'compared' | 'not_compared'; source?: string }) =>
  recordChannelReadback({ channelListingId: listingId, channel: 'ETSY', marketplace: 'GLOBAL', source: input.source ?? ETSY_CONTENT_SOURCE,
    compared: input.compared ?? (input.differing ?? []).map(d => d.field), differing: input.differing ?? [], checkedAt: input.at ?? AT,
    ...(input.outcome === 'not_compared' ? { outcome: 'not_compared' as const, reason: 'Etsy refused the listing details on this page, so it was read without them.' } : {}) })

beforeEach(() => {
  m.rows = []
  m.findMany.mockReset()
  m.findMany.mockImplementation(async ({ where }: any) => m.rows.filter(row => where.channelListingId.in.includes(row.channelListingId))
    .map(row => ({ channelListingId: row.channelListingId, driftedFields: row.driftedFields, checkedBySource: row.checkedBySource })))
})

describe('contentDriftByListing — the sheet mark\'s one read', () => {
  it('a listing whose last Etsy read differs: the time of that read, the true count, each field with the sheet\'s words', async () => {
    await read('listing-main-1', { compared: ['title', 'description', 'property:513'], differing: [
      { field: 'title', ours: 'Fake title Nexus', theirs: 'Fake title Etsy' },
      { field: 'property:513', ours: { property_id: 513, property_name: 'Fake material', values: ['Wool'] }, theirs: null },
    ] })
    const views = await contentDriftByListing(['listing-main-1'], ETSY_CONTENT_SOURCE)
    expect(views.get('listing-main-1')).toEqual({ source: 'etsy-content', checkedAt: AT.toISOString(), differing: 2, lastRead: 2, fields: [
      { field: 'title', label: 'Title', foundAt: AT.toISOString() }, { field: 'property:513', label: 'Fake material', foundAt: AT.toISOString() },
    ] })
  })

  it('ONE query for every listing of the sheet, selecting only what the view reads; no query for an empty sheet', async () => {
    await read('listing-a', { differing: [{ field: 'title', ours: 'A', theirs: 'B' }] })
    await read('listing-b', { differing: [{ field: 'tags', ours: ['a'], theirs: ['b'] }] })
    const views = await contentDriftByListing(['listing-a', 'listing-b', 'listing-c', 'listing-a'], ETSY_CONTENT_SOURCE)
    expect([...views.keys()].sort()).toEqual(['listing-a', 'listing-b'])
    expect(m.findMany).toHaveBeenCalledTimes(1)
    expect(m.findMany).toHaveBeenCalledWith({ where: { channelListingId: { in: ['listing-a', 'listing-b', 'listing-c'] } },
      select: { channelListingId: true, driftedFields: true, checkedBySource: true } })
    m.findMany.mockClear()
    expect((await contentDriftByListing([], ETSY_CONTENT_SOURCE)).size).toBe(0)
    expect(m.findMany).not.toHaveBeenCalled()
  })

  it('nothing for a listing never read, read clean, or whose last read could not compare (its older differences are not "the last read")', async () => {
    await read('listing-clean', { compared: ['title', 'description'], differing: [] })
    await read('listing-unread-now', { differing: [{ field: 'title', ours: 'A', theirs: 'B' }] })
    await read('listing-unread-now', { outcome: 'not_compared', at: LATER })
    const views = await contentDriftByListing(['listing-clean', 'listing-unread-now', 'listing-never'], ETSY_CONTENT_SOURCE)
    expect(views.size).toBe(0)
    // The stored difference is still there (the writer keeps it), the mark just does not claim it as today's read.
    expect(m.rows.find(row => row.channelListingId === 'listing-unread-now')!.driftedFields).toHaveLength(1)
  })

  it('a field that matches on the next read clears the mark (the writer clears what it compared)', async () => {
    await read('listing-fixed', { differing: [{ field: 'title', ours: 'A', theirs: 'B' }] })
    await read('listing-fixed', { compared: ['title'], differing: [], at: LATER })
    expect((await contentDriftByListing(['listing-fixed'], ETSY_CONTENT_SOURCE)).size).toBe(0)
  })

  it('only the asked source: another source\'s differences on the same listing are neither shown nor counted', async () => {
    await read('listing-mixed', { source: 'ebay-content', differing: [{ field: 'aspect:Marca', ours: 'A', theirs: 'B' }] })
    expect((await contentDriftByListing(['listing-mixed'], ETSY_CONTENT_SOURCE)).size).toBe(0)
    await read('listing-mixed', { differing: [{ field: 'description', ours: 'A', theirs: 'B' }], at: LATER })
    expect((await contentDriftByListing(['listing-mixed'], ETSY_CONTENT_SOURCE)).get('listing-mixed'))
      .toEqual({ source: 'etsy-content', checkedAt: LATER.toISOString(), differing: 1, lastRead: 1, fields: [{ field: 'description', label: 'Description', foundAt: LATER.toISOString() }] })
  })

  it(`names at most ${SHEET_DRIFT_FIELDS_SHOWN} fields; the count stays the true number`, async () => {
    const differing = Array.from({ length: 11 }, (_, i) => ({ field: `property:${200 + i}`, ours: null, theirs: { property_id: 200 + i, property_name: `Fake ${i}`, values: ['x'] } }))
    await read('listing-many', { differing })
    const view = (await contentDriftByListing(['listing-many'], ETSY_CONTENT_SOURCE)).get('listing-many')!
    expect(view.differing).toBe(11)
    expect(view.fields).toHaveLength(SHEET_DRIFT_FIELDS_SHOWN)
    expect(view.fields[0]).toEqual({ field: 'property:200', label: 'Fake 0', foundAt: AT.toISOString() })
  })

  it('(MINOR-10) a difference an earlier read found and the last read did not compare keeps ITS time, and is not counted as the last read\'s', async () => {
    const material = { field: 'property:513', ours: { property_id: 513, property_name: 'Fake material', values: ['Wool'] }, theirs: null }
    await read('listing-kept', { compared: ['title', 'property:513'], differing: [{ field: 'title', ours: 'A', theirs: 'B' }, material] })
    // The next read compares the title again (still different) but not the attributes (not read this sweep).
    await read('listing-kept', { compared: ['title'], differing: [{ field: 'title', ours: 'A', theirs: 'C' }], at: LATER })
    expect((await contentDriftByListing(['listing-kept'], ETSY_CONTENT_SOURCE)).get('listing-kept')).toEqual({ source: 'etsy-content',
      checkedAt: LATER.toISOString(), differing: 2, lastRead: 1, fields: [
        { field: 'title', label: 'Title', foundAt: LATER.toISOString() }, { field: 'property:513', label: 'Fake material', foundAt: AT.toISOString() },
      ] })
    // Then the title matches: only the earlier find is left, and the last read found nothing itself.
    const LAST = new Date('2026-10-06T16:20:00.000Z')
    await read('listing-kept', { compared: ['title'], differing: [], at: LAST })
    expect((await contentDriftByListing(['listing-kept'], ETSY_CONTENT_SOURCE)).get('listing-kept')).toEqual({ source: 'etsy-content',
      checkedAt: LAST.toISOString(), differing: 1, lastRead: 0, fields: [{ field: 'property:513', label: 'Fake material', foundAt: AT.toISOString() }] })
  })
})

describe('contentDriftView — the stored row\'s rules', () => {
  const clock = (over: Record<string, unknown>) => ({ [ETSY_CONTENT_SOURCE]: { at: AT.toISOString(), outcome: 'compared', differing: 1, ...over } })
  const entry = { field: 'title', ours: 'A', theirs: 'B', source: ETSY_CONTENT_SOURCE, checkedAt: AT.toISOString() }
  it('a clock without a valid time, or not "compared", is no view; a clock with no count uses the stored entries', () => {
    expect(contentDriftView({ driftedFields: [entry], checkedBySource: clock({ at: 'yesterday' }) }, ETSY_CONTENT_SOURCE)).toBeNull()
    expect(contentDriftView({ driftedFields: [entry], checkedBySource: clock({ outcome: 'not_compared' }) }, ETSY_CONTENT_SOURCE)).toBeNull()
    expect(contentDriftView({ driftedFields: [entry], checkedBySource: clock({ differing: 0 }) }, ETSY_CONTENT_SOURCE)).toBeNull()
    expect(contentDriftView({ driftedFields: [entry], checkedBySource: clock({ differing: undefined }) }, ETSY_CONTENT_SOURCE)).toMatchObject({ differing: 1 })
    expect(contentDriftView({ driftedFields: 'not a list', checkedBySource: null }, ETSY_CONTENT_SOURCE)).toBeNull()
  })
  it('an entry without a valid stored time is never the last read\'s: no time, listed after the timed ones', () => {
    const untimed = { field: 'description', ours: 'A', theirs: 'B', source: ETSY_CONTENT_SOURCE }
    const earlier = { ...entry, field: 'tags', checkedAt: '2026-10-05T20:20:00.000Z' }
    expect(contentDriftView({ driftedFields: [untimed, earlier, entry], checkedBySource: clock({ differing: 3 }) }, ETSY_CONTENT_SOURCE)).toEqual({
      source: ETSY_CONTENT_SOURCE, checkedAt: AT.toISOString(), differing: 3, lastRead: 1, fields: [
        { field: 'title', label: 'Title', foundAt: AT.toISOString() },
        { field: 'tags', label: 'Tags', foundAt: '2026-10-05T20:20:00.000Z' },
        { field: 'description', label: 'Description', foundAt: null },
      ] })
  })
  it('the words for each kind of field', () => {
    expect(contentDriftFieldLabel('taxonomy_id')).toBe('Category')
    expect(contentDriftFieldLabel('classification')).toBe('Who made, when made, craft supply')
    expect(contentDriftFieldLabel('inventory')).toBe('Variations, SKUs and processing profile')
    expect(contentDriftFieldLabel('translation:de')).toBe('Translation (de)')
    expect(contentDriftFieldLabel(PHOTO_COUNT_FIELD)).toBe('Photo count')
    expect(contentDriftFieldLabel('property:200', { ours: { property_name: '  ' }, theirs: { property_name: 'Fake colour' } })).toBe('Fake colour')
    expect(contentDriftFieldLabel('property:200', { ours: null, theirs: null })).toBe('Attribute 200')
  })
})
