import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import type { Prisma } from '@prisma/client'
import { transferTargetKey, type ProductTransferBoundary, type ProductTransferSelection, type TransferRow, type TransferIssue, type TransferMode } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { writeCatalogWorkbook, type WorkbookScope, type EditingWorkbookBaseline } from './catalog-workbook.js'
import { TRANSFER_MAX_FILE_BYTES, readTransferFile } from './catalog-transfer-file.js'
import { checkProductTransferBoundary, productTransferOptions } from './catalog-product-transfer.js'
import { TransferConflict } from './catalog-transfer.service.js'
import { resolveEbayWorkbook, resolveEbayCatalogWorkbook } from './catalog-ebay-workbook.js'
import { resolveAmazonCatalogWorkbook } from './catalog-amazon-workbook.js'
import { sniffCsv, shopifyInventoryDoor } from './channel-file-sniff.js'
import { resolveShopifyCsv } from './catalog-shopify-csv.js'
import { openWorkbookParser, type ParseSession } from './workbook-parse.js'
import type { SourceExclusion } from './catalog-source-mapping.js'

const EXPORT_KIND = 'product-editing-export-v3'
const INPUT_KIND = 'product-editing-input-v1'
export const PRODUCT_TRANSFER_MAX_BYTES = 50 * 1024 * 1024
export const PRODUCT_TRANSFER_MAX_OUTCOMES = 250_000
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
interface SavedExport extends EditingWorkbookBaseline { kind: typeof EXPORT_KIND; boundary: ProductTransferBoundary }
/** CFI-4 — an identity the file suggests but the Owner must confirm (BUILD.md §1, D4). */
export interface IdentityProposal { fileSku: string; proposedSku: string; reason: string }
interface ParsedInput { rows: TransferRow[]; issues: TransferIssue[]; exclusions?: SourceExclusion[]; boundary?: ProductTransferBoundary; editing?: boolean; warnings?: string[]; links?: IdentityProposal[]
  /** PSIE — what each part was (the parse worker's verdict), in upload order. */
  kinds?: ('editing' | 'wide' | 'transfer' | 'ebay' | 'amazon' | 'shopify')[]
  /** PSIE — the editing baseline the file was checked against, when it is a Nexus editing file. */
  exportId?: string }
/**
 * CFI-4 / D1 — the Owner's confirmations, sent with an upload: `links` maps a file SKU to the Nexus SKU it is,
 * `confirmDeletes` lets a file's delete rows end their listings — `true` for every delete row, or the list of file
 * SKUs the Owner confirmed one by one. Both absent = nothing is assumed. Passed to the readers unchanged.
 */
export interface ChannelFileDecisions { links?: Record<string, string>; confirmDeletes?: boolean | string[] }
/** Stage timing for the import. The 2026-09-16 handler emitted nothing and was unreadable. */
export type ImportLog = (event: string, detail: Record<string, unknown>) => void

const CHANNEL_NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }
/**
 * PSIE — tab names a person reads: `Shared`, `Shared · DE`, `Amazon IT`, `Amazon IT · de`, `eBay DE · 11450`. Excel allows
 * 31 characters and no `[]:*?/\`; a repeated name gets ` 2`, ` 3`. The manifest, not the name, says where a tab goes.
 */
export function sheetTabNames(scopes: Pick<WorkbookScope, 'entity' | 'channel' | 'marketplace' | 'locale' | 'category'>[]): string[] {
  const used = new Set<string>()
  const clean = (name: string) => name.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim()
  return scopes.map(scope => {
    const base = scope.entity === 'Products'
      ? scope.locale ? `Shared · ${scope.locale.toUpperCase()}` : 'Shared'
      : [`${CHANNEL_NAMES[scope.channel] ?? scope.channel} ${scope.marketplace}`, scope.locale, scope.category].filter(Boolean).join(' · ')
    const trimmed = clean(base).slice(0, 28).trim()
    let name = trimmed, n = 2
    while (used.has(name.toLowerCase())) name = `${trimmed} ${n++}`
    used.add(name.toLowerCase())
    return name
  })
}

/**
 * The workbook is only a reference to this user-owned, immutable export snapshot.
 * `options.style: 'sheet'` (PSIE) — the product sheet's file: readable tab names, no action columns, short instructions.
 */
export async function writeEditorWorkbook(scopes: WorkbookScope[], boundary: ProductTransferBoundary, userId: string | null, options: { style?: 'sheet' } = {}) {
  const exportedAt = new Date(), expiresAt = new Date(exportedAt.getTime() + 30 * 24 * 60 * 60_000)
  if (options.style === 'sheet') sheetTabNames(scopes).forEach((name, i) => { scopes[i].sheet = name })
  const baseline: SavedExport = { kind: EXPORT_KIND, id: randomUUID(), scopes, boundary, exportedAt: exportedAt.toISOString(), expiresAt: expiresAt.toISOString(), aliasLabels: Object.fromEntries(boundary.listings.map(l => [l.aliasKey, l.aliasLabel ?? (l.aliasKey || 'Primary listing')])) }
  const bytes = await writeCatalogWorkbook(scopes, true, baseline, options.style === 'sheet' ? 'sheet' : 'catalog')
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
  baselineOf: () => SavedExport | undefined, decisions: ChannelFileDecisions = {}, ebayMarket?: string, changesOnly = false): Promise<ParsedInput> {
  const outcome = await session.read(filename, buffer, EXPANDED_BATCH_BYTES - expanded.bytes, { ...(ebayMarket ? { market: ebayMarket } : {}), ...(changesOnly ? { changesOnly } : {}) })
  expanded.bytes += outcome.expandedBytes
  if (outcome.kind === 'editing') {
    const baseline = baselineOf()
    if (!baseline) throw new TransferConflict('This workbook baseline is unavailable, expired or belongs to another product or user. Download a new editing workbook.')
    return { ...outcome.parsed, boundary: baseline.boundary, editing: true, kinds: ['editing'], exportId: baseline.id }
  }
  if (outcome.kind === 'ebay') return { ...await resolveEbayWorkbook(outcome.table, productId, { links: decisions.links, confirmDeletes: decisions.confirmDeletes }), editing: true, kinds: ['ebay'] }
  // CFI-1 — Amazon's own template, scoped to this product group; account and marketplace resolve from the
  // file and the group's listings (BUILD.md D5). Like the eBay export its rows carry verified coordinates.
  if (outcome.kind === 'amazon') return { ...await resolveAmazonCatalogWorkbook(outcome.parsed, { productId, mode: 'update', links: decisions.links, confirmDeletes: decisions.confirmDeletes }), editing: true, kinds: ['amazon'] }
  // NCF — Shopify's own product CSV (recognised by its header on the worker).
  if (outcome.kind === 'shopify') return { ...await resolveShopifyCsv(outcome.table, { productId, links: decisions.links }), editing: true, kinds: ['shopify'] }
  return { ...outcome.parsed, kinds: [outcome.kind] }
}

/**
 * The drawer has no marketplace chooser, and an eBay sheet named after its family (`AIREON`) in a file whose name states
 * no market cannot say which eBay site it is. When this product group's eBay listings sit on exactly ONE marketplace,
 * that is the answer; otherwise none is assumed and the reader's refusal names the choice.
 */
async function drawerEbayMarket(productId: string): Promise<string | undefined> {
  const markets = new Set((await productTransferOptions(productId)).listings.filter(l => l.channel === 'EBAY').map(l => l.marketplace))
  return markets.size === 1 ? [...markets][0] : undefined
}

/** ZIPs are staged as one complete review. No partial archive can quietly become an import. */
/** `options.changesOnly` (PSIE): an editing workbook returns only the cells the user changed (see `readCatalogWorkbook`). */
export async function readEditorTransfer(buffer: Buffer, filename: string, productId: string, userId: string | null, log?: ImportLog, decisions: ChannelFileDecisions = {},
  options: { changesOnly?: boolean } = {}): Promise<ParsedInput> {
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
  const out: ParsedInput = { rows: [], issues: [], exclusions: [], editing: true, warnings: [], kinds: [] }
  const ebayMarket = parts.some(part => /\.xls[xm]$/i.test(part.name)) ? await drawerEbayMarket(productId) : undefined
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
      const parsed = await readEditorPart(session, part.bytes, part.name, productId, expanded, () => baselineUsed, decisions, ebayMarket, options.changesOnly === true)
      out.kinds!.push(...parsed.kinds ?? [])
      if (parsed.exportId) out.exportId = parsed.exportId
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
      if (parsed.links?.length) (out.links ??= []).push(...parsed.links)
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

export async function inspectEditorTransfer(buffer: Buffer, filename: string, productId: string, userId: string | null, log?: ImportLog, decisions: ChannelFileDecisions = {}) {
  const stage = (event: string, started: number, detail: Record<string, unknown> = {}) =>
    log?.(event, { ms: Math.round(performance.now() - started), heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), ...detail })

  let t = performance.now()
  const parsed = await readEditorTransfer(buffer, filename, productId, userId, log, decisions)
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
  return { inputId: input.id, selection, filename, attributes: parsed.rows.length, issues: parsed.issues.length, warnings: parsed.warnings ?? [], links: parsed.links ?? [] }
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

/**
 * CFI-1 — the catalog page's upload (`POST /catalog-transfer/preview`), read like the drawer's: on the parse worker
 * (heap cap + deadline, the 2026-09-16 rule), and by what the file IS, not by the File type the operator picked.
 *
 * 🔴 Before this, "Nexus workbook" + Amazon's `GALE IT.xlsx` ran ExcelJS on the request thread for > 8 min
 * (records/2026-09-24-results.md §3, d6), and "Amazon template" parsed on the request thread too. The chosen type is
 * now a hint: when the file is something else, it is read as what it is and the review says so in one sentence.
 */
export async function readCatalogTransferUpload(buffer: Buffer, filename: string, input: {
  /** Empty = "use the file's marketplace": allowed for an Amazon template or an eBay workbook only. */
  format?: string; accountId?: string; market: string; familyId?: string; mode: TransferMode; blankPolicy?: 'ignore' | 'clear'
} & ChannelFileDecisions, log?: ImportLog): Promise<ParsedInput & { market: string }> {
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) throw new Error('Choose a non-empty file up to 10 MB')
  // A Nexus workbook or CSV names no marketplace of its own; its attribute dictionary needs the chosen one.
  const requireMarket = () => { if (!input.market) throw new Error(NEXUS_FILE_NEEDS_MARKET); return input.market }
  // NCF — a CSV is read by what its header says: Shopify's product CSV goes to the parse worker like a channel
  // workbook, Shopify's inventory CSV is refused (stock is never imported from a file), and every other CSV is read
  // here exactly as before (no worker, no ExcelJS).
  const csv = /\.csv$/i.test(filename) ? sniffCsv(buffer) : null
  if (csv?.kind === 'shopify-inventory-csv') throw new Error(shopifyInventoryDoor(filename))
  if (!/\.xls[xm]$/i.test(filename) && csv?.kind !== 'shopify-product-csv') { const market = requireMarket(); return { ...await readTransferFile(buffer, filename, { blankPolicy: input.blankPolicy }), market } }
  const session = openWorkbookParser({
    log: (event, detail) => log?.(event, detail),
    // An editing workbook belongs to the product it was exported from; the catalog page has no baseline for it.
    resolveBaseline: async () => { throw new Error('Return this editing workbook to its product editor. Its saved export baseline is required.') },
  })
  try {
    // The chosen marketplace is the eBay reader's last hint, after the sheet name and the file name.
    const outcome = await session.read(filename, buffer, EXPANDED_BATCH_BYTES, { blankPolicy: input.blankPolicy, market: input.market || undefined })
    const decisions = { links: input.links, confirmDeletes: input.confirmDeletes }
    if (outcome.kind === 'amazon') {
      const meta = outcome.parsed.meta
      // No chosen marketplace = the template's own (a chosen one that contradicts the file is refused by the reader).
      const market = input.market || meta.marketplace || ''
      const parsed = { ...await resolveAmazonCatalogWorkbook(outcome.parsed, { accountId: input.accountId || undefined, marketplace: input.market || undefined, familyId: input.familyId || undefined, mode: input.mode, ...decisions }) as ParsedInput, market }
      return input.format === 'amazon' ? parsed : withWarning(parsed, `${filename} is an Amazon template (${meta.marketplace ?? 'unknown marketplace'}, ${meta.contentLanguageTag ?? 'unknown language'}); it was read as one, not as the File type chosen.`)
    }
    if (outcome.kind === 'ebay') {
      // The table's marketplace came from its sheet, its file name, or the chosen one — in that order.
      const parsed = { ...await resolveEbayCatalogWorkbook(outcome.table, { ...decisions, market: input.market || undefined }) as ParsedInput, market: outcome.table.marketplace }
      return withWarning(parsed, `${filename} is an eBay workbook (sheet "${outcome.table.sheet}"); it was read as one${input.format === 'catalog' || !input.format ? ', not as a Nexus workbook' : ''}.`)
    }
    if (outcome.kind === 'shopify') {
      // Shopify's file names no store: the one chosen on the page when it is a Shopify store, else the only one connected.
      const parsed = await resolveShopifyCsv(outcome.table, { accountId: input.accountId || undefined, links: input.links })
      return withWarning({ ...parsed, market: input.market || 'GLOBAL' } as ParsedInput & { market: string }, `${filename} is Shopify’s product CSV; it was read as one${input.format === 'catalog' || !input.format ? ', not as a Nexus file' : ''}.`)
    }
    const market = requireMarket()
    if (input.format === 'amazon') return { ...withWarning(outcome.parsed, `${filename} is not an Amazon template; it was read as a Nexus workbook.`), market }
    return { ...outcome.parsed, market }
  } finally {
    await session.close()
  }
}
const withWarning = <T extends ParsedInput>(parsed: T, warning: string): T => ({ ...parsed, warnings: [...(parsed.warnings ?? []), warning] })
/** The same sentence `marketOf` gives: a Nexus file cannot say which marketplace's attribute dictionary applies. */
export const NEXUS_FILE_NEEDS_MARKET = 'Select a marketplace for the attribute dictionary'
