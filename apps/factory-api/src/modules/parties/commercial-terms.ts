import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { PARTIES_MANAGE } from '@nexus/factory-domain/parties/permissions'
import { isCustomer, type PartyRole } from '@nexus/factory-domain/parties/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { PRICE_LISTS_MANAGE, PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import type { PriceListKind } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { commercialTermsProblems, depositOf, instalmentsOf, invoiceTypePreset, termsSummary, type InvoiceTiming } from '@nexus/factory-domain/sales/terms/terms'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import type { OfficeContext } from '../../core/context'
import { givePriceListInCommand } from '../sales/pricelists/assignments'
import { listCodesOf, listProblemFor } from '../sales/pricelists/lists'
import { LIST_COLUMNS, mayOnList } from '../sales/pricelists/store'
import { officeContextOf, type Reader } from '../sales/quotes/store'
import { termsForParty } from '../sales/terms/terms'
import { assertMayWrite, assertWritable, readParty } from './store'

/**
 * A customer's commercial terms (B-W2a-19; SAL-012; design sales.customers record, Tax & terms › "Commercial terms":
 * "defaults copied to new quotes and orders"): the currency and language of its documents, its payment terms from the
 * library (FIN-075), its price list (SAL-165; a discount group is a GROUP list), its default deposit, how its goods are
 * invoiced (per shipment: an immediate invoice TD01; monthly: one deferred TD24), its Incoterms 2020 rule, preferred
 * carrier and minimum order (the price grain). Read with parties.view; changed with parties.manage on the customer
 * (giving it a price list also needs pricelists.manage on the list) in ONE command on the party: its version guards the
 * change and its bump locks the row; the terms' and the list's rows are then held FOR SHARE, so an archive waits and
 * counts this customer. The quote takes them when it is made (modules/sales/quotes quotes.ts).
 */

const COLUMNS = {
  id: true,
  code: true,
  companyId: true,
  roles: true,
  status: true,
  currency: true,
  language: true,
  paymentTerms: true,
  paymentTermsId: true,
  priceListId: true,
  defaultDepositPct: true,
  invoiceTiming: true,
  incoterm: true,
  preferredCarrierCode: true,
  minimumOrderAmount: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.PartySelect
type TermsPartyRow = Prisma.PartyGetPayload<{ select: typeof COLUMNS }>

/** The price lists a customer is priced from: its own, then those it falls back to (at most 8). */
async function chainOf(db: Reader, listId: string | null) {
  const chain: { id: string; code: string; name: string; kind: PriceListKind; currency: string; status: string; companyId: string | null }[] = []
  for (let id = listId; id !== null && chain.length < 8 && !chain.some((row) => row.id === id); ) {
    const row = await db.priceList.findUnique({ where: { id }, select: LIST_COLUMNS })
    if (!row) break
    chain.push({ id: row.id, code: row.code, name: row.name, kind: row.kind as PriceListKind, currency: row.currency, status: row.status, companyId: row.companyId })
    id = row.baseListId
  }
  return chain
}

/** The commercial terms as the customer's card reads them. */
export async function commercialTermsOf(db: Reader, partyId: string) {
  const party: TermsPartyRow = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: COLUMNS })
  const terms = party.paymentTermsId ? await db.paymentTerms.findUnique({ where: { id: party.paymentTermsId }, select: { id: true, code: true, name: true, nameI18n: true, method: true, instalments: true, earlyPaymentDiscountPct: true, earlyPaymentDays: true, status: true, companyId: true } }) : null
  const chain = await chainOf(db, party.priceListId)
  const facts = terms ? { method: terms.method, instalments: instalmentsOf(terms.instalments), earlyPaymentDiscountPct: terms.earlyPaymentDiscountPct === null ? null : decimalText(terms.earlyPaymentDiscountPct.toString()), earlyPaymentDays: terms.earlyPaymentDays } : null
  const group = chain.find((row) => row.kind === 'GROUP') ?? null
  return {
    partyId: party.id,
    code: party.code,
    companyId: party.companyId,
    currency: party.currency,
    language: party.language,
    paymentTermsId: party.paymentTermsId,
    paymentTerms: terms && facts ? { id: terms.id, code: terms.code, name: terms.name, companyId: terms.companyId, status: terms.status, summary: { it: termsSummary(facts, 'it'), en: termsSummary(facts, 'en') }, deposit: depositOf(facts.instalments) } : null,
    /** The W1 printed text (used on its quotes when it has no library terms; its purchase orders as a supplier). */
    paymentTermsText: party.paymentTerms,
    priceListId: party.priceListId,
    priceList: chain[0] ?? null,
    /** The first GROUP list it is priced from (its own or one its list falls back to): its discount group. */
    discountGroup: group ? { id: group.id, code: group.code, name: group.name } : null,
    /** Its list and the lists it falls back to, in order. */
    priceChain: chain,
    defaultDepositPct: party.defaultDepositPct === null ? null : decimalText(party.defaultDepositPct.toString()),
    invoiceTiming: party.invoiceTiming as InvoiceTiming,
    /** The invoice its shipped goods get by default: TD01 per shipment, TD24 once a month. */
    invoiceTypePreset: invoiceTypePreset(party.invoiceTiming as InvoiceTiming),
    incoterm: party.incoterm,
    preferredCarrierCode: party.preferredCarrierCode,
    minimumOrderAmount: asMoney('price', party.minimumOrderAmount),
    version: party.version,
  }
}
export type CommercialTermsView = Awaited<ReturnType<typeof commercialTermsOf>>

/** GET /parties/:partyId/commercial-terms (parties.view). */
export async function getCommercialTerms(caller: CommandCaller, partyId: string): Promise<{ terms: CommercialTermsView }> {
  await readParty(caller, partyId)
  return caller.withClient(async (client) => ({ terms: await commercialTermsOf(client, partyId) }))
}

export interface CommercialTermsBody {
  readonly version: number
  readonly currency?: string | undefined
  readonly language?: string | undefined
  readonly paymentTermsId?: string | null | undefined
  readonly priceListId?: string | null | undefined
  readonly defaultDepositPct?: string | null | undefined
  readonly invoiceTiming?: InvoiceTiming | undefined
  readonly incoterm?: string | null | undefined
  readonly preferredCarrierCode?: string | null | undefined
  readonly minimumOrderAmount?: number | null | undefined
}

const FIELDS = ['currency', 'language', 'paymentTermsId', 'priceListId', 'defaultDepositPct', 'invoiceTiming', 'incoterm', 'preferredCarrierCode', 'minimumOrderAmount'] as const
type Field = (typeof FIELDS)[number]

const fieldsOf = (row: TermsPartyRow) => ({
  currency: row.currency,
  language: row.language,
  paymentTermsId: row.paymentTermsId,
  priceListId: row.priceListId,
  defaultDepositPct: row.defaultDepositPct === null ? null : decimalText(row.defaultDepositPct.toString()),
  invoiceTiming: row.invoiceTiming as InvoiceTiming,
  incoterm: row.incoterm,
  preferredCarrierCode: row.preferredCarrierCode,
  minimumOrderAmount: row.minimumOrderAmount,
})
type Fields = ReturnType<typeof fieldsOf>

/** Audit values: the price list as `listId`, the minimum order with its grain. */
const auditOf = (fields: Fields) => ({
  currency: fields.currency,
  language: fields.language,
  paymentTermsId: fields.paymentTermsId,
  listId: fields.priceListId,
  defaultDepositPct: fields.defaultDepositPct,
  invoiceTiming: fields.invoiceTiming,
  incoterm: fields.incoterm,
  preferredCarrierCode: fields.preferredCarrierCode,
  minimumOrderAmount: markMoney('price', fields.minimumOrderAmount),
})

/** The price list given to this customer: visible, the caller may give it (pricelists.manage), active, of its company and currency. */
async function checkList(tx: CommandTx, context: OfficeContext, listId: string, party: { companyId: string | null; currency: string; code: string }): Promise<Issue | null> {
  const list = isUuid(listId) ? await tx.priceList.findUnique({ where: { id: listId }, select: LIST_COLUMNS }) : null
  const path = 'body/priceListId'
  if (!list || !mayOnList(context, PRICE_LISTS_VIEW, list.companyId)) return { path, message: 'Not a price list you may see.' }
  if (!mayOnList(context, PRICE_LISTS_MANAGE, list.companyId)) return { path, message: `You may not give customers ${list.code}: that needs the right to keep price lists.` }
  const problem = listProblemFor(list, party)
  return problem ? { path, message: problem } : null
}

/** PATCH /parties/:partyId/commercial-terms (parties.manage): the fields sent, with the party's version. */
export async function updateCommercialTerms(caller: CommandCaller, partyId: string, body: CommercialTermsBody, idempotencyKey?: string): Promise<{ terms: CommercialTermsView }> {
  const context = officeContextOf(caller)
  const seen = await readParty(caller, partyId)
  assertMayWrite(context, PARTIES_MANAGE, seen)
  assertWritable(seen.status)
  const sent = FIELDS.filter((field) => body[field] !== undefined)
  if (sent.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
  const problems = commercialTermsProblems(body).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The commercial terms are not valid.', problems)
  if (body.paymentTermsId) await termsForParty(caller, body.paymentTermsId, seen.companyId, 'body/paymentTermsId')

  const { result } = await command(caller, { name: 'parties.setCommercialTerms', idempotencyKey, input: { partyId, ...body }, record: { type: 'Party', id: partyId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: COLUMNS })
    assertWritable(row.status as never)
    if (!isCustomer(row.roles as PartyRole[])) throw new InvalidStateError(`${row.code} is not a customer: commercial terms are a customer's (give it the customer or brand role first).`)
    const before = fieldsOf(row)
    const next: Fields = {
      currency: body.currency ?? before.currency,
      language: body.language ?? before.language,
      paymentTermsId: body.paymentTermsId === undefined ? before.paymentTermsId : body.paymentTermsId,
      priceListId: body.priceListId === undefined ? before.priceListId : body.priceListId,
      defaultDepositPct: body.defaultDepositPct === undefined ? before.defaultDepositPct : body.defaultDepositPct === null ? null : decimalText(body.defaultDepositPct),
      invoiceTiming: body.invoiceTiming ?? before.invoiceTiming,
      incoterm: body.incoterm === undefined ? before.incoterm : body.incoterm,
      preferredCarrierCode: body.preferredCarrierCode === undefined ? before.preferredCarrierCode : body.preferredCarrierCode === null ? null : body.preferredCarrierCode.trim(),
      minimumOrderAmount: body.minimumOrderAmount === undefined ? before.minimumOrderAmount : body.minimumOrderAmount,
    }
    const changed = FIELDS.filter((field: Field) => String(next[field]) !== String(before[field]))
    // The rows it now names, held until the commit (an archive of them waits, then counts this customer).
    if (next.paymentTermsId !== null && changed.includes('paymentTermsId')) {
      await tx.$queryRaw`SELECT id FROM "PaymentTerms" WHERE id = ${next.paymentTermsId}::uuid FOR SHARE`
      const terms = await tx.paymentTerms.findUnique({ where: { id: next.paymentTermsId }, select: { status: true, code: true } })
      if (terms?.status !== 'ACTIVE') throw new ValidationError(`${terms?.code ?? 'These terms'} were just archived.`, [{ path: 'body/paymentTermsId', message: 'Archived payment terms.' }])
    }
    if (next.priceListId !== null && (changed.includes('priceListId') || changed.includes('currency'))) {
      await tx.$queryRaw`SELECT id FROM "PriceList" WHERE id = ${next.priceListId}::uuid FOR SHARE`
      const issue = changed.includes('priceListId')
        ? await checkList(tx, context, next.priceListId, { companyId: row.companyId, currency: next.currency, code: row.code })
        : (async () => {
            const list = await tx.priceList.findUniqueOrThrow({ where: { id: next.priceListId! }, select: LIST_COLUMNS })
            const problem = list.currency === next.currency ? null : `${row.code} is priced from ${list.code} (${list.currency}): give it a list in ${next.currency} with its new currency.`
            return problem ? { path: 'body/currency', message: problem } : null
          })()
      const found = await issue
      if (found) throw new ValidationError(found.message, [found])
    }
    // B-W2b-16: the customer's list history follows its list (from today; one change per day).
    if (changed.includes('priceListId')) {
      const codes = await listCodesOf(tx, [before.priceListId, next.priceListId].filter((id): id is string => id !== null))
      await givePriceListInCommand(tools, { id: row.id, code: row.code, priceListId: before.priceListId, createdAt: row.createdAt }, next.priceListId, (id) => codes.get(id) ?? id)
    }
    if (changed.length > 0) {
      await tx.party.update({
        where: { id: partyId },
        data: {
          currency: next.currency,
          language: next.language,
          paymentTermsId: next.paymentTermsId,
          priceListId: next.priceListId,
          defaultDepositPct: next.defaultDepositPct,
          invoiceTiming: next.invoiceTiming,
          incoterm: next.incoterm,
          preferredCarrierCode: next.preferredCarrierCode,
          minimumOrderAmount: next.minimumOrderAmount,
          updatedAt: now,
        },
        select: { id: true },
      })
    }
    tools.audit({ action: 'parties.setCommercialTerms', recordType: 'Party', recordId: partyId, companyId: row.companyId, before: auditOf(before), after: auditOf(next) })
    if (changed.length > 0) tools.emit({ type: 'party.updated', subject: partyId, companyId: row.companyId, payload: { partyId, code: row.code, fields: [...changed] } })
    return { terms: await commercialTermsOf(tx, partyId) }
  })
  return result
}
