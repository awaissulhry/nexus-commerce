/**
 * FF2.8a — generateProcessingReport TDD tests.
 *
 * Written BEFORE the implementation (TDD).
 *
 * Suites:
 *   1.  Validation error → Amazon sheet row 2 Status=FAILED, Errors contains message
 *   2.  Apply SUCCESS   → row 2 Status=OK
 *   3.  Apply SKIPPED   → row 2 Status=SKIPPED, Errors contains detail
 *   4.  _meta + README sheets are NOT annotated (no Status column added)
 */

import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { generateWorkbook } from '../../workbook-generator.js'
import { generateProcessingReport } from '../report.js'
import { MASTER_FIELDS } from '../../registry/master-fields.js'
import { CHANNEL_MARKET_FIELDS } from '../../registry/channel-fields.js'
import type { WorkbookModel } from '../../registry/types.js'
import type { WorkbookData } from '../../fetch.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MODEL: WorkbookModel = {
  markets: { AMAZON: ['IT'], EBAY: [], SHOPIFY: [] },
  sheets: [
    {
      name: 'Products',
      sharedFields: MASTER_FIELDS,
      marketFields: [],
    },
    {
      name: 'Amazon',
      channel: 'AMAZON',
      sharedFields: [],
      marketFields: CHANNEL_MARKET_FIELDS,
    },
  ],
}

const DATA: WorkbookData = {
  products: [{ sku: 'P1', parent_sku: '', ean: '1234567890123' }],
  listings: {
    AMAZON: [
      {
        sku: 'P1',
        marketplace: 'IT',
        followMasterPrice: true,
        masterPrice: 99.9,
        priceOverride: null,
      },
    ],
    EBAY: [],
    SHOPIFY: [],
  },
}

const META = { snapshotId: 'test-snap', exportedAt: '2026-01-01' }

// ── Helper: read annotation columns from a worksheet ─────────────────────────

interface SheetAnnotations {
  hasStatus: boolean
  hasErrors: boolean
  rows: Array<{ status: string; errors: string }>
}

async function readAnnotations(
  reportBytes: Uint8Array,
  sheetName: string,
): Promise<SheetAnnotations> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(reportBytes))
  const ws = wb.getWorksheet(sheetName)
  if (!ws) return { hasStatus: false, hasErrors: false, rows: [] }

  let statusCol = -1
  let errorsCol = -1
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const v = cell.value
    if (typeof v === 'string' && v === 'Status') statusCol = colNumber
    if (typeof v === 'string' && v === 'Errors') errorsCol = colNumber
  })

  const rows: Array<{ status: string; errors: string }> = []
  const totalRows = ws.rowCount
  for (let r = 2; r <= totalRows; r++) {
    const row = ws.getRow(r)
    let isEmpty = true
    row.eachCell({ includeEmpty: false }, () => { isEmpty = false })
    if (isEmpty) continue

    const status = statusCol > 0 ? String(row.getCell(statusCol).value ?? '') : ''
    const errors = errorsCol > 0 ? String(row.getCell(errorsCol).value ?? '') : ''
    rows.push({ status, errors })
  }

  return { hasStatus: statusCol > 0, hasErrors: errorsCol > 0, rows }
}

// ── Suite 1: validation error annotation ─────────────────────────────────────

describe('generateProcessingReport — validation error', () => {
  it('Amazon sheet gains Status + Errors headers; row 2 Status=FAILED, Errors contains the message', async () => {
    const originalBytes = await generateWorkbook(MODEL, DATA, META)
    const reportBytes = await generateProcessingReport(originalBytes, {
      validation: [
        {
          sheet: 'Amazon',
          rowNumber: 2,
          column: 'title@IT',
          level: 'error',
          message: 'too long',
        },
      ],
    })

    const ann = await readAnnotations(reportBytes, 'Amazon')
    expect(ann.hasStatus).toBe(true)
    expect(ann.hasErrors).toBe(true)
    expect(ann.rows).toHaveLength(1)
    expect(ann.rows[0]!.status).toBe('FAILED')
    expect(ann.rows[0]!.errors).toContain('too long')
  })
})

// ── Suite 2: apply SUCCESS ────────────────────────────────────────────────────

describe('generateProcessingReport — apply SUCCESS', () => {
  it('Amazon sheet row 2 Status=OK when apply returns SUCCESS for the SKU', async () => {
    const originalBytes = await generateWorkbook(MODEL, DATA, META)
    const reportBytes = await generateProcessingReport(originalBytes, {
      validation: [],
      apply: {
        rows: [{ sku: 'P1', status: 'SUCCESS' }],
        applied: 1,
        skipped: 0,
        failed: 0,
        inverseDiff: [],
      },
    })

    const ann = await readAnnotations(reportBytes, 'Amazon')
    expect(ann.rows).toHaveLength(1)
    expect(ann.rows[0]!.status).toBe('OK')
  })
})

// ── Suite 3: apply SKIPPED ────────────────────────────────────────────────────

describe('generateProcessingReport — apply SKIPPED', () => {
  it('Amazon sheet row 2 Status=SKIPPED and Errors contains the detail', async () => {
    const originalBytes = await generateWorkbook(MODEL, DATA, META)
    const reportBytes = await generateProcessingReport(originalBytes, {
      validation: [],
      apply: {
        rows: [{ sku: 'P1', status: 'SKIPPED', detail: 'out-of-scope' }],
        applied: 0,
        skipped: 1,
        failed: 0,
        inverseDiff: [],
      },
    })

    const ann = await readAnnotations(reportBytes, 'Amazon')
    expect(ann.rows).toHaveLength(1)
    expect(ann.rows[0]!.status).toBe('SKIPPED')
    expect(ann.rows[0]!.errors).toContain('out-of-scope')
  })
})

// ── Suite 4: _meta and README not annotated ───────────────────────────────────

describe('generateProcessingReport — skip _meta and README', () => {
  it('_meta sheet has no Status column after report generation', async () => {
    const originalBytes = await generateWorkbook(MODEL, DATA, META)
    const reportBytes = await generateProcessingReport(originalBytes, { validation: [] })

    const ann = await readAnnotations(reportBytes, '_meta')
    expect(ann.hasStatus).toBe(false)
  })

  it('README sheet has no Status column after report generation', async () => {
    const originalBytes = await generateWorkbook(MODEL, DATA, META)
    const reportBytes = await generateProcessingReport(originalBytes, { validation: [] })

    const ann = await readAnnotations(reportBytes, 'README')
    expect(ann.hasStatus).toBe(false)
  })
})
