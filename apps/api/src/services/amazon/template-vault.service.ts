/**
 * A7 (XLSM hybrid) — Amazon template vault + "Export for Amazon (.xlsm)".
 *
 * Every Amazon official template the operator imports is captured verbatim
 * (owner decision: auto-capture ON). Export clones those bytes and rewrites
 * ONLY the Template sheet's data rows from the grid's current truth
 * (`rewriteTemplateDataRows`) — so the exported file keeps Amazon's own
 * valid-values sheets, localized dropdowns, macros and named ranges, and
 * re-uploads to Seller Central exactly like a hand-edited original.
 *
 * Reverse mapping reuses the SAME `suggestFlatFileMapping` the import wizard
 * uses (template-path tier, confidence 1.0 on real templates per A4C), so
 * import→export is symmetric by construction: a header maps to a grid column
 * id the identical way in both directions.
 *
 * Safety rails baked into row building (not optional):
 *   • `::record_action` is ALWAYS exported blank — blank is Amazon's default
 *     ("create or replace") in every locale; delete/partial tokens are
 *     localized dropdowns the operator picks in Excel deliberately.
 *   • FBA quantity is NEVER exported: quantity cells are blanked whenever the
 *     row's fulfillment channel says AMAZON/AFN (mirrors the import wizard's
 *     FBA belt and the Follow Master invariant — FBA qty is Amazon-managed).
 */

import type { PrismaClient } from '@prisma/client'
import {
  detectAmazonTemplate,
  rewriteTemplateDataRows,
  type AmazonTemplateMeta,
} from './template-workbook.js'
import {
  suggestFlatFileMapping,
  type FlatFileMappableColumn,
} from './flat-file-mapping.js'

const FBA_CHANNEL_RE = /amazon|amzn|afn/i
const FULFILLMENT_QTY_HEADER_RE = /^fulfillment_availability\b.*\.quantity$/

/** Stable vault key — v2 templates carry a UUID; legacy files synthesize one. */
export function vaultKeyFor(meta: AmazonTemplateMeta, filename: string): string {
  if (meta.templateIdentifier) return meta.templateIdentifier
  const mp = meta.marketplace ?? 'XX'
  const pts = meta.productTypes.join('+') || 'UNKNOWN'
  return `legacy:${mp}:${pts}:${filename.toLowerCase()}`
}

/**
 * Upsert the original template bytes. Called fire-and-forget from /parse —
 * throws are the caller's to log, never to surface (a vault hiccup must not
 * fail an import).
 */
export async function captureTemplateToVault(
  prisma: PrismaClient,
  bytes: Uint8Array,
  meta: AmazonTemplateMeta,
  filename: string,
): Promise<void> {
  const key = vaultKeyFor(meta, filename)
  const data = {
    marketplace: meta.marketplace ?? 'XX',
    productTypes: meta.productTypes,
    headerLanguageTag: meta.headerLanguageTag ?? null,
    filename,
    bytes: Buffer.from(bytes),
  }
  await prisma.amazonTemplateVault.upsert({
    where: { templateIdentifier: key },
    create: { templateIdentifier: key, ...data },
    update: data,
  })
}

export interface VaultEntrySummary {
  id: string
  templateIdentifier: string
  marketplace: string
  productTypes: string[]
  headerLanguageTag: string | null
  filename: string
  capturedAt: Date
  updatedAt: Date
}

/** Vault entries WITHOUT the workbook bytes (list stays cheap). */
export async function listVaultEntries(
  prisma: PrismaClient,
  marketplace?: string,
): Promise<VaultEntrySummary[]> {
  return prisma.amazonTemplateVault.findMany({
    where: marketplace ? { marketplace } : undefined,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      templateIdentifier: true,
      marketplace: true,
      productTypes: true,
      headerLanguageTag: true,
      filename: true,
      capturedAt: true,
      updatedAt: true,
    },
  })
}

/**
 * Pure row builder — grid rows (keyed by manifest column id) → template rows
 * (keyed by verbatim template header). Exported for tests.
 */
export function buildTemplateDataRows(
  templateHeaders: string[],
  columns: FlatFileMappableColumn[],
  gridRows: Array<Record<string, unknown>>,
): { dataRows: Array<Record<string, string>>; mappedHeaders: number; skippedEmptyRows: number } {
  const { mappings } = suggestFlatFileMapping(templateHeaders, columns)
  const colIdByHeader = new Map<string, string>()
  for (const m of mappings) {
    if (m.columnId) colIdByHeader.set(m.header, m.columnId)
  }

  const dataRows: Array<Record<string, string>> = []
  let skippedEmptyRows = 0
  for (const row of gridRows) {
    const fulfillment = String(
      row['fulfillment_availability__fulfillment_channel_code'] ?? row['fulfillment_channel_code'] ?? '',
    )
    const isFbaRow = FBA_CHANNEL_RE.test(fulfillment)
    const out: Record<string, string> = {}
    let any = false
    for (const header of templateHeaders) {
      if (header === '::record_action') continue // always blank — operator picks in Excel
      if (isFbaRow && FULFILLMENT_QTY_HEADER_RE.test(header)) continue // FBA qty is Amazon-managed
      const colId = colIdByHeader.get(header)
      if (!colId) continue
      const raw = row[colId]
      if (raw == null) continue
      // Amazon cells are single-line; collapse embedded breaks (mirrors /export).
      const v = String(raw).replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim()
      if (v === '') continue
      out[header] = v
      any = true
    }
    if (!any) {
      skippedEmptyRows++
      continue
    }
    dataRows.push(out)
  }
  return { dataRows, mappedHeaders: colIdByHeader.size, skippedEmptyRows }
}

export interface TemplateExportResult {
  bytes: Buffer
  sourceFilename: string
  templateIdentifier: string
  marketplace: string
  rowsWritten: number
  mappedHeaders: number
  totalHeaders: number
  skippedEmptyRows: number
}

/**
 * Build the "Export for Amazon" workbook: vault bytes + grid rows → .xlsm.
 * `columns` come from the CLIENT's manifest (possibly a multi-category union)
 * so the reverse mapping sees exactly the column ids the grid rows use.
 */
export async function buildAmazonTemplateExport(
  prisma: PrismaClient,
  opts: {
    marketplace: string
    templateIdentifier?: string
    columns: FlatFileMappableColumn[]
    rows: Array<Record<string, unknown>>
  },
): Promise<TemplateExportResult> {
  const entry = opts.templateIdentifier
    ? await prisma.amazonTemplateVault.findUnique({ where: { templateIdentifier: opts.templateIdentifier } })
    : await prisma.amazonTemplateVault.findFirst({
        where: { marketplace: opts.marketplace },
        orderBy: { updatedAt: 'desc' },
      })
  if (!entry) {
    throw new Error(
      `No Amazon template in the vault for ${opts.marketplace} — import an Amazon-downloaded template (.xlsm) once and it becomes the export base automatically`,
    )
  }

  const bytes = new Uint8Array(entry.bytes)
  const parsed = await detectAmazonTemplate(bytes)
  if (!parsed) {
    throw new Error('Vaulted workbook no longer parses as an Amazon template — re-import the original to refresh it')
  }

  const { dataRows, mappedHeaders, skippedEmptyRows } = buildTemplateDataRows(
    parsed.headers,
    opts.columns,
    opts.rows,
  )
  const rewritten = await rewriteTemplateDataRows(bytes, dataRows)

  return {
    bytes: rewritten.bytes,
    sourceFilename: entry.filename,
    templateIdentifier: entry.templateIdentifier,
    marketplace: entry.marketplace,
    rowsWritten: rewritten.rowsWritten,
    mappedHeaders,
    totalHeaders: parsed.headers.length,
    skippedEmptyRows,
  }
}
