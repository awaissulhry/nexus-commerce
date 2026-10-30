import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { CATALOGUE } from '../../lib/i18n/messages'
import { OFFICE_PAGES } from '../../shell/nav/office-nav'
import { designScreen as paletteScreen } from '../../shell/palette/fixtures'
import { designScreen } from './fixtures'
import { areaKey, canSearchSomething, chipKey, numbersOf, readTerms, resultHref, SEARCH_TYPES, SEARCH_VIEW_PERMISSIONS, searchPageHref, STATUS_CODES, statusKey, statusTone, termsQuery, typeKey } from './model'

const place = {
  built: OFFICE_PAGES,
  companies: [
    { id: '0190f0e2-1111-7000-8000-000000000001', code: 'DEMO' },
    { id: '0190f0e2-1111-7000-8000-000000000002', code: 'ESEMPIO' },
  ],
  company: 'DEMO',
}
const result = (over: Partial<Parameters<typeof resultHref>[0]> = {}) => ({ recordType: 'SalesOrder', recordId: 'r1', number: 'ORD-1', title: 'Demo', companyId: null, siteId: null, area: 'sales', ...over })

describe('where a result opens (B-W2a-32)', () => {
  it("opens a record on its own page in its company's Office, else the screen's", () => {
    expect(resultHref(result(), place)).toBe('/w/DEMO/sales/orders/r1')
    expect(resultHref(result({ companyId: '0190f0e2-1111-7000-8000-000000000002' }), place)).toBe('/w/ESEMPIO/sales/orders/r1')
    expect(resultHref(result({ companyId: '0190f0e2-9999-7000-8000-000000000009' }), place)).toBe('/w/DEMO/sales/orders/r1')
  })

  it('opens a supplier on the buying side, a customer on the sales side', () => {
    expect(resultHref(result({ recordType: 'Party', area: 'purchasing' }), place)).toBe('/w/DEMO/purchasing/suppliers/r1')
    expect(resultHref(result({ recordType: 'Party', area: 'sales' }), place)).toBe('/w/DEMO/sales/customers/r1')
  })

  it('opens a record type without a page of its own in its panels', () => {
    expect(resultHref(result({ recordType: 'Gizmo', number: 'GZ-1' }), place)).toBe('/w/DEMO/records/Gizmo/r1?label=GZ-1')
  })

  it('keeps the terms in the address', () => {
    expect(readTerms(new URLSearchParams('q=pista&type=SalesOrder'))).toEqual({ q: 'pista', type: 'SalesOrder' })
    expect(readTerms(new URLSearchParams('type=sales order'))).toEqual({ q: '', type: null })
    expect(termsQuery({ q: ' pista ', type: null })).toBe('?q=pista')
    expect(termsQuery({ q: '', type: null })).toBe('')
    expect(searchPageHref('DEMO', 'ORD 42', 'SalesOrder')).toBe('/w/DEMO/search?q=ORD+42&type=SalesOrder')
  })

  it('copies the numbers of the selected rows in the order shown, skipping rows without one', () => {
    const rows = [
      { recordId: 'a', number: 'ORD-1' },
      { recordId: 'b', number: null },
      { recordId: 'c', number: 'FT-9' },
    ]
    expect(numbersOf(rows, ['c', 'b', 'a'])).toEqual(['ORD-1', 'FT-9'])
  })

  it('knows who has something to search', () => {
    for (const permission of SEARCH_VIEW_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(permission), permission).toBe(true)
    expect(canSearchSomething(['orders.view'])).toBe(true)
    expect(canSearchSomething(['users.view', 'home.view'])).toBe(false)
  })
})

describe('the words a result is said with, in Italian and English', () => {
  for (const locale of ['it', 'en'] as const) {
    it(`${locale}: every indexed type, chip and status has words; another type is "Record"`, () => {
      const search = CATALOGUE[locale].search!
      const shell = CATALOGUE[locale].shell!
      for (const type of [...SEARCH_TYPES, 'Gizmo']) {
        expect(search[typeKey(type)], type).toBeTruthy()
        expect(search[chipKey(type)], type).toBeTruthy()
      }
      for (const code of STATUS_CODES) expect(search[statusKey(code)!], code).toBeTruthy()
      expect(statusKey('TELEPORTED')).toBeNull()
      for (const area of ['sales', 'products', 'purchasing', 'warehouse', 'production', 'finance']) expect(shell[areaKey(area)!.replace('shell:', '')], area).toBeTruthy()
      expect(areaKey('nowhere')).toBeNull()
    })
  }

  it('draws statuses in tones', () => {
    expect(statusTone('ON_HOLD')).toBe('warning')
    expect(statusTone('CANCELLED')).toBe('danger')
    expect(statusTone('SHIPPED')).toBe('success')
    expect(statusTone('DRAFT')).toBe('neutral')
    expect(statusTone(null)).toBe('neutral')
  })
})

describe('design cases (SCR-248, SCR-004)', () => {
  it('covers every state of the results page and the records of the palette', () => {
    expect(designScreen.screen).toBe('SCR-248')
    expect(designScreen.cases.map((entry) => entry.model.state)).toEqual(expect.arrayContaining(['ready', 'start', 'loading', 'slow', 'error', 'noAccess']))
    expect(designScreen.cases.some((entry) => entry.model.state === 'ready' && entry.model.rows.length === 0)).toBe(true)
    expect(paletteScreen.cases.map((entry) => entry.model.records?.state ?? 'none')).toEqual(expect.arrayContaining(['ready', 'loading', 'slow', 'error', 'none']))
  })

  it('holds made-up data only, never money', () => {
    const text = JSON.stringify([designScreen.cases, paletteScreen.cases])
    expect(text).not.toMatch(/€|EUR\b|\bamount\b|price|cost/i)
  })
})
