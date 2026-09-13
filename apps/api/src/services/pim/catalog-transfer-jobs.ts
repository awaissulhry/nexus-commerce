import { inDatabaseTransaction } from '../../lib/database-context.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { Prisma } from '@prisma/client'
import type { TransferRow, TransferIssue, TransferMode, TransferCell, ProductTransferBoundary } from '@nexus/shared/catalog-transfer'
import { transferTargetKey } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { buildTransferPlan, fingerprint, transferContracts, type TransferTarget } from './catalog-transfer-plan.js'
import { applyTransferTarget, loadTransferContext, safeSnapshot, TransferConflict } from './catalog-transfer.service.js'
import type { SourceMapping, SourceExclusion } from './catalog-source-mapping.js'
import { clearSheetColumnCache } from './sheet-columns.service.js'
import { clearFieldCatalogueCache } from './mapping/field-catalogue.service.js'
import { preservedTransferOverrides } from './catalog-transfer-preserved.js'
import { createReferenceResolver } from './reference-values.service.js'
import { assertProductTransferRows, checkProductTransferBoundary } from './catalog-product-transfer.js'
import { enrichTransferEffects } from './catalog-transfer-effects.js'

export const TRANSFER_BATCH = 100
export const TRANSFER_JOB_KIND = 'catalog-transfer-v2'
const LEASE_MS = 60_000
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const productKey = (sku: string) => JSON.stringify(['Products', sku])
type Counts = { productsCreated: number; listingsCreated: number; changed: number; unchanged: number; refused: number; excluded: number; productsAffected: number; listingsAffected: number; newOverrides: number; preservedOverrides: number }
const emptyCounts = (): Counts => ({ productsCreated: 0, listingsCreated: 0, changed: 0, unchanged: 0, refused: 0, excluded: 0, productsAffected: 0, listingsAffected: 0, newOverrides: 0, preservedOverrides: 0 })
interface JobPayload {
  outcomeVersion?: 1
  receipt?: { saved: number; unchanged: number; failed: number; excluded: number; unprocessed: number }
  kind: typeof TRANSFER_JOB_KIND; mode: TransferMode; market: string; inputHash: string; previewExpiresAt: string
  mapping?: SourceMapping; source?: { presetId?: string; presetVersion?: string; scheduleId?: string; url?: string; autoApply?: boolean }
  counts: Counts; warnings: string[]; unmappedColumns: string[]; reviewToken?: string
  recoveryAttempts?: number
  boundary?: ProductTransferBoundary
}
interface Dependency { sku: string; key?: string; before?: Record<string, unknown> | null }
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
    error: Array.isArray(job.errors) ? (job.errors[0] as { message?: string })?.message : undefined,
    completedAt: job.completedAt?.toISOString() ?? null }
}

/** Input is bounded to 50k attribute outcomes. Heavy snapshots are kept in indexed 100-record pages. */
export async function stageTransferJob(input: {
  rows: TransferRow[]; issues: TransferIssue[]; exclusions?: SourceExclusion[]; unmappedColumns?: string[]
  warnings?: string[]
  mode: TransferMode; market: string; filename: string; userId: string | null; mapping?: SourceMapping
  source?: JobPayload['source']; parentJobId?: string; scheduleClaimVersion?: Date; boundary?: ProductTransferBoundary
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
  const payload: JobPayload = { kind: TRANSFER_JOB_KIND, outcomeVersion: 1, mode: input.mode, market: input.market, mapping: input.mapping, source: input.source,
    boundary: input.boundary, inputHash: fingerprint([input.rows, input.issues, input.exclusions, input.mapping, input.source, input.boundary]), previewExpiresAt: expiresAt.toISOString(), counts: emptyCounts(), warnings: input.warnings ?? [], unmappedColumns: input.unmappedColumns ?? [] }
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
  try {
    const job = await prisma.bulkOperation.findUnique({ where: { id } }), payload = payloadOf(job?.changes)
    if (!job || !payload || !['PREVIEWING', 'RUNNING'].includes(job.status)) return
    let processed = job.processed ?? 0
    while (processed < (job.total ?? 0)) {
      const batch = await prisma.importJobRow.findMany({ where: { jobId: id, rowIndex: { gt: processed } }, orderBy: { rowIndex: 'asc' }, take: TRANSFER_BATCH })
      if (!batch.length) throw new Error('Import staging is incomplete')
      clearSheetColumnCache(); clearFieldCatalogueCache()
      const contracts = transferContracts(payload.market)
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
        const plan = context ? await buildTransferPlan([...rows, ...supplement], payload.mode, context, contracts, payload.mapping?.policy) : { targets: [], issues: [], warnings: [], exclusions: [] }
        if (context && payload.boundary) await enrichTransferEffects(id, plan, context, contracts, payload.market)
        const preserved = await preservedTransferOverrides(id, plan.targets.filter(t => batch.some(b => b.targetId === t.key)), contracts)
        const nextCounts = { ...payload.counts }
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
        const referenceRows = batch.flatMap(item => (item.parsedValues as unknown as RecordPayload).rows)
        const reference = referenceRows.length ? await loadTransferContext(referenceRows) : undefined
        for (const item of batch) {
          const record = item.parsedValues as unknown as RecordPayload
          try {
            await inDatabaseTransaction(prisma, async () => {
              const tx = prisma
              const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'RUNNING', processed }, data: { processed: item.rowIndex, expiresAt: new Date(Date.now() + LEASE_MS) } })
              if (!claim.count) throw new TransferConflict('Job checkpoint already advanced')
              const target = record.target
              if (payload.boundary) await checkProductTransferBoundary(payload.boundary, record.rows, tx)
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
                  if (fingerprint(safeSnapshot(current)) !== fingerprint(expected)) throw new TransferConflict('Shared or parent data changed since preview')
                }
                const context = await loadTransferContext(target.rows, tx as typeof prisma, reference)
                // LX.F2 R-LX-21 — see `buildTransferPlan`'s `revalidateDeclaredVersion`.
                const check = await buildTransferPlan(target.rows, payload.boundary ? 'update' : 'upsert', context, contracts, payload.mapping?.policy, { revalidateDeclaredVersion: false })
                const current = check.targets[0]
                if (current?.create && current.identity.entity === 'Products' && record.declaredParent) current.patch.isParent = true
                if (!current || check.issues.length || current.contractHash !== target.contractHash || fingerprint([current.patch, current.contentWrites]) !== fingerprint([target.patch, target.contentWrites])) throw new TransferConflict(check.issues[0]?.message ?? 'Catalog inputs or ownership changed since preview; review this record again')
                // A parent saved earlier in this same run is an authorized dependency.
                // Compare the child's own snapshot unchanged, with that verified parent
                // projection; otherwise its newly hydrated parent would look like a race.
                const owner = context.products.get(target.identity.sku)
                const parentVerified = target.identity.entity === 'Products' && target.before?.parentId && record.dependencies?.some(dependency => context.products.get(dependency.sku)?.id === target.before!.parentId)
                const applying = parentVerified ? { ...target, before: { ...target.before!, parent: owner?.parent ?? null } } : target
                if (target.create || target.cells.some(c => c.verdict === 'changed')) await applyTransferTarget(tx, applying, id, job.userId)
              }
              const sharedSku = target?.identity.entity === 'Products' ? target.identity.sku : record.rows[0]?.entity === 'Products' ? record.rows[0].sku : null
              const after = sharedSku ? await tx.product.findUnique({ where: { workspace_sku: workspaceKey({ sku: sharedSku }) }, include: { translations: true, parent: { include: { translations: true } }, categories: { select: { categoryId: true, isPrimary: true } } } }) : null
              if (!target && record.sharedBefore !== undefined && fingerprint(safeSnapshot(after)) !== fingerprint(record.sharedBefore)) throw new TransferConflict('Excluded shared data changed since preview; review its dependent updates again')
              await tx.importJobRow.update({ where: { id: item.id }, data: { status: target ? 'SUCCESS' : 'EXCLUDED', completedAt: new Date(), ...(after ? { afterState: json(safeSnapshot(after)) } : {}) } })
            })
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
      const status = failed ? 'PARTIAL' : 'COMPLETED'
      if (payload.outcomeVersion === 1) payload.receipt = await transferReceipt(id, job.total ?? 0)
      await prisma.$transaction(async tx => {
        const claim = await tx.bulkOperation.updateMany({ where: { id, status: 'RUNNING', processed }, data: { status, changes: json(payload), completedAt: new Date(), expiresAt: null } })
        if (claim.count) await tx.importJob.update({ where: { id }, data: { status, successRows: success, failedRows: failed, skippedRows: (job.total ?? 0) - success - failed, completedAt: new Date() } })
      })
    }
  } catch (error) {
    if (transientFailure(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    const stopped = await prisma.bulkOperation.findUnique({ where: { id } })
    const stoppedPayload = payloadOf(stopped?.changes)
    if (stoppedPayload?.outcomeVersion === 1) stoppedPayload.receipt = await transferReceipt(id, stopped?.total ?? 0)
    await prisma.$transaction(async tx => {
      await tx.bulkOperation.updateMany({ where: { id, status: { in: ['PREVIEWING', 'RUNNING'] } }, data: { status: 'FAILED', ...(stoppedPayload ? { changes: json(stoppedPayload) } : {}), completedAt: new Date(), expiresAt: null, errors: [{ message }] } })
      await tx.importJob.updateMany({ where: { id }, data: { status: 'FAILED', errorSummary: message, completedAt: new Date() } })
    })
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
async function transferReceipt(jobId: string, total: number) {
  const [saved, unchanged, failed, excluded] = await Promise.all([
    prisma.importJobRow.count({ where: { jobId, status: 'SUCCESS', parsedValues: { path: ['changed'], equals: true } } }),
    prisma.importJobRow.count({ where: { jobId, status: 'SUCCESS', parsedValues: { path: ['changed'], equals: false } } }),
    prisma.importJobRow.count({ where: { jobId, status: 'FAILED' } }),
    prisma.importJobRow.count({ where: { jobId, status: 'EXCLUDED' } }),
  ])
  return { saved, unchanged, failed, excluded, unprocessed: Math.max(0, total - saved - unchanged - failed - excluded) }
}
function transientFailure(error: unknown) {
  const code = (error as { code?: string })?.code ?? ''
  return code.startsWith('P1') || ['P2034', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code)
}

export async function applyTransferJob(id: string, userId: string | null, reviewToken: string) {
  const loaded = await readTransferJob(id, userId)
  if (!loaded) return null
  if (!reviewToken || loaded.payload.reviewToken !== reviewToken) throw new TransferConflict('Supply the token from the completed review')
  if (['RUNNING', 'COMPLETED', 'PARTIAL'].includes(loaded.job.status)) return transferJobStatus(loaded)
  if (loaded.job.status !== 'QUEUED' || Date.parse(loaded.payload.previewExpiresAt) <= Date.now()) throw new TransferConflict('This review is invalid or expired; preview the source again')
  if (loaded.payload.boundary) await checkProductTransferBoundary(loaded.payload.boundary)
  if (loaded.payload.source?.presetId) {
    const preset = await prisma.scheduledImport.findFirst({ where: { id: loaded.payload.source.presetId, createdBy: userId } })
    if (!preset || fingerprint([preset.columnMapping, preset.sourceUrl]) !== loaded.payload.source.presetVersion) throw new TransferConflict('Source mapping or policy changed since preview')
  }
  const claimed = await prisma.bulkOperation.updateMany({ where: { id, userId, status: 'QUEUED', expiresAt: { gt: new Date() } }, data: { status: 'RUNNING', processed: 0, expiresAt: new Date(Date.now() + LEASE_MS) } })
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
