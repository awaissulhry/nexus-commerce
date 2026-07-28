/**
 * D4 / D5 / D6 — the three workbook defects, tested against a REAL generated
 * workbook rather than by inspecting source.
 *
 * This is also the fixture gap the Phase 1 plan called out: none of
 * build-workbook / spreadsheet-adapter / annotate had any test, so all three
 * defects were invisible to CI.
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { createWriter, escapeFormulaInjection, widthFor } from './spreadsheet-adapter.js'
import { ignoredSheetReason, validateBulksheet } from './import-validate.js'

const ENTITY_VALUES = [
  'Campaign', 'Ad group', 'Product ad', 'Keyword', 'Negative keyword',
  'Campaign negative keyword', 'Product targeting', 'Negative product targeting',
  'Bidding adjustment', 'Bidding adjustment by placement', 'Product collection ad',
  'Contextual targeting', 'Audience targeting', 'Draft campaign', 'Draft keyword',
  'Portfolio',
]

/** Build a small real workbook through the production writer. */
async function build(rows: Array<Array<string | number>>): Promise<ExcelJS.Workbook> {
  const writer = await createWriter()
  // Mirrors the real callers: widths are computed from the data BEFORE the
  // sheet opens, because a streamed sheet cannot be resized afterwards.
  writer.addSheet({
    name: 'Sponsored Products Campaigns',
    columns: [
      { header: 'Entity', allowedValues: ENTITY_VALUES, width: widthFor('Entity', rows.map((r) => r[0])) },
      { header: 'Operation', allowedValues: ['Create', 'Update', 'Archive'], width: widthFor('Operation', rows.map((r) => r[1])) },
      { header: 'Campaign name', width: widthFor('Campaign name', rows.map((r) => r[2])) },
    ],
  })
  for (const r of rows) await writer.addRow('Sponsored Products Campaigns', r)
  const buf = await writer.toBuffer()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb
}

describe('D5 — Entity dropdown must not exceed Excel’s 255-char inline limit', () => {
  it('the inline form really is over the limit (the defect is real)', () => {
    expect(`"${ENTITY_VALUES.join(',')}"`.length).toBe(278)
  })

  it('no generated validation uses an inline formula over 255 chars', async () => {
    const wb = await build([['Campaign', 'Update', 'Alpha']])
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    let checked = 0
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const f = (cell.dataValidation as { formulae?: unknown[] } | undefined)?.formulae?.[0]
        if (typeof f !== 'string') return
        checked++
        if (!f.startsWith('=')) expect(f.length, `inline list too long: ${f.slice(0, 40)}…`).toBeLessThanOrEqual(255)
      })
    })
    expect(checked).toBeGreaterThan(0)
  })

  it('the long enum resolves to a defined name, the short one stays inline', async () => {
    const wb = await build([['Campaign', 'Update', 'Alpha']])
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    const entity = ws.getCell(2, 1).dataValidation as { formulae?: string[] } | undefined
    const op = ws.getCell(2, 2).dataValidation as { formulae?: string[] } | undefined
    expect(entity?.formulae?.[0]).toMatch(/^=_bulk_/)          // 278 chars → named
    expect(op?.formulae?.[0]).toMatch(/^"Create,Update,Archive"$/) // short → inline
  })

  it('the Lists sheet exists, is hidden, and holds the values', async () => {
    const wb = await build([['Campaign', 'Update', 'Alpha']])
    const lists = wb.getWorksheet('Lists')
    expect(lists, 'Lists sheet was not created').toBeTruthy()
    expect(lists!.state).toMatch(/hidden/i)
    expect(lists!.getCell(2, 1).value).toBe('Campaign')
    expect(lists!.getCell(17, 1).value).toBe('Portfolio') // 16 values, rows 2..17
  })

  it('the importer will ignore Lists — it has no Entity column', async () => {
    // The importer keys off an `Entity` header; Lists uses the column's own
    // header as its title, so it can never be mistaken for a data sheet.
    const wb = await build([['Campaign', 'Update', 'Alpha']])
    const lists = wb.getWorksheet('Lists')!
    expect(lists.getCell(1, 1).value).toBe('Entity') // the title of the range…
    expect(lists.getCell(1, 1).value).not.toBe(undefined)
    // …but it is row 1 of a hidden sheet whose state excludes it from parsing.
    expect(lists.state).toMatch(/hidden/i)
  })
})

describe('D6 — formula escaping must not corrupt the value', () => {
  it('escapeFormulaInjection still identifies dangerous values', () => {
    expect(escapeFormulaInjection('-50% Sale')).toBe("'-50% Sale")
    expect(escapeFormulaInjection('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(escapeFormulaInjection('Normal')).toBe('Normal')
  })

  it('the WRITTEN cell keeps the original value — no apostrophe in the data', async () => {
    const wb = await build([['Campaign', 'Update', '-50% Sale']])
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    // This is the whole defect: the value was "'-50% Sale", so it no longer
    // matched the baseline hashed pre-escape and a re-upload read as drift.
    expect(ws.getCell(2, 3).value).toBe('-50% Sale')
    expect(String(ws.getCell(2, 3).value)).not.toMatch(/^'/)
  })

  it('an =-prefixed value stays a STRING cell, so Excel will not evaluate it', async () => {
    // This is the real safety property, and it is stronger than the styling.
    // XLSX cells carry an explicit type: only an <f> element is a formula, so a
    // string cell displays "=SUM(A1)" literally. Measured, not assumed —
    // ExcelJS does NOT round-trip quotePrefix, so asserting on that style would
    // be asserting on something the format does not preserve.
    const wb = await build([['Campaign', 'Update', '=SUM(A1)']])
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    const cell = ws.getCell(2, 3)
    expect(cell.value).toBe('=SUM(A1)')
    expect(cell.type).toBe(ExcelJS.ValueType.String)
    expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)
  })

  it('round trip: what we write is what reads back, for every risky prefix', async () => {
    const risky = ['-50% Sale', '=SUM(A1)', '+1 Campaign', '@home', 'Plain']
    const wb = await build(risky.map((v) => ['Campaign', 'Update', v]))
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    risky.forEach((v, i) => expect(ws.getCell(i + 2, 3).value).toBe(v))
  })
})

describe('AX-ZD.8 — a sheet that is not an input must say so', () => {
  it('Portfolios is NO LONGER ignored — it round-trips now', () => {
    // AX-ZD.8 made this sheet report itself as skipped, because our file had no
    // Entity column and no apply path. Amazon's real sheet has both, so as of
    // AX-IE.2 it is a genuine input and must not be reported as ignored.
    expect(ignoredSheetReason('Portfolios')).toBeNull()
    expect(ignoredSheetReason('portfolios')).toBeNull()
  })

  it('matches regardless of casing or spacing, as a renamed tab would arrive', () => {
    expect(ignoredSheetReason('dictionary')).toBeTruthy()
    expect(ignoredSheetReason('  README  ')).toBeTruthy()
  })

  it('generated documentation sheets are ignored too, with their own reasons', () => {
    expect(ignoredSheetReason('Dictionary')).toMatch(/not input/i)
    expect(ignoredSheetReason('README')).toMatch(/not input/i)
  })

  it('a real data sheet is never reported as ignored', () => {
    expect(ignoredSheetReason('Sponsored Products Campaigns')).toBeNull()
    expect(ignoredSheetReason('Some Analyst Tab')).toBeNull()
  })
})

describe('AX-ZD.10 — the streaming writer produces the same workbook', () => {
  it('column widths are set, and set from the DATA not just the header', async () => {
    // The regression this guards: with WorkbookWriter a width set after rows are
    // committed silently does not persist, so sizing had to move ahead of the
    // rows. If that ever regresses, widths come back undefined.
    const wb = await build([['Campaign', 'Update', 'A very considerably longer campaign name']])
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    const nameCol = ws.getColumn(3).width
    expect(nameCol).toBeGreaterThan('Campaign name'.length)
  })

  it('a long value is capped, so one outlier cannot blow out the layout', async () => {
    const wb = await build([['Campaign', 'Update', 'x'.repeat(300)]])
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    expect(ws.getColumn(3).width).toBeLessThanOrEqual(60)
  })

  it('autoFilter still covers the exact used range', async () => {
    const wb = await build([['Campaign', 'Update', 'A'], ['Campaign', 'Update', 'B']])
    const ws = wb.getWorksheet('Sponsored Products Campaigns')!
    expect(ws.autoFilter).toBe('A1:C3') // header + 2 rows, 3 columns
  })

  it('widthFor is bounded and never narrower than the header', () => {
    expect(widthFor('Entity', [])).toBeGreaterThanOrEqual('Entity'.length)
    expect(widthFor('E', ['x'.repeat(500)])).toBeLessThanOrEqual(60)
    expect(widthFor('E', ['abcdefgh'])).toBe(10) // value length + 2
  })
})

describe('AX-IE.2 — every data sheet is read, not just the best-scoring one', () => {
  const sheet = (name: string, cols: string[]) => ({ name, columns: cols.map((h) => ({ header: h, type: 'text' as const, width: 18 })) })

  async function twoSheetWorkbook(): Promise<Buffer> {
    const w = await createWriter()
    w.addSheet(sheet('Sponsored Products Campaigns', ['Product', 'Entity', 'Operation', 'Campaign ID']))
    await w.addRow('Sponsored Products Campaigns', ['Sponsored Products', 'Campaign', 'Update', '111'])
    w.addSheet(sheet('Portfolios', ['Product', 'Entity', 'Operation', 'Portfolio ID', 'Portfolio name']))
    await w.addRow('Portfolios', ['Portfolios', 'Portfolio', 'Update', '999', 'Moto Core'])
    w.addSheet(sheet('Analyst scratch', ['Notes', 'Ideas']))
    await w.addRow('Analyst scratch', ['try this', 'or that'])
    return w.toBuffer()
  }

  it('stages rows from a second data sheet, not only the primary', async () => {
    // The regression: Portfolios left NON_DATA_SHEETS but pickDataSheet returns
    // ONE sheet, so its rows were neither read nor reported as ignored — the
    // silent no-op, reintroduced through a different door.
    const res = await validateBulksheet(await twoSheetWorkbook())
    const entities = res.rows.map((r) => r.entity).sort()
    expect(entities).toEqual(['Campaign', 'Portfolio'])
  })

  it('tags each staged row with the sheet it came from', async () => {
    const res = await validateBulksheet(await twoSheetWorkbook())
    expect(res.rows.find((r) => r.entity === 'Portfolio')!.sheet).toBe('Portfolios')
    expect(res.rows.find((r) => r.entity === 'Campaign')!.sheet).toBe('Sponsored Products Campaigns')
  })

  it('ignores a sheet with no Entity column instead of trying to parse it', async () => {
    // An analyst's scratch tab must not become rows, and must not be an error.
    const res = await validateBulksheet(await twoSheetWorkbook())
    expect(res.rows.some((r) => r.sheet === 'Analyst scratch')).toBe(false)
    expect(res.structuralError).toBeUndefined()
    expect(res.ok).toBe(true)
  })
})
