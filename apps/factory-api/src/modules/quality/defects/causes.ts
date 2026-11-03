import type { CauseProcess as DbProcess, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { CAUSE_LIMITS, CAUSE_PROCESSES, causeDraftProblems, missingCauses, PROCESS_WORDS, type CauseDraft, type CauseProcess } from '@nexus/factory-domain/quality/defects/causes'
import { mergedLabels } from '@nexus/factory-domain/quality/defects/rules'
import { missingLanguages } from '@nexus/factory-domain/quality/defects/vocabulary'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { assertManage, mayManage, officeOf } from './access'
import type { CauseView } from './vocabulary-contract'
import { floorLanguages, retiredWords, vocabularyChanged, wordsOf } from './vocabulary'

/**
 * Cause and responsible-process codes (B-W2b-90; QHS-004; design quality.defects df-causes "Rows: code, name, process.
 * Autosave per cell"): one list for the whole group, as the defect library. Reads with quality.defects.view; every write
 * quality.defects.manage over every company (403 in words), one command() each with an Idempotency-Key, audit rows with
 * companyId null and one `quality.vocabulary_changed` (list CAUSES).
 *
 *   GET    /quality/causes                 the codes in list order, each with its process in words, how often inspection
 *                                          defects and NCRs name it, the floor languages it has no words in; the
 *                                          processes, the tenant's other floor languages, the starter codes missing.
 *   POST   /quality/causes                 a code with its process (both fixed from now on) and its words.
 *   PATCH  /quality/causes/:causeId        words, order, active (retire / make active again), at the version read.
 *   DELETE /quality/causes/:causeId        only a code nothing names (else 409 in words: retire it).
 *   POST   /quality/causes/starter         the starter codes (one per process) the tenant does not have yet.
 *
 * The database's CauseCode_guard holds the code, the process and the words for every login; a retired code is refused on
 * a new inspection defect or NCR by its own triggers.
 */

const COLUMNS = {
  id: true,
  code: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  process: true,
  sortOrder: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CauseCodeSelect
type Row = Prisma.CauseCodeGetPayload<{ select: typeof COLUMNS }>
type Reader = Pick<CommandTx, 'causeCode' | 'inspectionDefect' | 'nonconformance'>

const viewOf = (row: Row, usedCount: number, languages: readonly string[]): CauseView => {
  const labelI18n = wordsOf(row.labelI18n)
  const process = row.process as CauseProcess
  return {
    id: row.id,
    code: row.code,
    labelIt: row.labelIt,
    labelEn: row.labelEn,
    labelI18n,
    process,
    processWords: { ...PROCESS_WORDS[process] },
    sortOrder: row.sortOrder,
    active: row.active,
    usedCount,
    missingLanguages: missingLanguages({ labelI18n }, languages),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const audited = (row: Row) => ({ code: row.code, process: row.process, labelIt: row.labelIt, labelEn: row.labelEn, labelI18n: wordsOf(row.labelI18n), sortOrder: row.sortOrder, active: row.active })
const byOrder = (a: Row, b: Row): number => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

/** How often inspection defects and NCRs name each code (what the caller's scope sees). */
async function usage(db: Reader): Promise<Map<string, number>> {
  const used = new Map<string, number>()
  for (const row of await db.inspectionDefect.groupBy({ by: ['causeCodeId'], where: { causeCodeId: { not: null } }, _count: { _all: true } })) if (row.causeCodeId) used.set(row.causeCodeId, (used.get(row.causeCodeId) ?? 0) + row._count._all)
  for (const row of await db.nonconformance.groupBy({ by: ['causeCodeId'], where: { causeCodeId: { not: null } }, _count: { _all: true } })) if (row.causeCodeId) used.set(row.causeCodeId, (used.get(row.causeCodeId) ?? 0) + row._count._all)
  return used
}

async function usesOf(db: Reader, id: string): Promise<number> {
  // One after the other: a transaction client runs one statement at a time.
  const inspections = await db.inspectionDefect.count({ where: { causeCodeId: id } })
  const ncrs = await db.nonconformance.count({ where: { causeCodeId: id } })
  return inspections + ncrs
}

async function readRow(db: Reader, id: string): Promise<Row | null> {
  return isUuid(id) ? db.causeCode.findUnique({ where: { id }, select: COLUMNS }) : null
}

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** A row the database's references keep (an NCR or an inspection defect out of the caller's sight names it). */
const isForeignKeyViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2003'

// ---- reads ----------------------------------------------------------------------------------------------------------

/** GET /quality/causes. */
export async function readCauses(caller: CommandCaller, query: { readonly active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.causeCode.findMany({ select: COLUMNS })
    const used = await usage(client)
    const languages = await floorLanguages(client)
    return {
      causes: rows
        .filter((row) => query.active === undefined || row.active === (query.active === 'true'))
        .sort(byOrder)
        .map((row) => viewOf(row, used.get(row.id) ?? 0, languages)),
      processes: CAUSE_PROCESSES.map((process) => ({ process, ...PROCESS_WORDS[process] })),
      languages,
      starterMissing: missingCauses(new Set(rows.map((row) => row.code))).map((cause) => cause.code),
      canManage: mayManage(context),
    }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

export interface CreateCauseBody extends CauseDraft {
  readonly code: string
  readonly process: CauseProcess
  readonly labelIt: string
  readonly labelEn: string
}

/** POST /quality/causes. */
export async function createCause(caller: CommandCaller, body: CreateCauseBody, idempotencyKey?: string): Promise<{ cause: CauseView }> {
  const context = officeOf(caller)
  assertManage(context)
  const code = body.code.trim().toUpperCase()
  const problems = causeDraftProblems({ ...body, code }, true)
  if (problems.length > 0) refuse(problems, 'The cause code is not valid.')
  const id = newId()
  const { result } = await command(caller, { name: 'quality.createCause', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // One writer of new codes at a time per tenant: the count and the free code are read under it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.cause-codes', current_setting('factory.tenant_id', true)), 0))`
    if ((await tx.causeCode.count()) >= CAUSE_LIMITS.perTenant) throw new ConflictError(`The cause list holds at most ${CAUSE_LIMITS.perTenant} codes: retire or delete some first.`)
    const taken = await tx.causeCode.findFirst({ where: { code }, select: { active: true } })
    if (taken) throw new ConflictError(`Cause code ${code} is taken${taken.active ? '' : ' by a retired code'}.`)
    const last = await tx.causeCode.aggregate({ _max: { sortOrder: true } })
    const row = await tx.causeCode.create({
      data: {
        id,
        code,
        process: body.process as DbProcess,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedLabels({}, body.labelI18n),
        sortOrder: body.sortOrder ?? Math.floor((last._max.sortOrder ?? 0) / 10) * 10 + 10,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: COLUMNS,
    })
    tools.audit({ recordType: 'CauseCode', recordId: id, companyId: null, after: audited(row) })
    vocabularyChanged(tools, 'CAUSES', 'CREATED', [code])
    return { cause: viewOf(row, 0, await floorLanguages(tx)) }
  })
  return result
}

export interface EditCauseBody extends Omit<CauseDraft, 'code' | 'process'> {
  readonly version: number
  readonly active?: boolean | undefined
}

/** PATCH /quality/causes/:causeId. */
export async function editCause(caller: CommandCaller, causeId: string, body: EditCauseBody, idempotencyKey?: string): Promise<{ cause: CauseView; retireWords: string | null }> {
  const context = officeOf(caller)
  assertManage(context)
  const before = await caller.withClient((client) => readRow(client, causeId))
  if (!before) throw new NotFoundError('Cause code not found.')
  const problems = causeDraftProblems(body, false)
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  const { result } = await command(
    caller,
    { name: 'quality.editCause', idempotencyKey, input: { causeId, ...body }, record: { type: 'CauseCode', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = (await readRow(tx, before.id))!
      const data: Prisma.CauseCodeUncheckedUpdateInput = { updatedAt: now }
      if (body.labelIt !== undefined) data.labelIt = body.labelIt.trim()
      if (body.labelEn !== undefined) data.labelEn = body.labelEn.trim()
      if (body.labelI18n !== undefined) data.labelI18n = mergedLabels(wordsOf(current.labelI18n), body.labelI18n)
      if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
      if (body.active !== undefined) data.active = body.active
      const row = await tx.causeCode.update({ where: { id: current.id }, data, select: COLUMNS })
      tools.audit({ recordType: 'CauseCode', recordId: row.id, companyId: null, before: audited(current), after: audited(row) })
      const change = body.active === false && current.active ? 'RETIRED' : body.active === true && !current.active ? 'REACTIVATED' : 'EDITED'
      vocabularyChanged(tools, 'CAUSES', change, [row.code])
      const used = await usesOf(tx, row.id)
      return { cause: viewOf(row, used, await floorLanguages(tx)), retireWords: change === 'RETIRED' ? retiredWords('Cause code', row.code, used) : null }
    },
  )
  return result
}

/** DELETE /quality/causes/:causeId?version=: only a code nothing names. */
export async function deleteCause(caller: CommandCaller, causeId: string, query: { readonly version: number }, idempotencyKey?: string): Promise<{ deleted: string; code: string }> {
  const context = officeOf(caller)
  assertManage(context)
  const before = await caller.withClient((client) => readRow(client, causeId))
  if (!before) throw new NotFoundError('Cause code not found.')
  const usedWords = (code: string, uses: number | null) =>
    `Cause code ${code} is used${uses === null ? '' : ` on ${uses} ${uses === 1 ? 'record' : 'records'}`}: retire it instead (it stays on them and leaves the pickers).`
  try {
    const { result } = await command(caller, { name: 'quality.deleteCause', idempotencyKey, input: { causeId, ...query } }, async (tools) => {
      const { tx } = tools
      const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "CauseCode" WHERE "id" = ${before.id}::uuid FOR UPDATE`
      if (!locked) throw new NotFoundError('Cause code not found.')
      if (locked.version !== query.version) throw new StaleVersionError('CauseCode', before.id, locked.version, query.version)
      const current = (await readRow(tx, before.id))!
      const uses = await usesOf(tx, current.id)
      if (uses > 0) throw new ConflictError(usedWords(current.code, uses))
      await tx.causeCode.delete({ where: { id: current.id }, select: { id: true } })
      tools.audit({ recordType: 'CauseCode', recordId: current.id, companyId: null, before: audited(current) })
      vocabularyChanged(tools, 'CAUSES', 'DELETED', [current.code])
      return { deleted: current.id, code: current.code }
    })
    return result
  } catch (error) {
    // A record the caller's scope does not see names it: the database's reference refuses the delete.
    if (isForeignKeyViolation(error)) throw new ConflictError(usedWords(before.code, null))
    throw error
  }
}

/** POST /quality/causes/starter: the starter codes the tenant does not have yet, after its last code. */
export async function addStarterCauses(caller: CommandCaller, idempotencyKey?: string): Promise<{ added: string[] }> {
  const context = officeOf(caller)
  assertManage(context)
  const { result } = await command(caller, { name: 'quality.addStarterCauses', idempotencyKey, input: {} }, async (tools) => {
    const { tx, now } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.cause-codes', current_setting('factory.tenant_id', true)), 0))`
    const rows = await tx.causeCode.findMany({ select: { code: true, sortOrder: true } })
    let order = Math.floor(Math.max(0, ...rows.map((row) => row.sortOrder)) / 10) * 10
    const added: string[] = []
    for (const cause of missingCauses(new Set(rows.map((row) => row.code)))) {
      order += 10
      const id = newId()
      const row = await tx.causeCode.create({
        data: { id, code: cause.code, process: cause.process as DbProcess, labelIt: cause.labelIt, labelEn: cause.labelEn, sortOrder: order, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: COLUMNS,
      })
      tools.audit({ recordType: 'CauseCode', recordId: id, companyId: null, after: audited(row) })
      added.push(row.code)
    }
    if (added.length === 0) tools.audit({ recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { starterCauses: 'nothing missing' } })
    vocabularyChanged(tools, 'CAUSES', 'STARTER_ADDED', added)
    return { added }
  })
  return result
}
