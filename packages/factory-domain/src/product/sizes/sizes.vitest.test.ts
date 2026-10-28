import { describe, expect, it } from 'vitest'
import { addSizesBody, createScaleBody, scaleView, sizeBody } from './contracts'
import {
  bodyMeasuresProblems,
  inScaleOrder,
  insertSizes,
  measureUnitProblems,
  measureUnitsOf,
  normaliseSize,
  reorderProblems,
  scaleOrder,
  scaleProblems,
  sequenceOf,
  sizeCodeChangeRefusal,
  sizeListProblems,
  sizeMachine,
  sizeProblems,
  sizeScaleMachine,
} from './rules'
import { canTransition } from '../../state/machine'

/** Made-up scales: EU jacket sizes 46-58 and letters S-3XL. */
const EU = ['46', '48', '50', '52', '54', '56', '58'].map((code, index) => ({ code, seq: index + 1, status: 'ACTIVE' as const }))

describe('a size (PRD-047)', () => {
  it('normalises the code, the label and the body measures', () => {
    expect(normaliseSize({ code: ' xl ', label: ' 52 (XL) ', bodyMeasures: { chest: { min: '108.0', max: '112.50', unit: 'cm' }, height: { min: '182', max: null, unit: 'cm' } } })).toEqual({
      code: 'XL',
      label: '52 (XL)',
      bodyMeasures: { chest: { min: '108', max: '112.5', unit: 'cm' }, height: { min: '182', max: null, unit: 'cm' } },
    })
    expect(normaliseSize({ code: '52', label: '  ', bodyMeasures: {} })).toEqual({ code: '52', label: null, bodyMeasures: null })
  })

  it('takes codes of 1 to 10 capitals or digits with . or _ inside, never the SKU separator', () => {
    for (const code of ['52', 'XL', '3XL', '7.5', 'W_38', 'S']) expect(sizeProblems({ code, label: null, bodyMeasures: null })).toEqual([])
    for (const code of ['S-M', '-1', '1.', 'xl', 'ABCDEFGHIJK', '', '44/46']) expect(sizeProblems({ code, label: null, bodyMeasures: null }).map((issue) => issue.path)).toEqual(['code'])
  })

  it('checks body measures: a point name, a unit, at least one end, numbers above 0, min ≤ max', () => {
    expect(bodyMeasuresProblems({ chest: { min: '100', max: '104', unit: 'cm' } })).toEqual([])
    expect(bodyMeasuresProblems({ Chest: { min: '100', max: '104', unit: 'cm' } })[0]!.path).toBe('bodyMeasures/Chest')
    expect(bodyMeasuresProblems({ chest: { min: null, max: null, unit: 'cm' } })).toEqual([{ path: 'bodyMeasures/chest', message: 'Give at least the smallest or the largest value.' }])
    expect(bodyMeasuresProblems({ chest: { min: '0', max: '104', unit: 'cm' } }).map((issue) => issue.path)).toEqual(['bodyMeasures/chest/min'])
    expect(bodyMeasuresProblems({ chest: { min: '106', max: '104', unit: 'cm' } })).toEqual([{ path: 'bodyMeasures/chest/max', message: 'The largest value is at least the smallest.' }])
    expect(bodyMeasuresProblems({ chest: { min: '100.123', max: null, unit: 'cm' } }).map((issue) => issue.path)).toEqual(['bodyMeasures/chest/min'])
    expect(bodyMeasuresProblems({ chest: { min: '100', max: null, unit: 'ft' as 'cm' } }).map((issue) => issue.path)).toEqual(['bodyMeasures/chest/unit'])
  })

  it('keeps one unit per measurement point across the scale', () => {
    const sizes = [
      normaliseSize({ code: '50', bodyMeasures: { chest: { min: '100', max: '104', unit: 'cm' } } }),
      normaliseSize({ code: '52', bodyMeasures: { chest: { min: '41', max: '43', unit: 'in' } } }),
    ]
    expect(measureUnitProblems(sizes)).toEqual([{ path: 'sizes/1/bodyMeasures/chest/unit', message: 'The scale measures chest in cm: use cm in every size.' }])
    expect(measureUnitsOf(sizes)).toEqual({ chest: 'cm' })
    expect(measureUnitProblems([sizes[1]!], { chest: 'cm' }, 'sizes/')).toHaveLength(1)
  })

  it('lists sizes once each, also against the sizes a scale has', () => {
    const list = ['46', '48', '46'].map((code) => normaliseSize({ code }))
    expect(sizeListProblems(list)).toEqual([{ path: 'sizes/2/code', message: 'The scale has size 46 already.' }])
    expect(sizeListProblems([normaliseSize({ code: '60' })], { taken: ['58', '60'] })).toEqual([{ path: 'sizes/0/code', message: 'The scale has size 60 already.' }])
    expect(sizeListProblems([])).toEqual([{ path: 'sizes', message: 'Give at least one size.' }])
    expect(sizeListProblems([normaliseSize({ code: '1' })], { taken: Array.from({ length: 60 }, (_, index) => String(index + 2)) })[0]!.message).toBe('A scale has at most 60 sizes.')
  })
})

describe('a size scale (PRD-047)', () => {
  it('has a code and a name', () => {
    expect(scaleProblems({ code: 'EU-46-58', name: 'EU 46-58' })).toEqual([])
    expect(scaleProblems({ code: 'eu 46', name: '' }).map((issue) => issue.path)).toEqual(['code', 'name'])
  })

  it('archives and restores scales and sizes, never deletes them (PRD-022)', () => {
    for (const machine of [sizeScaleMachine, sizeMachine]) {
      expect(canTransition(machine, 'ACTIVE', 'ARCHIVED').ok).toBe(true)
      expect(canTransition(machine, 'ARCHIVED', 'ACTIVE').ok).toBe(true)
    }
  })

  it('orders sizes by their place, and puts added sizes before a size or at the end', () => {
    expect(scaleOrder([{ code: 'L', seq: 3 }, { code: 'S', seq: 1 }, { code: 'M', seq: 2 }])).toEqual(['S', 'M', 'L'])
    expect(insertSizes(EU, ['60', '62'])).toEqual({ ok: true, order: ['46', '48', '50', '52', '54', '56', '58', '60', '62'] })
    expect(insertSizes(EU, ['44'], '46')).toEqual({ ok: true, order: ['44', '46', '48', '50', '52', '54', '56', '58'] })
    expect(insertSizes(EU, ['44'], '45')).toEqual({ ok: false, issues: [{ path: 'before', message: 'The scale has no size 45.' }] })
    expect([...sequenceOf(['S', 'M']).entries()]).toEqual([['S', 1], ['M', 2]])
    expect(inScaleOrder(['54', '46', '50'], EU)).toEqual(['46', '50', '54'])
  })

  it('reorders only with every size once', () => {
    expect(reorderProblems(['S', 'M', 'L'], ['L', 'M', 'S'])).toEqual([])
    expect(reorderProblems(['S', 'M', 'L'], ['S', 'S', 'XL'])).toEqual([
      { path: 'codes/1', message: 'Size S is listed twice.' },
      { path: 'codes/2', message: 'The scale has no size XL.' },
      { path: 'codes', message: 'List every size of the scale once; missing: M, L.' },
    ])
  })

  it('never changes the code of a size in use', () => {
    expect(sizeCodeChangeRefusal('52', new Set(['52']))).toMatch(/^Size 52 is in use/)
    expect(sizeCodeChangeRefusal('60', new Set(['52']))).toBeNull()
  })
})

describe('the size scale contracts', () => {
  it('upper-cases codes and refuses unknown keys', () => {
    expect(createScaleBody.parse({ code: 'eu-46-58', name: 'EU', sizes: [{ code: 'xl' }] })).toEqual({ code: 'EU-46-58', name: 'EU', sizes: [{ code: 'XL' }] })
    expect(sizeBody.safeParse({ code: '52', colour: 'x' }).success).toBe(false)
    expect(sizeBody.safeParse({ code: '52', bodyMeasures: { chest: { min: '100,5', max: null, unit: 'cm' } } }).success).toBe(false)
    expect(addSizesBody.safeParse({ version: 1, sizes: [] }).success).toBe(false)
  })

  it('answers a scale with its sizes', () => {
    const parsed = scaleView.parse({
      id: '0190a2b4-0000-7000-8000-000000000001',
      companyId: null,
      code: 'EU',
      name: 'EU',
      codes: ['50'],
      styleCount: 0,
      status: 'ACTIVE',
      version: 1,
      updatedAt: '2026-10-28T10:00:00.000Z',
      sizes: [{ id: '0190a2b4-0000-7000-8000-000000000002', code: '50', label: null, seq: 1, bodyMeasures: null, status: 'ACTIVE', version: 1, inUse: false, extra: 1 }],
      measureUnits: {},
      createdAt: '2026-10-28T10:00:00.000Z',
      createdById: null,
    })
    expect(parsed.sizes[0]).not.toHaveProperty('extra')
  })
})
