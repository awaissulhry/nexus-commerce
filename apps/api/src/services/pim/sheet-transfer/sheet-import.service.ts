/**
 * PSIE — the product sheet's import: the ONE engine behind the sheet's Import button (the Owner's plan, 2026-09-26,
 * `docs/product-sheet-import-export/PLAN.md`).
 *
 *   drop a file → read (parse worker) → check (one pass over the whole file) → READY: one summary
 *   → Apply → save in chunks (many records per transaction) → DONE, with Undo
 *
 * What makes it fast and simple, measured against the drawer path (GALE-JACKET, 40 changed cells: 27,412 rows sent
 * back, 284 false problems, 75 s to save):
 *  - Only changed cells travel. A Nexus editing file is read in changes-only mode (`readCatalogWorkbook`): a blank cell
 *    or one equal to the export is never returned, checked or saved.
 *  - One check pass for the whole file: contexts, contracts and the plan are built once, never per 100 records, and
 *    the schema caches are cleared once per job, never per batch.
 *  - Saving puts many records in one transaction, so the family's readiness is rebuilt once per chunk
 *    (`produceReadiness` dedupes inside a transaction) and the read cache is refreshed once per chunk. A chunk that
 *    hits a refusal is saved again one record per transaction, so one refused record never blocks the others.
 *  - A cell that ALSO changed in Nexus after the export is a problem for that cell only (`expected`, three-way),
 *    instead of the whole record failing its version check.
 *
 * The rules stay the proven ones: `buildTransferPlan` decides every cell, `applyTransferRecord` saves every record
 * (dependencies, re-plan, write fingerprint, compare-and-set) exactly as the catalog runner does.
 *
 * 🔴 Saving writes Nexus only (the Owner's D1 (a)): shared text still cascades to the listings that follow it, but no
 * channel update is queued (`queueOutbound: false`). Sending to the channels is its own step in the product.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { withWorkspace, workspaceContext } from '../../../lib/workspace-context.js'
import {
  transferTargetKey, transferCanonical, type TransferRow, type TransferIssue, type TransferCell, type ProductTransferBoundary, type ProductTransferSelection,
  type SheetImportStatus, type SheetImportSummary, type SheetImportFormat, type SheetImportChange, type SheetImportChangesPage, type SheetImportState,
  type SheetImportDelete, type SheetImportLink, type SheetImportChangeStatus,
} from '@nexus/shared/catalog-transfer'
import { readEditorTransfer, type ChannelFileDecisions, type ImportLog } from '../catalog-editor-workbook.js'
import { productTransferOptions, resolveProductTransferBoundary, assertProductTransferRows } from '../catalog-product-transfer.js'
import { buildTransferPlan, fingerprint, isEmptyChannelValue, transferContracts, type TransferTarget } from '../catalog-transfer-plan.js'
import { loadTransferContext, TransferConflict } from '../catalog-transfer.service.js'
import { applyTransferRecord, retryWriteConflicts, writeConflict } from '../catalog-transfer-jobs.js'
import { clearSheetColumnCache } from '../sheet-columns.service.js'
import { clearFieldCatalogueCache } from '../mapping/field-catalogue.service.js'
import { createReferenceResolver } from '../reference-values.service.js'
import { withCachedSchemas } from '../cached-schema-context.js'
import { productReadCacheService } from '../../product-read-cache.service.js'
import { deferReadiness, reconcileFamilyReadiness } from '../readiness-index.service.js'

export const SHEET_IMPORT_KIND = 'sheet-import-v1'
const LEASE_MS = 60_000
/** A check stays valid this long; after it the file must be dropped again. */
const REVIEW_MS = 24 * 60 * 60_000
/**
 * Records per save transaction. Each transaction rebuilds the family's readiness once at commit (~6 s for a 40-variant
 * family), so fewer, larger transactions save faster; 150 records (~12 s of writes) stays well inside the 60 s deadline.
 */
export const SAVE_CHUNK = 150
const CHANGES_PAGE = 100
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const productKey = (sku: string) => JSON.stringify(['Products', sku])
const CHANNEL_NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

interface Payload {
  kind: typeof SHEET_IMPORT_KIND
  productId: string
  market: string
  format: SheetImportFormat
  boundary: ProductTransferBoundary
  exportId?: string
  summary: SheetImportSummary
  warnings: string[]
  links: SheetImportLink[]
  deletes: SheetImportDelete[]
  destinations: string[]
  listingIds: string[]
  startedAt: string
  reviewToken?: string
  reviewExpiresAt?: string
  receipt?: { saved: number; failed: number; skipped: number }
  undoOf?: string
  undoneBy?: string
  /** An undo saves on its own when its check finds no problem. */
  autoApply?: boolean
  /** `${targetKey}|${locale}|${field}` → the column's label, from the export's dictionary. */
  labels: Record<string, string>
  /** The families whose readiness is rebuilt right after the save, and how that went. */
  readiness?: { state: 'pending' | 'done' | 'failed'; roots: string[]; error?: string }
}
interface Dependency { sku: string; key?: string; before?: Record<string, unknown> | null; ignoreParent?: true }
/** The record shape `applyTransferRecord` reads, plus what the review page shows. */
interface RecordPayload {
  rows: TransferRow[]
  target?: TransferTarget
  changed?: boolean
  dependencies?: Dependency[]
  sharedBefore?: Record<string, unknown> | null
  declaredParent?: boolean
  issues: TransferIssue[]
  /** The changed cells of a record that has a problem (its target is not kept): shown, never saved. */
  cells?: TransferCell[]
}
type RecordStatus = 'REVIEWED' | 'UNCHANGED' | 'INVALID' | 'EXCLUDED' | 'SUCCESS' | 'FAILED'
const payloadOf = (value: unknown) => (value as Payload | null)?.kind === SHEET_IMPORT_KIND ? value as Payload : null
const emptySummary = (): SheetImportSummary => ({ changes: 0, problems: 0, products: 0, listings: 0, unchanged: 0, created: 0, ended: 0, prices: 0 })

// ── reading ───────────────────────────────────────────────────────────────────────────────────

export interface StartSheetImport {
  buffer: Buffer; filename: string; productId: string; market: string; userId: string | null
  decisions?: ChannelFileDecisions; log?: ImportLog
}

/**
 * Read the file and start its check. Returns at once with the job in CHECKING; the check runs in the background and
 * the page polls `sheetImportStatus`. A file that cannot be read at all is refused here, with the reader's sentence.
 */
export async function startSheetImport(input: StartSheetImport): Promise<SheetImportStatus> {
  const started = performance.now()
  const parsed = await readEditorTransfer(input.buffer, input.filename, input.productId, input.userId, input.log, input.decisions ?? {}, { changesOnly: true })
  input.log?.('sheet-import.read', { ms: Math.round(performance.now() - started), rows: parsed.rows.length, issues: parsed.issues.length })
  const kinds = parsed.kinds ?? []
  const format: SheetImportFormat = kinds.includes('amazon') ? 'amazon' : kinds.includes('ebay') ? 'ebay'
    : kinds.length && kinds.every(k => k === 'editing') ? 'nexus' : kinds.includes('wide') || kinds.includes('editing') ? 'nexus-legacy' : 'csv'
  // The file decides the scope: the products and listings it names, inside this product's family.
  const scoped = parsed.boundary ? { boundary: parsed.boundary, rows: parsed.rows, outside: [] as TransferIssue[] } : await scopeFromRows(input.productId, parsed.rows)
  const labels = parsed.exportId ? await exportLabels(parsed.exportId, input.userId) : {}
  return createSheetImport({
    rows: scoped.rows, issues: [...parsed.issues, ...scoped.outside], boundary: scoped.boundary, market: input.market, format, filename: input.filename, userId: input.userId,
    warnings: parsed.editing === false && format !== 'csv' ? [] : parsed.warnings ?? [], links: parsed.links ?? [], exportId: parsed.exportId, labels,
    deletes: deletesOf(parsed.rows, parsed.issues), log: input.log,
  })
}

/**
 * A channel's own file (or a CSV) names SKUs, not a Nexus selection. Its scope is every product and listing of this
 * product's family that the file names; a row outside the family is a problem, never a reason to refuse the file.
 */
async function scopeFromRows(productId: string, rows: TransferRow[]) {
  const options = await productTransferOptions(productId)
  const skuById = new Map(options.products.map(p => [p.id, p.sku]))
  const inFamily = new Set(options.products.map(p => p.sku))
  const listingKeys = new Map(options.listings.map(l => [transferTargetKey({ ...l, entity: 'Listings', sku: skuById.get(l.productId)! }), l]))
  const kept: TransferRow[] = [], outside: TransferIssue[] = []
  for (const row of rows) {
    if (!inFamily.has(row.sku)) { outside.push({ ...row, message: `${row.fileSku ?? row.sku} is not in this product family. Import it from its own product.` }); continue }
    if (row.entity !== 'Products' && !listingKeys.has(transferTargetKey(row))) { outside.push({ ...row, message: `${row.sku} has no ${CHANNEL_NAMES[row.channel] ?? row.channel} ${row.marketplace} listing in Nexus for this account. Create the listing in the product first.` }); continue }
    kept.push(row)
  }
  const products = new Set(kept.map(r => r.sku)), listings = new Set(kept.filter(r => r.entity !== 'Products').map(transferTargetKey))
  if (!products.size) return { boundary: undefined, rows: kept, outside }
  const selection: ProductTransferSelection = {
    productIds: options.products.filter(p => products.has(p.sku)).map(p => p.id),
    includeShared: kept.some(r => r.entity === 'Products'),
    locales: kept.some(r => r.entity === 'Products') ? [...new Set(kept.filter(r => r.entity === 'Products').map(r => r.locale).filter(Boolean))] : [],
    listingIds: [...listingKeys.entries()].filter(([key]) => listings.has(key)).map(([, l]) => l.id),
  }
  return { boundary: await resolveProductTransferBoundary(productId, selection), rows: kept, outside }
}

/** The export's own column labels, so the review names a column the way the file did. */
async function exportLabels(exportId: string, userId: string | null): Promise<Record<string, string>> {
  const stored = await prisma.bulkOperation.findFirst({ where: { id: exportId, userId }, select: { changes: true } })
  const scopes = (stored?.changes as { scopes?: { entity: string; channel: string; accountId: string; marketplace: string; locale: string; fields: { field: string; label: string }[]; rows: TransferRow[] }[] } | null)?.scopes ?? []
  const labels: Record<string, string> = {}
  for (const scope of scopes) for (const field of scope.fields) labels[labelKey({ entity: scope.entity === 'Products' ? 'Products' : 'Overrides', channel: scope.channel, accountId: scope.accountId, marketplace: scope.marketplace, locale: scope.locale }, field.field)] = field.label
  return labels
}
const labelKey = (row: Pick<TransferRow, 'entity' | 'channel' | 'accountId' | 'marketplace' | 'locale'>, field: string) =>
  JSON.stringify([row.entity === 'Products' ? 'Products' : 'Overrides', row.channel, row.accountId, row.marketplace, row.locale, field])
const humanize = (field: string) => field.replace(/^value:/, '').replace(/__/g, ' ').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())

function deletesOf(rows: TransferRow[], issues: TransferIssue[]): SheetImportDelete[] {
  return [
    ...rows.filter(r => r.origin === 'channel-file' && r.entity === 'Listings' && r.field === 'presence' && r.action === 'SET')
      .map(r => ({ sku: r.sku, fileSku: r.fileSku ?? r.sku, channel: r.channel, marketplace: r.marketplace, accountId: r.accountId, confirmed: true })),
    ...issues.filter(i => i.field === 'presence').map(i => ({ sku: i.sku, fileSku: i.fileSku ?? i.sku, channel: i.channel ?? '', marketplace: i.marketplace ?? '', accountId: i.accountId ?? '', evidence: i.message, confirmed: false })),
  ]
}

// ── the job ───────────────────────────────────────────────────────────────────────────────────

interface CreateInput {
  rows: TransferRow[]; issues: TransferIssue[]; boundary?: ProductTransferBoundary; market: string; format: SheetImportFormat; filename: string; userId: string | null
  warnings: string[]; links: SheetImportLink[]; deletes: SheetImportDelete[]; exportId?: string; labels: Record<string, string>; undoOf?: string; autoApply?: boolean
  log?: ImportLog
}

async function createSheetImport(input: CreateInput): Promise<SheetImportStatus> {
  if (!input.rows.length && !input.issues.length) throw new Error('This file changes nothing: every cell is as it was exported. Change a value, then import it again.')
  const boundary = input.boundary
  const payload: Payload = { kind: SHEET_IMPORT_KIND, productId: boundary?.productId ?? '', market: input.market, format: input.format, boundary: boundary as ProductTransferBoundary,
    exportId: input.exportId, summary: emptySummary(), warnings: input.warnings, links: input.links, deletes: input.deletes, destinations: [], listingIds: [], startedAt: new Date().toISOString(),
    labels: input.labels, ...(input.undoOf ? { undoOf: input.undoOf } : {}), ...(input.autoApply ? { autoApply: true } : {}) }
  const job = await prisma.$transaction(async tx => {
    const history = await tx.importJob.create({ data: { jobName: input.filename, source: 'upload', filename: input.filename, fileKind: input.filename.split('.').pop()?.toLowerCase() ?? 'xlsx',
      targetEntity: SHEET_IMPORT_KIND, status: 'CHECKING', totalRows: 0, createdBy: input.userId } })
    return tx.bulkOperation.create({ data: { id: history.id, userId: input.userId, productCount: new Set(input.rows.map(r => r.sku)).size, changeCount: 0, status: 'CHECKING',
      changes: json(payload), processed: 0, total: 0, uploadFilename: input.filename, expiresAt: new Date(Date.now() + LEASE_MS) } })
  })
  // The check runs after the response; its lease is the job's own, so an interrupted check is marked FAILED by recovery.
  const context = workspaceContext()
  const run = () => checkSheetImport(job.id, input).catch(error => failJob(job.id, error))
  void (context ? withWorkspace(context, run) : run())
  return statusOf(job, payload)
}

/** The whole file in ONE pass: context, contracts and plan built once; records stored in bulk. */
async function checkSheetImport(jobId: string, input: CreateInput) {
  const started = performance.now()
  if (!input.boundary) {
    // Nothing in the file belongs to this family: every row is a problem already.
    return finishCheck(jobId, input, [], emptySummary(), { destinations: [], listingIds: [] })
  }
  assertProductTransferRows(input.boundary, input.rows)
  // A three-way cell (a Nexus editing file) replaces the record's version check with its own `expected` check.
  const rows = input.rows.map(row => row.expected !== undefined ? (({ version: _version, ...rest }) => rest)(row) as TransferRow : row)
  clearSheetColumnCache(); clearFieldCatalogueCache()
  const contracts = transferContracts(input.market)
  contracts.reference = createReferenceResolver()
  const { plan, context } = await withCachedSchemas(async () => {
    const context = rows.length ? await loadTransferContext(rows) : null
    const plan = context ? await buildTransferPlan(rows, 'update', context, contracts) : { targets: [] as TransferTarget[], issues: [] as TransferIssue[], warnings: [] as string[], exclusions: [] }
    return { plan, context }
  })
  // Records: one per product or listing the file touches, products first (parents before their variants), then listings.
  const groups = new Map<string, TransferRow[]>()
  for (const row of rows) { const key = transferTargetKey(row); if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(row) }
  const targets = new Map(plan.targets.map(t => [t.key, t]))
  const issuesByKey = new Map<string, TransferIssue[]>()
  const fileIssues: TransferIssue[] = [...input.issues]
  for (const issue of plan.issues) {
    const key = 'entity' in issue ? transferTargetKey(issue as unknown as TransferRow) : ''
    if (key && groups.has(key)) { if (!issuesByKey.has(key)) issuesByKey.set(key, []); issuesByKey.get(key)!.push(issue) } else fileIssues.push(issue)
  }
  const exclusions = new Set((plan.exclusions ?? []).map(e => transferTargetKey(e.identity as TransferRow)))
  const records: { key: string; payload: RecordPayload; status: RecordStatus }[] = []
  const summary = emptySummary()
  const changedProducts = new Set<string>()
  for (const [key, group] of groups) {
    const target = targets.get(key), issues = issuesByKey.get(key) ?? []
    // 🔴 Three-way: a cell the user changed that ALSO changed in Nexus after the export. Only that cell is a problem.
    for (const cell of target?.cells ?? []) {
      if (cell.verdict !== 'changed' || cell.expected === undefined) continue
      const exported = cell.expected === null ? null : cell.expected.action === 'CLEAR' ? null : cell.expected.value ?? null
      if (!sameValue(cell.before, exported)) issues.push({ ...cell, message: `Changed in Nexus after your export (now ${display(cell.before)}). Export a new file to change it.` })
    }
    const changed = !!target && (target.create || target.cells.some(c => c.verdict === 'changed') || !!target.presence || !!target.priceWrite)
    const status: RecordStatus = issues.length ? 'INVALID' : !target ? exclusions.has(key) ? 'EXCLUDED' : 'INVALID' : changed ? 'REVIEWED' : 'UNCHANGED'
    if (status === 'INVALID' && !issues.length) issues.push({ ...group[0], message: 'This row could not be checked. Download a new file and try again.' })
    if (status === 'REVIEWED' && target!.identity.entity === 'Products') changedProducts.add(target!.identity.sku)
    records.push({ key, status, payload: { rows: group, issues, ...(target && status === 'REVIEWED' ? { target, changed } : {}), ...(target && status === 'INVALID' ? { cells: target.cells.filter(c => c.verdict === 'changed') } : {}) } })
    for (const cell of target?.cells ?? []) if (cell.verdict === 'unchanged') summary.unchanged++
    if (status !== 'REVIEWED') continue
    summary.changes += target!.cells.filter(c => c.verdict === 'changed').length
    summary[target!.identity.entity === 'Products' ? 'products' : 'listings']++
    if (target!.create) summary.created++
    if (target!.presence) summary.ended++
    if (target!.priceWrite) summary.prices++
  }
  // Dependencies, as the catalog runner states them: a shared or parent product this record relies on is either saved
  // by this job (its key; the save reads what it saved) or must still be exactly what the check read (its snapshot).
  for (const record of records) {
    const target = record.payload.target
    if (!target || !context) continue
    const product = context.products.get(target.identity.sku)
    const parent = product?.parentId ? [...context.products.values()].find(p => p.id === product.parentId) : undefined
    // A variant this job does not change embeds its parent; when the job changes that parent, the variant is compared
    // without it (the parent is its own dependency here), or saving the parent would refuse every such listing.
    record.payload.dependencies = [...new Set([...(target.identity.entity !== 'Products' ? [target.identity.sku] : []), ...(parent ? [parent.sku] : [])])]
      .map(sku => changedProducts.has(sku) ? { sku, key: productKey(sku) }
        : { sku, before: context.products.get(sku) ?? null, ...(parent && sku !== parent.sku && changedProducts.has(parent.sku) ? { ignoreParent: true as const } : {}) })
  }
  summary.problems = fileIssues.length + records.reduce((n, r) => n + r.payload.issues.length, 0)
  if (fileIssues.length) records.push({ key: 'file', status: 'INVALID', payload: { rows: [], issues: fileIssues } })
  const order = (r: typeof records[number]) => {
    const target = r.payload.target, first = r.payload.rows[0]
    const entity = target?.identity.entity ?? first?.entity
    const variant = entity === 'Products' && !!context?.products.get(first?.sku ?? '')?.parentId
    return entity === 'Products' ? variant ? 1 : 0 : entity ? 2 : 3
  }
  records.sort((a, b) => order(a) - order(b))
  const listingIds = new Set<string>(), destinations = new Map<string, number>()
  for (const record of records) {
    const target = record.payload.target
    if (record.status !== 'REVIEWED' || !target) continue
    if (target.identity.entity !== 'Products' && target.before?.id) listingIds.add(String(target.before.id))
    const label = destinationOf(target.identity, input.boundary)
    destinations.set(label, (destinations.get(label) ?? 0) + 1)
  }
  input.log?.('sheet-import.checked', { jobId, ms: Math.round(performance.now() - started), records: records.length, changes: summary.changes, problems: summary.problems })
  // A contract's own note ("requirements from <date>; publish readiness is checked separately") says nothing about THIS
  // file, so the summary leaves it out; every other warning (a value kept outside a list, clears not read) stays.
  const warnings = plan.warnings.filter(w => !/: requirements from |: core product field definitions;/.test(w))
  return finishCheck(jobId, input, records, summary, { destinations: [...destinations.keys()], listingIds: [...listingIds], warnings })
}

async function finishCheck(jobId: string, input: CreateInput, records: { key: string; payload: RecordPayload; status: RecordStatus }[], summary: SheetImportSummary,
  extra: { destinations: string[]; listingIds: string[]; warnings?: string[] }) {
  if (!records.length && input.issues.length) {
    summary.problems = input.issues.length
    records.push({ key: 'file', status: 'INVALID', payload: { rows: [], issues: input.issues } })
  }
  const loaded = await prisma.bulkOperation.findUnique({ where: { id: jobId } })
  const payload = payloadOf(loaded?.changes)
  if (!loaded || !payload || loaded.status !== 'CHECKING') return
  for (let offset = 0; offset < records.length; offset += 500) {
    await prisma.importJobRow.createMany({ data: records.slice(offset, offset + 500).map((record, i) => ({ jobId, rowIndex: offset + i + 1, targetId: record.key,
      parsedValues: json(record.payload), status: record.status })) })
  }
  const ready = records.filter(r => r.status === 'REVIEWED').length
  const next: Payload = { ...payload, summary, destinations: extra.destinations, listingIds: extra.listingIds, warnings: [...new Set([...payload.warnings, ...(extra.warnings ?? [])])],
    reviewToken: fingerprint([jobId, summary, records.length, Date.now()]), reviewExpiresAt: new Date(Date.now() + REVIEW_MS).toISOString() }
  const claimed = await prisma.$transaction(async tx => {
    const claim = await tx.bulkOperation.updateMany({ where: { id: jobId, status: 'CHECKING' }, data: { status: 'READY', changes: json(next), changeCount: summary.changes, processed: 0, total: ready, expiresAt: new Date(next.reviewExpiresAt!) } })
    if (claim.count) await tx.importJob.update({ where: { id: jobId }, data: { status: 'READY', totalRows: records.length, planToken: next.reviewToken, planComputedAt: new Date(), planSummary: json(summary) } })
    return claim.count > 0
  })
  if (claimed && next.autoApply && !summary.problems && ready) await applySheetImport(jobId, loaded.userId, next.reviewToken!)
}

async function failJob(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  await prisma.$transaction(async tx => {
    await tx.bulkOperation.updateMany({ where: { id: jobId, status: { in: ['CHECKING', 'SAVING'] } }, data: { status: 'FAILED', completedAt: new Date(), expiresAt: null, errors: [{ message }] } })
    await tx.importJob.updateMany({ where: { id: jobId }, data: { status: 'FAILED', errorSummary: message, completedAt: new Date() } })
  }).catch(() => { /* recovery marks it later */ })
}

// ── saving ────────────────────────────────────────────────────────────────────────────────────

export async function readSheetImport(jobId: string, userId: string | null) {
  const job = await prisma.bulkOperation.findFirst({ where: { id: jobId, userId } })
  const payload = payloadOf(job?.changes)
  return job && payload ? { job, payload } : null
}

/**
 * Save the READY records. `reviewToken` proves the page shows this check. Problems are skipped (never saved); the
 * page says so on its button ("Apply 125 changes, skip 3"). Returns at once with the job in SAVING.
 */
export async function applySheetImport(jobId: string, userId: string | null, reviewToken: string): Promise<SheetImportStatus | null> {
  const loaded = await readSheetImport(jobId, userId)
  if (!loaded) return null
  const { job, payload } = loaded
  if (['SAVING', 'DONE', 'PARTIAL'].includes(job.status)) return statusOf(job, payload)
  if (job.status !== 'READY') throw new TransferConflict('This import is not ready to save. Drop the file again.')
  if (!reviewToken || payload.reviewToken !== reviewToken) throw new TransferConflict('This summary is out of date. Drop the file again.')
  if (payload.reviewExpiresAt && Date.parse(payload.reviewExpiresAt) <= Date.now()) throw new TransferConflict('This check expired. Drop the file again to check it against the current product.')
  if (!job.total) throw new TransferConflict('Nothing in this file can be saved. Fix the problems, then import it again.')
  const claimed = await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'READY' }, data: { status: 'SAVING', processed: 0, expiresAt: new Date(Date.now() + LEASE_MS) } })
  if (!claimed.count) return statusOf(await prisma.bulkOperation.findUniqueOrThrow({ where: { id: jobId } }), payload)
  await prisma.importJob.updateMany({ where: { id: jobId }, data: { status: 'SAVING' } })
  const context = workspaceContext()
  const run = () => saveSheetImport(jobId).catch(error => { if (!transient(error)) return failJob(jobId, error) })
  void (context ? withWorkspace(context, run) : run())
  return { ...statusOf(job, payload), state: 'SAVING' }
}

const saving = new Set<string>()
async function saveSheetImport(jobId: string) {
  if (saving.has(jobId)) return
  saving.add(jobId)
  try {
    const job = await prisma.bulkOperation.findUnique({ where: { id: jobId } }), payload = payloadOf(job?.changes)
    if (!job || !payload || job.status !== 'SAVING') return
    const started = performance.now()
    const all = await prisma.importJobRow.findMany({ where: { jobId }, orderBy: { rowIndex: 'asc' }, select: { id: true, targetId: true, parsedValues: true, status: true } })
    const pending = all.filter(r => r.status === 'REVIEWED')
    // R-AE-17 — every shared product this job declares, whatever its outcome.
    const declaredProductSkus = new Set(all.flatMap(r => { try { const key = JSON.parse(r.targetId ?? ''); return Array.isArray(key) && key[0] === 'Products' ? [String(key[1])] : [] } catch { return [] } }))
    clearSheetColumnCache(); clearFieldCatalogueCache()
    const contracts = transferContracts(payload.market)
    contracts.reference = createReferenceResolver()
    const referenceRows = pending.flatMap(r => (r.parsedValues as unknown as RecordPayload).rows)
    const reference = referenceRows.length ? await loadTransferContext(referenceRows) : undefined
    const save = (item: typeof pending[number], readCacheIds: Set<string>) => applyTransferRecord({ jobId, item, boundary: payload.boundary, mode: 'update', sharedCopy: false,
      contracts, reference, declaredProductSkus, userId: job.userId, options: { queueOutbound: false, readCacheIds } })
    const refresh = async (ids: Set<string>) => { if (ids.size) await productReadCacheService.refreshInTransaction(prisma as unknown as Prisma.TransactionClient, [...ids]) }
    // 🔴 Readiness is NOT rebuilt inside the save transactions (the Owner's choice, 2026-09-26): each family is noted and
    // rebuilt once, right after the last save commits (`refreshSheetReadiness`). The values are saved first, and fast.
    const families = new Set<string>()
    const transaction = <T>(work: () => Promise<T>) => deferReadiness(families, () => inDatabaseTransaction(prisma, work))
    const renew = (count: number) => prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'SAVING' }, data: { processed: { increment: count }, expiresAt: new Date(Date.now() + LEASE_MS) } })
    await withCachedSchemas(async () => {
      for (let offset = 0; offset < pending.length; offset += SAVE_CHUNK) {
        const chunk = pending.slice(offset, offset + SAVE_CHUNK)
        // A refused record rolls its chunk back. It is marked FAILED with its own sentence and the chunk is saved again
        // without it, so one refusal never blocks the others and never costs one transaction per record.
        let remaining = chunk, unknown = false
        while (remaining.length) {
          const attempt: { refused?: { item: typeof chunk[number]; error: unknown } } = {}
          try {
            await retryWriteConflicts(() => transaction(async () => {
              attempt.refused = undefined
              const ids = new Set<string>()
              for (const item of remaining) {
                try { await save(item, ids) } catch (error) { attempt.refused = { item, error }; throw error }
              }
              await refresh(ids)
            }))
            break
          } catch (error) {
            if (transient(error) && !writeConflict(error)) throw error
            if (!attempt.refused) { unknown = true; break }
            const { item, error: why } = attempt.refused
            await prisma.importJobRow.update({ where: { id: item.id }, data: { status: 'FAILED', errorMessage: why instanceof Error ? why.message : String(why), completedAt: new Date() } })
            remaining = remaining.filter(r => r !== item)
          }
        }
        if (unknown) {
          // The refusal came from the commit itself (not from one record): one record per transaction finds its owner.
          for (const item of remaining) {
            try {
              await retryWriteConflicts(() => transaction(async () => {
                const ids = new Set<string>()
                await save(item, ids)
                await refresh(ids)
              }))
            } catch (single) {
              if (transient(single) && !writeConflict(single)) throw single
              await prisma.importJobRow.update({ where: { id: item.id }, data: { status: 'FAILED', errorMessage: single instanceof Error ? single.message : String(single), completedAt: new Date() } })
            }
          }
        }
        if (!(await renew(chunk.length)).count) return
      }
    })
    const counts = await prisma.importJobRow.groupBy({ by: ['status'], where: { jobId }, _count: { _all: true } })
    const count = (status: string) => counts.find(c => c.status === status)?._count._all ?? 0
    const receipt = { saved: count('SUCCESS'), failed: count('FAILED'), skipped: count('INVALID') }
    const state: SheetImportState = receipt.failed && !receipt.saved ? 'FAILED' : receipt.failed ? 'PARTIAL' : 'DONE'
    const next: Payload = { ...payload, receipt, ...(families.size ? { readiness: { state: 'pending' as const, roots: [...families] } } : {}) }
    await prisma.$transaction(async tx => {
      const claim = await tx.bulkOperation.updateMany({ where: { id: jobId, status: 'SAVING' }, data: { status: state, changes: json(next), completedAt: new Date(), expiresAt: null } })
      if (claim.count) await tx.importJob.update({ where: { id: jobId }, data: { status: state, successRows: receipt.saved, failedRows: receipt.failed, skippedRows: receipt.skipped, completedAt: new Date() } })
    })
    console.info(`[sheet-import] ${jobId} saved ${receipt.saved}, failed ${receipt.failed}, skipped ${receipt.skipped} in ${Math.round(performance.now() - started)} ms`)
    if (next.readiness) void refreshSheetReadiness(jobId).catch(error => console.warn(`[sheet-import] ${jobId} readiness deferred to recovery`, error))
  } finally { saving.delete(jobId) }
}

const refreshing = new Set<string>()
/**
 * Rebuild the readiness of every family a save touched, once each, after the save committed. The job is already DONE
 * (the page shows it); `readiness` says `pending` until this ends, and the page reloads the sheet again then. A family
 * that cannot be rebuilt is `failed` (named in the job) and is rebuilt by its next edit; an interrupted rebuild is
 * finished by `recoverSheetImports`.
 */
export async function refreshSheetReadiness(jobId: string) {
  if (refreshing.has(jobId)) return
  refreshing.add(jobId)
  try {
    const job = await prisma.bulkOperation.findUnique({ where: { id: jobId }, select: { changes: true } })
    const readiness = payloadOf(job?.changes)?.readiness
    if (!readiness || readiness.state !== 'pending') return
    const started = performance.now()
    const failures: string[] = []
    for (const root of readiness.roots) {
      try { await reconcileFamilyReadiness(root) } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    }
    // Only the readiness keys change: the rest of the job (an undo being linked meanwhile) is never overwritten.
    await prisma.$executeRawUnsafe(`UPDATE "BulkOperation" SET "changes" = jsonb_set(jsonb_set("changes", '{readiness,state}', to_jsonb($2::text)), '{readiness,error}', to_jsonb($3::text)) WHERE "id" = $1`,
      jobId, failures.length ? 'failed' : 'done', failures[0] ?? '')
    console.info(`[sheet-import] ${jobId} readiness of ${readiness.roots.length} famil${readiness.roots.length === 1 ? 'y' : 'ies'} ${failures.length ? 'FAILED' : 'rebuilt'} in ${Math.round(performance.now() - started)} ms`)
  } finally { refreshing.delete(jobId) }
}

function transient(error: unknown) {
  const code = (error as { code?: string })?.code ?? ''
  return code.startsWith('P1') || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code) || writeConflict(error)
}

/**
 * Lease recovery, run by the catalog-transfer route's 30 s timer in every business: a save interrupted by a restart
 * resumes (saved records are marked in the same transaction as their write, so nothing is saved twice); a check
 * interrupted by a restart fails with a sentence — the file is simply dropped again.
 */
export async function recoverSheetImports() {
  // A readiness rebuild that did not finish (a restart right after a save) is run again.
  const lagging = await prisma.bulkOperation.findMany({ where: { status: { in: ['DONE', 'PARTIAL', 'FAILED'] }, completedAt: { lt: new Date(Date.now() - 60_000) },
    AND: [{ changes: { path: ['kind'], equals: SHEET_IMPORT_KIND } }, { changes: { path: ['readiness', 'state'], equals: 'pending' } }] }, select: { id: true }, take: 10 })
  for (const job of lagging) await refreshSheetReadiness(job.id).catch(() => { /* next tick */ })
  const stale = await prisma.bulkOperation.findMany({ where: { status: { in: ['CHECKING', 'SAVING'] }, expiresAt: { lt: new Date() }, changes: { path: ['kind'], equals: SHEET_IMPORT_KIND } }, select: { id: true, status: true }, take: 20 })
  for (const job of stale) {
    if (job.status === 'CHECKING') await failJob(job.id, new Error('The check was interrupted. Drop the file again.'))
    else if (!saving.has(job.id)) {
      const renewed = await prisma.bulkOperation.updateMany({ where: { id: job.id, status: 'SAVING', expiresAt: { lt: new Date() } }, data: { expiresAt: new Date(Date.now() + LEASE_MS) } })
      if (renewed.count) void saveSheetImport(job.id).catch(error => { if (!transient(error)) return failJob(job.id, error) })
    }
  }
}

// ── undo ──────────────────────────────────────────────────────────────────────────────────────

/** Fields an undo never puts back: they record a channel fact, or they are not value cells. */
const NOT_UNDONE = new Set(['presence', 'price', 'sale', 'sellerSku', 'parentSku', 'family', 'categoryIds', 'primaryCategoryId'])

/**
 * Put back what an import saved: a new import of the saved cells' BEFORE values, each expecting the value the import
 * wrote. A cell changed again since the import is a problem, never overwritten. It saves on its own when clean.
 */
export async function undoSheetImport(jobId: string, userId: string | null): Promise<SheetImportStatus | null> {
  const loaded = await readSheetImport(jobId, userId)
  if (!loaded) return null
  const { job, payload } = loaded
  if (payload.undoneBy) {
    const undo = await readSheetImport(payload.undoneBy, userId)
    if (undo) return statusOf(undo.job, undo.payload)
  }
  if (!['DONE', 'PARTIAL'].includes(job.status)) throw new TransferConflict('Only a saved import can be undone.')
  const saved = await prisma.importJobRow.findMany({ where: { jobId, status: 'SUCCESS' }, orderBy: { rowIndex: 'asc' }, select: { parsedValues: true } })
  const rows: TransferRow[] = []
  for (const item of saved) {
    const target = (item.parsedValues as unknown as RecordPayload).target
    if (!target || target.create) continue
    for (const cell of target.cells) {
      if (cell.verdict !== 'changed' || NOT_UNDONE.has(cell.field)) continue
      const { before, after, beforeState, afterState, verdict: _verdict, channelRead: _read, effectiveBefore: _eb, effectiveAfter: _ea, label: _label, expected: _expected, version: _version, ...identity } = cell
      rows.push({ ...identity, row: 0, source: undefined,
        action: beforeState === 'inherited' ? 'INHERIT' : isEmptyChannelValue(before) ? 'CLEAR' : 'SET', value: beforeState === 'inherited' || isEmptyChannelValue(before) ? null : before,
        expected: { action: afterState === 'inherited' ? 'INHERIT' : 'SET', value: after } })
    }
  }
  if (!rows.length) throw new TransferConflict('This import saved nothing that can be undone.')
  const status = await createSheetImport({ rows, issues: [], boundary: payload.boundary, market: payload.market, format: 'undo', filename: `Undo · ${job.uploadFilename ?? 'import'}`, userId,
    warnings: [], links: [], deletes: [], labels: payload.labels, undoOf: jobId, autoApply: true })
  // Only `undoneBy` changes: a readiness rebuild may be writing its own keys at the same time.
  await prisma.$executeRawUnsafe(`UPDATE "BulkOperation" SET "changes" = jsonb_set("changes", '{undoneBy}', to_jsonb($2::text)) WHERE "id" = $1`, jobId, status.jobId)
  return status
}

// ── reading a job back ────────────────────────────────────────────────────────────────────────

export async function sheetImportStatus(jobId: string, userId: string | null): Promise<SheetImportStatus | null> {
  const loaded = await readSheetImport(jobId, userId)
  return loaded ? statusOf(loaded.job, loaded.payload) : null
}

function statusOf(job: { id: string; status: string; processed: number | null; total: number | null; uploadFilename: string | null; completedAt: Date | null; errors: unknown }, payload: Payload): SheetImportStatus {
  const state = (['CHECKING', 'READY', 'SAVING', 'DONE', 'PARTIAL', 'FAILED'].includes(job.status) ? job.status : 'FAILED') as SheetImportState
  return { jobId: job.id, state, format: payload.format, filename: job.uploadFilename ?? '', summary: payload.summary, warnings: payload.warnings,
    processed: job.processed ?? 0, total: job.total ?? 0, startedAt: payload.startedAt, completedAt: job.completedAt?.toISOString() ?? null,
    ...(state === 'READY' && payload.reviewToken ? { reviewToken: payload.reviewToken } : {}), ...(payload.receipt ? { receipt: payload.receipt } : {}),
    links: payload.links, deletes: payload.deletes, destinations: payload.destinations, listingIds: payload.listingIds,
    ...(payload.undoOf ? { undoOf: payload.undoOf } : {}), ...(payload.undoneBy ? { undoneBy: payload.undoneBy } : {}),
    canUndo: ['DONE', 'PARTIAL'].includes(state) && !payload.undoneBy && (payload.receipt?.saved ?? 0) > 0 && payload.format !== 'undo',
    ...(payload.readiness ? { readiness: payload.readiness.state } : {}),
    ...(Array.isArray(job.errors) && (job.errors[0] as { message?: string })?.message ? { error: (job.errors[0] as { message: string }).message } : {}) }
}

/** The review page: every changed cell and every problem, flat, in record order. `filter: 'problems'` keeps problems only. */
export async function sheetImportChanges(jobId: string, userId: string | null, query: { page?: number; filter?: string; search?: string } = {}): Promise<SheetImportChangesPage | null> {
  const loaded = await readSheetImport(jobId, userId)
  if (!loaded) return null
  const { payload } = loaded
  const records = await prisma.importJobRow.findMany({ where: { jobId }, orderBy: { rowIndex: 'asc' }, select: { id: true, status: true, errorMessage: true, parsedValues: true } })
  const out: SheetImportChange[] = []
  for (const record of records) {
    const value = record.parsedValues as unknown as RecordPayload
    const base: SheetImportChangeStatus = record.status === 'SUCCESS' ? 'saved' : record.status === 'FAILED' ? 'failed' : record.status === 'INVALID' ? 'skipped' : 'ready'
    const issueKeys = new Set(value.issues.map(i => JSON.stringify([i.sku, (i as Partial<TransferRow>).locale ?? '', i.field])))
    // A problem shows the cell it is about: its current value and the value the file asked for, when the check read them.
    const cellsOf = value.target?.cells ?? value.cells ?? []
    for (const issue of value.issues) {
      const cell = cellsOf.find(c => c.sku === issue.sku && c.field === issue.field && c.locale === ((issue as Partial<TransferRow>).locale ?? ''))
      out.push(changeOf(`${record.id}:i:${out.length}`, { ...(cell ?? {}), ...issue } as Partial<TransferCell> & TransferIssue, payload, 'problem', issue.message))
    }
    for (const cell of value.target?.cells ?? value.cells ?? []) {
      if (cell.verdict !== 'changed' || issueKeys.has(JSON.stringify([cell.sku, cell.locale, cell.field]))) continue
      out.push(changeOf(`${record.id}:${cell.locale}:${cell.field}`, cell, payload, base, record.status === 'FAILED' ? record.errorMessage ?? 'Not saved' : base === 'skipped' ? 'Not saved: another cell in this row has a problem.' : undefined))
    }
  }
  const search = query.search?.trim().toLowerCase()
  const filtered = out.filter(c => (query.filter !== 'problems' || c.status === 'problem' || c.status === 'failed')
    && (!search || [c.sku, c.label, c.destination, c.field].some(v => v.toLowerCase().includes(search))))
  const page = Math.max(1, Math.floor(query.page ?? 1))
  return { changes: filtered.slice((page - 1) * CHANGES_PAGE, page * CHANGES_PAGE), total: filtered.length, page, pageSize: CHANGES_PAGE }
}

function changeOf(id: string, cell: Partial<TransferCell> & Pick<TransferIssue, 'sku' | 'field'>, payload: Payload, status: SheetImportChangeStatus, problem?: string): SheetImportChange {
  const entity = cell.entity ?? 'Products'
  const identity = { entity, channel: cell.channel ?? '', accountId: cell.accountId ?? '', marketplace: cell.marketplace ?? '', aliasKey: cell.aliasKey ?? '', sku: cell.sku, locale: cell.locale ?? '' }
  const listing = entity !== 'Products' && payload.boundary ? payload.boundary.listings.find(l => l.channel === identity.channel && l.marketplace === identity.marketplace && l.accountId === identity.accountId && l.aliasKey === identity.aliasKey)?.aliasLabel : undefined
  return { id, ...identity, destination: cell.field ? destinationOf(identity as TransferRow, payload.boundary) : 'File', ...(listing ? { listing } : {}),
    field: cell.field, label: cell.field ? payload.labels[labelKey(identity as TransferRow, cell.field)] ?? humanize(cell.field) : 'Row',
    before: cell.before ?? null, after: cell.after ?? null, beforeState: cell.beforeState ?? 'stored', afterState: cell.afterState ?? 'stored', status,
    ...(problem ? { problem } : {}), ...(cell.row ? { row: cell.row } : {}), ...(cell.source?.sheet ? { sheet: cell.source.sheet } : {}), ...(cell.source?.column ? { column: cell.source.column } : {}) }
}

function destinationOf(row: Pick<TransferRow, 'entity' | 'channel' | 'marketplace' | 'accountId' | 'aliasKey' | 'locale'>, boundary?: ProductTransferBoundary) {
  if (row.entity === 'Products') return row.locale ? `Shared · ${row.locale.toUpperCase()}` : 'Shared'
  const base = `${CHANNEL_NAMES[row.channel] ?? row.channel} · ${row.marketplace}`
  const aliases = boundary?.listings.filter(l => l.channel === row.channel && l.marketplace === row.marketplace && l.accountId === row.accountId) ?? []
  const alias = row.aliasKey ? aliases.find(l => l.aliasKey === row.aliasKey)?.aliasLabel : undefined
  return alias && aliases.some(l => l.aliasKey !== row.aliasKey) ? `${base} · ${alias}` : base
}

/** Equal as values: null, undefined, '' and [] are one "empty"; otherwise structural equality. */
export function sameValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === '' || Array.isArray(v) && v.length === 0
  if (empty(a) || empty(b)) return empty(a) && empty(b)
  return transferCanonical(a) === transferCanonical(b)
}
const display = (value: unknown) => value === null || value === undefined || value === '' ? 'empty' : typeof value === 'string' ? `"${value.length > 60 ? `${value.slice(0, 57)}…` : value}"` : JSON.stringify(value)
