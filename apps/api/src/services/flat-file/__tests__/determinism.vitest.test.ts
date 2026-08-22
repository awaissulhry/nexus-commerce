/**
 * FF1.8 — Determinism gate (CI proof of Contract §1).
 *
 * Test 1: identical CONTENT across two identical generator invocations.
 * Test 2: only the hidden _meta sheet changes when snapshotId changes;
 *         the visible Products and Amazon sheets carry identical cell contents.
 *
 * If Test 1 FAILS the generator is non-deterministic — this is a blocking
 * defect (CONTRACT §1 breach). Do NOT paper over it.
 *
 * 🔴 2026-08-22 — Test 1 compared RAW BYTES and that assertion was not sound.
 *
 * The generator is deterministic and pins `wb.created`/`wb.modified` from `exportedAt`
 * precisely so it would be — but `xlsx.writeBuffer()` writes a ZIP, and the zip entries
 * carry wall-clock mtimes that ExcelJS exposes no option to fix. Measured directly: two
 * generations with identical inputs are byte-identical back-to-back and DIFFER after a
 * 1.5s pause. So the old assertion held only while both calls landed inside the same
 * clock tick — it passed for years because the pair ran in ~30ms, and it began failing
 * the moment an unrelated commit made the suite slow enough to straddle a second.
 *
 * This is NOT papering over: byte-identity was never the property under test. What
 * Contract §1 protects is that no volatile value leaks into the workbook, and that is a
 * statement about CELL CONTENT, which is what this now compares — across every sheet,
 * including the hidden _meta one, so a stray Date or nonce still fails it. Restoring the
 * byte compare means making the zip reproducible first (normalise the entry mtimes after
 * `writeBuffer`, or patch the zip layer); until then it would only be re-arming a timer.
 */

import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { generateWorkbook } from '../workbook-generator'
import { MODEL, DATA } from './fixtures/sample-workbook'

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Read all cell values of a worksheet into a 2D array (row-major).
 * includeEmpty is set on both eachRow and eachCell so that completely
 * empty rows/cells are still represented, ensuring the comparison is
 * sensitive to any structural change.
 */
function sheetCells(ws: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = []
  ws.eachRow({ includeEmpty: true }, r => {
    const cells: unknown[] = []
    r.eachCell({ includeEmpty: true }, c => cells.push(c.value))
    rows.push(cells)
  })
  return rows
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Determinism gate (FF1.8)', () => {
  it('produces identical content across two identical generations', async () => {
    const a = await generateWorkbook(MODEL, DATA, { snapshotId: 's', exportedAt: '2026-07-05' })
    const b = await generateWorkbook(MODEL, DATA, { snapshotId: 's', exportedAt: '2026-07-05' })

    const wbA = new ExcelJS.Workbook(); await wbA.xlsx.load(Buffer.from(a))
    const wbB = new ExcelJS.Workbook(); await wbB.xlsx.load(Buffer.from(b))

    // EVERY sheet, _meta included: same inputs must yield the same cells everywhere. A
    // volatile value (a Date, a nonce, an iteration-ordered key) still fails this.
    const names = wbA.worksheets.map((w) => w.name)
    expect(names).toEqual(wbB.worksheets.map((w) => w.name))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(sheetCells(wbA.getWorksheet(name)!), `sheet '${name}' differs between two identical generations`)
        .toEqual(sheetCells(wbB.getWorksheet(name)!))
    }
  })

  it('only _meta changes when snapshotId changes (no volatile data leakage into visible sheets)', async () => {
    const bytesS1 = await generateWorkbook(MODEL, DATA, { snapshotId: 's1', exportedAt: '2026-07-05' })
    const bytesS2 = await generateWorkbook(MODEL, DATA, { snapshotId: 's2', exportedAt: '2026-07-05' })

    const wb1 = new ExcelJS.Workbook()
    await wb1.xlsx.load(Buffer.from(bytesS1))

    const wb2 = new ExcelJS.Workbook()
    await wb2.xlsx.load(Buffer.from(bytesS2))

    // Visible sheets: cell contents must be identical between s1 and s2 runs.
    for (const sheetName of ['Products', 'Amazon'] as const) {
      const ws1 = wb1.getWorksheet(sheetName)
      const ws2 = wb2.getWorksheet(sheetName)
      expect(ws1, `sheet '${sheetName}' missing from s1 workbook`).toBeDefined()
      expect(ws2, `sheet '${sheetName}' missing from s2 workbook`).toBeDefined()
      expect(sheetCells(ws1!)).toEqual(sheetCells(ws2!))
    }

    // _meta (veryHidden) must differ: the snapshotId cell changes.
    // wb.getWorksheet() resolves veryHidden sheets by name.
    const meta1 = wb1.getWorksheet('_meta')
    const meta2 = wb2.getWorksheet('_meta')
    expect(meta1, '_meta sheet missing from s1 workbook').toBeDefined()
    expect(meta2, '_meta sheet missing from s2 workbook').toBeDefined()

    const cells1 = sheetCells(meta1!)
    const cells2 = sheetCells(meta2!)

    // The overall cell tables must not be equal (snapshotId row differs).
    expect(cells1).not.toEqual(cells2)

    // Specifically verify the snapshotId row holds the correct value in each.
    const snapRow1 = cells1.find(row => row[0] === 'snapshotId')
    const snapRow2 = cells2.find(row => row[0] === 'snapshotId')
    expect(snapRow1, 'snapshotId row missing from _meta (s1)').toBeDefined()
    expect(snapRow2, 'snapshotId row missing from _meta (s2)').toBeDefined()
    expect(snapRow1![1]).toBe('s1')
    expect(snapRow2![1]).toBe('s2')
  })
})
