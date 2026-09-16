import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import type { Prisma } from '@prisma/client'
import { transferTargetKey, type ProductTransferBoundary, type ProductTransferSelection, type TransferRow, type TransferIssue } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { writeCatalogWorkbook, type WorkbookScope, type EditingWorkbookBaseline } from './catalog-workbook.js'
import { TRANSFER_MAX_FILE_BYTES } from './catalog-transfer-file.js'
import { checkProductTransferBoundary, productTransferOptions } from './catalog-product-transfer.js'
import { TransferConflict } from './catalog-transfer.service.js'
import { resolveEbayWorkbook } from './catalog-ebay-workbook.js'
import { openWorkbookParser, type ParseSession } from './workbook-parse.js'
import type { SourceExclusion } from './catalog-source-mapping.js'

const EXPORT_KIND = 'product-editing-export-v3'
const INPUT_KIND = 'product-editing-input-v1'
export const PRODUCT_TRANSFER_MAX_BYTES = 50 * 1024 * 1024
export const PRODUCT_TRANSFER_MAX_OUTCOMES = 250_000
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
interface SavedExport extends EditingWorkbookBaseline { kind: typeof EXPORT_KIND; boundary: ProductTransferBoundary }
interface ParsedInput { rows: TransferRow[]; issues: TransferIssue[]; exclusions?: SourceExclusion[]; boundary?: ProductTransferBoundary; editing?: boolean; warnings?: string[] }
/** Stage timing for the import. The 2026-09-16 handler emitted nothing and was unreadable. */
export type ImportLog = (event: string, detail: Record<string, unknown>) => void

/** The workbook is only a reference to this user-owned, immutable export snapshot. */
export async function writeEditorWorkbook(scopes: WorkbookScope[], boundary: ProductTransferBoundary, userId: string | null) {
  const exportedAt = new Date(), expiresAt = new Date(exportedAt.getTime() + 30 * 24 * 60 * 60_000)
  const baseline: SavedExport = { kind: EXPORT_KIND, id: randomUUID(), scopes, boundary, exportedAt: exportedAt.toISOString(), expiresAt: expiresAt.toISOString(), aliasLabels: Object.fromEntries(boundary.listings.map(l => [l.aliasKey, l.aliasLabel ?? (l.aliasKey || 'Primary listing')])) }
  const bytes = await writeCatalogWorkbook(scopes, true, baseline)
  await prisma.bulkOperation.create({ data: { id: baseline.id, userId, status: 'COMPLETED', productCount: boundary.products.length, changeCount: 0,
    changes: json(baseline), expiresAt, completedAt: new Date() }, select: { id: true } })
  return bytes
}

/** The whole batch's expansion budget, spent across every part of one upload. */
const EXPANDED_BATCH_BYTES = 128 * 1024 * 1024

/**
 * Turn one parsed part into an editor input, doing the database work the worker cannot.
 *
 * The branch order is the worker's — v3 editing workbook, wide workbook, eBay export,
 * plain attribute file — and the flags are load-bearing: only the first and third are
 * `editing`, and a part without that flag is what puts the legacy-file warning on the
 * review.
 */
async function readEditorPart(session: ParseSession, buffer: Buffer, filename: string, productId: string, expanded: { bytes: number },
  baselineOf: () => SavedExport | undefined): Promise<ParsedInput> {
  const outcome = await session.read(filename, buffer, EXPANDED_BATCH_BYTES - expanded.bytes)
  expanded.bytes += outcome.expandedBytes
  if (outcome.kind === 'editing') {
    const baseline = baselineOf()
    if (!baseline) throw new TransferConflict('This workbook baseline is unavailable, expired or belongs to another product or user. Download a new editing workbook.')
    return { ...outcome.parsed, boundary: baseline.boundary, editing: true }
  }
  if (outcome.kind === 'ebay') return { ...await resolveEbayWorkbook(outcome.table, productId), editing: true }
  return outcome.parsed
}

/** ZIPs are staged as one complete review. No partial archive can quietly become an import. */
export async function readEditorTransfer(buffer: Buffer, filename: string, productId: string, userId: string | null, log?: ImportLog): Promise<ParsedInput> {
  if (!buffer.length || buffer.length > PRODUCT_TRANSFER_MAX_BYTES) throw new Error('Choose a file up to 50 MB; individual workbooks may contain at most 10 MB')
  const parts: { name: string; bytes: Buffer }[] = []
  if (/\.zip$/i.test(filename)) {
    const zip = await JSZip.loadAsync(buffer)
    const entries = Object.values(zip.files).filter(f => !f.dir)
    if (entries.length > 52) throw new Error('Import at most 50 workbook parts')
    const size = (entry: typeof entries[number]) => (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (entries.reduce((n, e) => n + size(e), 0) > PRODUCT_TRANSFER_MAX_BYTES || entries.some(e => size(e) > TRANSFER_MAX_FILE_BYTES)) throw new Error('The extracted archive exceeds the import size limits')
    const manifestFile = zip.file('manifest.json')
    if (!manifestFile || size(manifestFile) > 1024 * 1024) throw new Error('Use the complete Nexus editing ZIP, including its manifest')
    const manifest = JSON.parse(await manifestFile.async('string')) as { purpose: string; files: { filename: string; attributeRows: number }[] }
    if (manifest.purpose !== 'editing' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 50) throw new Error('Use a Nexus editing export ZIP')
    const names = new Set<string>()
    for (const part of manifest.files) {
      if (typeof part.filename !== 'string' || !/^[^/\\]+\.xlsx$/i.test(part.filename) || names.has(part.filename) || !Number.isSafeInteger(part.attributeRows) || part.attributeRows < 0) throw new Error('Invalid or duplicate workbook part in the archive manifest')
      names.add(part.filename)
      const file = zip.file(part.filename)
      if (!file) throw new Error(`The archive is missing ${part.filename}. Upload the complete export.`)
      parts.push({ name: part.filename, bytes: await file.async('nodebuffer') })
    }
    if (entries.some(e => !names.has(e.name) && !['manifest.json', 'README.txt'].includes(e.name))) throw new Error('The archive contains an undeclared file')
  } else parts.push({ name: filename, bytes: buffer })
  const out: ParsedInput = { rows: [], issues: [], exclusions: [], editing: true, warnings: [] }
  const targets = new Set<string>()
  const expanded = { bytes: 0 }
  /*
   * 🔴 The baseline lookup stays HERE, on the main thread, and the worker asks for it.
   * It carries the session identity, the 30-day expiry and `checkProductTransferBoundary`
   * — three checks that decide whether this upload may touch this product at all. None of
   * them belongs behind a structured clone in a thread that holds an untrusted file.
   */
  let baselineUsed: SavedExport | undefined
  const session = openWorkbookParser({
    log: (event, detail) => log?.(event, detail),
    resolveBaseline: async exportId => {
      const stored = await prisma.bulkOperation.findFirst({ where: { id: exportId, userId, expiresAt: { gt: new Date() } } })
      const baseline = stored?.changes as unknown as SavedExport | undefined
      if (!baseline || baseline.kind !== EXPORT_KIND || baseline.boundary.productId !== productId) throw new TransferConflict('This workbook baseline is unavailable, expired or belongs to another product or user. Download a new editing workbook.')
      await checkProductTransferBoundary(baseline.boundary)
      baselineUsed = baseline
      return baseline
    },
  })
  try {
    for (const part of parts) {
      const parsed = await readEditorPart(session, part.bytes, part.name, productId, expanded, () => baselineUsed)
      if (!parsed.editing) out.editing = false
      // Edits may remove columns/rows intentionally. Completeness is the declared part list,
      // not a requirement that every original attribute must still be present.
      const keys = new Set(parsed.rows.map(transferTargetKey))
      if ([...keys].some(k => targets.has(k))) throw new Error('Two workbook parts address the same product or listing. Combine its edits in one workbook before reviewing.')
      keys.forEach(k => targets.add(k))
      out.rows.push(...parsed.rows.map(r => ({ ...r, source: { ...r.source, file: part.name } })))
      out.issues.push(...parsed.issues.map(i => ({ ...i, source: { ...i.source, file: part.name } })))
      out.exclusions!.push(...(parsed.exclusions ?? []).map(i => ({ ...i, source: { ...i.source, file: part.name } })))
      out.warnings!.push(...(parsed.warnings ?? []))
      if (out.rows.length + out.issues.length + out.exclusions!.length > PRODUCT_TRANSFER_MAX_OUTCOMES) throw new Error('Import at most 250,000 attribute outcomes in one batch')
      if (parsed.boundary) {
        if (out.boundary && JSON.stringify(out.boundary) !== JSON.stringify(parsed.boundary)) throw new Error('These workbooks have different export selections. Review each export separately.')
        out.boundary = parsed.boundary
      }
    }
  } finally {
    // The worker outlives no request. A thread left running would keep both its heap and
    // the incident's failure mode alive between uploads.
    await session.close()
  }
  if (!out.editing) out.warnings!.push('This file includes a legacy workbook or attribute CSV. Its explicit SET, CLEAR and INHERIT actions determine changes; deleting a value beside SET can set empty text. Check every proposed change. Use a new editing workbook for blank cells to always preserve data.')
  return out
}

export async function inspectEditorTransfer(buffer: Buffer, filename: string, productId: string, userId: string | null, log?: ImportLog) {
  const stage = (event: string, started: number, detail: Record<string, unknown> = {}) =>
    log?.(event, { ms: Math.round(performance.now() - started), heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), ...detail })

  let t = performance.now()
  const parsed = await readEditorTransfer(buffer, filename, productId, userId, log)
  stage('import.parsed', t, { filename, bytes: buffer.length, rows: parsed.rows.length, issues: parsed.issues.length })

  t = performance.now()
  const options = await productTransferOptions(productId)
  stage('import.options', t)
  const skus = new Set(parsed.rows.map(r => r.sku))
  const productById = new Map(options.products.map(p => [p.id, p.sku]))
  const keys = new Set(parsed.rows.filter(r => r.entity !== 'Products').map(transferTargetKey))
  const selection: ProductTransferSelection = {
    productIds: options.products.filter(p => skus.has(p.sku)).map(p => p.id),
    includeShared: parsed.rows.some(r => r.entity === 'Products'), locales: [...new Set(parsed.rows.map(r => r.locale).filter(Boolean))],
    listingIds: options.listings.filter(l => keys.has(transferTargetKey({ ...l, entity: 'Listings', sku: productById.get(l.productId)! }))).map(l => l.id),
  }
  t = performance.now()
  const input = await prisma.bulkOperation.create({ data: { userId, status: 'COMPLETED', productCount: selection.productIds.length, changeCount: 0,
    changes: json({ kind: INPUT_KIND, productId, parsed }), uploadFilename: filename, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) }, select: { id: true } })
  stage('import.stored', t, { inputId: input.id })
  return { inputId: input.id, selection, filename, attributes: parsed.rows.length, issues: parsed.issues.length, warnings: parsed.warnings ?? [] }
}

export async function readEditorInput(inputId: string, productId: string, userId: string | null) {
  const input = await prisma.bulkOperation.findFirst({ where: { id: inputId, userId, expiresAt: { gt: new Date() } } })
  const payload = input?.changes as unknown as { kind: string; productId: string; parsed: ParsedInput } | undefined
  if (!payload || payload.kind !== INPUT_KIND || payload.productId !== productId) throw new TransferConflict('This upload is unavailable or expired. Upload the file again.')
  if (payload.parsed.boundary) await checkProductTransferBoundary(payload.parsed.boundary)
  return { ...payload.parsed, filename: input!.uploadFilename ?? 'Product workbook' }
}

export function requireEditorVersions<T extends ParsedInput>(parsed: T): T {
  const seen = new Set<string>()
  for (const row of parsed.rows) if (row.version === undefined && !seen.has(transferTargetKey(row))) {
    seen.add(transferTargetKey(row))
    parsed.issues.push({ ...row, field: 'version', message: 'Keep the exported record version intact. For supplier data without versions, use Map a source file to review against current data.' })
  }
  return parsed
}
