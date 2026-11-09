import { createHash } from 'node:crypto'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { questionsOf } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { questionData } from '@nexus/factory-domain/purchasing/questionnaire/schema'
import type { QuestionnaireLinkState } from '@nexus/factory-domain/purchasing/questionnaire/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The questionnaire's reads (B-W2b-172): the versions of a company, the version a link asks (the latest published), the
 * supplier as we hold it (the link page's prefill), the links sent to a supplier and its answers. Every read takes the
 * client of its caller: the office's own scope for the office screens, the tenant's system scope for a link page (the
 * partner role reads no version, no party record and no other link: portal-supply.prisma's grants).
 *
 * The PDF of an answer and the buyer's review task have no column on the answer: the PDF is named by the audit row its
 * command wrote on the answer (`ANSWER_PDF_ACTION`), the task's id is derived from the answer's id (reviewTaskId), as
 * quality's CAPA reminders derive theirs.
 */

type Reader = Pick<FactoryClient, 'supplierQuestionnaire' | 'supplierQuestionnaireResponse' | 'oneOffLink' | 'party' | 'partyTaxIdentity' | 'partyAddress' | 'auditLog' | 'user' | 'storedFile' | 'task'> | CommandTx

export const RECORD = 'SupplierQuestionnaireResponse'
export const VERSION_RECORD = 'SupplierQuestionnaire'
export const ANSWER_PDF_ACTION = 'purchasing.questionnaire.answerPdf'
/** The category of a document uploaded through the questionnaire, until the buyer accepts the answer. */
export const UPLOAD_CATEGORY = 'QUESTIONNAIRE'

/** A UUID (version 8, RFC 9562) derived from a text: the same text, the same id. */
function derivedId(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The buyer's review task of an answer: one per answer, found again from the answer alone. */
export const reviewTaskId = (responseId: string): string => derivedId(`questionnaire-review|${responseId}`)

export const VERSION_COLUMNS = { id: true, companyId: true, revision: true, title: true, questions: true, publishedAt: true, publishedById: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.SupplierQuestionnaireSelect
export type VersionRow = Prisma.SupplierQuestionnaireGetPayload<{ select: typeof VERSION_COLUMNS }>

export const ANSWER_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  questionnaireId: true,
  linkId: true,
  answers: true,
  sites: true,
  subTierSites: true,
  signedName: true,
  signedRole: true,
  submittedAt: true,
  decision: true,
  reviewedAt: true,
  reviewedById: true,
  reviewNote: true,
  version: true,
} as const satisfies Prisma.SupplierQuestionnaireResponseSelect
export type AnswerRow = Prisma.SupplierQuestionnaireResponseGetPayload<{ select: typeof ANSWER_COLUMNS }>

export const versionView = (row: VersionRow) => ({
  id: row.id,
  companyId: row.companyId,
  revision: row.revision,
  title: row.title,
  questions: questionData(questionsOf(row.questions)),
  published: row.publishedAt !== null,
  publishedAt: row.publishedAt === null ? null : toUtcIso(row.publishedAt),
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})
export type VersionView = ReturnType<typeof versionView>

/** The company's latest PUBLISHED version: the one a link asks now; null when it has none. */
export async function currentVersion(client: Reader, companyId: string): Promise<VersionRow | null> {
  return client.supplierQuestionnaire.findFirst({ where: { companyId, publishedAt: { not: null } }, orderBy: { revision: 'desc' }, select: VERSION_COLUMNS })
}

/** Every version of the company, newest first. */
export async function versionsOf(client: Reader, companyId: string): Promise<VersionRow[]> {
  return client.supplierQuestionnaire.findMany({ where: { companyId }, orderBy: { revision: 'desc' }, take: 100, select: VERSION_COLUMNS })
}

/** The supplier as we hold it today: legal name, VAT number in force, registered address in one line, website. */
export async function supplierFacts(client: Reader, partyId: string, today: Date) {
  const party = await client.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true, tradeName: true, website: true, language: true, companyId: true, roles: true, status: true } })
  if (!party) return null
  const day = new Date(`${businessDate(today)}T00:00:00.000Z`)
  const identity = await client.partyTaxIdentity.findFirst({ where: { partyId, validFrom: { lte: day } }, orderBy: { validFrom: 'desc' }, select: { vatNumber: true } })
  const addresses = await client.partyAddress.findMany({ where: { partyId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { kinds: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true } })
  const registered = addresses.find((row) => row.kinds.includes('REGISTERED')) ?? addresses[0] ?? null
  const address = registered ? [registered.line1, registered.line2, `${registered.postalCode} ${registered.city}${registered.province ? ` (${registered.province})` : ''}`, registered.country].filter(Boolean).join(', ') : null
  return { ...party, vatNumber: identity?.vatNumber ?? null, address }
}

export const LINK_COLUMNS = { id: true, companyId: true, partyId: true, email: true, note: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true, createdAt: true, createdById: true, contactId: true } as const satisfies Prisma.OneOffLinkSelect
export type LinkRow = Prisma.OneOffLinkGetPayload<{ select: typeof LINK_COLUMNS }>

/** How the office reads one of its questionnaire links. */
export function linkStateOf(link: Pick<LinkRow, 'expiresAt' | 'uses' | 'maxUses' | 'revokedAt'>, now: Date): QuestionnaireLinkState {
  const state = linkState(link, now)
  if (state === 'REVOKED') return 'WITHDRAWN'
  if (link.uses >= link.maxUses) return 'ANSWERED'
  if (state === 'EXPIRED') return 'EXPIRED'
  return 'OPEN'
}

/** The questionnaire links of a supplier in a company, newest first. */
export async function linksOf(client: Reader, companyId: string, partyId: string): Promise<LinkRow[]> {
  return client.oneOffLink.findMany({ where: { companyId, partyId, purpose: 'SUPPLIER_ONBOARD', recordType: 'Party', recordId: partyId }, orderBy: { createdAt: 'desc' }, take: 50, select: LINK_COLUMNS })
}

/** The answers of a supplier in a company, newest first. */
export async function answersOf(client: Reader, companyId: string, partyId: string): Promise<AnswerRow[]> {
  return client.supplierQuestionnaireResponse.findMany({ where: { companyId, partyId }, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], take: 50, select: ANSWER_COLUMNS })
}

/** The answer PDFs, by answer id (from the audit rows their commands wrote). */
export async function answerPdfsOf(client: Reader, responseIds: readonly string[]): Promise<Map<string, string>> {
  if (responseIds.length === 0) return new Map()
  const rows = await client.auditLog.findMany({ where: { recordType: RECORD, recordId: { in: [...responseIds] }, action: ANSWER_PDF_ACTION }, select: { recordId: true, after: true } })
  const pdfs = new Map<string, string>()
  for (const row of rows) {
    const fileId = (row.after as Record<string, unknown> | null)?.fileId
    if (typeof fileId === 'string') pdfs.set(row.recordId, fileId)
  }
  return pdfs
}

/** Office people's names by id. */
export async function namesOf(client: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName] as const))
}

