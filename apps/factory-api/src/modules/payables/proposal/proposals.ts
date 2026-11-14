import type { Prisma } from '@nexus/factory-db'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PAYABLES_PAY, PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { DUAL_APPROVAL, dualThresholdMinor, FIRST_APPROVAL_LINE, needsSecondApproval, SECOND_APPROVAL_LINE, secondApprovalWords } from '@nexus/factory-domain/payables/proposal/approvals'
import { PAYABLES_PROPOSALS_APPROVE, PAYABLES_PROPOSALS_MANAGE } from '@nexus/factory-domain/payables/proposal/permissions'
import {
  approvalProblems,
  byDueAndDiscount,
  dueBucket,
  isMonday,
  isoWeekNumber,
  lineAmounts,
  lineProblems,
  payableOf,
  PROPOSAL_WORDS,
  proposalTitle,
  weekOf,
  type ProposalRefusal,
  type ProposalStatus,
} from '@nexus/factory-domain/payables/proposal/rules'
import { maskedIban } from '@nexus/factory-domain/purchasing/bank/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { historyLine } from '../../../platform/approvals/engine'
import { honourPeriodLocks } from '../../accounting/period-guard'
import { payableAccountOf } from '../../purchasing/bank/store'
import { RefusedError } from '../invoices'
import { officeOf, peopleNames, type Reader } from '../store'
import { remittanceOf, sendRemittances, type RemittanceOutcome } from './remittance'

/**
 * The weekly payment proposal (B-W2b-403; FIN-140, FIN-142; PQ1:01; factory-domain payables/proposal; factory-db bank.prisma
 * PaymentProposal + PaymentProposalLine and their guards, B-W2b-370). Office only, per company: can() on the company, and
 * every line's invoice also on its supplier. Amounts are money.cost (dropped for a reader without the cost grain).
 *
 *   GET  /payables/proposals?companyId&status                 payables.view: newest week first, totals, held lines
 *   GET  /payables/proposals/candidates?companyId&weekStart&currency  payables.view: the invoices approved and due by the
 *        week's Sunday (overdue included, undated last), by due date and discount, each with what is paid, the supplier's
 *        verified account (masked) or HELD, and the proposal it is in already; `waiting`: invoices due that wait for their
 *        approval (not proposable yet)
 *   POST /payables/proposals                                  proposals.manage: a DRAFT for the week (its Monday; this week
 *        when left out) and currency, with the invoices named (each with its discount) or every free candidate
 *   GET  /payables/proposals/:proposalId                      payables.view: the pop-up "Payment proposal — week 46": lines,
 *        total, IBAN checks, the approval (who made it, the second approval above the amount), the remittance switch, `may`
 *   PUT  /payables/proposals/:proposalId/lines                proposals.manage: the lines again while a DRAFT
 *   POST /payables/proposals/:proposalId/approve              proposals.approve + a fresh code: never by its maker; every
 *        line's account read again (payableAccountOf: the verified one; none: HELD, refused); above the amount the first
 *        yes is a REQUESTED line of the approval history (the proposal stays a DRAFT), the second (anyone else) approves it
 *   POST /payables/proposals/:proposalId/send-back            proposals.manage: APPROVED → DRAFT with why (the approval
 *        cleared)
 *   POST /payables/proposals/:proposalId/cancel               proposals.manage: DRAFT or APPROVED → CANCELLED with why
 *   POST /payables/proposals/:proposalId/paid                 proposals.manage + payables.pay over every invoice: once the
 *        transfers left the bank (the day, the bank's reference): every invoice PAID (period locks honoured) and the proposal
 *        PAID in ONE command; then the remittance advices (./remittance.ts: only while the company's switch is on)
 * Every write is ONE command under the company's proposal lock (the database's 'payment-proposal' money lock).
 */

const now = (): Date => serverClock.now()

const PROPOSAL_COLUMNS = {
  id: true,
  companyId: true,
  weekStart: true,
  currency: true,
  status: true,
  approvedAt: true,
  approvedById: true,
  paidAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PaymentProposalSelect
type ProposalRow = Prisma.PaymentProposalGetPayload<{ select: typeof PROPOSAL_COLUMNS }>

const LINE_COLUMNS = { id: true, proposalId: true, partyId: true, supplierInvoiceId: true, amount: true, discountAmount: true, supplierBankAccountId: true, version: true } as const satisfies Prisma.PaymentProposalLineSelect
type LineRow = Prisma.PaymentProposalLineGetPayload<{ select: typeof LINE_COLUMNS }>

const INVOICE_COLUMNS = { id: true, companyId: true, partyId: true, number: true, kind: true, status: true, matchStatus: true, currency: true, issueDate: true, dueDate: true, grossTotal: true, withholdingAmount: true, createdById: true, version: true } as const satisfies Prisma.SupplierInvoiceSelect
type InvoiceFacts = Prisma.SupplierInvoiceGetPayload<{ select: typeof INVOICE_COLUMNS }>

export const PROPOSAL_RECORD = 'PaymentProposal'
export const FIRST_PROPOSAL_APPROVAL_ACTION = 'payables.proposals.approveFirst'

const dayOf = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))
const dayDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
const refuse = (codes: readonly ProposalRefusal[]) => new RefusedError(codes.map((code) => ({ code, message: PROPOSAL_WORDS[code].en })))

const mayAt = (context: OfficeContext, permission: Parameters<typeof can>[1], companyId: string, partyId?: string): boolean => can(actorOf(context), permission, partyId ? { companyId, partyId } : { companyId })

/** The company's proposal lock (the same key as the database's factory_money_lock('payment-proposal', …)). */
async function lockProposals(tools: Pick<CommandTools, 'tx' | 'context'>, companyId: string): Promise<void> {
  const tenantId = (tools.context as OfficeContext).tenantId
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.money.payment-proposal'::text, ${tenantId}::uuid, ${companyId}::uuid), 0))`
}

async function readProposal(db: Reader, proposalId: string): Promise<ProposalRow | null> {
  return isUuid(proposalId) ? db.paymentProposal.findUnique({ where: { id: proposalId }, select: PROPOSAL_COLUMNS }) : null
}

/** The proposal the caller may see (payables.view over its company, else 404) and act on (`permission`, else 403). */
async function officeProposal(caller: CommandCaller, proposalId: string, permission: Parameters<typeof can>[1] = PAYABLES_VIEW): Promise<{ context: OfficeContext; proposal: ProposalRow }> {
  const context = officeOf(caller)
  const proposal = await caller.withClient((client) => readProposal(client, proposalId))
  if (!proposal || !mayAt(context, PAYABLES_VIEW, proposal.companyId)) throw new NotFoundError('Payment proposal not found.')
  if (!mayAt(context, permission, proposal.companyId)) throw new ForbiddenError()
  return { context, proposal }
}

/** The invoices in another live proposal (DRAFT, APPROVED), by invoice id. */
async function liveElsewhere(db: Reader, invoiceIds: readonly string[], proposalId: string | null): Promise<Map<string, { id: string; status: string }>> {
  if (invoiceIds.length === 0) return new Map()
  const rows = await db.paymentProposalLine.findMany({ where: { supplierInvoiceId: { in: [...invoiceIds] }, proposal: { status: { in: ['DRAFT', 'APPROVED'] }, ...(proposalId ? { id: { not: proposalId } } : {}) } }, select: { supplierInvoiceId: true, proposal: { select: { id: true, status: true } } } })
  return new Map(rows.map((row) => [row.supplierInvoiceId, row.proposal]))
}

interface Account {
  readonly id: string
  readonly masked: string
}

/** Each supplier's verified account in the currency (payableAccountOf), masked; null: payments are held. */
async function accountsOf(db: Reader, partyIds: readonly string[], currency: string): Promise<Map<string, Account | null>> {
  const out = new Map<string, Account | null>()
  for (const partyId of new Set(partyIds)) {
    const account = await payableAccountOf(db, partyId, currency)
    out.set(partyId, account ? { id: account.id, masked: maskedIban(account.iban.slice(0, 2), account.iban.slice(-4)) } : null)
  }
  return out
}

async function suppliersOf(db: Reader, partyIds: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const rows = partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(partyIds)] } }, select: { id: true, code: true, legalName: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.legalName }]))
}

const accountView = (account: Account | null | undefined) => (account ? { id: account.id, masked: account.masked, usable: true } : null)

// ---- reads ---------------------------------------------------------------------------------------------------------------

/** The first yes of a proposal above the amount and whether it still stands (the proposal is at the version it wrote). */
async function firstYesOf(db: Reader, proposal: Pick<ProposalRow, 'id' | 'version'>, version: number = proposal.version) {
  const row = await db.auditLog.findFirst({ where: { recordType: PROPOSAL_RECORD, recordId: proposal.id, action: FIRST_PROPOSAL_APPROVAL_ACTION }, select: { actorId: true, at: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
  const after = (row?.after ?? null) as { version?: unknown } | null
  if (!row || !row.actorId || typeof after?.version !== 'number') return { first: null, standing: false }
  return { first: { byId: row.actorId, at: row.at, version: after.version }, standing: after.version === version }
}

type Held = ProposalRefusal | 'NO_PERMISSION'
/** Why an action is held (null: it may be done): the permission first, then the state. */
const heldUnless = (permitted: boolean, state: boolean, code: ProposalRefusal): Held | null => (!permitted ? 'NO_PERMISSION' : state ? null : code)

export async function proposalView(db: Reader, context: OfficeContext, proposal: ProposalRow) {
  const lines = await db.paymentProposalLine.findMany({ where: { proposalId: proposal.id }, select: LINE_COLUMNS, orderBy: { id: 'asc' } })
  const invoices = new Map((lines.length === 0 ? [] : await db.supplierInvoice.findMany({ where: { id: { in: lines.map((line) => line.supplierInvoiceId) } }, select: INVOICE_COLUMNS })).map((row) => [row.id, row]))
  const suppliers = await suppliersOf(db, lines.map((line) => line.partyId))
  const accounts = await accountsOf(db, lines.map((line) => line.partyId), proposal.currency)
  const named = new Map((lines.length === 0 ? [] : await db.supplierBankAccount.findMany({ where: { id: { in: lines.flatMap((line) => (line.supplierBankAccountId ? [line.supplierBankAccountId] : [])) } }, select: { id: true, ibanCountry: true, ibanLast4: true, status: true } })).map((row) => [row.id, row]))
  const elsewhere = await liveElsewhere(db, lines.map((line) => line.supplierInvoiceId), proposal.id)
  const week = { weekStart: dayOf(proposal.weekStart)!, weekEnd: weekOf(dayOf(proposal.weekStart)!).weekEnd }
  const views = byDueAndDiscount(
    lines.map((line) => {
      const invoice = invoices.get(line.supplierInvoiceId)
      return { line, invoice, id: line.id, number: invoice?.number ?? '', dueDate: dayOf(invoice?.dueDate ?? null), discountAmount: line.discountAmount }
    }),
  ).map(({ line, invoice }) => {
    const verified = accounts.get(line.partyId) ?? null
    const onLine = line.supplierBankAccountId ? named.get(line.supplierBankAccountId) : undefined
    // The line names the verified account it goes to. A draft line shows the verified account now (the approval reads it again);
    // an approved or paid one keeps the account it was approved with (the IBAN used, masked).
    const used = onLine ? { id: onLine.id, masked: maskedIban(onLine.ibanCountry, onLine.ibanLast4) } : null
    const account = proposal.status === 'DRAFT' ? (onLine && onLine.status === 'ACTIVE' ? used : verified) : used
    const problems = invoice ? lineProblems({ companyId: invoice.companyId, kind: invoice.kind, status: invoice.status, currency: invoice.currency, inOtherProposal: elsewhere.has(invoice.id) }, proposal, { forApproval: proposal.status === 'DRAFT' }) : []
    return {
      id: line.id,
      invoice: invoice
        ? { id: invoice.id, number: invoice.number, issueDate: dayOf(invoice.issueDate)!, dueDate: dayOf(invoice.dueDate), due: dueBucket(dayOf(invoice.dueDate), week), status: invoice.status, grossTotal: asMoney('cost', invoice.grossTotal), withholdingAmount: asMoney('cost', invoice.withholdingAmount ?? 0) }
        : null,
      supplier: suppliers.get(line.partyId) ?? { id: line.partyId, code: '', name: '' },
      amount: asMoney('cost', line.amount),
      discountAmount: asMoney('cost', line.discountAmount),
      account: accountView(account),
      held: account === null,
      heldWords: account === null ? PROPOSAL_WORDS.HELD : null,
      problems: proposal.status === 'DRAFT' ? problems : [],
      version: line.version,
    }
  })
  const total = lines.reduce((sum, line) => sum + line.amount, 0)
  const discount = lines.reduce((sum, line) => sum + line.discountAmount, 0)
  const needed = needsSecondApproval(total, proposal.currency)
  const { first, standing } = needed && proposal.status === 'DRAFT' ? await firstYesOf(db, proposal) : { first: null, standing: false }
  const names = await peopleNames(db, [proposal.createdById, proposal.approvedById, first?.byId ?? null])
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null)
  const remittance = await remittanceOf(db, proposal.companyId)
  const held = views.filter((line) => line.held).length
  const actor = context.actorId
  const status = proposal.status as ProposalStatus
  const approveHeld: Held | null = !mayAt(context, PAYABLES_PROPOSALS_APPROVE, proposal.companyId)
    ? 'NO_PERMISSION'
    : (approvalProblems({ status, createdById: proposal.createdById, lines: views.map((line) => ({ held: line.held, problems: line.problems })) }, actor)[0] ?? (standing && first?.byId === actor ? 'SECOND_APPROVER' : null))
  const manages = mayAt(context, PAYABLES_PROPOSALS_MANAGE, proposal.companyId)
  return {
    id: proposal.id,
    companyId: proposal.companyId,
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    week: isoWeekNumber(week.weekStart),
    title: proposalTitle(week.weekStart),
    currency: proposal.currency,
    status,
    note: proposal.note,
    createdBy: person(proposal.createdById),
    createdAt: toUtcIso(proposal.createdAt),
    approvedBy: person(proposal.approvedById),
    approvedAt: proposal.approvedAt ? toUtcIso(proposal.approvedAt) : null,
    paidAt: proposal.paidAt ? toUtcIso(proposal.paidAt) : null,
    cancelledAt: proposal.cancelledAt ? toUtcIso(proposal.cancelledAt) : null,
    cancelReason: proposal.cancelReason,
    lines: views,
    totals: { amount: asMoney('cost', total), discount: asMoney('cost', discount), lines: views.length, held, suppliers: new Set(lines.map((line) => line.partyId)).size },
    approval: {
      fourEyes: PROPOSAL_WORDS.OWN_PROPOSAL,
      dual: {
        needed,
        threshold: asMoney('cost', dualThresholdMinor(proposal.currency)),
        decided: DUAL_APPROVAL.decided,
        words: DUAL_APPROVAL.words,
        first: first ? { by: person(first.byId), at: toUtcIso(first.at), standing } : null,
        waiting: needed && standing ? secondApprovalWords(names.get(first!.byId) ?? null, null) : null,
      },
    },
    remittance,
    may: {
      change: heldUnless(manages, status === 'DRAFT', 'NOT_DRAFT'),
      approve: approveHeld,
      sendBack: heldUnless(manages, status === 'APPROVED', 'NOT_APPROVED'),
      cancel: heldUnless(manages, status === 'DRAFT' || status === 'APPROVED', 'NOT_DRAFT'),
      pay: heldUnless(manages, status === 'APPROVED', 'NOT_APPROVED'),
    },
    version: proposal.version,
  }
}
export type ProposalView = Awaited<ReturnType<typeof proposalView>>

/** GET /payables/proposals */
export async function listProposals(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly status?: ProposalStatus | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.paymentProposal.findMany({
      where: { ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.status ? { status: query.status } : {}) },
      select: { ...PROPOSAL_COLUMNS, lines: { select: { amount: true, supplierBankAccountId: true } } },
      orderBy: [{ weekStart: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    })
    const visible = rows.filter((row) => mayAt(context, PAYABLES_VIEW, row.companyId))
    return {
      items: visible.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        weekStart: dayOf(row.weekStart)!,
        week: isoWeekNumber(dayOf(row.weekStart)!),
        currency: row.currency,
        status: row.status as ProposalStatus,
        lines: row.lines.length,
        held: row.lines.filter((line) => line.supplierBankAccountId === null).length,
        total: asMoney('cost', row.lines.reduce((sum, line) => sum + line.amount, 0)),
        approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null,
        paidAt: row.paidAt ? toUtcIso(row.paidAt) : null,
        version: row.version,
      })),
    }
  })
}

/** GET /payables/proposals/:proposalId */
export async function getProposal(caller: CommandCaller, proposalId: string) {
  const { context, proposal } = await officeProposal(caller, proposalId)
  return { proposal: await caller.withClient((client) => proposalView(client, context, proposal)) }
}

interface CandidateQuery {
  readonly companyId: string
  readonly weekStart?: string | undefined
  readonly currency?: string | undefined
}

async function weekAndCurrency(db: Reader, query: CandidateQuery): Promise<{ weekStart: string; weekEnd: string; currency: string }> {
  const week = weekOf(query.weekStart ?? businessDate(now()))
  if (query.weekStart && !isMonday(query.weekStart)) throw new ValidationError('A proposal is for a week, named by its Monday.', [{ path: 'weekStart', message: `${query.weekStart} is not a Monday (that week starts on ${week.weekStart}).` }])
  const company = await db.company.findUnique({ where: { id: query.companyId }, select: { currency: true } })
  if (!company) throw new NotFoundError('Company not found.')
  return { ...week, currency: query.currency ?? company.currency }
}

/** The proposable invoices of a company for a week and currency (see the module comment). */
async function candidatesOf(db: Reader, context: OfficeContext, companyId: string, week: { weekStart: string; weekEnd: string }, currency: string, proposalId: string | null) {
  const due = { OR: [{ dueDate: { lte: dayDate(week.weekEnd) } }, { dueDate: null }] } satisfies Prisma.SupplierInvoiceWhereInput
  const rows = (await db.supplierInvoice.findMany({ where: { companyId, currency, kind: 'INVOICE', status: 'APPROVED', ...due }, select: INVOICE_COLUMNS, take: 1000 })).filter((row) => mayAt(context, PAYABLES_VIEW, row.companyId, row.partyId))
  const waiting = (await db.supplierInvoice.findMany({ where: { companyId, currency, kind: 'INVOICE', status: { in: ['RECEIVED', 'DISPUTED'] }, ...due }, select: INVOICE_COLUMNS, take: 1000 })).filter((row) => mayAt(context, PAYABLES_VIEW, row.companyId, row.partyId))
  const elsewhere = await liveElsewhere(db, rows.map((row) => row.id), proposalId)
  const accounts = await accountsOf(db, rows.map((row) => row.partyId), currency)
  return { rows: byDueAndDiscount(rows.map((row) => ({ ...row, dueDate: dayOf(row.dueDate) }))).map((row) => ({ row, inProposal: elsewhere.get(row.id) ?? null, account: accounts.get(row.partyId) ?? null })), waiting: byDueAndDiscount(waiting.map((row) => ({ ...row, dueDate: dayOf(row.dueDate) }))) }
}

/** GET /payables/proposals/candidates */
export async function proposalCandidates(caller: CommandCaller, query: CandidateQuery) {
  const context = officeOf(caller)
  if (!mayAt(context, PAYABLES_VIEW, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    const { weekStart, weekEnd, currency } = await weekAndCurrency(client, query)
    const { rows, waiting } = await candidatesOf(client, context, query.companyId, { weekStart, weekEnd }, currency, null)
    const suppliers = await suppliersOf(client, [...rows.map(({ row }) => row.partyId), ...waiting.map((row) => row.partyId)])
    const free = rows.filter((entry) => entry.inProposal === null)
    return {
      companyId: query.companyId,
      weekStart,
      weekEnd,
      week: isoWeekNumber(weekStart),
      currency,
      items: rows.map(({ row, inProposal, account }) => ({
        invoiceId: row.id,
        number: row.number,
        supplier: suppliers.get(row.partyId) ?? { id: row.partyId, code: '', name: '' },
        issueDate: dayOf(row.issueDate)!,
        dueDate: row.dueDate,
        due: dueBucket(row.dueDate, { weekStart, weekEnd }),
        grossTotal: asMoney('cost', row.grossTotal),
        payable: asMoney('cost', payableOf(row)),
        account: accountView(account),
        held: account === null,
        inProposal,
      })),
      waiting: waiting.map((row) => ({ invoiceId: row.id, number: row.number, supplier: suppliers.get(row.partyId) ?? { id: row.partyId, code: '', name: '' }, dueDate: row.dueDate, due: dueBucket(row.dueDate, { weekStart, weekEnd }), status: row.status, words: PROPOSAL_WORDS.INVOICE_NOT_APPROVED })),
      totals: { invoices: free.length, held: free.filter((entry) => entry.account === null).length, payable: asMoney('cost', free.reduce((sum, entry) => sum + payableOf(entry.row), 0)) },
    }
  })
}

// ---- writes --------------------------------------------------------------------------------------------------------------

export interface LineInput {
  readonly invoiceId: string
  /** Minor units: the early-payment discount taken (0 or more). */
  readonly discountAmount?: number | undefined
}

/** Writes the lines of a DRAFT proposal (after deleting the old ones), each to its supplier's verified account or held. */
async function writeLines(tools: CommandTools, proposal: Pick<ProposalRow, 'id' | 'companyId' | 'currency'>, inputs: readonly LineInput[], context: OfficeContext): Promise<{ lines: number; held: number }> {
  const { tx } = tools
  await tx.paymentProposalLine.deleteMany({ where: { proposalId: proposal.id } })
  const ids = inputs.map((input) => input.invoiceId)
  const invoices = new Map((ids.length === 0 ? [] : await tx.supplierInvoice.findMany({ where: { id: { in: ids.filter(isUuid) } }, select: INVOICE_COLUMNS })).map((row) => [row.id, row]))
  const elsewhere = await liveElsewhere(tx, ids.filter(isUuid), proposal.id)
  const problems: { path: string; message: string }[] = []
  const seen = new Set<string>()
  inputs.forEach((input, index) => {
    const invoice = invoices.get(input.invoiceId)
    if (!invoice || !mayAt(context, PAYABLES_VIEW, invoice.companyId, invoice.partyId)) return problems.push({ path: `body/lines/${index}/invoiceId`, message: 'Not a supplier invoice you can see.' })
    if (seen.has(invoice.id)) return problems.push({ path: `body/lines/${index}/invoiceId`, message: `Invoice ${invoice.number} is named twice.` })
    seen.add(invoice.id)
    for (const code of lineProblems({ companyId: invoice.companyId, kind: invoice.kind, status: invoice.status, currency: invoice.currency, inOtherProposal: elsewhere.has(invoice.id) }, proposal, { forApproval: false })) problems.push({ path: `body/lines/${index}/${code}`, message: `${invoice.number}: ${PROPOSAL_WORDS[code].en}` })
    if (!lineAmounts(invoice, input.discountAmount ?? 0)) problems.push({ path: `body/lines/${index}/discountAmount`, message: `${invoice.number}: ${PROPOSAL_WORDS.TOO_MUCH.en}` })
    return undefined
  })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The proposal is not valid as it stands.', problems)
  const accounts = await accountsOf(tx, [...invoices.values()].map((row) => row.partyId), proposal.currency)
  let held = 0
  for (const input of inputs) {
    const invoice = invoices.get(input.invoiceId)!
    const amounts = lineAmounts(invoice, input.discountAmount ?? 0)!
    const account = accounts.get(invoice.partyId) ?? null
    if (!account) held += 1
    await tx.paymentProposalLine.create({ data: { id: newId(), companyId: proposal.companyId, proposalId: proposal.id, partyId: invoice.partyId, supplierInvoiceId: invoice.id, amount: amounts.amount, discountAmount: amounts.discountAmount, supplierBankAccountId: account?.id ?? null, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
  }
  return { lines: inputs.length, held }
}

function changed(tools: CommandTools, proposal: Pick<ProposalRow, 'id' | 'companyId' | 'weekStart'>, status: ProposalStatus, change: 'CREATED' | 'LINES_CHANGED' | 'FIRST_APPROVED' | 'APPROVED' | 'SENT_BACK' | 'CANCELLED' | 'PAID', counts: { lines: number; held: number; remitted?: number }) {
  tools.emit({ type: 'payment_proposal.changed', subject: proposal.id, companyId: proposal.companyId, payload: { proposalId: proposal.id, companyId: proposal.companyId, weekStart: dayOf(proposal.weekStart)!, status, change, lines: counts.lines, held: counts.held, remitted: counts.remitted ?? 0 } })
}

export interface CreateProposalInput {
  readonly companyId: string
  readonly weekStart?: string | undefined
  readonly currency?: string | undefined
  readonly lines?: readonly LineInput[] | undefined
  readonly note?: string | null | undefined
}

/** POST /payables/proposals (proposals.manage). */
export async function createProposal(caller: CommandCaller, input: CreateProposalInput, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!mayAt(context, PAYABLES_VIEW, input.companyId)) throw new NotFoundError('Company not found.')
  if (!mayAt(context, PAYABLES_PROPOSALS_MANAGE, input.companyId)) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'payables.proposals.create', idempotencyKey, input }, async (tools) => {
    await lockProposals(tools, input.companyId)
    const { weekStart, weekEnd, currency } = await weekAndCurrency(tools.tx, input)
    const lines = input.lines ?? (await candidatesOf(tools.tx, context, input.companyId, { weekStart, weekEnd }, currency, null)).rows.filter((entry) => entry.inProposal === null).map((entry) => ({ invoiceId: entry.row.id }))
    const id = newId()
    const proposal = await tools.tx.paymentProposal.create({ data: { id, companyId: input.companyId, weekStart: dayDate(weekStart), currency, note: input.note?.trim() || null, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: PROPOSAL_COLUMNS })
    const counts = await writeLines(tools, proposal, lines, context)
    tools.audit({ action: 'payables.proposals.create', recordType: PROPOSAL_RECORD, recordId: id, companyId: input.companyId, after: { weekStart, currency, lines: counts.lines, held: counts.held } })
    changed(tools, proposal, 'DRAFT', 'CREATED', counts)
    return { proposal: await proposalView(tools.tx, context, proposal) }
  })
  return result
}

/** PUT /payables/proposals/:proposalId/lines (proposals.manage): the lines again while a DRAFT. */
export async function putProposalLines(caller: CommandCaller, proposalId: string, input: { readonly version: number; readonly lines: readonly LineInput[]; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { context, proposal: seen } = await officeProposal(caller, proposalId, PAYABLES_PROPOSALS_MANAGE)
  if (seen.status !== 'DRAFT') throw refuse(['NOT_DRAFT'])
  const { result } = await command(caller, { name: 'payables.proposals.lines', idempotencyKey, input: { proposalId, ...input }, record: { type: 'PaymentProposal', id: proposalId, expectedVersion: input.version } }, async (tools) => {
    await lockProposals(tools, seen.companyId)
    const proposal = (await readProposal(tools.tx, proposalId))!
    if (proposal.status !== 'DRAFT') throw refuse(['NOT_DRAFT'])
    const counts = await writeLines(tools, proposal, input.lines, context)
    if (input.note !== undefined) await tools.tx.paymentProposal.update({ where: { id: proposalId }, data: { note: input.note?.trim() || null }, select: { id: true } })
    tools.audit({ action: 'payables.proposals.lines', recordType: PROPOSAL_RECORD, recordId: proposalId, companyId: proposal.companyId, after: { lines: counts.lines, held: counts.held } })
    changed(tools, proposal, 'DRAFT', 'LINES_CHANGED', counts)
    return { proposal: await proposalView(tools.tx, context, (await readProposal(tools.tx, proposalId))!) }
  })
  return result
}

/** The lines of a proposal with their invoices, read in the command (the accounts refreshed to the verified ones). */
async function linesForApproval(tools: CommandTools, proposal: ProposalRow): Promise<{ lines: (LineRow & { invoice: InvoiceFacts | undefined })[]; refreshed: number }> {
  const lines = await tools.tx.paymentProposalLine.findMany({ where: { proposalId: proposal.id }, select: LINE_COLUMNS })
  const invoices = new Map((lines.length === 0 ? [] : await tools.tx.supplierInvoice.findMany({ where: { id: { in: lines.map((line) => line.supplierInvoiceId) } }, select: INVOICE_COLUMNS })).map((row) => [row.id, row]))
  const accounts = await accountsOf(tools.tx, lines.map((line) => line.partyId), proposal.currency)
  let refreshed = 0
  const out: (LineRow & { invoice: InvoiceFacts | undefined })[] = []
  for (const line of lines) {
    // PQ1:01: a payment goes only to payableAccountOf, read again now (a retired account holds the line, a new verified one takes it).
    const account = accounts.get(line.partyId)?.id ?? null
    if (account !== line.supplierBankAccountId && proposal.status === 'DRAFT') {
      await tools.tx.paymentProposalLine.update({ where: { id: line.id }, data: { supplierBankAccountId: account, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      refreshed += 1
    }
    out.push({ ...line, supplierBankAccountId: account, invoice: invoices.get(line.supplierInvoiceId) })
  }
  return { lines: out, refreshed }
}

/** POST /payables/proposals/:proposalId/approve (proposals.approve + a fresh code, asked by the route). */
export async function approveProposal(caller: CommandCaller, proposalId: string, input: { readonly version: number; readonly note?: string | null | undefined }, stepUp: () => void, idempotencyKey?: string) {
  const { context, proposal: seen } = await officeProposal(caller, proposalId, PAYABLES_PROPOSALS_APPROVE)
  // The maker never approves (in words before the fresh code is asked).
  if (seen.createdById === context.actorId) throw refuse(['OWN_PROPOSAL'])
  if (seen.status !== 'DRAFT') throw refuse(['NOT_DRAFT'])
  stepUp()
  const { result } = await command(caller, { name: 'payables.proposals.approve', idempotencyKey, input: { proposalId, ...input }, record: { type: 'PaymentProposal', id: proposalId, expectedVersion: input.version } }, async (tools) => {
    await lockProposals(tools, seen.companyId)
    const proposal = (await readProposal(tools.tx, proposalId))!
    const { lines, refreshed } = await linesForApproval(tools, proposal)
    const elsewhere = await liveElsewhere(tools.tx, lines.map((line) => line.supplierInvoiceId), proposal.id)
    const facts = lines.map((line) => ({
      held: line.supplierBankAccountId === null,
      problems: line.invoice ? lineProblems({ companyId: line.invoice.companyId, kind: line.invoice.kind, status: line.invoice.status, currency: line.invoice.currency, inOtherProposal: elsewhere.has(line.invoice.id) }, proposal, { forApproval: true }) : (['INVOICE_PAID'] as ProposalRefusal[]),
    }))
    const problems = approvalProblems({ status: proposal.status as ProposalStatus, createdById: proposal.createdById, lines: facts }, context.actorId)
    if (problems.length > 0) throw refuse(problems)
    if (lines.some((line) => line.invoice && !mayAt(context, PAYABLES_VIEW, line.invoice.companyId, line.invoice.partyId))) throw new ForbiddenError('You do not see every invoice of this proposal: someone who sees them all approves it.')
    const total = lines.reduce((sum, line) => sum + line.amount, 0)
    const counts = { lines: lines.length, held: 0 }
    const note = input.note?.trim() || null
    if (needsSecondApproval(total, proposal.currency)) {
      const { first, standing } = await firstYesOf(tools.tx, proposal, tools.record?.previousVersion ?? proposal.version)
      // A line whose account was read again (above) lapses a first yes: the approver saw another account.
      if (first && standing && refreshed === 0) {
        if (first.byId === context.actorId) throw refuse(['SECOND_APPROVER'])
        await historyLine(tools, { companyId: proposal.companyId, recordType: PROPOSAL_RECORD, recordId: proposal.id, action: 'APPROVED', byId: context.actorId, words: note ? `${SECOND_APPROVAL_LINE} ${note}` : SECOND_APPROVAL_LINE })
      } else {
        await historyLine(tools, { companyId: proposal.companyId, recordType: PROPOSAL_RECORD, recordId: proposal.id, action: 'REQUESTED', byId: context.actorId, words: note ? `${FIRST_APPROVAL_LINE} ${note}` : FIRST_APPROVAL_LINE })
        tools.audit({ action: FIRST_PROPOSAL_APPROVAL_ACTION, recordType: PROPOSAL_RECORD, recordId: proposal.id, companyId: proposal.companyId, after: { version: tools.record?.version ?? proposal.version, lines: counts.lines, lapsed: first !== null, accountsReadAgain: refreshed } })
        changed(tools, proposal, 'DRAFT', 'FIRST_APPROVED', counts)
        return { step: 'FIRST' as const }
      }
    }
    await tools.tx.paymentProposal.update({ where: { id: proposalId }, data: { status: 'APPROVED', approvedAt: tools.now, approvedById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'payables.proposals.approve', recordType: PROPOSAL_RECORD, recordId: proposalId, companyId: proposal.companyId, before: { status: 'DRAFT' }, after: { status: 'APPROVED', lines: counts.lines, note, accountsReadAgain: refreshed } })
    changed(tools, proposal, 'APPROVED', 'APPROVED', counts)
    return { step: needsSecondApproval(total, proposal.currency) ? ('SECOND' as const) : ('SINGLE' as const) }
  })
  // Read after the commit: the first yes is read from its audit row, written with the command.
  return { proposal: await caller.withClient(async (client) => proposalView(client, context, (await readProposal(client, proposalId))!)), step: result.step }
}

/** POST /payables/proposals/:proposalId/send-back (proposals.manage): APPROVED → DRAFT, the approval cleared, with why. */
export async function sendBackProposal(caller: CommandCaller, proposalId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context, proposal: seen } = await officeProposal(caller, proposalId, PAYABLES_PROPOSALS_MANAGE)
  if (seen.status !== 'APPROVED') throw refuse(['NOT_APPROVED'])
  const { result } = await command(caller, { name: 'payables.proposals.sendBack', idempotencyKey, input: { proposalId, ...input }, record: { type: 'PaymentProposal', id: proposalId, expectedVersion: input.version } }, async (tools) => {
    const proposal = (await readProposal(tools.tx, proposalId))!
    if (proposal.status !== 'APPROVED') throw refuse(['NOT_APPROVED'])
    await tools.tx.paymentProposal.update({ where: { id: proposalId }, data: { status: 'DRAFT', approvedAt: null, approvedById: null }, select: { id: true } })
    const lines = await tools.tx.paymentProposalLine.count({ where: { proposalId } })
    tools.audit({ action: 'payables.proposals.sendBack', recordType: PROPOSAL_RECORD, recordId: proposalId, companyId: proposal.companyId, reason: input.reason.trim(), before: { status: 'APPROVED', approvedById: proposal.approvedById }, after: { status: 'DRAFT' } })
    changed(tools, proposal, 'DRAFT', 'SENT_BACK', { lines, held: 0 })
    return { proposal: await proposalView(tools.tx, context, (await readProposal(tools.tx, proposalId))!) }
  })
  return result
}

/** POST /payables/proposals/:proposalId/cancel (proposals.manage): DRAFT or APPROVED → CANCELLED, with why. */
export async function cancelProposal(caller: CommandCaller, proposalId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context, proposal: seen } = await officeProposal(caller, proposalId, PAYABLES_PROPOSALS_MANAGE)
  if (seen.status !== 'DRAFT' && seen.status !== 'APPROVED') throw refuse(['NOT_DRAFT'])
  const { result } = await command(caller, { name: 'payables.proposals.cancel', idempotencyKey, input: { proposalId, ...input }, record: { type: 'PaymentProposal', id: proposalId, expectedVersion: input.version } }, async (tools) => {
    const proposal = (await readProposal(tools.tx, proposalId))!
    if (proposal.status !== 'DRAFT' && proposal.status !== 'APPROVED') throw refuse(['NOT_DRAFT'])
    await tools.tx.paymentProposal.update({ where: { id: proposalId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: input.reason.trim().slice(0, 500) }, select: { id: true } })
    const lines = await tools.tx.paymentProposalLine.count({ where: { proposalId } })
    tools.audit({ action: 'payables.proposals.cancel', recordType: PROPOSAL_RECORD, recordId: proposalId, companyId: proposal.companyId, reason: input.reason.trim(), before: { status: proposal.status }, after: { status: 'CANCELLED' } })
    changed(tools, proposal, 'CANCELLED', 'CANCELLED', { lines, held: 0 })
    return { proposal: await proposalView(tools.tx, context, (await readProposal(tools.tx, proposalId))!) }
  })
  return result
}

export interface PaidInput {
  readonly version: number
  readonly paidOn: string
  readonly paymentRef: string
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

/**
 * POST /payables/proposals/:proposalId/paid (proposals.manage + payables.pay over every invoice): every invoice PAID (the
 * bank's day and reference, W2a's columns) and the proposal PAID in ONE command; then the remittance advices.
 */
export async function recordProposalPaid(caller: CommandCaller, proposalId: string, input: PaidInput, idempotencyKey?: string): Promise<{ proposal: ProposalView; remittances: RemittanceOutcome[] }> {
  const { context, proposal: seen } = await officeProposal(caller, proposalId, PAYABLES_PROPOSALS_MANAGE)
  if (seen.status !== 'APPROVED') throw refuse(['NOT_APPROVED'])
  if (input.paidOn > businessDate(now())) throw new ValidationError(PROPOSAL_WORDS.NOT_PAID_YET.en, [{ path: 'body/paidOn', message: 'The transfers are recorded once they left the bank.' }])
  const { result } = await command(caller, { name: 'payables.proposals.paid', idempotencyKey, input: { proposalId, ...input }, record: { type: 'PaymentProposal', id: proposalId, expectedVersion: input.version } }, async (tools) => {
    const proposal = (await readProposal(tools.tx, proposalId))!
    if (proposal.status !== 'APPROVED') throw refuse(['NOT_APPROVED'])
    const lines = await tools.tx.paymentProposalLine.findMany({ where: { proposalId }, select: LINE_COLUMNS })
    const invoices = await tools.tx.supplierInvoice.findMany({ where: { id: { in: lines.map((line) => line.supplierInvoiceId) } }, select: INVOICE_COLUMNS })
    const missing = invoices.filter((invoice) => !mayAt(context, PAYABLES_PAY, invoice.companyId, invoice.partyId))
    if (missing.length > 0) throw new ForbiddenError(`Recording the payment of ${missing.map((invoice) => invoice.number).join(', ')} needs payables.pay over its supplier.`)
    const early = invoices.filter((invoice) => input.paidOn < dayOf(invoice.issueDate)!)
    if (early.length > 0) throw new ValidationError('The payment is dated before an invoice.', early.map((invoice) => ({ path: 'body/paidOn', message: `Invoice ${invoice.number} was issued on ${dayOf(invoice.issueDate)}.` })))
    await honourPeriodLocks(
      tools,
      invoices.map((invoice) => ({ companyId: invoice.companyId, day: input.paidOn, refused: `the payment of supplier invoice ${invoice.number} on ${dayWords(input.paidOn)} is not recorded`, path: 'body/paidOn', record: { type: 'SupplierInvoice', id: invoice.id } })),
      input.periodLockOverride,
    )
    const reference = input.paymentRef.trim()
    for (const invoice of invoices) {
      if (invoice.status !== 'APPROVED') throw new RefusedError([{ code: 'INVOICE_NOT_APPROVED', message: `Invoice ${invoice.number} is ${invoice.status.toLowerCase()}: ${PROPOSAL_WORDS.INVOICE_NOT_APPROVED.en}` }])
      await tools.tx.supplierInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID', paidOn: dayDate(input.paidOn), paymentRef: reference, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'payables.pay', recordType: 'SupplierInvoice', recordId: invoice.id, companyId: invoice.companyId, before: { status: 'APPROVED' }, after: { status: 'PAID', paidOn: input.paidOn, paymentRef: reference, proposalId } })
      tools.emit({ type: 'supplier_invoice.paid', subject: invoice.id, companyId: invoice.companyId, payload: { supplierInvoiceId: invoice.id, partyId: invoice.partyId, status: 'PAID', matchStatus: invoice.matchStatus as 'MATCHED', paidOn: input.paidOn } })
    }
    await tools.tx.paymentProposal.update({ where: { id: proposalId }, data: { status: 'PAID', paidAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'payables.proposals.paid', recordType: PROPOSAL_RECORD, recordId: proposalId, companyId: proposal.companyId, before: { status: 'APPROVED' }, after: { status: 'PAID', paidOn: input.paidOn, paymentRef: reference, invoices: invoices.length } })
    changed(tools, proposal, 'PAID', 'PAID', { lines: lines.length, held: 0 })
    return { id: proposalId }
  })
  // The remittance advices: one per supplier, each its own command, only while the company's switch is on (./remittance.ts).
  const remittances = await sendRemittances(caller, result.id, idempotencyKey)
  const fresh = await caller.withClient((client) => readProposal(client, proposalId))
  return { proposal: await caller.withClient((client) => proposalView(client, context, fresh!)), remittances }
}

