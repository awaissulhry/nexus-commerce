import { beforeEach, describe, expect, it } from 'vitest'
import {
  fulfillmentBucket, groupIdForSku, assignSkusToGroup, removeSkusFromGroups, makeGroupId,
  loadGroups, saveGroups, loadGroupMode, saveGroupMode, loadCollapsedGroups, saveCollapsedGroups,
  type FlatFileGroup,
} from './group-model'

// in-memory localStorage stub
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
})

const g = (id: string, memberSkus: string[], order = 0): FlatFileGroup =>
  ({ id, name: id, color: 'blue', order, memberSkus })

describe('fulfillmentBucket', () => {
  it('FBA when channel code starts AMAZON/AFN/FBA', () => {
    expect(fulfillmentBucket({ fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU' })).toBe('FBA')
    expect(fulfillmentBucket({ fulfillment_availability__fulfillment_channel_code: 'AFN' })).toBe('FBA')
    expect(fulfillmentBucket({ fulfillment_availability__fulfillment_channel_code: 'FBA' })).toBe('FBA')
  })
  it('FBM for merchant/empty channel', () => {
    expect(fulfillmentBucket({ fulfillment_availability__fulfillment_channel_code: 'DEFAULT' })).toBe('FBM')
    expect(fulfillmentBucket({ fulfillment_availability__fulfillment_channel_code: '' })).toBe('FBM')
    expect(fulfillmentBucket({})).toBe('FBM')
  })
  it('_FBM SKU always FBM, even with an AMAZON channel code', () => {
    expect(fulfillmentBucket({ item_sku: 'GALE_JACKET_BLACK_M_FBM', fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU' })).toBe('FBM')
    expect(fulfillmentBucket({ item_sku: 'x-fbm' })).toBe('FBM')
  })
})

describe('groupIdForSku', () => {
  const groups = [g('g1', ['A', 'B']), g('g2', ['C'])]
  it('finds the owning group', () => {
    expect(groupIdForSku(groups, 'B')).toBe('g1')
    expect(groupIdForSku(groups, 'C')).toBe('g2')
  })
  it('null when ungrouped', () => {
    expect(groupIdForSku(groups, 'Z')).toBeNull()
  })
})

describe('assignSkusToGroup', () => {
  it('adds skus and removes them from other groups (≤1 group per sku)', () => {
    const groups = [g('g1', ['A', 'B']), g('g2', ['C'])]
    const out = assignSkusToGroup(groups, 'g2', ['B', 'D'])
    expect(out.find((x) => x.id === 'g1')!.memberSkus).toEqual(['A'])
    expect(out.find((x) => x.id === 'g2')!.memberSkus).toEqual(['C', 'B', 'D'])
  })
  it('dedups within the target group', () => {
    const out = assignSkusToGroup([g('g1', ['A'])], 'g1', ['A', 'A', 'B'])
    expect(out[0].memberSkus).toEqual(['A', 'B'])
  })
  it('returns a new array (immutable)', () => {
    const groups = [g('g1', ['A'])]
    const out = assignSkusToGroup(groups, 'g1', ['B'])
    expect(out).not.toBe(groups)
    expect(groups[0].memberSkus).toEqual(['A'])
  })
})

describe('removeSkusFromGroups', () => {
  it('drops skus from every group', () => {
    const out = removeSkusFromGroups([g('g1', ['A', 'B']), g('g2', ['B', 'C'])], ['B'])
    expect(out[0].memberSkus).toEqual(['A'])
    expect(out[1].memberSkus).toEqual(['C'])
  })
})

describe('makeGroupId', () => {
  it('is deterministic: max numeric suffix + 1', () => {
    expect(makeGroupId([])).toBe('g1')
    expect(makeGroupId([g('g1', []), g('g3', [])])).toBe('g4')
    expect(makeGroupId([g('weird', []), g('g2', [])])).toBe('g3')
  })
})

describe('persistence round-trips + safe defaults', () => {
  it('groups round-trip and normalise', () => {
    const groups = [g('g1', ['A'], 0), g('g2', ['B'], 1)]
    saveGroups('IT', groups)
    expect(loadGroups('IT')).toEqual(groups)
  })
  it('groups default to [] when absent or malformed', () => {
    expect(loadGroups('DE')).toEqual([])
    localStorage.setItem('ff-amazon-DE-groups', 'not json')
    expect(loadGroups('DE')).toEqual([])
    localStorage.setItem('ff-amazon-DE-groups', '{"not":"array"}')
    expect(loadGroups('DE')).toEqual([])
  })
  it('drops malformed entries + repairs bad colour', () => {
    localStorage.setItem('ff-amazon-IT-groups', JSON.stringify([
      { id: 'g1', name: 'ok', color: 'nope', order: 0, memberSkus: ['A'] },
      { id: 'g2' /* missing fields */ },
      { id: 'g3', name: 'x', color: 'teal', order: 2, memberSkus: ['B'] },
    ]))
    const out = loadGroups('IT')
    expect(out.map((x) => x.id)).toEqual(['g1', 'g3'])
    expect(out[0].color).toBe('blue') // repaired to palette[0]
    expect(out[1].color).toBe('teal')
  })
  it('mode round-trips + defaults to family', () => {
    expect(loadGroupMode('IT')).toBe('family')
    saveGroupMode('IT', 'custom'); expect(loadGroupMode('IT')).toBe('custom')
    saveGroupMode('IT', 'fulfillment'); expect(loadGroupMode('IT')).toBe('fulfillment')
    localStorage.setItem('ff-amazon-IT-group-mode', '"garbage"')
    expect(loadGroupMode('IT')).toBe('family')
  })
  it('collapsed groups round-trip as a Set', () => {
    saveCollapsedGroups('IT', new Set(['g1', 'g2']))
    expect(loadCollapsedGroups('IT')).toEqual(new Set(['g1', 'g2']))
    expect(loadCollapsedGroups('FR')).toEqual(new Set())
  })
  it('per-market isolation', () => {
    saveGroups('IT', [g('g1', ['A'])])
    saveGroups('DE', [g('g1', ['Z'])])
    expect(loadGroups('IT')[0].memberSkus).toEqual(['A'])
    expect(loadGroups('DE')[0].memberSkus).toEqual(['Z'])
  })
})
