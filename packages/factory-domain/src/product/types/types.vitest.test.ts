import { describe, expect, it } from 'vitest'
import { effectiveType, fillFromType, inheritedPpeProblems, missingAttributes, parentCircle, styleDefaultsOf, typeProblems, type TypeRow } from './rules'

const jacket: TypeRow = {
  id: 'jacket',
  code: 'TEST-PT-JKT',
  name: 'Test jacket',
  productType: 'JACKET',
  parentId: null,
  requiredAttributes: ['gender', 'hsCode'],
  defaultSizeScaleId: 'scale',
  labelTemplateId: 'label',
  measurementTemplateId: 'template',
  defaultPpeCategory: 'CATEGORY_II',
  defaultPpeStandard: 'EN 17092-4:2020',
  defaultPpeClass: 'A',
}
const touring: TypeRow = { ...jacket, id: 'touring', code: 'TEST-PT-TOUR', parentId: 'jacket', requiredAttributes: ['ppeClass', 'hsCode'], defaultSizeScaleId: null, labelTemplateId: null, measurementTemplateId: null, defaultPpeCategory: null, defaultPpeStandard: 'EN 17092-3:2020', defaultPpeClass: 'AA' }

describe('product types inherit (PRD-008)', () => {
  it('takes a default from the nearest type that sets it, and adds the required attributes up the tree', () => {
    const effective = effectiveType([touring, jacket])
    expect(effective.requiredAttributes).toEqual([
      { name: 'gender', fromTypeId: 'jacket' },
      { name: 'hsCode', fromTypeId: 'jacket' },
      { name: 'ppeClass', fromTypeId: 'touring' },
    ])
    expect(effective.defaults.defaultSizeScaleId).toEqual({ value: 'scale', fromTypeId: 'jacket' })
    expect(effective.defaults.defaultPpeClass).toEqual({ value: 'AA', fromTypeId: 'touring' })
    expect(styleDefaultsOf(effective)).toEqual({ sizeScaleId: 'scale', measurementTemplateId: 'template', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA', labelTemplateId: 'label' })
    expect(inheritedPpeProblems('JACKET', effective)).toEqual([])
  })

  it('a new style takes what it leaves out; the template only made to measure, the standard only in the type\'s category', () => {
    const defaults = styleDefaultsOf(effectiveType([touring, jacket]))
    const body: { code: string; sizeScaleId?: string } = { code: 'X' }
    expect(fillFromType(body, defaults)).toEqual({ code: 'X', sizeScaleId: 'scale', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' })
    expect(fillFromType({ sizeScaleId: 'mine', mtmAllowed: true }, defaults)).toMatchObject({ sizeScaleId: 'mine', measurementTemplateId: 'template' })
    expect(fillFromType({ ppeCategory: 'NOT_PPE' }, defaults)).toEqual({ ppeCategory: 'NOT_PPE', sizeScaleId: 'scale' })
    expect(fillFromType({ ppeClass: null }, defaults)).toMatchObject({ ppeClass: null, ppeStandard: 'EN 17092-3:2020' })
  })

  it('finds what a style misses, a circle, and PPE defaults that break W1\'s rules', () => {
    expect(missingAttributes({ gender: 'MEN', hsCode: ' ', ppeClass: null }, effectiveType([touring, jacket]).requiredAttributes)).toEqual(['hsCode', 'ppeClass'])
    expect(parentCircle('jacket', [touring, jacket])).toBe(true)
    expect(parentCircle('other', [touring, jacket])).toBe(false)
    expect(inheritedPpeProblems('GLOVES', effectiveType([jacket]))).toEqual([{ path: 'defaultPpeStandard', message: 'Rider gloves are made to EN 13594, not EN 17092.' }])
    expect(inheritedPpeProblems('JACKET', effectiveType([{ ...jacket, defaultPpeCategory: null }]))).toMatchObject([{ path: 'defaultPpeCategory' }])
    expect(typeProblems({ code: 'A B', name: 'x', requiredAttributes: ['gender', 'gender', 'colour'], defaultPpeStandard: null, defaultPpeClass: null }).map((issue) => issue.path)).toEqual(['code', 'requiredAttributes/1', 'requiredAttributes/2'])
  })
})
