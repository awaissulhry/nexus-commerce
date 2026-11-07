import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { ApprovalKind, ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandTools, CommandTx } from '../../core/command'
import type { diffView } from '../../modules/sales/orders/amend'

/**
 * The port between the approvals engine and the modules that own the records (B-W2b-184; plan "each record type registers
 * what it shares: photos, spec, the concession's ask, the amendment's lines old → new"). One adapter per record type
 * (./records.ts lists them); the engine (./ask.ts, ./answer.ts, ./settle.ts) never reads a module's tables itself.
 *
 *   read       the record in the given scope (the office person's for an ask, the tenant's system scope for a page): its
 *              company, site, party (the partner the request goes to), its label, and why it may not be asked now
 *   files      the records whose files the office may send with the request (copied onto the request, shared with the
 *              party: platform/files lets the link and the portal see only those); `autoFiles` the ones that always go
 *              (the DVR version's frozen PDF)
 *   content    what the page shows, in the reader's language (facts; a revised order line by line, old → new)
 *   onAsked    in the ask's command (office): the record names its request (a concession's approvalRequestId)
 *   onAnswered in the answer's command, in the PARTNER's scope (the link or the portal person): the record's own answer
 *              where the partner role may write it (a concession: ACCEPTED or REFUSED, recordedById null)
 *   settle     after the answer, in the tenant's system scope (one command, ./settle.ts): what the office's side does
 *              with it (a revised order's wait cleared)
 */

type Client = FactoryClient | CommandTx

export interface ApprovalRecord {
  readonly companyId: string
  readonly siteId: string | null
  /** The customer, supplier or outside signer asked; null: the record has no partner to ask (held). */
  readonly partyId: string | null
  /** The record as both sides read it ("SO-2026-0042 · revision 2"). */
  readonly label: string
  /** Why it may not be asked now, in words (null: it may). */
  readonly held: string | null
  /** The record whose thread keeps the answer (its own, or the order of a line, the NCR of a concession); null: the request's own. */
  readonly thread: { readonly type: string; readonly id: string } | null
}

/** What the engine knows when it reads a record: the party the office named (a signature: which outside signer), and now. */
export interface ReadContext {
  readonly partyId: string | null
  readonly now: Date
}

export interface Fact {
  readonly label: string
  readonly value: string
}

export type RevisedOrderDiff = ReturnType<typeof diffView>

export interface RevisedOrderContent {
  readonly orderNumber: string
  readonly revision: number
  readonly reason: string
  readonly currency: string
  readonly diff: RevisedOrderDiff
  readonly styles: Readonly<Record<string, { readonly code: string; readonly name: string }>>
  readonly colourways: Readonly<Record<string, { readonly code: string; readonly name: string }>>
}

export interface ApprovalContent {
  readonly facts: readonly Fact[]
  readonly revisedOrder: RevisedOrderContent | null
}

/** The request as an adapter sees it. */
export interface RequestRef {
  readonly id: string
  readonly companyId: string
  readonly kind: ApprovalKind
  readonly recordType: string
  readonly recordId: string
  readonly partyId: string
  readonly status: string
  readonly answer: string | null
  readonly typedName: string | null
  readonly answeredAt: Date | null
}

export interface RecordAdapter {
  readonly recordType: string
  readonly kinds: readonly ApprovalKind[]
  /** Seeing the record's requests (beyond partners.approvals.view). */
  readonly view: Permission
  /** Asking on it and withdrawing (beyond partners.approvals.ask). */
  readonly ask: Permission
  read(client: Client, recordId: string, kind: ApprovalKind, context: ReadContext): Promise<ApprovalRecord | null>
  /** The records whose files may go with the request (the record itself, its order, its NCR …). */
  fileRecords(client: Client, recordId: string): Promise<ReadonlyArray<{ readonly type: string; readonly id: string }>>
  autoFiles?(client: Client, recordId: string): Promise<string[]>
  content(client: Client, request: RequestRef, locale: ApprovalLocale): Promise<ApprovalContent>
  /** Why an OPEN request takes no answer now although it is not past due (the record moved on), in the reader's words. */
  answerHeld?(client: Client, request: RequestRef, locale: ApprovalLocale): Promise<string | null>
  onAsked?(tools: CommandTools, request: RequestRef): Promise<void>
  onAnswered?(tools: CommandTools, request: RequestRef): Promise<void>
  /** Returns what it did (audit), or null when nothing was left to do. */
  settle?(tools: CommandTools, request: RequestRef): Promise<Prisma.InputJsonObject | null>
}

/** The office's (or the system's) answer-time reads: the record's party language for the mails. */
export const words = (locale: ApprovalLocale, it: string, en: string): string => (locale === 'it' ? it : en)
