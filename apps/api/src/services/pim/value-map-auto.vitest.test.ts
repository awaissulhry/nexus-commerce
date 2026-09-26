/**
 * P5 (docs/attributes/PLAN.md §4.3) — automatic links and value maps.
 *
 *   · `masterDefaultRule`: an existing link keeps its source; a field the concept catalogue names links to the business
 *     attribute of that concept; a link into a STRICT list reads the value maps; measures and non-text Shopify fields
 *     are never linked by concept.
 *   · `autoMatchValueMaps`: on a real cached eBay category, the business's stored values (attribute AND variation axis)
 *     are matched to the channel's closed list — exact ignoring case, then synonyms — and what cannot be matched is
 *     returned, never guessed. A dry run writes nothing; a second run finds everything mapped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import prisma from '../../db.js'
import { masterDefaultRule } from './mapping/master-default-rule.js'
import { conceptSources } from './mapping/field-catalogue.service.js'
import { autoMatchValueMaps } from './value-map-auto.service.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
/** Production runs with business profiles on: every database call here runs inside a business, as real callers do. */
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

afterAll(async () => { await state.db?.close() })

describe('masterDefaultRule with concept links', () => {
  const masterKeys = new Set(['brand', 'name', 'color', 'target_gender', 'weightValue'])
  const concepts = (channel: 'AMAZON' | 'EBAY' | 'SHOPIFY') => ({ channel, sourceFor: conceptSources([{ code: 'color', semanticKey: 'color' }, { code: 'target_gender', semanticKey: 'target_gender' }]) })
  const f = (key: string, extra: Record<string, unknown> = {}) => ({ key, masterKey: undefined, channelStore: undefined, defaultRule: undefined, shopifyField: undefined, readOnlyReason: undefined, ...extra }) as never

  it('keeps an existing link exactly: same source, no concept note', () => scoped(async () => {
    expect(masterDefaultRule(f('brand'), masterKeys, concepts('EBAY'))).toEqual({ source: 'brand', notes: 'Inherits the corresponding Master attribute. A channel mapping or listing override can replace it.' })
    expect(masterDefaultRule(f('brand'), masterKeys)).toEqual(masterDefaultRule(f('brand'), masterKeys, concepts('EBAY')))
  }))

  it('links a field the channel names as a concept’s, and says which concept', () => scoped(async () => {
    const rule = masterDefaultRule(f('colore'), masterKeys, concepts('EBAY'))
    expect(rule).toMatchObject({ source: 'color', notes: expect.stringContaining('"color" concept') })
    expect(masterDefaultRule(f('department'), masterKeys, concepts('AMAZON'))).toMatchObject({ source: 'target_gender' })
    // Without the business's links there is nothing to link to.
    expect(masterDefaultRule(f('colore'), masterKeys)).toBeNull()
  }))

  it('reads the value maps when the channel list is strict — for a concept link and a direct link alike', () => scoped(async () => {
    expect(masterDefaultRule(f('colore', { mode: 'strict', options: ['Black'] }), masterKeys, concepts('EBAY'))).toMatchObject({ transforms: [{ type: 'valueMap', attribute: 'color' }] })
    expect(masterDefaultRule(f('color', { mode: 'strict', options: ['Black'] }), masterKeys, concepts('EBAY'))).toMatchObject({ source: 'color', transforms: [{ type: 'valueMap', attribute: 'color' }] })
    expect(masterDefaultRule(f('color', { mode: 'open', options: ['Black'] }), masterKeys, concepts('EBAY'))).not.toHaveProperty('transforms')
  }))

  it('never links a measure or a non-text Shopify field by concept', () => scoped(async () => {
    expect(masterDefaultRule(f('item_weight', { shape: 'measure' }), masterKeys, concepts('AMAZON'))).toBeNull()
    const reference = { id: 'x', definition: { type: 'list.metaobject_reference' }, type: 'list.metaobject_reference', source: 'shopify.color-pattern' }
    expect(masterDefaultRule(f('mf_color', { shopifyField: reference }), masterKeys, concepts('SHOPIFY'))).toBeNull()
    const text = { id: 'y', definition: { type: 'single_line_text_field' }, type: 'single_line_text_field', source: 'shopify.color-pattern' }
    expect(masterDefaultRule(f('mf_color', { shopifyField: text }), masterKeys, concepts('SHOPIFY'))).toMatchObject({ source: 'color' })
  }))
})

describe('autoMatchValueMaps on a cached eBay category', () => {
  beforeAll(() => scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '177104', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
      schemaDefinition: { conditions: [], aspects: [
        // A localized key with no English name — as measured in stored listings (`aspect_Colore`).
        { id: 'aspect_Colore', label: 'Colore', localizedName: 'Colore', englishName: null, kind: 'enum', options: ['Black', 'Blue', 'Red'], enumMode: 'strict', cardinality: 'SINGLE' },
      ] } as never } })
    const group = await prisma.attributeGroup.create({ data: { code: 'vma', label: 'Specs' } })
    await prisma.customAttribute.create({ data: { code: 'color', label: 'Color', groupId: group.id, type: 'text', scope: 'per_variant', semanticKey: 'color' } })
    const values: Array<[string, Record<string, unknown>]> = [
      ['vma-1', { color: 'Nero' }], ['vma-2', { color: 'Black' }], ['vma-3', { color: 'blu' }], ['vma-4', { color: 'Chartreuse' }],
      ['vma-5', { variations: { Colore: 'Rosso' } }], ['vma-6', { color: 'RED' }],
    ]
    for (const [id, categoryAttributes] of values) await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 1, categoryAttributes: categoryAttributes as never } })
  }), 60_000)

  it('matches exact-ignoring-case and synonyms, returns what it cannot match, and writes nothing on a dry run', () => scoped(async () => {
    const result = await autoMatchValueMaps({ channel: 'EBAY', marketplace: 'IT', productType: '177104' })
    expect(result.applied).toBe(false)
    const field = result.fields.find(f => f.attribute === 'color')!
    expect(field).toBeDefined()
    expect(field.concept).toBe('color')
    expect(field.alreadyValid).toBe(1)                     // Black is already an option
    const byFrom = (list: Array<{ from: string }>) => [...list].sort((a, b) => a.from.localeCompare(b.from))
    expect(byFrom(field.matched)).toEqual([
      { from: 'blu', to: 'Blue', how: 'synonym' },          // Italian spelling
      { from: 'Nero', to: 'Black', how: 'synonym' },
      { from: 'RED', to: 'Red', how: 'exact' },             // case only
      { from: 'Rosso', to: 'Red', how: 'synonym' },         // from the variation axis `Colore`
    ])
    expect(field.unmatched).toEqual(['Chartreuse'])
    expect(await prisma.fieldValueMap.count()).toBe(0)
  }))

  it('applies: one row per matched value, marked as automatic, and a second run finds them mapped', () => scoped(async () => {
    const applied = await autoMatchValueMaps({ channel: 'EBAY', marketplace: 'IT', productType: '177104', dryRun: false })
    expect(applied).toMatchObject({ applied: true, written: 4 })
    const rows = await prisma.fieldValueMap.findMany({ select: { attribute: true, fromValue: true, toValue: true, confidence: true, reviewedAt: true } })
    expect(rows.map(r => [r.fromValue, r.toValue, r.confidence]).sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['blu', 'Blue', 'AUTO_SYNONYM'], ['Nero', 'Black', 'AUTO_SYNONYM'], ['RED', 'Red', 'AUTO_EXACT'], ['Rosso', 'Red', 'AUTO_SYNONYM']])
    expect(rows.every(r => r.attribute === 'color' && r.reviewedAt instanceof Date)).toBe(true)
    const again = await autoMatchValueMaps({ channel: 'EBAY', marketplace: 'IT', productType: '177104', dryRun: false })
    expect(again.written).toBe(0)
    expect(again.fields.find(f => f.attribute === 'color')).toMatchObject({ alreadyMapped: 4, matched: [], unmatched: ['Chartreuse'] })
  }))
})
