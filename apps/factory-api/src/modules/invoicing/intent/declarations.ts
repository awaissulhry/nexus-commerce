import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { declarationProblems, declarationStateOf, INTENT_NATURA, remainingOf, type DeclarationState } from '@nexus/factory-domain/invoicing/intent/intent'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { INVOICES_TAX_MANAGE } from '@nexus/factory-domain/invoicing/tax-codes/permissions'
import { SWITCH_WORDS } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, type Reader } from '../store'
import { assertCompany, dayOf, dayValue, readSwitches, refused, refusingInWords } from '../tax-codes/store'

/**
 * The customers' declarations of intent (B-W2b-392; FIN-100; DPR 633/1972 art. 8 c.1 lett. c; design finance.invoices
 * "every zero-VAT line has its reason code": N3.5 "customer's declaration of intent"): recorded with the tax agency's
 * protocol number and date, the year and the amount declared for our supplies; checked on the agency's site with the
 * receipt it printed (a file uploaded on the declaration first: POST /files, recordType DeclarationOfIntent); revoked with
 * why (then frozen). What invoices use of it moves at their issue and back at a credit note's (./use.ts). Each write is
 * ONE command on the row (its version guards it), audited, with `declaration_of_intent.changed`; can() on the company
 * AND the customer. Recording and checking work while the company's declarations switch is off (an invoice names one
 * only while it is on: ./on-invoice.ts).
 */

export const DECLARATION_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  protocolNumber: true,
  protocolDate: true,
  year: true,
  amount: true,
  usedAmount: true,
  checkedAt: true,
  checkedById: true,
  receiptFileId: true,
  revokedAt: true,
  revokeReason: true,
  version: true,
} as const satisfies Prisma.DeclarationOfIntentSelect
export type DeclarationRow = Prisma.DeclarationOfIntentGetPayload<{ select: typeof DECLARATION_COLUMNS }>

/** A row as the domain reads it. */
export const declarationFactsOf = (row: DeclarationRow) => ({
  id: row.id,
  protocolNumber: row.protocolNumber,
  protocolDate: dayOf(row.protocolDate),
  year: row.year,
  amount: row.amount,
  usedAmount: row.usedAmount,
  checkedAt: row.checkedAt ? toUtcIso(row.checkedAt) : null,
  revokedAt: row.revokedAt ? toUtcIso(row.revokedAt) : null,
})

export async function readDeclaration(db: Reader, declarationId: string): Promise<DeclarationRow | null> {
  return isUuid(declarationId) ? db.declarationOfIntent.findUnique({ where: { id: declarationId }, select: DECLARATION_COLUMNS }) : null
}

/** The declaration an invoice names, as its XML prints it on the N3.5 lines (AltriDatiGestionali INTENTO), or null. */
export async function printedDeclarationOf(db: Reader, invoiceId: string): Promise<{ protocolNumber: string; protocolDate: string } | null> {
  const named = (await db.invoice.findUnique({ where: { id: invoiceId }, select: { declarationOfIntentId: true } }))?.declarationOfIntentId ?? null
  const row = named ? await db.declarationOfIntent.findUnique({ where: { id: named }, select: { protocolNumber: true, protocolDate: true } }) : null
  return row ? { protocolNumber: row.protocolNumber, protocolDate: dayOf(row.protocolDate) } : null
}

/** The net of the N3.5 lines of each invoice (minor units), by invoice. */
export async function intentAmounts(db: Reader, invoiceIds: readonly string[]): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map()
  const sums = await db.invoiceLine.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: [...invoiceIds] }, vatNature: INTENT_NATURA }, _sum: { netAmount: true } })
  return new Map(sums.map((row) => [row.invoiceId, Math.max(0, row._sum.netAmount ?? 0)]))
}

async function declarationView(db: Reader, row: DeclarationRow) {
  const party = await db.party.findUnique({ where: { id: row.partyId }, select: { code: true, legalName: true } })
  const switches = await readSwitches(db, row.companyId)
  const named = await db.invoice.findMany({ where: { declarationOfIntentId: row.id, status: { not: 'DRAFT' } }, select: { id: true, docType: true, number: true, issueDate: true }, orderBy: [{ issueDate: 'asc' }, { number: 'asc' }] })
  const credits = named.length === 0 ? [] : await db.invoice.findMany({ where: { creditOfId: { in: named.map((one) => one.id) }, docType: 'TD04', status: { not: 'DRAFT' } }, select: { id: true, docType: true, number: true, issueDate: true }, orderBy: [{ issueDate: 'asc' }, { number: 'asc' }] })
  const amounts = await intentAmounts(db, [...named, ...credits].map((one) => one.id))
  const facts = declarationFactsOf(row)
  return {
    ...facts,
    version: row.version,
    companyId: row.companyId,
    partyId: row.partyId,
    party: party ?? { code: '', legalName: '' },
    amount: asMoney('price', row.amount),
    usedAmount: asMoney('price', row.usedAmount),
    leftAmount: asMoney('price', remainingOf(row)),
    state: declarationStateOf(facts),
    checkedById: row.checkedById,
    receiptFileId: row.receiptFileId,
    revokeReason: row.revokeReason,
    waits: switches.declarationsOfIntentOn ? null : SWITCH_WORDS.declarationsOfIntentOn.off,
    invoices: [
      ...named.map((one) => ({ id: one.id, docType: one.docType, number: one.number, issueDate: one.issueDate ? dayOf(one.issueDate) : null, intentAmount: asMoney('price', amounts.get(one.id) ?? 0) })),
      ...credits.map((one) => ({ id: one.id, docType: one.docType, number: one.number, issueDate: one.issueDate ? dayOf(one.issueDate) : null, intentAmount: asMoney('price', -(amounts.get(one.id) ?? 0)) })),
    ],
  }
}

/** invoices.view: the declarations of the companies and customers the caller sees, newest first. */
export async function listDeclarations(caller: CommandCaller, query: { companyId?: string | undefined; partyId?: string | undefined; year?: number | undefined; state?: DeclarationState | undefined }) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const scope = scopeWhere(actorOf(context), INVOICES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.DeclarationOfIntentWhereInput
    const rows = await client.declarationOfIntent.findMany({
      where: { AND: [scope, ...(query.companyId ? [{ companyId: query.companyId }] : []), ...(query.partyId ? [{ partyId: query.partyId }] : []), ...(query.year ? [{ year: query.year }] : [])] },
      select: DECLARATION_COLUMNS,
      orderBy: [{ protocolDate: 'desc' }, { id: 'desc' }],
      take: 500,
    })
    const views = []
    for (const row of rows) {
      if (query.state && declarationStateOf(declarationFactsOf(row)) !== query.state) continue
      views.push(await declarationView(client, row))
    }
    return { declarations: views }
  })
}

/** The declaration the office may see (404) and act on with `permission` (403). */
async function officeDeclaration(caller: CommandCaller, declarationId: string, permission: Permission = INVOICES_VIEW): Promise<DeclarationRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readDeclaration(client, declarationId))
  assertCompany(context, INVOICES_VIEW, permission, row ? { companyId: row.companyId, partyId: row.partyId } : null, 'Declaration of intent')
  return row!
}

export async function getDeclaration(caller: CommandCaller, declarationId: string) {
  const row = await officeDeclaration(caller, declarationId)
  return { declaration: await caller.withClient((client) => declarationView(client, row)) }
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export interface CreateDeclarationInput {
  readonly companyId: string
  readonly partyId: string
  readonly protocolNumber: string
  readonly protocolDate: string
  readonly year?: number | undefined
  /** The price grain's (the API refuses it from staff without it). */
  readonly amount?: number | undefined
}

/** invoices.tax.manage: records a customer's declaration (UNCHECKED until the check on the tax agency's site). */
export async function createDeclaration(caller: CommandCaller, body: CreateDeclarationInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_TAX_MANAGE, { companyId: body.companyId, partyId: body.partyId }, 'Customer')
  if (body.amount === undefined) throw new ValidationError('Send the amount declared for our supplies.', [{ path: 'body/amount', message: 'Required.' }])
  const today = businessDate(serverClock.now())
  const input = { protocolNumber: body.protocolNumber.trim(), protocolDate: body.protocolDate, year: body.year ?? Number.parseInt(body.protocolDate.slice(0, 4), 10), amount: body.amount }
  const problems = declarationProblems(input, today)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'This declaration of intent cannot be recorded.', problems)
  return refusingInWords(async () => {
    const { result } = await command(caller, { name: 'invoices.createDeclarationOfIntent', idempotencyKey, input: body }, async (tools) => {
      const party = await tools.tx.party.findUnique({ where: { id: body.partyId }, select: { companyId: true, roles: true } })
      if (!party || (party.companyId !== null && party.companyId !== body.companyId)) throw new NotFoundError('Customer not found.')
      if (!party.roles.includes('CUSTOMER')) throw refused('NOT_CUSTOMER', 'A declaration of intent is a customer\'s: this party is not one of our customers.')
      if (!(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
      const id = newId()
      const row = await tools.tx.declarationOfIntent.create({
        data: { id, companyId: body.companyId, partyId: body.partyId, protocolNumber: input.protocolNumber, protocolDate: dayValue(input.protocolDate), year: input.year, amount: input.amount, createdById: actorIdOf(tools) },
        select: DECLARATION_COLUMNS,
      })
      tools.audit({ action: 'invoices.createDeclarationOfIntent', recordType: 'DeclarationOfIntent', recordId: id, companyId: body.companyId, after: { partyId: body.partyId, protocolNumber: input.protocolNumber, protocolDate: input.protocolDate, year: input.year, amount: markMoney('price', input.amount) } })
      tools.emit({ type: 'declaration_of_intent.changed', subject: id, companyId: body.companyId, payload: { declarationId: id, partyId: body.partyId, action: 'CREATED', invoiceId: null } })
      return { declaration: await declarationView(tools.tx, row) }
    })
    return result
  })
}

async function onDeclaration<T>(caller: CommandCaller, row: DeclarationRow, spec: { name: `invoices.${string}`; idempotencyKey: string | undefined; input: unknown; version: number }, work: (tools: CommandTools, current: DeclarationRow) => Promise<T>): Promise<T> {
  return refusingInWords(async () => {
    const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'DeclarationOfIntent', id: row.id, expectedVersion: spec.version } }, async (tools) => {
      const current = (await readDeclaration(tools.tx, row.id))!
      if (current.revokedAt) throw refused('REVOKED', `Declaration of intent ${current.protocolNumber} was revoked on ${dayOf(current.revokedAt)}: it changes no more.`)
      return work(tools, current)
    })
    return result
  })
}

/**
 * invoices.tax.manage: records the check of the protocol on the tax agency's site, with the receipt it printed (a file of
 * this declaration and its company, uploaded first): when and by whom, once.
 */
export async function checkDeclaration(caller: CommandCaller, declarationId: string, body: { version: number; receiptFileId: string }, idempotencyKey?: string) {
  const row = await officeDeclaration(caller, declarationId, INVOICES_TAX_MANAGE)
  return onDeclaration(caller, row, { name: 'invoices.checkDeclarationOfIntent', idempotencyKey, input: { declarationId, ...body }, version: body.version }, async (tools, current) => {
    if (current.checkedAt) throw refused('CHECKED', `Declaration of intent ${current.protocolNumber} was checked on ${dayOf(current.checkedAt)}: the check is recorded once.`)
    const file = await tools.tx.storedFile.findUnique({ where: { id: body.receiptFileId }, select: { recordType: true, recordId: true, companyId: true, status: true } })
    if (!file || file.recordType !== 'DeclarationOfIntent' || file.recordId !== current.id || file.companyId !== current.companyId) {
      throw refused('RECEIPT', "The receipt is a file uploaded on this declaration (its company's): upload the page the tax agency's site printed, then record the check.")
    }
    if (file.status !== 'AVAILABLE') throw refused('RECEIPT', 'The receipt is not available yet (its upload is not confirmed, or it is held by the virus check): confirm it first.')
    const updated = await tools.tx.declarationOfIntent.update({ where: { id: current.id }, data: { checkedAt: tools.now, checkedById: actorIdOf(tools), receiptFileId: body.receiptFileId }, select: DECLARATION_COLUMNS })
    tools.audit({ recordType: 'DeclarationOfIntent', recordId: current.id, companyId: current.companyId, before: { checkedAt: null }, after: { checkedAt: toUtcIso(tools.now), receiptFileId: body.receiptFileId } })
    tools.emit({ type: 'declaration_of_intent.changed', subject: current.id, companyId: current.companyId, payload: { declarationId: current.id, partyId: current.partyId, action: 'CHECKED', invoiceId: null } })
    return { declaration: await declarationView(tools.tx, updated) }
  })
}

/** invoices.tax.manage: revokes a declaration with why (the customer withdrew it, or it proved invalid); then frozen. */
export async function revokeDeclaration(caller: CommandCaller, declarationId: string, body: { version: number; reason: string }, idempotencyKey?: string) {
  const row = await officeDeclaration(caller, declarationId, INVOICES_TAX_MANAGE)
  return onDeclaration(caller, row, { name: 'invoices.revokeDeclarationOfIntent', idempotencyKey, input: { declarationId, ...body }, version: body.version }, async (tools, current) => {
    const drafts = await tools.tx.invoice.count({ where: { declarationOfIntentId: current.id, status: 'DRAFT' } })
    const updated = await tools.tx.declarationOfIntent.update({ where: { id: current.id }, data: { revokedAt: tools.now, revokeReason: body.reason.trim() }, select: DECLARATION_COLUMNS })
    tools.audit({ recordType: 'DeclarationOfIntent', recordId: current.id, companyId: current.companyId, before: { revokedAt: null }, after: { revokedAt: toUtcIso(tools.now), drafts }, reason: body.reason.trim() })
    tools.emit({ type: 'declaration_of_intent.changed', subject: current.id, companyId: current.companyId, payload: { declarationId: current.id, partyId: current.partyId, action: 'REVOKED', invoiceId: null } })
    return { declaration: await declarationView(tools.tx, updated) }
  })
}
