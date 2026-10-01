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
import { SHEET_IMPORT_SOURCE, type EbayFamilyPlan, type EbayListingPlan } from '../catalog-ebay-workbook.js'
import { archiveAlias, createAlias, nameListingAlias } from '../listing-alias.service.js'
import { draftListingFields, ensureDraftListings } from '../draft-listing.service.js'
import { variationBag } from '../shared-variation-values.js'
import { setFamilyAxes, setFamilyVariationValues } from '../family-variations.service.js'
import { promoteProduct } from '../product-relationship.service.js'
import { productEventService } from '../../product-event.service.js'
import { productTransferOptions, resolveProductTransferBoundary, assertProductTransferRows } from '../catalog-product-transfer.js'
import { buildTransferPlan, fingerprint, isEmptyChannelValue, transferContracts, type TransferTarget } from '../catalog-transfer-plan.js'
import { loadTransferContext, TransferConflict } from '../catalog-transfer.service.js'
import { applyTransferRecord, retryWriteConflicts, writeConflict } from '../catalog-transfer-jobs.js'
import { clearSheetColumnCache } from '../sheet-columns.service.js'
import { clearFieldCatalogueCache } from '../mapping/field-catalogue.service.js'
import { createReferenceResolver } from '../reference-values.service.js'
import { withCachedSchemas } from '../cached-schema-context.js'
import { productReadCacheService } from '../../product-read-cache.service.js'
import { deferReadiness, markReadinessPending, rebuildImportedFamily } from '../readiness-index.service.js'

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
  /** eBay files (2026-10-01): the extra listings Apply names or creates first; `listingsDone` is what it did (a resumed save and Undo read it). */
  listingPlan?: EbayListingPlan
  listingsDone?: ListingsDone
  /** An undo of an import that made listings: clear those SKUs and archive those listings. */
  listingUndo?: ListingsDone
  /** The product the Import was opened on. A family the import creates is another product: the done screen offers to open it. */
  openProductId?: string
  /** Phase 2: the families and main listings Apply made, in one transaction with this record (a resumed save skips that step). */
  familiesDone?: FamiliesDone
  /** Phase 2: the scopes of the other families this import created; each record is saved against its own family's scope. */
  familyBoundaries?: ProductTransferBoundary[]
}
/**
 * A family Apply created, made the open product the parent of (`adopted`), or completed (`existing`): `products` are the ones
 * it created or brought back; `axesSet` and `filled` what it gave an existing family (Undo puts them back to none).
 */
interface FamilyDone {
  rootId: string; rootSku: string; adopted: boolean; existing?: boolean; axes: string[]; products: { id: string; sku: string }[]
  /** The attribute codes of `axes`, in the same order. */
  axisCodes?: string[]
  axesSet?: string[]
  /** The values as stored (the dictionary's spelling): Undo clears only the ones still so. */
  filled?: { productId: string; sku: string; values: Record<string, string> }[]
}
/** The main listing drafts Apply made (`listings`: only rows this import inserted). */
interface MainDone { rootId: string; rootSku: string; accountId: string; marketplace: string; listings: { id: string; productId: string }[] }
interface FamiliesDone { families: FamilyDone[]; mains: MainDone[] }
interface ListingsDone {
  named: { aliasId: string; sku: string; rootSku: string; label: string; marketplace: string }[]
  created: { aliasId: string; sku: string; rootId: string; rootSku: string; accountId: string; marketplace: string }[]
  families?: FamilyDone[]
  mains?: MainDone[]
}
/** What Apply does for a family, counted as changes: the product (or the axes an existing family gets), each variation, each value it fills. */
const familySize = (family: EbayFamilyPlan) => (family.existingId ? family.setsAxes ? 1 : 0 : 1) + family.children.length
  + (family.fills ?? []).reduce((n, f) => n + Object.keys(f.values).length, 0)
const planSize = (plan?: EbayListingPlan) => plan ? plan.names.length + plan.creates.length + (plan.families ?? []).reduce((n, f) => n + familySize(f), 0) + (plan.mains?.length ?? 0) : 0
const undoSize = (undo?: ListingsDone) => undo ? undo.named.length + undo.created.length + (undo.mains?.length ?? 0)
  + (undo.families ?? []).reduce((n, f) => n + f.products.length + (f.axesSet ? 1 : 0) + (f.filled ?? []).reduce((m, v) => m + Object.keys(v.values).length, 0), 0) : 0
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
  const parsed = await readEditorTransfer(input.buffer, input.filename, input.productId, input.userId, input.log, input.decisions ?? {}, { changesOnly: true, listingPlan: true })
  input.log?.('sheet-import.read', { ms: Math.round(performance.now() - started), rows: parsed.rows.length, issues: parsed.issues.length })
  const kinds = parsed.kinds ?? []
  const format: SheetImportFormat = kinds.includes('amazon') ? 'amazon' : kinds.includes('ebay') ? 'ebay' : kinds.includes('shopify') ? 'shopify'
    : kinds.length && kinds.every(k => k === 'editing') ? 'nexus' : kinds.includes('wide') || kinds.includes('editing') ? 'nexus-legacy' : 'csv'
  // The file decides the scope: the products and listings it names, inside this product's family.
  const scoped = parsed.boundary ? { boundary: parsed.boundary, rows: parsed.rows, outside: [] as TransferIssue[] } : await scopeFromRows(input.productId, parsed.rows)
  const labels = parsed.exportId ? await exportLabels(parsed.exportId, input.userId) : {}
  return createSheetImport({
    rows: scoped.rows, issues: [...parsed.issues, ...outsideRows(parsed.exclusions ?? []), ...scoped.outside], boundary: scoped.boundary, market: input.market, format, filename: input.filename, userId: input.userId,
    warnings: parsed.editing === false && format !== 'csv' ? [] : parsed.warnings ?? [], links: parsed.links ?? [], exportId: parsed.exportId, labels,
    deletes: deletesOf(parsed.rows, parsed.issues), listingPlan: parsed.listingPlan, openProductId: input.productId, log: input.log,
    nothing: (parsed.exclusions ?? []).find(e => !OUTSIDE_PRODUCT.test(e.message))?.message,
  })
}

/** The readers' sentence for a row of another product (`Outside this product; use Catalog import`, maybe after a sheet name). */
const OUTSIDE_PRODUCT = /Outside this product/
/**
 * Never drop a row (2026-10-01): a row a reader skipped because it belongs to another product is a problem the review names,
 * once per row. Before this, a file of another family read as "This file changes nothing".
 */
function outsideRows(exclusions: readonly TransferIssue[]): TransferIssue[] {
  const seen = new Set<string>()
  return exclusions.filter(e => OUTSIDE_PRODUCT.test(e.message)).flatMap(e => {
    const key = JSON.stringify([e.source?.file ?? '', e.source?.sheet ?? '', e.row])
    if (seen.has(key)) return []
    seen.add(key)
    return [{ ...e, message: `${e.sku || 'This row'} is not in this product family. Import it from its own product.` }]
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
  listingPlan?: EbayListingPlan; listingUndo?: ListingsDone; openProductId?: string
  /** Why the file holds nothing to import, when a reader said (a reference-only column). */
  nothing?: string
  log?: ImportLog
}

async function createSheetImport(input: CreateInput): Promise<SheetImportStatus> {
  if (!input.rows.length && !input.issues.length && !planSize(input.listingPlan) && !undoSize(input.listingUndo)) {
    // "Every cell is as it was exported" is only true of a file Nexus exported; any other file is told what it holds.
    throw new Error(input.exportId ? 'This file changes nothing: every cell is as it was exported. Change a value, then import it again.'
      : `This file holds nothing Nexus can import into this product.${input.nothing ? ` ${input.nothing}` : ''}`)
  }
  const boundary = input.boundary
  const payload: Payload = { kind: SHEET_IMPORT_KIND, productId: boundary?.productId ?? input.listingPlan?.creates[0]?.rootId ?? input.listingPlan?.names[0]?.rootId ?? input.openProductId ?? '', market: input.market, format: input.format, boundary: boundary as ProductTransferBoundary,
    exportId: input.exportId, summary: emptySummary(), warnings: input.warnings, links: input.links, deletes: input.deletes, destinations: [], listingIds: [], startedAt: new Date().toISOString(),
    labels: input.labels, ...(input.undoOf ? { undoOf: input.undoOf } : {}), ...(input.autoApply ? { autoApply: true } : {}),
    ...(planSize(input.listingPlan) ? { listingPlan: input.listingPlan } : {}), ...(undoSize(input.listingUndo) ? { listingUndo: input.listingUndo } : {}),
    ...(input.openProductId ? { openProductId: input.openProductId } : {}) }
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
  const plan = input.listingPlan, undo = input.listingUndo
  // The products and listings Apply makes or names are changes too; a new listing's values become records when it exists.
  const creates = [...plan?.creates ?? [], ...plan?.mains ?? []]
  // The new variations of an existing family on its listings: one record per variation and listing, once their rows exist.
  const pending = [...creates.map(c => c.rows), ...(plan?.families ?? []).map(f => f.rows ?? [])]
  const pendingRecords = pending.reduce((n, rows) => n + new Set(rows.map(r => JSON.stringify([r.sku, r.accountId, r.aliasKey]))).size, 0)
  summary.changes += planSize(plan) + undoSize(undo) + pending.reduce((n, rows) => n + rows.length, 0)
  summary.products += (plan?.families ?? []).reduce((n, f) => n + (f.existingId ? (f.setsAxes ? 1 : 0) + (f.fills?.length ?? 0) : 1) + f.children.length, 0)
    + (undo?.families ?? []).reduce((n, f) => n + f.products.length + (f.filled?.length ?? 0), 0)
  summary.listings += pendingRecords + (undo?.created.length ?? 0)
  summary.created += creates.length
  const ready = records.filter(r => r.status === 'REVIEWED').length + planSize(plan) + pendingRecords + undoSize(undo)
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
    const job = await prisma.bulkOperation.findUnique({ where: { id: jobId } }), loadedPayload = payloadOf(job?.changes)
    if (!job || !loadedPayload || job.status !== 'SAVING') return
    const started = performance.now()
    const payload = await applyListingPlan(jobId, loadedPayload, job.userId)
    const all = await prisma.importJobRow.findMany({ where: { jobId }, orderBy: { rowIndex: 'asc' }, select: { id: true, targetId: true, parsedValues: true, status: true } })
    const pending = all.filter(r => r.status === 'REVIEWED')
    // R-AE-17 — every shared product this job declares, whatever its outcome.
    const declaredProductSkus = new Set(all.flatMap(r => { try { const key = JSON.parse(r.targetId ?? ''); return Array.isArray(key) && key[0] === 'Products' ? [String(key[1])] : [] } catch { return [] } }))
    clearSheetColumnCache(); clearFieldCatalogueCache()
    const contracts = transferContracts(payload.market)
    contracts.reference = createReferenceResolver()
    const referenceRows = pending.flatMap(r => (r.parsedValues as unknown as RecordPayload).rows)
    const reference = referenceRows.length ? await loadTransferContext(referenceRows) : undefined
    // Each record is checked against its own family's scope: a file can create a family besides the open product's.
    const scopes = [payload.boundary, ...payload.familyBoundaries ?? []].filter(Boolean)
    const scopeOf = (item: typeof pending[number]) => { const sku = (item.parsedValues as unknown as RecordPayload).rows[0]?.sku; return scopes.find(b => b.products.some(p => p.sku === sku)) ?? payload.boundary }
    const save = (item: typeof pending[number], readCacheIds: Set<string>) => applyTransferRecord({ jobId, item, boundary: scopeOf(item), mode: 'update', sharedCopy: false,
      contracts, reference, declaredProductSkus, userId: job.userId, options: { queueOutbound: false, readCacheIds } })
    const refresh = async (ids: Set<string>) => { if (ids.size) await productReadCacheService.refreshInTransaction(prisma as unknown as Prisma.TransactionClient, [...ids]) }
    // 🔴 Readiness is NOT rebuilt inside the save transactions (the Owner's choice, 2026-09-26): each family is noted,
    // marked pending in the SAME transaction as its values (no reader shows the old answer as current), and rebuilt once
    // right after the last save commits (`refreshSheetReadiness`). The readiness-pending drain finishes an interrupted one.
    const families = new Set<string>()
    const transaction = <T>(work: () => Promise<T>) => deferReadiness(families, () => inDatabaseTransaction(prisma, async () => {
      const result = await work()
      if (families.size) await markReadinessPending([...families])
      return result
    }))
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
    const receipt = { saved: count('SUCCESS') + undoSize(payload.listingsDone) + undoSize(payload.listingUndo), failed: count('FAILED'), skipped: count('INVALID') }
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
 * (the page shows it); `readiness` says `pending` until this ends, and the page reloads the sheet again then. The rows
 * stay marked pending until rebuilt, so a family that fails here is rebuilt by the readiness-pending drain; the job
 * says `failed` so the page can say so. An interrupted rebuild is finished by `recoverSheetImports` and by the drain.
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
      // 0 = nothing pending any more (the drain or another worker got there first) — also done. A family with no readiness
      // row at all is built (audit P6: it had nothing to mark pending, so it stayed "Not computed").
      try { await rebuildImportedFamily(root) } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    }
    // Only the readiness keys change: the rest of the job (an undo being linked meanwhile) is never overwritten.
    await prisma.$executeRawUnsafe(`UPDATE "BulkOperation" SET "changes" = jsonb_set(jsonb_set("changes", '{readiness,state}', to_jsonb($2::text)), '{readiness,error}', to_jsonb($3::text)) WHERE "id" = $1`,
      jobId, failures.length ? 'failed' : 'done', failures[0] ?? '')
    console.info(`[sheet-import] ${jobId} readiness of ${readiness.roots.length} famil${readiness.roots.length === 1 ? 'y' : 'ies'} ${failures.length ? 'FAILED' : 'rebuilt'} in ${Math.round(performance.now() - started)} ms`)
  } finally { refreshing.delete(jobId) }
}

// ── new families and extra listings (eBay files, 2026-10-01) ──────────────────────────────────

/**
 * Apply's first step for an eBay file (the Owner: "simply import", one step), in the order the save needs: the new families
 * and their main listings (`applyFamilies`), then each extra listing without a SKU gets the file's SKU, each missing one is
 * created as inert drafts, and the file's rows for every new listing become records of this job; the save then writes every
 * record. An undo puts back what an import made instead. It runs once: `listingsDone` is stored with the new records in one
 * transaction, so a resumed save goes straight to the records.
 */
async function applyListingPlan(jobId: string, payload: Payload, userId: string | null): Promise<Payload> {
  const undo = payload.listingUndo
  if (payload.listingsDone || (!planSize(payload.listingPlan) && !undoSize(undo))) return payload
  const done: ListingsDone = { named: [], created: [] }
  if (undo) {
    for (const n of undo.named) await prisma.productListingAlias.updateMany({ where: { id: n.aliasId, sku: n.sku }, data: { sku: null } })
    for (const c of undo.created) await archiveAlias(c.aliasId, { productId: c.rootId, accountId: c.accountId })
    await undoFamilies(undo, jobId, userId)
    const next: Payload = { ...payload, listingsDone: done }
    await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'SAVING' }, data: { changes: json(next), processed: { increment: undoSize(undo) } } })
    return next
  }
  if ((payload.listingPlan!.families?.length || payload.listingPlan!.mains?.length) && !payload.familiesDone) payload = await applyFamilies(jobId, payload, userId)
  const plan = payload.listingPlan!, made = payload.familiesDone ?? { families: [], mains: [] }
  Object.assign(done, made)
  /** A listing of a family Apply just created is planned by its root SKU: the root had no id when the file was checked. */
  const rootIdOf = (rootId: string, rootSku: string) => rootId || made.families.find(f => f.rootSku === rootSku)?.rootId || ''
  for (const n of plan.names) {
    const alias = await prisma.productListingAlias.findFirst({ where: { id: n.aliasId }, select: { sku: true } })
    if (alias?.sku !== n.sku) await nameListingAlias(n.aliasId, n.sku)
    done.named.push({ aliasId: n.aliasId, sku: n.sku, rootSku: n.rootSku, label: n.label, marketplace: n.marketplace })
  }
  const rows: TransferRow[] = []
  /** Every listing that joins the job's scope, per family root. */
  const joined = new Map<string, string[]>()
  const join = (rootId: string, ids: string[]) => joined.set(rootId, [...joined.get(rootId) ?? [], ...ids])
  /** The file's rows for new drafts: each row gets its listing's account and current version. */
  const takeRows = async (source: TransferRow[], where: Prisma.ChannelListingWhereInput, at: { aliasKey: string; accountId: string }, rootId: string) => {
    const listings = await prisma.channelListing.findMany({ where, select: { id: true, productId: true, version: true } })
    const products = await prisma.product.findMany({ where: { id: { in: listings.map(l => l.productId) } }, select: { id: true, sku: true } })
    const versionOf = new Map(products.map(p => [p.sku, listings.find(l => l.productId === p.id)!.version]))
    for (const row of source) if (versionOf.has(row.sku)) rows.push({ ...row, ...at, version: versionOf.get(row.sku)! })
    join(rootId, listings.map(l => l.id))
  }
  for (const m of made.mains) {
    const main = plan.mains?.find(x => x.rootSku === m.rootSku && x.marketplace === m.marketplace)
    const family = await prisma.product.findMany({ where: { OR: [{ id: m.rootId }, { parentId: m.rootId }], deletedAt: null }, select: { id: true } })
    await takeRows(main?.rows ?? [], { productId: { in: family.map(p => p.id) }, channel: 'EBAY', marketplace: m.marketplace, channelConnectionId: m.accountId, aliasKey: '' }, { aliasKey: '', accountId: m.accountId }, m.rootId)
  }
  // Phase 2b — the new variations of an existing family, on each of its listings the file names.
  for (const f of plan.families ?? []) {
    const doneFamily = made.families.find(d => d.existing && d.rootSku === f.rootSku)
    if (!doneFamily || !f.rows?.length || !doneFamily.products.length) continue
    for (const l of f.listings ?? []) await takeRows(f.rows.filter(r => r.aliasKey === l.aliasKey && r.accountId === l.accountId),
      { productId: { in: doneFamily.products.map(p => p.id) }, channel: 'EBAY', marketplace: l.marketplace, channelConnectionId: l.accountId, aliasKey: l.aliasKey }, { aliasKey: l.aliasKey, accountId: l.accountId }, doneFamily.rootId)
  }
  for (const c of plan.creates) {
    const rootId = rootIdOf(c.rootId, c.rootSku)
    if (!rootId) throw new TransferConflict(`The product ${c.rootSku} was not created. Drop the file again.`)
    // A save resumed after the listing was made finds it by its SKU; it never makes a second one.
    const existing = await prisma.productListingAlias.findFirst({ where: { sku: c.sku, productId: rootId, status: 'ACTIVE' }, select: { id: true } })
    const alias = existing ?? await createAlias({ productId: rootId, channel: 'EBAY', marketplace: c.marketplace, accountId: c.accountId, label: c.sku, sku: c.sku })
    done.created.push({ aliasId: alias.id, sku: c.sku, rootId, rootSku: c.rootSku, accountId: c.accountId, marketplace: c.marketplace })
    await takeRows(c.rows, { aliasKey: alias.id }, { aliasKey: alias.id, accountId: c.accountId }, rootId)
  }
  // The new listings join the job's scope, so the save may write them. A family other than the job's own gets its own scope.
  let boundary = payload.boundary
  const familyBoundaries = [...payload.familyBoundaries ?? []]
  for (const [rootId, listingIds] of joined) {
    const family = await prisma.product.findMany({ where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null }, select: { id: true } })
    const scope = (base?: ProductTransferBoundary) => resolveProductTransferBoundary(base?.productId || rootId, {
      productIds: [...new Set([...(base?.products.map(p => p.id) ?? []), ...family.map(p => p.id)])],
      includeShared: base?.includeShared ?? false, locales: base?.locales ?? [],
      listingIds: [...new Set([...(base?.listings.map(l => l.id) ?? []), ...listingIds])] })
    if (!boundary || boundary.rootId === rootId) boundary = await scope(boundary)
    else {
      const index = familyBoundaries.findIndex(b => b.rootId === rootId)
      if (index < 0) familyBoundaries.push(await scope())
      else familyBoundaries[index] = await scope(familyBoundaries[index])
    }
  }
  const records = rows.length ? await planListingRecords(rows, payload.market) : []
  const last = await prisma.importJobRow.aggregate({ where: { jobId }, _max: { rowIndex: true } })
  const next: Payload = { ...payload, boundary: boundary as ProductTransferBoundary, ...(familyBoundaries.length ? { familyBoundaries } : {}), listingsDone: done,
    listingIds: [...new Set([...payload.listingIds, ...[...joined.values()].flat()])] }
  await prisma.$transaction(async tx => {
    if (records.length) await tx.importJobRow.createMany({ data: records.map((record, i) => ({ jobId, rowIndex: (last._max.rowIndex ?? 0) + i + 1, targetId: record.key,
      parsedValues: json(record.payload), status: record.status })) })
    await tx.bulkOperation.updateMany({ where: { id: jobId, status: 'SAVING' }, data: { changes: json(next), processed: { increment: done.named.length + done.created.length } } })
  })
  return next
}

/**
 * Phase 2 (the Owner, 2026-10-01: "import any files to then create new products based on the SKUs") — in ONE transaction,
 * stored in the job with what it made (a resumed save skips it): each family's products as DRAFT (the open product becomes
 * the parent instead of a new one; a product an undone import put in the recycle bin comes back), its axes and values
 * through the one writer (`family-variations.service.ts`), then the main eBay listing's inert drafts (`ensureDraftListings`).
 */
async function applyFamilies(jobId: string, payload: Payload, userId: string | null): Promise<Payload> {
  const plan = payload.listingPlan!
  return inDatabaseTransaction(prisma, async () => {
    const tx = prisma as unknown as Prisma.TransactionClient
    const done: FamiliesDone = { families: [], mains: [] }
    for (const family of plan.families ?? []) done.families.push(await createFamily(tx, family, jobId, userId))
    for (const main of plan.mains ?? []) {
      const rootId = main.rootId || done.families.find(f => f.rootSku === main.rootSku)?.rootId
      if (!rootId) throw new TransferConflict(`The product ${main.rootSku} was not created. Drop the file again.`)
      const family = await tx.product.findMany({ where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null }, select: { id: true } })
      const ensured = await ensureDraftListings(tx, { channel: 'EBAY', market: main.marketplace, accountId: main.accountId, productIds: family.map(p => p.id), family: true })
      done.mains.push({ rootId, rootSku: main.rootSku, accountId: main.accountId, marketplace: main.marketplace, listings: ensured.filter(l => l.created).map(l => ({ id: l.id, productId: l.productId })) })
      // `ensureDraftListings` leaves the read cache to its caller.
      await productReadCacheService.refreshInTransaction(tx, family.map(p => p.id))
    }
    const next: Payload = { ...payload, familiesDone: done }
    const step = (plan.families ?? []).reduce((n, f) => n + familySize(f), 0) + (plan.mains?.length ?? 0)
    const saved = await tx.bulkOperation.updateMany({ where: { id: jobId, status: 'SAVING' }, data: { changes: json(next), processed: { increment: step } } })
    if (!saved.count) throw new TransferConflict('This import stopped before its products were created. Drop the file again.')
    return next
  }, { isolationLevel: 'Serializable', timeoutMs: 120_000 })
}

/** One family: its root (created, brought back or the open product), its variations, then their axes and values. */
async function createFamily(tx: Prisma.TransactionClient, family: EbayFamilyPlan, jobId: string, userId: string | null): Promise<FamilyDone> {
  const products: { id: string; sku: string }[] = []
  const make = async (sku: string, fields: { name: string; parentId: string | null; isParent: boolean; variationTheme?: string }) => {
    const binned = family.restore[sku]
    const data = { name: fields.name, status: 'DRAFT', parentId: fields.parentId, isParent: fields.isParent, ...(fields.variationTheme ? { variationTheme: fields.variationTheme } : {}) }
    let id: string
    if (binned) {
      // An earlier import of this file made it, and its undo put it in the recycle bin: it comes back as a draft.
      const back = await tx.product.updateMany({ where: { id: binned, sku, deletedAt: { not: null } }, data: { ...data, deletedAt: null, version: { increment: 1 } } })
      if (back.count !== 1) throw new TransferConflict(`${sku} changed since the check. Drop the file again.`)
      id = binned
    } else {
      id = (await tx.product.create({ data: { sku, basePrice: 0, importSource: SHEET_IMPORT_SOURCE, importedAt: new Date(), ...data } as Prisma.ProductUncheckedCreateInput, select: { id: true } })
        .catch(error => { throw (error as { code?: string })?.code === 'P2002' ? new TransferConflict(`${sku} was added to Nexus after the check. Drop the file again.`) : error })).id
    }
    await tx.auditLog.create({ data: { userId, entityType: 'Product', entityId: id, action: binned ? 'restore' : 'create', before: json(binned ? { deletedAt: 'recycle bin' } : null),
      after: json({ sku, ...data }), metadata: { source: 'sheet-import', jobId } } })
    await productEventService.emitTx(tx, { aggregateId: id, aggregateType: 'Product', eventType: 'PRODUCT_CREATED', data: { sku, ...data }, metadata: { source: 'OPERATOR', writer: 'sheet-import', importJobId: jobId } })
    products.push({ id, sku })
    return id
  }
  let rootId: string
  if (family.existingId) {
    // Phase 2b — an existing family: what it has stays; it gets the axes it lacked (none before) and its new variations.
    const root = await tx.product.findFirst({ where: { id: family.existingId, deletedAt: null }, select: { id: true, sku: true, parentId: true, variationAxisCodes: true, variationAxes: true } })
    if (!root || root.sku !== family.rootSku || root.parentId || family.setsAxes && (root.variationAxisCodes.length || root.variationAxes.length)) throw new TransferConflict(`${family.rootSku} changed since the check. Drop the file again.`)
    rootId = root.id
  } else if (family.adoptId) {
    const root = await tx.product.findFirst({ where: { id: family.adoptId, deletedAt: null }, select: { id: true, sku: true, parentId: true, _count: { select: { children: { where: { deletedAt: null } } } } } })
    if (!root || root.sku !== family.rootSku || root.parentId || root._count.children) throw new TransferConflict(`${family.rootSku} changed since the check. Drop the file again.`)
    if (family.children.length) await promoteProduct(tx, root.id, family.theme)
    rootId = root.id
  } else rootId = await make(family.rootSku, { name: family.name, parentId: null, isParent: family.children.length > 0, ...(family.children.length ? { variationTheme: family.theme } : {}) })
  for (const child of family.children) await make(child.sku, { name: child.name, parentId: rootId, isParent: false })
  const fills = family.fills ?? []
  if (family.axes.length && (family.children.length || fills.length || family.setsAxes)) {
    // THE writers of axes and values: dictionary codes, values matched to options, unknown values added as options. An
    // existing family's axes are written only when it had none.
    const root = await tx.product.findUniqueOrThrow({ where: { id: rootId }, select: { version: true } })
    let version = root.version
    if (!family.existingId || family.setsAxes) ({ version } = await setFamilyAxes(rootId, { expectedVersion: version, codes: family.axes.map(a => a.code), labels: family.axes.map(a => a.label) }))
    const idOf = new Map(products.map(p => [p.sku, p.id]))
    const changes = [...family.children.flatMap(c => family.axes.map(a => ({ productId: idOf.get(c.sku)!, axis: a.code, value: c.values[a.code] ?? null, addOption: true }))),
      ...fills.flatMap(f => Object.entries(f.values).map(([axis, value]) => ({ productId: f.productId, axis, value, addOption: true })))]
    for (let offset = 0; offset < changes.length; offset += 2000) ({ version } = await setFamilyVariationValues(rootId, { expectedVersion: version, changes: changes.slice(offset, offset + 2000) }))
  }
  // An existing family's listings the file names: each new variation gets its inert draft row there.
  const added = products.map(p => p.id)
  for (const l of family.existingId && added.length ? family.listings ?? [] : []) {
    if (!l.aliasKey) await ensureDraftListings(tx, { channel: 'EBAY', market: l.marketplace, accountId: l.accountId, productIds: [rootId, ...added], family: true })
    else await tx.channelListing.createMany({ data: added.map(productId => draftListingFields({ productId, channel: 'EBAY', market: l.marketplace, accountId: l.accountId, aliasKey: l.aliasKey })), skipDuplicates: true })
  }
  // What an existing family was given, as stored (the dictionary's spelling): Undo clears only values still so.
  const stored = fills.length ? await tx.product.findMany({ where: { id: { in: fills.map(f => f.productId) } }, select: { id: true, categoryAttributes: true, variantAttributes: true } }) : []
  const filled = fills.map(f => {
    const bag = variationBag(stored.find(p => p.id === f.productId) ?? { categoryAttributes: null, variantAttributes: null })
    return { productId: f.productId, sku: f.sku, values: Object.fromEntries(Object.keys(f.values).map(code => [code, String(bag[code] ?? '')])) }
  })
  await productReadCacheService.refreshInTransaction(tx, [rootId, ...products.map(p => p.id), ...fills.map(f => f.productId)])
  return { rootId, rootSku: family.rootSku, adopted: !!family.adoptId, axes: family.axes.map(a => a.label), axisCodes: family.axes.map(a => a.code), products,
    ...(family.existingId ? { existing: true, ...(family.setsAxes ? { axesSet: family.axes.map(a => a.code) } : {}), ...(filled.length ? { filled } : {}) } : {}) }
}

/**
 * Undo of what an import gave an EXISTING family (phase 2b), through the same writers: the values it filled go back to none
 * where they are still what it wrote, then the axes it set, where they are still its axes. A value changed since stays.
 */
async function undoFamilyValues(family: FamilyDone, binned: string[]) {
  await inDatabaseTransaction(prisma, async () => {
    const root = await prisma.product.findFirst({ where: { id: family.rootId, deletedAt: null }, select: { version: true, variationAxisCodes: true } })
    if (!root) return
    let version = root.version
    const ids = (family.filled ?? []).map(f => f.productId).filter(id => !binned.includes(id))
    const now = ids.length ? await prisma.product.findMany({ where: { id: { in: ids }, parentId: family.rootId, deletedAt: null }, select: { id: true, categoryAttributes: true, variantAttributes: true } }) : []
    const changes = (family.filled ?? []).flatMap(f => {
      const product = now.find(p => p.id === f.productId)
      if (!product) return []
      const bag = variationBag(product)
      return Object.entries(f.values).filter(([code, value]) => value && String(bag[code] ?? '') === value).map(([axis]) => ({ productId: f.productId, axis, value: null }))
    })
    if (changes.length) ({ version } = await setFamilyVariationValues(family.rootId, { expectedVersion: version, changes }))
    if (family.axesSet && JSON.stringify(root.variationAxisCodes) === JSON.stringify(family.axesSet)) await setFamilyAxes(family.rootId, { expectedVersion: version, codes: [], labels: [] })
  }, { isolationLevel: 'Serializable', timeoutMs: 120_000 })
}

/**
 * Undo of what `applyFamilies` made: the products it created or brought back go to the recycle bin (never the open product it
 * made a parent: that stays a parent), and the inert drafts it made on a product it did not create are removed.
 */
async function undoFamilies(undo: ListingsDone, jobId: string, userId: string | null) {
  const binned = (undo.families ?? []).flatMap(f => f.products.map(p => p.id))
  const drafts = (undo.mains ?? []).flatMap(m => m.listings.filter(l => !binned.includes(l.productId)))
  for (const family of undo.families ?? []) if (family.filled?.length || family.axesSet) await undoFamilyValues(family, binned)
  if (!binned.length && !drafts.length) return
  await prisma.$transaction(async tx => {
    const live = binned.length ? await tx.product.findMany({ where: { id: { in: binned }, deletedAt: null }, select: { id: true, sku: true } }) : []
    const at = new Date()
    if (live.length) {
      await tx.product.updateMany({ where: { id: { in: live.map(p => p.id) } }, data: { deletedAt: at } })
      await tx.auditLog.createMany({ data: live.map(p => ({ userId, entityType: 'Product', entityId: p.id, action: 'soft-delete', before: { deletedAt: null }, after: { deletedAt: at.toISOString() },
        metadata: { sku: p.sku, source: 'sheet-import-undo', jobId } })) })
    }
    // Only a draft nothing sent anywhere: one published since stays.
    if (drafts.length) await tx.channelListing.deleteMany({ where: { id: { in: drafts.map(l => l.id) }, externalListingId: null, isPublished: false, listingStatus: 'DRAFT' } })
    await productReadCacheService.refreshInTransaction(tx, [...new Set([...binned, ...drafts.map(l => l.productId)])])
  }, { timeout: 60_000 })
}

/** The records of a listing Apply just created: the file's rows for it, checked now against its new drafts. */
async function planListingRecords(rows: TransferRow[], market: string) {
  clearSheetColumnCache(); clearFieldCatalogueCache()
  const contracts = transferContracts(market)
  contracts.reference = createReferenceResolver()
  const { plan, context } = await withCachedSchemas(async () => {
    const context = await loadTransferContext(rows)
    return { plan: await buildTransferPlan(rows, 'update', context, contracts), context }
  })
  const groups = new Map<string, TransferRow[]>()
  for (const row of rows) groups.set(transferTargetKey(row), [...(groups.get(transferTargetKey(row)) ?? []), row])
  const targets = new Map(plan.targets.map(t => [t.key, t]))
  return [...groups].map(([key, group]) => {
    const target = targets.get(key)
    const issues: TransferIssue[] = plan.issues.filter(i => 'entity' in i && transferTargetKey(i as unknown as TransferRow) === key)
    const changed = !!target && (target.create || target.cells.some(c => c.verdict === 'changed') || !!target.presence || !!target.priceWrite)
    if (!target && !issues.length) issues.push({ ...group[0], message: 'This row could not be checked. Import the file again.' })
    const status: RecordStatus = issues.length || !target ? 'INVALID' : changed ? 'REVIEWED' : 'UNCHANGED'
    const product = context.products.get(group[0].sku)
    const parent = product?.parentId ? [...context.products.values()].find(p => p.id === product.parentId) : undefined
    const dependencies = [...new Set([group[0].sku, ...(parent ? [parent.sku] : [])])].map(sku => ({ sku, before: context.products.get(sku) ?? null }))
    const payload: RecordPayload = { rows: group, issues, ...(target && status === 'REVIEWED' ? { target, changed, dependencies } : {}), ...(target && status === 'INVALID' ? { cells: target.cells.filter(c => c.verdict === 'changed') } : {}) }
    return { key, status, payload }
  })
}

/**
 * The review rows of what Apply makes, first in the list and in the order it makes them: the new products ("New product
 * GALE-JACKET (varies by Colore, Taglia)", "New variation GALE-JACKET-BLACK-MEN-M (Nero · M)"), the main listing
 * ("New listing (draft)"), the listing SKUs and extra listings, then the values of each new listing until they are records.
 */
export function planChanges(payload: Payload): SheetImportChange[] {
  const out: SheetImportChange[] = []
  const change = (id: string, at: { sku: string; marketplace: string; accountId: string; aliasKey: string }, destination: string, field: string, label: string, before: unknown, after: unknown, status: SheetImportChangeStatus): SheetImportChange =>
    ({ id, sku: at.sku, destination, entity: 'Listings', channel: 'EBAY', marketplace: at.marketplace, accountId: at.accountId, aliasKey: at.aliasKey, locale: '', field, label, before, after, beforeState: 'stored', afterState: 'stored', status })
  const product = (id: string, sku: string, field: string, label: string, before: unknown, after: unknown, status: SheetImportChangeStatus): SheetImportChange =>
    ({ id, sku, destination: 'Shared', entity: 'Products', channel: '', marketplace: '', accountId: '', aliasKey: '', locale: '', field, label, before, after, beforeState: 'stored', afterState: 'stored', status })
  const done = payload.listingsDone
  const made: SheetImportChangeStatus = done || payload.familiesDone ? 'saved' : 'new'
  // An undo: what goes to the recycle bin, what stays (the open product stays a parent), what is removed.
  const undone: SheetImportChangeStatus = done ? 'saved' : 'new'
  const binned = new Set((payload.listingUndo?.families ?? []).flatMap(f => f.products.map(p => p.id)))
  for (const f of payload.listingUndo?.families ?? []) {
    const variations = f.products.filter(p => p.id !== f.rootId).length
    if (f.axesSet) out.push(product(`plan:ux:${f.rootSku}`, f.rootSku, 'variationAxes', 'Axes', f.axes.join(', '), null, undone))
    for (const v of f.filled ?? []) for (const [code, value] of Object.entries(v.values)) out.push(product(`plan:uv:${v.sku}:${code}`, v.sku, `variation:${code}`, labelOf(f, code), value, null, undone))
    if (f.adopted) out.push(product(`plan:uf:${f.rootSku}`, f.rootSku, 'variations', 'Variations', `${variations} ${variations === 1 ? 'variation' : 'variations'}`,
      `${f.rootSku} stays a product with variations${f.axes.length ? ` (${f.axes.join(', ')})` : ''}. Its variations go to the recycle bin.`, undone))
    for (const p of f.products) out.push(product(`plan:ud:${p.sku}`, p.sku, 'product', 'Product', `Product ${p.sku}`, 'In the recycle bin', undone))
  }
  for (const m of payload.listingUndo?.mains ?? []) {
    if (m.listings.some(l => !binned.has(l.productId))) out.push(change(`plan:um:${m.rootSku}`, { sku: m.rootSku, marketplace: m.marketplace, accountId: m.accountId, aliasKey: '' }, `eBay · ${m.marketplace}`, 'listing', 'Listing', 'Draft listing', 'Removed', undone))
  }
  for (const n of payload.listingUndo?.named ?? []) out.push(change(`plan:u:${n.aliasId}`, { sku: n.rootSku, marketplace: n.marketplace, accountId: '', aliasKey: n.aliasId }, `eBay · ${n.marketplace} · ${n.label}`, 'listingSku', 'Listing SKU', n.sku, null, undone))
  for (const c of payload.listingUndo?.created ?? []) out.push(change(`plan:a:${c.aliasId}`, { sku: c.rootSku, marketplace: c.marketplace, accountId: c.accountId, aliasKey: c.aliasId }, `eBay · ${c.marketplace} · ${c.sku}`, 'listing', 'Listing', `Listing ${c.sku} (draft)`, 'Archived', undone))
  // An import: the families, then the main listings, then the extra listings.
  for (const f of payload.listingPlan?.families ?? []) {
    const varies = f.axes.length ? ` (varies by ${f.axes.map(a => a.label).join(', ')})` : ''
    if (f.existingId) {
      // Phase 2b — an existing family: the axes it gets, its new variations, the values it lacked, then their listing values.
      if (f.setsAxes) out.push(product(`plan:x:${f.rootSku}`, f.rootSku, 'variationAxes', 'Axes', null, f.axes.map(a => a.label).join(', '), made))
      for (const c of f.children) out.push(product(`plan:v:${c.sku}`, c.sku, 'variation', 'Variation', null,
        `${f.restore[c.sku] ? `${c.sku} back from the recycle bin` : `New variation ${c.sku}`} (${f.axes.map(a => c.values[a.code]).join(' · ')})`, made))
      for (const v of f.fills ?? []) for (const a of f.axes) if (v.values[a.code]) out.push(product(`plan:fv:${v.sku}:${a.code}`, v.sku, `variation:${a.code}`, a.label, null, v.values[a.code], made))
      if (!done) (f.rows ?? []).forEach((row, i) => {
        const listing = f.listings?.find(l => l.aliasKey === row.aliasKey && l.accountId === row.accountId)
        out.push(change(`plan:fr:${f.rootSku}:${i}`, { sku: row.sku, marketplace: row.marketplace, accountId: row.accountId, aliasKey: row.aliasKey },
          `eBay · ${row.marketplace}${row.aliasKey && listing ? ` · ${listing.label}` : ''}`, row.field, payload.labels[labelKey(row, row.field)] ?? humanize(row.field), null, row.value, 'new'))
      })
      continue
    }
    out.push(f.adoptId ? product(`plan:f:${f.rootSku}`, f.rootSku, 'variations', 'Variations', 'No variations', `${f.rootSku} becomes a product with variations${varies}`, made)
      : product(`plan:f:${f.rootSku}`, f.rootSku, 'product', 'Product', null, `${f.restore[f.rootSku] ? `${f.rootSku} back from the recycle bin` : `New product ${f.rootSku}`}${varies}`, made))
    for (const c of f.children) {
      const values = f.axes.length ? ` (${f.axes.map(a => c.values[a.code]).join(' · ')})` : ''
      out.push(product(`plan:v:${c.sku}`, c.sku, 'variation', 'Variation', null, `${f.restore[c.sku] ? `${c.sku} back from the recycle bin` : `New variation ${c.sku}`}${values}`, made))
    }
  }
  for (const m of payload.listingPlan?.mains ?? []) {
    const at = { sku: m.rootSku, marketplace: m.marketplace, accountId: m.accountId, aliasKey: '' }
    out.push(change(`plan:m:${m.rootSku}`, at, `eBay · ${m.marketplace}`, 'listing', 'Listing', null, 'New listing (draft)', made))
    if (done) continue
    m.rows.forEach((row, i) => out.push(change(`plan:m:${m.rootSku}:${i}`, { ...at, sku: row.sku }, `eBay · ${m.marketplace}`, row.field,
      payload.labels[labelKey(row, row.field)] ?? humanize(row.field), null, row.value, 'new')))
  }
  for (const n of payload.listingPlan?.names ?? []) out.push(change(`plan:n:${n.aliasId}`, { sku: n.rootSku, marketplace: n.marketplace, accountId: n.accountId, aliasKey: n.aliasId }, `eBay · ${n.marketplace} · ${n.label}`, 'listingSku', 'Listing SKU', null, n.sku, done ? 'saved' : 'new'))
  for (const c of payload.listingPlan?.creates ?? []) {
    const at = { sku: c.rootSku, marketplace: c.marketplace, accountId: c.accountId, aliasKey: '' }
    out.push(change(`plan:c:${c.sku}`, at, `eBay · ${c.marketplace} · ${c.sku}`, 'listing', 'Listing', null, `New listing ${c.sku} (draft)`, done ? 'saved' : 'new'))
    if (done) continue
    c.rows.forEach((row, i) => out.push(change(`plan:c:${c.sku}:${i}`, { ...at, sku: row.sku }, `eBay · ${c.marketplace} · ${c.sku}`, row.field,
      payload.labels[labelKey(row, row.field)] ?? humanize(row.field), null, row.value, 'new')))
  }
  return out
}

/** An axis's label in an undo row: the family's own spelling for the code, else the code. */
const labelOf = (family: FamilyDone, code: string) => family.axes[(family.axisCodes ?? []).indexOf(code)] ?? code

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
  // A listing the import created is archived as a whole, a product it created goes to the recycle bin, a draft it made on the
  // open product is removed: their cells are not put back one by one.
  const created = new Set(payload.listingsDone?.created.map(c => c.aliasId) ?? [])
  const madeProducts = new Set((payload.listingsDone?.families ?? []).flatMap(f => f.products.map(p => p.sku)))
  const madeListings = new Set((payload.listingsDone?.mains ?? []).flatMap(m => m.listings.map(l => l.id)))
  for (const item of saved) {
    const target = (item.parsedValues as unknown as RecordPayload).target
    if (!target || target.create || created.has(target.identity.aliasKey) || madeProducts.has(target.identity.sku) || madeListings.has(String(target.before?.id ?? ''))) continue
    for (const cell of target.cells) {
      if (cell.verdict !== 'changed' || NOT_UNDONE.has(cell.field)) continue
      const { before, after, beforeState, afterState, verdict: _verdict, channelRead: _read, effectiveBefore: _eb, effectiveAfter: _ea, label: _label, expected: _expected, version: _version, ...identity } = cell
      rows.push({ ...identity, row: 0, source: undefined,
        action: beforeState === 'inherited' ? 'INHERIT' : isEmptyChannelValue(before) ? 'CLEAR' : 'SET', value: beforeState === 'inherited' || isEmptyChannelValue(before) ? null : before,
        expected: { action: afterState === 'inherited' ? 'INHERIT' : 'SET', value: after } })
    }
  }
  if (!rows.length && !undoSize(payload.listingsDone)) throw new TransferConflict('This import saved nothing that can be undone.')
  const status = await createSheetImport({ rows, issues: [], boundary: payload.boundary, market: payload.market, format: 'undo', filename: `Undo · ${job.uploadFilename ?? 'import'}`, userId,
    warnings: [], links: [], deletes: [], labels: payload.labels, undoOf: jobId, autoApply: true, ...(undoSize(payload.listingsDone) ? { listingUndo: payload.listingsDone } : {}) })
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
    // Phase 2 — a family this import created is another product than the open one: the done screen offers to open it.
    ...(!payload.undoneBy && payload.listingsDone?.families?.some(f => !f.adopted && !f.existing) ? { newFamilies: payload.listingsDone.families.filter(f => !f.adopted && !f.existing).map(f => ({ productId: f.rootId, sku: f.rootSku })) } : {}),
    ...(Array.isArray(job.errors) && (job.errors[0] as { message?: string })?.message ? { error: (job.errors[0] as { message: string }).message } : {}) }
}

/** The review page: every changed cell and every problem, flat, in record order. `filter: 'problems'` keeps problems only. */
export async function sheetImportChanges(jobId: string, userId: string | null, query: { page?: number; filter?: string; search?: string } = {}): Promise<SheetImportChangesPage | null> {
  const loaded = await readSheetImport(jobId, userId)
  if (!loaded) return null
  const { payload } = loaded
  const records = await prisma.importJobRow.findMany({ where: { jobId }, orderBy: { rowIndex: 'asc' }, select: { id: true, status: true, errorMessage: true, parsedValues: true } })
  const out: SheetImportChange[] = planChanges(payload)
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
  const scopes = [payload.boundary, ...payload.familyBoundaries ?? []].filter(Boolean)
  const scope = scopes.find(b => b.products.some(p => p.sku === identity.sku)) ?? payload.boundary
  const listing = entity !== 'Products' && scope ? scope.listings.find(l => l.channel === identity.channel && l.marketplace === identity.marketplace && l.accountId === identity.accountId && l.aliasKey === identity.aliasKey)?.aliasLabel : undefined
  return { id, ...identity, destination: cell.field ? destinationOf(identity as TransferRow, scope) : 'File', ...(listing ? { listing } : {}),
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
