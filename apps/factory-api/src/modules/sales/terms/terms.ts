import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PAYMENT_TERMS_MANAGE, PAYMENT_TERMS_VIEW } from '@nexus/factory-domain/sales/terms/permissions'
import { checkPaymentTerms, type InstalmentInput, type PaymentTermsFields } from '@nexus/factory-domain/sales/terms/terms'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../quotes/store'
import { assertMayChangeTerms, customersOf, mayOnTerms, readTermsFor, TERMS_COLUMNS, TERMS_SCOPE, termsFactsOf, termsUse, termsViewOf, type TermsRow, type TermsView } from './store'

/**
 * The payment terms library (B-W2a-19; FIN-075; design finance.settings "Payment terms": a grid, Add · edit): the list
 * and one entry (paymentterms.view), a new entry, an edit, archive and reactivate (paymentterms.manage), each ONE command
 * on the entry (its version is the edit-conflict guard; its bump locks the row). The rules are factory-domain
 * sales/terms (`checkPaymentTerms`): a code, the printed name (and its other languages), the FatturaPA payment method,
 * the instalments totalling 100 with at most one on the order (the deposit), the early-payment discount both or neither.
 * An edit never rewrites a document: a quote, an order and an invoice keep their own printed text and dates; once a quote
 * version or an order names the terms, their rules (method, instalments, early-payment discount) are fixed and only
 * their code and names change (new rules are new terms). Terms are
 * archived, never deleted; they cannot be archived while a customer has them as its default (change those first), so a
 * new quote never starts on archived terms.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The payment terms are not valid.', issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
const codeTaken = (code: string) => new ConflictError(`The payment terms code ${code} is taken.`)
const isUnique = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** The terms after a write, in the command. */
async function viewInCommand(tools: CommandTools, id: string): Promise<{ terms: TermsView }> {
  const row = await tools.tx.paymentTerms.findUniqueOrThrow({ where: { id }, select: TERMS_COLUMNS })
  return { terms: termsViewOf(row, (await customersOf(tools.tx, [id])).get(id) ?? 0) }
}

const auditOf = (fields: PaymentTermsFields | ReturnType<typeof termsFactsOf>) => ({
  code: fields.code,
  name: fields.name,
  nameI18n: (fields.nameI18n ?? null) as Prisma.InputJsonValue | null,
  method: fields.method,
  instalments: fields.instalments.map((item) => ({ ...item })),
  earlyPaymentDiscountPct: fields.earlyPaymentDiscountPct,
  earlyPaymentDays: fields.earlyPaymentDays,
})

// ---- reads --------------------------------------------------------------------------------------------------------------

export interface ListTermsQuery {
  readonly companyId?: string | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined
  readonly q?: string | undefined
}

/**
 * GET /sales/payment-terms: the library the caller may see, by code (active ones unless asked). With `companyId`, what
 * that company may use: its own terms and every company's.
 */
export async function listTerms(caller: CommandCaller, query: ListTermsQuery): Promise<{ terms: TermsView[] }> {
  const context = officeContextOf(caller)
  const search = query.q?.trim()
  const where: Prisma.PaymentTermsWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PAYMENT_TERMS_VIEW, TERMS_SCOPE) as Prisma.PaymentTermsWhereInput,
      query.status === 'ALL' ? {} : { status: query.status ?? 'ACTIVE' },
      query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
      search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.paymentTerms.findMany({ where, select: TERMS_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 500 })
    const customers = await customersOf(client, rows.map((row) => row.id))
    return { terms: rows.map((row) => termsViewOf(row, customers.get(row.id) ?? 0)) }
  })
}

/** GET /sales/payment-terms/:termsId. */
export async function getTerms(caller: CommandCaller, termsId: string): Promise<{ terms: TermsView }> {
  const row = await readTermsFor(caller, termsId)
  return caller.withClient(async (client) => ({ terms: termsViewOf(row, (await customersOf(client, [row.id])).get(row.id) ?? 0) }))
}

// ---- writes ------------------------------------------------------------------------------------------------------------

export interface TermsBody {
  readonly code: string
  readonly name: string
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly method: string
  readonly instalments: readonly InstalmentInput[]
  readonly earlyPaymentDiscountPct?: string | null | undefined
  readonly earlyPaymentDays?: number | null | undefined
}

/** POST /sales/payment-terms (paymentterms.manage over the company, or every company for terms of every company). */
export async function createTerms(caller: CommandCaller, body: TermsBody & { companyId?: string | null | undefined }, idempotencyKey?: string): Promise<{ terms: TermsView }> {
  const context = officeContextOf(caller)
  const companyId = body.companyId ?? null
  assertMayChangeTerms(context, PAYMENT_TERMS_MANAGE, companyId)
  const checked = checkPaymentTerms(body)
  if (!checked.ok) throw invalid(checked.issues)
  const fields = checked.terms
  const { result } = await command(caller, { name: 'paymentTerms.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new ValidationError('No such company.', [{ path: 'body/companyId', message: 'No such company.' }])
    if (await tx.paymentTerms.findFirst({ where: { code: fields.code }, select: { id: true } })) throw codeTaken(fields.code)
    const id = newId()
    await tx.paymentTerms.create({
      data: {
        id,
        companyId,
        code: fields.code,
        name: fields.name,
        nameI18n: (fields.nameI18n ?? undefined) as Prisma.InputJsonValue | undefined,
        method: fields.method,
        instalments: fields.instalments.map((item) => ({ ...item })) as Prisma.InputJsonValue,
        earlyPaymentDiscountPct: fields.earlyPaymentDiscountPct,
        earlyPaymentDays: fields.earlyPaymentDays,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'paymentTerms.create', recordType: 'PaymentTerms', recordId: id, companyId, after: { companyId, status: 'ACTIVE', ...auditOf(fields) } })
    tools.emit({ type: 'payment_terms.changed', subject: id, companyId, payload: { paymentTermsId: id, code: fields.code, change: 'CREATED', fields: [] } })
    return viewInCommand(tools, id)
  }).catch((error: unknown) => {
    if (isUnique(error)) throw codeTaken(fields.code)
    throw error
  })
  return result
}

const FIELDS = ['code', 'name', 'nameI18n', 'method', 'instalments', 'earlyPaymentDiscountPct', 'earlyPaymentDays'] as const
/** The fields that decide what is due when: fixed once a quote version or an order names the terms. */
const RULE_FIELDS: readonly string[] = ['method', 'instalments', 'earlyPaymentDiscountPct', 'earlyPaymentDays']

/**
 * PATCH /sales/payment-terms/:termsId: the fields sent (with the entry's version). Archived terms are reactivated
 * before they change. Documents already made keep their own copy.
 */
export async function updateTerms(caller: CommandCaller, termsId: string, body: Partial<TermsBody> & { version: number }, idempotencyKey?: string): Promise<{ terms: TermsView }> {
  const context = officeContextOf(caller)
  const seen = await readTermsFor(caller, termsId)
  assertMayChangeTerms(context, PAYMENT_TERMS_MANAGE, seen.companyId)
  const sent = FIELDS.filter((field) => body[field] !== undefined)
  if (sent.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
  const { result } = await command(caller, { name: 'paymentTerms.update', idempotencyKey, input: { termsId, ...body }, record: { type: 'PaymentTerms', id: termsId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.paymentTerms.findUniqueOrThrow({ where: { id: termsId }, select: TERMS_COLUMNS })
    if (row.status === 'ARCHIVED') throw new InvalidStateError('These payment terms are archived: reactivate them before changing them.')
    const before = termsFactsOf(row)
    const checked = checkPaymentTerms({
      code: body.code ?? before.code,
      name: body.name ?? before.name,
      nameI18n: body.nameI18n === undefined ? (before.nameI18n as Record<string, string> | null) : body.nameI18n,
      method: body.method ?? before.method,
      instalments: body.instalments ?? before.instalments,
      earlyPaymentDiscountPct: body.earlyPaymentDiscountPct === undefined ? before.earlyPaymentDiscountPct : blankToNull(body.earlyPaymentDiscountPct),
      earlyPaymentDays: body.earlyPaymentDays === undefined ? before.earlyPaymentDays : body.earlyPaymentDays,
    })
    if (!checked.ok) throw invalid(checked.issues)
    const next = checked.terms
    const changed = FIELDS.filter((field) => JSON.stringify(auditOf(before)[field]) !== JSON.stringify(auditOf(next)[field]))
    // Terms in use keep their rules: quotes sent with them, the deposit requests and payment schedules made from them,
    // and the invoices' due dates follow them. Their names may still change (each document keeps its printed copy).
    const rules = changed.filter((field) => RULE_FIELDS.includes(field))
    if (rules.length > 0) {
      const use = await termsUse(tx, termsId)
      if (use.quoteVersions + use.orders > 0) {
        throw new ConflictError(
          `${row.code} is used by ${use.quoteVersions} quote ${use.quoteVersions === 1 ? 'version' : 'versions'} and ${use.orders} ${use.orders === 1 ? 'order' : 'orders'}: its payment method, instalments and early-payment discount stay as they are. Add new terms for other rules and give them to the customers.`,
        )
      }
    }
    if (changed.includes('code') && (await tx.paymentTerms.findFirst({ where: { code: next.code, id: { not: termsId } }, select: { id: true } }))) throw codeTaken(next.code)
    if (changed.length > 0) {
      await tx.paymentTerms.update({
        where: { id: termsId },
        data: {
          code: next.code,
          name: next.name,
          nameI18n: next.nameI18n === null ? undefined : (next.nameI18n as Prisma.InputJsonValue),
          method: next.method,
          instalments: next.instalments.map((item) => ({ ...item })) as Prisma.InputJsonValue,
          earlyPaymentDiscountPct: next.earlyPaymentDiscountPct,
          earlyPaymentDays: next.earlyPaymentDays,
          updatedAt: now,
        },
        select: { id: true },
      })
      // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
      if (next.nameI18n === null && row.nameI18n !== null) await tx.$executeRaw`UPDATE "PaymentTerms" SET "nameI18n" = NULL WHERE "id" = ${termsId}::uuid`
    }
    tools.audit({ action: 'paymentTerms.update', recordType: 'PaymentTerms', recordId: termsId, companyId: row.companyId, before: auditOf(before), after: auditOf(next) })
    if (changed.length > 0) tools.emit({ type: 'payment_terms.changed', subject: termsId, companyId: row.companyId, payload: { paymentTermsId: termsId, code: next.code, change: 'UPDATED', fields: [...changed] } })
    return viewInCommand(tools, termsId)
  }).catch((error: unknown) => {
    if (isUnique(error)) throw new ConflictError('The payment terms code is taken.')
    throw error
  })
  return result
}

/**
 * POST /sales/payment-terms/:termsId/archive | reactivate (with the version). Archiving is refused while a customer has
 * the terms as its default, in words, with how many; a quote or an order that already took them keeps them.
 */
export async function moveTerms(caller: CommandCaller, termsId: string, move: 'archive' | 'reactivate', body: { version: number }, idempotencyKey?: string): Promise<{ terms: TermsView }> {
  const context = officeContextOf(caller)
  const seen = await readTermsFor(caller, termsId)
  assertMayChangeTerms(context, PAYMENT_TERMS_MANAGE, seen.companyId)
  const to = move === 'archive' ? 'ARCHIVED' : 'ACTIVE'
  const { result } = await command(caller, { name: `paymentTerms.${move}`, idempotencyKey, input: { termsId, ...body }, record: { type: 'PaymentTerms', id: termsId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row: TermsRow = await tx.paymentTerms.findUniqueOrThrow({ where: { id: termsId }, select: TERMS_COLUMNS })
    if (row.status === to) throw new InvalidStateError(move === 'archive' ? 'These payment terms are archived already.' : 'These payment terms are active already.')
    if (move === 'archive') {
      const users = await tx.party.count({ where: { paymentTermsId: termsId, status: { not: 'ARCHIVED' } } })
      if (users > 0) throw new ConflictError(`${users} ${users === 1 ? 'customer has' : 'customers have'} ${row.code} as ${users === 1 ? 'its' : 'their'} default payment terms: give ${users === 1 ? 'it' : 'them'} other terms first.`)
    }
    await tx.paymentTerms.update({ where: { id: termsId }, data: { status: to, updatedAt: now }, select: { id: true } })
    tools.audit({ action: `paymentTerms.${move}`, recordType: 'PaymentTerms', recordId: termsId, companyId: row.companyId, before: { status: row.status }, after: { status: to } })
    tools.emit({ type: 'payment_terms.changed', subject: termsId, companyId: row.companyId, payload: { paymentTermsId: termsId, code: row.code, change: move === 'archive' ? 'ARCHIVED' : 'REACTIVATED', fields: ['status'] } })
    return viewInCommand(tools, termsId)
  })
  return result
}

/** Terms the caller may give to a customer of `companyId` (paymentterms.view on them), active, of that company or every company. */
export async function termsForParty(caller: CommandCaller, termsId: string, partyCompanyId: string | null, path: string): Promise<TermsRow> {
  const context = officeContextOf(caller)
  const row = await readTermsFor(caller, termsId).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new ValidationError('No such payment terms.', [{ path, message: 'Not payment terms of the library you may see.' }])
    throw error
  })
  if (!mayOnTerms(context, PAYMENT_TERMS_VIEW, row.companyId)) throw new ValidationError('No such payment terms.', [{ path, message: 'Not payment terms of the library you may see.' }])
  if (row.status !== 'ACTIVE') throw new ValidationError(`${row.code} is archived: give the customer active terms.`, [{ path, message: 'Archived payment terms.' }])
  if (row.companyId !== null && partyCompanyId !== null && row.companyId !== partyCompanyId) throw new ValidationError(`${row.code} belongs to another company.`, [{ path, message: "Terms of the customer's company, or of every company." }])
  return row
}
