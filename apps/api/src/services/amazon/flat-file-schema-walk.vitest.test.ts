/**
 * A4C — exhaustive schema walker + deep reassembly tests. Synthetic schemas
 * mirror the exact families the live census flagged as missing (epr nested
 * arrays, offer schedules, ghs classifications, chest dimensions, localized
 * material instances) plus already-covered shapes that must add nothing.
 */
import { describe, it, expect } from 'vitest'
import { walkSchemaLeaves, emitUncoveredColumns, applyDeepValue } from './flat-file-schema-walk.js'

const CTX = { marketplaceId: 'APJ6JRA9NG5V4', languageTag: 'it_IT' }

describe('walkSchemaLeaves', () => {
  it('enumerates nested arrays-in-arrays with schema-declared instance counts (epr shape)', () => {
    const epr = {
      type: 'array',
      maxUniqueItems: 2,
      items: {
        properties: {
          marketplace_id: { type: 'string' },
          main_material: { type: 'string', enum: ['PLASTIC', 'PAPER'] },
          granular_materials: {
            type: 'array',
            maxUniqueItems: 4,
            items: {
              properties: {
                granular_material: { type: 'string' },
                recycled_content_percentage: { type: 'number' },
                weight: { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string' } } },
              },
            },
          },
        },
      },
    }
    const leaves = walkSchemaLeaves('epr_product_packaging', epr as never)
    // per root instance: main_material + 4 × (granular_material, pct, weight.value, weight.unit)
    expect(leaves.length).toBe(2 * (1 + 4 * 4))
    const refs = leaves.map((l) => l.fieldRef)
    expect(refs).toContain('epr_product_packaging[marketplace_id]#2.granular_materials#3.weight.value')
    expect(refs).toContain('epr_product_packaging[marketplace_id]#1.main_material')
    const deep = leaves.find((l) => l.fieldRef.endsWith('#2.granular_materials#3.weight.value'))!
    // value-leaf ids drop the __value suffix (matches chest__size / chest__size__unit)
    expect(deep.colId).toBe('epr_product_packaging_2__granular_materials_3__weight')
    expect(deep.spec).toMatchObject({ rootIdx: 2, leaf: 'value', type: 'number' })
  })

  it('walks localized wrappers with instances (outer.material #1..#N) and deep schedules', () => {
    const outer = {
      type: 'array',
      items: {
        properties: {
          material: {
            type: 'array',
            maxUniqueItems: 5,
            items: { properties: { value: { type: 'string' }, language_tag: { type: 'string' } } },
          },
        },
      },
    }
    const leaves = walkSchemaLeaves('outer', outer as never)
    expect(leaves.map((l) => l.fieldRef)).toEqual([
      'outer[marketplace_id]#1.material[language_tag]#1.value',
      'outer[marketplace_id]#1.material[language_tag]#2.value',
      'outer[marketplace_id]#1.material[language_tag]#3.value',
      'outer[marketplace_id]#1.material[language_tag]#4.value',
      // nested cap = 4
    ])
    expect(leaves[1].colId).toBe('outer__material_2')
    expect(leaves[1].spec.segs[0]).toMatchObject({ key: 'material', idx: 2, localized: true })

    const offer = {
      type: 'array',
      items: {
        properties: {
          audience: { type: 'string' },
          minimum_seller_allowed_price: {
            type: 'array',
            items: {
              properties: {
                schedule: { type: 'array', items: { properties: { value_with_tax: { type: 'number' } } } },
              },
            },
          },
        },
      },
    }
    const offerLeaves = walkSchemaLeaves('purchasable_offer', offer as never)
    expect(offerLeaves.map((l) => l.fieldRef)).toContain(
      'purchasable_offer[marketplace_id]#1.minimum_seller_allowed_price#1.schedule#1.value_with_tax',
    )
  })
})

describe('emitUncoveredColumns — the never-again diff', () => {
  it('adds nothing for a fully-covered field (bullet_point style)', () => {
    const bullet = {
      type: 'array',
      maxUniqueItems: 5,
      items: { properties: { value: { type: 'string' }, language_tag: { type: 'string' } } },
    }
    const existing = [1, 2, 3, 4, 5].map((i) => ({
      id: `bullet_point_${i}`,
      fieldRef: `bullet_point[marketplace_id][language_tag]#${i}.value`,
    }))
    const res = emitUncoveredColumns('bullet_point', bullet as never, existing)
    expect(res.columns).toEqual([])
    expect(res.covered).toBe(5)
    expect(res.leaves).toBe(5)
  })

  it('emits typed generic columns for uncovered leaves only (chest dims, enum kind)', () => {
    const chest = {
      type: 'array',
      items: {
        properties: {
          size: {
            type: 'array',
            items: { properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['CM', 'IN'] } } },
          },
        },
      },
    }
    const res = emitUncoveredColumns('chest', chest as never, [])
    expect(res.columns.map((c) => c.id)).toEqual(['chest__size', 'chest__size__unit'])
    expect(res.columns[0].kind).toBe('number')
    expect(res.columns[1].kind).toBe('enum')
    expect(res.columns[1].options).toEqual(['', 'CM', 'IN'])
    expect(res.deep['chest__size'].leaf).toBe('value')
  })

  it('never emits two columns for one canonical leaf and dodges id collisions', () => {
    const f = { type: 'array', items: { properties: { value: { type: 'string' } } } }
    const res = emitUncoveredColumns('fabric', f as never, [{ id: 'fabric', fieldRef: undefined }])
    expect(res.columns).toHaveLength(1)
    expect(res.columns[0].id).toBe('fabric__x') // 'fabric' taken by the existing column
  })
})

describe('applyDeepValue — nested reassembly', () => {
  it('rebuilds sibling leaves into one nested structure with root stamps', () => {
    const attrs: Record<string, unknown> = {}
    const specWeightV = { rootIdx: 2, segs: [{ key: 'granular_materials', idx: 3 }], leaf: 'value', type: 'number' as const }
    const specWeightU = { rootIdx: 2, segs: [{ key: 'granular_materials', idx: 3 }], leaf: 'unit', type: 'string' as const }
    // weight is one level deeper (object under the array element)
    const vSpec = { ...specWeightV, segs: [...specWeightV.segs, { key: 'weight' }] }
    const uSpec = { ...specWeightU, segs: [...specWeightU.segs, { key: 'weight' }] }
    applyDeepValue(attrs, 'epr_product_packaging', vSpec, '12,5', CTX)
    applyDeepValue(attrs, 'epr_product_packaging', uSpec, 'GRAM', CTX)
    const root = attrs.epr_product_packaging as Array<Record<string, unknown>>
    expect(root).toHaveLength(2)
    expect(root[1].marketplace_id).toBe(CTX.marketplaceId)
    const gm = root[1].granular_materials as Array<Record<string, unknown>>
    expect(gm).toHaveLength(3)
    expect(gm[2].weight).toEqual({ value: 12.5, unit: 'GRAM' })
    expect(root[0]).toEqual({}) // untouched placeholder instance
  })

  it('stamps language_tag on localized array elements and audience on purchasable_offer', () => {
    const attrs: Record<string, unknown> = {}
    applyDeepValue(
      attrs,
      'outer',
      { rootIdx: 1, segs: [{ key: 'material', idx: 2, localized: true }], leaf: 'value', type: 'string' },
      'Nylon',
      CTX,
    )
    const outer = attrs.outer as Array<Record<string, unknown>>
    const material = outer[0].material as Array<Record<string, unknown>>
    expect(material[1]).toEqual({ language_tag: 'it_IT', value: 'Nylon' })

    applyDeepValue(
      attrs,
      'purchasable_offer',
      { rootIdx: 1, segs: [{ key: 'minimum_seller_allowed_price', idx: 1 }, { key: 'schedule', idx: 1 }], leaf: 'value_with_tax', type: 'number' },
      '99.5',
      CTX,
    )
    const offer = attrs.purchasable_offer as Array<Record<string, unknown>>
    expect(offer[0].audience).toBe('ALL')
    expect((offer[0].minimum_seller_allowed_price as never[])[0]).toEqual({
      schedule: [{ value_with_tax: 99.5 }],
    })
  })

  it('drops NaN numbers instead of emitting them', () => {
    const attrs: Record<string, unknown> = {}
    applyDeepValue(attrs, 'chest', { rootIdx: 1, segs: [{ key: 'size', idx: 1 }], leaf: 'value', type: 'number' }, 'abc', CTX)
    expect(attrs.chest).toBeUndefined()
  })
})
