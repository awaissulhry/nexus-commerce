import { inDatabaseTransaction } from '../../lib/database-context.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { Prisma } from '@prisma/client'
import type { TransferRow, TransferIssue, TransferMode, TransferCell, ProductTransferBoundary, TransferChannelRead } from '@nexus/shared/catalog-transfer'
import { transferTargetKey } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { buildTransferPlan, fingerprint, targetWriteFingerprint, transferContracts, type TransferTarget } from './catalog-transfer-plan.js'
import { applyTransferTarget, loadTransferContext, safeSnapshot, TransferConflict } from './catalog-transfer.service.js'
import type { SourceMapping, SourceExclusion } from './catalog-source-mapping.js'
import { clearSheetColumnCache } from './sheet-columns.service.js'
import { clearFieldCatalogueCache } from './mapping/field-catalogue.service.js'
import { preservedTransferOverrides } from './catalog-transfer-preserved.js'
import { createReferenceResolver } from './reference-values.service.js'
import { assertProductTransferRows, checkProductTransferBoundary } from './catalog-product-transfer.js'
import { enrichTransferEffects } from './catalog-transfer-effects.js'
import { STRUCTURE_ROOTS, OUT_OF_SCOPE_ROOTS as AMAZON_OUT_OF_SCOPE_ROOTS } from '../channel-drift/amazon-content-compare.js'
import { withWorkspace, workspaceContext } from '../../lib/workspace-context.js'

export const TRANSFER_BATCH = 100
export const TRANSFER_JOB_KIND = 'catalog-transfer-v2'
const LEASE_MS = 60_000
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const productKey = (sku: string) => JSON.stringify(['Products', sku])
/**
 * CFI (R-CFI-1) additive counts: `alreadyEmpty` — full-update blanks whose Nexus value was already empty (nothing to clear);
 * `clearUnchecked` — ones whose current value could not be read (left alone, the review warns); `cleared`, `ended`,
 * `pricesRecorded` — the channel file's clears, deletes and record-only prices that will be applied.
 */
type Counts = { productsCreated: number; listingsCreated: number; changed: number; unchanged: number; refused: number; excluded: number; productsAffected: number; listingsAffected: number; newOverrides: number; preservedOverrides: number
  alreadyEmpty: number; clearUnchecked: number; cleared: number; ended: number; pricesRecorded: number }
const emptyCounts = (): Counts => ({ productsCreated: 0, listingsCreated: 0, changed: 0, unchanged: 0, refused: 0, excluded: 0, productsAffected: 0, listingsAffected: 0, newOverrides: 0, preservedOverrides: 0,
  alreadyEmpty: 0, clearUnchecked: 0, cleared: 0, ended: 0, pricesRecorded: 0 })
/** CFI-4 — an identity the file suggests that the Owner must confirm before its rows can apply. */
export interface TransferLinkProposal { fileSku: string; proposedSku: string; reason: string }
/** CFI-3 — a channel-file delete: confirmed (a presence row that will end the listing) or waiting for confirmation (an issue). */
/** `fileSku` is the SKU as the file writes it (the web ticks deletes by it; readers match only the file SKU); `sku` is the Nexus product. */
export interface TransferDeleteSummary { sku: string; fileSku: string; channel: string; marketplace: string; accountId: string; evidence?: string; confirmed: boolean }
/** CFI-8 (BUILD.md D7) — what the channel last reported for a listing cell, from `ChannelDrift`. */
export type ChannelRead = TransferChannelRead
interface JobPayload {
  outcomeVersion?: 1
  receipt?: { saved: number; unchanged: number; failed: number; excluded: number; unprocessed: number; skipped?: number }
  kind: typeof TRANSFER_JOB_KIND; mode: TransferMode; market: string; inputHash: string; previewExpiresAt: string
  mapping?: SourceMapping; source?: { presetId?: string; presetVersion?: string; scheduleId?: string; url?: string; autoApply?: boolean }
  /** A first copy of another business's shared products: its market is the OWNER's, so this business
   *  need not have it (a new business profile has no marketplace at all). See assortment/copy-run. */
  sharedCopy?: boolean
  counts: Counts; warnings: string[]; unmappedColumns: string[]; reviewToken?: string
  recoveryAttempts?: number
  boundary?: ProductTransferBoundary
  links?: TransferLinkProposal[]
  deletes?: TransferDeleteSummary[]
  /** CFI-7 (D6) — the Owner applied only the ready records of an INVALID review; the refused ones were skipped. */
  readyOnly?: boolean
}
/**
 * `ignoreParent` (PSIE) — compare this dependency WITHOUT its embedded parent. Set when the parent is saved by the same
 * job and is itself a dependency of the record: a changes-only import sends no record for an unchanged variant, and
 * that variant's snapshot embeds the parent the job just changed. The parent is still checked on its own.
 */
interface Dependency { sku: string; key?: string; before?: Record<string, unknown> | null; ignoreParent?: true }
const withoutParent = (snapshot: Record<string, unknown> | null) => snapshot ? (({ parent: _parent, ...rest }) => rest)(snapshot) : snapshot
interface RecordPayload {
  changed?: boolean
  rows: TransferRow[]; declaredParent?: boolean; target?: TransferTarget; dependencies?: Dependency[]
  sharedBefore?: Record<string, unknown> | null
  issues?: TransferIssue[]; exclusions?: SourceExclusion[]; preserved?: TransferCell[]
}
const payloadOf = (value: unknown) => (value as JobPayload)?.kind === TRANSFER_JOB_KIND ? value as JobPayload : null
export async function readTransferJob(id: string, userId: string | null) {
  const job = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const payload = payloadOf(job?.changes)
  return job && payload ? { job, payload } : null
}
export async function recentProductTransferJobs(productId: string, userId: string | null) {
  const jobs = await prisma.bulkOperation.findMany({ where: { userId, AND: [{ changes: { path: ['kind'], equals: TRANSFER_JOB_KIND } }, { changes: { path: ['boundary', 'productId'], equals: productId } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5, select: { id: true, uploadFilename: true, status: true } })
  return jobs.map(j => ({ id: j.id, filename: j.uploadFilename, state: j.status }))
}
export function transferJobStatus(loaded: NonNullable<Awaited<ReturnType<typeof readTransferJob>>>) {
  const { job, payload } = loaded
  return { jobId: job.id, state: job.status, processed: job.processed ?? 0, total: job.total ?? 0, mode: payload.mode,
    counts: payload.counts, receipt: payload.receipt, hasChangeFilter: payload.outcomeVersion === 1, warnings: payload.warnings, unmappedColumns: payload.unmappedColumns,
    policy: payload.mapping?.policy ?? { shared: 'replace', overrides: 'replace' }, source: payload.source,
    reviewToken: payload.reviewToken, expiresAt: payload.previewExpiresAt, filename: job.uploadFilename, boundary: payload.boundary,
    links: payload.links ?? [], deletes: payload.deletes ?? [], readyOnly: payload.readyOnly === true,
    error: Array.isArray(job.errors) ? (job.errors[0] as { message?: string })?.message : undefined,
    completedAt: job.completedAt?.toISOString() ?? null }
}

/** Input is bounded to 50k attribute outcomes. Heavy snapshots are kept in indexed 100-record pages. */
export async function stageTransferJob(input: {
  rows: TransferRow[]; issues: TransferIssue[]; exclusions?: SourceExclusion[]; unmappedColumns?: string[]
  warnings?: string[]
  mode: TransferMode; market: string; filename: string; userId: string | null; mapping?: SourceMapping
  source?: JobPayload['source']; parentJobId?: string; scheduleClaimVersion?: Date; boundary?: ProductTransferBoundary; sharedCopy?: boolean
  /** CFI-4 — identity proposals from a channel-file reader (ParsedInput.links), shown for confirmation. */
  links?: TransferLinkProposal[]
}) {
  if (input.boundary) {
    if (input.mode !== 'update') throw new Error('Product-editor imports update existing records only')
    assertProductTransferRows(input.boundary, input.rows)
    await checkProductTransferBoundary(input.boundary)
  }
  const limit = input.boundary ? 250_000 : 50_000
  if (input.rows.length + input.issues.length + (input.exclusions?.length ?? 0) > limit) throw new Error(`Import at most ${limit.toLocaleString()} attribute outcomes`)
  if (!input.rows.length && !input.issues.length && !input.exclusions?.length) throw new Error('The file contains no attribute actions')
  const groups = new Map<string, RecordPayload>()
  const declaredParents = new Set(input.rows.filter(r => r.entity === 'Products' && r.field === 'parentSku' && r.action === 'SET').map(r => String(r.value)))
  for (const row of input.rows) {
    const key = transferTargetKey(row)
    if (!groups.has(key)) groups.set(key, { rows: [], declaredParent: row.entity === 'Products' && declaredParents.has(row.sku) })
    groups.get(key)!.rows.push(row)
  }
  const productSkus = [...new Set(input.rows.filter(r => r.entity === 'Products').map(r => r.sku))]
  const existingVariants = new Set<string>()
  for (let offset = 0; offset < productSkus.length; offset += TRANSFER_BATCH) {
    const identities = await prisma.product.findMany({ where: { sku: { in: productSkus.slice(offset, offset + TRANSFER_BATCH) } }, select: { sku: true, parentId: true } })
    for (const product of identities) if (product.parentId) existingVariants.add(product.sku)
  }
  const records = [...groups.entries()].sort(([, a], [, b]) =>
    Number(a.rows[0].entity !== 'Products') - Number(b.rows[0].entity !== 'Products') || Number(existingVariants.has(a.rows[0].sku) || a.rows.some(r => r.field === 'parentSku' && r.action === 'SET')) - Number(existingVariants.has(b.rows[0].sku) || b.rows.some(r => r.field === 'parentSku' && r.action === 'SET')))
  // Exclusions and malformed rows also have durable, individually pageable outcomes.
  for (const issue of input.issues) records.push([`issue:${records.length}`, { rows: [], issues: [issue] }])
  for (const exclusion of input.exclusions ?? []) records.push([`excluded:${records.length}`, { rows: [], exclusions: [exclusion] }])
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000)
  // CFI-3 — every channel-file delete the review must show: confirmed presence rows, and the readers' unconfirmed ones (issues on `presence`).
  const deletes: TransferDeleteSummary[] = [
    ...input.rows.filter(r => r.origin === 'channel-file' && r.entity === 'Listings' && r.field === 'presence' && r.action === 'SET')
      .map(r => ({ sku: r.sku, fileSku: r.fileSku ?? r.sku, channel: r.channel, marketplace: r.marketplace, accountId: r.accountId, confirmed: true })),
    ...input.issues.filter(i => i.field === 'presence').map(i => {
      const at = i as TransferIssue & Partial<Pick<TransferRow, 'channel' | 'marketplace' | 'accountId' | 'fileSku'>>
      return { sku: i.sku, fileSku: at.fileSku ?? i.sku, channel: at.channel ?? '', marketplace: at.marketplace ?? '', accountId: at.accountId ?? '', evidence: i.message, confirmed: false }
    }),
  ]
  const payload: JobPayload = { kind: TRANSFER_JOB_KIND, outcomeVersion: 1, mode: input.mode, market: input.market, mapping: input.mapping, source: input.source, sharedCopy: input.sharedCopy,
    boundary: input.boundary, inputHash: fingerprint([input.rows, input.issues, input.exclusions, input.mapping, input.source, input.boundary]), previewExpiresAt: expiresAt.toISOString(), counts: emptyCounts(), warnings: input.warnings ?? [], unmappedColumns: input.unmappedColumns ?? [],
    ...(input.links?.length ? { links: input.links } : {}), ...(deletes.length ? { deletes } : {}) }
  const job = await prisma.$transaction(async tx => {
    const history = await tx.importJob.create({ data: { jobName: input.filename, source: input.source?.url ? 'url' : 'upload', sourceUrl: input.source?.url, filename: input.filename,
      fileKind: input.filename.split('.').pop() ?? 'csv', targetEntity: TRANSFER_JOB_KIND, columnMapping: json(input.mapping ?? {}),
      status: 'STAGING', totalRows: records.length, createdBy: input.userId, scheduleId: input.source?.scheduleId, parentJobId: input.parentJobId } })
    if (input.scheduleClaimVersion && input.source?.scheduleId) {
      const receipt = await tx.scheduledImport.updateMany({ where: { id: input.source.scheduleId, enabled: true, updatedAt: input.scheduleClaimVersion, lastStatus: 'FETCHING' }, data: { lastJobId: history.id } })
      if (!receipt.count) throw new TransferConflict('Schedule already claimed or changed')
    }
    return tx.bulkOperation.create({ data: { id: history.id, userId: input.userId, productCount: new Set(input.rows.map(r => r.sku)).size, changeCount: 0,
      status: 'STAGING', changes: json(payload), processed: 0, total: records.length, uploadFilename: input.filename, expiresAt: new Date(Date.now() + LEASE_MS) } })
  })
  // STAGING is never runnable. An interrupted upload cannot expose a partial review as complete.
  for (let offset = 0; offset < records.length; offset += TRANSFER_BATCH) {
    await prisma.importJobRow.createMany({ data: records.slice(offset, offset + TRANSFER_BATCH).map(([key, record], i) => ({ jobId: job.id, rowIndex: offset + i + 1, targetId: key, parsedValues: json(record), status: 'PENDING' })) })
    const renewed = await prisma.bulkOperation.updateMany({ where: { id: job.id, status: 'STAGING' }, data: { expiresAt: new Date(Date.now() + LEASE_MS) } })
    if (!renewed.count) throw new TransferConflict('Staging expired; upload the complete source again')
  }
  await prisma.$transaction(async tx => {
    const claim = await tx.bulkOperation.updateMany({ where: { id: job.id, status: 'STAGING' }, data: { status: 'PREVIEWING', expiresAt: new Date(Date.now() + LEASE_MS) } })
    if (!claim.count) throw new TransferConflict('Staging expired; upload the complete source again')
    await tx.importJob.update({ where: { id: job.id }, data: { status: 'PREVIEWING' } })
  })
  void runTransferJob(job.id).catch(() => { /* lease recovery retries unfinished chunks */ })
  return { ...transferJobStatus({ job, payload }), state: 'PREVIEWING' }
}

const running = new Set<string>()
export async function runTransferJob(id: string) {
  if (running.has(id)) return
  running.add(id)
  let autoApply: { userId: string | null; token: string } | undefined
  let declaredProductSkus: Set<string> | undefined
  try {
    const job = await prisma.bulkOperation.findUnique({ where: { id } }), payload = payloadOf(job?.changes)
    if (!job || !payload || !['PREVIEWING', 'RUNNING'].includes(job.status)) return
    let processed = job.processed ?? 0
    while (processed < (job.total ?? 0)) {
      const batch = await prisma.importJobRow.findMany({ where: { jobId: id, rowIndex: { gt: processed } }, orderBy: { rowIndex: 'asc' }, take: TRANSFER_BATCH })
      if (!batch.length) throw new Error('Import staging is incomplete')
      clearSheetColumnCache(); clearFieldCatalogueCache()
      const contracts = transferContracts(payload.market, { allowUnknownMarket: payload.sharedCopy === true })
      // Choices are fresh for this preview/apply batch, shared across its records.
      contracts.reference = createReferenceResolver()
      if (job.status === 'PREVIEWING') {
        const rows = batch.flatMap(r => (r.parsedValues as unknown as RecordPayload).rows)
        if (payload.boundary) await checkProductTransferBoundary(payload.boundary, rows)
        const parentSkus = new Set(rows.filter(r => r.field === 'parentSku' && r.action === 'SET').map(r => String(r.value)))
        const relatedKeys = [...new Set([...parentSkus, ...rows.filter(r => r.entity !== 'Products').map(r => r.sku)].map(productKey))]
        const declarations = relatedKeys.length ? await prisma.importJobRow.findMany({ where: { jobId: id, targetId: { in: relatedKeys } }, take: 2 * TRANSFER_BATCH }) : []
        const supplement = declarations.filter(d => !batch.some(b => b.id === d.id)).flatMap(d => (d.parsedValues as unknown as RecordPayload).rows)
        const context = rows.length ? await loadTransferContext([...rows, ...supplement]) : null
        // Existing parent relationships can cross preview pages even when parentSku is omitted.
        const dependencyKeys = context ? [...new Set([...context.products.values()].filter(p => p.parentId).map(p => [...context.products.values()].find(parent => parent.id === p.parentId)?.sku).filter((sku): sku is string => !!sku).map(productKey))].filter(key => !declarations.some(d => d.targetId === key) && !batch.some(b => b.targetId === key)) : []
        if (dependencyKeys.length) declarations.push(...await prisma.importJobRow.findMany({ where: { jobId: id, targetId: { in: dependencyKeys } }, take: TRANSFER_BATCH }))
        const plan = context ? await buildTransferPlan([...rows, ...supplement], payload.mode, context, contracts, payload.mapping?.policy, { sharedCopy: payload.sharedCopy === true }) : { targets: [], issues: [], warnings: [], exclusions: [] }
        if (context && payload.boundary) await enrichTransferEffects(id, plan, context, contracts, payload.market)
        await attachChannelReads(plan.targets.filter(t => batch.some(b => b.targetId === t.key)))
        const preserved = await preservedTransferOverrides(id, plan.targets.filter(t => batch.some(b => b.targetId === t.key)), contracts)
        const nextCounts = { ...emptyCounts(), ...payload.counts }
        nextCounts.alreadyEmpty += plan.stats?.alreadyEmpty ?? 0
        nextCounts.clearUnchecked += plan.stats?.clearUnchecked ?? 0
        const updates: { id: string; record: RecordPayload; status: string }[] = []
        for (const item of batch) {
          const record = item.parsedValues as unknown as RecordPayload
          const target = plan.targets.find(t => t.key === item.targetId)
          if (target?.create && target.identity.entity === 'Products' && record.declaredParent) target.patch.isParent = true
          const sourceKey = (r: TransferIssue | TransferRow) => JSON.stringify([r.row, r.sku, r.field, r.source?.file, r.source?.sheet])
          const sourceLines = new Set(record.rows.map(sourceKey))
          const issues = [...(record.issues ?? []), ...plan.issues.filter(i => sourceLines.has(sourceKey(i))) ]
          if (payload.boundary && target?.cells.some(c => c.field === 'parentSku' && c.verdict === 'changed')) issues.push({ ...target.identity, field: 'parentSku', message: 'Change parent relationships in the product relationship tools, then export a new workbook.' })
          const exclusions = [...(record.exclusions ?? []), ...(plan.exclusions ?? []).filter(i => sourceLines.has(sourceKey(i))) ]
          if (!target && record.rows.length && !issues.length && !exclusions.length) issues.push({ ...record.rows[0], message: 'This destination could not be planned' })
          nextCounts.refused += issues.length; nextCounts.excluded += exclusions.length
          if (target) {
            const shared = target.identity.entity === 'Products', changed = target.create || target.cells.some(c => c.verdict === 'changed')
            if (target.create) nextCounts[shared ? 'productsCreated' : 'listingsCreated']++
            if (changed) nextCounts[shared ? 'productsAffected' : 'listingsAffected']++
            for (const cell of target.cells) {
              nextCounts[cell.verdict]++
              if (!shared && cell.entity === 'Overrides' && cell.beforeState === 'inherited' && cell.afterState === 'stored' && cell.verdict === 'changed') nextCounts.newOverrides++
              if (!shared && cell.entity === 'Overrides' && cell.beforeState === 'stored' && cell.verdict === 'unchanged') nextCounts.preservedOverrides++
              if (cell.verdict === 'changed' && cell.origin === 'channel-file') {
                if (cell.clearIfPresent) nextCounts.cleared++
                if (cell.entity === 'Listings' && cell.field === 'presence') nextCounts.ended++
                if (cell.entity === 'Overrides' && (cell.field === 'price' || cell.field === 'sale')) nextCounts.pricesRecorded++
              }
            }
          }
          nextCounts.preservedOverrides += exclusions.filter(e => e.identity?.entity === 'Overrides').length
          const preservedCells = target?.identity.entity === 'Products' ? preserved.get(target.identity.sku) ?? [] : []
          nextCounts.preservedOverrides += preservedCells.length
          const dependencies: Dependency[] = []
          if (target && context) {
            const product = context.products.get(target.identity.sku)
            const parent = [...context.products.values()].find(p => p.id === product?.parentId)
            for (const sku of [...new Set([...(target.identity.entity !== 'Products' ? [target.identity.sku] : []), ...(parent ? [parent.sku] : [])])]) {
              const key = productKey(sku)
              const hasDeclaration = batch.some(b => b.targetId === key) || declarations.some(d => d.targetId === key)
              dependencies.push(hasDeclaration ? { sku, key } : { sku, before: context.products.get(sku) ?? null })
            }
          }
          const sharedBefore = !target && record.rows[0]?.entity === 'Products' ? context?.products.get(record.rows[0].sku) ?? null : undefined
          updates.push({ id: item.id, record: { ...record, changed: !!target && (target.create || target.cells.some(c => c.verdict === 'changed')), target, issues, exclusions, dependencies, preserved: preservedCells, sharedBefore }, status: issues.length ? 'INVALID' : target ? 'REVIEWED' : 'EXCLUDED' })
        }
        const next = { ...payload, counts: nextCounts, warnings: [...new Set([...payload.warnings, ...plan.warnings])] }
        const advanced = await prisma.$transaction(async tx => {
          const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'PREVIEWING', processed }, data: { processed: batch[batch.length - 1].rowIndex, changes: json(next), expiresAt: new Date(Date.now() + LEASE_MS) } })
          if (!claim.count) return false
          for (const update of updates) await tx.importJobRow.update({ where: { id: update.id }, data: { parsedValues: json(update.record), status: update.status } })
          return true
        }, { timeout: 30_000 })
        if (!advanced) return
        Object.assign(payload, next)
        processed = batch[batch.length - 1].rowIndex
      } else {
        declaredProductSkus ??= await jobProductSkus(id)
        const referenceRows = batch.flatMap(item => (item.parsedValues as unknown as RecordPayload).rows)
        const reference = referenceRows.length ? await loadTransferContext(referenceRows) : undefined
        for (const item of batch) {
          const record = item.parsedValues as unknown as RecordPayload
          // CFI-7 (D6) — a ready-only apply skips every record the review refused; its status and issues stay as reviewed.
          if (item.status === 'INVALID') {
            const skipped = await prisma.bulkOperation.updateMany({ where: { id, status: 'RUNNING', processed }, data: { processed: item.rowIndex, expiresAt: new Date(Date.now() + LEASE_MS) } })
            if (!skipped.count) return
            processed = item.rowIndex
            continue
          }
          try {
            await retryWriteConflicts(() => inDatabaseTransaction(prisma, async () => {
              const tx = prisma
              const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'RUNNING', processed }, data: { processed: item.rowIndex, expiresAt: new Date(Date.now() + LEASE_MS) } })
              if (!claim.count) throw new TransferConflict('Job checkpoint already advanced')
              await applyTransferRecord({ jobId: id, item, boundary: payload.boundary, mode: payload.boundary ? 'update' : 'upsert', policy: payload.mapping?.policy, sharedCopy: payload.sharedCopy === true,
                contracts, reference, declaredProductSkus, userId: job.userId })
            }))
          } catch (error) {
            // Infrastructure failures leave the checkpoint untouched for lease recovery.
            if (transientFailure(error)) throw error
            const message = error instanceof Error ? error.message : String(error)
            const advanced = await prisma.$transaction(async tx => {
              const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'RUNNING', processed }, data: { processed: item.rowIndex, expiresAt: new Date(Date.now() + LEASE_MS) } })
              if (!claim.count) return false
              await tx.importJobRow.update({ where: { id: item.id }, data: { status: 'FAILED', errorMessage: message, completedAt: new Date() } })
              return true
            })
            if (!advanced) return
          }
          processed = item.rowIndex
        }
      }
    }
    if (job.status === 'PREVIEWING') {
      const status = payload.counts.refused ? 'INVALID' : 'QUEUED'
      payload.reviewToken = fingerprint([id, payload.inputHash, payload.previewExpiresAt, payload.counts])
      await prisma.$transaction(async tx => {
        const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'PREVIEWING', processed }, data: { status, changes: json(payload), expiresAt: new Date(payload.previewExpiresAt), processed: 0 } })
        if (claim.count) await tx.importJob.update({ where: { id }, data: { status, planToken: payload.reviewToken, planComputedAt: new Date(), planSummary: json(payload.counts) } })
      })
      if (status === 'QUEUED' && payload.source?.autoApply) autoApply = { userId: job.userId, token: payload.reviewToken }
    } else {
      const failed = await prisma.importJobRow.count({ where: { jobId: id, status: 'FAILED' } })
      const success = await prisma.importJobRow.count({ where: { jobId: id, status: 'SUCCESS' } })
      // CFI-7 — records a ready-only apply skipped keep their INVALID review status; the job did not apply everything.
      const skipped = payload.readyOnly ? await prisma.importJobRow.count({ where: { jobId: id, status: 'INVALID' } }) : 0
      const status = failed || skipped ? 'PARTIAL' : 'COMPLETED'
      if (payload.outcomeVersion === 1) payload.receipt = await transferReceipt(id, job.total ?? 0)
      await prisma.$transaction(async tx => {
        const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'RUNNING', processed }, data: { status, changes: json(payload), completedAt: new Date(), expiresAt: null } })
        if (claim.count) await tx.importJob.update({ where: { id }, data: { status, successRows: success, failedRows: failed, skippedRows: (job.total ?? 0) - success - failed, completedAt: new Date() } })
      })
    }
  } catch (error) {
    if (transientFailure(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    const recordFailure = async () => {
      const stopped = await prisma.bulkOperation.findUnique({ where: { id } })
      const stoppedPayload = payloadOf(stopped?.changes)
      if (stoppedPayload?.outcomeVersion === 1) stoppedPayload.receipt = await transferReceipt(id, stopped?.total ?? 0)
      await prisma.$transaction(async tx => {
        await tx.bulkOperation.updateMany({ where: { id, status: { in: ['PREVIEWING', 'RUNNING'] } }, data: { status: 'FAILED', ...(stoppedPayload ? { changes: json(stoppedPayload) } : {}), completedAt: new Date(), expiresAt: null, errors: [{ message }] } })
        await tx.importJob.updateMany({ where: { id }, data: { status: 'FAILED', errorSummary: message, completedAt: new Date() } })
      })
    }
    // The job runs as the signed-in user, and the row policy requires an ACTIVE member. A user who lost access mid-job
    // failed the job's last statement, and would fail this write too — the job stuck in PREVIEWING/RUNNING forever. The
    // failure is recorded under the job's own business with no actor; the job itself still ran as the user.
    const context = workspaceContext()
    await (context ? withWorkspace({ workspaceId: context.workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, recordFailure) : recordFailure())
  } finally { running.delete(id) }
  if (autoApply) {
    try { await applyTransferJob(id, autoApply.userId, autoApply.token) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await prisma.$transaction(async tx => {
        const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'INVALID', errors: [{ message }] } })
        if (claim.count) await tx.importJob.updateMany({ where: { id }, data: { status: 'INVALID', errorSummary: message } })
      })
    }
  }
}
/**
 * One reviewed record, saved inside the CALLER's transaction: dependencies checked, the record re-planned and compared
 * with the review, the target written, its checkpoint row marked. Shared by the catalog runner (one transaction per
 * record) and the product sheet's import (PSIE: many records per transaction). `options` reach `applyTransferTarget`.
 */
export async function applyTransferRecord(input: {
  jobId: string; item: { id: string; parsedValues: unknown }; boundary?: ProductTransferBoundary; mode: TransferMode; policy?: SourceMapping['policy']; sharedCopy: boolean
  contracts: ReturnType<typeof transferContracts>; reference?: Awaited<ReturnType<typeof loadTransferContext>>; declaredProductSkus: ReadonlySet<string>; userId: string | null
  options?: Parameters<typeof applyTransferTarget>[4]
}) {
  const { jobId: id, item, contracts, reference, declaredProductSkus } = input
  const record = item.parsedValues as unknown as RecordPayload
  const tx = prisma
  const target = record.target
  if (input.boundary) await checkProductTransferBoundary(input.boundary, record.rows, tx)
  if (target) {
    // Read dependent shared/parent records in the same serializable transaction.
    for (const dependency of record.dependencies ?? []) {
      let expected = dependency.before
      if (dependency.key) {
        const prior = await tx.importJobRow.findFirst({ where: { jobId: id, targetId: dependency.key, status: { in: ['SUCCESS', 'EXCLUDED'] } }, select: { afterState: true } })
        if (!prior?.afterState) throw new TransferConflict('A required shared/parent update did not complete')
        expected = prior.afterState as Record<string, unknown>
      }
      const current = await tx.product.findUnique({ where: { workspace_sku: workspaceKey({ sku: dependency.sku }) }, include: { translations: true, parent: { include: { translations: true } }, categories: { select: { categoryId: true, isPrimary: true } } } })
      const compare = dependency.ignoreParent ? withoutParent : (value: Record<string, unknown> | null) => value
      if (fingerprint(compare(safeSnapshot(current))) !== fingerprint(compare(expected ?? null))) throw new TransferConflict('Shared or parent data changed since preview')
    }
    const context = await loadTransferContext(target.rows, tx as typeof prisma, reference)
    // LX.F2 R-LX-21 — see `buildTransferPlan`'s `revalidateDeclaredVersion`.
    const check = await buildTransferPlan(target.rows, input.mode, context, contracts, input.policy, { revalidateDeclaredVersion: false, declaredProductSkus, sharedCopy: input.sharedCopy })
    const current = check.targets[0]
    if (current?.create && current.identity.entity === 'Products' && record.declaredParent) current.patch.isParent = true
    if (!current || check.issues.length || current.contractHash !== target.contractHash || targetWriteFingerprint(current) !== targetWriteFingerprint(target)) throw new TransferConflict(check.issues[0]?.message ?? 'Catalog inputs or ownership changed since preview; review this record again')
    // A parent saved earlier in this same run is an authorized dependency.
    // Compare the child's own snapshot unchanged, with that verified parent
    // projection; otherwise its newly hydrated parent would look like a race.
    const owner = context.products.get(target.identity.sku)
    const parentVerified = target.identity.entity === 'Products' && target.before?.parentId && record.dependencies?.some(dependency => context.products.get(dependency.sku)?.id === target.before!.parentId)
    const applying = parentVerified ? { ...target, before: { ...target.before!, parent: owner?.parent ?? null } } : target
    if (target.create || target.cells.some(c => c.verdict === 'changed')) await applyTransferTarget(tx, applying, id, input.userId, input.options)
  }
  const sharedSku = target?.identity.entity === 'Products' ? target.identity.sku : record.rows[0]?.entity === 'Products' ? record.rows[0].sku : null
  const after = sharedSku ? await tx.product.findUnique({ where: { workspace_sku: workspaceKey({ sku: sharedSku }) }, include: { translations: true, parent: { include: { translations: true } }, categories: { select: { categoryId: true, isPrimary: true } } } }) : null
  if (!target && record.sharedBefore !== undefined && fingerprint(safeSnapshot(after)) !== fingerprint(record.sharedBefore)) throw new TransferConflict('Excluded shared data changed since preview; review its dependent updates again')
  await tx.importJobRow.update({ where: { id: item.id }, data: { status: target ? 'SUCCESS' : 'EXCLUDED', completedAt: new Date(), ...(after ? { afterState: json(safeSnapshot(after)) } : {}) } })
}

/** R-AE-17 — every shared product this job declares, whatever its outcome (see `buildTransferPlan`). */
async function jobProductSkus(jobId: string) {
  const skus = new Set<string>()
  for (const { targetId } of await prisma.importJobRow.findMany({ where: { jobId }, select: { targetId: true } })) {
    try {
      const key = JSON.parse(targetId ?? '')
      if (Array.isArray(key) && key[0] === 'Products' && typeof key[1] === 'string') skus.add(key[1])
    } catch { /* a record without a destination declares nothing */ }
  }
  return skus
}
async function transferReceipt(jobId: string, total: number) {
  const [saved, unchanged, failed, excluded, skipped] = await Promise.all([
    prisma.importJobRow.count({ where: { jobId, status: 'SUCCESS', parsedValues: { path: ['changed'], equals: true } } }),
    prisma.importJobRow.count({ where: { jobId, status: 'SUCCESS', parsedValues: { path: ['changed'], equals: false } } }),
    prisma.importJobRow.count({ where: { jobId, status: 'FAILED' } }),
    prisma.importJobRow.count({ where: { jobId, status: 'EXCLUDED' } }),
    // CFI-7 — refused records of a ready-only apply (0 otherwise: a QUEUED review holds none).
    prisma.importJobRow.count({ where: { jobId, status: 'INVALID' } }),
  ])
  // `skipped` only when a ready-only apply skipped something, so every existing receipt keeps its exact shape.
  return { saved, unchanged, failed, excluded, unprocessed: Math.max(0, total - saved - unchanged - failed - excluded - skipped), ...(skipped ? { skipped } : {}) }
}

/**
 * CFI-8 (BUILD.md D7) — attach to each listing cell what the channel last reported, from `ChannelDrift`: ONE query per
 * preview batch. Only differing fields are stored there, so a field with no entry says "no difference recorded at the
 * last compared read" — never "the channel holds this value", because a field Nexus does not send is not compared.
 * Keys: an Amazon attribute root (`material`), content `item_name[de_DE]`, eBay `title` / `aspect:<name>`.
 */
async function attachChannelReads(targets: TransferTarget[]) {
  const listings = targets.filter(t => t.identity.entity !== 'Products' && t.before?.id)
  if (!listings.length) return
  const drifts = await prisma.channelDrift.findMany({ where: { channelListingId: { in: listings.map(t => String(t.before!.id)) } }, select: { channelListingId: true, driftedFields: true, checkedBySource: true } })
  const byListing = new Map(drifts.map(d => [d.channelListingId, d]))
  for (const target of listings) {
    const drift = byListing.get(String(target.before!.id))
    if (!drift) continue
    const entries = (Array.isArray(drift.driftedFields) ? drift.driftedFields : []) as { field: string; ours: unknown; theirs: unknown; source: string; checkedAt: string }[]
    const clocks = Object.entries((drift.checkedBySource && typeof drift.checkedBySource === 'object' ? drift.checkedBySource : {}) as Record<string, { at?: string; outcome?: string }>)
      .filter(([, clock]) => clock?.outcome === 'compared' && typeof clock.at === 'string').sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
    for (const cell of target.cells) {
      const root = cell.field.split('__')[0]
      const hit = entries.find(e => e.field === cell.field || e.field === root || e.field.startsWith(`${root}[`) || e.field === `aspect:${cell.label ?? cell.field}`)
      // 🔴 "No difference recorded" is only true for a field the source COMPARES. The Amazon content read skips the RRP,
      // price, stock, images and parent links; the price report compares price only; the eBay read compares the title
      // (aspects only when they differ). Measured 2026-09-25: GALE DE's RRP read "Same as Nexus" although never compared.
      const comparing = clocks.find(([source]) => sourceCompares(source, cell))
      const read: ChannelRead | null = hit ? { differs: true, value: hit.theirs, ours: hit.ours, readAt: hit.checkedAt, source: hit.source }
        : comparing ? { differs: false, readAt: String(comparing[1].at), source: comparing[0] }
        : clocks.length ? { notCompared: true, readAt: String(clocks[0][1].at) } : null
      if (read) cell.channelRead = read
    }
  }
}
/** Does this read source compare this review cell? (See `attachChannelReads`.) */
export function sourceCompares(source: string, cell: Pick<TransferCell, 'entity' | 'field'>): boolean {
  if (cell.entity !== 'Overrides') return false // productType, presence, sellerSku: no read compares them
  const root = cell.field.split('__')[0]
  if (cell.field === 'price') return source === 'amazon-merchant-listings-report'
  if (cell.field === 'sale') return false
  if (source === 'amazon-content') return !STRUCTURE_ROOTS.has(root) && !AMAZON_OUT_OF_SCOPE_ROOTS.has(root) && !/image_locator/.test(root)
  if (source === 'ebay-content') return cell.field === 'title'
  return false
}
function transientFailure(error: unknown) {
  const code = (error as { code?: string })?.code ?? ''
  return code.startsWith('P1') || ['P2034', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code) || writeConflict(error)
}
/**
 * 🔴 Production 2026-09-25 (GALE DE/FR/ES applied at once, all touching GALE-JACKET): a serializable write conflict raised
 * inside a record's transaction was caught by a helper, and the NEXT statement failed with 25P02 "current transaction is
 * aborted" — not P2034 — so the record was marked FAILED although nothing had been written (the transaction rolled back).
 * Both shapes mean "run this record again".
 */
export function writeConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return (error as { code?: string })?.code === 'P2034' || /\b25P02\b|current transaction is aborted|write conflict or a deadlock|could not serialize access/i.test(message)
}
/** Run a record transaction again on a write conflict (it rolled back), up to three times; then the lease recovery resumes it. */
export async function retryWriteConflicts<T>(work: () => Promise<T>, attempts = 3, pause = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await work() }
    catch (error) {
      if (attempt >= attempts || !writeConflict(error)) throw error
      await pause(150 * attempt + Math.floor(Math.random() * 100))
    }
  }
}

/**
 * CFI-7 (D6) — `readyOnly: true` also accepts an INVALID review: its refused records are skipped (their status stays
 * INVALID, counted `skipped` in the receipt) and the ready ones apply as usual. Without it an INVALID review still refuses.
 */
export async function applyTransferJob(id: string, userId: string | null, reviewToken: string, options: { readyOnly?: boolean } = {}) {
  const loaded = await readTransferJob(id, userId)
  if (!loaded) return null
  if (!reviewToken || loaded.payload.reviewToken !== reviewToken) throw new TransferConflict('Supply the token from the completed review')
  if (['RUNNING', 'COMPLETED', 'PARTIAL'].includes(loaded.job.status)) return transferJobStatus(loaded)
  const readyOnly = options.readyOnly === true && loaded.job.status === 'INVALID'
  if (!(loaded.job.status === 'QUEUED' || readyOnly) || Date.parse(loaded.payload.previewExpiresAt) <= Date.now()) throw new TransferConflict('This review is invalid or expired; preview the source again')
  if (readyOnly && !await prisma.importJobRow.count({ where: { jobId: id, status: 'REVIEWED' } })) throw new TransferConflict('Nothing in this review is ready to apply. Correct the refused rows and preview the file again.')
  if (loaded.payload.boundary) await checkProductTransferBoundary(loaded.payload.boundary)
  if (loaded.payload.source?.presetId) {
    const preset = await prisma.scheduledImport.findFirst({ where: { id: loaded.payload.source.presetId, createdBy: userId } })
    if (!preset || fingerprint([preset.columnMapping, preset.sourceUrl]) !== loaded.payload.source.presetVersion) throw new TransferConflict('Source mapping or policy changed since preview')
  }
  const claimed = await prisma.bulkOperation.updateMany({ where: { id, userId, status: loaded.job.status, expiresAt: { gt: new Date() } }, data: { status: 'RUNNING', processed: 0, expiresAt: new Date(Date.now() + LEASE_MS),
    ...(readyOnly ? { changes: json({ ...loaded.payload, readyOnly: true }) } : {}) } })
  if (claimed.count) void runTransferJob(id).catch(() => {})
  return { ...transferJobStatus(loaded), state: 'RUNNING', processed: 0 }
}

export async function transferJobOutcomes(id: string, userId: string | null, page = 1, status?: string, scope?: { sku?: string; destination?: string }) {
  if (!await readTransferJob(id, userId)) return null
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Use a positive page number')
  if (status && !['CHANGED', 'UNCHANGED', 'REVIEWED', 'INVALID', 'EXCLUDED', 'SUCCESS', 'FAILED'].includes(status)) throw new Error('Unknown outcome filter')
  const identityFilter = (field: string, value: string) => ({ OR: [['target', 'identity', field], ['rows', '0', field], ['issues', '0', field], ['exclusions', '0', 'identity', field]].map(path => ({ parsedValues: { path, equals: value } })) })
  const filters: ReturnType<typeof identityFilter>[] = []
  if (scope?.sku) filters.push(identityFilter('sku', scope.sku))
  if (scope?.destination) {
    let destination: unknown
    try { destination = JSON.parse(scope.destination) } catch { throw new Error('Choose a valid destination filter') }
    if (!Array.isArray(destination) || destination.length !== 4 || destination.some(v => typeof v !== 'string')) throw new Error('Choose a valid destination filter')
    for (const [i, field] of ['channel', 'accountId', 'marketplace', 'aliasKey'].entries()) filters.push(identityFilter(field, destination[i]))
  }
  const where = { jobId: id, ...(filters.length ? { AND: filters } : {}), ...(['CHANGED', 'UNCHANGED'].includes(status ?? '') ? { status: { in: ['REVIEWED', 'SUCCESS', 'FAILED'] }, parsedValues: { path: ['changed'], equals: status === 'CHANGED' } } : status ? { status } : {}) }
  const [total, rows] = await Promise.all([prisma.importJobRow.count({ where }), prisma.importJobRow.findMany({ where, orderBy: { rowIndex: 'asc' }, take: 50, skip: (page - 1) * 50 })])
  return { total, page, pageSize: 50, rows: rows.map(row => {
    const record = row.parsedValues as unknown as RecordPayload
    return { id: row.id, index: row.rowIndex, status: row.status, identity: record.target?.identity ?? record.rows[0] ?? record.exclusions?.[0]?.identity,
      cells: record.target?.cells ?? [], preserved: record.preserved ?? [], issues: record.issues ?? [], exclusions: record.exclusions ?? [], error: row.errorMessage }
  }) }
}

export async function retryTransferJob(id: string, userId: string | null) {
  const loaded = await readTransferJob(id, userId)
  if (!loaded) return null
  if (!['PARTIAL', 'FAILED'].includes(loaded.job.status)) throw new TransferConflict('Only a finished import with refused records can be reviewed for retry')
  if (await prisma.importJobRow.count({ where: { jobId: id } }) !== loaded.job.total) throw new TransferConflict('Source staging was interrupted. Upload the complete source again; a partial file cannot be retried.')
  const rows: TransferRow[] = []
  let cursor = 0
  while (true) {
    const page = await prisma.importJobRow.findMany({ where: { jobId: id, status: loaded.job.status === 'FAILED' ? { in: ['FAILED', 'REVIEWED', 'PENDING'] } : 'FAILED', rowIndex: { gt: cursor } }, orderBy: { rowIndex: 'asc' }, take: TRANSFER_BATCH })
    if (!page.length) break
    for (const item of page) rows.push(...(item.parsedValues as unknown as RecordPayload).rows.map(r => ({ ...r, version: undefined })))
    cursor = page[page.length - 1].rowIndex
  }
  return stageTransferJob({ rows, issues: [], mode: loaded.payload.boundary ? 'update' : 'upsert', boundary: loaded.payload.boundary, market: loaded.payload.market, mapping: loaded.payload.mapping,
    source: { ...loaded.payload.source, autoApply: false }, filename: loaded.job.uploadFilename ?? 'Retry', userId, parentJobId: id })
}

export async function recoverTransferJobs() {
  const staging = await prisma.bulkOperation.findMany({ where: { status: 'STAGING', expiresAt: { lt: new Date() }, changes: { path: ['kind'], equals: TRANSFER_JOB_KIND } }, select: { id: true, total: true }, take: 2 })
  for (const job of staging) {
    const complete = await prisma.importJobRow.count({ where: { jobId: job.id } }) === job.total
    const status = complete ? 'PREVIEWING' : 'FAILED'
    const message = 'Source staging was interrupted. Upload the complete source again.'
    const recovered = await prisma.$transaction(async tx => {
      const claim = await tx.bulkOperation.updateMany({ where: { id: job.id, status: 'STAGING', expiresAt: { lt: new Date() } }, data: { status, expiresAt: complete ? new Date(Date.now() + LEASE_MS) : null, ...(!complete ? { errors: [{ message }], completedAt: new Date() } : {}) } })
      if (claim.count) await tx.importJob.updateMany({ where: { id: job.id }, data: { status, ...(!complete ? { errorSummary: message, completedAt: new Date() } : {}) } })
      return !!claim.count
    })
    if (complete && recovered) void runTransferJob(job.id).catch(() => {})
  }
  const jobs = await prisma.bulkOperation.findMany({ where: { status: { in: ['PREVIEWING', 'RUNNING'] }, expiresAt: { lt: new Date() }, changes: { path: ['kind'], equals: TRANSFER_JOB_KIND } }, select: { id: true, changes: true, total: true }, take: 2 })
  for (const job of jobs) {
    const payload = payloadOf(job.changes)!
    const attempts = (payload.recoveryAttempts ?? 0) + 1
    if (attempts > 5) {
      const message = 'Import recovery failed five times. Review the unprocessed records before retrying.'
      if (payload.outcomeVersion === 1) payload.receipt = await transferReceipt(job.id, job.total ?? 0)
      await prisma.$transaction(async tx => {
        const claim = await tx.bulkOperation.updateMany({ where: { id: job.id, status: { in: ['PREVIEWING', 'RUNNING'] }, expiresAt: { lt: new Date() } }, data: { status: 'FAILED', changes: json(payload), errors: [{ message }], completedAt: new Date(), expiresAt: null } })
        if (claim.count) await tx.importJob.updateMany({ where: { id: job.id }, data: { status: 'FAILED', errorSummary: message, completedAt: new Date() } })
      })
      continue
    }
    const claim = await prisma.bulkOperation.updateMany({ where: { id: job.id, expiresAt: { lt: new Date() }, status: { in: ['PREVIEWING', 'RUNNING'] } }, data: { expiresAt: new Date(Date.now() + LEASE_MS), changes: json({ ...payload, recoveryAttempts: attempts }) } })
    if (claim.count) void runTransferJob(job.id).catch(() => {})
  }
}
