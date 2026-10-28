import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { DomainError, InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { events as fileEvents } from '@nexus/factory-domain/files/events'
import { events as importEvents } from '@nexus/factory-domain/imports/events'
import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import { mapHeaders } from '@nexus/factory-domain/imports/headers'
import { keyOf, keyValues, markValues, unmarkValues, type ExistingRecord, type Importer, type RowValues } from '@nexus/factory-domain/imports/importer'
import { IMPORT_LIMITS, importMachine, type CsvEncoding } from '@nexus/factory-domain/imports/job'
import { applyCheck, parseRow, planner } from '@nexus/factory-domain/imports/plan'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { heldRoles } from '../auth/roles/access'
import { TooLargeObjectError } from '../files/port'
import { processFiles, type FilesRuntime } from '../files/service'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { adapterRefusals, mappedColumns, unheldGrainIssues, type Layout } from './jobs'
import { processImporters, type ImportAdapter, type ImportScope } from './registry'
import { readSheet, SheetError } from './sheet'

/**
 * The import work of the worker (plan A1 §3.3, W0-22; feature PLT-176). Both steps run as the job's tenant's system
 * context (row-level security forced, every write through command() with its audit rows), are safe to run again, and
 * stop quietly when the job moved on (cancelled meanwhile: "settled").
 *
 *   dry run   handler imports.planUpload, on `file.available` of a file whose record is an ImportJob (the sheet's
 *             upload was confirmed): read the bytes from the file store (gateway op files.read), read the sheet, map
 *             its headers, refuse a mapped money column outside the grains the job's creator held, then plan the rows
 *             in batches of IMPORT_LIMITS.planBatchSize: the adapter's `load` in a transaction that is always rolled back
 *             and refused if it wrote (a dry run cannot write a business row), the plan of the batch stored by imports.recordPlan (its receipt makes a repeated
 *             batch a no-op, the unique row number a second guard). imports.finishPlan: PLANNED with the counts, and in
 *             mode APPLY straight on to APPLYING. A sheet that cannot be planned → FAILED with its issues, no row.
 *   apply     handler imports.applyPlan, on `import.apply_requested`: the planned CREATE and UPDATE rows not applied
 *             yet, in row order, in batches of the importer's batchSize. Each batch is ONE command imports.applyBatch:
 *             the job row is locked (its version bumped), the job must still be APPLYING, the batch's records are loaded
 *             again and each row checked (applyCheck): changed since the dry run or already done → SKIPPED with the
 *             reason; otherwise the adapter writes it (audited) → APPLIED. A write that throws rolls back the whole batch:
 *             nothing of it is written. Then imports.finishApply: APPLIED.
 *
 * Errors: a row the plan marked ERROR is never applied (the others are). A batch that throws stops the apply: the
 * handler's job is retried (a passing failure), and after its last attempt the job is FAILED with the batch's rows
 * named; the batches before it stay applied, and applying it again resumes at that batch (rows carry appliedAt).
 */

export const PLAN_HANDLER = 'imports.planUpload'
export const APPLY_HANDLER = 'imports.applyPlan'
export const IMPORT_ATTEMPTS = 3

const fileAvailable = fileEvents[0].payload
const applyRequested = importEvents.find((event) => event.type === 'import.apply_requested')!.payload

/** The job moved on (cancelled, planned or applied elsewhere): nothing to do. */
class Settled extends Error {
  override name = 'Settled'
}

export interface ImportWork {
  readonly files?: FilesRuntime
  /** Is this the handler's last attempt (then a failure is recorded on the job). */
  readonly lastAttempt?: boolean
  /** The event being handled: the causation of the work's events. */
  readonly causationId?: string
}

export type WorkOutcome = 'planned' | 'applied' | 'failed' | 'settled'

const PLAN_JOB_SELECT = {
  id: true,
  companyId: true,
  importerKey: true,
  sheetName: true,
  encoding: true,
  numberFormat: true,
  mapping: true,
  grains: true,
  status: true,
  mode: true,
  createdById: true,
  file: { select: { storeAccountId: true, storageKey: true, contentType: true, status: true } },
} as const satisfies Prisma.ImportJobSelect

/**
 * The person who started a job, as their live roles make them now, for the importer's own check in the dry run
 * (registry.ts `authorize`). Two-factor is taken as proved: the session that started the job had to hold these
 * permissions, and the apply checks the person who applies on their own session. Nobody (a person who left, or no
 * person): no grants.
 */
async function starterOf(caller: CommandCaller, userId: string | null): Promise<Actor> {
  const tenantId = caller.factoryContext ? actorOf(caller.factoryContext).tenantId : undefined
  if (!userId || !tenantId) return { audience: 'office', ...(tenantId ? { tenantId } : {}), grants: [] }
  const grants = await caller.withClient(async (client) => {
    const user = await client.user.findUnique({ where: { id: userId }, select: { requireMfa: true, status: true } })
    if (!user || user.status !== 'ACTIVE') return []
    return sessionGrants(user, await heldRoles(client, userId, serverClock.now()), true)
  })
  return { audience: 'office', tenantId, grants }
}

/** A failure in words for the job (an adapter's own message only when it is a domain error: those are for people). */
const failureText = (error: unknown): string =>
  error instanceof DomainError ? error.message.slice(0, 500) : `${error instanceof Error ? error.name : 'Error'} (see the worker log).`

/** imports.fail: the job → FAILED with what went wrong. A job that moved on meanwhile is left alone. */
async function failJob(caller: CommandCaller, jobId: string, failure: { readonly error: string; readonly issues?: readonly Issue[] }, causationId?: string): Promise<'failed' | 'settled'> {
  try {
    await command(
      caller,
      { name: 'imports.fail', input: { jobId, ...failure }, causationId, record: { type: 'ImportJob', id: jobId, transition: { machine: importMachine, to: 'FAILED' } } },
      async ({ tx, audit, emit, record }) => {
        const row = await tx.importJob.update({
          where: { id: jobId },
          data: { error: failure.error, ...(failure.issues ? { issues: failure.issues as unknown as Prisma.InputJsonValue } : {}) },
          select: { companyId: true, importerKey: true },
        })
        audit({ recordType: 'ImportJob', recordId: jobId, companyId: row.companyId, before: { status: record!.from }, after: { status: 'FAILED', error: failure.error, issues: failure.issues ?? null } })
        emit({ type: 'import.failed', subject: jobId, companyId: row.companyId, payload: { jobId, importerKey: row.importerKey } })
        return { failed: true }
      },
    )
    return 'failed'
  } catch (error) {
    if (error instanceof InvalidStateError) return 'settled'
    throw error
  }
}

/** Ends the read-only transaction: rolls it back, carrying what it read. */
class RolledBack<T> extends Error {
  override name = 'RolledBack'
  constructor(readonly value: T) {
    super('rolled back')
  }
}

/** An importer's load wrote during a dry run (the write was rolled back). */
export class DryRunWriteError extends Error {
  override name = 'DryRunWriteError'
}

/**
 * Runs `work` in a transaction of the caller's scope that is ALWAYS rolled back, so a dry run cannot leave a write
 * behind; and a write is refused loudly: PostgreSQL gives a transaction an id only when it writes, so a transaction
 * that has one after `work` wrote something. (The scoped client allows no SET statement, so the transaction cannot be
 * declared READ ONLY up front.)
 */
async function readOnly<T>(caller: CommandCaller, work: (tx: CommandTx) => Promise<T>): Promise<T> {
  try {
    await caller.withClient((client) =>
      client.$transaction(async (tx) => {
        const value = await work(tx)
        const [state] = await tx.$queryRawUnsafe<{ xid: string | null }[]>('SELECT pg_current_xact_id_if_assigned()::text AS xid')
        if (state?.xid !== null && state?.xid !== undefined) throw new DryRunWriteError('The importer wrote to the database while reading for a dry run; the write was undone.')
        throw new RolledBack(value)
      }),
    )
  } catch (error) {
    if (error instanceof RolledBack) return error.value as T
    throw error
  }
  throw new Error('unreachable: the read-only transaction always rolls back')
}

/** The records the keys find, by key. */
function existingByKey(importer: Importer, records: readonly ExistingRecord[]): Map<string, ExistingRecord> {
  const byKey = new Map<string, ExistingRecord>()
  for (const record of records) {
    const key = keyOf(importer, record.values)
    if (key !== null) byKey.set(key, record)
  }
  return byKey
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue

/** The dry run of one job (the handler's work; also called by tests). */
export async function planImport(caller: CommandCaller, jobId: string, work: ImportWork = {}): Promise<WorkOutcome> {
  const job = await caller.withClient((client) => client.importJob.findUnique({ where: { id: jobId }, select: PLAN_JOB_SELECT }))
  if (!job || job.status !== 'UPLOADED' || job.file.status !== 'AVAILABLE') return 'settled'
  const causationId = work.causationId
  const fail = (failure: { error: string; issues?: readonly Issue[] }) => failJob(caller, jobId, failure, causationId)
  const adapter = processImporters().get(job.importerKey)
  if (!adapter) return fail({ error: `The importer ${job.importerKey} is not available in this version of the factory.` })
  const importer = adapter.importer
  const scope: ImportScope = { companyId: job.companyId }

  try {
    const files = work.files ?? processFiles()
    const bytes = await files.storage.read(caller, job.file.storeAccountId, job.file.storageKey, IMPORT_LIMITS.maxBytes)
    if (!bytes) return await fail({ error: 'The sheet is not in the file store: upload it again in a new import.' })
    const sheet = await readSheet(bytes, {
      contentType: job.file.contentType,
      sheetName: job.sheetName,
      encoding: job.encoding as CsvEncoding | null,
      maxRows: importer.maxRows,
    })
    const mapping = mapHeaders(importer.columns, sheet.headers, (job.mapping ?? {}) as Record<string, string | null>)
    const layout: Layout = {
      format: sheet.format,
      sheet: sheet.sheet,
      sheets: sheet.sheets,
      encoding: sheet.encoding,
      delimiter: sheet.delimiter,
      headers: sheet.headers,
      columns: mapping.columns,
      ignored: mapping.ignored,
    }
    const issues = [...mapping.issues, ...unheldGrainIssues(adapter, layout, job.grains)]
    if (adapter.authorize) issues.push(...adapterRefusals(adapter, await starterOf(caller, job.createdById), job.companyId, mappedColumns(layout)))
    if (issues.length > 0) {
      await saveLayout(caller, jobId, layout, causationId)
      return await fail({ error: 'The sheet cannot be imported as it is: see the issues.', issues })
    }

    const run = planner(importer)
    const context = { numberFormat: job.numberFormat as NumberFormat }
    for (let start = 0, batch = 0; start < sheet.rows.length; start += IMPORT_LIMITS.planBatchSize, batch++) {
      const parsed = sheet.rows.slice(start, start + IMPORT_LIMITS.planBatchSize).map((row) => parseRow(importer, mapping.columns, row, context))
      const keys = [...new Set(parsed.flatMap((row) => (row.errors.length === 0 && row.key !== null ? [row.key] : [])))]
      const records = keys.length === 0 ? [] : await readOnly(caller, (tx) => adapter.load(tx, keys.map((key) => keyValues(importer, key)), scope))
      const planned = run.plan(parsed, existingByKey(importer, records))
      await command(caller, { name: 'imports.recordPlan', idempotencyKey: `plan.${jobId}.${batch}`, input: { jobId, batch }, causationId }, async ({ tx, audit, now }) => {
        const current = await tx.importJob.findUnique({ where: { id: jobId }, select: { status: true } })
        if (current?.status !== 'UPLOADED') throw new Settled()
        await tx.importRow.createMany({
          data: planned.map((row) => ({
            id: newId(),
            jobId,
            rowNumber: row.rowNumber,
            action: row.action,
            key: row.key,
            recordId: row.recordId,
            ...(row.errors.length > 0 ? { errors: json(row.errors) } : {}),
            ...(row.before ? { before: json(markValues(importer, row.before)) } : {}),
            ...(row.after ? { after: json(markValues(importer, row.after)) } : {}),
            createdAt: now,
            updatedAt: now,
          })),
          skipDuplicates: true,
        })
        audit({ recordType: 'ImportJob', recordId: jobId, companyId: job.companyId, after: { planned: { firstRow: planned[0]?.rowNumber ?? null, lastRow: planned.at(-1)?.rowNumber ?? null, rows: planned.length } } })
        return { rows: planned.length }
      })
    }

    await command(
      caller,
      { name: 'imports.finishPlan', input: { jobId }, causationId, record: { type: 'ImportJob', id: jobId, transition: { machine: importMachine, to: 'PLANNED' } } },
      async ({ tx, audit, emit, now }) => {
        const counts = await tx.importRow.groupBy({ by: ['action'], where: { jobId }, _count: { _all: true } })
        const count = (action: string): number => counts.find((entry) => entry.action === action)?._count._all ?? 0
        const applyNow = job.mode === 'APPLY'
        if (applyNow) assertTransition(importMachine, 'PLANNED', 'APPLYING', { planned: true })
        const data = {
          layout: json(layout),
          rowCount: counts.reduce((sum, entry) => sum + entry._count._all, 0),
          createCount: count('CREATE'),
          updateCount: count('UPDATE'),
          unchangedCount: count('UNCHANGED'),
          errorCount: count('ERROR'),
          plannedAt: now,
          error: null,
          ...(applyNow ? { status: 'APPLYING' as const, applyRequestedAt: now } : {}),
        }
        const row = await tx.importJob.update({ where: { id: jobId }, data, select: { companyId: true, importerKey: true, status: true } })
        const { layout: _layout, ...summary } = data
        audit({ recordType: 'ImportJob', recordId: jobId, companyId: row.companyId, before: { status: 'UPLOADED' }, after: { ...summary, plannedAt: now.toISOString(), status: row.status } })
        const payload = { jobId, importerKey: row.importerKey }
        emit({ type: 'import.planned', subject: jobId, companyId: row.companyId, payload })
        if (applyNow) emit({ type: 'import.apply_requested', subject: jobId, companyId: row.companyId, payload })
        return { status: row.status }
      },
    )
    return 'planned'
  } catch (error) {
    if (error instanceof Settled || error instanceof InvalidStateError) return 'settled'
    if (error instanceof SheetError) return fail({ error: 'The sheet could not be read: see the issues.', issues: error.issues })
    if (error instanceof TooLargeObjectError) return fail({ error: `The sheet is larger than ${IMPORT_LIMITS.maxBytes / 1_048_576} MiB.` })
    if (error instanceof DryRunWriteError) {
      await fail({ error: `The dry run failed: ${error.message}` })
      throw error
    }
    if (work.lastAttempt) await fail({ error: `The dry run failed: ${failureText(error)}` }).catch(() => undefined)
    throw error
  }
}

/** Keeps what the dry run read on a job that cannot be planned (the screen shows the headers to fix the mapping). */
async function saveLayout(caller: CommandCaller, jobId: string, layout: Layout, causationId?: string): Promise<void> {
  await command(caller, { name: 'imports.recordLayout', input: { jobId }, causationId }, async ({ tx, audit }) => {
    const row = await tx.importJob.update({ where: { id: jobId }, data: { layout: json(layout) }, select: { companyId: true } })
    audit({ recordType: 'ImportJob', recordId: jobId, companyId: row.companyId, after: { layout: { headers: layout.headers, columns: layout.columns, ignored: layout.ignored } } })
    return { saved: true }
  })
}

const APPLY_JOB_SELECT = { id: true, companyId: true, importerKey: true, status: true } as const satisfies Prisma.ImportJobSelect

/** The apply of one job (the handler's work; also called by tests). */
export async function applyPlan(caller: CommandCaller, jobId: string, work: ImportWork = {}): Promise<WorkOutcome> {
  const job = await caller.withClient((client) => client.importJob.findUnique({ where: { id: jobId }, select: APPLY_JOB_SELECT }))
  if (!job || job.status !== 'APPLYING') return 'settled'
  const causationId = work.causationId
  const adapter = processImporters().get(job.importerKey)
  if (!adapter) return failJob(caller, jobId, { error: `The importer ${job.importerKey} is not available in this version of the factory.` }, causationId)
  const importer = adapter.importer
  const scope: ImportScope = { companyId: job.companyId }
  let batch: { first: number; last: number } | null = null

  try {
    for (;;) {
      const next = await caller.withClient((client) =>
        client.importRow.findMany({
          where: { jobId, action: { in: ['CREATE', 'UPDATE'] }, appliedAt: null },
          select: { rowNumber: true },
          orderBy: { rowNumber: 'asc' },
          take: importer.batchSize,
        }),
      )
      if (next.length === 0) break
      batch = { first: next[0]!.rowNumber, last: next[next.length - 1]!.rowNumber }
      await applyBatch(caller, adapter, job.companyId, jobId, batch, scope, causationId)
    }
    batch = null
    await command(
      caller,
      { name: 'imports.finishApply', input: { jobId }, causationId, record: { type: 'ImportJob', id: jobId, transition: { machine: importMachine, to: 'APPLIED' } } },
      async ({ tx, audit, emit, now }) => {
        const row = await tx.importJob.update({ where: { id: jobId }, data: { appliedAt: now, error: null }, select: { companyId: true, importerKey: true, appliedCount: true, skippedCount: true } })
        audit({ recordType: 'ImportJob', recordId: jobId, companyId: row.companyId, before: { status: 'APPLYING' }, after: { status: 'APPLIED', appliedCount: row.appliedCount, skippedCount: row.skippedCount } })
        emit({ type: 'import.applied', subject: jobId, companyId: row.companyId, payload: { jobId, importerKey: row.importerKey } })
        return { applied: row.appliedCount }
      },
    )
    return 'applied'
  } catch (error) {
    if (error instanceof Settled || error instanceof InvalidStateError) return 'settled'
    if (work.lastAttempt) {
      const where = batch ? `Rows ${batch.first} to ${batch.last} could not be applied, so none of them was written` : 'The apply could not finish'
      await failJob(caller, jobId, { error: `${where}: ${failureText(error)} Rows before them stay applied; apply the import again to go on from there.` }, causationId).catch(() => undefined)
    }
    throw error
  }
}

/** imports.applyBatch: one transaction for the batch's rows (all or nothing). */
async function applyBatch(
  caller: CommandCaller,
  adapter: ImportAdapter,
  companyId: string | null,
  jobId: string,
  batch: { readonly first: number; readonly last: number },
  scope: ImportScope,
  causationId: string | undefined,
): Promise<void> {
  const importer = adapter.importer
  await command(caller, { name: 'imports.applyBatch', input: { jobId, ...batch }, causationId, record: { type: 'ImportJob', id: jobId } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.importJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })
    if (current.status !== 'APPLYING') throw new Settled()
    const rows = await tx.importRow.findMany({
      where: { jobId, rowNumber: { gte: batch.first, lte: batch.last }, action: { in: ['CREATE', 'UPDATE'] }, appliedAt: null },
      select: { id: true, rowNumber: true, action: true, key: true, recordId: true, before: true, after: true },
      orderBy: { rowNumber: 'asc' },
    })
    const keys = [...new Set(rows.flatMap((row) => (row.key === null ? [] : [row.key])))]
    const records = keys.length === 0 ? [] : await adapter.load(tx, keys.map((key) => keyValues(importer, key)), scope)
    const byKey = existingByKey(importer, records)
    let applied = 0
    let skipped = 0
    for (const row of rows) {
      const before = unmarkValues(row.before)
      const after = unmarkValues(row.after) as RowValues
      const decision =
        row.key === null
          ? ({ apply: false, note: 'changed_since_dry_run' } as const)
          : applyCheck(importer, { action: row.action, recordId: row.recordId, before, after }, byKey.get(row.key) ?? null)
      if (decision.apply) {
        const written = await adapter.write(
          tools,
          { action: row.action as 'CREATE' | 'UPDATE', key: keyValues(importer, row.key!), recordId: row.recordId, before, values: after },
          scope,
        )
        await tx.importRow.update({ where: { id: row.id }, data: { outcome: 'APPLIED', recordId: written.recordId, appliedAt: now }, select: { id: true } })
        applied += 1
      } else {
        await tx.importRow.update({ where: { id: row.id }, data: { outcome: 'SKIPPED', note: decision.note, appliedAt: now }, select: { id: true } })
        skipped += 1
      }
    }
    await tx.importJob.update({ where: { id: jobId }, data: { appliedCount: { increment: applied }, skippedCount: { increment: skipped } }, select: { id: true } })
    tools.audit({ recordType: 'ImportJob', recordId: jobId, companyId, after: { batch: { firstRow: batch.first, lastRow: batch.last }, applied, skipped } })
    return { applied, skipped }
  })
}

/** The worker's import handlers: background.ts HANDLERS. */
export function importHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: PLAN_HANDLER,
      events: ['file.available'],
      attempts: IMPORT_ATTEMPTS,
      async handle(event, tools) {
        const payload = fileAvailable.parse(event.payload)
        if (payload.recordType !== 'ImportJob') return
        await planImport(tools.caller, payload.recordId, { causationId: event.eventId, lastAttempt: tools.attempt >= IMPORT_ATTEMPTS })
      },
    }),
    defineHandler({
      name: APPLY_HANDLER,
      events: ['import.apply_requested'],
      attempts: IMPORT_ATTEMPTS,
      async handle(event, tools) {
        const { jobId } = applyRequested.parse(event.payload)
        await applyPlan(tools.caller, jobId, { causationId: event.eventId, lastAttempt: tools.attempt >= IMPORT_ATTEMPTS })
      },
    }),
  ]
}
