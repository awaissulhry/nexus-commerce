import { describe, expect, it } from 'vitest'
import { measureMail } from './mail'
import {
  centimetresOf,
  decimalOf,
  formProblems,
  hintsOf,
  hundredthsOf,
  kilogramsOf,
  lengthIn,
  photosDeleteAfterFor,
  pointsByZone,
  profileValuesOf,
  walkOrder,
  zoneOf,
  type MeasureForm,
  type MeasurePoint,
} from './rules'

const point = (code: string, seq: number, extra: Partial<MeasurePoint> = {}): MeasurePoint => ({ code, name: code[0]!.toUpperCase() + code.slice(1), seq, required: true, minCm: null, maxCm: null, howTo: null, ...extra })
const POINTS = [point('chest', 1, { minCm: '70.00', maxCm: '150.00' }), point('waist', 2), point('sleeve', 3, { minCm: '50.00', maxCm: '80.00' }), point('inside_leg', 4, { required: false }), point('riding_reach', 5, { required: false })]

const form = (patch: Partial<MeasureForm> = {}): MeasureForm => ({
  units: 'cm',
  basics: { height: '178', weight: '74', age: '34' },
  values: { chest: '101', waist: '85', sleeve: '65' },
  fit: { fit: 'SNUG', posture: '', asymmetry: '' },
  photos: {},
  ...patch,
})

describe('numbers (decimal strings, never floats)', () => {
  it('reads a typed decimal with a dot or a comma, at most two decimals', () => {
    expect(hundredthsOf('61.5')).toBe(6150)
    expect(hundredthsOf('61,25')).toBe(6125)
    expect(hundredthsOf(' 178 ')).toBe(17800)
    expect(hundredthsOf('61.555')).toBeNull()
    expect(hundredthsOf('abc')).toBeNull()
    expect(hundredthsOf('-3')).toBeNull()
  })
  it('converts inches exactly and pounds to two decimals', () => {
    expect(centimetresOf('40.5', 'in')).toBe(10287)
    expect(decimalOf(10287)).toBe('102.87')
    expect(decimalOf(6100)).toBe('61')
    expect(kilogramsOf('163', 'in')).toBe(7394)
    expect(lengthIn(10287, 'in')).toBe('40.5')
  })
})

describe('zones and order', () => {
  it('groups the points by body zone from their codes, others last', () => {
    expect(zoneOf('Inside-leg')).toBe('LEGS')
    expect(zoneOf('riding_knee')).toBe('RIDING')
    expect(zoneOf('collar_x')).toBe('OTHER')
    expect(pointsByZone(POINTS).map((group) => [group.zone, group.points.map((p) => p.code)])).toEqual([
      ['UPPER', ['chest', 'waist']],
      ['ARMS', ['sleeve']],
      ['LEGS', ['inside_leg']],
      ['RIDING', ['riding_reach']],
    ])
    expect(walkOrder(POINTS).map((p) => p.code)).toEqual(['chest', 'waist', 'sleeve', 'inside_leg', 'riding_reach'])
  })
})

describe('the checks', () => {
  it('passes a complete form; optional points and photos may stay empty', () => {
    expect(formProblems(form(), POINTS, 'OPTIONAL')).toEqual([])
  })
  it('names each field that needs something, in the order of the page', () => {
    const problems = formProblems(form({ basics: { height: '', weight: 'x', age: '7' }, values: { chest: '101', waist: '0.5', sleeve: '' } }), POINTS, 'REQUIRED')
    expect(problems.map((p) => `${p.path} ${p.code}`)).toEqual([
      'body/basics/height REQUIRED',
      'body/basics/weight NOT_A_NUMBER',
      'body/basics/age OUT_OF_LIMITS',
      'body/values/waist OUT_OF_LIMITS',
      'body/values/sleeve REQUIRED',
      'body/photos/FRONT PHOTO_REQUIRED',
      'body/photos/SIDE PHOTO_REQUIRED',
      'body/photos/BACK PHOTO_REQUIRED',
    ])
  })
  it('refuses a value for a point the form does not have, and one photo used twice', () => {
    const problems = formProblems(form({ values: { chest: '101', waist: '85', sleeve: '65', neck: '40' }, photos: { FRONT: 'a', SIDE: 'a', BACK: 'b' } }), POINTS, 'OPTIONAL')
    expect(problems.map((p) => `${p.path} ${p.code}`)).toEqual(['body/values/neck UNKNOWN_POINT', 'body/photos/SIDE SAME_PHOTO'])
  })
})

describe('hints never block', () => {
  it('says a value outside the range, and a girth out of proportion to the height', () => {
    const hints = hintsOf(form({ basics: { height: '172', weight: '74', age: '34' }, values: { chest: '140', waist: '85', sleeve: '45' } }), POINTS)
    expect(hints).toEqual([
      { code: 'chest', kind: 'FOR_HEIGHT', valueCm: 14000, boundCm: 17200 },
      { code: 'sleeve', kind: 'BELOW_RANGE', valueCm: 4500, boundCm: 5000 },
    ])
    expect(formProblems(form({ values: { chest: '140', waist: '85', sleeve: '45' } }), POINTS, 'OPTIONAL')).toEqual([])
  })
})

describe('what lands in the profile', () => {
  it('keeps centimetres and kilograms, the height and weight beside the points, and the fit notes in words', () => {
    const values = profileValuesOf(form({ units: 'in', basics: { height: '70', weight: '163', age: '34' }, values: { chest: '40.5', waist: '33', sleeve: '25.5' }, fit: { fit: 'REGULAR', posture: 'Leans forward.', asymmetry: '' } }), POINTS)
    expect(values.measurements).toEqual({ chest: { value: '102.87', unit: 'cm' }, waist: { value: '83.82', unit: 'cm' }, sleeve: { value: '64.77', unit: 'cm' }, height: { value: '177.8', unit: 'cm' }, weight: { value: '73.94', unit: 'kg' } })
    expect(values.fitNotes).toBe('Fit: regular.\nAge: 34.\nTyped in inches and pounds (kept in cm and kg).\nPosture and riding: Leans forward.')
  })
  it('deletes the photos 90 days after the garment ships', () => {
    expect(photosDeleteAfterFor(new Date('2026-11-01T10:00:00.000Z')).toISOString()).toBe('2027-01-30T10:00:00.000Z')
  })
})

describe('the mail', () => {
  it('names the sender, the garment and the day, in the rider language, and holds the link only where given', () => {
    const mail = measureMail('it', { companyName: 'Esempio Srl', riderName: 'Marco', garment: 'la giacca', expiresAt: new Date('2026-11-30T23:00:00.000Z'), photos: true }, 'https://example.test/l#token=x')
    expect(mail.subject).toBe('Le misure per la giacca — Esempio Srl')
    expect(mail.body).toContain('30/11/2026')
    expect(mail.body).toContain('https://example.test/l#token=x')
    expect(measureMail('en', { companyName: 'Example Ltd', riderName: 'Marco', garment: 'the jacket', expiresAt: new Date('2026-11-30T23:00:00.000Z'), photos: false }, '').body).not.toContain('photos')
  })

  it('names the last day the link works in Rome, not in UTC (B-W2b-F35)', () => {
    const until = (expiresAt: string, locale: 'it' | 'en' = 'it') => measureMail(locale, { companyName: 'Esempio Srl', riderName: 'Marco', garment: 'la giacca', expiresAt: new Date(expiresAt), photos: false }, '').body
    // 23:30 UTC on 12 November is 00:30 on 13 November in Rome: the link still works on the 13th.
    expect(until('2026-11-12T23:30:00.000Z')).toContain('fino al 13/11/2026')
    expect(until('2026-11-12T23:30:00.000Z', 'en')).toContain('until 2026-11-13')
    expect(until('2026-11-13T11:00:00.000Z')).toContain('fino al 13/11/2026')
    // An expiry at Rome midnight (23:00 UTC in winter, 22:00 in summer) ends the day before.
    expect(until('2026-11-30T23:00:00.000Z')).toContain('fino al 30/11/2026')
    expect(until('2026-07-31T22:00:00.000Z')).toContain('fino al 31/07/2026')
    expect(until('2026-07-31T22:30:00.000Z')).toContain('fino al 01/08/2026')
  })
})
