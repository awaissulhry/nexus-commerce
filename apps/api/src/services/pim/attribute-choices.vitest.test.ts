/**
 * P6 (docs/attributes/PLAN.md §4.4) — the open dropdown's data: one merged choice list with its sources, retired
 * options no longer offered (but still readable), and suggestions on a text attribute.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import prisma from '../../db.js'
import { attributeChoices, ChoicesError } from './attribute-choices.service.js'
import { upsertAttributes } from './attribute-dictionary.service.js'
import { familySheetFields } from './family-sheet-schema.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
/** Production runs with business profiles on: every database call here runs inside a business, as real callers do. */
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

let familyId = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '177104', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { conditions: [], aspects: [
      { id: 'aspect_Color', label: 'Color', localizedName: 'Colore', englishName: 'Color', kind: 'enum', options: ['Black', 'Blue'], enumMode: 'strict', cardinality: 'SINGLE' },
    ] } as never } })
  await prisma.attributeGroup.create({ data: { code: 'choices', label: 'Specs' } })
  // A TEXT attribute with suggestion options (P6): one retired.
  const saved = await upsertAttributes([{ code: 'color', label: 'Color', type: 'text', groupCode: 'choices', semanticKey: 'color',
    options: [{ code: 'black', label: 'Black', synonyms: ['Nero'] }, { code: 'bordeaux', label: 'Bordeaux' }, { code: 'old_red', label: 'Old red', archived: true }] }])
  expect(saved.applied).toBe(true)
  const family = await prisma.productFamily.create({ data: { code: 'choices-jackets', label: 'Jackets' } })
  familyId = family.id
  await prisma.familyAttribute.create({ data: { familyId, attributeId: (saved.results[0] as { id: string }).id, channels: [] } })
}), 60_000)
afterAll(async () => { await state.db?.close() })

it('merges the business options and the channel values into one list, with every source and where it is closed', () => scoped(async () => {
  const result = await attributeChoices('color', [{ channel: 'EBAY', marketplace: 'IT', productType: '177104' }])
  expect(result.attribute).toEqual({ code: 'color', label: 'Color', optionMode: 'open' })
  const byValue = Object.fromEntries(result.choices.map(c => [c.value, c]))
  // `black` (business) and `Black` (eBay) are one choice with two sources.
  expect(byValue.black).toMatchObject({ label: 'Black', sources: ['business', 'EBAY IT'], strictIn: ['EBAY IT'], synonyms: ['Nero'] })
  expect(byValue.Blue).toMatchObject({ sources: ['EBAY IT'], strictIn: ['EBAY IT'] })
  expect(byValue.bordeaux).toMatchObject({ sources: ['business'], strictIn: [] })
  // A retired option is not offered.
  expect(byValue.old_red).toBeUndefined()
  expect(result.channels).toEqual([expect.objectContaining({ coordinate: 'EBAY IT', mode: 'strict', options: 2 })])
  expect(result.unavailable).toEqual([])
}))

it('says which coordinate it could not read, instead of silently offering less', () => scoped(async () => {
  const result = await attributeChoices('color', [{ channel: 'EBAY', marketplace: 'ZZ', productType: '1' }])
  expect(result.unavailable).toEqual([expect.objectContaining({ coordinate: 'EBAY ZZ' })])
  expect(result.choices.map(c => c.value).sort()).toEqual(['black', 'bordeaux'])
  await expect(attributeChoices('nope', [])).rejects.toBeInstanceOf(ChoicesError)
}))

it('the sheet offers only current options, but keeps the label of a retired one so a saved value still reads well', () => scoped(async () => {
  const [field] = (await familySheetFields([familyId], 'en')).filter(f => f.id === 'attr_color')
  expect(field.options).toEqual(['black', 'bordeaux'])
  expect(field.optionLabels).toMatchObject({ old_red: 'Old red' })
  // Suggestions on a text attribute keep it a text column: the dropdown is open.
  expect(field.type).toBe('text')
}))
