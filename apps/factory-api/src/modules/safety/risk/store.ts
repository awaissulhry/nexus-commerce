import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { sameName, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import { SAFETY_RISK_MANAGE, SAFETY_RISK_SIGN } from '@nexus/factory-domain/safety/risk/permissions'
import {
  completion,
  DVR_SIGNER_ROLES,
  dvrSignatureId,
  holdersOf,
  measureDueState,
  movesFor,
  OPEN_MEASURE_STATUSES,
  personKeyOf,
  reviewState,
  type DvrAuthorKind,
  type DvrSignerRole,
  type DvrSignMethod,
  type DvrVersionStatus,
  type MeasureSource,
  type MeasureStatus,
  type SignerAppointment,
} from '@nexus/factory-domain/safety/risk/rules'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { userNames } from '../../people/employees/employees'
import { dayOf, dayOrNull, mayAt } from '../organisation/access'
import { newestFiles } from '../organisation/store'

/**
 * The risk assessment's rows as the screens read them (B-W2b-122): an assessment with its version in force, the one waiting
 * for signatures and its open measures; a version with its frozen PDF, SHA-256, signers (each with the appointment that
 * holds the role, the signature and a paper's scan) and its kept seal; a measure with its roles, owner, due state, cost (the
 * cost grain: the contract drops it without), source and evidence. Shared by the reads and the writes (their answers).
 *
 * Who a signer is (for "nobody signs twice" and "you sign for a role you hold"): the appointee of the role's appointment (a
 * person of the company by id, an outside contact by name), the office user who signed in (OFFICE), the worker's person
 * (FLOOR_PIN). An office user is the appointee when the appointee's person is linked to that user (Employee.userId), else
 * when the user's name is the appointee's (loosely).
 */

type Client = FactoryClient | CommandTx

export const RECORD_ASSESSMENT = 'RiskAssessment'
export const RECORD_VERSION = 'RiskAssessmentVersion'
export const RECORD_SIGNATURE = 'RiskAssessmentSignature'
export const RECORD_MEASURE = 'RiskMeasure'
export const SEAL_KIND = 'DVR_FROZEN'

export const ASSESSMENT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  name: true,
  nextReviewOn: true,
  status: true,
  note: true,
  version: true,
  site: { select: { code: true, name: true, company: { select: { code: true, legalName: true } } } },
} as const satisfies Prisma.RiskAssessmentSelect
export type AssessmentRow = Prisma.RiskAssessmentGetPayload<{ select: typeof ASSESSMENT_SELECT }>

export const SIGNATURE_SELECT = { id: true, role: true, appointmentId: true, signerName: true, signedOn: true, signedAt: true, method: true, signedById: true, signedByWorkerId: true } as const satisfies Prisma.RiskAssessmentSignatureSelect
export type SignatureRow = Prisma.RiskAssessmentSignatureGetPayload<{ select: typeof SIGNATURE_SELECT }>

export const VERSION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  assessmentId: true,
  versionNo: true,
  label: true,
  effectiveOn: true,
  authorKind: true,
  authorName: true,
  changeSummary: true,
  fileId: true,
  sha256: true,
  frozenAt: true,
  frozenById: true,
  signersRequired: true,
  status: true,
  certainDateOn: true,
  signedAt: true,
  withdrawnAt: true,
  withdrawnReason: true,
  version: true,
  file: { select: { originalName: true, sizeBytes: true, contentType: true } },
  signatures: { select: SIGNATURE_SELECT, orderBy: [{ signedAt: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.RiskAssessmentVersionSelect
export type VersionRow = Prisma.RiskAssessmentVersionGetPayload<{ select: typeof VERSION_SELECT }>

export const readAssessment = (client: Client, id: string): Promise<AssessmentRow | null> => client.riskAssessment.findUnique({ where: { id }, select: ASSESSMENT_SELECT }) as Promise<AssessmentRow | null>
export const readVersion = (client: Client, id: string): Promise<VersionRow | null> => client.riskAssessmentVersion.findUnique({ where: { id }, select: VERSION_SELECT }) as Promise<VersionRow | null>

/** The day an instant falls on in Europe/Rome (the guards' "today", the day a version was frozen). */
export const romeDay = (instant: Date): BusinessDate => businessDate(instant)

const placeOf = (row: { readonly companyId: string; readonly siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })

// ---- who signs ------------------------------------------------------------------------------------------------------------

export interface Organisation {
  readonly appointments: readonly SignerAppointment[]
  /** The office user linked to an appointee who is a person of the company, by appointment id. */
  readonly userOf: ReadonlyMap<string, string | null>
}

/** The company's appointments to the roles that sign a DVR (ended ones too: a signature names the one it was given under). */
export async function organisationOf(client: Client, companyId: string): Promise<Organisation> {
  const rows = await client.safetyAppointment.findMany({
    where: { companyId, role: { in: [...DVR_SIGNER_ROLES] } },
    orderBy: [{ fromDate: 'asc' }, { id: 'asc' }],
    select: { id: true, role: true, siteId: true, fromDate: true, untilDate: true, employeeId: true, outsideName: true, employee: { select: { firstName: true, lastName: true, userId: true } } },
  })
  return {
    appointments: rows.map((row) => ({
      id: row.id,
      role: row.role as SafetyRole,
      siteId: row.siteId,
      fromDate: dayOf(row.fromDate),
      untilDate: dayOrNull(row.untilDate),
      employeeId: row.employeeId,
      outsideName: row.outsideName,
      name: row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : (row.outsideName ?? ''),
    })),
    userOf: new Map(rows.map((row) => [row.id, row.employee?.userId ?? null])),
  }
}

export interface Me {
  readonly userId: string
  readonly name: string
  readonly employeeIds: readonly string[]
}

/** The signed-in office person: their name and the people of the companies linked to their account. */
export async function meOf(client: Client, context: OfficeContext): Promise<Me> {
  const user = await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
  const employees = await client.employee.findMany({ where: { userId: context.actorId }, select: { id: true } })
  return { userId: context.actorId, name: user?.displayName ?? '', employeeIds: employees.map((row) => row.id) }
}

export const personsOfMe = (me: Me): string[] => [`user:${me.userId}`, ...me.employeeIds.map((employeeId) => `employee:${employeeId}`)]

/** The signed-in person holds this appointment: their account is the appointee's, else their name is (loosely). */
export function isHolder(me: Me, holder: SignerAppointment, organisation: Organisation): boolean {
  const linked = holder.employeeId ? (organisation.userOf.get(holder.id) ?? null) : null
  if (linked) return linked === me.userId
  if (holder.employeeId && me.employeeIds.includes(holder.employeeId)) return true
  return sameName(me.name, holder.name)
}

/** Who gave each signature of a version (person keys), for "nobody signs twice". */
export async function signedPersons(client: Client, signatures: readonly SignatureRow[], organisation: Organisation): Promise<{ role: DvrSignerRole; name: string; persons: string[] }[]> {
  const users = [...new Set(signatures.filter((row) => row.method === 'OFFICE' && row.signedById).map((row) => row.signedById!))]
  const workers = [...new Set(signatures.filter((row) => row.signedByWorkerId).map((row) => row.signedByWorkerId!))]
  const linked = users.length > 0 ? await client.employee.findMany({ where: { userId: { in: users } }, select: { id: true, userId: true } }) : []
  const workerPeople = workers.length > 0 ? await client.worker.findMany({ where: { id: { in: workers } }, select: { id: true, employeeId: true } }) : []
  return signatures.map((row) => {
    const persons: string[] = []
    const appointment = row.appointmentId ? organisation.appointments.find((candidate) => candidate.id === row.appointmentId) : undefined
    if (appointment) persons.push(personKeyOf(appointment))
    if (row.method === 'OFFICE' && row.signedById) {
      persons.push(`user:${row.signedById}`)
      for (const person of linked.filter((employee) => employee.userId === row.signedById)) persons.push(`employee:${person.id}`)
    }
    if (row.signedByWorkerId) {
      persons.push(`worker:${row.signedByWorkerId}`)
      const employeeId = workerPeople.find((worker) => worker.id === row.signedByWorkerId)?.employeeId
      if (employeeId) persons.push(`employee:${employeeId}`)
    }
    return { role: row.role as DvrSignerRole, name: row.signerName, persons }
  })
}

// ---- versions ------------------------------------------------------------------------------------------------------------

/** The versions of one assessment as the record shows them (newest first), or the ones asked for. */
export async function versionViews(client: Client, context: OfficeContext, rows: readonly VersionRow[], today: BusinessDate) {
  if (rows.length === 0) return []
  const assessmentId = rows[0]!.assessmentId
  const newestSigned = await client.riskAssessmentVersion.findFirst({ where: { assessmentId, status: 'SIGNED' }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
  const organisation = await organisationOf(client, rows[0]!.companyId)
  const me = await meOf(client, context)
  const mySelf = personsOfMe(me)
  const planned = rows.flatMap((row) => (row.signersRequired as DvrSignerRole[]).map((role) => row.signatures.find((signature) => signature.role === role)?.id ?? dvrSignatureId(row.id, role)))
  const scans = await newestFiles(client, RECORD_SIGNATURE, [...new Set([...planned, ...rows.flatMap((row) => row.signatures.map((signature) => signature.id))])])
  const names = await userNames(client, rows.flatMap((row) => [row.frozenById, ...row.signatures.map((signature) => signature.signedById)]))
  const seals = await client.generatedDocument.findMany({
    where: { recordType: RECORD_VERSION, recordId: { in: rows.map((row) => row.id) }, kind: SEAL_KIND },
    orderBy: [{ version: 'desc' }],
    select: { id: true, recordId: true, version: true, language: true, fileId: true, createdAt: true },
  })
  const fromVersions = await client.riskMeasure.findMany({ where: { versionId: { in: rows.map((row) => row.id) } }, select: { versionId: true } })
  const views = []
  for (const row of rows) {
    const required = row.signersRequired as DvrSignerRole[]
    const status = row.status as DvrVersionStatus
    const waiting = status === 'AWAITING_SIGNATURES'
    const signed = await signedPersons(client, row.signatures, organisation)
    const canSign = waiting && mayAt(context, SAFETY_RISK_SIGN, placeOf(row))
    const { missing } = completion(required, row.signatures.map((signature) => ({ role: signature.role as DvrSignerRole, signedOn: dayOf(signature.signedOn) })))
    const seal = seals.find((entry) => entry.recordId === row.id)
    views.push({
      id: row.id,
      assessmentId: row.assessmentId,
      versionNo: row.versionNo,
      label: row.label,
      effectiveOn: dayOf(row.effectiveOn),
      authorKind: row.authorKind as DvrAuthorKind,
      authorName: row.authorName,
      changeSummary: row.changeSummary,
      status,
      inForce: status === 'SIGNED' && newestSigned?.versionNo === row.versionNo,
      superseded: status === 'SIGNED' && newestSigned !== null && newestSigned.versionNo > row.versionNo,
      file: { fileId: row.fileId, name: row.file.originalName, sizeBytes: row.file.sizeBytes, contentType: row.file.contentType },
      sha256: row.sha256,
      frozenAt: row.frozenAt.toISOString(),
      frozenBy: names.get(row.frozenById) ?? null,
      certainDateOn: dayOrNull(row.certainDateOn),
      signedAt: row.signedAt?.toISOString() ?? null,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      withdrawnReason: row.withdrawnReason,
      signers: required.map((role) => {
        const signature = row.signatures.find((entry) => entry.role === role) ?? null
        const signatureId = signature?.id ?? dvrSignatureId(row.id, role)
        const appointment = signature?.appointmentId ? organisation.appointments.find((candidate) => candidate.id === signature.appointmentId) : undefined
        const holder = signature ? (appointment ?? null) : waiting ? (holdersOf(organisation.appointments, role, row.siteId, today)[0] ?? null) : null
        const mine =
          canSign && signature === null && holder !== null && isHolder(me, holder, organisation) && !signed.some((entry) => entry.persons.some((person) => person === personKeyOf(holder) || mySelf.includes(person)))
        return {
          role,
          signatureId,
          holder: holder ? { appointmentId: holder.id, name: holder.name } : null,
          signature: signature
            ? {
                id: signature.id,
                signerName: signature.signerName,
                signedOn: dayOf(signature.signedOn),
                signedAt: signature.signedAt.toISOString(),
                method: signature.method as DvrSignMethod,
                appointmentId: signature.appointmentId,
                recordedBy: signature.signedById ? (names.get(signature.signedById) ?? null) : null,
                scan: scans.get(signature.id) ?? null,
              }
            : null,
          mine,
        }
      }),
      missing: waiting ? missing : [],
      sealed: seal ? { documentId: seal.id, version: seal.version, language: seal.language, fileId: seal.fileId, createdAt: seal.createdAt.toISOString() } : null,
      measures: fromVersions.filter((measure) => measure.versionId === row.id).length,
      version: row.version,
    })
  }
  return views
}

// ---- assessments ---------------------------------------------------------------------------------------------------------

const BRIEF_SELECT = {
  id: true,
  assessmentId: true,
  versionNo: true,
  label: true,
  status: true,
  effectiveOn: true,
  certainDateOn: true,
  authorKind: true,
  authorName: true,
  signersRequired: true,
  signatures: { select: { role: true, signedOn: true } },
} as const satisfies Prisma.RiskAssessmentVersionSelect
type BriefRow = Prisma.RiskAssessmentVersionGetPayload<{ select: typeof BRIEF_SELECT }>

const briefOf = (row: BriefRow) => ({
  id: row.id,
  versionNo: row.versionNo,
  label: row.label,
  status: row.status as DvrVersionStatus,
  effectiveOn: dayOf(row.effectiveOn),
  certainDateOn: dayOrNull(row.certainDateOn),
  authorKind: row.authorKind as DvrAuthorKind,
  authorName: row.authorName,
  signers: (row.signersRequired as DvrSignerRole[]).map((role) => {
    const signature = row.signatures.find((entry) => entry.role === role)
    return { role, signedOn: signature ? dayOf(signature.signedOn) : null }
  }),
})

/** The assessments as the Assessments list shows them (one read for the versions, the open measures and the role sheets). */
export async function assessmentViews(client: Client, context: OfficeContext, rows: readonly AssessmentRow[], today: BusinessDate) {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const versions = (await client.riskAssessmentVersion.findMany({
    where: { assessmentId: { in: ids }, status: { in: ['AWAITING_SIGNATURES', 'SIGNED'] } },
    orderBy: [{ versionNo: 'desc' }],
    select: BRIEF_SELECT,
  })) as BriefRow[]
  const open = await client.riskMeasure.findMany({ where: { assessmentId: { in: ids }, status: { in: [...OPEN_MEASURE_STATUSES] } }, select: { assessmentId: true, dueOn: true } })
  const sheets = await client.roleSheet.findMany({ where: { siteId: { in: [...new Set(rows.map((row) => row.siteId))] }, status: 'ACTIVE' }, select: { siteId: true } })
  return rows.map((row) => {
    const own = versions.filter((version) => version.assessmentId === row.id)
    const inForce = own.find((version) => version.status === 'SIGNED')
    const waiting = own.find((version) => version.status === 'AWAITING_SIGNATURES')
    const measures = open.filter((measure) => measure.assessmentId === row.id)
    const nextReviewOn = dayOrNull(row.nextReviewOn)
    return {
      id: row.id,
      companyId: row.companyId,
      company: { code: row.site.company.code, name: row.site.company.legalName },
      siteId: row.siteId,
      site: { code: row.site.code, name: row.site.name },
      name: row.name,
      status: row.status as 'ACTIVE' | 'ARCHIVED',
      nextReviewOn,
      reviewState: row.status === 'ACTIVE' ? reviewState(nextReviewOn, today) : null,
      note: row.note,
      inForce: inForce ? briefOf(inForce) : null,
      waiting: waiting ? briefOf(waiting) : null,
      openMeasures: measures.length,
      overdueMeasures: measures.filter((measure) => measure.dueOn !== null && dayOf(measure.dueOn) < today).length,
      roles: sheets.filter((sheet) => sheet.siteId === row.siteId).length,
      version: row.version,
      canManage: mayAt(context, SAFETY_RISK_MANAGE, placeOf(row)),
    }
  })
}

// ---- measures ------------------------------------------------------------------------------------------------------------

export const MEASURE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  assessmentId: true,
  title: true,
  risk: true,
  roleSheetIds: true,
  ownerId: true,
  dueOn: true,
  cost: true,
  status: true,
  source: true,
  versionId: true,
  sourceRecordType: true,
  sourceRecordId: true,
  doneAt: true,
  doneById: true,
  evidenceNote: true,
  verifiedAt: true,
  verifiedById: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  assessment: { select: { name: true, site: { select: { code: true, name: true, company: { select: { code: true, legalName: true, currency: true } } } } } },
  dvrVersion: { select: { id: true, versionNo: true, label: true } },
} as const satisfies Prisma.RiskMeasureSelect
export type MeasureRow = Prisma.RiskMeasureGetPayload<{ select: typeof MEASURE_SELECT }>

export const readMeasure = (client: Client, id: string): Promise<MeasureRow | null> => client.riskMeasure.findUnique({ where: { id }, select: MEASURE_SELECT }) as Promise<MeasureRow | null>

/** The measures as the improvement plan shows them (one read for the roles, the names and the evidence). */
export async function measureViews(client: Client, context: OfficeContext, rows: readonly MeasureRow[], today: BusinessDate) {
  if (rows.length === 0) return []
  const sheetIds = [...new Set(rows.flatMap((row) => row.roleSheetIds))]
  const sheets = sheetIds.length > 0 ? await client.roleSheet.findMany({ where: { id: { in: sheetIds } }, select: { id: true, code: true, name: true } }) : []
  const names = await userNames(client, rows.flatMap((row) => [row.ownerId, row.doneById, row.verifiedById]))
  const files = await client.storedFile.findMany({
    where: { recordType: RECORD_MEASURE, recordId: { in: rows.map((row) => row.id) }, status: 'AVAILABLE' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, recordId: true, originalName: true },
  })
  return rows.map((row) => {
    const status = row.status as MeasureStatus
    const dueOn = dayOrNull(row.dueOn)
    const manager = mayAt(context, SAFETY_RISK_MANAGE, placeOf(row))
    const mine = row.ownerId !== null && row.ownerId === context.actorId
    return {
      id: row.id,
      assessmentId: row.assessmentId,
      assessment: row.assessment.name,
      companyId: row.companyId,
      company: { code: row.assessment.site.company.code, name: row.assessment.site.company.legalName },
      siteId: row.siteId,
      site: { code: row.assessment.site.code, name: row.assessment.site.name },
      title: row.title,
      risk: row.risk,
      roleSheets: row.roleSheetIds.map((sheetId) => sheets.find((sheet) => sheet.id === sheetId)).filter((sheet): sheet is { id: string; code: string; name: string } => sheet !== undefined),
      ownerId: row.ownerId,
      owner: row.ownerId ? (names.get(row.ownerId) ?? null) : null,
      mine,
      dueOn,
      dueState: measureDueState({ status, dueOn }, today),
      cost: asMoney('cost', row.cost),
      currency: row.assessment.site.company.currency,
      status,
      source: row.source as MeasureSource,
      sourceVersion: row.dvrVersion ? { id: row.dvrVersion.id, versionNo: row.dvrVersion.versionNo, label: row.dvrVersion.label } : null,
      sourceRecord: row.sourceRecordType && row.sourceRecordId ? { type: row.sourceRecordType, id: row.sourceRecordId } : null,
      doneAt: row.doneAt?.toISOString() ?? null,
      doneBy: row.doneById ? (names.get(row.doneById) ?? null) : null,
      evidenceNote: row.evidenceNote,
      evidence: files.filter((file) => file.recordId === row.id).map((file) => ({ fileId: file.id, name: file.originalName })),
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      verifiedBy: row.verifiedById ? (names.get(row.verifiedById) ?? null) : null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      note: row.note,
      version: row.version,
      canManage: manager,
      canMove: movesFor(status, { manager, owner: mine }),
    }
  })
}

const MAX_PEOPLE = 500

/** The office people who may own a measure at a company: ACTIVE, reading the safety pages there (safety.view). */
export async function ownersAt(client: Client, context: OfficeContext, companyId: string, now: Date) {
  const users = await client.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_PEOPLE, select: { id: true, displayName: true } })
  const owners: { id: string; name: string; me: boolean }[] = []
  for (const user of users) {
    const reader: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, user.id, now), true) }
    if (can(reader, SAFETY_VIEW, { companyId })) owners.push({ id: user.id, name: user.displayName, me: user.id === context.actorId })
  }
  return [...owners.filter((owner) => owner.me), ...owners.filter((owner) => !owner.me)]
}
