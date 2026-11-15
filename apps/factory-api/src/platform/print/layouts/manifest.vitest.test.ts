import { describe, expect, it } from 'vitest'
import type { ManifestSheet, SheetShipment } from '@nexus/factory-domain/shipping/manifest/rules'
import { manifestPdf } from './manifest'

/** The day's sheet as a PDF (B-W2b-395; LOG-049): a closed sheet, a preview, a long one over several pages. Made-up facts. */

const row = (n: number): SheetShipment => ({
  id: `0190b3c4-0000-7000-8000-${String(n).padStart(12, '0')}`,
  number: `SH-${String(n).padStart(4, '0')}`,
  consignee: 'Made-up Moto Workshop S.r.l. with a rather long trade name that runs over its column',
  city: 'Seedville',
  country: 'IT',
  parcels: 2,
  weightKg: '7.250',
  trackingNumbers: ['FK0000000001', 'FK0000000002', 'FK0000000003'],
  ddtNumber: `${n}/2026`,
  shippedAt: new Date('2026-11-16T15:00:00.000Z'),
})

const sheet = (over: Partial<ManifestSheet> = {}): ManifestSheet => ({
  companyName: 'Made-up Factory S.r.l.',
  site: { code: 'A1', name: 'Seed works', address: ['Via Seed 1', '00000 Seedtown (MI) IT'] },
  carrier: { code: 'brt', name: 'BRT' },
  day: '2026-11-16',
  sheetId: '0190b3c4-0000-7000-8000-00000000abcd',
  closedAt: '2026-11-16 17:30',
  closedBySystem: false,
  preview: false,
  shipments: [row(2), row(1)],
  ...over,
})

const pages = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length

describe('the end-of-day manifest PDF', () => {
  it('paints a closed sheet on one A4 page, a preview and an empty sheet too', async () => {
    const closed = await manifestPdf(sheet())
    expect(closed.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pages(closed)).toBe(1)
    expect(pages(await manifestPdf(sheet({ preview: true, closedAt: null, sheetId: null })))).toBe(1)
    expect(pages(await manifestPdf(sheet({ shipments: [], closedBySystem: true })))).toBe(1)
  })

  it('runs over several pages when the day was long', async () => {
    const long = await manifestPdf(sheet({ shipments: Array.from({ length: 60 }, (_, index) => row(index + 1)) }))
    expect(pages(long)).toBeGreaterThan(2)
  })
})
