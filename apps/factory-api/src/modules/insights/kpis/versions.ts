import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { activationProblems, draftProblems, KPI_EDITABLE, type KpiRefusal, type KpiVersionFields } from '@nexus/factory-domain/insights/kpis/checks'
import type { KpiGrain, KpiUnit } from '@nexus/factory-domain/insights/kpis/catalogue'
import { kpiFileOf } from '@nexus/factory-domain/insights/kpis/registry'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { officeContextOf } from '../viewer'
import { VERSION_SELECT, type VersionRow } from './store'

/**
 * Writing a KPI's versions (B-W2b-428; ANA-012 "KPI definitions with versions"; design home.kpis › a KPI › History "changes to
 * the definition, so an old number can be explained"), each one command (audit row, kpi.changed, Idempotency-Key):
 *
 *   draft      a new version made from one of the KPI (its fields copied, what the person changes changed), numbered max + 1
 *              under a lock per KPI, with what changed (required); written as a DRAFT
 *   edit       a draft's fields, at the version the person read (compare-and-set)
 *   activate   a draft put in force: the version in force is SUPERSEDED first, then the draft is ACTIVE (one in force per
 *              KPI; the database's partial unique); only with the measures, unit and grain of the KPI's calculation
 *   retire     the version in force withdrawn (RETIRED): the KPI has no version in force, and its uses go with it
 *   delete     a draft only (a version that was in force explains old numbers and is kept)
 *
 * The database holds the same rules (…_insights_depth_w2b_guards); a write that still reaches one answers 409 in words
 * (core/errors, factory-domain insights/kpis/refusals).
 */

export type DraftBody = Partial<Omit<KpiVersionFields, 'sourceRecords' | 'measureKeys'>> & {
  readonly basedOnId: string
  readonly changeNote: string
  readonly sourceRecords?: readonly string[] | undefined
  readonly measureKeys?: readonly string[] | undefined
  readonly ownerRoleId?: string | undefined
}

export type EditBody = Partial<Omit<DraftBody, 'basedOnId' | 'changeNote'>> & { readonly version: number; readonly changeNote?: string | undefined }

const refused = (code: KpiRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

const lockKpi = (tools: CommandTools, kpiKey: string) => tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.kpis', ${'tenantId' in tools.context ? tools.context.tenantId : ''}::text, ${kpiKey}::text), 0))`

const actorIdOf = (tools: CommandTools): string => {
  const context = tools.context
  if (context.audience !== 'office') throw new ForbiddenError()
  return context.actorId
}

async function rowOf(tx: CommandTx, id: string): Promise<VersionRow> {
  const row = isUuid(id) ? await tx.kpiDefinition.findUnique({ where: { id }, select: VERSION_SELECT }) : null
  if (!row) throw new NotFoundError('KPI version not found.')
  return row
}

/** The owner of a definition: an office role of the tenant that is not archived. */
async function checkOwner(tx: CommandTx, roleId: string): Promise<void> {
  const role = isUuid(roleId) ? await tx.role.findUnique({ where: { id: roleId }, select: { audience: true, archivedAt: true } }) : null
  if (!role || role.audience !== 'OFFICE' || role.archivedAt) throw new ValidationError('A KPI is owned by an office role that is not archived.', [{ path: 'body/ownerRoleId', message: 'Choose an office role.' }])
}

const fieldsOf = (row: VersionRow): KpiVersionFields & { ownerRoleId: string } => ({
  nameIt: row.nameIt,
  nameEn: row.nameEn,
  definitionIt: row.definitionIt,
  definitionEn: row.definitionEn,
  formulaIt: row.formulaIt,
  formulaEn: row.formulaEn,
  sourceRecords: row.sourceRecords,
  measureKeys: row.measureKeys,
  unit: row.unit as KpiUnit,
  grain: row.grain as KpiGrain | null,
  ownerRoleId: row.ownerRoleId,
})

/** The fields a body changes (those it names). */
const changedOf = (body: Record<string, unknown>): Set<string> => new Set(KPI_EDITABLE.filter((field) => body[field] !== undefined))

function merged(row: VersionRow, body: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...fieldsOf(row) }
  for (const field of KPI_EDITABLE) if (body[field] !== undefined && field !== 'changeNote') out[field] = body[field]
  return out as unknown as KpiVersionFields & { ownerRoleId: string }
}

const changed = (row: VersionRow, action: 'DRAFTED' | 'EDITED' | 'DELETED' | 'ACTIVATED' | 'RETIRED' | 'INSTALLED', supersededId: string | null = null) => ({
  type: 'kpi.changed',
  subject: row.id,
  payload: { kpiKey: row.kpiKey, kpiVersion: row.kpiVersion, definitionId: row.id, action, supersededId },
})

/** POST /insights/kpis/:key/versions: a new draft made from a version of the KPI. */
export async function draftVersion(caller: CommandCaller, kpiKey: string, body: DraftBody, idempotencyKey: string | null | undefined) {
  officeContextOf(caller)
  const { result } = await command(caller, { name: 'insights.kpiDraft', idempotencyKey, input: { kpiKey, ...body } }, async (tools) => {
    const actorId = actorIdOf(tools)
    await lockKpi(tools, kpiKey)
    const base = await rowOf(tools.tx, body.basedOnId)
    if (base.kpiKey !== kpiKey) throw refused('BASED_ON_OTHER_KPI', `A new version of ${kpiKey} is made from one of its own versions.`)
    const fields = merged(base, body)
    const problems = draftProblems({ ...fields, changeNote: body.changeNote }, changedOf(body))
    if (problems.length > 0) throw new ValidationError('The new version is not complete.', problems)
    if (fields.ownerRoleId !== base.ownerRoleId) await checkOwner(tools.tx, fields.ownerRoleId)
    const top = await tools.tx.kpiDefinition.aggregate({ where: { kpiKey }, _max: { kpiVersion: true } })
    const id = newId()
    const kpiVersion = (top._max.kpiVersion ?? 0) + 1
    await tools.tx.kpiDefinition.create({
      data: { id, kpiKey, kpiVersion, basedOnId: base.id, changeNote: body.changeNote, ...fields, sourceRecords: [...fields.sourceRecords], measureKeys: [...fields.measureKeys], createdById: actorId, createdAt: tools.now, updatedAt: tools.now },
    })
    const row = await rowOf(tools.tx, id)
    tools.audit({ action: 'insights.kpiDrafted', recordType: 'KpiDefinition', recordId: id, after: { kpiKey, kpiVersion, basedOn: base.kpiVersion, changeNote: body.changeNote, changed: [...changedOf(body)].filter((field) => field !== 'changeNote') } })
    tools.emit(changed(row, 'DRAFTED'))
    return { id, kpiKey, kpiVersion, version: row.version }
  })
  return result
}

/** PATCH /insights/kpis/versions/:id: a draft's fields, at the version read. */
export async function editDraft(caller: CommandCaller, id: string, body: EditBody, idempotencyKey: string | null | undefined) {
  officeContextOf(caller)
  const { result } = await command(caller, { name: 'insights.kpiEdit', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const row = await rowOf(tools.tx, id)
    if (row.version !== body.version) throw new StaleVersionError('KpiDefinition', id, row.version, body.version)
    if (row.state !== 'DRAFT') throw refused('NOT_DRAFT', 'Only a draft is changed: write a new version from this one.')
    const fields = merged(row, body)
    const changeNote = body.changeNote ?? row.changeNote
    if (row.basedOnId === null && body.changeNote !== undefined) throw new ValidationError('A first version has nothing it changed from.', [{ path: 'body/changeNote', message: 'Only a version made from another says what changed.' }])
    const problems = draftProblems({ ...fields, changeNote }, changedOf(body))
    if (problems.length > 0) throw new ValidationError('The draft is not complete.', problems)
    if (fields.ownerRoleId !== row.ownerRoleId) await checkOwner(tools.tx, fields.ownerRoleId)
    const { count } = await tools.tx.kpiDefinition.updateMany({
      where: { id, version: body.version, state: 'DRAFT' },
      data: { ...fields, sourceRecords: [...fields.sourceRecords], measureKeys: [...fields.measureKeys], changeNote, version: { increment: 1 }, updatedAt: tools.now },
    })
    if (count !== 1) throw new StaleVersionError('KpiDefinition', id, row.version + 1, body.version)
    tools.audit({ action: 'insights.kpiEdited', recordType: 'KpiDefinition', recordId: id, after: { kpiKey: row.kpiKey, kpiVersion: row.kpiVersion, changed: [...changedOf(body)] } })
    tools.emit(changed(row, 'EDITED'))
    return { id, kpiKey: row.kpiKey, kpiVersion: row.kpiVersion, version: row.version + 1 }
  })
  return result
}

/** POST /insights/kpis/versions/:id/activate: the draft in force, the one before it superseded. */
export async function activateVersion(caller: CommandCaller, id: string, body: { readonly version: number }, idempotencyKey: string | null | undefined) {
  officeContextOf(caller)
  const { result } = await command(caller, { name: 'insights.kpiActivate', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const actorId = actorIdOf(tools)
    const first = await rowOf(tools.tx, id)
    await lockKpi(tools, first.kpiKey)
    const row = await rowOf(tools.tx, id)
    if (row.version !== body.version) throw new StaleVersionError('KpiDefinition', id, row.version, body.version)
    if (row.state !== 'DRAFT') throw refused('NOT_DRAFT', 'Only a draft is put in force.')
    const problems = activationProblems({ measureKeys: row.measureKeys, unit: row.unit as KpiUnit, grain: row.grain as KpiGrain | null }, kpiFileOf(row.kpiKey))
    if (problems.length > 0) throw new DomainError('conflict', problems[0]!.message, problems)
    const current = await tools.tx.kpiDefinition.findFirst({ where: { kpiKey: row.kpiKey, state: 'ACTIVE' }, select: VERSION_SELECT })
    if (current) {
      // First the one in force ends (the partial unique allows one ACTIVE per KPI at every moment).
      await tools.tx.kpiDefinition.updateMany({ where: { id: current.id, state: 'ACTIVE' }, data: { state: 'SUPERSEDED', endedAt: tools.now, endedById: actorId, version: { increment: 1 }, updatedAt: tools.now } })
      tools.audit({ action: 'insights.kpiSuperseded', recordType: 'KpiDefinition', recordId: current.id, before: { state: 'ACTIVE' }, after: { state: 'SUPERSEDED', by: row.kpiVersion } })
    }
    const { count } = await tools.tx.kpiDefinition.updateMany({ where: { id, version: body.version, state: 'DRAFT' }, data: { state: 'ACTIVE', activatedAt: tools.now, activatedById: actorId, version: { increment: 1 }, updatedAt: tools.now } })
    if (count !== 1) throw new StaleVersionError('KpiDefinition', id, row.version + 1, body.version)
    tools.audit({ action: 'insights.kpiActivated', recordType: 'KpiDefinition', recordId: id, before: { state: 'DRAFT' }, after: { state: 'ACTIVE', kpiKey: row.kpiKey, kpiVersion: row.kpiVersion, superseded: current?.kpiVersion ?? null } })
    tools.emit(changed(row, 'ACTIVATED', current?.id ?? null))
    return { id, kpiKey: row.kpiKey, kpiVersion: row.kpiVersion, version: row.version + 1, supersededId: current?.id ?? null }
  })
  return result
}

/** POST /insights/kpis/:key/retire: the version in force withdrawn, with the KPI's uses. */
export async function retireKpi(caller: CommandCaller, kpiKey: string, body: { readonly version: number }, idempotencyKey: string | null | undefined) {
  officeContextOf(caller)
  const { result } = await command(caller, { name: 'insights.kpiRetire', idempotencyKey, input: { kpiKey, ...body } }, async (tools) => {
    const actorId = actorIdOf(tools)
    await lockKpi(tools, kpiKey)
    const row = await tools.tx.kpiDefinition.findFirst({ where: { kpiKey, state: 'ACTIVE' }, select: VERSION_SELECT })
    if (!row) throw refused('NOT_IN_FORCE', 'This KPI has no version in force to withdraw.')
    if (row.version !== body.version) throw new StaleVersionError('KpiDefinition', row.id, row.version, body.version)
    const { count } = await tools.tx.kpiDefinition.updateMany({ where: { id: row.id, version: body.version, state: 'ACTIVE' }, data: { state: 'RETIRED', endedAt: tools.now, endedById: actorId, version: { increment: 1 }, updatedAt: tools.now } })
    if (count !== 1) throw new StaleVersionError('KpiDefinition', row.id, row.version + 1, body.version)
    const uses = await tools.tx.kpiUse.deleteMany({ where: { kpiKey } })
    tools.audit({ action: 'insights.kpiRetired', recordType: 'KpiDefinition', recordId: row.id, before: { state: 'ACTIVE' }, after: { state: 'RETIRED', kpiKey, kpiVersion: row.kpiVersion, usesRemoved: uses.count } })
    tools.emit(changed(row, 'RETIRED'))
    if (uses.count > 0) tools.emit({ type: 'kpi.uses_changed', subject: row.id, payload: { added: 0, removed: uses.count, kpiKeys: [kpiKey] } })
    return { id: row.id, kpiKey, kpiVersion: row.kpiVersion, version: row.version + 1, usesRemoved: uses.count }
  })
  return result
}

/** DELETE /insights/kpis/versions/:id?version=: a draft only. */
export async function deleteDraft(caller: CommandCaller, id: string, version: number, idempotencyKey: string | null | undefined) {
  officeContextOf(caller)
  const { result } = await command(caller, { name: 'insights.kpiDelete', idempotencyKey, input: { id, version } }, async (tools) => {
    const row = await rowOf(tools.tx, id)
    if (row.version !== version) throw new StaleVersionError('KpiDefinition', id, row.version, version)
    if (row.state !== 'DRAFT') throw refused('NOT_DRAFT', 'A version that was in force explains old numbers and is kept; only a draft is deleted.')
    const { count } = await tools.tx.kpiDefinition.deleteMany({ where: { id, version, state: 'DRAFT' } })
    if (count !== 1) throw new StaleVersionError('KpiDefinition', id, row.version + 1, version)
    tools.audit({ action: 'insights.kpiDeleted', recordType: 'KpiDefinition', recordId: id, before: { kpiKey: row.kpiKey, kpiVersion: row.kpiVersion, state: 'DRAFT' } })
    tools.emit(changed(row, 'DELETED'))
    return { id, deleted: true as const }
  })
  return result
}
