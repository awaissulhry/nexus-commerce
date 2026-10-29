import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRIVACY_MANAGE, PRIVACY_VIEW } from '@nexus/factory-domain/privacy/permissions'
import { activityProblems, cleanList, type ProcessingActivityInput } from '@nexus/factory-domain/privacy/records'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { assertMay, companyFor, officeOf, refuse } from './access'

/**
 * A company's record of processing activities (B-W1-36; GDPR art. 30(1), processors under art. 28; GAP-009; A2 SCR-086
 * "Processing register"): privacy.view to read, privacy.manage to add, change and archive, over the company. Every write
 * is ONE command on the activity (its version is the edit guard) with an audit row before/after: the audit log keeps
 * the record's history (art. 30 asks for it in writing). An archived activity never changes; nothing is deleted.
 */

const ACTIVITY_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  purpose: true,
  legalBasis: true,
  dataSubjects: true,
  dataCategories: true,
  recipients: true,
  processors: true,
  transfers: true,
  retention: true,
  security: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ProcessingActivitySelect

type ActivityRow = Prisma.ProcessingActivityGetPayload<{ select: typeof ACTIVITY_SELECT }>

const viewOf = (row: ActivityRow) => ({ ...row, updatedAt: toUtcIso(row.updatedAt) })
const readRow = (db: Pick<CommandTx, 'processingActivity'>, id: string) => db.processingActivity.findUnique({ where: { id }, select: ACTIVITY_SELECT })
const auditOf = (row: ActivityRow) => {
  const { id: _id, version: _version, updatedAt: _updatedAt, ...rest } = row
  return rest
}

/** The fields as stored: texts trimmed, lists cleaned. */
function cleaned(input: Partial<ProcessingActivityInput>): Partial<ProcessingActivityInput> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    out[key] = Array.isArray(value) ? cleanList(value) : typeof value === 'string' ? value.trim() : value
  }
  return out as Partial<ProcessingActivityInput>
}

async function readActivity(caller: CommandCaller, activityId: string, permission: typeof PRIVACY_VIEW | typeof PRIVACY_MANAGE): Promise<ActivityRow> {
  const context = officeOf(caller)
  const row = isUuid(activityId) ? await caller.withClient((client) => readRow(client, activityId)) : null
  if (!row) throw new NotFoundError('Processing activity not found.')
  assertMay(context, permission, row.companyId, 'Processing activity not found.')
  return row
}

/** privacy.view: the company's activities by code (ACTIVE and ARCHIVED, or one of them). */
export async function listActivities(caller: CommandCaller, query: { companyId: string; status?: 'ACTIVE' | 'ARCHIVED' | undefined }) {
  const { company } = await companyFor(caller, query.companyId, PRIVACY_VIEW)
  const rows = await caller.withClient((client) =>
    client.processingActivity.findMany({ where: { companyId: company.id, ...(query.status ? { status: query.status } : {}) }, select: ACTIVITY_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] }),
  )
  return { company, activities: rows.map(viewOf) }
}

/** privacy.manage: a new activity of the company (its code unique there). */
export async function createActivity(caller: CommandCaller, body: ProcessingActivityInput & { companyId: string }, idempotencyKey?: string) {
  const { context, company } = await companyFor(caller, body.companyId, PRIVACY_MANAGE)
  const { companyId: _companyId, ...fields } = body
  refuse(activityProblems(fields), 'The processing activity is not complete.')
  const data = cleaned(fields) as ProcessingActivityInput
  const { result } = await command(caller, { name: 'privacy.createActivity', idempotencyKey, input: body }, async (tools) => {
    if (await tools.tx.processingActivity.findFirst({ where: { companyId: company.id, code: data.code }, select: { id: true } })) {
      throw new ConflictError(`The company's record already has an activity ${data.code}.`)
    }
    const id = newId()
    const { count } = await tools.tx.processingActivity.createMany({
      data: [{ id, companyId: company.id, ...data, dataSubjects: [...data.dataSubjects], dataCategories: [...data.dataCategories], recipients: [...data.recipients], processors: [...data.processors], createdById: context.actorId }],
      skipDuplicates: true,
    })
    if (count !== 1) throw new ConflictError(`The company's record already has an activity ${data.code}.`)
    const row = (await readRow(tools.tx, id))!
    tools.audit({ recordType: 'ProcessingActivity', recordId: id, companyId: company.id, after: auditOf(row) })
    return { activity: viewOf(row) }
  })
  return result
}

/** privacy.manage: changes the fields sent, at the version read. */
export async function patchActivity(caller: CommandCaller, activityId: string, body: Partial<ProcessingActivityInput> & { version: number }, idempotencyKey?: string) {
  const row = await readActivity(caller, activityId, PRIVACY_MANAGE)
  const { version, ...fields } = body
  refuse(activityProblems(fields, true), 'The processing activity is not complete.')
  if (row.status === 'ARCHIVED') throw new InvalidStateError(`Activity ${row.code} is archived: it never changes.`)
  const data = cleaned(fields)
  const { result } = await command(caller, { name: 'privacy.changeActivity', idempotencyKey, input: { activityId, ...body }, record: { type: 'ProcessingActivity', id: activityId, expectedVersion: version } }, async (tools) => {
    const before = (await readRow(tools.tx, activityId))!
    if (before.status === 'ARCHIVED') throw new InvalidStateError(`Activity ${before.code} is archived: it never changes.`)
    await tools.tx.processingActivity.update({ where: { id: activityId }, data: data as Prisma.ProcessingActivityUpdateInput, select: { id: true } })
    const after = (await readRow(tools.tx, activityId))!
    tools.audit({ recordType: 'ProcessingActivity', recordId: activityId, companyId: row.companyId, before: auditOf(before), after: auditOf(after) })
    return { activity: viewOf(after) }
  })
  return result
}

/** privacy.manage: the processing stopped; the activity stays in the record, archived. */
export async function archiveActivity(caller: CommandCaller, activityId: string, body: { version: number }, idempotencyKey?: string) {
  const row = await readActivity(caller, activityId, PRIVACY_MANAGE)
  if (row.status === 'ARCHIVED') return { activity: viewOf(row) }
  const { result } = await command(caller, { name: 'privacy.archiveActivity', idempotencyKey, input: { activityId, ...body }, record: { type: 'ProcessingActivity', id: activityId, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.processingActivity.update({ where: { id: activityId }, data: { status: 'ARCHIVED' }, select: { id: true } })
    tools.audit({ recordType: 'ProcessingActivity', recordId: activityId, companyId: row.companyId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    return { activity: viewOf((await readRow(tools.tx, activityId))!) }
  })
  return result
}
