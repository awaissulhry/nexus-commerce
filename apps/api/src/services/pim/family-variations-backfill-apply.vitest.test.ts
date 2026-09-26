/**
 * VTR step 1b — the backfill WRITE (docs/variation-theme/STEP1-PLAN.md): per family, in ONE transaction, the axes become attribute
 * codes (today's spellings kept in the label mirror) and each value moves under its code as the dictionary spells it. Dry run writes
 * nothing; a second run changes nothing; a family that cannot be mapped is skipped and reported.
 */
import { afterAll, aroundAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '@nexus/database/workspace-context'

const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('./readiness-index.service.js', () => ({ produceReadinessForProducts: vi.fn(async () => ({ inline: 0, pending: 0 })) }))
aroundAll(run => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, run))
import prisma from '../../db.js'
import { applyFamilyVariationsBackfill } from './family-variations-backfill.js'

beforeEach(async () => {
  await prisma.productReadCache.deleteMany()
  await prisma.product.deleteMany()
  await prisma.attributeOption.deleteMany()
  await prisma.customAttribute.deleteMany()
  await prisma.attributeGroup.deleteMany()
  await prisma.attributeGroup.create({ data: { id: 'g', code: 'variation', label: 'Variation' } })
  await prisma.customAttribute.create({ data: { id: 'a-color', code: 'color', label: 'Color', semanticKey: 'color', groupId: 'g', type: 'select' } })
  await prisma.customAttribute.create({ data: { id: 'a-size', code: 'size', label: 'Size', semanticKey: 'size', groupId: 'g', type: 'select' } })
  // What the attributes lane creates (option A): Italian default label, other languages alongside.
  for (const [id, attributeId, code, label, en] of [['o1', 'a-color', 'black', 'Nero', 'Black'], ['o2', 'a-color', 'red', 'Rosso', 'Red'],
    ['o3', 'a-size', 'm', 'M', 'M'], ['o4', 'a-size', 'l', 'L', 'L']] as const) {
    await prisma.attributeOption.create({ data: { id, attributeId, code, label, metadata: { labels: { it: label, en } }, sortOrder: 1 } })
  }
  // A family with axes and values under today's spellings.
  await prisma.product.create({ data: { id: 'fam', sku: 'FAM', name: 'F', basePrice: 1, isParent: true, version: 4, variationAxes: ['Colore', 'Taglia'] } })
  await prisma.product.create({ data: { id: 'f1', sku: 'FAM-1', name: 'F1', basePrice: 1, parentId: 'fam', categoryAttributes: { variations: { Colore: 'Nero', Taglia: 'M' } }, variantAttributes: { Taglia: 'M' } } })
  await prisma.product.create({ data: { id: 'f2', sku: 'FAM-2', name: 'F2', basePrice: 1, parentId: 'fam', categoryAttributes: { variations: { Colore: 'Nero | Donna', Taglia: 'L' } } } })
  // A family with a theme text and NO axes (the Owner: take the axes from the theme text).
  await prisma.product.create({ data: { id: 'gale', sku: 'GALE', name: 'G', basePrice: 1, isParent: true, version: 9, variationAxes: [], variationTheme: 'Colore,Taglia' } })
  await prisma.product.create({ data: { id: 'g1', sku: 'GALE-1', name: 'G1', basePrice: 1, parentId: 'gale', categoryAttributes: { variations: { Color: 'Rosso', Size: 'L' } } } })
  // A family whose axis maps to nothing: skipped, untouched.
  await prisma.product.create({ data: { id: 'odd', sku: 'ODD', name: 'O', basePrice: 1, isParent: true, version: 2, variationAxes: ['Materiale'] } })
  await prisma.product.create({ data: { id: 'o1', sku: 'ODD-1', name: 'O1', basePrice: 1, parentId: 'odd', categoryAttributes: { variations: { Materiale: 'Pelle' } } } })
})
afterAll(async () => { await fixture.database?.close() })

const row = (id: string) => prisma.product.findUniqueOrThrow({ where: { id }, select: { version: true, variationAxes: true, variationAxisCodes: true, categoryAttributes: true, variantAttributes: true } })

describe('applyFamilyVariationsBackfill', () => {
  it('dry run: lists every change and writes nothing', async () => {
    const result = await applyFamilyVariationsBackfill({ write: false })
    expect(result.families.map(f => [f.sku, f.status])).toEqual([['FAM', 'planned'], ['GALE', 'planned'], ['ODD', 'skipped']])
    expect(result.families.find(f => f.sku === 'FAM')).toMatchObject({ axes: ['color', 'size'], valueChanges: 4, optionsToCreate: ['color:Nero | Donna'] })
    expect(result.families.find(f => f.sku === 'ODD')).toMatchObject({ reason: 'The Materiale axis maps to no dictionary attribute.' })
    expect((await row('fam')).version).toBe(4)
    expect((await row('f1')).categoryAttributes).toEqual({ variations: { Colore: 'Nero', Taglia: 'M' } })
    expect(await prisma.attributeOption.count()).toBe(4)
  })

  it('write: axes become codes (spellings kept), values move under the codes, a mixed value becomes a business option', async () => {
    const result = await applyFamilyVariationsBackfill({ write: true })
    expect(result.families.map(f => [f.sku, f.status])).toEqual([['FAM', 'written'], ['GALE', 'written'], ['ODD', 'skipped']])
    expect(await row('fam')).toMatchObject({ variationAxisCodes: ['color', 'size'], variationAxes: ['Colore', 'Taglia'], version: 6 })
    expect((await row('f1')).categoryAttributes).toEqual({ variations: { color: 'Nero', size: 'M' } })
    expect((await row('f1')).variantAttributes).toEqual({})
    expect((await row('f2')).categoryAttributes).toEqual({ variations: { color: 'Nero | Donna', size: 'L' } })
    expect(await prisma.attributeOption.findFirst({ where: { code: 'nero_donna' }, select: { label: true } })).toEqual({ label: 'Nero | Donna' })
    expect(await row('gale')).toMatchObject({ variationAxisCodes: ['color', 'size'], variationAxes: ['Colore', 'Taglia'] })
    expect((await row('g1')).categoryAttributes).toEqual({ variations: { color: 'Rosso', size: 'L' } })
    expect(await row('odd')).toMatchObject({ version: 2, variationAxisCodes: [] })
  })

  it('a second run changes nothing', async () => {
    await applyFamilyVariationsBackfill({ write: true })
    const before = await Promise.all(['fam', 'f1', 'gale', 'g1'].map(row))
    const again = await applyFamilyVariationsBackfill({ write: true })
    expect(again.families.filter(f => f.status === 'written')).toEqual([])
    expect(again.families.find(f => f.sku === 'FAM')).toMatchObject({ status: 'unchanged' })
    expect(await Promise.all(['fam', 'f1', 'gale', 'g1'].map(row))).toEqual(before)
  })
})
