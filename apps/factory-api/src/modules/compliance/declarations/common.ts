import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DECLARATIONS_VIEW } from '@nexus/factory-domain/compliance/declarations/permissions'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { mayWrite } from '../../product/materials/store'
import { officeOf as labelsOfficeOf } from '../labels/store'
import { assertMayKeep, namesFor } from '../register-of-rules/common'

/**
 * What the DoC generator's parts share (B-W2b-257; modules/compliance/declarations): the office context, the module clock,
 * the document as the caller may see it (its style's company through compliance.certificates.view), who may write it (a
 * document of every company needs a grant over every company), the command on the module clock, and the last line of
 * defence that turns the database's own refusal (B-W2b-218's `compliance: …` guards, a unique key, a reference) into a 409
 * in words, never a 500 (register-of-rules' `rulesGuarded`).
 */

export type Reader = FactoryClient | CommandTx

export const officeOf = (caller: CommandCaller): OfficeContext => labelsOfficeOf(caller)

let clock: Clock = serverClock
/** Test only: the module clock ("today", the commands' time). */
export function useDeclarationsClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const declarationsClock = (): Clock => clock
export const todayOf = (): BusinessDate => businessDate(clock.now())

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause
/** The guards whose sentences a person may read: the compliance tables', the generated documents', the files'. */
const SPOKEN = /^(compliance|documents|files|numbering): /

/**
 * Runs a write; the database's refusal becomes a 409 in words (never a 500): a guard's own sentence (B-W2b-218's
 * `compliance: …`, the generated documents' `documents: …`), a unique key (`taken`), a reference that refuses.
 */
export async function guarded<T>(work: () => Promise<T>, words: { readonly taken?: string } = {}): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = causeOf(error)
    const code = (error as { code?: unknown } | null)?.code
    const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : null
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001' || cause?.originalCode === 'P0001') && message && SPOKEN.test(message)) {
      const words = message.replace(SPOKEN, '')
      const sentence = `${words.charAt(0).toUpperCase()}${words.slice(1)}`
      throw new DomainError('conflict', sentence.endsWith('.') ? sentence : `${sentence}.`, [{ path: 'refusal/DATABASE', message: sentence }])
    }
    if (code === 'P2002' || cause?.originalCode === '23505') throw new DomainError('conflict', words.taken ?? 'This clashes with a row that exists already.')
    if (code === 'P2003' || cause?.originalCode === '23503') throw new DomainError('conflict', 'Another record still names this one.')
    throw error
  }
}

/** command() on the module clock, guarded: a database refusal answers 409 in words. */
export function declarationsCommand<Result>(caller: CommandCaller, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>, words: { readonly taken?: string } = {}) {
  return guarded(() => runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock }), words)
}

/** A refusal in words, with its code (`refusal/<CODE>`), as the other compliance modules answer it. */
export const refused = (kind: 'conflict' | 'invalid_state', refusal: { readonly code: string; readonly message: string }): DomainError =>
  new DomainError(kind, refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }])

export const assertMayWriteDocument = (context: OfficeContext, permission: Permission, companyId: string | null): void => assertMayKeep(context, permission, companyId, 'A declaration')
export const mayWriteDocument = (context: OfficeContext, permission: Permission, companyId: string | null): boolean => mayWrite(actorOf(context), permission, companyId)

/** May the caller read a record of this company (null: every company's)? */
export const mayRead = (context: OfficeContext, companyId: string | null): boolean => can(actorOf(context), DECLARATIONS_VIEW, companyId === null ? {} : { companyId })

export const DOCUMENT_SELECT = {
  id: true,
  companyId: true,
  styleId: true,
  kind: true,
  language: true,
  revision: true,
  number: true,
  status: true,
  certificateId: true,
  makerPartyId: true,
  makerName: true,
  makerAddress: true,
  productIdentification: true,
  standards: true,
  signedByName: true,
  signedByFunction: true,
  signedPlace: true,
  signedOn: true,
  issuedAt: true,
  origin: true,
  content: true,
  translationOfId: true,
  translationStatus: true,
  translationCheckedAt: true,
  translationCheckedById: true,
  marketCode: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ComplianceDocumentSelect
export type DocumentRow = Prisma.ComplianceDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>

export const STYLE_SELECT = {
  id: true,
  code: true,
  name: true,
  nameI18n: true,
  status: true,
  companyId: true,
  brandPartyId: true,
  soldUnderOurName: true,
  ppeCategory: true,
  ppeStandard: true,
  ppeClass: true,
  sizes: true,
} as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>

/** The style as the caller may see it (compliance.certificates.view over its company), or not found. */
export async function readVisibleStyle(db: Reader, context: OfficeContext, styleId: string): Promise<StyleRow> {
  const style = isUuid(styleId) ? await db.style.findUnique({ where: { id: styleId }, select: STYLE_SELECT }) : null
  if (!style || !mayRead(context, style.companyId)) throw new NotFoundError('There is no such style.')
  return style
}

/** The document as the caller may see it (its company, and its style's), or not found. */
export async function readVisibleDocument(db: Reader, context: OfficeContext, documentId: string): Promise<DocumentRow> {
  const row = isUuid(documentId) ? await db.complianceDocument.findUnique({ where: { id: documentId }, select: DOCUMENT_SELECT }) : null
  if (!row || !mayRead(context, row.companyId)) throw new NotFoundError('There is no such declaration.')
  const style = await db.style.findUnique({ where: { id: row.styleId }, select: { companyId: true } })
  if (!style || !mayRead(context, style.companyId)) throw new NotFoundError('There is no such declaration.')
  return row
}

export { namesFor }

/** Rome's day of an instant. */
export const dayOf = (value: Date): BusinessDate => businessDate(value)
/** A `date` column's value as the day it holds. */
export const dateDay = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dateOf = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
