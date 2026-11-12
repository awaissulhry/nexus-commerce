import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { subcontractorCapacityChanged as changedEvent } from '@nexus/factory-domain/planning-subcontract/events'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PLANNING_SUBCONTRACT_CAPACITY } from '@nexus/factory-domain/planning/subcontract-capacity/permissions'
import { capacityProblems, capacityWords, conflictProblem, rowOn, type CapacityUnit } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, siteFor } from '../access'
import { workshopsOf } from '../schedule/store'
import type { Reader } from '../store'
import { CAPACITY_COLUMNS, capacityRowOf, readCapacityRows, type CapacityDbRow } from './store'

/**
 * A workshop's weekly capacity (B-W2b-321; PLN-124; design planning.capacity "subcontractors (W2b) with their weekly
 * minutes or pieces", Capacity settings): rows of SubcontractorCapacity, per workshop and kind of work (null: all its
 * work), minutes or garments a week, from a day until a day.
 *
 *   GET    /planning/subcontract-capacity?siteId | partyId   the rows of the site's workshops (or of one workshop)
 *   POST   /planning/subcontract-capacity                    a row
 *   PATCH  /planning/subcontract-capacity/:capacityId        its kind, unit, number, days or note (the workshop is fixed)
 *   DELETE /planning/subcontract-capacity/:capacityId?version=
 *
 * Read with planning.view, kept with planning.subcontract.capacity, both over the workshop (its company, or every company
 * for a tenant-wide workshop). The rows of one workshop and kind never overlap and keep one unit: a write takes the
 * workshop's advisory lock and checks the others (the database has no overlap rule).
 */

interface WorkshopParty {
  readonly id: string
  readonly companyId: string | null
  readonly code: string
  readonly name: string
  readonly roles: readonly string[]
  readonly status: string
}

const scopeOf = (party: Pick<WorkshopParty, 'id' | 'companyId'>) => (party.companyId ? { companyId: party.companyId, partyId: party.id } : { partyId: party.id })

async function readParty(db: Reader, partyId: string): Promise<WorkshopParty | null> {
  if (!isUuid(partyId)) return null
  const row = await db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, code: true, legalName: true, tradeName: true, roles: true, status: true } })
  return row ? { id: row.id, companyId: row.companyId, code: row.code, name: row.tradeName ?? row.legalName, roles: row.roles, status: row.status } : null
}

/** The workshop the caller reaches with planning.view (else not found) and, for a write, the capacity permission (else forbidden). */
function assertWorkshop(context: OfficeContext, party: WorkshopParty | null, write: boolean): asserts party is WorkshopParty {
  const actor = actorOf(context)
  if (!party || !party.roles.includes('SUBCONTRACTOR') || !can(actor, PLANNING_VIEW, scopeOf(party))) throw new NotFoundError('Workshop not found: a workshop is a party with the subcontractor role.')
  if (write && !can(actor, PLANNING_SUBCONTRACT_CAPACITY, scopeOf(party))) throw new ForbiddenError('Keeping a workshop’s capacity needs planning.subcontract.capacity over it.')
}

export function rowView(row: CapacityDbRow, party: Pick<WorkshopParty, 'id' | 'code' | 'name'>, today: BusinessDate, may: boolean) {
  const facts = capacityRowOf(row)
  return {
    id: row.id,
    workshop: { id: party.id, code: party.code, name: party.name },
    workCentreKind: row.workCentreKind,
    unit: row.unit as CapacityUnit,
    perWeek: row.perWeek,
    validFrom: facts.validFrom,
    validTo: facts.validTo,
    note: row.note,
    inForceToday: rowOn([facts], facts.partyId, facts.workCentreKind, today) !== null,
    words: capacityWords(facts),
    version: row.version,
    may: { change: may },
  }
}

/** GET /planning/subcontract-capacity. */
export async function listCapacity(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly partyId?: string | undefined }) {
  const context = officeContextOf(caller)
  if (!query.siteId && !query.partyId) throw new ValidationError('Name the site or the workshop.', [{ path: 'querystring/siteId', message: 'Give siteId or partyId.' }])
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    let parties: WorkshopParty[] = []
    if (query.partyId) {
      const party = await readParty(db, query.partyId)
      assertWorkshop(context, party, false)
      parties = [party]
    } else {
      const site = await siteFor(caller, query.siteId!, PLANNING_VIEW, db)
      const workshops = await workshopsOf(db, site)
      parties = (await Promise.all(workshops.map((workshop) => readParty(db, workshop.id)))).filter((party): party is WorkshopParty => party !== null && can(actorOf(context), PLANNING_VIEW, scopeOf(party)))
    }
    const rows = await readCapacityRows(db, parties.map((party) => party.id))
    const actor = actorOf(context)
    return {
      workshops: parties.map((party) => ({ id: party.id, code: party.code, name: party.name, may: { create: can(actor, PLANNING_SUBCONTRACT_CAPACITY, scopeOf(party)) } })),
      rows: rows.map((row) => {
        const party = parties.find((candidate) => candidate.id === row.partyId)!
        return rowView(row, party, today, can(actor, PLANNING_SUBCONTRACT_CAPACITY, scopeOf(party)))
      }),
    }
  })
}

export interface CapacityBody {
  readonly partyId: string
  readonly workCentreKind?: string | null | undefined
  readonly unit: CapacityUnit
  readonly perWeek: number
  readonly validFrom: BusinessDate
  readonly validTo?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const day = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

async function lockWorkshop(tools: CommandTools, partyId: string): Promise<void> {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : ''
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.subcontract-capacity', ${tenantId}::text, ${partyId}::text), 0))`
}

/** Under the workshop's lock: the row may stand beside its others (409 in words otherwise). */
async function assertNoConflict(tools: CommandTools, row: { id: string | null; partyId: string; workCentreKind: string | null; unit: CapacityUnit; validFrom: BusinessDate; validTo: BusinessDate | null }): Promise<void> {
  await lockWorkshop(tools, row.partyId)
  const others = (await readCapacityRows(tools.tx, [row.partyId])).map(capacityRowOf)
  const problem = conflictProblem(others, { ...row, perWeek: 1 })
  if (problem) throw new DomainError('conflict', problem.message, [problem])
}

const emitChanged = (tools: CommandTools, row: { id: string; partyId: string; workCentreKind: string | null; unit: string }, companyId: string | null, change: 'CREATED' | 'EDITED' | 'DELETED') =>
  tools.emit(eventFor(changedEvent, { subject: row.id, companyId, payload: { capacityId: row.id, partyId: row.partyId, workCentreKind: row.workCentreKind, unit: row.unit as CapacityUnit, change } }))

/** POST /planning/subcontract-capacity. */
export async function createCapacity(caller: CommandCaller, body: CapacityBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const party = await caller.withClient((db) => readParty(db, body.partyId))
  assertWorkshop(context, party, true)
  if (party.status === 'ARCHIVED') throw new ConflictError(`${party.name} is archived: it gets no capacity.`)
  const problems = capacityProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const row = { id: newId(), partyId: party.id, workCentreKind: body.workCentreKind ?? null, unit: body.unit, perWeek: body.perWeek, validFrom: body.validFrom, validTo: body.validTo ?? null, note: blank(body.note) }
  const today = businessDate(serverClock.now())
  const { result } = await command(caller, { name: 'planning.subcontractCapacity.create', idempotencyKey, input: body }, async (tools) => {
    await assertNoConflict(tools, { ...row, id: null })
    const created = await tools.tx.subcontractorCapacity.create({
      data: { id: row.id, partyId: row.partyId, workCentreKind: row.workCentreKind as never, unit: row.unit, perWeek: row.perWeek, validFrom: day(row.validFrom), validTo: row.validTo ? day(row.validTo) : null, note: row.note, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId },
      select: CAPACITY_COLUMNS,
    })
    tools.audit({ action: 'planning.subcontractCapacity.create', recordType: 'SubcontractorCapacity', recordId: row.id, companyId: party.companyId, after: { partyId: row.partyId, workCentreKind: row.workCentreKind, unit: row.unit, perWeek: row.perWeek, validFrom: row.validFrom, validTo: row.validTo, note: row.note } })
    emitChanged(tools, row, party.companyId, 'CREATED')
    return { row: rowView(created, party, today, true) }
  })
  return result
}

async function capacityTarget(caller: CommandCaller, capacityId: string) {
  const context = officeContextOf(caller)
  const found = await caller.withClient(async (db) => {
    const row = isUuid(capacityId) ? await db.subcontractorCapacity.findUnique({ where: { id: capacityId }, select: CAPACITY_COLUMNS }) : null
    return row ? { row, party: await readParty(db, row.partyId) } : null
  })
  if (!found) throw new NotFoundError('Capacity row not found.')
  assertWorkshop(context, found.party, true)
  return { row: found.row, party: found.party! }
}

export interface CapacityPatch {
  readonly version: number
  readonly workCentreKind?: string | null | undefined
  readonly unit?: CapacityUnit | undefined
  readonly perWeek?: number | undefined
  readonly validFrom?: BusinessDate | undefined
  readonly validTo?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** PATCH /planning/subcontract-capacity/:capacityId. */
export async function editCapacity(caller: CommandCaller, capacityId: string, body: CapacityPatch, idempotencyKey?: string) {
  const { row: before, party } = await capacityTarget(caller, capacityId)
  const facts = capacityRowOf(before)
  const next = {
    id: before.id,
    partyId: before.partyId,
    workCentreKind: body.workCentreKind !== undefined ? body.workCentreKind : facts.workCentreKind,
    unit: body.unit ?? facts.unit,
    perWeek: body.perWeek ?? facts.perWeek,
    validFrom: body.validFrom ?? facts.validFrom,
    validTo: body.validTo !== undefined ? body.validTo : facts.validTo,
    note: body.note !== undefined ? blank(body.note) : before.note,
  }
  const problems = capacityProblems(next)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const current = { ...facts, note: before.note }
  const changed = (['workCentreKind', 'unit', 'perWeek', 'validFrom', 'validTo', 'note'] as const).filter((field) => next[field] !== current[field])
  if (changed.length === 0) throw new ConflictError('Nothing changed: the row is already so.')
  const today = businessDate(serverClock.now())
  const { result } = await command(caller, { name: 'planning.subcontractCapacity.edit', idempotencyKey, input: { capacityId, ...body }, record: { type: 'SubcontractorCapacity', id: capacityId, expectedVersion: body.version } }, async (tools) => {
    await assertNoConflict(tools, next)
    const updated = await tools.tx.subcontractorCapacity.update({
      where: { id: capacityId },
      data: { workCentreKind: next.workCentreKind as never, unit: next.unit, perWeek: next.perWeek, validFrom: day(next.validFrom), validTo: next.validTo ? day(next.validTo) : null, note: next.note, updatedAt: tools.now },
      select: CAPACITY_COLUMNS,
    })
    tools.audit({ action: 'planning.subcontractCapacity.edit', recordType: 'SubcontractorCapacity', recordId: capacityId, companyId: party.companyId, before: Object.fromEntries(changed.map((field) => [field, current[field]])), after: Object.fromEntries(changed.map((field) => [field, next[field]])) })
    emitChanged(tools, next, party.companyId, 'EDITED')
    return { row: rowView(updated, party, today, true) }
  })
  return result
}

/** DELETE /planning/subcontract-capacity/:capacityId?version=. */
export async function deleteCapacity(caller: CommandCaller, capacityId: string, version: number, idempotencyKey?: string) {
  const { row: before, party } = await capacityTarget(caller, capacityId)
  const facts = capacityRowOf(before)
  const { result } = await command(caller, { name: 'planning.subcontractCapacity.delete', idempotencyKey, input: { capacityId, version, delete: true }, record: { type: 'SubcontractorCapacity', id: capacityId, expectedVersion: version } }, async (tools) => {
    await lockWorkshop(tools, before.partyId)
    await tools.tx.subcontractorCapacity.delete({ where: { id: capacityId }, select: { id: true } })
    tools.audit({ action: 'planning.subcontractCapacity.delete', recordType: 'SubcontractorCapacity', recordId: capacityId, companyId: party.companyId, before: { partyId: facts.partyId, workCentreKind: facts.workCentreKind, unit: facts.unit, perWeek: facts.perWeek, validFrom: facts.validFrom, validTo: facts.validTo }, after: { deleted: true } })
    emitChanged(tools, facts, party.companyId, 'DELETED')
    return { deleted: capacityId }
  })
  return result
}
