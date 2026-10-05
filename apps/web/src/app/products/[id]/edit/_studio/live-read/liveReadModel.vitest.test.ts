/**
 * Read live (Owner, 2026-09-26: "the ability to read whatever is currently live on the channel") — the comparison the drawer shows.
 * Pure: a live read (the shared shape, @nexus/shared/live-read) beside what the Information sheet holds for the same destination.
 */
import { describe, expect, it } from 'vitest'
import type { LiveRead } from '@nexus/shared/live-read'
import { comparisonSummary, contentRows, errorGroups, formatLiveValue, variationRows, type NexusVariant } from './liveReadModel'

const read = (over: Partial<LiveRead> = {}): LiveRead => ({
  readAt: '2026-09-26T21:05:00.000Z', source: 'ebay-trading-item', revision: 'r1',
  destination: { productId: 'p', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: '' },
  content: {}, variations: null, errors: [], ...over,
})

describe('formatLiveValue', () => {
  it('says what it is: a value, nothing on the channel, or could not read — never a blank that looks like "no change"', () => {
    expect(formatLiveValue({ state: 'value', value: 'Giacca' })).toBe('Giacca')
    expect(formatLiveValue({ state: 'value', value: ['A', 'B'] })).toBe('A, B')
    expect(formatLiveValue({ state: 'value', value: { amount: '99.00', currency: 'EUR' } })).toBe('99.00 EUR')
    expect(formatLiveValue({ state: 'absent' })).toBe('Not on the channel')
    expect(formatLiveValue({ state: 'unread', reason: 'timeout' })).toBe('Could not read: timeout')
  })
})

describe('variationRows', () => {
  const links = [{ channelName: 'Colore', familyKey: 'Colore', axisKey: 'color' }, { channelName: 'Taglia', familyKey: 'Taglia', axisKey: 'size' }]
  const live = read({ variations: { axes: ['Colore', 'Taglia'], order: {}, variants: [
    { sku: 'A', values: { Colore: 'Nero', Taglia: 'M' }, price: { state: 'value', value: { amount: '99.00', currency: 'EUR' } }, stock: { state: 'value', value: 4 }, state: 'live' },
    { sku: 'B', values: { Colore: 'Arancia', Taglia: 'L' }, price: { state: 'absent' }, stock: { state: 'unread', reason: 'no offer' }, state: 'live' },
    { sku: 'C', values: {}, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'missing' },
    { sku: 'X', values: { Colore: 'Blu', Taglia: 'S' }, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'extra' },
  ] } })
  const nexus: NexusVariant[] = [{ sku: 'A', values: { Color: 'Nero', Size: 'M' } }, { sku: 'B', values: { Colore: 'Arancione', Taglia: 'L' } }, { sku: 'C', values: { Colore: 'Rosso', Taglia: 'XL' } }]

  it('puts the live value beside the value the sheet shows, matching the channel axis to the family axis', () => {
    const rows = variationRows(live, links, nexus)
    expect(rows.find(r => r.sku === 'A')).toMatchObject({ state: 'live', differs: false, price: '99.00 EUR', stock: '4',
      cells: [{ axis: 'Colore', live: 'Nero', nexus: 'Nero', differs: false }, { axis: 'Taglia', live: 'M', nexus: 'M', differs: false }] })
  })

  it('marks a value the channel shows differently', () => {
    const b = variationRows(live, links, nexus).find(r => r.sku === 'B')!
    expect(b.differs).toBe(true)
    expect(b.cells[0]).toEqual({ axis: 'Colore', live: 'Arancia', nexus: 'Arancione', differs: true })
    expect(b.stock).toBe('Could not read: no offer')
  })

  it('a variant only in Nexus, and one only on the channel, are named — not hidden', () => {
    const rows = variationRows(live, links, nexus)
    expect(rows.find(r => r.sku === 'C')).toMatchObject({ state: 'missing', cells: [{ live: null, nexus: 'Rosso' }, { live: null, nexus: 'XL' }] })
    expect(rows.find(r => r.sku === 'X')).toMatchObject({ state: 'extra', cells: [{ live: 'Blu', nexus: null }, { live: 'S', nexus: null }] })
  })

  it('a listing without variations has no rows', () => {
    expect(variationRows(read(), links, nexus)).toEqual([])
  })
})

describe('contentRows', () => {
  it('compares a field the sheet holds under the same key; a field the sheet does not hold is shown, marked "not compared"', () => {
    const rows = contentRows(read({ content: {
      title: { state: 'value', value: 'Giacca Racing' },
      description: { state: 'value', value: '<p>Nuova</p>' },
      'aspect:Marca': { state: 'value', value: ['Xavia'] },
      'item_name:["MKT-IT","it_IT"]': { state: 'unread', reason: 'throttled' },
      pictures: { state: 'absent' },
    } }), { title: 'Giacca Racing', description: '<p>Vecchia</p>' })
    expect(rows).toEqual([
      { field: 'aspect:Marca', label: 'Marca', live: 'Xavia', nexus: null, state: 'not-compared' },
      { field: 'description', label: 'Description', live: '<p>Nuova</p>', nexus: '<p>Vecchia</p>', state: 'differs' },
      { field: 'item_name:["MKT-IT","it_IT"]', label: 'item_name (it_IT)', live: 'Could not read: throttled', nexus: null, state: 'unread' },
      { field: 'pictures', label: 'Pictures', live: 'Not on the channel', nexus: null, state: 'absent' },
      { field: 'title', label: 'Title', live: 'Giacca Racing', nexus: 'Giacca Racing', state: 'same' },
    ])
  })
})

describe('comparisonSummary', () => {
  it('says "nothing could be compared" when nothing was — never "no differences" over an empty comparison', () => {
    // The drawer's first local run (eBay DE, a draft listing): no content, no variations, one error.
    expect(comparisonSummary([], [])).toBe('Nothing could be compared with Nexus.')
    const onlyUncompared = contentRows(read({ content: { gtin: { state: 'value', value: '1' }, brand: { state: 'unread', reason: 'x' } } }), {})
    expect(comparisonSummary([], onlyUncompared)).toBe('Nothing could be compared with Nexus.')
  })
  it('counts what was compared, and what differs', () => {
    const content = contentRows(read({ content: { title: { state: 'value', value: 'Giacca' }, brand: { state: 'value', value: 'Xavia' } } }), { title: 'Giacca', brand: 'XAVIA' })
    expect(comparisonSummary([], content)).toBe('1 difference from Nexus, in 2 parts compared.')
    expect(comparisonSummary([], content.slice(1))).toBe('No differences from Nexus, in 1 part compared.')
  })
})

describe('contentRows — the sheet\'s own keys', () => {
  it('finds the title, the pictures and each item specific where the sheet keeps them (name, imageUrls, the aspect key)', () => {
    // Seen on the first local run: the eBay sheet holds the title under `name`, so "Title" read "—" beside the live value.
    const live = read({ content: {
      title: { state: 'value', value: 'Giacca Gale' },
      pictures: { state: 'value', value: ['https://a/1.jpg'] },
      'aspect:paese di origine': { state: 'value', value: ['Italia'] },
    } })
    const rows = contentRows(live, { name: 'Giacca Gale', imageUrls: ['https://a/1.jpg', 'https://a/2.jpg'], paese_di_origine: 'Italia' })
    expect(rows.map(r => [r.field, r.nexus, r.state])).toEqual([
      ['aspect:paese di origine', 'Italia', 'same'],
      ['pictures', '2 pictures', 'differs'],
      ['title', 'Giacca Gale', 'same'],
    ])
    // A list of picture links is shown as a count (the drawer has no room for URLs); same / differs still compares every link.
    expect(rows.find(r => r.field === 'pictures')?.live).toBe('1 picture')
  })
})

describe('errorGroups', () => {
  it('one line per reason: twenty variants that failed the same way read as one line, not twenty', () => {
    const errors = [
      { scope: 'item' as const, reason: 'The eBay group could not be read (no answer).' },
      ...['A', 'B', 'C'].map(sku => ({ scope: 'sku' as const, sku, reason: 'The eBay item could not be read (no answer).' })),
      { scope: 'field' as const, field: 'price', reason: 'Key missing' },
    ]
    expect(errorGroups(errors)).toEqual([
      { label: 'Listing', reason: 'The eBay group could not be read (no answer).', names: [] },
      { label: '3 variants', reason: 'The eBay item could not be read (no answer).', names: ['A', 'B', 'C'] },
      { label: 'price', reason: 'Key missing', names: [] },
    ])
  })
})

describe('contentRows — Amazon fields', () => {
  it('matches an Amazon field id (root:["<marketplaceId>","<language>"], as the publish review writes it) to the sheet\'s root key', () => {
    const rows = contentRows(read({ content: {
      'item_name:["MKT-IT","it_IT"]': { state: 'value', value: ['Giacca Gale'] },
      'bullet_point:["MKT-IT","it_IT"]': { state: 'value', value: ['A', 'B'] },
      brand: { state: 'value', value: [{ value: 'Xavia' }] },
    } }), { item_name: 'Giacca Gale', bullet_point: ['A', 'C'] })
    expect(rows.map(r => [r.label, r.nexus, r.state])).toEqual([
      ['Brand', null, 'not-compared'],
      ['bullet_point (it_IT)', 'A, C', 'differs'],
      ['item_name (it_IT)', 'Giacca Gale', 'same'],
    ])
  })
})

describe('contentRows — Etsy (E5): the review\'s own comparison', () => {
  const etsy = (content: LiveRead['content']) => read({ source: 'etsy-listing', revision: 'r-etsy',
    destination: { productId: 'p', channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'acc', aliasKey: '' }, content })

  it('Etsy\'s Tags, Materials and Styles are compared with the sheet\'s Search keywords, Material and Style, as sets (order and case ignored)', () => {
    const rows = contentRows(etsy({
      tags: { state: 'value', value: ['Giacca', 'moto', 'Pelle'] },
      materials: { state: 'value', value: ['Wool', 'cotton'] },
      styles: { state: 'value', value: ['Boho'] },
    }), { keywords: ['pelle', 'GIACCA', 'Moto'], material: ['Cotton', 'wool'], style: ['Minimal'] })
    expect(rows.map(r => [r.field, r.nexus, r.state])).toEqual([
      ['materials', 'Cotton, wool', 'same'],
      ['styles', 'Minimal', 'differs'],
      ['tags', 'pelle, GIACCA, Moto', 'same'],
    ])
    // The live list is shown as Etsy holds it; only the comparison folds it.
    expect(rows.find(r => r.field === 'tags')?.live).toBe('Giacca, moto, Pelle')
  })

  it('a tag the sheet lacks differs; a description that differs only by Windows line ends or trailing space is the same', () => {
    const rows = contentRows(etsy({
      tags: { state: 'value', value: ['giacca', 'moto'] },
      description: { state: 'value', value: 'Riga uno\r\nRiga due\r\n  ' },
    }), { keywords: ['giacca'], description: 'Riga uno\nRiga due' })
    expect(rows.map(r => [r.field, r.state])).toEqual([['description', 'same'], ['tags', 'differs']])
  })

  it('Item weight and Item size (value + unit objects) are not compared: the sheet holds the number and the unit apart', () => {
    const rows = contentRows(etsy({
      item_weight: { state: 'value', value: { value: 1.2, unit: 'kg' } },
      item_dimensions: { state: 'value', value: { length: 30, width: 20, height: 5, unit: 'cm' } },
    }), { item_weight: 1.2, item_dimensions: '30 × 20 × 5 cm' })
    expect(rows.map(r => [r.field, r.state])).toEqual([['item_dimensions', 'not-compared'], ['item_weight', 'not-compared']])
  })

  it('the title still reads the sheet\'s name; attributes, translations and the variations stay "not compared"', () => {
    const rows = contentRows(etsy({
      title: { state: 'value', value: 'Fake jacket' },
      'property:513': { state: 'value', value: { property_id: 513, property_name: 'Fake material', values: ['Wool'] } },
      'translation:de': { state: 'value', value: { language: 'de', title: 'Fake Jacke', description: null, tags: [] } },
      inventory: { state: 'value', value: { products: [] } },
    }), { name: 'Fake jacket', keywords: ['x'] })
    expect(rows.map(r => [r.field, r.state])).toEqual([['inventory', 'not-compared'], ['property:513', 'not-compared'], ['title', 'same'], ['translation:de', 'not-compared']])
  })

  it('other channels keep their rules: an eBay read never maps Tags to Search keywords, and compares lists in order', () => {
    const rows = contentRows(read({ content: {
      tags: { state: 'value', value: ['a', 'b'] },
      materials: { state: 'value', value: ['B', 'a'] },
      description: { state: 'value', value: 'x\r\ny' },
    } }), { keywords: ['a', 'b'], materials: ['a', 'B'], description: 'x\ny' })
    expect(rows.map(r => [r.field, r.state])).toEqual([['description', 'differs'], ['materials', 'differs'], ['tags', 'not-compared']])
  })
})
