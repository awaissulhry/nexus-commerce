/**
 * The containment, exercised rather than asserted.
 *
 * On 2026-09-16 one XLSX upload pinned the production API's heap at 3.751469056 GB, stopped
 * every other route within four seconds, and never crashed — so it was never restarted
 * (`docs/2026-09-16-studio-import-wedged-production.md`). These tests hold the property that
 * makes that impossible: a parse that cannot finish inside its budget kills its own worker
 * and leaves this process running.
 *
 * The heap cap is lowered through `heapMb` so the kill path runs against a small file in
 * milliseconds. A containment that nothing ever trips is a containment nobody has seen work.
 */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { openWorkbookParser, WorkbookParseError } from './workbook-parse.js'

const refuseBaseline = async () => { throw new Error('no baseline in this suite') }

/** A plain grid — not a Nexus workbook, so it falls to the deepest branch of the reader. */
async function grid(rows: number, columns: number): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Products')
  for (let r = 1; r <= rows; r++) {
    const row = sheet.getRow(r)
    for (let c = 1; c <= columns; c++) row.getCell(c).value = `cell ${r}-${c}`
  }
  return Buffer.from(await book.xlsx.writeBuffer())
}

describe('the import parse cannot take the API with it', () => {
  it('kills its own worker and keeps this process alive when a parse exceeds its heap', async () => {
    const file = await grid(4000, 40)
    const events: string[] = []
    const session = openWorkbookParser({ resolveBaseline: refuseBaseline, heapMb: 32, log: event => { events.push(event) } })
    const before = process.memoryUsage().heapUsed
    let failure: WorkbookParseError
    try {
      failure = await session.read('runaway.xlsx', file, 128 * 1024 * 1024).then(
        () => { throw new Error('the capped parse should have been refused') },
        (e: WorkbookParseError) => e)
    } finally {
      await session.close()
    }
    /*
     * 🔴 `reason`, not merely "it rejected". A worker that never started also rejects — the
     * first cut of this suite went green against one that died on `Cannot find module …js`,
     * having proved nothing about the heap at all.
     */
    expect(failure.reason).toBe('heap')
    // The host is the thing that used to die. It must be unscathed and still measurable.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024)
    expect(events).toContain('workbook.parse.died')
  }, 60_000)

  it('tells the operator what to do about a file too large to read, not just that it failed', async () => {
    const file = await grid(4000, 40)
    const session = openWorkbookParser({ resolveBaseline: refuseBaseline, heapMb: 32 })
    try {
      await session.read('runaway.xlsx', file, 128 * 1024 * 1024)
      expect.unreachable('the capped parse should have been refused')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbookParseError)
      expect((error as WorkbookParseError).reason).toBe('heap')
      expect((error as WorkbookParseError).message).toMatch(/split it into smaller workbooks/i)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('stops a parse that never finishes instead of letting the request hang', async () => {
    const session = openWorkbookParser({ resolveBaseline: refuseBaseline, timeoutMs: 40 })
    try {
      const failure = await session.read('slow.xlsx', await grid(1500, 30), 128 * 1024 * 1024).catch(e => e as WorkbookParseError)
      expect(failure).toBeInstanceOf(WorkbookParseError)
      expect(failure.reason).toBe('timeout')
    } finally {
      await session.close()
    }
  }, 60_000)

  it('parses an ordinary attribute workbook through the worker and returns its rows', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Products')
    sheet.addRow(['sku', 'field', 'action', 'value'])
    sheet.addRow(['GALE-JACKET', 'name', 'SET', 'Gale jacket'])
    const file = Buffer.from(await book.xlsx.writeBuffer())

    const session = openWorkbookParser({ resolveBaseline: refuseBaseline })
    try {
      const outcome = await session.read('attributes.xlsx', file, 128 * 1024 * 1024)
      expect(outcome.kind).toBe('transfer')
      expect(outcome.kind === 'transfer' && outcome.parsed.rows).toMatchObject([{ sku: 'GALE-JACKET', field: 'name', action: 'SET', value: 'Gale jacket' }])
      // The budget the batch spends is reported back, so a ZIP cannot exceed it part by part.
      expect(outcome.expandedBytes).toBeGreaterThan(0)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('refuses a part that would exceed the batch budget before loading it', async () => {
    const session = openWorkbookParser({ resolveBaseline: refuseBaseline })
    try {
      await expect(session.read('big.xlsx', await grid(400, 20), 1024)).rejects.toThrow(/expands beyond 128 MB/)
    } finally {
      await session.close()
    }
  }, 60_000)
})
