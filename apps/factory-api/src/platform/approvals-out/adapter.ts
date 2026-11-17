import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { ApprovalKind, ApprovalLocale, Words } from '@nexus/factory-domain/approvals-out/kinds'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { ReverseEffect, ReverseFacts } from '@nexus/factory-domain/production-brand/override'
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
 *              with it (a revised order's wait cleared); B-PR-30a: also after the office decided it FOR the party (in the
 *              office's own command, ./override.ts — the answer then names `decidedForPartyById`, no portal person, no link)
 *   reverseFacts / reverse   B-PR-30b: what putting the party's answer back would do to the record (the live cut of the lines
 *              it is about, a gate it passed, a counter-offer carried out, or why the record keeps it: `held`), and doing it,
 *              in the office's command (./override.ts). An adapter without them: the answer is only marked put back.
 */

type Client = FactoryClient | CommandTx

export interface ApprovalRecord {
  readonly companyId: string
  readonly siteId: string | null
  /** The customer, supplier or outside signer asked; null: the record has no partner to ask (held). */
  readonly partyId: string | null
  /**
   * The record as both sides read it, in both languages ("SO-2026-0042 · revisione 2" / "SO-2026-0042 · revision 2"): the
   * screens show the reader's (B-W2b-F16: `words` in the API), a mail and a thread message the party's.
   */
  readonly label: Words
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

/** B-PR-30b: what a record says about putting its party's answer back (factory-domain production-brand/override reverseVerdict). */
export interface RecordReverseFacts extends Pick<ReverseFacts, 'cut' | 'passedGate' | 'applied' | 'sampleKind'> {
  /** Why the record keeps the answer as it is (its own words, the office reads them; null: it may be put back). */
  readonly held: { readonly code: string; readonly words: Words } | null
}

/** B-PR-30b: what a reversal asks of the record, in the office's command. */
export interface ReverseInput {
  readonly effects: readonly ReverseEffect[]
  /** The office person who put the answer back (the one who asked for it, when a second person granted it). */
  readonly actorId: string
  /** ASK_AGAIN: the new request's id and its APPROVAL link (its token minted outside the command; none: the hook mints one). */
  readonly ask: { readonly requestId: string; readonly linkId: string; readonly tokenHash: string } | null
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

/** B-PR-26: who answers (the portal person or a link) and whether they see prices (the price grain of their role; a link: no). */
export interface AnswererFacts {
  readonly via: 'LINK' | 'PORTAL'
  readonly seesPrices: boolean
}

export interface RecordAdapter {
  readonly recordType: string
  readonly kinds: readonly ApprovalKind[]
  /**
   * B-PR-28: kinds the record carries that only their own command asks (REPROMISE: sales accepting a re-promise): never offered
   * by "Ask for approval" (the record's `kinds`), yet read, answered and settled through this adapter.
   */
  readonly commandKinds?: readonly ApprovalKind[]
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
  /**
   * B-PR-26: why THIS answerer may not answer it (null: they may), in their words — a priced counter-offer only by a customer
   * role with the price grain (the Buyer, the Admin), and only in the portal. Read in the tenant's system scope.
   */
  answererHeld?(client: Client, request: RequestRef, who: AnswererFacts, locale: ApprovalLocale): Promise<string | null>
  onAsked?(tools: CommandTools, request: RequestRef): Promise<void>
  onAnswered?(tools: CommandTools, request: RequestRef): Promise<void>
  /** Returns what it did (audit), or null when nothing was left to do. */
  settle?(tools: CommandTools, request: RequestRef): Promise<Prisma.InputJsonObject | null>
  /** B-PR-30b: the facts of putting the answer back (in the caller's scope, or the command's). */
  reverseFacts?(client: Client, request: RequestRef): Promise<RecordReverseFacts>
  /** B-PR-30b: puts the record's own effect back (the effects the verdict allowed); returns what it did (audit). */
  reverse?(tools: CommandTools, request: RequestRef, input: ReverseInput): Promise<Prisma.InputJsonObject | null>
}

/** The office's (or the system's) answer-time reads: the record's party language for the mails. */
export const words = (locale: ApprovalLocale, it: string, en: string): string => (locale === 'it' ? it : en)

/** A label with no words in it (a number, a code and a name): the same in both languages. */
export const sameWords = (text: string): Words => ({ it: text, en: text })
