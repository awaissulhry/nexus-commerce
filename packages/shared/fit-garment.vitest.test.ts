import { describe, expect, it } from 'vitest'
import { FitGarmentError, fitGarmentProblems, fitGarmentSummary, fitNumber, normalizeFitGarment, readFitGarment } from './fit-garment.js'

const table = (extra: Record<string, unknown> = {}) => ({
  measures: ['chest', 'waist', 'sleeve'],
  sizes: [{ name: 'M', chest: 106, waist: 94, sleeve: 62.5 }, { name: 'L', chest: 112, waist: 100, sleeve: 64 }],
  ...extra,
})
const problemsOf = (input: unknown) => fitGarmentProblems(input)

describe('normalizeFitGarment — the canonical shape', () => {
  it('keeps a sound table exactly, in the canonical key order', () => {
    const value = normalizeFitGarment(table({ flat: ['chest'], room: { chest: [6, 16] } }))
    expect(value).toEqual({
      measures: ['chest', 'waist', 'sleeve'],
      sizes: [{ name: 'M', chest: 106, waist: 94, sleeve: 62.5 }, { name: 'L', chest: 112, waist: 100, sleeve: 64 }],
      flat: ['chest'],
      room: { chest: [6, 16] },
    })
    expect(JSON.stringify(normalizeFitGarment({ sizes: [{ sleeve: 60, chest: 100, name: 'S' }], measures: ['chest', 'sleeve'] })))
      .toBe('{"measures":["chest","sleeve"],"sizes":[{"name":"S","chest":100,"sleeve":60}]}')
  })

  it('clears: null, an empty string, no rows, rows with no values', () => {
    expect(normalizeFitGarment(null)).toBeNull()
    expect(normalizeFitGarment(undefined)).toBeNull()
    expect(normalizeFitGarment('')).toBeNull()
    expect(normalizeFitGarment({})).toBeNull()
    expect(normalizeFitGarment({ measures: ['chest'], sizes: [] })).toBeNull()
    expect(normalizeFitGarment({ measures: ['chest'], sizes: [{ name: 'M' }, { name: 'L', chest: '' }, { name: '', chest: null }] })).toBeNull()
  })

  it('drops a row with no values, a measure no size has, and their flat and room entries; trims names', () => {
    expect(normalizeFitGarment({
      measures: ['chest', 'hips', 'waist'],
      sizes: [{ name: ' M ', chest: 106 }, { name: 'L' }, { name: '', waist: '' }],
      flat: ['chest', 'hips'],
      room: { hips: [2, 8], waist: [1, 5] },
    })).toEqual({ measures: ['chest'], sizes: [{ name: 'M', chest: 106 }], flat: ['chest'] })
  })

  it('takes numbers as text, with a decimal comma or point, and a JSON string', () => {
    expect(normalizeFitGarment({ measures: ['sleeve'], sizes: [{ name: 'M', sleeve: '62,5' }, { name: 'L', sleeve: ' 64.0 ' }] }))
      .toEqual({ measures: ['sleeve'], sizes: [{ name: 'M', sleeve: 62.5 }, { name: 'L', sleeve: 64 }] })
    expect(normalizeFitGarment(JSON.stringify(table()))).toEqual(table())
    expect(normalizeFitGarment({ measures: ['chest'], sizes: [{ name: 'M', chest: 100 }], room: { chest: ['-2,5', '10'] } }))
      .toEqual({ measures: ['chest'], sizes: [{ name: 'M', chest: 100 }], room: { chest: [-2.5, 10] } })
  })

  it('throws a FitGarmentError with every problem', () => {
    let caught: unknown
    try { normalizeFitGarment({ measures: ['chest', 'shoulder'], sizes: [{ name: 'M', chest: 0 }] }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(FitGarmentError)
    expect((caught as FitGarmentError).problems).toHaveLength(2)
    expect((caught as FitGarmentError).message).toContain('"shoulder" is not a measure')
  })
})

describe('fitGarmentProblems — what cannot be saved', () => {
  it('a sound table has none', () => {
    expect(problemsOf(table())).toEqual([])
    expect(problemsOf(null)).toEqual([])
  })

  it('refuses what is not a table', () => {
    expect(problemsOf([1, 2])[0]).toContain('table of sizes and measures')
    expect(problemsOf('not json')[0]).toContain('table of sizes and measures')
    expect(problemsOf(42)[0]).toContain('table of sizes and measures')
    expect(problemsOf(table({ colour: 'red' }))[0]).toContain('"colour" is not part')
    expect(problemsOf({ measures: 'chest', sizes: [] })[0]).toContain('measures must be a list')
    expect(problemsOf({ measures: ['chest'], sizes: { M: 1 } })[0]).toContain('sizes must be a list')
    expect(problemsOf({ measures: ['chest'], sizes: ['M'] })[0]).toContain('Row 1 is not a size row')
  })

  it('measures: only the eight known keys, each once; a value only under a listed measure', () => {
    expect(problemsOf({ measures: ['chest', 'shoulder'], sizes: [{ name: 'M', chest: 100 }] })).toEqual([expect.stringContaining('"shoulder" is not a measure')])
    expect(problemsOf({ measures: ['chest', 'chest'], sizes: [{ name: 'M', chest: 100 }] })).toEqual(['Chest is listed twice.'])
    expect(problemsOf({ measures: ['chest'], sizes: [{ name: 'M', chest: 100, hips: 90 }] })).toEqual(['Size M has a value for Hips, which is not one of the measures.'])
    expect(problemsOf({ measures: ['chest'], sizes: [{ name: 'M', chest: 100, collar: 40 }] })).toEqual(['Size M: "collar" is not a measure Nexus knows.'])
  })

  it('values: a number of cm above 0, at most 250, at most one decimal', () => {
    const one = (chest: unknown) => problemsOf({ measures: ['chest'], sizes: [{ name: 'M', chest }] })
    expect(one(0)).toEqual(['Size M, Chest: 0 cm must be above 0 and at most 250.'])
    expect(one(-3)).toHaveLength(1)
    expect(one(250)).toEqual([])
    expect(one(250.1)).toHaveLength(1)
    expect(one(62.55)).toEqual(['Size M, Chest: 62.55 cm may have at most one decimal.'])
    expect(one('abc')).toEqual(['Size M, Chest: "abc" is not a number.'])
    expect(one('12cm')).toHaveLength(1)
    expect(one(true)).toHaveLength(1)
    expect(one(Number.NaN)).toHaveLength(1)
    expect(one(0.1)).toEqual([])
  })

  it('sizes: a name for every row with values, at most 12 characters, unique ignoring case, 1 to 30 rows', () => {
    expect(problemsOf({ measures: ['chest'], sizes: [{ name: '', chest: 100 }] })).toEqual(['Row 1 has measurements but no size name.'])
    expect(problemsOf({ measures: ['chest'], sizes: [{ name: 'Extra extra large', chest: 100 }] })).toEqual(['Size "Extra extra large" is longer than 12 characters.'])
    expect(problemsOf({ measures: ['chest'], sizes: [{ name: 'xl', chest: 100 }, { name: 'XL', chest: 110 }] })).toEqual(['Sizes xl and XL are the same size name.'])
    expect(problemsOf({ measures: ['chest'], sizes: [{ name: 'M', chest: 100 }, { name: 'M', chest: 110 }] })).toEqual(['Size M is listed twice.'])
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i + 1}`, chest: 80 + i }))
    expect(problemsOf({ measures: ['chest'], sizes: rows(30) })).toEqual([])
    expect(problemsOf({ measures: ['chest'], sizes: rows(31) })).toEqual(['A table holds at most 30 sizes; this one has 31.'])
    // An empty row does not count towards the 30.
    expect(problemsOf({ measures: ['chest'], sizes: [...rows(30), { name: 'Spare' }] })).toEqual([])
  })

  it('flat: circumferences among the measures only', () => {
    expect(problemsOf(table({ flat: ['sleeve'] }))).toEqual(['Sleeve length is a length, not a width round the body: it cannot be measured flat.'])
    expect(problemsOf(table({ flat: ['hips'] }))).toEqual(['Hips is measured flat but is not one of the measures.'])
    expect(problemsOf(table({ flat: ['belly'] }))[0]).toContain('"belly" is not a measure')
    expect(problemsOf(table({ flat: 'chest' }))).toEqual(['The flat measures must be a list.'])
    expect(normalizeFitGarment(table({ flat: ['chest', 'chest', 'waist'] }))?.flat).toEqual(['chest', 'waist'])
    expect(normalizeFitGarment(table({ flat: [] }))).not.toHaveProperty('flat')
  })

  it('room: [least, most], least below most, −20 to 60, for a listed measure', () => {
    expect(problemsOf(table({ room: { chest: [6, 16], waist: [-20, 60] } }))).toEqual([])
    expect(problemsOf(table({ room: { chest: [16, 6] } }))).toEqual(['Chest: the least room (16) must be below the most (6).'])
    expect(problemsOf(table({ room: { chest: [6, 6] } }))).toHaveLength(1)
    expect(problemsOf(table({ room: { chest: [-21, 6] } }))).toEqual(['Chest: the room for a good fit must be from -20 to 60 cm.'])
    expect(problemsOf(table({ room: { chest: [6, 61] } }))).toHaveLength(1)
    expect(problemsOf(table({ room: { chest: [6] } }))).toEqual(['Chest: the room for a good fit is a least and a most.'])
    expect(problemsOf(table({ room: { chest: [6, ''] } }))).toEqual(['Chest: give both the least and the most room, or neither.'])
    expect(problemsOf(table({ room: { hips: [1, 2] } }))).toEqual(['Hips has room for a good fit but is not one of the measures.'])
    expect(problemsOf(table({ room: [[6, 16]] }))).toEqual(['The room for a good fit must give a least and a most per measure.'])
    expect(normalizeFitGarment(table({ room: { chest: ['', null] } }))).not.toHaveProperty('room')
  })
})

describe('the helpers', () => {
  it('fitNumber reads a number or its text; empty is undefined; anything else NaN', () => {
    expect(fitNumber('62,5')).toBe(62.5)
    expect(fitNumber(' 64 ')).toBe(64)
    expect(fitNumber('')).toBeUndefined()
    expect(fitNumber(null)).toBeUndefined()
    expect(fitNumber('6 2')).toBeNaN()
    expect(fitNumber({})).toBeNaN()
  })

  it('fitGarmentSummary: the cell words, or nothing', () => {
    expect(fitGarmentSummary(table())).toBe('2 sizes · chest, waist, sleeve length')
    expect(fitGarmentSummary({ measures: ['inseam'], sizes: [{ name: '48', inseam: 80 }] })).toBe('1 size · inside leg')
    expect(fitGarmentSummary(null)).toBe('')
    expect(fitGarmentSummary({ measures: ['chest'], sizes: [{ name: 'M', chest: -1 }] })).toBe('')
  })

  it('readFitGarment returns the value and the problems together', () => {
    expect(readFitGarment(table())).toEqual({ value: table(), problems: [] })
    expect(readFitGarment({ measures: ['x'] }).value).toBeNull()
  })
})
