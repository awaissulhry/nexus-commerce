/**
 * MCP full control P9 — the catalog import and the bulk rollback, as `import-catalog` and `rollback-bulk-operation`
 * drive them. Loaded by data-transfer.tools.ts only inside a handler (`await import`): it reaches the import wizard and
 * the bulk services, which a registry import must never pull in (the channel and auth services behind them).
 *
 * Two rules from the Owner's choice A (2026-10-02):
 *
 *  · Claude's import is the SAME wizard a person uses. The dry run reads the file, maps it and plans it with the
 *    wizard's own functions (`readSourceFile`, `mapSourceTable`, `buildTransferPlan`), writing nothing. When a person
 *    approves, the run uploads the file to the wizard (`inspectCatalogSource`), has the wizard review it
 *    (`previewCatalogSource`) and applies it (`ImportWizardService.apply`) only when the wizard's review writes exactly
 *    what the approved preview showed. Every check, match and message is the wizard's.
 *  · An import is undone by re-importing what its records replaced (their "before" record, catalog-transfer-before.ts)
 *    through the same wizard — refused while any of those values no longer reads as the import wrote it.
 */
import { transferCanonical, type TransferCell, type TransferIssue, type TransferMode, type TransferRow } from '@nexus/shared/catalog-transfer'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { buildTransferPlan, fingerprint, targetWriteFingerprint, transferContracts, type TransferTarget } from '../../pim/catalog-transfer-plan.js'
import { loadTransferContext } from '../../pim/catalog-transfer.service.js'
import { createReferenceResolver } from '../../pim/reference-values.service.js'
import { readSourceFile } from '../../pim/catalog-source-file.js'
import { mapSourceTable, validateSourceMapping, type SourceMapping } from '../../pim/catalog-source-mapping.js'
import { inspectCatalogSource, previewCatalogSource, readSourcePreset } from '../../pim/catalog-source.service.js'
import { applyTransferJob, readTransferJob, stageTransferJob, transferJobStatus, TRANSFER_JOB_KIND } from '../../pim/catalog-transfer-jobs.js'
import { readTransferBeforeRecord, type TransferBeforeCell } from '../../pim/catalog-transfer-before.js'
import { safeFetch, SafeFetchError } from '../../net/safe-fetch.js'
import { ImportWizardService } from '../../import-wizard.service.js'
import { safeText } from './claude-safe.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

/** 09 §4 — what Claude may import at once; a bigger file is imported in Nexus. */
export const MAX_IMPORT_ROWS = 500
export const MAX_IMPORT_BYTES = 512 * 1024
/** Changed values an import (or its undo) may carry from here; beyond it the review belongs in Nexus. */
export const MAX_IMPORT_VALUES = 5_000
/** Bulk-job items an undo from here may cover. */
export const MAX_ROLLBACK_ITEMS = 5_000
const SHOWN = 20
const PAUSE_MS = 100
const WAIT_MS = 120_000

const fail = (error: string): ToolResult => ({ ok: false, error })
const message = (error: unknown) => safeText(error instanceof Error ? error.message : String(error), 400)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What the approval compares: the counts and the basis, in a canonical form. */
export const materialOf = (preview: unknown) => {
  const p = (preview ?? {}) as { counts?: unknown; basis?: unknown }
  return transferCanonical({ counts: p.counts ?? null, basis: p.basis ?? null })
}

// ── Planning, as the wizard plans ──────────────────────────────────────────────────────────────────

const writes = (target: TransferTarget) => target.create || target.cells.some(cell => cell.verdict === 'changed')

/**
 * The wizard's review of these rows, computed whole and written nowhere: the same contracts, reference resolver and
 * planner `runTransferJob` uses per page, and the same mark on a new product another row names as its parent.
 */
export async function planRows(rows: TransferRow[], mode: TransferMode, market: string, policy?: SourceMapping['policy']) {
  if (!rows.length) return { targets: [] as TransferTarget[], issues: [] as TransferIssue[], exclusions: [] as TransferIssue[], warnings: [] as string[] }
  const contracts = transferContracts(market)
  contracts.reference = createReferenceResolver()
  const context = await loadTransferContext(rows)
  const plan = await buildTransferPlan(rows, mode, context, contracts, policy)
  const declaredParents = new Set(rows.filter(r => r.entity === 'Products' && r.field === 'parentSku' && r.action === 'SET').map(r => String(r.value)))
  for (const target of plan.targets) if (target.create && target.identity.entity === 'Products' && declaredParents.has(target.identity.sku)) target.patch.isParent = true
  return { targets: plan.targets, issues: plan.issues, exclusions: (plan.exclusions ?? []) as TransferIssue[], warnings: plan.warnings }
}

/**
 * Everything a plan writes, record by record, and the values it replaces: the dry run's and the wizard's review must
 * give the same, and a value that moved after the person approved (even to be overwritten with the same new value) is
 * a different decision.
 */
export function planFingerprint(targets: TransferTarget[]): string {
  return fingerprint(targets.filter(writes)
    .map(t => [t.key, t.create, targetWriteFingerprint(t), t.categories ?? null, t.parentSku ?? null,
      t.cells.filter(c => c.verdict === 'changed').map(c => [c.entity, c.field, c.locale, c.before ?? null, c.beforeState])] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

/** The wizard's own review of a staged job, as `planFingerprint` reads it, with its refusals. */
async function reviewOf(jobId: string) {
  const rows = await prisma.importJobRow.findMany({ where: { jobId }, select: { parsedValues: true } })
  const records = rows.map(row => row.parsedValues as { target?: TransferTarget; issues?: TransferIssue[] } | null)
  return {
    plan: planFingerprint(records.flatMap(r => (r?.target ? [r.target] : []))),
    issues: records.flatMap(r => r?.issues ?? []),
  }
}

/** Wait (real time) until the wizard's job reaches one of `states`; null when it has not within the wait. */
async function settled(jobId: string, userId: string | null, states: string[]) {
  const until = Date.now() + WAIT_MS
  for (;;) {
    const loaded = await readTransferJob(jobId, userId)
    if (loaded && states.includes(loaded.job.status)) return transferJobStatus(loaded)
    if (!loaded || Date.now() > until) return null
    await new Promise(resolve => setTimeout(resolve, PAUSE_MS))
  }
}

type Located = Pick<TransferCell, 'entity' | 'sku' | 'channel' | 'accountId' | 'marketplace' | 'aliasKey' | 'locale' | 'field'>
const cellKey = (c: Located) => JSON.stringify([c.entity, c.sku, c.channel, c.accountId, c.marketplace, c.aliasKey, c.locale, c.field])
const where = (c: Located) => (c.entity === 'Products' ? 'product' : `${c.channel} ${c.marketplace} listing`)
const shown = (value: unknown) => (typeof value === 'string' ? safeText(value, 300) : value ?? null)
/** One changed value, keyed by its field so the door's money filter takes a money field out by its name. */
const line = (c: Located, from: { value: unknown; state: string }, to: { value: unknown; state: string }) => ({
  sku: c.sku,
  where: where(c),
  ...(c.entity !== 'Products' ? { account: c.accountId } : {}),
  field: c.field,
  ...(c.locale ? { locale: c.locale } : {}),
  from: { [c.field]: shown(from.value) },
  to: { [c.field]: shown(to.value) },
  ...(from.state === 'inherited' ? { fromInherited: true } : {}),
  ...(to.state === 'inherited' ? { toInherited: true } : {}),
})
const refusals = (issues: TransferIssue[]) =>
  `${issues.slice(0, 8).map(i => `row ${i.row}${i.field ? ` (${safeText(i.field, 60)})` : ''}: ${safeText(i.message, 200)}`).join('; ')}${issues.length > 8 ? `; and ${issues.length - 8} more` : ''}`

// ── import-catalog ─────────────────────────────────────────────────────────────────────────────────

export interface ImportArgs {
  text?: string
  url?: string
  mapping?: Omit<SourceMapping, 'kind' | 'execution'>
  savedMappingId?: string
}
interface Source { buffer: Buffer; filename: string; link?: string }

async function readSource(args: ImportArgs): Promise<Source | { refusal: string }> {
  if (!!args.text === !!args.url) return { refusal: 'Not imported: give the file either as text or as a public https link (one of the two).' }
  if (args.text) {
    const buffer = Buffer.from(args.text, 'utf8')
    if (buffer.length > MAX_IMPORT_BYTES) return { refusal: `Not imported: the text is ${Math.ceil(buffer.length / 1024)} KB; Claude imports at most 512 KB at a time. Split it, or import it in Nexus.` }
    return { buffer, filename: 'claude-import.csv' }
  }
  let url: URL
  try { url = new URL(args.url!) } catch { return { refusal: 'Not imported: that is not a link.' } }
  if (url.protocol !== 'https:') return { refusal: 'Not imported: use a public https link.' }
  try {
    const { buffer } = await safeFetch(url.toString(), { maxBytes: MAX_IMPORT_BYTES, timeoutMs: 30_000, maxRedirects: 0 })
    // Named as the wizard names a fetched source (catalog-source-fetch.ts), so it reads the same format.
    return { buffer, filename: decodeURIComponent(url.pathname.split('/').pop() || 'source.csv'), link: url.toString() }
  } catch (error) {
    if (error instanceof SafeFetchError) return { refusal: `Not imported: the link was refused — ${error.reason === 'too_large' ? 'the file is larger than 512 KB' : error.message}.` }
    return { refusal: `Not imported: the link could not be read — ${message(error)}.` }
  }
}

async function readMapping(args: ImportArgs, ctx: ToolContext): Promise<SourceMapping | { refusal: string }> {
  if (!!args.mapping === !!args.savedMappingId) return { refusal: 'Not imported: give the column mapping, or the id of a saved mapping (one of the two).' }
  if (args.savedMappingId) {
    // A person's saved mappings are their own; the approval's re-check (no person) reads the one the request named.
    const preset = ctx.userId
      ? await readSourcePreset(args.savedMappingId, ctx.userId)
      : await prisma.scheduledImport.findFirst({ where: { id: args.savedMappingId, targetEntity: 'catalog-source-v1' } })
    if (!preset) return { refusal: 'Saved mapping not found' }
    try { return validateSourceMapping(preset.columnMapping) } catch (error) { return { refusal: `Not imported: the saved mapping is not usable — ${message(error)}` } }
  }
  try { return validateSourceMapping({ kind: 'catalog-source-v1', ...args.mapping }) } catch (error) { return { refusal: `Not imported: ${message(error)}` } }
}

interface ImportPlan {
  source: Source
  mapping: SourceMapping
  preview: Record<string, unknown> & { basis: { source: string; mapping: string; plan: string } }
  writing: TransferTarget[]
}

async function planImport(args: ImportArgs, ctx: ToolContext): Promise<ImportPlan | { refusal: string }> {
  const source = await readSource(args)
  if ('refusal' in source) return source
  const mapping = await readMapping(args, ctx)
  if ('refusal' in mapping) return mapping
  let table: Awaited<ReturnType<typeof readSourceFile>>
  try { table = await readSourceFile(source.buffer, source.filename) } catch (error) { return { refusal: `Not imported: ${message(error)}` } }
  if (!table.records.length) return { refusal: 'Not imported: the file has a header and no rows.' }
  if (table.records.length > MAX_IMPORT_ROWS) {
    return { refusal: `Not imported: the file has ${table.records.length} rows; Claude imports at most ${MAX_IMPORT_ROWS} at a time. Split it, or import it in Nexus (Products › Import).` }
  }
  let mapped: ReturnType<typeof mapSourceTable>
  try { mapped = mapSourceTable(table, mapping) } catch (error) { return { refusal: `Not imported: ${message(error)}` } }
  for (const row of [...mapped.rows, ...mapped.issues, ...mapped.exclusions]) row.source = { ...row.source, file: source.filename }
  let plan: Awaited<ReturnType<typeof planRows>>
  try { plan = await planRows(mapped.rows, mapping.mode, mapping.market, mapping.policy) } catch (error) { return { refusal: `Not imported: ${message(error)}` } }
  const issues = [...mapped.issues, ...plan.issues]
  if (issues.length) {
    return { refusal: `Not imported: Nexus's import refuses ${plural(issues.length, 'value')} of this file — ${refusals(issues)}. Correct the file and ask again.` }
  }
  const writing = plan.targets.filter(writes)
  const cells = plan.targets.flatMap(t => t.cells)
  const changed = cells.filter(c => c.verdict === 'changed')
  const preserved = mapped.exclusions.length + plan.exclusions.length
  if (!writing.length) {
    return { refusal: `Not imported: the file changes nothing here — ${plural(cells.length - changed.length, 'value')} already read like this${preserved ? `, ${preserved} left as they are` : ''}.` }
  }
  if (changed.length > MAX_IMPORT_VALUES) {
    return { refusal: `Not imported: the file changes ${changed.length} values; Claude imports at most ${MAX_IMPORT_VALUES} at a time. Import it in Nexus (Products › Import).` }
  }
  const products = writing.filter(t => t.identity.entity === 'Products')
  const listings = writing.filter(t => t.identity.entity !== 'Products')
  const lines = changed.map(c => line(c, { value: c.before, state: c.beforeState }, { value: c.after, state: c.afterState }))
  return {
    source,
    mapping,
    writing,
    preview: {
      action: 'import-catalog',
      source: {
        kind: source.link ? 'link' : 'text',
        file: safeText(source.filename, 120),
        ...(source.link ? { link: safeText(source.link, 300) } : {}),
        rows: table.records.length,
        columns: table.headers.slice(0, 40).map(h => safeText(h, 80)),
        ...(mapped.unmappedColumns.length ? { notImported: mapped.unmappedColumns.slice(0, 40).map(h => safeText(h, 80)) } : {}),
      },
      mapping: {
        market: mapping.market,
        mode: mapping.mode,
        policy: mapping.policy,
        columns: mapping.bindings.slice(0, 40).map(b => `${safeText(b.source, 80)} → ${b.entity === 'Products' ? 'product' : 'listing'} ${safeText(b.field, 80)}`),
      },
      counts: {
        productsCreated: products.filter(t => t.create).length,
        productsChanged: products.filter(t => !t.create).length,
        listingsCreated: listings.filter(t => t.create).length,
        listingsChanged: listings.filter(t => !t.create).length,
        valuesChanged: changed.length,
        valuesAlreadyTheSame: cells.length - changed.length,
        valuesLeftAsTheyAre: preserved,
      },
      changes: lines.slice(0, SHOWN),
      ...(lines.length > SHOWN ? { moreChanges: lines.length - SHOWN } : {}),
      ...(plan.warnings.length ? { warnings: plan.warnings.slice(0, 10).map(w => safeText(w, 200)) } : {}),
      // What the approval holds still: the file, the mapping and every write (the gate re-checks; the run compares).
      basis: { source: fingerprint(source.buffer.toString('base64')), mapping: fingerprint(mapping), plan: planFingerprint(plan.targets) },
      note: 'Runs through Nexus\'s catalog import. When a person approves, Nexus reviews the file again and applies it only '
        + 'if its review writes exactly this; listings then sync to their channels like any edit. Undo re-imports the values it '
        + 'replaced (products and listings it created stay).',
    },
  }
}

export async function importCatalogDryRun(args: ImportArgs, ctx: ToolContext): Promise<ToolResult> {
  const planned = await planImport(args, ctx)
  return 'refusal' in planned ? fail(planned.refusal) : { ok: true, preview: planned.preview }
}

export async function importCatalogExecute(args: ImportArgs, ctx: ToolContext): Promise<ToolResult> {
  const planned = await planImport(args, ctx)
  if ('refusal' in planned) return fail(planned.refusal)
  if (ctx.approvedPreview !== undefined && materialOf(ctx.approvedPreview) !== materialOf(planned.preview)) {
    return fail('Not imported: the file, its mapping or what it changes moved since this was approved. Ask again for a fresh review.')
  }
  const userId = ctx.userId ?? null
  // The wizard, as a person runs it: upload the file, map it, let Nexus review it, apply the review.
  const inspected = await inspectCatalogSource(planned.source.buffer, planned.source.filename, userId, planned.source.link)
  const staged = await previewCatalogSource({ sourceId: inspected.sourceId, inputHash: inspected.hash, mapping: planned.mapping, userId })
  const jobId = staged.jobId
  const review = await settled(jobId, userId, ['QUEUED', 'INVALID', 'FAILED'])
  if (!review) return fail(`Not imported: Nexus's review of the file did not finish in time. It is import ${jobId} in Nexus (Products › Import), where a person can apply it.`)
  const reviewed = await reviewOf(jobId)
  if (review.state !== 'QUEUED') {
    return fail(`Not imported: Nexus's review refused the file${reviewed.issues.length ? ` — ${refusals(reviewed.issues)}` : review.error ? ` — ${safeText(review.error, 200)}` : ''}. The review is import ${jobId} in Nexus.`)
  }
  if (reviewed.plan !== planned.preview.basis.plan) {
    return fail(`Not imported: Nexus's review writes something other than the approved preview (the catalog changed meanwhile). Nothing was applied; ask again for a fresh review.`)
  }
  try {
    await new ImportWizardService(prisma).apply(jobId, review.reviewToken, userId)
  } catch (error) {
    return fail(`Not imported: ${message(error)}`)
  }
  const done = await settled(jobId, userId, ['COMPLETED', 'PARTIAL', 'FAILED'])
  return {
    ok: true,
    data: {
      jobId,
      state: done?.state ?? 'RUNNING',
      ...(done?.receipt ? { receipt: done.receipt } : {}),
      note: done ? 'Imported through Nexus\'s catalog import; its review and outcomes are in Products › Import.' : 'Still applying in Nexus; follow it with job-history (kind transfer).',
    },
    // C2 — undo re-imports what this import's records replaced (rollback-bulk-operation), refused when a value moved.
    change: {
      before: { jobId, file: safeText(planned.source.filename, 120), records: planned.writing.length },
      after: { jobId, changedSince: [] },
    },
  }
}

// ── Undoing an import: re-import its "before" record ─────────────────────────────────────────────────

/** The row that puts one recorded cell back: inherited again, cleared, or set to the value it held. */
function inverseRow(row: number, cell: TransferBeforeCell): TransferRow {
  const coordinate = { row, entity: cell.entity, sku: cell.sku, channel: cell.channel, accountId: cell.accountId, marketplace: cell.marketplace, aliasKey: cell.aliasKey, locale: cell.locale, field: cell.field }
  if (cell.beforeState === 'inherited') return { ...coordinate, action: 'INHERIT' }
  return cell.before == null ? { ...coordinate, action: 'CLEAR' } : { ...coordinate, action: 'SET', value: cell.before }
}

/** Does the catalog still hold what the import wrote here? (An inherited value is compared by its state.) */
const stillAsWritten = (cell: TransferBeforeCell, now: TransferCell | undefined) =>
  !!now && now.beforeState === cell.afterState && (cell.afterState === 'inherited' || transferCanonical(now.before ?? null) === transferCanonical(cell.after ?? null))

interface ImportUndo {
  file: string
  market: string
  rows: TransferRow[]
  moved: string[]
  preview: Record<string, unknown> & { basis: { jobId: string; plan: string } }
}

type Operation = { id: string; status: string; changes: unknown; uploadFilename: string | null; completedAt: Date | null }

async function planImportUndo(op: Operation, ctx: Pick<ToolContext, 'can'>): Promise<ImportUndo | { refusal: string }> {
  const payload = op.changes as { market: string; sharedCopy?: boolean }
  const file = safeText(op.uploadFilename ?? 'import', 120)
  if (!['COMPLETED', 'PARTIAL'].includes(op.status)) return { refusal: `Not undone: the import "${file}" is ${op.status.toLowerCase()}; only a finished import can be undone.` }
  if (!ctx.can(F.productsImport)) return { refusal: 'Not undone: undoing an import re-imports values, which needs the catalog import permission.' }
  if (payload.sharedCopy) return { refusal: `Not undone: "${file}" is a first copy of another business's products; change it in Nexus.` }
  const rows = await prisma.importJobRow.findMany({ where: { jobId: op.id, status: 'SUCCESS' }, select: { rowIndex: true, beforeState: true }, orderBy: { rowIndex: 'asc' } })
  const records = rows.flatMap(r => { const record = readTransferBeforeRecord(r.beforeState); return record ? [{ row: r.rowIndex, record }] : [] })
  const wrote = await prisma.importJobRow.count({ where: { jobId: op.id, status: 'SUCCESS', parsedValues: { path: ['changed'], equals: true } } })
  if (records.length < wrote) {
    return { refusal: `Not undone: the import "${file}" ran before Nexus kept a record of the values it replaced, so it cannot be put back here. Change the values back in Nexus.` }
  }
  if (!records.length) return { refusal: `Not undone: the import "${file}" changed nothing.` }
  if (records.some(r => r.record.cells.some(c => c.origin === 'channel-file'))) {
    return { refusal: `Not undone: "${file}" came from a channel's own file (ended listings, recorded channel prices); an import cannot put those back. Change them in Nexus.` }
  }
  const created = records.filter(r => r.record.created)
  const cells = records.filter(r => !r.record.created).flatMap(r => r.record.cells.map(cell => ({ row: r.row, cell })))
  if (!cells.length) {
    return { refusal: `Not undone: the import "${file}" only created ${plural(created.length, 'product or listing', 'products or listings')}; undo cannot delete them. Delete them in Nexus if they should go.` }
  }
  if (cells.length > MAX_IMPORT_VALUES) return { refusal: `Not undone: the import "${file}" changed ${cells.length} values; undo an import this large in Nexus.` }
  const inverse = cells.map(({ row, cell }) => inverseRow(row, cell))
  let plan: Awaited<ReturnType<typeof planRows>>
  try { plan = await planRows(inverse, 'update', payload.market) } catch (error) { return { refusal: `Not undone: ${message(error)}` } }
  if (plan.issues.length) return { refusal: `Not undone: Nexus's import refuses ${plural(plan.issues.length, 'value')} of the undo — ${refusals(plan.issues)}.` }
  const now = new Map(plan.targets.flatMap(t => t.cells.map(c => [cellKey(c), c] as const)))
  const moved = cells.filter(({ cell }) => !stillAsWritten(cell, now.get(cellKey(cell))))
    .map(({ cell }) => `${cell.sku} ${cell.field}${cell.locale ? ` [${cell.locale}]` : ''}${cell.entity === 'Products' ? '' : ` (${cell.channel} ${cell.marketplace})`}`)
  const writing = plan.targets.filter(writes)
  const lines = writing.flatMap(t => t.cells.filter(c => c.verdict === 'changed'))
    .map(c => line(c, { value: c.before, state: c.beforeState }, { value: c.after, state: c.afterState }))
  return {
    file,
    market: payload.market,
    rows: inverse,
    moved,
    preview: {
      action: 'rollback-bulk-operation',
      kind: 'import',
      jobId: op.id,
      file,
      finishedAt: op.completedAt?.toISOString() ?? null,
      counts: {
        valuesPutBack: lines.length,
        products: writing.filter(t => t.identity.entity === 'Products').length,
        listings: writing.filter(t => t.identity.entity !== 'Products').length,
        createdProductsKept: created.filter(r => r.record.identity.entity === 'Products').length,
        createdListingsKept: created.filter(r => r.record.identity.entity !== 'Products').length,
      },
      changes: lines.slice(0, SHOWN),
      ...(lines.length > SHOWN ? { moreChanges: lines.length - SHOWN } : {}),
      basis: { jobId: op.id, plan: planFingerprint(plan.targets) },
      note: 'Re-imports the values this import replaced, through Nexus\'s catalog import: when a person approves, Nexus reviews '
        + 'the undo again and applies it only if its review writes exactly this. Products and listings the import created stay. '
        + 'The undo runs as its own import.',
    },
  }
}

/** For `import-catalog`'s undo (`undo.current`): which values of the import no longer read as it wrote them. */
export async function importChangedSince(jobId: string): Promise<string[]> {
  const op = await prisma.bulkOperation.findUnique({ where: { id: jobId }, select: { id: true, status: true, changes: true, uploadFilename: true, completedAt: true } })
  if (!op) return ['the import is no longer there']
  const planned = await planImportUndo(op, { can: () => true })
  return 'refusal' in planned ? [] : planned.moved.slice(0, 5)
}

// ── Undoing a bulk job: Nexus's bulk rollback ───────────────────────────────────────────────────────

const BULK_SUPPORTED = new Set(['PRICING_UPDATE', 'INVENTORY_UPDATE', 'STATUS_UPDATE', 'ATTRIBUTE_UPDATE'])
type Item = { productId: string | null; beforeState: unknown; afterState: unknown }
type Job = { id: string; jobName: string; actionType: string; status: string; isRollbackable: boolean; rollbackJobId: string | null; completedAt: Date | null; actionPayload: unknown }

/** The value a bulk job item stores, read from the product now (bulk-action.service.ts `extractItemState`). */
async function bulkStateNow(actionType: string, product: Record<string, unknown>, after: Record<string, unknown> | null, job: Job) {
  if (actionType === 'PRICING_UPDATE') return { basePrice: product.basePrice != null ? Number(product.basePrice) : null }
  if (actionType === 'INVENTORY_UPDATE') return { totalStock: product.totalStock ?? null }
  if (actionType === 'STATUS_UPDATE') return { status: product.status ?? null }
  const attributeName = String(after?.attributeName ?? (job.actionPayload as { attributeName?: unknown } | null)?.attributeName ?? '')
  const { readProductAttribute } = await import('../../bulk-action/attribute-helpers.js')
  const { currentValue, kind, jsonKey } = readProductAttribute(product as never, attributeName)
  return { attributeName, kind, jsonKey: jsonKey ?? null, value: currentValue }
}

/** A bulk item's state as one value per field: an attribute shows under its own name. */
const bulkValue = (state: unknown) => {
  const s = (state ?? {}) as Record<string, unknown>
  return typeof s.attributeName === 'string' ? { [s.attributeName]: shown(s.value) } : Object.fromEntries(Object.entries(s).map(([k, v]) => [k, shown(v)]))
}

async function planBulkRollback(job: Job): Promise<{ preview: Record<string, unknown> } | { refusal: string }> {
  const name = safeText(job.jobName, 120)
  if (!['COMPLETED', 'PARTIALLY_COMPLETED'].includes(job.status)) return { refusal: `Not undone: the bulk job "${name}" is ${job.status.toLowerCase()}; only a finished job can be undone.` }
  if (job.rollbackJobId) return { refusal: `Not undone: the bulk job "${name}" was already undone (job ${job.rollbackJobId}).` }
  if (!job.isRollbackable) return { refusal: `Not undone: the bulk job "${name}" cannot be undone (it is itself an undo, or was marked so).` }
  if (!BULK_SUPPORTED.has(job.actionType)) return { refusal: `Not undone: a ${job.actionType} bulk job cannot be undone; price, stock, status and attribute changes can.` }
  const items: Item[] = await prisma.bulkActionItem.findMany({ where: { jobId: job.id, status: 'SUCCEEDED' }, select: { productId: true, beforeState: true, afterState: true }, orderBy: { id: 'asc' } })
  if (!items.length) return { refusal: `Not undone: the bulk job "${name}" changed nothing that can be put back (no item succeeded).` }
  if (items.length > MAX_ROLLBACK_ITEMS) return { refusal: `Not undone: the bulk job "${name}" changed ${items.length} products; undo a job this large in Nexus (Bulk operations).` }
  const withRecord = items.filter(i => i.productId && i.beforeState)
  const ids = [...new Set(withRecord.map(i => i.productId!))]
  const products = new Map<string, Record<string, unknown>>()
  for (let at = 0; at < ids.length; at += 1_000) {
    for (const p of await prisma.product.findMany({ where: { id: { in: ids.slice(at, at + 1_000) } } })) products.set(p.id, p as unknown as Record<string, unknown>)
  }
  const moved: string[] = []
  const lines: Array<Record<string, unknown>> = []
  for (const item of withRecord) {
    const product = products.get(item.productId!)
    const after = item.afterState as Record<string, unknown> | null
    if (!product || product.deletedAt) { moved.push(`${String(product?.sku ?? item.productId)} (deleted)`); continue }
    if (transferCanonical(await bulkStateNow(job.actionType, product, after, job)) !== transferCanonical(after)) { moved.push(String(product.sku)); continue }
    lines.push({ sku: product.sku, from: bulkValue(after), to: bulkValue(item.beforeState) })
  }
  if (moved.length) {
    return { refusal: `Not undone: ${plural(moved.length, 'product')} changed since the bulk job "${name}" wrote ${moved.length === 1 ? 'it' : 'them'} (${moved.slice(0, 5).map(s => safeText(s, 80)).join(', ')}${moved.length > 5 ? ', …' : ''}). Undo would overwrite those later changes.` }
  }
  return {
    preview: {
      action: 'rollback-bulk-operation',
      kind: 'bulk',
      jobId: job.id,
      job: name,
      actionType: job.actionType,
      finishedAt: job.completedAt?.toISOString() ?? null,
      counts: { productsPutBack: lines.length, withoutRecord: items.length - withRecord.length },
      changes: lines.slice(0, SHOWN),
      ...(lines.length > SHOWN ? { moreChanges: lines.length - SHOWN } : {}),
      basis: { jobId: job.id, items: fingerprint(withRecord.map(i => [i.productId, i.beforeState, i.afterState])) },
      note: 'Puts back the values the job replaced, through Nexus\'s bulk rollback (Bulk operations); prices, stock and status '
        + 'then reach the channels like any edit. The undo is recorded as its own job and cannot itself be undone here.',
    },
  }
}

// ── rollback-bulk-operation ─────────────────────────────────────────────────────────────────────────

type Found =
  | { kind: 'bulk'; job: Job }
  | { kind: 'import'; op: Operation }
  | { kind: 'refused'; refusal: string }

async function findJob(jobId: string): Promise<Found> {
  const job = await prisma.bulkActionJob.findUnique({ where: { id: jobId }, select: { id: true, jobName: true, actionType: true, status: true, isRollbackable: true, rollbackJobId: true, completedAt: true, actionPayload: true } })
  if (job) return { kind: 'bulk', job }
  const op = await prisma.bulkOperation.findUnique({ where: { id: jobId }, select: { id: true, status: true, changes: true, uploadFilename: true, completedAt: true } })
  if (op && (op.changes as { kind?: unknown } | null)?.kind === TRANSFER_JOB_KIND) return { kind: 'import', op }
  const legacy = await prisma.importJob.findUnique({ where: { id: jobId }, select: { jobName: true } })
  if (legacy) {
    return { kind: 'refused', refusal: `Not undone: the import "${safeText(legacy.jobName, 120)}" was not made by Nexus's catalog import, so it kept no record of the values it replaced. Change them back in Nexus.` }
  }
  return { kind: 'refused', refusal: 'Job not found' }
}

export async function rollbackDryRun(jobId: string, ctx: ToolContext): Promise<ToolResult> {
  const found = await findJob(jobId)
  if (found.kind === 'refused') return fail(found.refusal)
  if (found.kind === 'bulk') {
    const planned = await planBulkRollback(found.job)
    return 'refusal' in planned ? fail(planned.refusal) : { ok: true, preview: planned.preview }
  }
  const planned = await planImportUndo(found.op, ctx)
  if ('refusal' in planned) return fail(planned.refusal)
  if (planned.moved.length) {
    return fail(`Not undone: ${plural(planned.moved.length, 'value')} of the import "${planned.file}" changed since it wrote them (${planned.moved.slice(0, 5).map(m => safeText(m, 80)).join(', ')}${planned.moved.length > 5 ? ', …' : ''}). Undo would overwrite those later changes.`)
  }
  return { ok: true, preview: planned.preview }
}

export async function rollbackExecute(jobId: string, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await rollbackDryRun(jobId, ctx)
  if (!fresh.ok) return fresh
  if (ctx.approvedPreview !== undefined && materialOf(ctx.approvedPreview) !== materialOf(fresh.preview)) {
    return fail('Not undone: what the undo puts back moved since this was approved. Ask again for a fresh review.')
  }
  const userId = ctx.userId ?? null
  const found = await findJob(jobId)
  if (found.kind === 'bulk') {
    const { BulkActionService } = await import('../../bulk-action.service.js')
    try {
      const result = await new BulkActionService(prisma).rollbackBulkActionJob(jobId, userId)
      return { ok: true, data: { jobId, ...result, note: 'Undone through Nexus\'s bulk rollback; the undo is its own job in Bulk operations.' } }
    } catch (error) {
      return fail(`Not undone: ${message(error)}`)
    }
  }
  if (found.kind !== 'import') return fail(found.refusal)
  const planned = await planImportUndo(found.op, ctx)
  if ('refusal' in planned) return fail(planned.refusal)
  const staged = await stageTransferJob({ rows: planned.rows, issues: [], mode: 'update', market: planned.market, filename: `Undo of ${planned.file}`.slice(0, 200), userId })
  const undoJobId = staged.jobId
  const review = await settled(undoJobId, userId, ['QUEUED', 'INVALID', 'FAILED'])
  if (!review) return fail(`Not undone: Nexus's review of the undo did not finish in time. It is import ${undoJobId} in Nexus (Products › Import).`)
  const reviewed = await reviewOf(undoJobId)
  if (review.state !== 'QUEUED') return fail(`Not undone: Nexus's review refused the undo${reviewed.issues.length ? ` — ${refusals(reviewed.issues)}` : ''}. The review is import ${undoJobId} in Nexus.`)
  if (reviewed.plan !== (fresh.preview as ImportUndo['preview']).basis.plan) {
    return fail('Not undone: Nexus\'s review of the undo writes something other than the approved preview (the catalog changed meanwhile). Ask again.')
  }
  const applied = await applyTransferJob(undoJobId, userId, review.reviewToken!)
  if (!applied) return fail(`Not undone: the undo import ${undoJobId} could not be started.`)
  const done = await settled(undoJobId, userId, ['COMPLETED', 'PARTIAL', 'FAILED'])
  return {
    ok: true,
    data: {
      jobId,
      undoJobId,
      state: done?.state ?? 'RUNNING',
      ...(done?.receipt ? { receipt: done.receipt } : {}),
      note: done ? 'Put back through Nexus\'s catalog import; the undo is its own import in Products › Import.' : 'Still applying in Nexus; follow it with job-history (kind transfer).',
    },
  }
}
