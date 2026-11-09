import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { businessDate } from '@nexus/factory-domain/core/time'
import { completion, DVR_SIGNER_ROLES, dvrSignatureId, dvrSignatureKey, type DvrSignerRole } from '@nexus/factory-domain/safety/risk/rules'
import { SAFETY_RISK_MANAGE } from '@nexus/factory-domain/safety/risk/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
import { sameWords, words, type ReadContext, type RecordAdapter, type RequestRef } from '../../../platform/approvals-out/adapter'
import { dateOf, dayOf } from '../organisation/access'

/**
 * Outside signers of a DVR version by link (B-W2b-184 with B-W2b-122; follow-up AP1:02; design plant.risk "Send for
 * signature", links.approve): the RSPP, the territorial RLS or the occupational doctor who is an OUTSIDE contact of a party
 * (SafetyAppointment.outsidePartyId) gets an approval request of kind SIGNATURE on the version AWAITING_SIGNATURES, with the
 * frozen PDF attached (its SHA-256 on the page): one request per outside signer (the request's party is the appointee's).
 * The signer answers by its APPROVAL link (or in the portal) with the typed name (signed and timed, the evidence on the
 * request).
 *
 * B-W2b-F13b (wave 23): an APPROVED answer is the signature. The settle (the tenant's system scope, after the answer) writes
 * the RiskAssessmentSignature row: method LINK, the approval request, the outside appointee's appointment for the role it
 * signs, the name the signer typed, the Rome day of the answer and the answer's instant, the version's SHA-256 — and, when it
 * was the last signature the version waited for, the version becomes SIGNED with its certain date in the same command (as
 * an office signature does). The seal is kept by the office afterwards (POST /safety/risk/versions/:id/seal: no file store
 * here). A refused answer, a version no longer waiting, or a role signed meanwhile (on paper) writes no row: the version's
 * history says why (`safety.signatureByLink`, signatureWritten false). factory-db's guard holds the same rules.
 */

const RECORD = 'RiskAssessmentVersion'
type Client = FactoryClient | CommandTx

const ROLE_WORDS: Readonly<Record<string, { it: string; en: string }>> = {
  EMPLOYER: { it: 'Datore di lavoro', en: 'Employer' },
  RSPP: { it: 'RSPP', en: 'RSPP (head of the prevention service)' },
  RLS: { it: 'RLS', en: 'RLS (workers\' safety representative)' },
  RLST: { it: 'RLST', en: 'RLST (territorial safety representative)' },
  DOCTOR: { it: 'Medico competente', en: 'Occupational doctor' },
}

const VERSION = {
  id: true,
  companyId: true,
  siteId: true,
  versionNo: true,
  label: true,
  effectiveOn: true,
  sha256: true,
  status: true,
  signersRequired: true,
  fileId: true,
  assessment: { select: { name: true } },
  signatures: { select: { role: true } },
} as const

/** The outside appointees who still sign the version: role, party, contact (in force at its site today). */
async function outsideSigners(client: Client, version: { readonly companyId: string; readonly siteId: string; readonly signersRequired: readonly string[]; readonly signatures: readonly { readonly role: string }[] }, now: Date) {
  const day = new Date(`${businessDate(now)}T00:00:00.000Z`)
  const signed = new Set(version.signatures.map((signature) => signature.role))
  const waiting = version.signersRequired.filter((role) => !signed.has(role) && (DVR_SIGNER_ROLES as readonly string[]).includes(role))
  if (waiting.length === 0) return []
  const rows = await client.safetyAppointment.findMany({
    where: {
      companyId: version.companyId,
      role: { in: waiting as never },
      OR: [{ siteId: version.siteId }, { siteId: null }],
      fromDate: { lte: day },
      AND: [{ OR: [{ untilDate: null }, { untilDate: { gte: day } }] }],
      outsidePartyId: { not: null },
    },
    orderBy: [{ fromDate: 'asc' }, { id: 'asc' }],
    select: { id: true, role: true, outsideName: true, outsidePartyId: true, outsideContactId: true },
  })
  return rows.map((row) => ({ appointmentId: row.id, role: row.role as string, name: row.outsideName ?? '', partyId: row.outsidePartyId!, contactId: row.outsideContactId }))
}

/** The role the request's party signs for (the first of its waiting roles), or null. */
async function roleOf(client: Client, versionId: string, partyId: string, now: Date): Promise<string | null> {
  const version = await client.riskAssessmentVersion.findUnique({ where: { id: versionId }, select: VERSION })
  if (!version) return null
  return (await outsideSigners(client, version, now)).find((signer) => signer.partyId === partyId)?.role ?? null
}

export const SIGNATURE_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: RECORD,
  kinds: ['SIGNATURE'],
  view: SAFETY_RISK_MANAGE,
  ask: SAFETY_RISK_MANAGE,
  async read(client, recordId, _kind, context: ReadContext) {
    const version = await client.riskAssessmentVersion.findUnique({ where: { id: recordId }, select: VERSION })
    if (!version) return null
    const base = { companyId: version.companyId, siteId: version.siteId, thread: null }
    const label = sameWords(`${version.assessment.name} · v${version.versionNo}`)
    if (version.status !== 'AWAITING_SIGNATURES') return { ...base, partyId: context.partyId, label, held: `Version ${version.versionNo} is ${version.status.toLowerCase().replaceAll('_', ' ')}: it takes no more signatures.` }
    const signers = await outsideSigners(client, version, context.now)
    const chosen = context.partyId ? signers.filter((signer) => signer.partyId === context.partyId) : signers
    if (chosen.length === 0) {
      return { ...base, partyId: context.partyId, label, held: context.partyId ? 'This party is no outside signer of the version who has still to sign.' : 'No outside signer of the version has still to sign: an employee signs in the office.' }
    }
    if (new Set(chosen.map((signer) => signer.partyId)).size > 1) return { ...base, partyId: null, label, held: `Name the signer: ${chosen.map((signer) => `${signer.role} ${signer.name}`).join(', ')}.` }
    const signer = chosen[0]!
    const role = ROLE_WORDS[signer.role]
    return { ...base, partyId: signer.partyId, label: { it: `${label.it} · ${role?.it ?? signer.role}`, en: `${label.en} · ${role?.en ?? signer.role}` }, held: null }
  },
  async fileRecords(client, recordId) {
    // The frozen PDF (autoFiles) is a file of the assessment the version freezes (versions.ts), not of the version: without
    // it here every SIGNATURE ask was refused "Not a file of this record" (B-W2b-F13b, found by its live check).
    const version = await client.riskAssessmentVersion.findUnique({ where: { id: recordId }, select: { assessmentId: true } })
    return [{ type: RECORD, id: recordId }, ...(version ? [{ type: 'RiskAssessment', id: version.assessmentId }] : [])]
  },
  async autoFiles(client, recordId) {
    const version = await client.riskAssessmentVersion.findUnique({ where: { id: recordId }, select: { fileId: true } })
    return version ? [version.fileId] : []
  },
  async content(client, request, locale: ApprovalLocale) {
    const version = await client.riskAssessmentVersion.findUnique({ where: { id: request.recordId }, select: VERSION })
    if (!version) return { facts: [], revisedOrder: null }
    const role = await roleOf(client, version.id, request.partyId, request.answeredAt ?? new Date())
    return {
      facts: [
        { label: words(locale, 'Documento', 'Document'), value: `${version.assessment.name} — ${version.label}` },
        { label: words(locale, 'Versione', 'Version'), value: String(version.versionNo) },
        { label: words(locale, 'In vigore dal', 'In force from'), value: version.effectiveOn.toISOString().slice(0, 10) },
        ...(role ? [{ label: words(locale, 'Firmate come', 'You sign as'), value: ROLE_WORDS[role]?.[locale] ?? role }] : []),
        { label: words(locale, 'Impronta SHA-256 del PDF', 'SHA-256 of the PDF'), value: version.sha256 },
      ],
      revisedOrder: null,
    }
  },
  async answerHeld(client, request, locale) {
    const version = await client.riskAssessmentVersion.findUnique({ where: { id: request.recordId }, select: { status: true } })
    if (version?.status !== 'AWAITING_SIGNATURES') return words(locale, 'Questa versione del documento non attende più firme.', 'This version of the document takes no more signatures.')
    return (await roleOf(client, request.recordId, request.partyId, new Date())) ? null : words(locale, 'La vostra firma su questa versione non è più attesa.', 'Your signature on this version is no longer expected.')
  },
  settle: settleSignature,
})

/** Why no signature row is written for an answer (the version's history says it), or null when it is. */
type NotWritten = 'NOT_APPROVED' | 'NO_ANSWER' | 'VERSION_NOT_WAITING' | 'NOT_EXPECTED'

/** The settle of an answered SIGNATURE request (inside the settle's command, the tenant's system scope). */
async function settleSignature(tools: CommandTools, request: RequestRef): Promise<Prisma.InputJsonObject | null> {
  const { tx, now } = tools
  // The version's lock first: an office signature of the same version waits (versions.ts takes the same lock).
  await tx.$queryRaw`SELECT "id" FROM "RiskAssessmentVersion" WHERE "id" = ${request.recordId}::uuid FOR UPDATE`
  const version = await tx.riskAssessmentVersion.findUnique({ where: { id: request.recordId }, select: { ...VERSION, assessmentId: true, signatures: { select: { role: true, signedOn: true } } } })
  if (!version) return null
  const answeredAt = request.answeredAt
  const signer = answeredAt ? (await outsideSigners(tx, version, answeredAt)).find((candidate) => candidate.partyId === request.partyId) ?? null : null
  const role = signer?.role ?? null
  const scope = { companyId: version.companyId, siteId: version.siteId }
  const base = { versionNo: version.versionNo, role, status: request.status, approvalRequestId: request.id }
  const why: NotWritten | null =
    request.status !== 'APPROVED' ? 'NOT_APPROVED' : !answeredAt || !request.typedName?.trim() ? 'NO_ANSWER' : version.status !== 'AWAITING_SIGNATURES' ? 'VERSION_NOT_WAITING' : !signer ? 'NOT_EXPECTED' : null
  if (why !== null || !signer || !answeredAt) {
    tools.audit({ action: 'safety.signatureByLink', recordType: RECORD, recordId: version.id, ...scope, after: { ...base, signatureWritten: false, why } })
    return { role, signatureWritten: false, why }
  }
  const signerRole = signer.role as DvrSignerRole
  const signedOn = businessDate(answeredAt)
  const signatureId = dvrSignatureId(version.id, signerRole)
  const signerName = request.typedName!.trim()
  await tx.riskAssessmentSignature.create({
    data: {
      id: signatureId,
      ...scope,
      versionId: version.id,
      key: dvrSignatureKey(version.id, signerRole),
      role: signerRole,
      appointmentId: signer.appointmentId,
      signerName,
      signedOn: dateOf(signedOn),
      // The instant the signer approved: the signature was given then (the settle may run later).
      signedAt: answeredAt,
      method: 'LINK',
      approvalRequestId: request.id,
      signatureSha256: version.sha256,
      createdAt: now,
    },
    select: { id: true },
  })
  const done = completion(version.signersRequired as DvrSignerRole[], [...version.signatures.map((signature) => ({ role: signature.role as DvrSignerRole, signedOn: dayOf(signature.signedOn) })), { role: signerRole, signedOn }])
  tools.audit({
    action: 'safety.signatureByLink',
    recordType: RECORD,
    recordId: version.id,
    ...scope,
    after: { ...base, signatureWritten: true, signatureId, method: 'LINK', signerName, signedOn, appointmentId: signer.appointmentId, signatureSha256: version.sha256 },
  })
  tools.emit({ type: 'risk_signature.collected', subject: version.assessmentId, ...scope, payload: { assessmentId: version.assessmentId, versionId: version.id, role: signerRole, method: 'LINK', complete: done.complete } })
  if (done.complete) {
    await tx.riskAssessmentVersion.update({ where: { id: version.id }, data: { status: 'SIGNED', certainDateOn: dateOf(done.certainDateOn!), signedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.dvrSigned', recordType: RECORD, recordId: version.id, ...scope, before: { status: 'AWAITING_SIGNATURES' }, after: { status: 'SIGNED', certainDateOn: done.certainDateOn } })
    tools.emit({ type: 'risk_assessment_version.changed', subject: version.assessmentId, ...scope, payload: { assessmentId: version.assessmentId, versionId: version.id, versionNo: version.versionNo, change: 'SIGNED', certainDateOn: done.certainDateOn } })
  }
  return { role, signatureWritten: true, signatureId, complete: done.complete }
}
