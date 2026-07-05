/**
 * FF2.5 — Dry-run preview orchestrator.
 *
 * Pure read-only — WRITES NOTHING to any DB (reads only via the injected prisma).
 * This is the safety gate before any mutating apply.
 *
 * Wires the pipeline:
 *   parseWorkbook  → parse xlsx bytes into ParsedWorkbook
 *   validateWorkbook → registry-driven cell validation (no DB)
 *   classifyColumns  → tag each column with import-scope metadata
 *   fetchCatalog     → read current DB state (bounded to referenced SKUs)
 *   computeDiff      → per-cell diff (no fingerprint/conflict detection yet — Task 7)
 *
 * If skuSet is empty (workbook has no rows with SKUs), fetchCatalog returns
 * empty WorkbookData and computeDiff returns an empty diff — valid result.
 */

import { parseWorkbook } from './parse.js'
import type { ParsedWorkbook } from './parse.js'
import { validateWorkbook } from './validate.js'
import type { ValidationIssue } from './validate.js'
import { classifyColumns } from './scope.js'
import type { ImportScope } from './scope.js'
import { computeDiff } from './diff.js'
import type { ImportDiff } from './diff.js'
import { fetchCatalog } from '../fetch.js'
import type { WorkbookData } from '../fetch.js'

// ── Public interface ───────────────────────────────────────────────────────────

export interface PreviewResult {
  validation: ValidationIssue[]
  diff: ImportDiff
  scope: ImportScope
  meta: ParsedWorkbook['meta']
}

// ── previewImport ─────────────────────────────────────────────────────────────

/**
 * Dry-run preview: parse the uploaded xlsx bytes, validate, classify, fetch
 * current DB state, and diff — all without writing anything.
 *
 * @param prisma  Injected Prisma client (typed `any`; avoids singleton import).
 *                Only read operations are called (findMany). No writes.
 * @param bytes   Raw xlsx file bytes (from multipart upload or artifact store).
 * @param scope   Which channel + markets (+ whether master columns are included)
 *                the operator intends to import.
 * @returns       PreviewResult: validation issues, per-cell diff, the scope
 *                passed in, and the workbook's snapshot metadata.
 */
export async function previewImport(
  prisma: any,
  bytes: Uint8Array,
  scope: ImportScope,
): Promise<PreviewResult> {
  // 1. Parse xlsx bytes → structured ParsedWorkbook (pure; no DB)
  const wb = await parseWorkbook(bytes)

  // 2. Registry-driven cell validation (pure; no DB)
  const validation = validateWorkbook(wb)

  // 3. Tag every workbook column with scope metadata (pure; no DB)
  const scoped = classifyColumns(wb, scope)

  // 4. Collect every SKU referenced in data sheets to bound the DB fetch.
  //    Iterates all sheets (Products + channel sheets); both emit rows with a
  //    'sku' cell. An empty skuSet still yields a valid (empty-diff) result.
  const skuSet = new Set<string>()
  for (const sheet of Object.values(wb.sheets)) {
    for (const row of sheet.rows) {
      const sku = String(row.cells['sku']?.value ?? '').trim()
      if (sku) skuSet.add(sku)
    }
  }

  // 5. Read current DB state — bounded to referenced SKUs + requested channel.
  //    fetchCatalog only calls prisma.product.findMany + prisma.channelListing.findMany;
  //    no create/update/delete methods are invoked.
  const current: WorkbookData = await fetchCatalog(prisma, {
    skuIn: [...skuSet],
    channels: [scope.channel],
  })

  // 6. Per-cell diff against current DB state (pure; no DB).
  //    NOTE: conflict detection via opts.fingerprints is wired in Task 7;
  //    pass empty opts here so no conflicts are raised yet.
  const diff = computeDiff(wb, scoped, current, {})

  return { validation, diff, scope, meta: wb.meta }
}
