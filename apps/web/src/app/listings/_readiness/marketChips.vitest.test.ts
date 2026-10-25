import { describe, expect, it } from 'vitest'
import type { ReadinessChip, ReadinessDestination } from '@nexus/shared/listing-readiness'
import {
  chipAriaLabel,
  chipLines,
  destinationLines,
  chipText,
  destinationFromKey,
  destinationLookup,
  nextStepPlace,
  orderedChips,
  worstChip,
} from './marketChips'

const counts = (over: Partial<ReadinessChip['counts']> = {}) => ({ blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 0, ...over })
const chip = (destinationKey: string, over: Partial<ReadinessChip> = {}): ReadinessChip => ({
  destinationKey, state: 'ready', counts: counts({ ready: 1 }), issueCount: 0, pending: false, computedAt: null, ...over,
})
const key = (...parts: Array<string | null>) => JSON.stringify(parts)
const dest = (k: string, label: string): ReadinessDestination => ({ key: k, channel: '', marketplace: '', accountId: null, aliasKey: '', label })

describe('chip text', () => {
  it('a ready chip names its destination only', () => {
    expect(chipText(chip('k'), 'Amazon DE')).toBe('Amazon DE')
  })
  it('a chip that is not ready adds its problem count', () => {
    expect(chipText(chip('k', { state: 'blocked', issueCount: 3 }), 'Amazon DE')).toBe('Amazon DE · 3')
    expect(chipText(chip('k', { state: 'absent', issueCount: 0 }), 'eBay IT')).toBe('eBay IT')
  })
})

describe('chip aria text — a full sentence', () => {
  it('state, problems, listings', () => {
    expect(chipAriaLabel(chip('k', { state: 'blocked', issueCount: 3, counts: counts({ blocked: 12, warn: 8 }) }), 'Amazon DE')).toBe('Amazon DE: Blocked, 3 problems, 20 products')
  })
  it('one of each is singular; no problems says none', () => {
    expect(chipAriaLabel(chip('k', { state: 'warn', issueCount: 1, counts: counts({ warn: 1 }) }), 'Shopify')).toBe('Shopify: Warnings, 1 problem, 1 product')
    expect(chipAriaLabel(chip('k'), 'Shared')).toBe('Shared: Ready, 1 product')
  })
  it('a pending chip says it is checking and that this is the last result', () => {
    expect(chipAriaLabel(chip('k', { state: 'blocked', issueCount: 2, pending: true, counts: counts({ blocked: 1 }) }), 'Amazon IT'))
      .toBe('Amazon IT: Blocked, 2 problems, 1 product. Checking again now; this is the last result.')
  })
})

describe('chip aria text — the channel’s part (the live layer)', () => {
  const live = {
    state: 'mixed' as const, listed: 18, notListed: 2, byState: { active: 18 }, externalId: null, url: null, priceMin: null, priceMax: null,
    currency: null, quantity: null, fulfillment: null, channelErrorCount: 0, suppressedCount: 1, outOfSyncCount: 0, syncFailedCount: 0,
    lastSyncedAt: null, duplicates: 0,
  }
  const blocked = chip('k', { state: 'blocked', issueCount: 3, counts: counts({ blocked: 12, warn: 8 }), live })
  it('follows the readiness sentence, in the channel’s words', () => {
    expect(chipAriaLabel(blocked, 'Amazon DE', 'AMAZON')).toBe('Amazon DE: Blocked, 3 problems, 20 products. On Amazon: Mixed, 18 Active, 2 Not listed. 1 Suppressed.')
  })
  it('a pending chip says it is checking after both', () => {
    expect(chipAriaLabel({ ...blocked, pending: true }, 'Amazon DE', 'AMAZON'))
      .toBe('Amazon DE: Blocked, 3 problems, 20 products. On Amazon: Mixed, 18 Active, 2 Not listed. 1 Suppressed. Checking again now; this is the last result.')
  })
  it('no live data (Shared, no permission, an older API): the sentence as before', () => {
    expect(chipAriaLabel(chip('k', { live: null }), 'Shared', 'SHARED')).toBe('Shared: Ready, 1 product')
    expect(chipAriaLabel(chip('k'), 'eBay IT', 'EBAY')).toBe('eBay IT: Ready, 1 product')
  })
})

describe('destinations', () => {
  it('chips follow the destinations order; unknown ones go last in their own order', () => {
    const a = key('SHARED', null, null, null), b = key('AMAZON', 'IT', 'acc', null), c = key('AMAZON', 'DE', 'acc', null), x = key('ETSY', 'GLOBAL', 'e', null)
    const ordered = orderedChips([chip(x), chip(c), chip(a), chip(b)], [dest(a, 'Shared'), dest(b, 'Amazon IT'), dest(c, 'Amazon DE')])
    expect(ordered.map((ch) => ch.destinationKey)).toEqual([a, b, c, x])
  })
  it('a key the page has no record of still reads as words', () => {
    expect(destinationFromKey(key('AMAZON', 'DE', 'acc1', null)).label).toBe('Amazon DE')
    expect(destinationFromKey(key('EBAY', 'IT', 'acc2', 'al1')).label).toBe('eBay IT')
    expect(destinationFromKey(key(null, null, null, null)).label).toBe('Shared')
    expect(destinationFromKey(key('SHOPIFY', 'GLOBAL', 's', null)).label).toBe('Shopify')
    expect(destinationFromKey('not json').label).toBe('not json')
  })
  it('the lookup prefers the API’s own label', () => {
    const k = key('AMAZON', 'DE', 'acc1', null)
    expect(destinationLookup([dest(k, 'Amazon DE · Xavia')])(k).label).toBe('Amazon DE · Xavia')
    expect(destinationLookup([])(k).label).toBe('Amazon DE')
  })
})

describe('the Next step', () => {
  const step = { destinationKey: 'next', field: 'sizeChart', label: 'Size chart', message: 'Add a size chart', kind: 'required' as const, affected: 20, productId: 'p', locale: 'de', href: '/x' }
  it('the chip that needs attention first (Blocked → Warnings → Not computed → Not set up → Ready)', () => {
    expect(worstChip([chip('r'), chip('n', { state: 'absent' }), chip('c', { state: 'notComputed' })])?.destinationKey).toBe('c')
    expect(worstChip([])).toBeNull()
  })
  it('the next step says where and how many', () => {
    expect(nextStepPlace(step, 'Amazon DE')).toBe('Amazon DE · 20 products')
    expect(nextStepPlace({ affected: 1 }, 'eBay IT')).toBe('eBay IT · 1 product')
  })
})

describe('chip lines', () => {
  const d = (k: string, channel: string, marketplace: string, label: string, accountId: string | null = null): ReadinessDestination =>
    ({ key: k, channel, marketplace, accountId, aliasKey: '', label })
  const all = [
    d('s', 'SHARED', '', 'Shared'),
    d('a-it', 'AMAZON', 'IT', 'Amazon IT', 'amz'),
    d('a-de', 'AMAZON', 'DE', 'Amazon DE', 'amz'),
    d('e-it-1', 'EBAY', 'IT', 'eBay IT · motovento', 'e1'),
    d('e-it-2', 'EBAY', 'IT', 'eBay IT · xaviaracing', 'e2'),
    d('shop', 'SHOPIFY', '', 'Shopify', 'sh'),
  ]
  const lookup = destinationLookup(all)
  it('puts a store\'s markets on one line under its short name, and the market-less destinations first', () => {
    const lines = chipLines(all.map((x) => chip(x.key, x.key === 'a-de' ? { state: 'blocked', issueCount: 72 } : {})), lookup)
    expect(lines.map((l) => [l.label, l.items.map((c) => c.text)])).toEqual([
      [null, ['Shared', 'Shopify']],
      ['Amazon', ['IT', 'DE · 72']],
      ['eBay · motovento', ['IT']],
      ['eBay · xaviaracing', ['IT']],
    ])
  })
  it('keeps the full destination words for the sentence a screen reader hears', () => {
    const [, amazon] = chipLines([chip('s'), chip('a-de', { state: 'blocked', issueCount: 2 })], lookup)
    expect(amazon.items[0].label).toBe('Amazon DE')
    expect(chipAriaLabel(amazon.items[0].chip, amazon.items[0].label)).toBe('Amazon DE: Blocked, 2 problems, 1 product')
  })
  it('has no first line when every destination has a market', () => {
    expect(chipLines([chip('a-it')], lookup).map((l) => l.label)).toEqual(['Amazon'])
  })
})

describe('the Fix window’s market switcher', () => {
  it('uses the same lines as the grid’s chips', () => {
    const d = (key: string, channel: string, marketplace: string, label: string): ReadinessDestination => ({ key, channel, marketplace, accountId: null, aliasKey: '', label })
    const lines = destinationLines([d('s', 'SHARED', '', 'Shared'), d('a', 'AMAZON', 'DE', 'Amazon DE'), d('b', 'AMAZON', 'IT', 'Amazon IT'), d('e', 'ETSY', '', 'Etsy')])
    expect(lines.map((l) => [l.label, l.items.map((i) => i.text)])).toEqual([[null, ['Shared', 'Etsy']], ['Amazon', ['DE', 'IT']]])
  })
})
