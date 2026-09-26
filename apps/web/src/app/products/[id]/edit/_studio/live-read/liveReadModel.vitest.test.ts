/**
 * Read live (Owner, 2026-09-26: "the ability to read whatever is currently live on the channel") — the comparison the drawer shows.
 * Pure: a live read (the shared shape, @nexus/shared/live-read) beside what the Information sheet holds for the same destination.
 */
import { describe, expect, it } from 'vitest'
import type { LiveRead } from '@nexus/shared/live-read'
import { contentRows, formatLiveValue, variationRows, type NexusVariant } from './liveReadModel'

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
      'item_name@IT/it': { state: 'unread', reason: 'throttled' },
      pictures: { state: 'absent' },
    } }), { title: 'Giacca Racing', description: '<p>Vecchia</p>' })
    expect(rows).toEqual([
      { field: 'aspect:Marca', label: 'Marca', live: 'Xavia', nexus: null, state: 'not-compared' },
      { field: 'description', label: 'Description', live: '<p>Nuova</p>', nexus: '<p>Vecchia</p>', state: 'differs' },
      { field: 'item_name@IT/it', label: 'item_name (IT, it)', live: 'Could not read: throttled', nexus: null, state: 'unread' },
      { field: 'pictures', label: 'Pictures', live: 'Not on the channel', nexus: null, state: 'absent' },
      { field: 'title', label: 'Title', live: 'Giacca Racing', nexus: 'Giacca Racing', state: 'same' },
    ])
  })
})
