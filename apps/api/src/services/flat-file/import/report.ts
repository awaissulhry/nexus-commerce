/**
 * FF2.8a — generateProcessingReport: annotated workbook producer.
 *
 * Given the original uploaded workbook bytes and the results of validation
 * and/or apply, returns a new workbook that is a faithful copy of the
 * original PLUS two appended columns on every visible data sheet:
 *
 *   Status  — FAILED | SKIPPED | WARN | OK (per-row outcome)
 *   Errors  — semicolon-joined validation messages and apply detail
 *
 * Skipped sheets: _meta (veryHidden metadata store) and README (instructions).
 * No timestamps or volatile values are injected — output is deterministic for
 * the same inputs.
 *
 * Pure function — no DB access, no side effects.
 */

import ExcelJS from 'exceljs'
import type { ValidationIssue } from './validate.js'
import type { ApplyResult } from './apply.js'

// ── Public interface ──────────────────────────────────────────────────────────

export interface ReportInput {
  validation: ValidationIssue[]
  apply?: ApplyResult
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sheet names that must never receive Status/Errors annotation columns. */
const SKIP_SHEETS = new Set<string>(['_meta', 'README'])

// ── generateProcessingReport ─────────────────────────────────────────────────

/**
 * Load the original uploaded workbook, annotate each visible data sheet with
 * Status and Errors columns derived from validation issues and apply results,
 * and return the annotated workbook bytes.
 *
 * @param originalBytes - The raw bytes of the uploaded .xlsx file.
 * @param input         - Validation issues and optional apply result.
 * @returns             - Annotated workbook as a Uint8Array.
 */
export async function generateProcessingReport(
  originalBytes: Uint8Array,
  input: ReportInput,
): Promise<Uint8Array> {
  // ── Load original workbook ─────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(originalBytes) as any)

  // ── Index validation issues: sheet → rowNumber → issue[] ──────────────────
  const bySheetRow = new Map<string, Map<number, ValidationIssue[]>>()
  for (const issue of input.validation) {
    let byRow = bySheetRow.get(issue.sheet)
    if (!byRow) {
      byRow = new Map<number, ValidationIssue[]>()
      bySheetRow.set(issue.sheet, byRow)
    }
    let arr = byRow.get(issue.rowNumber)
    if (!arr) {
      arr = []
      byRow.set(issue.rowNumber, arr)
    }
    arr.push(issue)
  }

  // ── Index apply row results: sku → { status, detail? } ────────────────────
  const applyBySku = new Map<string, { status: 'SUCCESS' | 'SKIPPED' | 'FAILED'; detail?: string }>()
  if (input.apply) {
    for (const r of input.apply.rows) {
      applyBySku.set(r.sku, { status: r.status, detail: r.detail })
    }
  }

  // ── Annotate each visible data sheet ───────────────────────────────────────
  for (const ws of wb.worksheets) {
    if (SKIP_SHEETS.has(ws.name)) continue

    // Scan header row (row 1) to locate the sku column and the rightmost column.
    const headerRow = ws.getRow(1)
    let skuColNumber = -1
    let lastColNumber = 0

    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (colNumber > lastColNumber) lastColNumber = colNumber
      const val = cell.value
      if (typeof val === 'string' && val === 'sku') {
        skuColNumber = colNumber
      }
    })

    if (lastColNumber === 0) continue // sheet has no columns — skip

    const statusCol = lastColNumber + 1
    const errorsCol = lastColNumber + 2

    // Write Status and Errors headers (bold, matching existing header style)
    const sh = headerRow.getCell(statusCol)
    sh.value = 'Status'
    sh.font = { bold: true }

    const eh = headerRow.getCell(errorsCol)
    eh.value = 'Errors'
    eh.font = { bold: true }

    // Retrieve pre-indexed issues for this sheet (may be undefined if none)
    const byRow = bySheetRow.get(ws.name)

    // Iterate data rows (2 .. rowCount)
    const totalRows = ws.rowCount
    for (let r = 2; r <= totalRows; r++) {
      const row = ws.getRow(r)

      // Skip genuinely empty rows (e.g. trailing whitespace rows in the xlsx)
      let rowIsEmpty = true
      row.eachCell({ includeEmpty: false }, () => { rowIsEmpty = false })
      if (rowIsEmpty) continue

      // Read the SKU value to look up the apply result
      const rawSku = skuColNumber > 0 ? row.getCell(skuColNumber).value : null
      const sku = rawSku != null ? String(rawSku) : ''

      // Collect validation issues for this (sheet, rowNumber) pair
      const issues: ValidationIssue[] = byRow ? (byRow.get(r) ?? []) : []
      const hasErrors = issues.some(i => i.level === 'error')
      const hasWarns = issues.some(i => i.level === 'warn')

      // Collect apply result for this SKU (undefined if no apply provided)
      const applyRow = sku ? applyBySku.get(sku) : undefined

      // ── Compute Status ─────────────────────────────────────────────────────
      // Priority: FAILED > SKIPPED > WARN > OK
      let status: string
      if (hasErrors || applyRow?.status === 'FAILED') {
        status = 'FAILED'
      } else if (applyRow?.status === 'SKIPPED') {
        status = 'SKIPPED'
      } else if (hasWarns) {
        status = 'WARN'
      } else {
        status = 'OK'
      }

      // ── Compute Errors string ──────────────────────────────────────────────
      // Format: "[error] message" or "[warn] message", separated by " ; ".
      // Apply detail is appended for FAILED and SKIPPED rows.
      const parts: string[] = []
      for (const issue of issues) {
        parts.push('[' + issue.level + '] ' + issue.message)
      }
      if (
        applyRow &&
        (applyRow.status === 'FAILED' || applyRow.status === 'SKIPPED') &&
        applyRow.detail
      ) {
        parts.push(applyRow.detail)
      }

      // Write annotation cells
      row.getCell(statusCol).value = status
      if (parts.length > 0) {
        row.getCell(errorsCol).value = parts.join(' ; ')
      }
    }
  }

  // ── Serialise and return ───────────────────────────────────────────────────
  return new Uint8Array(await wb.xlsx.writeBuffer())
}
