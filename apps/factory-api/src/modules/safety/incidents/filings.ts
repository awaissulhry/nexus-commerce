import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { SAFETY_INCIDENTS_PEOPLE, SAFETY_INCIDENTS_VIEW } from '@nexus/factory-domain/safety/incidents/permissions'
import { certificateRefusal, dueAtOf, fileRefusal, filingsToAdd, filingTypeFor, INAIL_REMINDER_HOURS, INAIL_TIMER_KIND, INCIDENT_LIMITS, refusalOf, reminderPlan, type FilingStatus, type FilingType } from '@nexus/factory-domain/safety/incidents/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { cancelTimerInCommand, cancelTimersOfRecord, setTimerInCommand } from '../../../platform/timers/service'
import { assertVersion } from '../../people/employees/access'
import { actorIdOf, assertMay, assertMayWrite, officeOf, refuse } from './access'

/**
 * The INAIL filings (B-W2b-125; QHS-268 "the INAIL reporting deadline tracker", D.Lgs. 81/2008 art. 18 c.1 r; design
 * plant.incidents tab Authority notice, pop-up "Record INAIL filing"): INAIL filing stays a manual send on the INAIL portal
 * (no API); Nexus records it. safety.incidents.people over the incident, each one command:
 *
 *   POST /safety/incidents/:id/filings                         an injured person's absence: the filing it calls for (from one
 *                                                              day beyond the event's, the statistical communication; over
 *                                                              three days, the insurance report), with the certificate when
 *                                                              it is in hand (DUE, the 48-hour clock started) or WAITING
 *   PATCH /safety/incidents/:id/filings/:filingId              absence days, the certificate's reference and time (DUE now,
 *                                                              or the deadline moved); a statistical one growing past three
 *                                                              days gets the insurance report too, in the same command
 *   POST /safety/incidents/:id/filings/:filingId/file          filed on the INAIL portal: when, INAIL's protocol number
 *   POST /safety/incidents/:id/filings/:filingId/not-needed    decided not needed; …/needed back (WAITING or DUE again)
 *
 * The countdown: dueAt = the certificate's time + 48 hours exactly (the guard's rule); every read gives the server's now and
 * the minutes left (store.ts / protected.ts countdownOf); the screens count down from dueAt. The reminder: each DUE filing
 * keeps date timers (platform/timers, key INAIL_FILING_DUE:-24h, :-4h and at the deadline; rules.ts reminderPlan), fired by
 * the scheduler's `timers.fire` within a minute; ./notices.ts tells the people who keep the filings (bell + digest). A filing
 * filed, not needed or moved cancels or moves its timers in the same command. Answers carry ids, states and deadlines only:
 * never a type, an absence or a certificate (a command's answer is kept in its receipt).
 */

const PEOPLE_WORDS = 'The INAIL filings are kept by the safety roles and HR (safety.incidents.people).'
const TIMER_RECORD = 'InailFiling'

async function placeOf(caller: CommandCaller, incidentId: string) {
  if (!isUuid(incidentId)) throw new NotFoundError('Incident not found.')
  const row = await caller.withClient((db) => db.incident.findUnique({ where: { id: incidentId }, select: { companyId: true, siteId: true } }))
  if (!row) throw new NotFoundError('Incident not found.')
  return row
}

async function lockedIncident(tx: CommandTx, incidentId: string) {
  await tx.$queryRaw`SELECT id FROM "Incident" WHERE id = ${incidentId}::uuid FOR UPDATE`
  const row = await tx.incident.findUnique({ where: { id: incidentId }, select: { id: true, number: true, companyId: true, siteId: true, kind: true, status: true, occurredAt: true } })
  if (!row) throw new NotFoundError('Incident not found.')
  if (row.status !== 'OPEN') refuse(refusalOf('NOT_OPEN'))
  return row
}

type Incident = Awaited<ReturnType<typeof lockedIncident>>

/** Keeps a filing's reminders in step: a DUE filing has its stages' timers, any other none. */
export async function syncReminders(tools: CommandTools, incident: Pick<Incident, 'id' | 'number' | 'companyId' | 'siteId'>, filing: { readonly id: string; readonly status: FilingStatus; readonly dueAt: Date | null }, why: string): Promise<void> {
  const record = { type: TIMER_RECORD, id: filing.id }
  if (filing.status !== 'DUE' || filing.dueAt === null) {
    await cancelTimersOfRecord(tools, record, why)
    return
  }
  const plan = reminderPlan(filing.dueAt, tools.now)
  const keys = new Set(plan.map((stage) => stage.timerKey))
  for (const hours of INAIL_REMINDER_HOURS) {
    const timerKey = hours === 0 ? INAIL_TIMER_KIND : `${INAIL_TIMER_KIND}:-${hours}h`
    if (!keys.has(timerKey)) await cancelTimerInCommand(tools, record, timerKey, 'GONE')
  }
  for (const stage of plan) {
    await setTimerInCommand(tools, { record, recordLabel: incident.number, timerKey: stage.timerKey, dueAt: filing.dueAt, fireAt: stage.fireAt, companyId: incident.companyId, siteId: incident.siteId, payload: { incidentId: incident.id, hoursBefore: stage.hoursBefore } })
  }
}

function filingEvent(tools: CommandTools, incident: Incident, filing: { readonly id: string; readonly status: FilingStatus; readonly dueAt: Date | null }, change: 'ADDED' | 'EDITED' | 'CERTIFICATE' | 'FILED' | 'NOT_NEEDED' | 'NEEDED' | 'RECEIPT'): void {
  tools.emit({ type: 'inail_filing.changed', subject: incident.id, companyId: incident.companyId, siteId: incident.siteId, payload: { incidentId: incident.id, filingId: filing.id, change, status: filing.status, dueAt: filing.dueAt?.toISOString() ?? null } })
}

const toDate = (value: string, path: string): Date => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new ValidationError('The time is not valid.', [{ path: `body/${path}`, message: 'Expected a time.' }])
  return date
}

async function guard(caller: CommandCaller, incidentId: string) {
  const context = officeOf(caller)
  const place = await placeOf(caller, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, place)
  assertMayWrite(context, SAFETY_INCIDENTS_PEOPLE, place, PEOPLE_WORDS)
}

/** Inserts the filings an absence calls for; answers their ids, states and deadlines. */
async function insertFilings(tools: CommandTools, incident: Incident, personId: string, types: readonly FilingType[], fields: { expectedAbsenceDays: number | null; certificateReference: string | null; certificateReceivedAt: Date | null }) {
  const made = []
  for (const type of types) {
    const id = newId()
    const dueAt = fields.certificateReceivedAt ? dueAtOf(fields.certificateReceivedAt) : null
    const status: FilingStatus = fields.certificateReceivedAt ? 'DUE' : 'WAITING_CERTIFICATE'
    await tools.tx.inailFiling.create({
      data: {
        id,
        siteId: incident.siteId,
        incidentId: incident.id,
        incidentPersonId: personId,
        type,
        key: `inail:${personId}:${type}`,
        expectedAbsenceDays: fields.expectedAbsenceDays,
        certificateReference: fields.certificateReference,
        certificateReceivedAt: fields.certificateReceivedAt,
        dueAt,
        status,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    })
    // The audit row names neither the type nor the absence nor the certificate (protected): the state and the deadline.
    tools.audit({ action: 'safety.addInailFiling', recordType: 'InailFiling', recordId: id, companyId: incident.companyId, siteId: incident.siteId, after: { incidentId: incident.id, status, dueAt: dueAt?.toISOString() ?? null } })
    const filing = { id, status, dueAt }
    await syncReminders(tools, incident, filing, 'The filing changed.')
    filingEvent(tools, incident, filing, 'ADDED')
    made.push({ id, version: 1, status, dueAt: dueAt?.toISOString() ?? null })
  }
  return made
}

export interface AddFilingBody {
  readonly incidentPersonId: string
  readonly expectedAbsenceDays: number
  readonly certificateReference?: string | undefined
  readonly certificateReceivedAt?: string | undefined
}

/** POST /safety/incidents/:id/filings. */
export async function addFiling(caller: CommandCaller, incidentId: string, body: AddFilingBody, idempotencyKey?: string) {
  await guard(caller, incidentId)
  const receivedAt = body.certificateReceivedAt ? toDate(body.certificateReceivedAt, 'certificateReceivedAt') : null
  const { result, replayed } = await command(caller, { name: 'safety.addInailFiling', idempotencyKey, input: { incidentId, ...body } }, async (tools) => {
    const incident = await lockedIncident(tools.tx, incidentId)
    const person = isUuid(body.incidentPersonId) ? await tools.tx.incidentPerson.findFirst({ where: { id: body.incidentPersonId, incidentId }, select: { id: true, involvement: true, employeeId: true } }) : null
    if (!person) throw new NotFoundError('Person not found.')
    if (incident.kind !== 'INJURY' || person.involvement !== 'INJURED' || person.employeeId === null) refuse(refusalOf('FILING_NOT_EMPLOYEE', 'incidentPersonId'))
    if (receivedAt) refuse(certificateRefusal(receivedAt, { occurredAt: incident.occurredAt, now: tools.now }))
    const existing = (await tools.tx.inailFiling.findMany({ where: { incidentPersonId: person!.id }, select: { type: true } })).map((row) => row.type as FilingType)
    if (filingTypeFor(body.expectedAbsenceDays) === null) refuse(refusalOf('NO_FILING_NEEDED', 'expectedAbsenceDays'))
    const types = filingsToAdd(body.expectedAbsenceDays, existing)
    if (types.length === 0) refuse(refusalOf('FILING_EXISTS', 'expectedAbsenceDays'))
    const filings = await insertFilings(tools, incident, person!.id, types, { expectedAbsenceDays: body.expectedAbsenceDays, certificateReference: body.certificateReference?.trim().slice(0, INCIDENT_LIMITS.certificate) || null, certificateReceivedAt: receivedAt })
    return { filings }
  })
  return { ...result, replayed }
}

const FILING_ROW = { id: true, incidentPersonId: true, type: true, status: true, expectedAbsenceDays: true, actualAbsenceDays: true, certificateReference: true, certificateReceivedAt: true, dueAt: true, version: true } as const

async function lockedFiling(tx: CommandTx, incidentId: string, filingId: string, version: number) {
  if (!isUuid(filingId)) throw new NotFoundError('Filing not found.')
  await tx.$queryRaw`SELECT id FROM "InailFiling" WHERE id = ${filingId}::uuid FOR UPDATE`
  const row = await tx.inailFiling.findFirst({ where: { id: filingId, incidentId }, select: FILING_ROW })
  if (!row) throw new NotFoundError('Filing not found.')
  assertVersion('filing', row.version, version)
  if (row.status === 'FILED') refuse(refusalOf('FILING_FILED'))
  return row
}

export interface EditFilingBody {
  readonly version: number
  readonly expectedAbsenceDays?: number | null | undefined
  readonly actualAbsenceDays?: number | null | undefined
  readonly certificateReference?: string | null | undefined
  readonly certificateReceivedAt?: string | undefined
}

/** PATCH /safety/incidents/:id/filings/:filingId. */
export async function editFiling(caller: CommandCaller, incidentId: string, filingId: string, body: EditFilingBody, idempotencyKey?: string) {
  await guard(caller, incidentId)
  const receivedAt = body.certificateReceivedAt ? toDate(body.certificateReceivedAt, 'certificateReceivedAt') : null
  const { result, replayed } = await command(caller, { name: 'safety.editInailFiling', idempotencyKey, input: { incidentId, filingId, ...body } }, async (tools) => {
    const incident = await lockedIncident(tools.tx, incidentId)
    const row = await lockedFiling(tools.tx, incidentId, filingId, body.version)
    if (receivedAt) refuse(certificateRefusal(receivedAt, { occurredAt: incident.occurredAt, now: tools.now }))
    const certificateMoved = receivedAt !== null && receivedAt.getTime() !== row.certificateReceivedAt?.getTime()
    const status: FilingStatus = certificateMoved && row.status === 'WAITING_CERTIFICATE' ? 'DUE' : (row.status as FilingStatus)
    const dueAt = certificateMoved ? dueAtOf(receivedAt!) : row.dueAt
    const data = {
      ...(body.expectedAbsenceDays !== undefined ? { expectedAbsenceDays: body.expectedAbsenceDays } : {}),
      ...(body.actualAbsenceDays !== undefined ? { actualAbsenceDays: body.actualAbsenceDays } : {}),
      ...(body.certificateReference !== undefined ? { certificateReference: body.certificateReference?.trim().slice(0, INCIDENT_LIMITS.certificate) || null } : {}),
      ...(certificateMoved ? { certificateReceivedAt: receivedAt, dueAt, status } : {}),
    }
    if (Object.keys(data).length === 0) throw new ValidationError('Change at least one thing.', [{ path: 'body', message: 'Nothing to change.' }])
    await tools.tx.inailFiling.update({ where: { id: row.id }, data: { ...data, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.editInailFiling', recordType: 'InailFiling', recordId: row.id, companyId: incident.companyId, siteId: incident.siteId, before: { status: row.status, dueAt: row.dueAt?.toISOString() ?? null }, after: { status, dueAt: dueAt?.toISOString() ?? null, changed: Object.keys(data) } })
    const filing = { id: row.id, status, dueAt }
    // Reminders move only with the deadline or the state (an edit of the days never fires a stage twice).
    if (certificateMoved) await syncReminders(tools, incident, filing, 'The filing changed.')
    filingEvent(tools, incident, filing, certificateMoved ? 'CERTIFICATE' : 'EDITED')
    // A statistical communication whose absence grows past three days: the insurance report too (B-W2b-91), the new
    // certificate's time when this change brought one.
    const days = body.actualAbsenceDays ?? body.expectedAbsenceDays ?? null
    let added: { id: string; version: number; status: FilingStatus; dueAt: string | null }[] = []
    if (days !== null && row.type === 'STATISTICAL') {
      const existing = (await tools.tx.inailFiling.findMany({ where: { incidentPersonId: row.incidentPersonId }, select: { type: true } })).map((other) => other.type as FilingType)
      const types = filingsToAdd(days, existing).filter((type) => type === 'INSURANCE')
      if (types.length > 0) added = await insertFilings(tools, incident, row.incidentPersonId, types, { expectedAbsenceDays: days, certificateReference: receivedAt ? (body.certificateReference?.trim() || null) : null, certificateReceivedAt: receivedAt })
    }
    return { filing: { id: row.id, version: row.version + 1, status, dueAt: dueAt?.toISOString() ?? null }, added }
  })
  return { ...result, replayed }
}

/** POST /safety/incidents/:id/filings/:filingId/file: filed on the INAIL portal (a manual send), recorded here. */
export async function fileFiling(caller: CommandCaller, incidentId: string, filingId: string, body: { readonly version: number; readonly filedAt: string; readonly protocolNumber: string }, idempotencyKey?: string) {
  await guard(caller, incidentId)
  const filedAt = toDate(body.filedAt, 'filedAt')
  const { result, replayed } = await command(caller, { name: 'safety.fileInailFiling', idempotencyKey, input: { incidentId, filingId, ...body } }, async (tools) => {
    const incident = await lockedIncident(tools.tx, incidentId)
    const row = await lockedFiling(tools.tx, incidentId, filingId, body.version)
    if (row.status === 'NOT_NEEDED') refuse(refusalOf('FILING_NOT_NEEDED_NOW'))
    refuse(fileRefusal({ status: row.status as FilingStatus, certificateReceivedAt: row.certificateReceivedAt }, filedAt, tools.now))
    await tools.tx.inailFiling.update({ where: { id: row.id }, data: { status: 'FILED', filedAt, filedById: actorIdOf(tools.context), protocolNumber: body.protocolNumber.trim().slice(0, INCIDENT_LIMITS.protocol), version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.fileInailFiling', recordType: 'InailFiling', recordId: row.id, companyId: incident.companyId, siteId: incident.siteId, before: { status: row.status }, after: { status: 'FILED', filedAt: filedAt.toISOString(), late: row.dueAt !== null && filedAt.getTime() > row.dueAt.getTime() } })
    const filing = { id: row.id, status: 'FILED' as const, dueAt: row.dueAt }
    await syncReminders(tools, incident, filing, 'The filing was recorded as filed on the INAIL portal.')
    filingEvent(tools, incident, filing, 'FILED')
    return { filing: { id: row.id, version: row.version + 1, status: 'FILED' as const, dueAt: row.dueAt?.toISOString() ?? null } }
  })
  return { ...result, replayed }
}

/** POST …/not-needed | …/needed. */
export async function setNeeded(caller: CommandCaller, incidentId: string, filingId: string, needed: boolean, body: { readonly version: number }, idempotencyKey?: string) {
  await guard(caller, incidentId)
  const { result, replayed } = await command(caller, { name: needed ? 'safety.needInailFiling' : 'safety.skipInailFiling', idempotencyKey, input: { incidentId, filingId, ...body } }, async (tools) => {
    const incident = await lockedIncident(tools.tx, incidentId)
    const row = await lockedFiling(tools.tx, incidentId, filingId, body.version)
    if (needed && row.status !== 'NOT_NEEDED') refuse(refusalOf('FILING_NOT_NEEDED_NOW'))
    const status: FilingStatus = needed ? (row.certificateReceivedAt ? 'DUE' : 'WAITING_CERTIFICATE') : 'NOT_NEEDED'
    const data = needed ? { status, notNeededAt: null, notNeededById: null } : { status, notNeededAt: tools.now, notNeededById: actorIdOf(tools.context) }
    if (!needed && row.status === 'NOT_NEEDED') {
      // Marked not needed already: nothing changes (the audit row says it was asked again).
      tools.audit({ action: 'safety.skipInailFiling', recordType: 'InailFiling', recordId: row.id, companyId: incident.companyId, siteId: incident.siteId, after: { status: 'NOT_NEEDED', already: true } })
      return { filing: { id: row.id, version: row.version, status: 'NOT_NEEDED' as FilingStatus, dueAt: row.dueAt?.toISOString() ?? null } }
    }
    await tools.tx.inailFiling.update({ where: { id: row.id }, data: { ...data, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: needed ? 'safety.needInailFiling' : 'safety.skipInailFiling', recordType: 'InailFiling', recordId: row.id, companyId: incident.companyId, siteId: incident.siteId, before: { status: row.status }, after: { status } })
    const filing = { id: row.id, status, dueAt: row.dueAt }
    await syncReminders(tools, incident, filing, 'The filing was marked not needed.')
    filingEvent(tools, incident, filing, needed ? 'NEEDED' : 'NOT_NEEDED')
    return { filing: { id: row.id, version: row.version + 1, status, dueAt: row.dueAt?.toISOString() ?? null } }
  })
  return { ...result, replayed }
}
