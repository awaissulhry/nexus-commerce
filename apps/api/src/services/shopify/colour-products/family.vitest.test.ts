/**
 * The colour plan from the real family loader (`loadFamily`) on PGlite: a size is the text the products store — what the
 * Shopify publisher sends — not the default label of the dictionary option it matches. Regression (Xavia X suit,
 * IND-SUIT, MISANO on the live store): sizes stored "46" … "58" under numeric dictionary options (`v_46` …) did not pair
 * with Shopify's "46" … "58" ("0 of 7 pair") when the option is labelled otherwise. Every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/shopify/colour-products/family.vitest.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { matchColourProducts, type ColourCandidate } from '@nexus/shared/shopify-colour-products'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { loadFamily } from '../../images/media-plan.service.js'
import { loadColourPlan } from './family.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const SIZES = ['46', '48', '50', '52', '54', '56', '58']
const ids: Record<string, string> = {}

/** A suit family: Colore × Taglia, sizes stored as "46" … "58"; `option` gives each size's dictionary option. */
async function suit(sku: string, sizeAttribute: string) {
  const root = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, isParent: true, variationAxes: ['Colore', 'Taglia'], variationAxisCodes: ['color', sizeAttribute] } as never })
  for (const size of SIZES) await prisma.product.create({ data: { sku: `${sku}-NERO-${size}`, name: `${sku} ${size}`, basePrice: 10, parentId: root.id,
    categoryAttributes: { variations: { Colore: 'Nero', Taglia: size } } } as never })
  return root.id
}

beforeAll(() => scoped(async () => {
  const group = await prisma.attributeGroup.create({ data: { code: 'suit-sizes', label: 'Variations' } })
  const attribute = (code: string, label: string) => prisma.customAttribute.create({ data: { code, label, groupId: group.id, type: 'select', scope: 'per_variant' } })
  const colour = await attribute('color', 'Colore')
  await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'nero', label: 'Nero' } })
  // Numeric codes (v_46 …) whose default label is not the stored text; the stored "46" matches by synonym.
  const eu = await attribute('size_eu', 'Taglia')
  for (const [i, size] of SIZES.entries()) await prisma.attributeOption.create({ data: { attributeId: eu.id, code: `v_${size}`, label: `EU ${size}`, synonyms: [size], sortOrder: i } })
  // A size dictionary whose letter options list the EU numbers as synonyms: "46" matches the option `s`, labelled "S".
  const letters = await attribute('size_letters', 'Taglia')
  for (const [i, letter] of ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'].entries()) await prisma.attributeOption.create({ data: { attributeId: letters.id, code: letter.toLowerCase(), label: letter, synonyms: [SIZES[i]], sortOrder: i } })
  ids.eu = await suit('XRACING', 'size_eu')
  ids.letters = await suit('IND-SUIT', 'size_letters')
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** The live Shopify product: one option, Size "46" … "58", no SKU on any variant. */
const shopify: ColourCandidate = { id: 'gid://shopify/Product/900000000001', title: 'X suit', handle: 'x-suit', status: 'ACTIVE', colourName: 'Black', group: [],
  variants: SIZES.map((size, i) => ({ id: `gid://shopify/ProductVariant/${i}`, sku: null, inventoryItemId: `gid://shopify/InventoryItem/${i}`, options: [size] })) }

describe('the colour plan names each size as the products store it', () => {
  it.each([['eu', 'v_46'], ['letters', 's']])('numeric sizes stored "46" … "58" (dictionary %s) pair with Shopify\'s "46" … "58"', async (family, firstCode) => {
    const loaded = await scoped(() => loadFamily(ids[family]))
    // The root cause: the dictionary's label for the stored "46" is not "46".
    const key = Object.keys(loaded.family.valueLabels).find(k => k.endsWith(`:${firstCode}`))!
    expect(loaded.family.valueLabels[key]).not.toBe('46')
    expect(loaded.valueTexts[key]).toBe('46')
    const { plan } = await scoped(() => loadColourPlan(ids[family]))
    expect(plan.issues).toEqual([])
    expect(plan.products.map(p => [p.nexusValue, p.options[0].values])).toEqual([['Nero', SIZES]])
    const [match] = matchColourProducts(plan, [shopify], {}, { [plan.products[0].key]: shopify.id })
    expect([match.variants.length, match.missing.length, match.extra.length, match.issues]).toEqual([7, 0, 0, []])
    expect(match.variants.every(v => v.by === 'options')).toBe(true)
  })

  it('the size map pairs those stored texts too (MISANO: 46 → S on a letter-sized store)', async () => {
    const { plan } = await scoped(() => loadColourPlan(ids.eu, { sizeMap: { size_eu: { 46: 'S', 48: 'M' } } }))
    expect(plan.products[0].options[0]).toMatchObject({ values: ['S', 'M', ...SIZES.slice(2)], nexusValues: SIZES })
  })
})
