/** E2 — TSV report parser + guards: the pure heart of the eBay pipeline. */
import { describe, it, expect } from 'vitest'
import { parseReportTsv, moneyToCents } from './ebay-ads-reports.service.js'
import { shouldSkipStaleFlip } from './ebay-ads-entity-sync.service.js'
import { shouldSkipEndFlip, parseItemDetail } from './ebay-listing-index.service.js'

describe('parseReportTsv', () => {
  it('parses a listing-grain report with money → cents', () => {
    const tsv = [
      'listing_id\tday\timpressions\tclicks\tctr\tad_fees\tsale_amount\tquantity_sold',
      '256564203510\t2026-07-01\t1200\t34\t2.83\t4.13\t109.99\t1',
      '256566101420\t2026-07-01\t800\t12\t1.50\t0.00\t0.00\t0',
    ].join('\n')
    const rows = parseReportTsv(tsv)!
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      entityId: '256564203510',
      entityType: 'LISTING',
      date: '2026-07-01',
      impressions: 1200,
      clicks: 34,
      adFeesCents: 413,
      salesCents: 10999,
      soldQty: 1,
    })
    expect(rows[0]!.ctr).toBeCloseTo(2.83)
  })

  it('recognizes campaign and keyword grains + cpc_* aliases', () => {
    const c = parseReportTsv('campaign_id\tday\tcpc_ad_fees\n1\t2026-07-01\t2.50')!
    expect(c[0]).toMatchObject({ entityType: 'CAMPAIGN', adFeesCents: 250 })
    const k = parseReportTsv('keyword_id\tdate\tclicks\n77\t2026-07-02\t5')!
    expect(k[0]).toMatchObject({ entityType: 'KEYWORD', clicks: 5 })
  })

  it('keeps unmapped columns in extra — nothing silently dropped', () => {
    const rows = parseReportTsv('listing_id\tday\tclicks\tsome_new_metric\nX\t2026-07-01\t3\t42')!
    expect(rows[0]!.extra).toEqual({ some_new_metric: '42' })
  })

  it('returns null (fail-loud) when no entity or date column exists', () => {
    expect(parseReportTsv('foo\tbar\n1\t2')).toBeNull()
    expect(parseReportTsv('listing_id\tclicks\nX\t3')).toBeNull() // no date
  })

  it('handles empty report bodies and skips blank/short lines', () => {
    expect(parseReportTsv('')).toEqual([])
    const rows = parseReportTsv('listing_id\tday\tclicks\n\nX\t2026-07-01\t3\n')!
    expect(rows).toHaveLength(1)
  })

  it('ISO datetime in the date column truncates to the day', () => {
    const rows = parseReportTsv('listing_id\tdate\tclicks\nX\t2026-07-01T00:00:00.000Z\t9')!
    expect(rows[0]!.date).toBe('2026-07-01')
  })
})

describe('moneyToCents — locale-formatted eBay money cells', () => {
  it('parses the observed IT-site format "EUR 1.234,56"', () => {
    expect(moneyToCents('EUR 0,00')).toBe(0)
    expect(moneyToCents('EUR 12,34')).toBe(1234)
    expect(moneyToCents('EUR 1.234,56')).toBe(123456)
    expect(moneyToCents('EUR 109,99')).toBe(10999)
  })
  it('parses US format and plain numbers', () => {
    expect(moneyToCents('1,234.56')).toBe(123456)
    expect(moneyToCents('12.34')).toBe(1234)
    expect(moneyToCents('42')).toBe(4200)
    expect(moneyToCents('-3,50')).toBe(-350)
  })
  it('handles empty/garbage as zero', () => {
    expect(moneyToCents(undefined)).toBe(0)
    expect(moneyToCents('')).toBe(0)
    expect(moneyToCents('EUR')).toBe(0)
  })
})

describe('parseReportTsv — EUR-comma money end-to-end', () => {
  it('does not 100× inflate Italian-locale money columns', () => {
    const rows = parseReportTsv('campaign_id\tlisting_id\timpressions\tclicks\tctr\tad_fees\tsale_amount\tsales\nC1\tL1\t703\t2\t0.28\tEUR 1,50\tEUR 109,99\t1', '2026-07-02')!
    expect(rows[0]).toMatchObject({ entityType: 'LISTING', entityId: 'L1', adFeesCents: 150, salesCents: 10999, soldQty: 1 })
    expect(rows[0]!.extra).toMatchObject({ campaign_id: 'C1' }) // lineage preserved
    expect(rows[0]!.date).toBe('2026-07-02') // fallbackDate for single-day tasks
  })
})

describe('reconciliation circuit breakers', () => {
  it('stale flip: allows small drops, blocks implausible mass-drops', () => {
    expect(shouldSkipStaleFlip(20, 18)).toBe(false) // 10% gone → fine
    expect(shouldSkipStaleFlip(20, 5)).toBe(true) // 75% gone → breaker
    expect(shouldSkipStaleFlip(0, 0)).toBe(false)
    expect(shouldSkipStaleFlip(20, 20)).toBe(false)
  })
  it('end flip uses the tighter 40% threshold', () => {
    expect(shouldSkipEndFlip(20, 13)).toBe(false) // 35% → allowed
    expect(shouldSkipEndFlip(20, 11)).toBe(true) // 45% → breaker
  })
})

describe('parseItemDetail (Trading GetItem XML)', () => {
  it('extracts site, category, variation SKUs and aspects', () => {
    const xml = `<GetItemResponse><Ack>Success</Ack><Item>
      <Site>Italy</Site>
      <PrimaryCategory><CategoryID>177104</CategoryID></PrimaryCategory>
      <Quantity>101</Quantity><QuantitySold>27</QuantitySold>
      <ItemSpecifics>
        <NameValueList><Name>Marca</Name><Value>XAVIA</Value></NameValueList>
        <NameValueList><Name>Taglia</Name><Value>M</Value><Value>L</Value></NameValueList>
      </ItemSpecifics>
      <Variations>
        <Variation><SKU>GALE-JACKET-BLACK-MEN-M</SKU></Variation>
        <Variation><SKU>GALE-JACKET-BLACK-MEN-L</SKU></Variation>
      </Variations>
    </Item></GetItemResponse>`
    const d = parseItemDetail(xml)
    expect(d.site).toBe('Italy')
    expect(d.categoryId).toBe('177104')
    expect(d.quantity).toBe(101)
    expect(d.quantitySold).toBe(27)
    expect(d.variationSkus).toEqual(['GALE-JACKET-BLACK-MEN-M', 'GALE-JACKET-BLACK-MEN-L'])
    expect(d.aspects).toEqual({ Marca: ['XAVIA'], Taglia: ['M', 'L'] })
  })
  it('falls back to the top-level SKU for single-SKU items', () => {
    const d = parseItemDetail('<Item><SKU>SLIDER-01</SKU></Item>')
    expect(d.variationSkus).toEqual(['SLIDER-01'])
  })
})
