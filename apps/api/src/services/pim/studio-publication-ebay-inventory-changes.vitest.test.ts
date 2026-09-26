/** PE P3.2 — change-only plan for an eBay Inventory-model listing: pure, anonymised fixtures. */
import { describe, expect, it } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import { compileEbayInventoryChanges, prepareEbayInventoryChanges, type EbayInventoryOurs } from './studio-publication-ebay-inventory-changes.js'
import { publicationChangeId } from './studio-publication-changes.js'
import type { ServerLiveRead } from '../live-read/types.js'
import type { EbayInventoryRaw } from '../live-read/ebay-inventory.js'

const liveGroup = { title: 'Jacket', description: '<p>Warm</p>', imageUrls: ['https://img.example/1.jpg'],
  aspects: { Marca: ['Brand'], Materiale: ['Pelle'] }, variantSKUs: ['FAM-RED-M', 'FAM-RED-L'],
  variesBy: { aspectsImageVariesBy: ['Colore'], specifications: [{ name: 'Colore', values: ['Rosso'] }, { name: 'Taglia', values: ['M', 'L'] }] } }
function live(group: Record<string, unknown> | null = liveGroup): ServerLiveRead<EbayInventoryRaw> {
  return { readAt: '2026-09-26T20:00:00.000Z', source: 'ebay-inventory-group', revision: group ? 'rev-1' : null,
    destination: { productId: 'family', channel: 'EBAY', marketplace: 'IT', accountId: 'account', aliasKey: '' },
    content: group ? { title: { state: 'value', value: group.title }, description: { state: 'value', value: group.description },
      pictures: { state: 'value', value: group.imageUrls },
      ...Object.fromEntries(Object.entries(group.aspects as Record<string, string[]>).map(([name, values]) => [`aspect:${name.toLowerCase()}`, { state: 'value' as const, value: values }])) }
      : { title: { state: 'unread', reason: 'group 500' }, description: { state: 'unread', reason: 'group 500' }, pictures: { state: 'unread', reason: 'group 500' } },
    variations: group ? { axes: ['Colore', 'Taglia'], order: { Colore: ['Rosso'], Taglia: ['M', 'L'] }, variants: [
      { sku: 'FAM-RED-M', values: { Colore: 'Rosso', Taglia: 'M' }, price: { state: 'absent' }, stock: { state: 'value', value: 3 }, state: 'live' },
      { sku: 'FAM-RED-L', values: { Colore: 'Rosso', Taglia: 'L' }, price: { state: 'absent' }, stock: { state: 'value', value: 0 }, state: 'live' }] } : null,
    errors: group ? [] : [{ scope: 'item', reason: 'group 500' }], raw: { groupKey: group ? 'FAM' : null, group, items: {}, item: null } }
}
const ours = (over: Partial<EbayInventoryOurs> = {}): EbayInventoryOurs => ({ title: 'Jacket', description: '<p>Warm</p>', pictures: ['https://img.example/1.jpg'],
  aspects: { Marca: ['Brand'], Materiale: ['Pelle'] }, axes: ['Colore', 'Taglia'], order: { Colore: ['Rosso'], Taglia: ['M', 'L'] },
  variants: [{ productId: 'm', sku: 'FAM-RED-M', values: { Colore: 'Rosso', Taglia: 'M' } }, { productId: 'l', sku: 'FAM-RED-L', values: { Colore: 'Rosso', Taglia: 'L' } }], ...over })
const owner = { productId: 'family', sku: 'FAM' }
const accepted = (entries: Record<string, unknown>) => new Map<string, StudioPublishValue>(Object.entries(entries).map(([field, value]) => [publicationChangeId('family', field), { state: 'value', value }]))
const byField = (plan: ReturnType<typeof prepareEbayInventoryChanges>) => Object.fromEntries(plan.changes.map(c => [c.field, c]))

describe('prepareEbayInventoryChanges', () => {
  it('nothing changed and the channel matches: every row SAME, nothing selectable', () => {
    const plan = prepareEbayInventoryChanges({ owner, ours: ours(), live: live(), baselineValues: accepted({ title: 'Jacket', description: '<p>Warm</p>' }) })
    expect(plan.changes.every(c => c.status === 'SAME' && !c.selectable)).toBe(true)
  })

  it('a Nexus title change since the accepted send is SEND by default; the group PUT replaces only the title', () => {
    const plan = prepareEbayInventoryChanges({ owner, ours: ours({ title: 'Winter jacket' }), live: live(), baselineValues: accepted({ title: 'Jacket' }) })
    const title = byField(plan).title
    expect(title).toMatchObject({ status: 'SEND', selectable: true, selectedByDefault: true })
    const send = compileEbayInventoryChanges(plan, [title.id])
    expect(send.groupKey).toBe('FAM')
    expect(send.group).toEqual({ ...liveGroup, title: 'Winter jacket' })
    expect(send.fieldWrites).toEqual({ family: [{ field: 'title', value: { state: 'value', value: 'Winter jacket' } }] })
  })

  it('with no accepted record a differing channel value is DIFFERS: selectable, never by default', () => {
    const plan = prepareEbayInventoryChanges({ owner, ours: ours({ description: '<p>New</p>' }), live: live(), baselineValues: new Map() })
    expect(byField(plan).description).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: false })
  })

  it('an unread group: every row CANNOT_COMPARE, and nothing can be compiled', () => {
    const plan = prepareEbayInventoryChanges({ owner, ours: ours({ title: 'Winter jacket' }), live: live(null), baselineValues: accepted({ title: 'Jacket' }) })
    expect(plan.changes.every(c => !c.selectable && c.reason === 'group 500')).toBe(true)
    expect(() => compileEbayInventoryChanges(plan, [byField(plan).title.id])).toThrow()
  })

  it('one aspect replaced; the other aspects, the channel-only ones included, are kept', () => {
    const channelOnly = { ...liveGroup, aspects: { ...liveGroup.aspects, 'Numero di parte': ['X1'] } }
    const plan = prepareEbayInventoryChanges({ owner, ours: ours({ aspects: { Marca: ['Brand'], Materiale: ['Tessuto'] } }), live: live(channelOnly), baselineValues: new Map() })
    const send = compileEbayInventoryChanges(plan, [byField(plan)['aspect:materiale'].id])
    expect(send.group.aspects).toEqual({ Marca: ['Brand'], Materiale: ['Tessuto'], 'Numero di parte': ['X1'] })
    expect(byField(plan)['aspect:numero di parte']).toMatchObject({ selectable: false })
  })

  it('variant values, new or removed variants and the variation theme are refused by name (P3.6), never sent', () => {
    const plan = prepareEbayInventoryChanges({ owner, ours: ours({ variants: [{ productId: 'm', sku: 'FAM-RED-M', values: { Colore: 'Rosso', Taglia: 'XL' } }, { productId: 'n', sku: 'FAM-RED-S', values: { Colore: 'Rosso', Taglia: 'S' } }],
      order: { Colore: ['Rosso'], Taglia: ['S', 'M', 'L', 'XL'] } }), live: live(), baselineValues: new Map() })
    const variation = plan.changes.filter(c => c.field === 'variation' || c.field === 'variesBy' || c.field.startsWith('variation-removed:'))
    expect(variation.map(c => c.sku).sort()).toEqual(['FAM', 'FAM-RED-L', 'FAM-RED-M', 'FAM-RED-S'])
    expect(variation.every(c => !c.selectable && /later step/.test(c.reason))).toBe(true)
  })

  it('refuses to compile when the live group holds a field the whole-object PUT would not carry', () => {
    const plan = prepareEbayInventoryChanges({ owner, ours: ours({ title: 'Winter jacket' }), live: live({ ...liveGroup, somethingNew: true }), baselineValues: accepted({ title: 'Jacket' }) })
    expect(() => compileEbayInventoryChanges(plan, [byField(plan).title.id])).toThrow(/unknown field/)
  })

  it('an empty title or a non-HTTPS picture cannot be selected', () => {
    const plan = prepareEbayInventoryChanges({ owner, ours: ours({ title: '', pictures: ['http://img.example/1.jpg'] }), live: live(), baselineValues: new Map() })
    expect(byField(plan).title.selectable).toBe(false)
    expect(byField(plan).pictures.selectable).toBe(false)
  })
})
