import type { Prisma } from '@nexus/factory-db'
import type { Problem } from '@nexus/factory-domain/compliance/declarations/rules'
import { USER_INFORMATION_GENERATE } from '@nexus/factory-domain/compliance/user-information/permissions'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { OfficeContext } from '../../../core/context'
import { assertMayWriteDocument, DOCUMENT_SELECT, mayRead, readVisibleDocument, refused, type Reader, type StyleRow } from '../declarations/common'

/**
 * What the user information builder's parts share (B-W2b-258; modules/compliance/user-information). The DoC generator's
 * common parts (B-W2b-257: the office context, the module clock, the guarded command whose database refusals answer 409 in
 * words, the document and style as the caller may see them, who may write a document) are reused as they are; here only
 * what the leaflet adds: its `sections` column, its kind, the writable draft, the company of a new leaflet.
 */

export const KIND = 'USER_INFORMATION' as const
export const LANGUAGES_MAX = 10

export const LEAFLET_SELECT = { ...DOCUMENT_SELECT, sections: true } as const satisfies Prisma.ComplianceDocumentSelect
export type LeafletRow = Prisma.ComplianceDocumentGetPayload<{ select: typeof LEAFLET_SELECT }>

/** The number a generated leaflet carries ("UI-JK100-DE-r3", beside the DoC's "DoC-JK100-DE-r3"). */
export const leafletNumber = (code: string, language: string, revision: number): string => `UI-${code}-${language.toUpperCase()}-r${revision}`.slice(0, 60)

/** A user-information document as the caller may see it (its company and its style's), or not found; a DoC is refused. */
export async function readVisibleLeaflet(db: Reader, context: OfficeContext, documentId: string): Promise<LeafletRow> {
  const visible = await readVisibleDocument(db, context, documentId)
  if (visible.kind !== KIND) throw refused('invalid_state', { code: 'DECLARATION', message: 'This is a Declaration of Conformity: open it in the DoC generator (/compliance/declarations).' })
  return db.complianceDocument.findUniqueOrThrow({ where: { id: documentId }, select: LEAFLET_SELECT })
}

/** A generated leaflet draft this caller may write (`permission`: generate by default). */
export async function writableLeaflet(db: Reader, context: OfficeContext, documentId: string, permission: Permission = USER_INFORMATION_GENERATE): Promise<LeafletRow> {
  const row = await readVisibleLeaflet(db, context, documentId)
  if (row.origin !== 'GENERATED') throw refused('invalid_state', { code: 'SIGNED', message: 'This is a signed leaflet (W1): its PDF is uploaded, never generated or edited here.' })
  if (row.status !== 'DRAFT') throw refused('invalid_state', { code: 'NOT_DRAFT', message: `This leaflet is ${row.status}: it changes no more.` })
  assertMayWriteDocument(context, permission, row.companyId)
  return row
}

/** The company whose leaflet it is: the style's, or (a style of every company) the one named. */
export async function companyOf(db: Reader, context: OfficeContext, style: StyleRow, asked: string | null | undefined, path: string): Promise<string | null> {
  if (style.companyId !== null) {
    if (asked && asked !== style.companyId) throw new ValidationError('The company is not valid.', [{ path, message: `Style ${style.code} is company ${style.companyId}'s: its user information is that company's.` }])
    return style.companyId
  }
  if (!asked) return null
  const company = await db.company.findUnique({ where: { id: asked }, select: { id: true } })
  if (!company || !mayRead(context, company.id)) throw new ValidationError('The company is not valid.', [{ path, message: 'Not a company you reach.' }])
  return company.id
}

/** The problems of a composition as the API's refusal: 409 with each problem at `refusal/<CODE>`. */
export const compositionRefusal = (blocking: readonly Problem[]): DomainError =>
  new DomainError(
    'conflict',
    blocking.map((problem) => problem.message).join(' '),
    blocking.map((problem) => ({ path: `refusal/${problem.code}`, message: problem.message })),
  )

/** The market by its code (one row per code in the tenant), or a 400 at `path`. */
export async function readMarket(db: Reader, code: string, path: string) {
  const market = await db.marketProfile.findFirst({ where: { code }, select: { id: true, code: true, name: true, markings: true, userInfoLanguages: true, companyId: true, switchedOn: true, status: true } })
  if (!market) throw new ValidationError('The market is not valid.', [{ path, message: `There is no market ${code}.` }])
  return market
}

/** Languages as ISO 639 codes, each once (paths under `at`). */
export function languageProblems(languages: readonly string[], at: string): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = []
  languages.forEach((language, index) => {
    if (!/^[a-z]{2,3}$/.test(language)) problems.push({ path: `${at}/${index}`, message: 'A language as an ISO 639 code ("it").' })
    else if (languages.indexOf(language) !== index) problems.push({ path: `${at}/${index}`, message: `${language} is given twice.` })
  })
  return problems
}
