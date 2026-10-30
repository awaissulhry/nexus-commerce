import { describe, expect, it } from 'vitest'
import type { ItemUnits } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import { lotBasesOf, orderQuantityOf, receivedBase, receivedShapeProblems, receivedUnitOf } from './conversion'
import { discrepancyNote, kindAndReason, nextDiscrepancySeq, readDiscrepancyNote, reportSelection, settleProblems, discrepancyQuantityProblems, discrepancyEditProblem } from './discrepancies'
import { hideListBody, hideListImporter, hideListTotals, lineOfRow, listProblems, planHide, receivedHideValues, type HideListOrderLine } from './hide-list'
import { discrepancyReport, discrepancyReportMail } from './report'

/**
 * Receiving every day (B-W2a-31; SCM-115, SCM-118, SCM-123, SCM-248), the pure parts: discrepancies (kind and reason,
 * the note's code, the moves), the report's words, the supplier's unit at receipt (rounded as the database's trigger
 * rounds) and the tannery's hide list (rows → one receipt, totals against the order). Numbers worked by hand.
 */

const STANDARD = new Set(['SHORT', 'OVER', 'WRONG_ITEM', 'DAMAGED'])

describe('a discrepancy: its kind and its reason code', () => {
  it('a standard reason is also a kind, either gives the other', () => {
    expect(kindAndReason({ reasonCode: 'DAMAGED' }, STANDARD)).toEqual({ kind: 'DAMAGED', reasonCode: 'DAMAGED' })
    expect(kindAndReason({ kind: 'SHORT' }, STANDARD)).toEqual({ kind: 'SHORT', reasonCode: 'SHORT' })
    // A kind the list has no code for: no reason code.
    expect(kindAndReason({ kind: 'WRONG_COLOUR' }, STANDARD)).toEqual({ kind: 'WRONG_COLOUR', reasonCode: null })
    // Lower case is read as the code.
    expect(kindAndReason({ reasonCode: ' over ' }, STANDARD)).toEqual({ kind: 'OVER', reasonCode: 'OVER' })
  })

  it("a tenant's own reason needs the kind; a code that is another kind refuses; an inactive code refuses", () => {
    const own = new Set([...STANDARD, 'STAINS'])
    expect(kindAndReason({ reasonCode: 'STAINS' }, own)).toEqual({ problems: [expect.objectContaining({ path: 'body/kind' })] })
    expect(kindAndReason({ reasonCode: 'STAINS', kind: 'DAMAGED' }, own)).toEqual({ kind: 'DAMAGED', reasonCode: 'STAINS' })
    expect(kindAndReason({ reasonCode: 'SHORT', kind: 'DAMAGED' }, own)).toEqual({ problems: [{ path: 'body/kind', message: 'The reason SHORT is a short delivery: its kind is SHORT, not DAMAGED.' }] })
    expect(kindAndReason({ reasonCode: 'HOLES', kind: 'DAMAGED' }, own)).toEqual({ problems: [expect.objectContaining({ path: 'body/reasonCode', message: expect.stringContaining('HOLES is not an active reason') })] })
    expect(kindAndReason({}, own)).toEqual({ problems: [expect.objectContaining({ path: 'body/kind' })] })
  })

  it('the code leads the note and is read back only for a code the list knows', () => {
    expect(discrepancyNote('DAMAGED', ' two hides with holes ')).toBe('DAMAGED: two hides with holes')
    expect(discrepancyNote('SHORT', null)).toBe('SHORT')
    expect(discrepancyNote(null, '  ')).toBeNull()
    expect(readDiscrepancyNote('DAMAGED: two hides with holes', STANDARD)).toEqual({ reasonCode: 'DAMAGED', note: 'two hides with holes' })
    expect(readDiscrepancyNote('SHORT', STANDARD)).toEqual({ reasonCode: 'SHORT', note: null })
    // Words that only look like a code stay the note.
    expect(readDiscrepancyNote('NOTE: the box was open', STANDARD)).toEqual({ reasonCode: null, note: 'NOTE: the box was open' })
    expect(readDiscrepancyNote(null, STANDARD)).toEqual({ reasonCode: null, note: null })
  })

  it('a quantity comes with its unit, above 0, four decimals at most', () => {
    expect(discrepancyQuantityProblems(null, null)).toEqual([])
    expect(discrepancyQuantityProblems('12.5', 'FT2')).toEqual([])
    expect(discrepancyQuantityProblems('12.5', null)).toEqual([{ path: 'body/uom', message: 'Give the quantity and its unit together, or neither.' }])
    expect(discrepancyQuantityProblems(null, 'PCS')).toEqual([{ path: 'body/quantity', message: 'Give the quantity and its unit together, or neither.' }])
    expect(discrepancyQuantityProblems('0', 'PCS')).toEqual([{ path: 'body/quantity', message: 'Above 0.' }])
    expect(discrepancyQuantityProblems('1.23456', 'M')).toEqual([{ path: 'body/quantity', message: 'At most 4 decimals.' }])
  })

  it('numbers 10, 20 …; changes only while OPEN; settles as the trigger allows', () => {
    expect(nextDiscrepancySeq([])).toBe(10)
    expect(nextDiscrepancySeq([10, 30])).toBe(40)
    expect(discrepancyEditProblem('OPEN', 'change')).toBeNull()
    expect(discrepancyEditProblem('SENT', 'remove')).toMatch(/never removed/)
    expect(settleProblems('SENT', 'AGREED', null)).toEqual([])
    expect(settleProblems('AGREED', 'CREDITED', 'credit note 77')).toEqual([])
    expect(settleProblems('OPEN', 'AGREED', null)).toEqual([{ path: 'body/to', message: 'Only a discrepancy reported to the supplier (SENT) is agreed: send the report first.' }])
    expect(settleProblems('SENT', 'CREDITED', null)).toEqual([{ path: 'body/to', message: 'Only a discrepancy the supplier agreed (AGREED) is credited.' }])
    expect(settleProblems('OPEN', 'CLOSED', '')).toEqual([{ path: 'body/note', message: 'Say what settled it, or why it is not pursued.' }])
    expect(settleProblems('CLOSED', 'CLOSED', 'again')).toEqual([{ path: 'body/to', message: 'It is closed: it changes no more.' }])
  })

  it('a report names the OPEN ones by default; SENT ones may go again; answered ones refuse', () => {
    const rows = [
      { id: 'a', seq: 10, status: 'OPEN' as const },
      { id: 'b', seq: 20, status: 'SENT' as const },
      { id: 'c', seq: 30, status: 'AGREED' as const },
    ]
    expect(reportSelection(rows, null)).toEqual({ chosen: ['a'], toSend: ['a'], problems: [] })
    expect(reportSelection(rows, ['a', 'b'])).toEqual({ chosen: ['a', 'b'], toSend: ['a'], problems: [] })
    expect(reportSelection(rows, ['c', 'x']).problems).toEqual([
      { path: 'body/discrepancyIds/0', message: 'Discrepancy 30 is agreed: the supplier answered it already.' },
      { path: 'body/discrepancyIds/1', message: 'Not a discrepancy of this receipt.' },
    ])
    expect(reportSelection(rows.slice(1), null).problems).toEqual([{ path: 'body/discrepancyIds', message: 'Nothing is open to report: every discrepancy of this receipt was reported or closed.' }])
  })
})

describe('the report to the supplier: words, no price', () => {
  const input = {
    language: 'it' as const,
    date: '2026-10-30',
    company: { name: 'Example Pelletteria S.r.l.', lines: ['Via Prova 1, 50100 Firenze (FI)'], legal: 'Example Pelletteria S.r.l. · P. IVA IT00000000000' },
    supplier: { name: 'Example Tannery S.p.A.', address: 'Via Concia 2, 56029 Santa Croce (PI)', vatNumber: 'IT00000002022' },
    receipt: { number: 'GR-2026-0007', receivedOn: '2026-10-29', site: 'A1 Example site', supplierDdtNumber: 'DDT-881', supplierDdtDate: '2026-10-28', purchaseOrderNumber: 'PO-2026-0042' },
    lines: [
      { seq: 20, kind: 'SHORT' as const, reason: 'Quantità mancante', material: { code: 'LEA-100', name: 'Vacchetta', colour: 'Nero', orderLine: 10, supplierCode: 'VAC-N' }, quantity: '12.5', uom: 'FT2' as const, note: null, photos: 0 },
      { seq: 10, kind: 'DAMAGED' as const, reason: 'Macchie', material: null, quantity: null, uom: null, note: 'Scatola schiacciata', photos: 2 },
    ],
    sample: true,
  }

  it('prints the receipt, the supplier and each discrepancy in the supplier language, in order', () => {
    const report = discrepancyReport(input)
    expect(report.title).toBe('Rapporto di non conformità della consegna')
    expect(report.sample).toBe('ANTEPRIMA - non inviato')
    expect(report.facts).toEqual([
      { label: 'Nostro ricevimento', value: 'GR-2026-0007' },
      { label: 'Ricevuto il', value: '29/10/2026' },
      { label: 'Luogo di ricevimento', value: 'A1 Example site' },
      { label: 'Vostro DDT', value: 'DDT-881 · 28/10/2026' },
      { label: 'Nostro ordine', value: 'PO-2026-0042' },
      { label: 'Data del rapporto', value: '30/10/2026' },
    ])
    expect(report.supplier.lines).toEqual(['Example Tannery S.p.A.', 'Via Concia 2, 56029 Santa Croce (PI)', 'P. IVA IT00000002022'])
    expect(report.rows).toEqual([
      { seq: '10', material: 'Consegna nel suo insieme', kind: 'Danneggiato: Macchie', quantity: '', note: 'Scatola schiacciata · 2 foto' },
      // The standard reason's words are the kind's: printed once.
      { seq: '20', material: 'LEA-100 Vacchetta · Nero · vs. cod. VAC-N · riga ordine 10', kind: 'Quantità mancante', quantity: '12,5 ft²', note: '' },
    ])
    expect(report.fileName).toBe('Rapporto-non-conformita-GR-2026-0007.pdf')
    expect(JSON.stringify(report)).not.toMatch(/€|price|prezzo|cost/i)
  })

  it('the mail: the standard text, or the office own words', () => {
    expect(discrepancyReportMail({ language: 'en', receiptNumber: 'GR-2026-0007', supplierDdtNumber: 'DDT-881', count: 2, recipientName: 'Order Desk', message: null })).toEqual({
      subject: 'Delivery discrepancies GR-2026-0007 (your delivery note DDT-881)',
      body: 'Dear Order Desk,\n\nattached is the report of the 2 discrepancies we found in the delivery GR-2026-0007 (your delivery note DDT-881). Please reply and tell us how you will settle them.\n\nKind regards',
    })
    expect(discrepancyReportMail({ language: 'it', receiptNumber: 'GR-2026-0007', supplierDdtNumber: null, count: 1, recipientName: null, message: 'Vedi foto.' }).body).toBe('Buongiorno,\n\nVedi foto.\n\nCordiali saluti')
  })
})

describe("the supplier's unit at receipt", () => {
  // Protectors counted in PCS, bought in BOX of 10; a fabric in M2 bought in M of 1.40 m width.
  const protector: ItemUnits = { baseUom: 'PCS', purchaseUom: 'BOX', purchaseFactor: '10', consumptionUom: 'PCS', consumptionFactor: '1' }
  const fabric: ItemUnits = { baseUom: 'M2', purchaseUom: 'M', purchaseFactor: '1.4', consumptionUom: 'M2', consumptionFactor: '1' }

  it('rounds quantity × factor to four decimals, half away from zero (the trigger round())', () => {
    expect(receivedBase('3', '10').toFixed(4)).toBe('30.0000')
    expect(receivedBase('2.5', '0.00005').toFixed(4)).toBe('0.0001')
    expect(receivedBase('1', '0.33335').toFixed(4)).toBe('0.3334')
  })

  it("the material's own factor, a given one for a unit of its own size, refusals in words", () => {
    expect(receivedUnitOf('BOX', null, protector)).toEqual({ unit: { uom: 'BOX', factor: '10.00000000' } })
    // A box of 12 this time: BOX is a unit of its own size, the factor given wins.
    expect(receivedUnitOf('BOX', '12', protector)).toEqual({ unit: { uom: 'BOX', factor: '12.00000000' } })
    expect(receivedUnitOf('M', null, fabric)).toEqual({ unit: { uom: 'M', factor: '1.40000000' } })
    // A metre of this fabric is 1.4 m²: another factor is a mistake.
    expect(receivedUnitOf('M', '1.5', fabric)).toEqual({ problems: [{ path: 'receivedFactor', message: 'One M is 1.4 M2 for this material; leave the factor out, or receive in a unit of its own size.' }] })
    expect(receivedUnitOf('ROLL', null, fabric)).toEqual({ problems: [expect.objectContaining({ path: 'receivedFactor', message: expect.stringContaining('does not convert ROLL') })] })
    expect(receivedUnitOf('ROLL', '48.5', fabric)).toEqual({ unit: { uom: 'ROLL', factor: '48.50000000' } })
    expect(receivedUnitOf('PCS', '2', protector)).toEqual({ problems: [{ path: 'receivedFactor', message: "PCS is the material's own unit: its factor is 1." }] })
    expect(receivedUnitOf('BOX', '0', protector)).toEqual({ problems: [{ path: 'receivedFactor', message: 'Above 0.' }] })
  })

  it("lots' bases add up to the line's exactly (the remainder on the largest lot)", () => {
    // 1 + 1 + 2 units of 0.33333333: each 0.3333, 0.3333, 0.6667 = 1.3333; the line round(4 × 0.33333333) = 1.3333.
    expect(lotBasesOf(['1', '1', '2'], '0.33333333')).toEqual({ lineBase: new Dec('1.3333'), lots: [new Dec('0.3333'), new Dec('0.3333'), new Dec('0.6667')] })
    // 1 + 1: 0.6667 for the line, 0.3333 + 0.3333 = 0.6666, the first largest takes the 0.0001.
    const two = lotBasesOf(['1', '1'], '0.33333333')
    expect(two.lineBase.toFixed(4)).toBe('0.6667')
    expect(two.lots.map((lot) => lot.toFixed(4))).toEqual(['0.3334', '0.3333'])
  })

  it("the line's quantity against the order: the same unit, else the order line's own ratio", () => {
    expect(orderQuantityOf({ quantity: '3', uom: 'BOX', baseQuantity: '30' }, { uom: 'BOX', quantity: '10', baseQuantity: '100' }).toString()).toBe('3')
    expect(orderQuantityOf({ quantity: '3', uom: 'BOX', baseQuantity: '30' }, { uom: 'PCS', quantity: '100', baseQuantity: '100' }).toString()).toBe('30')
    expect(orderQuantityOf({ quantity: '7', uom: 'M', baseQuantity: '9.8' }, { uom: 'M2', quantity: '14', baseQuantity: '14' }).toString()).toBe('9.8')
  })

  it('what a line sends for its tracking', () => {
    expect(receivedShapeProblems({}, 'NONE')).toEqual([])
    expect(receivedShapeProblems({ receivedQuantity: '3', receivedUom: 'BOX' }, 'NONE')).toEqual([])
    expect(receivedShapeProblems({ receivedQuantity: '3', quantity: '30' }, 'NONE')).toEqual([{ path: 'quantity', message: "Received in the supplier's unit: give the quantity as receivedQuantity, not quantity." }])
    expect(receivedShapeProblems({ receivedUom: 'BOX' }, 'NONE')).toEqual([{ path: 'receivedQuantity', message: "How many came, in the supplier's unit?" }])
    expect(receivedShapeProblems({ receivedUom: 'BOX', receivedQuantity: '1', lots: [] }, 'LOT')).toEqual([{ path: 'receivedQuantity', message: "A lot-tracked line is counted by its lots (in the received unit): leave the line's received quantity out." }])
    expect(receivedShapeProblems({ receivedUom: 'FT2' }, 'HIDE')).toEqual([{ path: 'receivedUom', message: 'Leather is received hide by hide, each in the unit it was measured in: leave the received unit out.' }])
  })
})

describe("the tannery's hide list", () => {
  const leather = (extra: Partial<HideListOrderLine> = {}): HideListOrderLine => ({ id: 'l10', seq: 10, itemCode: 'LEA-100', supplierArticleCode: 'VAC-N', uom: 'FT2', leather: true, expected: '100.0000', received: '0.0000', tolerancePct: '5', baseUom: 'FT2', ...extra })
  const lining: HideListOrderLine = { id: 'l20', seq: 20, itemCode: 'LIN-200', supplierArticleCode: null, uom: 'M', leather: false, expected: '50.0000', received: '0.0000', tolerancePct: null, baseUom: 'M' }

  it('is an importer of the engine: one order and the tannery number are the key, one batch per list', () => {
    expect(hideListImporter.key).toBe('inventory.hideList')
    expect(hideListImporter.keyColumns).toEqual(['order', 'tanneryNumber'])
    expect(hideListImporter.maxRows).toBe(500)
    expect(hideListImporter.batchSize).toBe(500)
    expect(hideListImporter.validateRow({ area: '0', thicknessMm: '120' })).toEqual([
      { column: 'area', message: 'A hide has an area above 0.' },
      { column: 'thicknessMm', message: 'At most 99.99 mm.' },
    ])
  })

  it('a hide received before: UNCHANGED with the same area, an error with another', () => {
    const existing = { id: 'h1', values: receivedHideValues('PO-1', 'T-01', { receiptNumber: 'GR-2026-0001', tag: 'HD-X', area: '52.3000', unit: 'FT2' }) }
    expect(planHide({ order: 'PO-1', tanneryNumber: 'T-01', area: '52.3' }, existing)).toEqual({ action: 'UNCHANGED' })
    expect(planHide({ order: 'PO-1', tanneryNumber: 'T-01', area: '52.4' }, existing)).toEqual({ action: 'ERROR', errors: [expect.objectContaining({ column: 'tanneryNumber', message: expect.stringContaining('(GR-2026-0001, tag HD-X, 52.3000 FT2)') })] })
    expect(planHide({ order: 'PO-1', tanneryNumber: 'T-02', area: '50' }, null)).toEqual({ action: 'CREATE', after: { order: 'PO-1', tanneryNumber: 'T-02', area: '50' } })
  })

  it('finds the order line by seq, by article (ours or the supplier) or as the only leather line', () => {
    const lines = [leather(), lining]
    expect(lineOfRow({}, lines)).toEqual({ line: lines[0] })
    expect(lineOfRow({ line: 20 }, lines)).toEqual({ problem: { column: 'line', message: 'Order line 20 (LIN-200) is not leather: it is not received hide by hide.' } })
    expect(lineOfRow({ article: 'vac-n' }, lines)).toEqual({ line: lines[0] })
    expect(lineOfRow({ line: 30 }, lines)).toEqual({ problem: { column: 'line', message: 'The order has no line 30.' } })
    expect(lineOfRow({}, [leather(), leather({ id: 'l30', seq: 30 })])).toEqual({ problem: { column: 'line', message: 'The order has several leather lines: give the order line (or the article) on each row.' } })
  })

  it('one list: one order, one delivery note, one place, each tannery number once', () => {
    const answers = listProblems([
      { rowNumber: 2, values: { order: 'PO-1', tanneryNumber: 'T-01', ddtNumber: 'DDT-1' } },
      { rowNumber: 3, values: { order: 'PO-1', tanneryNumber: 'T-01' } },
      { rowNumber: 4, values: { order: 'PO-2', tanneryNumber: 'T-02', ddtNumber: 'DDT-2', location: 'A1-RCV' } },
    ])
    expect(answers[0]).toEqual([])
    expect(answers[1]).toEqual([{ column: 'tanneryNumber', message: 'Hide T-01 is on the list twice (row 2 too).' }])
    expect(answers[2]!.map((issue) => issue.column)).toEqual(['order', 'ddtNumber'])
  })

  it('totals per order line against expected and the tolerance; over without a reason needs one', () => {
    const totals = hideListTotals([
      { line: leather(), baseArea: new Dec('52.3'), lotKey: 'DB1|', differenceReason: null },
      { line: leather(), baseArea: new Dec('55.0'), lotKey: 'DB2|', differenceReason: null },
    ])
    expect(totals).toHaveLength(1)
    expect(totals[0]).toMatchObject({ hides: 2, lots: 2, baseArea: '107.3000', needsReason: true, difference: { kind: 'OVER', upTo: '105.0000', difference: '7.3000' } })
    expect(hideListTotals([{ line: leather(), baseArea: new Dec('104'), lotKey: '|', differenceReason: null }])[0]).toMatchObject({ needsReason: false, difference: { kind: 'WITHIN_TOLERANCE' } })
  })

  it('the rows make one receipt body: lots by dye batch and supplier lot, hides in row order', () => {
    const line = leather()
    const body = hideListBody(
      [
        { line, values: { order: 'PO-1', tanneryNumber: 'T-01', area: '52.3', unit: 'FT2', dyeBatch: 'DB1', grade: 'A', thicknessMm: '1.2', ddtNumber: 'DDT-1', ddtDate: '2026-10-28' } },
        { line, values: { order: 'PO-1', tanneryNumber: 'T-02', area: '4.8', unit: 'M2', dyeBatch: 'DB2', differenceReason: 'Taken: the tannery sent the whole batch' } },
        { line, values: { order: 'PO-1', tanneryNumber: 'T-03', area: '50', dyeBatch: 'DB1', defects: 'Scar' } },
      ],
      { purchaseOrderId: 'po-1', locationId: 'loc-1' },
    )
    expect(body).toEqual({
      purchaseOrderId: 'po-1',
      locationId: 'loc-1',
      supplierDdtNumber: 'DDT-1',
      supplierDdtDate: '2026-10-28',
      lines: [
        {
          purchaseOrderLineId: 'l10',
          differenceReason: 'Taken: the tannery sent the whole batch',
          lots: [
            {
              supplierLotRef: null,
              dyeBatch: 'DB1',
              shade: null,
              hides: [
                { supplierCode: 'T-01', area: '52.3', areaUom: 'FT2', grade: 'A', shade: null, thicknessMm: '1.2', defects: null },
                { supplierCode: 'T-03', area: '50', grade: null, shade: null, thicknessMm: null, defects: 'Scar' },
              ],
            },
            { supplierLotRef: null, dyeBatch: 'DB2', shade: null, hides: [{ supplierCode: 'T-02', area: '4.8', areaUom: 'M2', grade: null, shade: null, thicknessMm: null, defects: null }] },
          ],
        },
      ],
    })
  })
})
