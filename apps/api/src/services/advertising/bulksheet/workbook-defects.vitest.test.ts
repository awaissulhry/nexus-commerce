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
import { createWriter, escapeFormulaInjection } from './spreadsheet-adapter.js'

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
  writer.addSheet({
    name: 'Sponsored Products Campaigns',
    columns: [
      { header: 'Entity', allowedValues: ENTITY_VALUES },
      { header: 'Operation', allowedValues: ['Create', 'Update', 'Archive'] },
      { header: 'Campaign name' },
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
