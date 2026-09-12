/**
 * PES.7 — event readings. Fixtures are the three shapes measured across all 157 events on
 * GALE-JACKET, including the fact that only one of them carries a per-field delta.
 */
import { describe, expect, it } from 'vitest'

import {
  groupEvents, readEvent, readValue, summariseActivity, type ProductEvent,
} from './readEvents'

const event = (over: Partial<ProductEvent> = {}): ProductEvent => ({
  id: 'e1', aggregateId: 'p1', aggregateType: 'Product',
  eventType: 'IMAGES_UPDATED',
  data: { source: 'upload-cloudinary', imageId: 'i1', wasType: 'ALT' },
  metadata: null,
  createdAt: '2026-09-01T15:46:05.494Z',
  ...over,
})

const flatFile = (over: Partial<ProductEvent> = {}) => event({
  eventType: 'FLAT_FILE_IMPORTED',
  data: { region: 'IT', channel: 'EBAY', marketplace: 'IT', channelListingId: 'c1' },
  metadata: { source: 'FLAT_FILE_IMPORT', flatFileType: 'EBAY_FLAT_FILE' },
  ...over,
})

const bulk = (fields: Array<{ field: string; value: unknown }>, over: Partial<ProductEvent> = {}) => event({
  eventType: 'BULK_OP_APPLIED',
  data: { fields, bulkOperationId: 'b1' },
  metadata: { ip: '::1', source: 'OPERATOR', bulkOperationId: 'b1' },
  ...over,
})

describe('readEvent — no raw enum reaches the screen', () => {
  it('never renders the eventType verbatim', () => {
    for (const e of [event(), flatFile(), bulk([{ field: 'x', value: 1 }]), event({ eventType: 'SOMETHING_NEW' })]) {
      expect(readEvent(e).title).not.toBe(e.eventType)
      expect(readEvent(e).title).not.toMatch(/_/)
    }
  })

  it('humanises an unknown type rather than hiding it', () => {
    expect(readEvent(event({ eventType: 'PRICE_CHANGED' })).title).toBe('Price changed')
  })
})

describe('readEvent — images', () => {
  it.each([
    ['upload-cloudinary', 'Image uploaded'],
    ['upload-video', 'Video uploaded'],
    ['delete', 'Image removed'],
    ['reorder', 'Images reordered'],
    ['import-from-dam', 'Image imported from the asset library'],
    ['derive', 'Image derived from another'],
    ['patch-metadata', 'Image details edited'],
  ])('%s reads as "%s"', (source, title) => {
    expect(readEvent(event({ data: { source } })).title).toBe(title)
  })

  it('reports an unrecognised source as itself, never as an upload', () => {
    const r = readEvent(event({ data: { source: 'teleported' } }))
    expect(r.title).toBe('Image changed (teleported)')
    expect(r.title).not.toMatch(/uploaded/)
  })

  it('carries the slot when the event names one', () => {
    expect(readEvent(event()).detail).toBe('ALT slot')
    expect(readEvent(event({ data: { source: 'delete' } })).detail).toBeNull()
  })
})

describe('readEvent — flat file', () => {
  it('offers no delta, because the event carries none', () => {
    // 🔴 The point: an expander here would open empty and imply the detail was lost.
    expect(readEvent(flatFile()).fields).toBeNull()
  })

  it('shows everything it does know', () => {
    expect(readEvent(flatFile()).detail).toBe('EBAY · IT · EBAY_FLAT_FILE')
  })

  it('falls back to region when there is no marketplace', () => {
    // The fixture keeps its metadata, so the file type is legitimately still part of the line.
    const r = readEvent(flatFile({ data: { region: 'DE', channel: 'AMAZON' } }))
    expect(r.detail).toBe('AMAZON · DE · EBAY_FLAT_FILE')
  })

  it('has no detail rather than an empty string when it knows nothing', () => {
    expect(readEvent(flatFile({ data: {}, metadata: {} })).detail).toBeNull()
  })
})

describe('readEvent — bulk edits are the only ones with a delta', () => {
  it('names the single field it changed', () => {
    const r = readEvent(bulk([{ field: 'manufacturer', value: null }]))
    expect(r.title).toBe('Bulk edit · manufacturer')
    expect(r.fields).toEqual([{ field: 'manufacturer', value: null }])
  })

  it('counts multiple fields', () => {
    expect(readEvent(bulk([{ field: 'a', value: 1 }, { field: 'b', value: 2 }])).title)
      .toBe('Bulk edit · 2 fields')
  })

  it('names the operator when the record says so', () => {
    expect(readEvent(bulk([{ field: 'a', value: 1 }])).actor).toBe('An operator')
  })

  it('drops malformed field entries rather than rendering them', () => {
    const r = readEvent(bulk([{ field: 'ok', value: 1 }, 'nope' as never, { value: 2 } as never]))
    expect(r.fields).toEqual([{ field: 'ok', value: 1 }])
  })

  it('has no fields rather than an empty list when none survive', () => {
    expect(readEvent(bulk([])).fields).toBeNull()
  })
})

describe('readValue — a cleared field is not the string "null"', () => {
  it.each([
    [null, 'cleared'],
    [undefined, 'cleared'],
    ['', 'empty'],
    ['PES2 GUARD PROBE', 'PES2 GUARD PROBE'],
    [0, '0'],
    [false, 'false'],
  ])('%s → %s', (input, expected) => {
    expect(readValue(input)).toBe(expected)
  })
})

describe('groupEvents', () => {
  const at = (iso: string) => ({ createdAt: iso })

  it('collapses a burst of the same type and says it is a group', () => {
    const g = groupEvents([
      flatFile({ id: '1', ...at('2026-07-19T23:34:10Z') }),
      flatFile({ id: '2', ...at('2026-07-19T23:34:40Z') }),
    ])
    expect(g).toHaveLength(1)
    expect(g[0].grouped).toBe(true)
    expect(g[0].events).toHaveLength(2)
  })

  it('does not merge across the window', () => {
    const g = groupEvents([
      flatFile({ id: '1', ...at('2026-07-19T23:34:10Z') }),
      flatFile({ id: '2', ...at('2026-07-19T23:40:10Z') }),
    ])
    expect(g).toHaveLength(2)
  })

  it('does not merge different types', () => {
    const g = groupEvents([
      flatFile({ id: '1', ...at('2026-07-19T23:34:10Z') }),
      event({ id: '2', ...at('2026-07-19T23:34:20Z') }),
    ])
    expect(g).toHaveLength(2)
  })

  it('🔴 never merges away a bulk edit — its fields are the point of the row', () => {
    const g = groupEvents([
      bulk([{ field: 'a', value: 1 }], { id: '1', ...at('2026-07-19T23:34:10Z') }),
      bulk([{ field: 'b', value: 2 }], { id: '2', ...at('2026-07-19T23:34:20Z') }),
    ])
    expect(g).toHaveLength(2)
    expect(g.every((x) => !x.grouped)).toBe(true)
  })

  it('an empty log groups to nothing rather than throwing', () => {
    expect(groupEvents([])).toEqual([])
  })
})

describe('summariseActivity', () => {
  it('counts by kind and spans the log', () => {
    const s = summariseActivity([
      event({ id: '1', createdAt: '2026-05-23T00:00:00Z' }),
      flatFile({ id: '2', createdAt: '2026-07-19T00:00:00Z' }),
      bulk([{ field: 'a', value: 1 }], { id: '3', createdAt: '2026-09-01T00:00:00Z' }),
    ])
    expect(s.total).toBe(3)
    expect(s.byKind).toMatchObject({ images: 1, import: 1, bulk: 1 })
    expect(s.firstAt).toBe('2026-05-23T00:00:00Z')
    expect(s.lastAt).toBe('2026-09-01T00:00:00Z')
  })

  it('an empty log has no span rather than a fake one', () => {
    const s = summariseActivity([])
    expect(s).toMatchObject({ total: 0, firstAt: null, lastAt: null })
  })
})
