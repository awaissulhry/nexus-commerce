import type { FastifyRequest } from 'fastify'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { SAFETY_INCIDENTS_PEOPLE, SAFETY_INCIDENTS_VIEW } from '@nexus/factory-domain/safety/incidents/permissions'
import { countdownOf, filingStateOf, INCIDENT_LAW, INCIDENT_LIMITS, INAIL_RULE, INAIL_RULE_WORDS, PROTECTED_LAW, type BodyPart, type BodySide, type FilingStatus, type FilingType, type InjuryNature, type Involvement } from '@nexus/factory-domain/safety/incidents/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { assertMay, assertMayWrite, may, officeOf, placeCaller } from './access'
import { userNames } from './store'

/**
 * Protected data (B-W2b-125; QHS-270 "injury details as protected data", GDPR art. 9; design plant.incidents "People involved:
 * visible to safety and HR roles; every view recorded", "Person and injury columns only for safety and HR roles, behind a
 * 'Show people' toggle that is recorded"; B-W2b-91's view log): the ONLY reads of IncidentPerson and InailFiling values.
 * safety.incidents.people over the incident; each read is a command that writes the view first (ProtectedView: who looked, at
 * whose data, when), and the values are read AFTER that command commits and returned as they stand: a command's answer is
 * kept in its receipt, so no value ever enters one (B-W2b-77's rule for figures behind a gate).
 *
 *   POST /safety/incidents/:id/people/open                       the people and their injuries (INCIDENT_PERSON, OPEN, per person)
 *   POST /safety/incidents/:id/filings/open                      the INAIL filings (INAIL_FILING, OPEN, per filing)
 *   POST /safety/incidents/people                                "Show people" on the list (INCIDENT_PEOPLE_LIST, LIST, per company)
 *   POST /safety/incidents/:id/filings/:filingId/receipt/:fileId/open   INAIL's receipt (INAIL_FILING, COPY), a presigned GET
 *
 * A view is recorded for an office user only (ProtectedView.viewerId); nothing here is open to the floor or a partner.
 */

const PEOPLE_WORDS = 'The people involved and the INAIL filings are seen by the safety roles and HR (safety.incidents.people), each view recorded.'

async function incidentFor(caller: CommandCaller, context: OfficeContext, incidentId: string) {
  if (!isUuid(incidentId)) throw new NotFoundError('Incident not found.')
  const row = await caller.withClient((db) => db.incident.findUnique({ where: { id: incidentId }, select: { id: true, number: true, companyId: true, siteId: true, occurredAt: true } }))
  if (!row) throw new NotFoundError('Incident not found.')
  assertMay(context, SAFETY_INCIDENTS_VIEW, row)
  assertMayWrite(context, SAFETY_INCIDENTS_PEOPLE, row, PEOPLE_WORDS)
  return row
}

interface ViewRow {
  readonly recordType: 'INCIDENT_PERSON' | 'INAIL_FILING' | 'INCIDENT_PEOPLE_LIST'
  readonly recordId: string | null
  readonly employeeId: string | null
  readonly companyId: string
  readonly what: 'OPEN' | 'LIST' | 'COPY'
}

/** Writes the views (one command: the view log and its audit row on the incident). */
async function recordViews(caller: CommandCaller, context: OfficeContext, name: 'safety.openIncidentPeople' | 'safety.openInailFilings' | 'safety.showIncidentPeople' | 'safety.openInailReceipt', audited: { readonly id: string; readonly companyId: string; readonly siteId: string }[], views: readonly ViewRow[]): Promise<void> {
  await command(caller, { name, input: { incidents: audited.map((incident) => incident.id), views: views.length } }, async (tools) => {
    await tools.tx.protectedView.createMany({ data: views.map((view) => ({ id: newId(), companyId: view.companyId, recordType: view.recordType, recordId: view.recordId, employeeId: view.employeeId, what: view.what, viewerId: context.actorId, viewedAt: tools.now })) })
    // The audit row names the incident and how many views, never a person (the view log keeps whose data it was).
    for (const incident of audited) tools.audit({ action: name, recordType: 'Incident', recordId: incident.id, companyId: incident.companyId, siteId: incident.siteId, after: { what: views[0]?.what ?? 'OPEN', views: views.length } })
    return { recorded: views.length }
  })
}

const PERSON_VALUES = {
  id: true,
  incidentId: true,
  involvement: true,
  employeeId: true,
  outsideName: true,
  bodyParts: true,
  bodySide: true,
  nature: true,
  firstAidGiven: true,
  sentToHospital: true,
  version: true,
  employee: { select: { displayName: true } },
  _count: { select: { inailFilings: true } },
} as const

function personOut(row: { id: string; involvement: string; employeeId: string | null; outsideName: string | null; bodyParts: string[]; bodySide: string | null; nature: string | null; firstAidGiven: boolean; sentToHospital: boolean; version: number; employee: { displayName: string } | null; _count: { inailFilings: number } }) {
  return {
    id: row.id,
    involvement: row.involvement as Involvement,
    employee: row.employeeId ? { id: row.employeeId, name: row.employee?.displayName ?? '' } : null,
    outsideName: row.outsideName,
    bodyParts: row.bodyParts as BodyPart[],
    bodySide: row.bodySide as BodySide | null,
    nature: row.nature as InjuryNature | null,
    firstAidGiven: row.firstAidGiven,
    sentToHospital: row.sentToHospital,
    filings: row._count.inailFilings,
    version: row.version,
  }
}

/** POST /safety/incidents/:id/people/open. */
export async function openPeople(caller: CommandCaller, incidentId: string) {
  const context = officeOf(caller)
  const incident = await incidentFor(caller, context, incidentId)
  const ids = await caller.withClient((db) => db.incidentPerson.findMany({ where: { incidentId }, select: { id: true, employeeId: true } }))
  if (ids.length > 0) await recordViews(caller, context, 'safety.openIncidentPeople', [incident], ids.map((person) => ({ recordType: 'INCIDENT_PERSON', recordId: person.id, employeeId: person.employeeId, companyId: incident.companyId, what: 'OPEN' })))
  // Read after the views are recorded; a person added meanwhile is left out (it was not recorded as seen).
  const seen = new Set(ids.map((person) => person.id))
  const rows = await caller.withClient((db) => db.incidentPerson.findMany({ where: { incidentId, id: { in: [...seen] } }, select: PERSON_VALUES, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  return { incident: { id: incident.id, number: incident.number }, people: rows.map(personOut), recorded: ids.length > 0, law: PROTECTED_LAW }
}

const FILING_VALUES = {
  id: true,
  incidentPersonId: true,
  type: true,
  status: true,
  expectedAbsenceDays: true,
  actualAbsenceDays: true,
  certificateReference: true,
  certificateReceivedAt: true,
  dueAt: true,
  filedAt: true,
  filedById: true,
  protocolNumber: true,
  notNeededAt: true,
  notNeededById: true,
  version: true,
  person: { select: { employeeId: true, outsideName: true, employee: { select: { displayName: true } } } },
} as const

/** POST /safety/incidents/:id/filings/open. */
export async function openFilings(caller: CommandCaller, incidentId: string) {
  const context = officeOf(caller)
  const incident = await incidentFor(caller, context, incidentId)
  const ids = await caller.withClient((db) => db.inailFiling.findMany({ where: { incidentId }, select: { id: true, person: { select: { employeeId: true } } } }))
  if (ids.length > 0) await recordViews(caller, context, 'safety.openInailFilings', [incident], ids.map((filing) => ({ recordType: 'INAIL_FILING', recordId: filing.id, employeeId: filing.person.employeeId, companyId: incident.companyId, what: 'OPEN' })))
  const now = new Date()
  const rows = await caller.withClient((db) => db.inailFiling.findMany({ where: { incidentId, id: { in: ids.map((filing) => filing.id) } }, select: FILING_VALUES, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  const receipts = await caller.withClient((db) => db.storedFile.findMany({ where: { recordType: 'InailFiling', recordId: { in: rows.map((row) => row.id) }, status: 'AVAILABLE' }, select: { id: true, recordId: true, originalName: true }, orderBy: [{ availableAt: 'desc' }, { id: 'desc' }] }))
  const users = await caller.withClient((db) => userNames(db, rows.flatMap((row) => [row.filedById, row.notNeededById])))
  return {
    incident: { id: incident.id, number: incident.number, occurredAt: incident.occurredAt.toISOString() },
    now: now.toISOString(),
    filings: rows.map((row) => ({
      id: row.id,
      personId: row.incidentPersonId,
      person: { employeeId: row.person.employeeId, name: row.person.employee?.displayName ?? row.person.outsideName ?? '' },
      type: row.type as FilingType,
      status: row.status as FilingStatus,
      state: filingStateOf({ status: row.status as FilingStatus, dueAt: row.dueAt }, now),
      expectedAbsenceDays: row.expectedAbsenceDays,
      actualAbsenceDays: row.actualAbsenceDays,
      certificateReference: row.certificateReference,
      certificateReceivedAt: row.certificateReceivedAt?.toISOString() ?? null,
      dueAt: row.dueAt?.toISOString() ?? null,
      countdown: row.status === 'DUE' && row.dueAt ? countdownOf(row.dueAt, now) : null,
      filedAt: row.filedAt?.toISOString() ?? null,
      filedBy: row.filedById ? (users.get(row.filedById) ?? null) : null,
      protocolNumber: row.protocolNumber,
      notNeededAt: row.notNeededAt?.toISOString() ?? null,
      notNeededBy: row.notNeededById ? (users.get(row.notNeededById) ?? null) : null,
      receipt: (() => {
        const file = receipts.find((receipt) => receipt.recordId === row.id)
        return file ? { fileId: file.id, name: file.originalName } : null
      })(),
      version: row.version,
    })),
    recorded: ids.length > 0,
    rule: { law: INCIDENT_LAW, ...INAIL_RULE, words: INAIL_RULE_WORDS },
  }
}

/** POST /safety/incidents/people: "Show people" on the list's page (the incidents the caller may see the people of). */
export async function showPeople(caller: CommandCaller, body: { readonly incidentIds: readonly string[] }) {
  const context = officeOf(caller)
  if (body.incidentIds.length > INCIDENT_LIMITS.peopleList) throw new ValidationError(`At most ${INCIDENT_LIMITS.peopleList} incidents at once.`, [{ path: 'body/incidentIds', message: `At most ${INCIDENT_LIMITS.peopleList}.` }])
  const asked = [...new Set(body.incidentIds.filter(isUuid))]
  const incidents = (await caller.withClient((db) => db.incident.findMany({ where: { id: { in: asked } }, select: { id: true, companyId: true, siteId: true } }))).filter((row) => may(context, SAFETY_INCIDENTS_PEOPLE, row))
  if (incidents.length === 0) return { incidents: [], recorded: false }
  const companies = [...new Set(incidents.map((row) => row.companyId))]
  await recordViews(caller, context, 'safety.showIncidentPeople', incidents, companies.map((companyId) => ({ recordType: 'INCIDENT_PEOPLE_LIST', recordId: null, employeeId: null, companyId, what: 'LIST' })))
  const rows = await caller.withClient((db) => db.incidentPerson.findMany({ where: { incidentId: { in: incidents.map((row) => row.id) } }, select: PERSON_VALUES, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  return { incidents: incidents.map((incident) => ({ id: incident.id, people: rows.filter((row) => row.incidentId === incident.id).map(personOut) })), recorded: true }
}

/** POST /safety/incidents/:id/filings/:filingId/receipt/:fileId/open: INAIL's receipt, a COPY recorded, then a presigned GET. */
export async function openReceipt(request: FastifyRequest, incidentId: string, filingId: string, fileId: string) {
  const context = officeOf(request)
  const incident = await incidentFor(request, context, incidentId)
  const filing = isUuid(filingId) ? await request.withClient((db) => db.inailFiling.findFirst({ where: { id: filingId, incidentId }, select: { id: true, person: { select: { employeeId: true } } } })) : null
  if (!filing) throw new NotFoundError('Filing not found.')
  const file = isUuid(fileId) ? await request.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: 'InailFiling', recordId: filingId, status: 'AVAILABLE' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  await recordViews(request, context, 'safety.openInailReceipt', [incident], [{ recordType: 'INAIL_FILING', recordId: filing.id, employeeId: filing.person.employeeId, companyId: incident.companyId, what: 'COPY' }])
  const reader = placeCaller(request, context.tenantId, incident, [FILES_READ])
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, file.id, { viaModule: true }) }
}
