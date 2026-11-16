import { describe, expect, it } from 'vitest'
import { destinationClassOf } from '../shipping/customs/rules'
import { evidenceNeed } from '../shipping/evidence/evidence'
import { destinationOf } from '../shipping/services/catalogue'
import { outsideVatArea, specialTerritoryOf, territoryWords } from './special-territories'

/**
 * B-W2b-GF2 (gap G463): the EU's special fiscal territories (Directive 2006/112/EC art. 6; DPR 633/1972 art. 7; Reg. (EU)
 * 952/2013 art. 4), told apart by the postal code and town, not the country code alone. Made-up addresses.
 */

describe('the special fiscal territories', () => {
  it('finds each by its postal code (and the town where the code is shared), and an ordinary place is none', () => {
    expect(specialTerritoryOf({ country: 'IT', postalCode: '23041', city: 'Livigno' })).toMatchObject({ key: 'LIVIGNO', vat: 'OUTSIDE', customs: 'OUTSIDE', state: 'IT' })
    expect(specialTerritoryOf({ country: 'IT', postalCode: '23030', city: 'Livigno' })?.key).toBe('LIVIGNO')
    expect(specialTerritoryOf({ country: 'IT', postalCode: '23030', city: 'Valdisotto' })).toBeNull()
    expect(specialTerritoryOf({ country: 'IT', postalCode: '22061', city: "Campione d'Italia" })).toMatchObject({ key: 'CAMPIONE', vat: 'OUTSIDE', customs: 'INSIDE' })
    expect(specialTerritoryOf({ country: 'IT', postalCode: '22060', city: 'Carimate' })).toBeNull()
    expect(specialTerritoryOf({ country: 'ES', postalCode: '35001', city: 'Las Palmas' })).toMatchObject({ key: 'CANARY_ISLANDS', vat: 'OUTSIDE', customs: 'INSIDE' })
    expect(specialTerritoryOf({ country: 'ES', postalCode: '38001' })?.key).toBe('CANARY_ISLANDS')
    expect(specialTerritoryOf({ country: 'ES', postalCode: '51001' })).toMatchObject({ key: 'CEUTA', customs: 'OUTSIDE' })
    expect(specialTerritoryOf({ country: 'ES', postalCode: '52001' })?.key).toBe('MELILLA')
    expect(specialTerritoryOf({ country: 'ES', postalCode: '28001', city: 'Madrid' })).toBeNull()
    expect(specialTerritoryOf({ country: 'GR', postalCode: '630 86' })?.key).toBe('MOUNT_ATHOS')
    expect(specialTerritoryOf({ country: 'DE', postalCode: '27498' })?.key).toBe('HELIGOLAND')
    expect(specialTerritoryOf({ country: 'DE', postalCode: '78266', city: 'Büsingen am Hochrhein' })?.key).toBe('BUSINGEN')
    expect(specialTerritoryOf({ country: 'FI', postalCode: '22100', city: 'Mariehamn' })?.key).toBe('ALAND')
    expect(specialTerritoryOf({ country: 'AX', postalCode: '22100' })?.key).toBe('ALAND')
    expect(specialTerritoryOf({ country: 'FR', postalCode: '97400', city: 'Saint-Denis' })).toMatchObject({ key: 'FRENCH_OVERSEAS', vat: 'OUTSIDE', customs: 'INSIDE' })
    expect(specialTerritoryOf({ country: 'FR', postalCode: '97133' })).toMatchObject({ key: 'FRENCH_OCT', customs: 'OUTSIDE' })
    expect(specialTerritoryOf({ country: 'FR', postalCode: '75001', city: 'Paris' })).toBeNull()
    expect(specialTerritoryOf({ country: 'MC', postalCode: '98000' })).toMatchObject({ key: 'MONACO', vat: 'INSIDE', customs: 'INSIDE', state: 'FR' })
    expect(outsideVatArea({ country: 'ES', postalCode: '35001' })).toBe(true)
    expect(outsideVatArea({ country: 'MC' })).toBe(false)
    expect(outsideVatArea({ country: 'DE', postalCode: '80331' })).toBe(false)
  })

  it('says what each means for goods sent there from Italy, in both languages, with the law', () => {
    const canaries = territoryWords(specialTerritoryOf({ country: 'ES', postalCode: '35001' })!)
    expect(canaries.en).toBe("the Canary Islands: outside the EU's VAT area though inside its customs territory; goods sent there are an export for VAT and take export papers (Directive 2006/112/EC art. 6).")
    expect(canaries.it).toContain('le Isole Canarie: fuori dall’area IVA dell’UE')
    expect(territoryWords(specialTerritoryOf({ country: 'IT', postalCode: '23041' })!).en).toContain("outside the EU's VAT area and customs territory")
    expect(territoryWords(specialTerritoryOf({ country: 'MC' })!).en).toContain('as to another EU state')
  })

  it('makes the destination an export (papers) outside the VAT area, Monaco an EU one, and art. 41 never applies there', () => {
    expect(destinationClassOf('IT')).toBe('DOMESTIC')
    expect(destinationClassOf('IT', undefined, { postalCode: '23041', city: 'Livigno' })).toBe('EXPORT')
    expect(destinationClassOf('IT', undefined, { postalCode: '22061' })).toBe('EXPORT')
    expect(destinationClassOf('ES', undefined, { postalCode: '35001' })).toBe('EXPORT')
    expect(destinationClassOf('ES', undefined, { postalCode: '28001' })).toBe('EU')
    expect(destinationClassOf('ES')).toBe('EU')
    expect(destinationClassOf('MC')).toBe('EU')
    expect(destinationClassOf('CH')).toBe('EXPORT')
    const sale = { taxMode: 'EU_B2B', companyCountry: 'IT' }
    expect(evidenceNeed({ ...sale, shipToCountry: 'ES', shipToPostalCode: '28001' }).needed).toBe(true)
    const canaries = evidenceNeed({ ...sale, shipToCountry: 'ES', shipToPostalCode: '35001', shipToCity: 'Las Palmas' })
    expect(canaries).toEqual({ needed: false, words: "The goods go to the Canary Islands, outside the EU's VAT area: art. 41 does not apply (an export has its own proof of exit; Directive 2006/112/EC art. 6)." })
    expect(evidenceNeed({ ...sale, shipToCountry: 'MC', shipToPostalCode: '98000' }).needed).toBe(true)
    // The carrier booking: customs papers travel to a territory outside the VAT area.
    expect(destinationOf('IT', 'ES', { postalCode: '38001' })).toBe('EXPORT')
    expect(destinationOf('IT', 'IT', { postalCode: '23041', city: 'Livigno' })).toBe('EXPORT')
    expect(destinationOf('IT', 'IT', { postalCode: '20121' })).toBe('DOMESTIC')
    expect(destinationOf('IT', 'MC')).toBe('EU')
    expect(destinationOf('IT', 'DE')).toBe('EU')
  })
})
