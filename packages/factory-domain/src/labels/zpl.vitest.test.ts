import { describe, expect, it } from 'vitest'
import { formatScanId, tenantTag } from '../numbering/scan-id'
import { composeLabel } from './model'
import { dotsOf, fitText, labelZpl, stockProblems, zplText } from './zpl'

// Golden ZPL: the exact text a label printer receives. A change here changes every printed label; review it on a
// printer (or labelary.com's viewer) before updating these strings.

const TAG = tenantTag('0199f0a0-0000-7000-8000-000000000001')
const STOCK_203 = { widthMm: 100, heightMm: 50, dpi: 203 }

const hide = () =>
  composeLabel({
    kind: 'HIDE',
    language: 'it',
    scanId: formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4321 }),
    maker: 'Seed A',
    title: 'Nappa 1.2 nero',
    fields: { colour: 'Nero', grade: 'A', area: '5,42 m²', lot: 'LT-0001' },
  })

describe('labelZpl (golden)', () => {
  it('prints a hide label at 203 dpi on 100 × 50 mm: the scannable id as a Code 128 (^BC) and as text', () => {
    expect(TAG).toBe('6F')
    expect(labelZpl(hide(), STOCK_203, 2)).toBe(
      [
        '^XA',
        '^CI28',
        '^PW799',
        '^LL400',
        '^LH0,0',
        '^FO20,20^A0N,20,20^FH^FDPelle _C2_B7 Seed A^FS',
        '^FO20,44^A0N,32,32^FH^FDNappa 1.2 nero^FS',
        '^FO20,84^BY2,3,80^BCN,80,N,N,N^FDHD-6F-000471-X^FS',
        '^FO20,172^A0N,28,28^FH^FDHD-6F-000471-X^FS',
        '^FO20,212^A0N,16,16^FH^FDColore^FS',
        '^FO20,230^A0N,24,24^FH^FDNero^FS',
        '^FO399,212^A0N,16,16^FH^FDScelta^FS',
        '^FO399,230^A0N,24,24^FH^FDA^FS',
        '^FO20,260^A0N,16,16^FH^FDSuperficie^FS',
        '^FO20,278^A0N,24,24^FH^FD5,42 m_C2_B2^FS',
        '^FO399,260^A0N,16,16^FH^FDLotto^FS',
        '^FO399,278^A0N,24,24^FH^FDLT-0001^FS',
        '^PQ2',
        '^XZ',
        '',
      ].join('\n'),
    )
  })

  it('prints a bundle ticket at 300 dpi in English, escaping ZPL command characters in the data', () => {
    const bundle = composeLabel({
      kind: 'BUNDLE',
      language: 'en',
      scanId: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 70000 }),
      maker: 'Seed_A^~',
      title: 'Style JKT-01 Touring',
      fields: { workOrder: 'WO-2026-0012', size: '50', pieces: '12', operation: 'Sewing', colour: 'Nero' },
    })
    expect(labelZpl(bundle, { widthMm: 100, heightMm: 50, dpi: 300 })).toBe(
      [
        '^XA',
        '^CI28',
        '^PW1181',
        '^LL591',
        '^LH0,0',
        '^FO30,30^A0N,30,30^FH^FDBundle _C2_B7 Seed_5FA_5E_7E^FS',
        '^FO30,65^A0N,47,47^FH^FDStyle JKT-01 Touring^FS',
        '^FO30,124^BY3,3,118^BCN,118,N,N,N^FDBN-6F-0024BG-Y^FS',
        '^FO30,254^A0N,41,41^FH^FDBN-6F-0024BG-Y^FS',
        '^FO30,313^A0N,24,24^FH^FDWork order^FS',
        '^FO30,339^A0N,35,35^FH^FDWO-2026-0012^FS',
        '^FO590,313^A0N,24,24^FH^FDSize^FS',
        '^FO590,339^A0N,35,35^FH^FD50^FS',
        '^FO30,384^A0N,24,24^FH^FDColour^FS',
        '^FO30,410^A0N,35,35^FH^FDNero^FS',
        '^FO590,384^A0N,24,24^FH^FDPieces^FS',
        '^FO590,410^A0N,35,35^FH^FD12^FS',
        '^FO30,455^A0N,24,24^FH^FDOperation^FS',
        '^FO30,481^A0N,35,35^FH^FDSewing^FS',
        '^PQ1',
        '^XZ',
        '',
      ].join('\n'),
    )
  })

  it('prints a carton label on 4 × 6 inch stock, cutting a value that does not fit its column', () => {
    const carton = composeLabel({
      kind: 'CARTON',
      language: 'it',
      scanId: formatScanId({ type: 'CARTON', tenantTag: TAG, ref: 12 }),
      maker: 'Seed A',
      title: 'Ordine SO-2026-0042',
      fields: { customer: 'Example Customer S.r.l. with a very long name that will not fit on the line', carton: '3/12', grossWeight: '8,4 kg' },
    })
    const zpl = labelZpl(carton, { widthMm: 102, heightMm: 152, dpi: 203 })
    expect(zpl).toContain('^PW815\n^LL1215\n')
    expect(zpl).toContain('^FO20,84^BY2,3,80^BCN,80,N,N,N^FDCT-6F-00000C-G^FS')
    expect(zpl).toContain('^FO20,230^A0N,24,24^FH^FDExample Customer S.r.l. ...^FS')
    expect(zpl).toContain('^FO407,212^A0N,16,16^FH^FDCollo^FS')
  })

  it('makes the same text from the same label, and only printable ASCII', () => {
    expect(labelZpl(hide(), STOCK_203)).toBe(labelZpl(hide(), STOCK_203))
    expect(labelZpl(hide(), STOCK_203)).toMatch(/^[\x20-\x7e\n]+$/)
  })

  it('refuses a stock the layout does not fit and a copy count out of range', () => {
    expect(stockProblems({ widthMm: 57, heightMm: 32, dpi: 203 }).map((problem) => problem.path)).toEqual(['printer/labelWidthMm', 'printer/labelHeightMm'])
    expect(stockProblems({ widthMm: 100, heightMm: 50, dpi: 150 }).map((problem) => problem.path)).toEqual(['printer/dpi'])
    expect(() => labelZpl(hide(), { widthMm: 57, heightMm: 32, dpi: 203 })).toThrow(RangeError)
    expect(() => labelZpl(hide(), STOCK_203, 0)).toThrow(RangeError)
    expect(() => labelZpl(hide(), STOCK_203, 501)).toThrow(RangeError)
  })
})

describe('ZPL helpers', () => {
  it('escapes ^ ~ _ and every non-ASCII character as UTF-8 hex for ^FH', () => {
    expect(zplText('^XZ~JA_')).toBe('_5EXZ_7EJA_5F')
    expect(zplText('Qualità €')).toBe('Qualit_C3_A0 _E2_82_AC')
    expect(zplText('plain text 123-/')).toBe('plain text 123-/')
  })

  it('turns hundredths of a millimetre into dots with integer arithmetic', () => {
    expect(dotsOf(10_000, 203)).toBe(799)
    expect(dotsOf(25, 203)).toBe(2)
    expect(dotsOf(25, 300)).toBe(3)
    expect(dotsOf(25, 600)).toBe(6)
  })

  it('cuts text to the width it gets', () => {
    expect(fitText('short', 400, 24)).toBe('short')
    expect(fitText('x'.repeat(100), 132, 24)).toBe(`${'x'.repeat(7)}...`)
  })
})
