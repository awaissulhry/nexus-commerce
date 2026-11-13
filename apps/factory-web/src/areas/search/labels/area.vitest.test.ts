import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { areaKey, resultHref } from '../model'
import { areaOfResult } from './area'

/** B-W2b-382 (XF7:03): a result is listed under the area of the page it opens. */
const place = { built: OFFICE_PAGES, companies: [{ id: 'c1', code: 'DEMO' }], company: 'DEMO' }
const result = (recordType: string, area: string) => ({ recordType, recordId: 'r1', number: 'N-1', title: 'Demo', companyId: null, siteId: null, area })

describe('the area a search result says', () => {
  it('a product-safety report, indexed under Sales, says Compliance — where its page is', () => {
    const href = resultHref(result('ProductSafetyReport', 'sales'), place)
    expect(href).toBe('/w/DEMO/compliance/register/accidents/reports/r1')
    const area = areaOfResult(href, 'sales')
    expect(area).toBe('compliance')
    expect(CATALOGUE.it.shell?.[areaKey(area)!.replace('shell:', '')]).toBeTruthy()
    expect(CATALOGUE.en.shell?.[areaKey(area)!.replace('shell:', '')]).toBe(CATALOGUE.en.shell?.['nav.compliance.area'])
  })
  it('keeps the indexer’s area where it is the page’s: a supplier on the buying side, a customer on the sales side', () => {
    expect(areaOfResult(resultHref(result('Party', 'purchasing'), place), 'purchasing')).toBe('purchasing')
    expect(areaOfResult(resultHref(result('Party', 'sales'), place), 'sales')).toBe('sales')
    expect(areaOfResult(resultHref(result('SalesOrder', 'sales'), place), 'sales')).toBe('sales')
  })
  it('keeps the indexer’s area for a result that opens its record panels', () => {
    expect(areaOfResult('/w/DEMO/records/Colour/r1?label=N-1', 'products')).toBe('products')
    expect(areaOfResult('/w/DEMO/me', 'admin')).toBe('admin')
  })
})
