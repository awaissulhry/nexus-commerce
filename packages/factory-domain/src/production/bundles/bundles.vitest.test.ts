import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../core/errors'
import { composeLabel } from '../../labels/model'
import { formatScanId, tenantTag } from '../../numbering/scan-id'
import { floorPrivacyStatus, floorReadiness, NO_DPIA_NOTE } from '../../privacy/readiness'
import { floorRulesStatus } from '../settings/monitoring'
import {
  bundlesReadyRefusal,
  cellBundles,
  DEFAULT_BUNDLE_SIZE,
  planBundles,
  reprintRefusal,
  scannedBundleRefusal,
  splitBundles,
  voidRefusal,
  type CellCut,
  type PlanCell,
  type PlanFacts,
} from './rules'
import { bundleTicketZpl, operationLines, ticketLabel, type BundleTicket } from './ticket'

// Figures by hand. Cell BLK 50 of 12 jackets: its leather parts are the outer shell (12 pieces cut) and a collar (13: one
// recut over); so 12 whole garments are cut. Cell BLK 52 of 6 has nothing cut yet. A lining cell has no part cut from hides.
const c50: CellCut = { cellId: 'c50', quantity: 12, cut: 12, parts: [{ part: 'Collar', pieces: 13, planned: true }, { part: 'Outer shell', pieces: 12, planned: true }, { part: 'Shell recut', pieces: 1, planned: false }] }
const c52: CellCut = { cellId: 'c52', quantity: 6, cut: 0, parts: [{ part: 'Collar', pieces: 0, planned: true }, { part: 'Outer shell', pieces: 0, planned: true }] }
const lining: CellCut = { cellId: 'lin', quantity: 4, cut: null, parts: [] }

const cell = (cut: CellCut, label: string, bundles: Parameters<typeof cellBundles>[1] = []): PlanCell => ({ ...cellBundles(cut, bundles), label })
const workOrder = { number: 'WO-00042', status: 'RELEASED' as const, kind: 'SIZE_GRID' as const }
const facts = (overrides: Partial<PlanFacts> = {}): PlanFacts => ({ workOrder, cells: [cell(c50, 'BLK 50'), cell(c52, 'BLK 52')], asks: null, ...overrides })

describe('what a cell still has to bundle (MES-065)', () => {
  it('counts whole garments against every part and part bundles against their part; a cell not cut from hides has nothing', () => {
    expect(cellBundles(c50, [])).toEqual({
      cellId: 'c50',
      quantity: 12,
      cut: 12,
      bundled: 0,
      toBundle: 12,
      parts: [
        { part: 'Collar', pieces: 13, bundled: 0, toBundle: 13 },
        { part: 'Outer shell', pieces: 12, bundled: 0, toBundle: 12 },
      ],
    })
    // 5 whole garments take 5 of every part.
    const five = cellBundles(c50, [{ cellId: 'c50', part: null, quantity: 5 }, { cellId: 'c52', part: null, quantity: 9 }])
    expect(five).toMatchObject({ bundled: 5, toBundle: 7, parts: [{ part: 'Collar', bundled: 5, toBundle: 8 }, { part: 'Outer shell', bundled: 5, toBundle: 7 }] })
    // 4 collars travelling on their own: min(12 − 0, 13 − 4) − 5 = 4 whole garments are left.
    const collars = cellBundles(c50, [{ cellId: 'c50', part: null, quantity: 5 }, { cellId: 'c50', part: 'Collar', quantity: 4 }])
    expect(collars).toMatchObject({ bundled: 5, toBundle: 4, parts: [{ part: 'Collar', bundled: 9, toBundle: 4 }, { part: 'Outer shell', bundled: 5, toBundle: 7 }] })
    expect(cellBundles(lining, [])).toEqual({ cellId: 'lin', quantity: 4, cut: null, bundled: 0, toBundle: 0, parts: [] })
  })

  it('splits garments into bundles of the size, the last one taking the rest', () => {
    expect(splitBundles(12, 5)).toEqual([5, 5, 2])
    expect(splitBundles(10, 5)).toEqual([5, 5])
    expect(splitBundles(3, 10)).toEqual([3])
    expect(splitBundles(0, 5)).toEqual([])
    expect(() => splitBundles(4, 0)).toThrow(RangeError)
  })
})

describe('a request to make bundles', () => {
  it('bundles everything cut, not bundled, in bundles of the asked size or the default one', () => {
    expect(planBundles(facts({ bundleSize: 5 }))).toEqual({
      ok: true,
      singlePiece: false,
      bundles: [
        { cellId: 'c50', part: null, quantity: 5 },
        { cellId: 'c50', part: null, quantity: 5 },
        { cellId: 'c50', part: null, quantity: 2 },
      ],
    })
    expect(DEFAULT_BUNDLE_SIZE).toBe(10)
    expect(planBundles(facts())).toMatchObject({ ok: true, bundles: [{ quantity: 10 }, { quantity: 2 }] })
    // The screen's own quantities, a part bundle, and a share of a cell.
    expect(planBundles(facts({ asks: [{ cellId: 'c50', quantities: [6, 6] }] }))).toMatchObject({ ok: true, bundles: [{ quantity: 6 }, { quantity: 6 }] })
    expect(planBundles(facts({ asks: [{ cellId: 'c50', part: 'Collar', quantity: 13, bundleSize: 13 }] }))).toMatchObject({ ok: true, bundles: [{ cellId: 'c50', part: 'Collar', quantity: 13 }] })
    expect(planBundles(facts({ asks: [{ cellId: 'c50', quantity: 7, bundleSize: 4 }] }))).toMatchObject({ ok: true, bundles: [{ quantity: 4 }, { quantity: 3 }] })
  })

  it('never bundles more than was cut and not yet bundled, in words', () => {
    const over = planBundles(facts({ asks: [{ cellId: 'c50', quantity: 13 }] }))
    expect(over).toEqual({ ok: false, refusal: { code: 'MORE_THAN_CUT', message: 'BLK 50 has 12 cut garments not in bundles; 13 asked. A bundle never holds more than was cut.' } })
    expect(planBundles(facts({ asks: [{ cellId: 'c50', quantities: [7, 6] }] }))).toMatchObject({ ok: false, refusal: { code: 'MORE_THAN_CUT' } })
    const bundled = [cell(c50, 'BLK 50', [{ cellId: 'c50', part: null, quantity: 12 }]), cell(c52, 'BLK 52')]
    expect(planBundles(facts({ cells: bundled }))).toEqual({ ok: false, refusal: { code: 'NOTHING_TO_BUNDLE', message: 'Nothing cut is waiting for bundles on work order WO-00042.' } })
    expect(planBundles(facts({ cells: bundled, asks: [{ cellId: 'c50' }] }))).toEqual({ ok: false, refusal: { code: 'NOTHING_TO_BUNDLE', message: 'BLK 50: nothing cut is waiting for bundles (12 cut, 12 in bundles).' } })
    expect(planBundles(facts({ asks: [{ cellId: 'c50', part: 'Sleeve' }] }))).toMatchObject({ ok: false, refusal: { code: 'NOT_A_PART', message: expect.stringContaining('its parts are Collar, Outer shell') } })
    expect(planBundles(facts({ cells: [cell(lining, 'LIN 50')], asks: [{ cellId: 'lin' }] }))).toMatchObject({ ok: false, refusal: { code: 'NOT_CUT_FROM_HIDES' } })
    expect(planBundles(facts({ workOrder: { ...workOrder, status: 'COMPLETED' } }))).toMatchObject({ ok: false, refusal: { code: 'WORK_ORDER_NOT_OPEN' } })
    const many: CellCut = { cellId: 'm', quantity: 101, cut: 101, parts: [{ part: 'Outer shell', pieces: 101, planned: true }] }
    expect(planBundles(facts({ cells: [cell(many, 'BLK 54')], bundleSize: 1 }))).toMatchObject({ ok: false, refusal: { code: 'TOO_MANY_BUNDLES' } })
  })

  it('keeps a made-to-measure unit to one garment per bundle (single-piece mode, MES-068)', () => {
    const unit: CellCut = { cellId: 'u', quantity: 1, cut: 1, parts: [{ part: 'Outer shell', pieces: 1, planned: true }] }
    const mtm = { ...workOrder, kind: 'MADE_TO_MEASURE' as const }
    expect(planBundles(facts({ workOrder: mtm, cells: [cell(unit, 'BLK MTM')] }))).toEqual({ ok: true, singlePiece: true, bundles: [{ cellId: 'u', part: null, quantity: 1 }] })
    expect(planBundles(facts({ workOrder: mtm, cells: [cell(unit, 'BLK MTM')], bundleSize: 5 }))).toMatchObject({ ok: false, refusal: { code: 'SINGLE_PIECE' } })
  })

  it('refuses a request that does not hold together (a 400 with every problem)', () => {
    const problems = (asks: PlanFacts['asks']) => {
      try {
        planBundles(facts({ asks }))
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
        return ((error as ValidationError).issues ?? []).map((issue) => issue.path)
      }
      throw new Error('no ValidationError')
    }
    expect(problems([{ cellId: 'nope' }, { cellId: 'c50', quantity: 5, quantities: [4] }, { cellId: 'c50' }])).toEqual(['body/cells/0/workOrderSizeId', 'body/cells/1/quantity', 'body/cells/2'])
    expect(problems([{ cellId: 'c50', quantities: [4], bundleSize: 4 }])).toEqual(['body/cells/0/bundleSize'])
    expect(problems([])).toEqual(['body/cells'])
  })
})

describe('reprint, void and the scan of an old ticket (MES-073)', () => {
  it('reprints and voids only an ACTIVE bundle of an open work order; voids one only before any scan names it', () => {
    const bundle = { code: 'BN-A', status: 'ACTIVE' as const, replacedCodes: [] }
    expect(reprintRefusal({ bundle, workOrder })).toBeNull()
    expect(reprintRefusal({ bundle: { ...bundle, status: 'VOID' }, workOrder })).toMatchObject({ code: 'VOIDED' })
    expect(reprintRefusal({ bundle, workOrder: { ...workOrder, status: 'CLOSED' } })).toMatchObject({ code: 'WORK_ORDER_NOT_OPEN' })
    expect(voidRefusal({ bundle, workOrder, scans: 0 })).toBeNull()
    expect(voidRefusal({ bundle, workOrder, scans: 2 })).toEqual({ code: 'SCANNED', message: 'Bundle BN-A was scanned already (2 scans): a bundle is voided only before any scan names it. Undo or correct its scans instead.' })
    expect(voidRefusal({ bundle: { ...bundle, status: 'VOID' }, workOrder, scans: 0 })).toMatchObject({ code: 'VOIDED' })
    expect(voidRefusal({ bundle, workOrder: { ...workOrder, status: 'CANCELLED' }, scans: 0 })).toMatchObject({ code: 'WORK_ORDER_NOT_OPEN' })
  })

  it('refuses an old ticket with the new code in the words, and a voided bundle', () => {
    const bundle = { code: 'BN-NEW', status: 'ACTIVE' as const, replacedCodes: ['BN-OLD'] }
    expect(scannedBundleRefusal(bundle, 'BN-NEW')).toBeNull()
    expect(scannedBundleRefusal(bundle, 'BN-OLD')).toEqual({ code: 'REPLACED', message: 'Ticket BN-OLD was replaced by BN-NEW: use the new ticket.' })
    expect(scannedBundleRefusal({ ...bundle, status: 'VOID' }, 'BN-NEW')).toMatchObject({ code: 'VOIDED' })
    expect(scannedBundleRefusal({ ...bundle, status: 'VOID' }, 'BN-OLD')).toMatchObject({ code: 'REPLACED', message: expect.stringContaining('voided too') })
  })

  it("holds bundles while the site's floor is not ready, in the gate's words", () => {
    const privacy = (dpia: boolean) => floorPrivacyStatus({ dpia: dpia ? { versionNo: 1, reviewDueOn: null } : null, workerNotice: { label: '2026-10' }, today: '2026-11-20' })
    const rules = (basis: boolean) => floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: basis })
    expect(bundlesReadyRefusal(floorReadiness(privacy(true), rules(true)))).toBeNull()
    expect(bundlesReadyRefusal(floorReadiness(privacy(false), rules(true)))).toEqual({ code: 'FLOOR_NOT_READY', message: `Bundles are held at this site until its floor is ready: ${NO_DPIA_NOTE}` })
    expect(bundlesReadyRefusal(floorReadiness(privacy(true), rules(false)))).toMatchObject({ message: expect.stringContaining('no legal basis is on record') })
    expect(bundlesReadyRefusal(null)).toMatchObject({ code: 'FLOOR_NOT_READY' })
  })
})

describe("a bundle's ticket (MES-066)", () => {
  const tag = tenantTag('7c9e6679-7425-40de-944b-e07fc1f90ae7')
  const ticket: BundleTicket = {
    code: formatScanId({ type: 'BUNDLE', tenantTag: tag, ref: 42 }),
    language: 'it',
    maker: 'Made-up Leather Srl',
    workOrder: { number: 'WO-00042', batchNumber: 'BA-00007' },
    style: { code: 'JKT-02', name: 'Touring jacket' },
    colourway: { code: 'BLK', name: 'Nero' },
    size: '52',
    quantity: 5,
    part: null,
    operations: [
      { seq: 10, code: 'CUT', name: 'Taglio pelle' },
      { seq: 20, code: 'SEW', name: 'Cucitura e montaggio' },
      { seq: 30, code: 'QC', name: 'Controllo finale' },
      { seq: 40, code: 'PACK', name: 'Imballo' },
    ],
  }

  it('is the BUNDLE label of the work order, batch, style, colourway, size, garments and operations (the PDF fallback)', () => {
    const label = composeLabel(ticketLabel(ticket), { tenantTag: tag })
    expect(label).toMatchObject({ kind: 'BUNDLE', scanId: ticket.code, heading: 'Fascio · Made-up Leather Srl', title: 'Touring jacket' })
    expect(label.fields.map((field) => [field.label, field.value])).toEqual([
      ['Ordine di lavoro', 'WO-00042 · BA-00007'],
      ['Modello', 'JKT-02'],
      ['Taglia', '52'],
      ['Colore', 'BLK Nero'],
      ['Pezzi', '5'],
      ['Fase', '10 · 20 · 30 · 40'],
    ])
    expect(ticketLabel({ ...ticket, part: 'Collar', quantity: 3 }).fields?.pieces).toBe('3 · Collar')
    // Another factory's code is not printed on our ticket.
    expect(() => composeLabel(ticketLabel(ticket), { tenantTag: tag === '00' ? '11' : '00' })).toThrow(ValidationError)
  })

  it('prints the operations below the fields where the stock has room; on short stock only their numbers', () => {
    // 100 × 100 mm at 203 dpi: the fields end at 44.5 mm; 55.5 mm − 2.5 mm margin − 1 mm gap = 15 lines of 3.3 mm.
    const tall = bundleTicketZpl(ticket, { widthMm: 100, heightMm: 100, dpi: 203 }, 1, { tenantTag: tag })
    expect(tall).toContain(`^BCN,80,N,N,N^FD${ticket.code}^FS`)
    for (const line of ['10 CUT Taglio pelle', '20 SEW Cucitura e montaggio', '30 QC Controllo finale', '40 PACK Imballo']) expect(tall).toContain(`^FD${line}^FS`)
    expect(tall.indexOf('40 PACK Imballo')).toBeLessThan(tall.indexOf('^PQ1'))
    expect(tall.trimEnd().endsWith('^XZ')).toBe(true)
    // 100 × 50 mm: no room below the fields; the "Fase" field carries the numbers.
    const short = bundleTicketZpl(ticket, { widthMm: 100, heightMm: 50, dpi: 203 }, 2)
    expect(short).not.toContain('Taglio pelle')
    expect(short).toContain('10 _C2_B7 20 _C2_B7 30 _C2_B7 40')
    expect(short).toContain('^PQ2')
    expect(operationLines(ticket, 3)).toEqual(['10 CUT Taglio pelle', '20 SEW Cucitura e montaggio', '+2 altre fasi'])
    expect(operationLines({ ...ticket, language: 'en' }, 2)).toEqual(['10 CUT Taglio pelle', '+3 more operations'])
    expect(operationLines(ticket, 1)).toEqual([])
  })
})
