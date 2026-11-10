import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { createPrepackBody, updatePrepackBody } from './contracts'
import { PRODUCT_PREPACKS_MANAGE } from './permissions'
import { bySize, codeProblems, linePlan, linesProblems, nameProblems, outsideRange, piecesOf, prepackWords, ratioText, type PrepackContext } from './rules'

const RANGE = ['50', '52', '54']
const BLK = '0190f0e2-0000-7000-8000-000000000001'
const RED = '0190f0e2-0000-7000-8000-000000000002'
const OLD = '0190f0e2-0000-7000-8000-000000000003'
const STYLE: PrepackContext = {
  scope: 'STYLE',
  sizes: RANGE,
  sizesOf: "the style's sizes",
  colourways: [
    { id: BLK, code: 'BLK', status: 'ACTIVE' },
    { id: RED, code: 'RED', status: 'ACTIVE' },
    { id: OLD, code: 'OLD', status: 'ARCHIVED' },
  ],
}
const SCALE: PrepackContext = { scope: 'SCALE', sizes: ['48', '50', '52', '54', '56'], sizesOf: 'the sizes of scale EU', colourways: [] }
const line = (size: string, quantity: number, colourwayId: string | null = null) => ({ size, quantity, colourwayId })

describe('prepack lines (PRD-055)', () => {
  it('takes sizes of the range with whole pieces, per size or per colourway', () => {
    expect(linesProblems([line('50', 2), line('52', 3), line('54', 2)], STYLE)).toEqual([])
    expect(linesProblems([line('52', 2, BLK), line('52', 1, RED)], STYLE)).toEqual([])
    expect(linesProblems([line('48', 1), line('56', 1)], SCALE)).toEqual([])
  })

  it('refuses in words: no line, a size outside, a bad quantity, a colourway on a scale pack, twice, both ways', () => {
    expect(linesProblems([], STYLE)).toEqual([{ path: 'lines', message: 'A prepack has at least one size with its pieces.' }])
    expect(linesProblems([line('56', 1)], STYLE)).toEqual([{ path: 'lines/0/size', message: "Size 56 is not one of the style's sizes (50, 52, 54)." }])
    expect(linesProblems([line('50', 0)], STYLE)[0]!.path).toBe('lines/0/quantity')
    expect(linesProblems([line('50', 10_001)], STYLE)[0]!.message).toBe('Size 50 has 1 to 10,000 pieces, a whole number.')
    expect(linesProblems([line('50', 1, BLK)], SCALE)[0]!.path).toBe('lines/0/colourwayId')
    expect(linesProblems([line('50', 1), line('50', 2)], STYLE)).toEqual([{ path: 'lines/1/size', message: 'Size 50 is given twice.' }])
    expect(linesProblems([line('52', 1), line('52', 1, RED)], STYLE)).toEqual([{ path: 'lines/1/colourwayId', message: 'Size 52 is given both for any colourway and per colourway: give it one way.' }])
    expect(linesProblems([line('52', 1, OLD)], STYLE)[0]!.message).toBe('Colourway OLD is archived: a new line names an active colourway.')
    expect(linesProblems([line('52', 1, 'not-a-colourway')], STYLE)[0]!.message).toBe("The colourway of size 52 is not one of the style's.")
  })

  it('lets a kept line keep a size that left the range or an archived colourway', () => {
    const existing = [line('48', 1), line('52', 1, OLD)]
    expect(linesProblems([line('48', 2), line('52', 3, OLD)], { ...STYLE, existing })).toEqual([])
  })

  it('counts pieces, per size, the ratio and what the style is not made in', () => {
    const lines = [line('52', 3), line('50', 2), line('54', 2)]
    expect(piecesOf(lines)).toBe(7)
    expect(bySize(lines, RANGE)).toEqual([{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }, { size: '54', quantity: 2 }])
    expect(ratioText(lines, RANGE)).toBe('2-3-2')
    expect(ratioText([line('50', 2), line('54', 2)], RANGE)).toBe('2-0-2')
    expect(ratioText([line('52', 2, BLK), line('52', 1, RED)], RANGE)).toBe('3')
    expect(ratioText([line('48', 1), line('50', 2), line('52', 3), line('54', 2), line('56', 1)], SCALE.sizes)).toBe('1-2-3-2-1')
    expect(outsideRange([line('48', 1), line('50', 2), line('56', 1)], RANGE)).toEqual(['48', '56'])
    expect(prepackWords([line('52', 2), line('50', 1)], RANGE)).toBe('3 pieces per pack: 50 ×1, 52 ×2')
    expect(prepackWords([line('48', 1)], RANGE, ['48'])).toBe('1 piece per pack: 48 ×1 · not for this style: it is not made in 48')
  })

  it('plans a new list of lines against the old one by size and colourway', () => {
    const existing = [{ ...line('50', 2), id: 'a' }, { ...line('52', 3), id: 'b' }, { ...line('54', 2), id: 'c' }]
    const plan = linePlan(existing, [line('50', 2), line('52', 4), line('52', 1, RED)])
    expect(plan.changed).toEqual([{ from: existing[1], quantity: 4 }])
    expect(plan.added).toEqual([line('52', 1, RED)])
    expect(plan.removed).toEqual([existing[2]])
  })

  it('checks the code and the name', () => {
    expect(codeProblems('PP-7')).toEqual([])
    expect(codeProblems('PP 7')[0]!.path).toBe('code')
    expect(nameProblems('Pack of seven')).toEqual([])
    expect(nameProblems('   ')[0]!.path).toBe('name')
  })

  it('accepts and refuses bodies; a new prepack is of the style unless said', () => {
    expect(createPrepackBody.parse({ code: 'PP-7', name: 'Pack', lines: [{ size: '50', quantity: 2 }] })).toEqual({ scope: 'STYLE', code: 'PP-7', name: 'Pack', lines: [{ size: '50', quantity: 2, colourwayId: null }] })
    expect(createPrepackBody.safeParse({ code: 'PP-7', name: 'Pack', lines: [] }).success).toBe(false)
    expect(updatePrepackBody.safeParse({ version: 1, lines: [{ size: '50', quantity: 0 }] }).success).toBe(false)
    expect(updatePrepackBody.safeParse({ version: 2, name: 'Renamed' }).success).toBe(true)
  })
})

describe('who keeps prepacks, and the event', () => {
  it('declares product.prepacks.manage for sales and the production manager', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PRODUCT_PREPACKS_MANAGE)).toBe(true)
    expect(templateOf('sales')?.permissions).toContain(PRODUCT_PREPACKS_MANAGE)
    expect(templateOf('production_manager')?.permissions).toContain(PRODUCT_PREPACKS_MANAGE)
    expect(templateOf('planner')?.permissions).not.toContain(PRODUCT_PREPACKS_MANAGE)
    expect(templateOf('owner')?.permissions).toContain(PRODUCT_PREPACKS_MANAGE)
  })

  it('declares prepack.changed and style.protectors_changed', () => {
    const types = EVENT_DEFINITIONS.map((event) => event.type)
    expect(types).toContain('prepack.changed')
    expect(types).toContain('style.protectors_changed')
  })
})
