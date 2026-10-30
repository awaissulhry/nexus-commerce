import { describe, expect, it } from 'vitest'
import type { BomLineData } from '../bom/rules'
import type { StepData } from '../routing/rules'
import { copiedFields, copiedRange, copyBomLines, copyNote, copyRoutingSteps, needsRevision, PART_NOT_YET, sourceRevisionOf } from './copy'
import { customsMissing, customsProblems, hsCodeProblem, normaliseCustoms } from './customs'
import { changeStyle, newStyle, type ScaleSizes, type StyleFields } from './rules'

/** Made-up styles, sizes and ids; nothing here is a real product or code list beyond ISO 3166-1. */
const SCALE: ScaleSizes = [
  { code: '48', seq: 1, status: 'ACTIVE' },
  { code: '50', seq: 2, status: 'ACTIVE' },
  { code: '52', seq: 3, status: 'ACTIVE' },
  { code: '54', seq: 4, status: 'ARCHIVED' },
]
const id = (n: number) => `0195f5d0-0000-7000-8000-${String(n).padStart(12, '0')}`

const style = (more: Partial<StyleFields> = {}): StyleFields => {
  const outcome = newStyle({ code: 'GT-01', name: 'Giacca', productType: 'JACKET', sizeScaleId: id(1), sizes: ['48', '50', '52'], baseSize: '50', ...more }, SCALE)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome.style
}

describe('customs and origin data (PRD-018)', () => {
  it('keeps a commodity code typed with dots or spaces as digits, the origin in capitals, the mass without trailing zeros', () => {
    expect(normaliseCustoms({ hsCode: '4203.10 00', originCountry: ' it ', netMassKg: '1.850' })).toEqual({ hsCode: '42031000', originCountry: 'IT', netMassKg: '1.85' })
    const made = style({ hsCode: '4203 10 00', originCountry: 'it', netMassKg: '1.850' })
    expect(made).toMatchObject({ hsCode: '42031000', originCountry: 'IT', netMassKg: '1.85' })
  })

  it('takes HS 6, CN 8 and TARIC 10 digits of a real chapter; refuses other lengths, chapter 77 and 00', () => {
    expect(hsCodeProblem('420310')).toBeNull()
    expect(hsCodeProblem('42031000')).toBeNull()
    expect(hsCodeProblem('6203431900')).toBeNull()
    expect(hsCodeProblem('4203100')).toMatch(/6 \(HS\), 8 \(CN\) or 10 \(TARIC\)/)
    expect(hsCodeProblem('77010000')).toMatch(/Chapter 77/)
    expect(hsCodeProblem('00123456')).toMatch(/Chapter 00/)
  })

  it('refuses EU as an origin, an unknown country, a mass of 0 or with 4 decimals', () => {
    expect(customsProblems({ hsCode: null, originCountry: 'EU', netMassKg: null })).toEqual([{ path: 'originCountry', message: 'Name the country of origin (ISO 3166-1, like IT), not the EU.' }])
    expect(customsProblems({ hsCode: null, originCountry: 'QQ', netMassKg: '0' }).map((issue) => issue.path)).toEqual(['originCountry', 'netMassKg'])
    expect(customsProblems({ hsCode: null, originCountry: null, netMassKg: '1.2345' })[0]?.message).toMatch(/3 decimals/)
    expect(newStyle({ code: 'GT-02', name: 'X', productType: 'JACKET', sizeScaleId: id(1), hsCode: '12' }, SCALE)).toMatchObject({ ok: false, issues: [{ path: 'hsCode' }] })
  })

  it('a change names the customs fields it moved; null clears one; what is missing is listed', () => {
    const current = style({ hsCode: '42031000' })
    const change = changeStyle(current, { originCountry: 'IT', netMassKg: '2', hsCode: null }, SCALE)
    expect(change).toMatchObject({ ok: true, changed: ['hsCode', 'originCountry', 'netMassKg'] })
    if (!change.ok) return
    expect(customsMissing(change.style)).toEqual(['hsCode'])
    expect(changeStyle(current, { netMassKg: '2.000' }, SCALE)).toMatchObject({ ok: true, style: { netMassKg: '2' } })
  })
})

describe('copying a style (PRD-011)', () => {
  const revisions = [
    { id: id(11), revision: 1, status: 'OBSOLETE' },
    { id: id(12), revision: 2, status: 'RELEASED' },
    { id: id(13), revision: 3, status: 'DRAFT' },
  ]

  it('takes the parts from the revision named, else the released one, else the newest', () => {
    expect(sourceRevisionOf(revisions)?.revision).toBe(2)
    expect(sourceRevisionOf(revisions.filter((entry) => entry.status !== 'RELEASED'))?.revision).toBe(3)
    expect(sourceRevisionOf(revisions, id(11))?.revision).toBe(1)
    expect(sourceRevisionOf(revisions, id(99))).toBeNull()
    expect(sourceRevisionOf([])).toBeNull()
  })

  it('leaves a size archived in the scale out of the range (and the base size with it), and says which', () => {
    expect(copiedRange({ sizes: ['50', '52', '54'], baseSize: '54' }, SCALE)).toEqual({ sizes: ['50', '52'], baseSize: null, dropped: ['54'] })
    expect(copiedRange({ sizes: ['48', '50'], baseSize: '50' }, SCALE)).toEqual({ sizes: ['48', '50'], baseSize: '50', dropped: [] })
  })

  it('keeps the identity, takes the new code and name, and the made-to-measure set-up only with MEASUREMENTS', () => {
    const source = style({ season: 'FW27', mtmAllowed: true, measurementTemplateId: id(5), hsCode: '42031000', originCountry: 'IT', nameI18n: { it: 'Giacca' } })
    const range = { sizes: ['48', '50'], baseSize: '50' }
    const plain = copiedFields(source, { code: 'GT-01-B', name: 'Giacca B' }, [], range)
    expect(plain).toMatchObject({ code: 'GT-01-B', name: 'Giacca B', nameI18n: null, season: 'FW27', sizes: ['48', '50'], mtmAllowed: false, measurementTemplateId: null, hsCode: '42031000', originCountry: 'IT' })
    expect(copiedFields(source, { code: 'GT-01-C', name: 'C', season: null }, ['MEASUREMENTS'], range)).toMatchObject({ season: null, mtmAllowed: true, measurementTemplateId: id(5) })
    expect(needsRevision(['MEASUREMENTS'])).toBe(false)
    expect(needsRevision(['LABELS'])).toBe(true)
    expect(PART_NOT_YET.PICTURES).toMatch(/W2b/)
    expect(PART_NOT_YET.BOM).toBeUndefined()
  })

  it('copies BOM lines under new ids onto the copy colourways, sizes in the range only, a line of an unmapped colourway left out', () => {
    const line = (n: number, more: Partial<BomLineData>): BomLineData => ({
      id: id(100 + n), seq: n * 10, itemId: id(200), placement: null, qty: '1', uom: 'PCS', wastagePct: '0', sizeDependent: false, colourDependent: false,
      itemColourId: null, colourwayId: null, supplierId: null, note: null, sizes: [], colours: [], ...more,
    })
    const lines = [
      line(2, { sizeDependent: true, sizes: [{ size: '50', qty: '43' }, { size: '54', qty: '47' }] }),
      line(1, { colourDependent: true, colours: [{ colourwayId: id(31), itemColourId: id(41) }, { colourwayId: id(32), itemColourId: id(42) }] }),
      line(3, { colourwayId: id(32) }),
    ]
    let next = 500
    const copied = copyBomLines(lines, new Map([[id(31), id(61)]]), ['48', '50', '52'], () => id(next++))
    expect(copied.dropped).toBe(1)
    expect(copied.lines.map((entry) => [entry.seq, entry.id])).toEqual([[10, id(500)], [20, id(501)]])
    expect(copied.lines[0]!.colours).toEqual([{ colourwayId: id(61), itemColourId: id(41) }])
    expect(copied.lines[1]!.sizes).toEqual([{ size: '50', qty: '43' }])
  })

  it('copies routing steps under new ids with their subcontract details', () => {
    const step = (n: number): StepData => ({ id: id(700 + n), seq: n * 10, operationId: id(800), code: `OP-${n}`, name: 'Op', nameI18n: { it: 'Op' }, workCentreKind: 'SEWING', standardMinutes: '4.2', scanRequired: true, instructions: null })
    let next = 900
    const copied = copyRoutingSteps([step(2), step(1)], new Map([[id(702), { supplierId: id(3), pricePerPiece: '4.5', transitDays: 6 }]]), () => id(next++))
    expect(copied.map((entry) => [entry.step.seq, entry.step.id, entry.subcontract?.transitDays ?? null])).toEqual([[10, id(900), null], [20, id(901), 6]])
  })

  it('notes where the copy came from', () => {
    expect(copyNote({ code: 'GT-01' }, { revision: 2 })).toBe('Copied from GT-01 revision 2.')
    expect(copyNote({ code: 'GT-01' }, null)).toBe('Copied from GT-01.')
    expect(copyNote({ code: 'GT-01' }, { revision: 2 }, 'Spring version')).toBe('Spring version')
  })
})
