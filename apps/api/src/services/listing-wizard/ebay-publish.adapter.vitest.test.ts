/**
 * B1 — eBay fitment mapper. Pure, so the captured-fitment → Inventory API
 * product_compatibility shape is fully unit-testable without eBay creds.
 */
import { describe, it, expect, vi } from 'vitest'

// The adapter imports prisma + sibling services at module load; mock the DB so
// importing the pure mapper never spins up a real PrismaClient.
vi.mock('../../db.js', () => ({ default: {} }))

import { buildEbayCompatibilityBody, buildEbayRegulatory } from './ebay-publish.adapter.js'

describe('B1 — buildEbayCompatibilityBody', () => {
  it('maps year/make/model/submodel → compatibilityProperties (stable order)', () => {
    const body = buildEbayCompatibilityBody({
      universal: false,
      fitments: [{ year: 2020, make: 'Honda', model: 'CBR600RR', submodel: 'ABS' }],
    })
    expect(body).not.toBeNull()
    expect(body!.compatibleProducts).toHaveLength(1)
    expect(body!.compatibleProducts[0].compatibilityProperties).toEqual([
      { name: 'Year', value: '2020' },
      { name: 'Make', value: 'Honda' },
      { name: 'Model', value: 'CBR600RR' },
      { name: 'Submodel', value: 'ABS' },
    ])
  })
  it('omits submodel when absent/null', () => {
    const body = buildEbayCompatibilityBody({ fitments: [{ year: '2019', make: 'Yamaha', model: 'R6', submodel: null }] })
    expect(body!.compatibleProducts[0].compatibilityProperties.map((p) => p.name)).toEqual(['Year', 'Make', 'Model'])
  })
  it('universal fit → null (no list sent)', () => {
    expect(buildEbayCompatibilityBody({ universal: true, fitments: [{ year: '2020', make: 'Honda', model: 'X' }] })).toBeNull()
  })
  it('no fitments / null / undefined → null', () => {
    expect(buildEbayCompatibilityBody({ universal: false, fitments: [] })).toBeNull()
    expect(buildEbayCompatibilityBody(null as any)).toBeNull()
    expect(buildEbayCompatibilityBody(undefined)).toBeNull()
  })
  it('drops fitments missing make or model', () => {
    const body = buildEbayCompatibilityBody({
      fitments: [
        { year: '2020', make: 'Honda', model: '' },       // no model → dropped
        { year: '2021', make: '', model: 'CBR' },          // no make → dropped
        { year: '2022', make: 'Honda', model: 'CBR1000' }, // valid
      ],
    })
    expect(body!.compatibleProducts).toHaveLength(1)
    expect(body!.compatibleProducts[0].compatibilityProperties).toContainEqual({ name: 'Model', value: 'CBR1000' })
  })
  it('multiple valid fitments → multiple compatibleProducts', () => {
    const body = buildEbayCompatibilityBody({
      fitments: [
        { year: '2020', make: 'Honda', model: 'CBR600' },
        { year: '2021', make: 'Kawasaki', model: 'Ninja' },
      ],
    })
    expect(body!.compatibleProducts).toHaveLength(2)
  })
})

describe('C2 — buildEbayRegulatory', () => {
  const rp = { name: 'Xavia Srl', addressLines: ['Via Roma 1', '20100 Milano'], email: 'c@xavia.it', phone: '+39 02 1' }

  it('responsible person → responsiblePersons[] with EU type + folded address + country', () => {
    const reg = buildEbayRegulatory({ responsiblePerson: rp })
    const p = (reg!.responsiblePersons as any[])[0]
    expect(p).toMatchObject({
      companyName: 'Xavia Srl', country: 'IT', types: ['EU_RESPONSIBLE_PERSON'],
      addressLine1: 'Via Roma 1', addressLine2: '20100 Milano', email: 'c@xavia.it', phone: '+39 02 1',
    })
  })
  it('manufacturer → manufacturer.companyName + country', () => {
    expect(buildEbayRegulatory({ manufacturer: 'Xavia Mfg' })!.manufacturer)
      .toEqual({ companyName: 'Xavia Mfg', country: 'IT' })
  })
  it('country override is honoured', () => {
    expect((buildEbayRegulatory({ manufacturer: 'X' }, 'DE')!.manufacturer as any).country).toBe('DE')
  })
  it('single address line → addressLine1 only (no addressLine2)', () => {
    const p = (buildEbayRegulatory({ responsiblePerson: { name: 'X', addressLines: ['Solo'] } })!.responsiblePersons as any[])[0]
    expect(p.addressLine1).toBe('Solo')
    expect(p).not.toHaveProperty('addressLine2')
  })
  it('no usable data → null', () => {
    expect(buildEbayRegulatory(null)).toBeNull()
    expect(buildEbayRegulatory({})).toBeNull()
    expect(buildEbayRegulatory({ responsiblePerson: { name: '' } })).toBeNull()
  })
  it('C4.2 — garment class + protectors → productSafety.statements', () => {
    const reg = buildEbayRegulatory({
      garmentClass: 'AA',
      impactProtectors: [{ zone: 'back', standard: 'EN_1621_2', level: '2' }],
    })
    const ps = reg!.productSafety as { statements: string[] }
    expect(ps.statements).toContain('EN 17092 Class AA protective motorcycle garment')
    expect(ps.statements).toContain('back protector: EN 1621-2 Level 2')
  })
  it('C4.2 — no structured data → no productSafety', () => {
    expect(buildEbayRegulatory({ manufacturer: 'X' })!.productSafety).toBeUndefined()
  })
})
