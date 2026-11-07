import type { FactoryClient } from '@nexus/factory-db'
import type { ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { businessDate } from '@nexus/factory-domain/core/time'
import { DVR_SIGNER_ROLES } from '@nexus/factory-domain/safety/risk/rules'
import { SAFETY_RISK_MANAGE } from '@nexus/factory-domain/safety/risk/permissions'
import type { CommandTx } from '../../../core/command'
import { words, type ReadContext, type RecordAdapter } from '../../../platform/approvals-out/adapter'

/**
 * Outside signers of a DVR version by link (B-W2b-184 with B-W2b-122; follow-up AP1:02; design plant.risk "Send for
 * signature", links.approve): the RSPP, the territorial RLS or the occupational doctor who is an OUTSIDE contact of a party
 * (SafetyAppointment.outsidePartyId) gets an approval request of kind SIGNATURE on the version AWAITING_SIGNATURES, with the
 * frozen PDF attached (its SHA-256 on the page): one request per outside signer (the request's party is the appointee's).
 * The signer answers by its APPROVAL link with the typed name (signed and timed, the link's evidence on the request).
 *
 * NOT written yet: the RiskAssessmentSignature row. Its method is OFFICE, PAPER or FLOOR_PIN and its guard asks an office
 * signer or recorder for OFFICE and PAPER (…_safety_w2b_guards), so a link signature would be recorded as something it is
 * not (the seal prints "signed on paper (scan on file)"). Schema need: SafetySignMethod LINK + RiskAssessmentSignature
 * .approvalRequestId (LINK ⇔ the request, no office signer). Until then the answer stays on the request (the evidence) and
 * on the version's history (an audit row), and the office records the paper as before.
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
    const label = `${version.assessment.name} · v${version.versionNo}`
    if (version.status !== 'AWAITING_SIGNATURES') return { ...base, partyId: context.partyId, label, held: `Version ${version.versionNo} is ${version.status.toLowerCase().replaceAll('_', ' ')}: it takes no more signatures.` }
    const signers = await outsideSigners(client, version, context.now)
    const chosen = context.partyId ? signers.filter((signer) => signer.partyId === context.partyId) : signers
    if (chosen.length === 0) {
      return { ...base, partyId: context.partyId, label, held: context.partyId ? 'This party is no outside signer of the version who has still to sign.' : 'No outside signer of the version has still to sign: an employee signs in the office.' }
    }
    if (new Set(chosen.map((signer) => signer.partyId)).size > 1) return { ...base, partyId: null, label, held: `Name the signer: ${chosen.map((signer) => `${signer.role} ${signer.name}`).join(', ')}.` }
    const signer = chosen[0]!
    return { ...base, partyId: signer.partyId, label: `${label} · ${signer.role}`, held: null }
  },
  async fileRecords(_client, recordId) {
    return [{ type: RECORD, id: recordId }]
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
  async settle(tools, request) {
    const version = await tools.tx.riskAssessmentVersion.findUnique({ where: { id: request.recordId }, select: { id: true, companyId: true, siteId: true, versionNo: true } })
    if (!version) return null
    const role = await roleOf(tools.tx, version.id, request.partyId, request.answeredAt ?? tools.now)
    // The version's history keeps the outside signer's answer (the evidence is the request's); the signature row waits for
    // SafetySignMethod LINK (see above).
    tools.audit({ action: 'safety.signatureByLink', recordType: RECORD, recordId: version.id, companyId: version.companyId, siteId: version.siteId, after: { versionNo: version.versionNo, role, status: request.status, approvalRequestId: request.id, signatureWritten: false } })
    return { role, signatureWritten: false }
  },
})
