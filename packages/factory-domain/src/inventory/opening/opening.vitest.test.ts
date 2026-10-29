import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import type { RowValues } from '../../imports/importer'
import { parseRow } from '../../imports/plan'
import { importedLineValues, openingStockImporter, openingTemplate, planLine } from './importer'
import { lotGroupProblems, openingMoveKey, planOpeningRow, stockWords, type OpeningFacts, type OpeningItem, type OpeningLot } from './rules'

/** Made-up materials, as the API reads them: leather by the hide (base ft², Cr VI 3 mg/kg), a lining in metres, a certified protector. */
const leather: OpeningItem = {
  id: 'item-lea',
  code: 'LEA-100',
  active: true,
  foreign: false,
  tracking: 'HIDE',
  units: { baseUom: 'FT2', purchaseUom: 'FT2', purchaseFactor: '1', consumptionUom: 'FT2', consumptionFactor: '1' },
  requiresCrViTest: true,
  crViLimitMgKg: '3.000',
  isPpeComponent: false,
  standardCost: '4.200000',
  colours: [
    { id: 'col-blk', code: 'BLK', active: true },
    { id: 'col-red', code: 'RED', active: true },
  ],
}
const lining: OpeningItem = {
  ...leather,
  id: 'item-lin',
  code: 'LIN-200',
  tracking: 'LOT',
  units: { baseUom: 'M', purchaseUom: 'ROLL', purchaseFactor: '50', consumptionUom: 'M', consumptionFactor: '1' },
  requiresCrViTest: false,
  crViLimitMgKg: null,
  standardCost: '3.100000',
  colours: [{ id: 'col-gry', code: 'GRY', active: true }],
}
const protector: OpeningItem = { ...lining, id: 'item-pro', code: 'PRO-300', units: { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' }, isPpeComponent: true, standardCost: null, colours: [] }

const facts = (over: Partial<OpeningFacts> = {}): OpeningFacts => ({
  site: { id: 'site-a1', code: 'A1', reachable: true },
  location: { id: 'loc-store', code: 'A1-STORE', active: true },
  item: leather,
  supplier: null,
  report: { id: 'file-1' },
  certificateCovers: null,
  lot: null,
  rule: 'SUPPLIER_REPORT_ACCEPTED',
  today: '2026-10-29',
  ...over,
})
const hide: RowValues = { line: 'CS-0001', site: 'A1', location: 'A1-STORE', item: 'LEA-100', colour: 'BLK', lot: 'DB-4471', quantity: '5.2', unit: 'M2' }
const report: RowValues = { crViMgKg: '1.2', crViMethod: 'EN ISO 17075-1', lab: 'Test Lab One', reportNumber: 'TL-1', testedOn: '2026-09-01', reportFile: 'tl-1.pdf' }
const columnsOf = (problems: readonly { column?: string }[]) => problems.map((problem) => problem.column ?? null)
const omit = (values: RowValues, ...names: string[]): RowValues => Object.fromEntries(Object.entries(values).filter(([name]) => !names.includes(name)))

describe('a leather row: hides, the lot as the receipts start it, the existing report (B-W1-35; REACH Annex XVII entry 47)', () => {
  it('a hide with a PASS report: a new lot in QUARANTINE (never released by the import), its result recorded, the area in ft²', () => {
    const { problems, plan } = planOpeningRow({ ...hide, ...report }, facts())
    expect(problems).toEqual([])
    expect(plan!.lot).toMatchObject({ kind: 'NEW', supplierLotRef: 'DB-4471', start: { qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViLimitMgKg: '3.000', crViStatus: 'PENDING', holds: ['CR_VI_TEST'] } })
    // 5.2 m² = 5.2 / 0.09290304 ft² = 55.97231… → 55.9723 (four decimals, half up).
    expect(plan!.hides).toEqual([{ area: '5.2000', baseArea: '55.9723', supplierCode: null, grade: null, thicknessMm: null, defects: null }])
    expect(plan!.result).toMatchObject({ fileId: 'file-1', verdict: { verdict: 'PASS', valueMgKg: '1.200' }, effect: { crViStatus: 'PASS', qualityStatus: 'QUARANTINE' } })
    expect(plan!.cost).toEqual({ method: 'STANDARD_COST', unitCost: '4.200000' })
  })

  it('a lot in one row: every hide with its own area (never a count times an average)', () => {
    const { problems, plan } = planOpeningRow({ ...omit(hide, 'quantity'), areas: '50;52.5;48.25', unit: 'FT2', hides: 3 }, facts())
    expect(problems).toEqual([])
    expect(plan!.hides.map((entry) => [entry.area, entry.baseArea])).toEqual([
      ['50.0000', '50.0000'],
      ['52.5000', '52.5000'],
      ['48.2500', '48.2500'],
    ])
    expect([plan!.quantity, plan!.baseQuantity]).toEqual(['150.7500', '150.7500'])
    expect(plan!.result).toBeNull()
  })

  it('no report: QUARANTINE, Cr VI PENDING, nothing recorded', () => {
    const { plan } = planOpeningRow(hide, facts({ report: null }))
    expect(plan!.lot).toMatchObject({ kind: 'NEW', start: { qualityStatus: 'QUARANTINE', crViStatus: 'PENDING' } })
    expect(plan!.result).toBeNull()
  })

  it('a FAIL report: the lot keeps QUARANTINE with Cr VI FAIL (rejected by the quality step, never usable)', () => {
    const { plan } = planOpeningRow({ ...hide, ...report, crViMgKg: '3' }, facts())
    expect(plan!.result).toMatchObject({ verdict: { verdict: 'FAIL' }, effect: { crViStatus: 'FAIL', qualityStatus: 'QUARANTINE' } })
  })

  it('"not detected" with the detection limit is a PASS; both a value and a limit, or a limit above the lot\'s, are refused', () => {
    expect(planOpeningRow({ ...hide, ...omit(report, 'crViMgKg'), detectionLimitMgKg: '0.5' }, facts()).plan!.result).toMatchObject({ verdict: { verdict: 'PASS', belowDetectionLimit: true } })
    expect(columnsOf(planOpeningRow({ ...hide, ...report, detectionLimitMgKg: '0.5' }, facts()).problems)).toEqual(['detectionLimitMgKg'])
    expect(columnsOf(planOpeningRow({ ...hide, ...omit(report, 'crViMgKg'), detectionLimitMgKg: '3.5' }, facts()).problems)).toEqual(['detectionLimitMgKg'])
  })

  it('the report against the evidence rule (Q14), the test day and the supplier report\'s period', () => {
    const supplierReport = { ...hide, ...report, article: 'NAPPA 1.2', periodFrom: '2026-01-01', periodTo: '2026-06-30', receivedOn: '2026-03-10' }
    expect(planOpeningRow(supplierReport, facts()).plan!.result).toMatchObject({ input: { evidence: 'SUPPLIER_REPORT', article: 'NAPPA 1.2' } })
    expect(planOpeningRow(supplierReport, facts({ rule: 'LOT_REPORT_REQUIRED' })).problems).toEqual([{ column: 'evidence', message: expect.stringContaining('asks for a lab report on every lot') }])
    expect(columnsOf(planOpeningRow({ ...supplierReport, receivedOn: '2026-08-01' }, facts()).problems)).toEqual(['periodTo'])
    expect(columnsOf(planOpeningRow({ ...hide, ...report, testedOn: '2026-11-02' }, facts()).problems)).toEqual(['testedOn'])
    expect(columnsOf(planOpeningRow({ ...hide, ...omit(report, 'crViMethod', 'lab') }, facts()).problems)).toEqual(['crViMethod', 'lab'])
  })

  it('the report file must be one uploaded report of the company', () => {
    expect(planOpeningRow({ ...hide, ...omit(report, 'reportFile') }, facts()).problems).toEqual([{ column: 'reportFile', message: expect.stringContaining("Name the report's file") }])
    expect(planOpeningRow({ ...hide, ...report }, facts({ report: 'NONE' })).problems).toEqual([{ column: 'reportFile', message: 'No opening-stock report of this company is named tl-1.pdf: upload it first.' }])
    expect(columnsOf(planOpeningRow({ ...hide, ...report }, facts({ report: 'SEVERAL' })).problems)).toEqual(['reportFile'])
  })

  it('refuses a unit that is not an area, a colour missing, hide columns on a lot material', () => {
    expect(planOpeningRow({ ...hide, unit: 'KG' }, facts()).problems).toEqual([{ column: 'unit', message: "A hide is measured in m², dm² or ft²: give material LEA-100's areas in M2, DM2 or FT2." }])
    expect(planOpeningRow(omit(hide, 'colour'), facts()).problems).toEqual([{ column: 'colour', message: 'Material LEA-100 comes in colours (BLK, RED): name the colour.' }])
    expect(columnsOf(planOpeningRow({ ...hide, item: 'LIN-200', colour: 'GRY', unit: 'M', grade: 'A' }, facts({ item: lining })).problems)).toEqual(['grade'])
    expect(columnsOf(planOpeningRow(omit(hide, 'lot'), facts()).problems)).toEqual(['lot'])
  })
})

describe('lining in metres and protectors per piece', () => {
  const liningRow: RowValues = { line: 'CS-0010', site: 'A1', location: 'A1-STORE', item: 'LIN-200', colour: 'GRY', lot: 'R-77', quantity: '120', unit: 'M' }

  it('a lining lot needs no quality step: RELEASED at the start, as a receipt would (no test, no certificate)', () => {
    const { plan } = planOpeningRow(liningRow, facts({ item: lining }))
    expect(plan!.lot).toMatchObject({ kind: 'NEW', start: { qualityStatus: 'RELEASED', crViStatus: 'NOT_REQUIRED', holds: [] } })
    expect([plan!.quantity, plan!.baseQuantity, plan!.hides]).toEqual(['120.0000', '120.0000', []])
  })

  it('values the given unit cost per base unit (the cost grain): 1.85 €/m at 0.01 m per cm', () => {
    expect(planOpeningRow({ ...liningRow, quantity: '250', unit: 'CM', unitCost: '0.0185' }, facts({ item: lining })).plan).toMatchObject({ baseQuantity: '2.5000', cost: { method: 'MANUAL', unitCost: '1.850000' } })
  })

  it('a roll has no fixed size: refused with the units the material converts', () => {
    expect(planOpeningRow({ ...liningRow, unit: 'ROLL' }, facts({ item: lining })).problems).toEqual([{ column: 'unit', message: 'A ROLL has no fixed size: give the quantity in M, CM, MM.' }])
    expect(planOpeningRow({ ...liningRow, unit: 'KG' }, facts({ item: lining })).problems).toEqual([{ column: 'unit', message: 'Material LIN-200 does not convert KG to its stock unit M: give the quantity in M, CM, MM.' }])
  })

  it('a certified protector starts in quarantine for its certificate; a named certificate must cover it', () => {
    const row: RowValues = { line: 'CS-0020', site: 'A1', location: 'A1-STORE', item: 'PRO-300', lot: 'P-1', quantity: '24', unit: 'PCS', certificate: 'CERT-1' }
    expect(planOpeningRow(row, facts({ item: protector, certificateCovers: true })).plan).toMatchObject({ lot: { start: { qualityStatus: 'QUARANTINE', holds: ['PPE_CERTIFICATE'] } }, cost: null })
    expect(columnsOf(planOpeningRow(row, facts({ item: protector, certificateCovers: false })).problems)).toEqual(['certificate'])
    expect(columnsOf(planOpeningRow({ ...liningRow, certificate: 'CERT-1' }, facts({ item: lining, certificateCovers: true })).problems)).toEqual(['certificate'])
  })

  it('names every wrong reference of the row at once', () => {
    expect(planOpeningRow(liningRow, facts({ item: null })).problems).toEqual([{ column: 'item', message: 'Material LIN-200 does not exist: import it with the materials first.' }])
    expect(columnsOf(planOpeningRow(liningRow, facts({ site: null, item: lining })).problems)).toEqual(['site'])
    expect(columnsOf(planOpeningRow(liningRow, facts({ location: null, item: lining })).problems)).toEqual(['location'])
    expect(planOpeningRow(liningRow, facts({ site: { id: 'site-a2', code: 'A1', reachable: false }, item: lining })).problems[0]!.message).toContain('Your role does not reach site A1')
    expect(columnsOf(planOpeningRow(liningRow, facts({ item: { ...lining, foreign: true, active: false } })).problems)).toEqual(['item', 'item'])
    expect(columnsOf(planOpeningRow({ ...liningRow, ...report }, facts({ item: lining })).problems)).toEqual(['crViMgKg'])
    expect(columnsOf(planOpeningRow({ ...liningRow, stockDate: '2026-11-01' }, facts({ item: lining })).problems)).toEqual(['stockDate'])
  })
})

describe('rows that join a lot made before (an earlier row or import)', () => {
  const lot: OpeningLot = {
    id: 'lot-1',
    code: 'LA-000041',
    supplierId: null,
    dyeBatch: null,
    shade: null,
    receivedDay: '2026-10-29',
    qualityStatus: 'QUARANTINE',
    requiresCrViTest: true,
    crViStatus: 'PASS',
    crViLimitMgKg: '3.000',
    result: { method: 'EN ISO 17075-1', valueMgKg: '1.200', belowDetectionLimit: false, detectionLimitMgKg: null, lab: 'Test Lab One', reportNumber: 'TL-1', testedOn: '2026-09-01', evidence: 'LOT_REPORT', article: null, periodFrom: null, periodTo: null, fileId: 'file-1' },
    hideNumbers: ['T-1'],
  }

  it('adds its hides; the same report again records nothing; another report is refused', () => {
    expect(planOpeningRow({ ...hide, ...report }, facts({ lot })).plan).toMatchObject({ lot: { kind: 'JOIN', lotId: 'lot-1' }, result: null })
    expect(planOpeningRow({ ...hide, ...report, crViMgKg: '1.3' }, facts({ lot })).problems).toEqual([{ column: 'crViMgKg', message: expect.stringContaining('has another chromium VI result already') }])
    expect(planOpeningRow({ ...hide, hideNumber: 'T-1' }, facts({ lot })).problems).toEqual([{ column: 'hideNumber', message: 'Lot LA-000041 (DB-4471) has a hide numbered T-1 already.' }])
  })

  it('a lot still PENDING takes the report of a later row', () => {
    expect(planOpeningRow({ ...hide, ...report }, facts({ lot: { ...lot, crViStatus: 'PENDING', result: null } })).plan!.result).toMatchObject({ effect: { crViStatus: 'PASS', qualityStatus: 'QUARANTINE' } })
  })

  it('never adds stock to a lot released (or rejected) after the quality step', () => {
    expect(planOpeningRow(hide, facts({ lot: { ...lot, qualityStatus: 'RELEASED' } })).problems).toEqual([{ column: 'lot', message: expect.stringContaining('would skip the quality step') }])
    expect(columnsOf(planOpeningRow(hide, facts({ lot: { ...lot, qualityStatus: 'REJECTED' } })).problems)).toEqual(['lot'])
    const releasedLining = { ...lot, requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' as const, crViLimitMgKg: null, result: null, qualityStatus: 'RELEASED' as const }
    expect(planOpeningRow({ line: 'CS-0011', site: 'A1', location: 'A1-STORE', item: 'LIN-200', colour: 'GRY', lot: 'R-77', quantity: '10', unit: 'M' }, facts({ item: lining, lot: releasedLining })).problems).toEqual([])
  })

  it('in one batch, the rows of one lot say the same about it; hide numbers differ', () => {
    const rows = [
      { rowNumber: 2, values: { ...hide, ...report, hideNumber: 'T-1' } },
      { rowNumber: 3, values: { ...hide, line: 'CS-0002', ...report, hideNumber: 'T-2' } },
      { rowNumber: 4, values: { ...hide, line: 'CS-0003', ...report, crViMgKg: '2.1', hideNumber: 'T-1' } },
      { rowNumber: 5, values: { ...hide, line: 'CS-0004', colour: 'RED', ...report, crViMgKg: '2.1' } },
      { rowNumber: 6, values: { ...hide, line: 'CS-0005', dyeBatch: 'X', hideNumber: 'T-3' } },
    ]
    expect(lotGroupProblems(rows).map(columnsOf)).toEqual([[], [], ['crViMgKg', 'hideNumber'], [], []])
    expect(lotGroupProblems(rows)[2]![0]!.message).toBe('Row 2 gives lot DB-4471 another chromium VI report: the rows of one lot say the same.')
  })
})

describe('the importer: cells, the row check, a line imported before (PLT-176 dry run)', () => {
  const headers = ['Riga', 'Sito', 'Ubicazione', 'Articolo', 'Colore', 'Lotto', 'Quantità', 'UM', 'Aree pelli', 'Pelli', 'Costo unitario', 'Cromo VI', 'Metodo', 'Laboratorio', 'Data prova', 'File rapporto']
  const mapping = mapHeaders(openingStockImporter.columns, headers)
  const parse = (cells: (string | number | null)[], numberFormat: 'it' | 'en' = 'it') => parseRow(openingStockImporter, mapping.columns, { rowNumber: 2, cells }, { numberFormat })

  it('maps the Italian headers to every column', () => {
    expect(mapping.issues).toEqual([])
    expect(mapping.columns.map((entry) => entry.column)).toEqual(['line', 'site', 'location', 'item', 'colour', 'lot', 'quantity', 'unit', 'areas', 'hides', 'unitCost', 'crViMgKg', 'crViMethod', 'lab', 'testedOn', 'reportFile'])
  })

  it('reads hide areas in the job\'s number format, the unit\'s aliases, a method by its number', () => {
    const row = parse(['cs-1', 'a1', 'a1-store', 'lea-100', 'blk', 'DB-1', null, 'mq', '5,20; 4,85 | 1.234,5', '3', null, '1,2', '17075-1', 'Lab', '01/09/2026', 'r.pdf'])
    expect(row.errors).toEqual([])
    expect(row.values).toMatchObject({ line: 'CS-1', site: 'A1', item: 'LEA-100', lot: 'DB-1', unit: 'M2', areas: '5.2;4.85;1234.5', hides: 3, crViMgKg: '1.2', crViMethod: 'EN ISO 17075-1', testedOn: '2026-09-01' })
    expect(row.key).toBe('["CS-1"]')
  })

  it('refuses a negative quantity, a bad unit, a hide count that does not match, both quantity and areas', () => {
    expect(parse(['cs-2', 'a1', 'x', 'lin', null, null, '-3', 'm', null, null, null, null, null, null, null, null]).errors).toEqual([{ column: 'quantity', message: 'The quantity is above 0: opening stock is what lies there.' }])
    expect(parse(['cs-3', 'a1', 'x', 'lin', null, null, '3', 'barili', null, null, null, null, null, null, null, null]).errors.map((error) => error.column)).toEqual(['unit'])
    expect(parse(['cs-4', 'a1', 'x', 'lea', null, null, null, 'ft2', '5;6', '3', null, null, null, null, null, null]).errors).toEqual([{ column: 'hides', message: 'The row holds 2 hides, not 3.' }])
    expect(parse(['cs-5', 'a1', 'x', 'lea', null, null, '5', 'ft2', '5;6', null, null, null, null, null, null, null]).errors.map((error) => error.column)).toEqual(['areas'])
    expect(parse(['cs-6', 'a1', 'x', 'lea', null, null, null, 'ft2', '5;0', null, null, null, null, null, null, null]).errors).toEqual([{ column: 'areas', message: 'Every hide has an area above 0.' }])
    expect(parse(['cs-7', 'a1', 'x', 'lea', null, null, null, 'ft2', null, null, '-1', null, null, null, null, null]).errors.map((error) => error.column)).toEqual(['unitCost'])
  })

  it('a line imported before: UNCHANGED when the row says the same, an error when it says something else', () => {
    const imported = { id: 'lot-1', values: importedLineValues('CS-1', { site: 'A1', location: 'A1-STORE', item: 'LEA-100', colour: 'BLK', lot: 'DB-1', lotCode: 'LA-000041', unit: 'FT2', quantities: ['50.0000', '52.5000'] }) }
    const values: RowValues = { line: 'CS-1', site: 'A1', location: 'A1-STORE', item: 'LEA-100', colour: 'BLK', lot: 'DB-1', unit: 'FT2', areas: '50;52.5' }
    expect(planLine(values, null)).toEqual({ action: 'CREATE', after: values })
    expect(planLine(values, imported)).toEqual({ action: 'UNCHANGED' })
    expect(planLine({ ...values, areas: '50;52.4' }, imported)).toEqual({
      action: 'ERROR',
      errors: [{ column: 'line', message: 'Line CS-1 was imported before (LEA-100 BLK, lot LA-000041 at A1 A1-STORE) with other values: a line is never posted twice. Correct the stock with an adjustment, or give this row a line of its own.' }],
    })
    expect(openingMoveKey('c-1', 'CS-1', 2)).toBe('inventory.opening:c-1:CS-1:2')
  })

  it('its template names every column, and its made-up rows read without a problem in both number formats', () => {
    for (const format of ['it', 'en'] as const) {
      const template = openingTemplate(format)
      expect(template.header).toHaveLength(Object.keys(openingStockImporter.columns).length)
      const map = mapHeaders(openingStockImporter.columns, [...template.header])
      expect(map.issues).toEqual([])
      const rows = template.rows.map((cells, index) => parseRow(openingStockImporter, map.columns, { rowNumber: index + 2, cells: [...cells] }, { numberFormat: format }))
      expect(rows.flatMap((row) => row.errors)).toEqual([])
      expect(rows[2]!.values).toMatchObject({ areas: '4.85;5.1;5.3', hides: 3, stockDate: '2026-12-31', detectionLimitMgKg: '0.5', evidence: 'SUPPLIER_REPORT' })
    }
    expect(openingTemplate('it').rows[0]).toContain('31/12/2026')
  })

  it('says stock in two numbers for leather, never across units', () => {
    expect(stockWords([{ baseUom: 'FT2', quantity: '100.5', hides: 2 }, { baseUom: 'M', quantity: '120', hides: 0 }, { baseUom: 'FT2', quantity: '50', hides: 1 }])).toBe('3 hides · 150.5 ft² · 120 m')
  })
})
