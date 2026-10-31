import { describe, expect, it } from 'vitest'
import { OFFICE_PAGES } from '../nav/office-nav'
import { isPrintView, printAddressOf, printHref, printKindOf, viewHref } from './print-model'

describe('the print view of any page (B-W2b-05, PLT-171)', () => {
  it('is the same address with print=1 (a list keeps its filters), and back is the address without it', () => {
    expect(printHref('/w/DEMO/sales/orders', 'late=true&status=OPEN')).toBe('/w/DEMO/sales/orders?late=true&status=OPEN&print=1')
    expect(printHref('/w/DEMO/sales/orders', '')).toBe('/w/DEMO/sales/orders?print=1')
    expect(printHref('/w/DEMO/sales/orders', 'print=1')).toBe('/w/DEMO/sales/orders?print=1')
    expect(viewHref('/w/DEMO/sales/orders', 'late=true&print=1')).toBe('/w/DEMO/sales/orders?late=true')
    expect(viewHref('/w/DEMO/sales/orders', 'print=1')).toBe('/w/DEMO/sales/orders')
    expect(isPrintView(new URLSearchParams('print=1'))).toBe(true)
    expect(isPrintView(new URLSearchParams('print=0'))).toBe(false)
    expect(isPrintView(null)).toBe(false)
  })

  it('a page with an id prints the record; a list or any other page prints the view; paper pages have none', () => {
    expect(printKindOf('/sales/orders/0190f0e2-3333-7000-8000-000000000002', OFFICE_PAGES)).toBe('record')
    expect(printKindOf('/records/Certificate/0190f0e2-5555-7000-8000-000000000001', OFFICE_PAGES)).toBe('record')
    expect(printKindOf('/sales/orders', OFFICE_PAGES)).toBe('view')
    // A built page with a fixed name is not a record because a record page sits beside it.
    expect(printKindOf('/sales/orders/new', OFFICE_PAGES)).toBe('view')
    for (const paper of ['/production/reports/print', '/finance/invoices/x/xml', '/warehouse/shipments/x/pack', '/plant/jobs/x/sheet', '/quality/holds/x/tag']) {
      expect(printKindOf(paper, OFFICE_PAGES), paper).toBeNull()
    }
  })
})

describe('one way to print each page', () => {
  it('a page with its own print page opens that one (with its terms); every other page its print view', () => {
    expect(printAddressOf('/home/today', '', OFFICE_PAGES)).toBe('/home/today/print')
    expect(printAddressOf('/production/reports', 'site=s1&date=2026-10-30', OFFICE_PAGES)).toBe('/production/reports/print?site=s1&date=2026-10-30')
    expect(printAddressOf('/sales/orders', 'late=true', OFFICE_PAGES)).toBe('/sales/orders?late=true&print=1')
  })
})
