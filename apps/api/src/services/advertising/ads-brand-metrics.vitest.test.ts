import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import {
  parseBrandBuildingRows,
  decodeReportPayload,
  toNum,
  toInt,
  parseDay,
} from './ads-brand-metrics.service.js'

const FALLBACK = new Date(Date.UTC(2026, 6, 1))

/**
 * Verbatim slice of a real response captured from the IT profile on
 * 2026-07-29. Every metric value is a STRING — that is Amazon's actual
 * encoding, not a simplification for the test.
 */
const LIVE_SAMPLE = {
  brandBuildingMetrics: [
    {
      metadata: {
        metricsComputationDate: '2026-06-27',
        brandName: 'XAVIA RACING WWW.XAVIARACING.IT',
        categoryNodeName: '/Categorie/Moto, accessori e componenti',
        categoryNodeTreeName: 'it-automotive',
        lookbackPeriod: '1w',
      },
      metrics: {
        brandCustomers: '12',
        brandCustomersCategoryMedian: '12',
        brandCustomersCategoryTopPerformers: '417.28',
        highValueCustomers: '2',
        addToCarts: '99',
        addToCartsCategoryMedian: '34',
        salesIndex: '0.8603',
        awarenessIndex: '0.6668',
        considerationIndex: '0.6684',
        viewedDetailPageOnly: '833',
        brandedSearchesOnly: '1',
        brandedSearchesAndDetailPageViews: '4',
        newToBrandCustomerRate: '0.86',
        customerConversionRate: '0.01',
      },
    },
  ],
}

describe('toNum / toInt', () => {
  it('parses Amazon string-encoded metrics', () => {
    expect(toNum('0.6668')).toBeCloseTo(0.6668)
    expect(toInt('12')).toBe(12)
    expect(toInt('417.28')).toBe(417)
  })

  it('keeps a real zero as zero', () => {
    expect(toNum('0')).toBe(0)
    expect(toInt('0')).toBe(0)
  })

  it('returns null for absent values instead of collapsing them to 0', () => {
    // Number(null) === 0 and Number('') === 0. Without an explicit guard a
    // metric Amazon did not report would read as a real zero.
    for (const v of [null, undefined, '', '   ', {}, [], true]) {
      expect(toNum(v)).toBeNull()
      expect(toInt(v)).toBeNull()
    }
  })

  it('returns null for non-numeric junk', () => {
    expect(toNum('n/a')).toBeNull()
    expect(toInt('abc')).toBeNull()
  })
})

describe('parseDay', () => {
  it('parses YYYY-MM-DD to UTC midnight', () => {
    expect(parseDay('2026-06-27', FALLBACK).toISOString()).toBe('2026-06-27T00:00:00.000Z')
  })

  it('falls back on missing or unparseable values', () => {
    expect(parseDay(undefined, FALLBACK)).toEqual(FALLBACK)
    expect(parseDay('nope', FALLBACK)).toEqual(FALLBACK)
  })
})

describe('parseBrandBuildingRows — live contract', () => {
  it('parses the real captured payload', () => {
    const rows = parseBrandBuildingRows(LIVE_SAMPLE, FALLBACK)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.brandName).toBe('XAVIA RACING WWW.XAVIARACING.IT')
    expect(r.computationDate.toISOString()).toBe('2026-06-27T00:00:00.000Z')
    expect(r.lookbackPeriod).toBe('1w')
    expect(r.categoryNodeTreeName).toBe('it-automotive')
    expect(r.awarenessIndex).toBeCloseTo(0.6668)
    expect(r.considerationIndex).toBeCloseTo(0.6684)
    expect(r.salesIndex).toBeCloseTo(0.8603)
    expect(r.brandCustomers).toBe(12)
    expect(r.highValueCustomers).toBe(2)
    expect(r.addToCarts).toBe(99)
    expect(r.viewedDetailPageOnly).toBe(833)
    expect(r.brandedSearchesOnly).toBe(1)
    expect(r.brandedSearchesAndDetailPageViews).toBe(4)
    expect(r.newToBrandCustomerRate).toBeCloseTo(0.86)
    expect(r.customerConversionRate).toBeCloseTo(0.01)
  })

  it('retains the full raw metric map including category benchmarks', () => {
    // The median / top-performer pair is the competitive value of this report;
    // flattening to promoted columns alone would discard it.
    const rows = parseBrandBuildingRows(LIVE_SAMPLE, FALLBACK)
    expect(rows[0].metrics.brandCustomersCategoryMedian).toBe('12')
    expect(rows[0].metrics.brandCustomersCategoryTopPerformers).toBe('417.28')
    expect(rows[0].metrics.addToCartsCategoryMedian).toBe('34')
  })

  it('keeps raw metric values as strings', () => {
    const rows = parseBrandBuildingRows(LIVE_SAMPLE, FALLBACK)
    for (const v of Object.values(rows[0].metrics)) expect(typeof v).toBe('string')
  })

  it('parses multiple weekly rows independently', () => {
    const two = {
      brandBuildingMetrics: [
        LIVE_SAMPLE.brandBuildingMetrics[0],
        {
          metadata: { ...LIVE_SAMPLE.brandBuildingMetrics[0].metadata, metricsComputationDate: '2026-07-04' },
          metrics: { ...LIVE_SAMPLE.brandBuildingMetrics[0].metrics, awarenessIndex: '0.7' },
        },
      ],
    }
    const rows = parseBrandBuildingRows(two, FALLBACK)
    expect(rows).toHaveLength(2)
    expect(rows[1].computationDate.toISOString()).toBe('2026-07-04T00:00:00.000Z')
    expect(rows[1].awarenessIndex).toBeCloseTo(0.7)
  })

  it('keeps one row per CATEGORY NODE for the same brand-week', () => {
    // Verified live 2026-07-29: Amazon returns the same brand-week at several
    // category-node depths, each with its own benchmarks. Keying without
    // categoryNodeName collapsed 28 IT records into 5 stored rows.
    const meta = LIVE_SAMPLE.brandBuildingMetrics[0].metadata
    const rows = parseBrandBuildingRows(
      {
        brandBuildingMetrics: [
          { metadata: { ...meta, categoryNodeName: '/Categorie/Moto' }, metrics: { addToCarts: '99' } },
          { metadata: { ...meta, categoryNodeName: '/Categorie/Moto/Abbigliamento' }, metrics: { addToCarts: '12' } },
          { metadata: { ...meta, categoryNodeName: '/Categorie/Moto/Abbigliamento/Giacche' }, metrics: { addToCarts: '3' } },
        ],
      },
      FALLBACK,
    )
    expect(rows).toHaveLength(3)
    // Same brand + same week — only the category distinguishes them, so the
    // uniqueness key MUST include it.
    expect(new Set(rows.map((r) => r.computationDate.getTime())).size).toBe(1)
    expect(new Set(rows.map((r) => r.categoryNodeName)).size).toBe(3)
    expect(rows.map((r) => r.addToCarts)).toEqual([99, 12, 3])
  })

  it('uses an empty-string sentinel, never null, for a missing category', () => {
    // categoryNodeName is part of the unique key and Postgres treats NULLs as
    // distinct, so a null would silently re-admit duplicate rows.
    const rows = parseBrandBuildingRows(
      { brandBuildingMetrics: [{ metadata: { brandName: 'X', metricsComputationDate: '2026-06-27' }, metrics: {} }] },
      FALLBACK,
    )
    expect(rows[0].categoryNodeName).toBe('')
  })

  it('drops rows with no brand name rather than inventing a placeholder', () => {
    // brandName is part of the uniqueness key — a placeholder would overwrite
    // a real brand's week.
    const rows = parseBrandBuildingRows(
      { brandBuildingMetrics: [{ metadata: { metricsComputationDate: '2026-06-27' }, metrics: { addToCarts: '5' } }] },
      FALLBACK,
    )
    expect(rows).toHaveLength(0)
  })

  it('leaves unreported metrics null rather than zero', () => {
    const rows = parseBrandBuildingRows(
      { brandBuildingMetrics: [{ metadata: { brandName: 'X', metricsComputationDate: '2026-06-27' }, metrics: {} }] },
      FALLBACK,
    )
    expect(rows[0].awarenessIndex).toBeNull()
    expect(rows[0].brandCustomers).toBeNull()
    expect(rows[0].addToCarts).toBeNull()
  })

  it('defaults lookbackPeriod to 1w when absent', () => {
    const rows = parseBrandBuildingRows(
      { brandBuildingMetrics: [{ metadata: { brandName: 'X', metricsComputationDate: '2026-06-27' }, metrics: {} }] },
      FALLBACK,
    )
    expect(rows[0].lookbackPeriod).toBe('1w')
  })

  it('tolerates a flattened record without metadata/metrics nesting', () => {
    const rows = parseBrandBuildingRows(
      [{ brandName: 'XAVIA', metricsComputationDate: '2026-06-27', awarenessIndex: '0.5' }],
      FALLBACK,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].awarenessIndex).toBeCloseTo(0.5)
  })

  it.each([
    ['brandBuildingMetrics', (r: unknown) => ({ brandBuildingMetrics: [r] })],
    ['bare array', (r: unknown) => [r]],
    ['{rows}', (r: unknown) => ({ rows: [r] })],
    ['{data}', (r: unknown) => ({ data: [r] })],
  ])('unwraps the %s envelope', (_label, wrap) => {
    const rows = parseBrandBuildingRows(wrap(LIVE_SAMPLE.brandBuildingMetrics[0]), FALLBACK)
    expect(rows).toHaveLength(1)
  })

  it('returns empty for junk instead of throwing', () => {
    expect(parseBrandBuildingRows(null, FALLBACK)).toEqual([])
    expect(parseBrandBuildingRows({}, FALLBACK)).toEqual([])
    expect(parseBrandBuildingRows('nonsense', FALLBACK)).toEqual([])
    expect(parseBrandBuildingRows([null, 42, 'x'], FALLBACK)).toEqual([])
  })

  it('drops nested objects from the raw metric map', () => {
    const rows = parseBrandBuildingRows(
      {
        brandBuildingMetrics: [{
          metadata: { brandName: 'X', metricsComputationDate: '2026-06-27' },
          metrics: { addToCarts: '5', nested: { a: 1 } },
        }],
      },
      FALLBACK,
    )
    expect(rows[0].metrics).toEqual({ addToCarts: '5' })
  })
})

describe('decodeReportPayload', () => {
  it('decodes plain JSON (what Brand Metrics actually returns)', () => {
    expect(decodeReportPayload(Buffer.from(JSON.stringify(LIVE_SAMPLE)))).toEqual(LIVE_SAMPLE)
  })

  it('decodes gzipped JSON', () => {
    expect(decodeReportPayload(gzipSync(Buffer.from(JSON.stringify(LIVE_SAMPLE))))).toEqual(LIVE_SAMPLE)
  })

  it('decodes NDJSON and skips malformed lines', () => {
    const row = { a: 1 }
    const nd = `${JSON.stringify(row)}\n{broken\n${JSON.stringify(row)}`
    expect(decodeReportPayload(Buffer.from(nd))).toEqual([row, row])
  })

  it('returns empty for an empty body', () => {
    expect(decodeReportPayload(Buffer.from(''))).toEqual([])
    expect(decodeReportPayload(Buffer.from('   '))).toEqual([])
  })

  it('does not mistake a 1-byte body for gzip', () => {
    expect(decodeReportPayload(Buffer.from([0x1f]))).toEqual([])
  })
})
