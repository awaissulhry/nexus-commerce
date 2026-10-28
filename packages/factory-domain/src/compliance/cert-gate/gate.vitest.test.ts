import { describe, expect, it } from 'vitest'
import { certificateGate, type GateCover, type GateRequest, type GateStyle, type MadeToMeasureGateRequest } from './gate'

// A made-up jacket in sizes 48, 50, 52 and two colourways; the notified body "0000" and every number are invented.
const BLACK = '0195f5d0-0000-7000-8000-0000000000c1'
const RED = '0195f5d0-0000-7000-8000-0000000000c2'
const style: GateStyle = { id: '0195f5d0-0000-7000-8000-0000000000d1', code: 'TEST-JKT', ppeCategory: 'CATEGORY_II', sizes: ['48', '50', '52'], mtmAllowed: true }
const cover = (overrides: Partial<GateCover> = {}, certificate: Partial<GateCover['certificate']> = {}): GateCover => ({
  coverageId: '0195f5d0-0000-7000-8000-0000000000e1',
  colourwayIds: [],
  sizes: [],
  allowsMadeToMeasure: false,
  ...overrides,
  certificate: {
    id: '0195f5d0-0000-7000-8000-0000000000f1',
    number: 'TEST-CERT-0001',
    standard: 'EN 17092-4:2020',
    ppeClass: 'A',
    notifiedBodyName: 'Test Notified Body',
    notifiedBodyNumber: '0000',
    validFrom: '2026-01-15',
    validTo: '2031-01-14',
    status: 'VALID',
    ...certificate,
  },
})
const sized = (covers: GateCover[], overrides: Partial<{ size: string; colourwayId: string; date: string; style: GateStyle }> = {}): GateRequest => ({
  style,
  colourwayId: BLACK,
  date: '2026-10-28',
  covers,
  size: '50',
  ...overrides,
})
const range = (min: string, max: string) => ({ min, max, unit: 'cm' })
const SIZE_MEASURES = {
  '48': { chest: range('94', '98'), height: range('170', '176') },
  '50': { chest: range('98', '102'), height: range('174', '180') },
  '52': { chest: range('102', '106'), height: range('178', '184') },
}
const mtm = (covers: GateCover[], measurements: Record<string, { value: string; unit: string }>, overrides: Partial<MadeToMeasureGateRequest> = {}): GateRequest => ({
  style,
  colourwayId: BLACK,
  date: '2026-10-28',
  covers,
  madeToMeasure: { measurements, sizeMeasures: SIZE_MEASURES },
  ...overrides,
})
const codes = (request: GateRequest) => {
  const result = certificateGate(request)
  return result.allowed ? [] : result.reasons.map((reason) => reason.code)
}

describe('the certificate gate (QHS-051)', () => {
  it('PPE Regulation 2016/425: a garment is covered by a valid certificate covering its style, colourway and size', () => {
    expect(certificateGate(sized([cover()]))).toEqual({
      allowed: true,
      outcome: 'covered',
      route: 'SIZE',
      coverageId: '0195f5d0-0000-7000-8000-0000000000e1',
      certificate: { id: '0195f5d0-0000-7000-8000-0000000000f1', number: 'TEST-CERT-0001', standard: 'EN 17092-4:2020', ppeClass: 'A', notifiedBodyName: 'Test Notified Body', notifiedBodyNumber: '0000', validFrom: '2026-01-15', validTo: '2031-01-14' },
    })
    expect(certificateGate(sized([cover({ colourwayIds: [BLACK], sizes: ['50', '52'] })])).allowed).toBe(true)
  })

  it('PPE Regulation 2016/425: refuses a category II garment no certificate covers', () => {
    const result = certificateGate(sized([]))
    expect(result).toMatchObject({ allowed: false, outcome: 'refused', reasons: [{ code: 'no_certificate' }] })
    expect(!result.allowed && result.reasons[0]!.message).toContain('Reg. (EU) 2016/425')
  })

  it('PPE Regulation 2016/425: refuses with an expired certificate, also before the scheduler marked it', () => {
    expect(codes(sized([cover({}, { status: 'EXPIRED', validFrom: '2021-10-01', validTo: '2026-09-30' })]))).toEqual(['certificate_expired'])
    // Still VALID in the register, but the day is after its last valid day.
    const result = certificateGate(sized([cover({}, { validFrom: '2021-10-01', validTo: '2026-10-27' })]))
    expect(result).toMatchObject({ allowed: false, reasons: [{ code: 'certificate_expired', certificateId: '0195f5d0-0000-7000-8000-0000000000f1', message: 'Certificate TEST-CERT-0001 (EN 17092-4:2020, notified body 0000) expired: its last valid day was 2026-10-27.' }] })
    // On the last valid day it still covers.
    expect(certificateGate(sized([cover({}, { validFrom: '2021-10-29', validTo: '2026-10-28' })])).allowed).toBe(true)
  })

  it('PPE Regulation 2016/425: refuses with a draft, suspended or withdrawn certificate, or one not valid yet', () => {
    for (const status of ['DRAFT', 'SUSPENDED', 'WITHDRAWN'] as const) expect(codes(sized([cover({}, { status })]))).toEqual(['certificate_not_valid'])
    expect(codes(sized([cover({}, { validFrom: '2026-11-01' })]))).toEqual(['certificate_not_yet_valid'])
  })

  it('PPE Regulation 2016/425: refuses a colourway or a size the certificate does not cover, and says which', () => {
    expect(codes(sized([cover({ colourwayIds: [BLACK] })], { colourwayId: RED }))).toEqual(['colourway_not_covered'])
    const result = certificateGate(sized([cover({ sizes: ['48', '50'] })], { size: '52' }))
    expect(result).toMatchObject({ allowed: false, reasons: [{ code: 'size_not_covered', message: 'Certificate TEST-CERT-0001 (EN 17092-4:2020, notified body 0000) does not cover size 52 of style TEST-JKT (it covers 48, 50).' }] })
    expect(codes(sized([cover()], { size: '56' }))).toEqual(['size_not_covered'])
    // Every reason of every certificate.
    expect(codes(sized([cover({ colourwayIds: [BLACK] }, { status: 'SUSPENDED' })], { colourwayId: RED }))).toEqual(['certificate_not_valid', 'colourway_not_covered'])
  })

  it('takes the covering certificate that is valid longest when several cover the garment, and ignores the ones that do not', () => {
    const older = cover({ coverageId: '0195f5d0-0000-7000-8000-0000000000e2' }, { id: '0195f5d0-0000-7000-8000-0000000000f2', number: 'TEST-CERT-0000', validFrom: '2022-01-01', validTo: '2026-12-31' })
    const expired = cover({ coverageId: '0195f5d0-0000-7000-8000-0000000000e3' }, { id: '0195f5d0-0000-7000-8000-0000000000f3', status: 'EXPIRED' })
    const result = certificateGate(sized([older, expired, cover()]))
    expect(result).toMatchObject({ allowed: true, coverageId: '0195f5d0-0000-7000-8000-0000000000e1', certificate: { number: 'TEST-CERT-0001' } })
  })

  it('needs no certificate for a garment that is not PPE or is category I (self-certified)', () => {
    expect(certificateGate(sized([], { style: { ...style, ppeCategory: 'NOT_PPE' } }))).toMatchObject({ allowed: true, outcome: 'not_required' })
    expect(certificateGate(sized([], { style: { ...style, ppeCategory: 'CATEGORY_I' } }))).toMatchObject({ allowed: true, outcome: 'not_required' })
    expect(certificateGate(sized([], { style: { ...style, ppeCategory: 'CATEGORY_III' } })).allowed).toBe(false)
  })

  it('refuses a day that is not a calendar day', () => {
    expect(() => certificateGate(sized([cover()], { date: '2026-02-30' }))).toThrow(RangeError)
  })
})

describe('the made-to-measure route (PRD-288)', () => {
  const allowing = cover({ allowsMadeToMeasure: true })
  const rider = { chest: { value: '100.5', unit: 'cm' }, height: { value: '183', unit: 'cm' }, waist: { value: '84', unit: 'cm' } }

  it("PPE Regulation 2016/425 Annex III: covers a made-to-measure unit whose rider's measures fall inside the covered sizes' body measures", () => {
    expect(certificateGate(mtm([allowing], rider))).toMatchObject({ allowed: true, outcome: 'covered', route: 'MADE_TO_MEASURE', certificate: { number: 'TEST-CERT-0001' } })
    // The bounds are included.
    expect(certificateGate(mtm([allowing], { chest: { value: '94', unit: 'cm' }, height: { value: '184.0', unit: 'cm' } })).allowed).toBe(true)
  })

  it('PPE Regulation 2016/425 Annex III: refuses a measurement outside the covered sizes and names the point', () => {
    const narrow = cover({ allowsMadeToMeasure: true, sizes: ['48', '50'] })
    const result = certificateGate(mtm([narrow], { ...rider, chest: { value: '103', unit: 'cm' } }))
    expect(result).toMatchObject({
      allowed: false,
      route: 'MADE_TO_MEASURE',
      reasons: [{ code: 'measurement_outside', point: 'chest' }, { code: 'measurement_outside', point: 'height' }],
    })
    expect(!result.allowed && result.reasons[1]!.message).toBe("The rider's height of 183 cm is outside the body measures of the covered sizes (48: 170–176, 50: 174–180; 170–180 cm overall).")
  })

  it('PPE Regulation 2016/425 Annex III: refuses when the certificate does not allow made-to-measure units, or the style is not made to measure', () => {
    expect(codes(mtm([cover()], rider))).toEqual(['made_to_measure_not_allowed'])
    expect(codes(mtm([allowing], rider, { style: { ...style, mtmAllowed: false } }))).toEqual(['style_not_made_to_measure'])
  })

  it('refuses a missing or unreadable measurement, and sizes without body measures', () => {
    expect(certificateGate(mtm([allowing], { chest: rider.chest }))).toMatchObject({ allowed: false, reasons: [{ code: 'measurement_missing', point: 'height' }] })
    expect(codes(mtm([allowing], { ...rider, chest: { value: '1005', unit: 'mm' } }))).toEqual(['measurement_invalid'])
    expect(codes(mtm([allowing], { ...rider, chest: { value: 'about 100', unit: 'cm' } }))).toEqual(['measurement_invalid'])
    const bare: GateRequest = { style, colourwayId: BLACK, date: '2026-10-28', covers: [allowing], madeToMeasure: { measurements: rider, sizeMeasures: { '48': null, '50': null, '52': null } } }
    expect(codes(bare)).toEqual(['body_measures_missing'])
  })

  it('still refuses an expired certificate on the made-to-measure route', () => {
    expect(codes(mtm([cover({ allowsMadeToMeasure: true }, { status: 'EXPIRED' })], rider))).toEqual(['certificate_expired'])
  })
})
