import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { depositRequestFor, paymentInstructions, type BankDetails, type DepositDraft, type PaymentInstructions } from '@nexus/factory-domain/sales/deposits/deposits'
import type { DepositKind } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CustomerTaxProfile } from '@nexus/factory-domain/tax/vat-treatment'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * Deposit requests (B-W1-24; SAL-195, FIN-066; Q12: an acconto paid by bank transfer): the sales module's commands on
 * DepositRequest (factory-db sales.prisma; the …_sales_guards trigger holds its states for every login).
 *
 *   request    `requestDepositInCommand`: the request of an ACCEPTED quote version, OPEN, from the version's percent,
 *              kind and amount, due DEPOSIT_DUE_DAYS after the acceptance, with the VAT rules' fiscal decision
 *              (factory-domain sales/deposits). Once per version: called by the system step after an acceptance
 *              (quotes/after-acceptance.ts), which the office role (factory_runtime) runs — a link session may not
 *              insert a request.
 *   paid       `markDepositPaid`: OPEN → PAID when the payments allocated cover it, inside the payments command that
 *              allocated (payments.ts allocateInCommand, under the request's money lock). Moved here from
 *              modules/payments (B-W1-28 kept it there until sales had its own).
 *   pay how    `depositBankDetailsFor` (= `companyBankDetails`, the Company row's bank account): the
 *              account for the instructions; null when the company has none (the page and the mail say they follow).
 *              The account itself is kept by bank.ts (a step-up each time).
 */

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export const DEPOSIT_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  quoteVersionId: true,
  orderId: true,
  kind: true,
  depositPct: true,
  currency: true,
  amount: true,
  dueDate: true,
  fiscalDocument: true,
  fiscalRule: true,
  status: true,
  paidAt: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.DepositRequestSelect
export type DepositRow = Prisma.DepositRequestGetPayload<{ select: typeof DEPOSIT_COLUMNS }>

const day = (value: Date): string => value.toISOString().slice(0, 10)

/** A deposit request as the office and its customer read it (the price grain marks the amount in the contracts). */
export function depositViewOf(row: DepositRow) {
  return {
    id: row.id,
    quoteVersionId: row.quoteVersionId,
    orderId: row.orderId,
    kind: row.kind as DepositKind,
    depositPct: row.depositPct === null ? null : decimalText(row.depositPct.toString()),
    currency: row.currency,
    amount: row.amount,
    dueDate: day(row.dueDate),
    fiscalDocument: row.fiscalDocument,
    fiscalRule: row.fiscalRule,
    status: row.status,
    paidAt: row.paidAt === null ? null : toUtcIso(row.paidAt),
    createdAt: toUtcIso(row.createdAt),
  }
}
export type DepositView = ReturnType<typeof depositViewOf>

/** The deposit request of a quote version, if one was made (one per version). */
export const depositOfVersion = (db: FactoryClient | CommandTx, versionId: string): Promise<DepositRow | null> =>
  db.depositRequest.findFirst({ where: { quoteVersionId: versionId }, select: DEPOSIT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

export interface AcceptedVersion {
  readonly id: string
  readonly quoteId: string
  readonly companyId: string
  readonly partyId: string
  readonly currency: string
  readonly depositPct: string | null
  readonly depositKind: DepositKind | null
  readonly depositAmount: number | null
  /** The acceptance's day (Europe/Rome): the due date counts from it. */
  readonly acceptedOn: string
}

/**
 * Inside a command of the office or system context: the version's deposit request, made OPEN when it asks one and none
 * exists yet (the caller holds the version's row lock). Returns the request (made now or before), or null when the
 * version asks no deposit.
 */
export async function requestDepositInCommand(tools: CommandTools, version: AcceptedVersion, profile: CustomerTaxProfile | null): Promise<{ row: DepositRow; created: boolean; draft: DepositDraft | null } | null> {
  const existing = await depositOfVersion(tools.tx, version.id)
  if (existing) return { row: existing, created: false, draft: null }
  const draft = depositRequestFor({ depositPct: version.depositPct, depositKind: version.depositKind, depositAmount: version.depositAmount, currency: version.currency }, version.acceptedOn, profile)
  if (!draft) return null
  const id = newId()
  const row = await tools.tx.depositRequest.create({
    data: {
      id,
      companyId: version.companyId,
      partyId: version.partyId,
      quoteVersionId: version.id,
      kind: draft.kind,
      depositPct: draft.depositPct,
      currency: draft.currency,
      amount: draft.amount,
      dueDate: new Date(`${draft.dueDate}T00:00:00.000Z`),
      fiscalDocument: draft.fiscalDocument,
      fiscalRule: draft.fiscalRule,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: actorIdOf(tools),
    },
    select: DEPOSIT_COLUMNS,
  })
  tools.audit({
    action: 'sales.deposits.request',
    recordType: 'DepositRequest',
    recordId: id,
    companyId: version.companyId,
    after: {
      quoteVersionId: version.id,
      kind: draft.kind,
      depositPct: draft.depositPct,
      currency: draft.currency,
      amount: markMoney('price', draft.amount),
      dueDate: draft.dueDate,
      fiscalDocument: draft.fiscalDocument,
      fiscalRule: draft.fiscalRule,
      reason: draft.reason,
      status: 'OPEN',
    },
  })
  tools.emit({
    type: 'deposit_request.created',
    subject: id,
    companyId: version.companyId,
    payload: { depositRequestId: id, quoteId: version.quoteId, versionId: version.id, partyId: version.partyId, fiscalDocument: draft.fiscalDocument, dueDate: draft.dueDate },
  })
  return { row, created: true, draft }
}

/**
 * The deposit request is PAID (its allocations cover it). Inside the command that allocated, under the request's money
 * lock (payments/locks.ts); the request's own version moves (an open edit of it sees the change). The …_sales_guards
 * trigger allows OPEN → PAID with its paidAt.
 */
export async function markDepositPaid(tools: CommandTools, request: { id: string; companyId: string; partyId: string; orderId: string | null }): Promise<void> {
  const { count } = await tools.tx.depositRequest.updateMany({ where: { id: request.id, status: 'OPEN' }, data: { status: 'PAID', paidAt: tools.now, version: { increment: 1 } } })
  if (count !== 1) return
  tools.audit({ action: 'payments.depositPaid', recordType: 'DepositRequest', recordId: request.id, companyId: request.companyId, before: { status: 'OPEN' }, after: { status: 'PAID', paidAt: toUtcIso(tools.now) } })
  tools.emit({ type: 'payment.deposit_paid', subject: request.id, companyId: request.companyId, payload: { depositRequestId: request.id, partyId: request.partyId, orderId: request.orderId } })
}

// ---- how to pay it -------------------------------------------------------------------------------------------------

/**
 * The company's bank account as stored (factory-db Company.bankAccountHolder, iban, bic, bankName), or null when it has
 * none. Read in the office or system scope only: the floor and partner roles cannot select these columns, so a deposit
 * page or a document reads it through the tenant's system caller. The invoicing XML (DatiPagamento MP05) can use it too.
 */
export async function companyBankDetails(client: FactoryClient | CommandTx, companyId: string): Promise<BankDetails | null> {
  const row = await client.company.findUnique({ where: { id: companyId }, select: { bankAccountHolder: true, iban: true, bic: true, bankName: true } })
  if (!row || row.iban === null || row.bankAccountHolder === null) return null
  return { accountHolder: row.bankAccountHolder, iban: row.iban, bic: row.bic, bankName: row.bankName }
}

/** The company's bank account a deposit is paid to, or null when none is on record. Read in the office or system scope. */
export const depositBankDetailsFor = companyBankDetails

/** The instructions of a request: amount, due date, reference, the company's account (read in the office or system scope). */
export async function instructionsFor(client: FactoryClient | CommandTx, request: Pick<DepositRow, 'companyId' | 'amount' | 'currency' | 'dueDate' | 'kind'>, documentNumber: string, language: DocumentLanguage): Promise<PaymentInstructions> {
  const bank = await depositBankDetailsFor(client, request.companyId)
  return paymentInstructions({ amount: request.amount, currency: request.currency, dueDate: day(request.dueDate), kind: request.kind as DepositKind, documentNumber, bank, language })
}
