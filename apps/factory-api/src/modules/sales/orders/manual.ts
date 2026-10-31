import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { fitsDecimal, fromMinorUnits, toMinorUnits, type CurrencyCode, type MinorUnits } from '@nexus/factory-domain/core/money'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { formatNumber } from '@nexus/factory-domain/numbering/format'
import { isNumberValue, scopeKeyFor, yearOfScope } from '@nexus/factory-domain/numbering/kinds'
import { depositRequestFor } from '@nexus/factory-domain/sales/deposits/deposits'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { paymentScheduleOf } from '@nexus/factory-domain/sales/orders/schedule'
import { isIssueList, MAX_QUOTE_LINES, MAX_TEXT, priceBasisOf, versionTaxModeOf, type DepositKind } from '@nexus/factory-domain/sales/quotes/quotes'
import { depositDueDaysOf, quoteDefaultsOf, type Instalment } from '@nexus/factory-domain/sales/terms/terms'
import type { PartyTaxMode } from '@nexus/factory-domain/parties/tax'
import { DEPOSIT_DUE_DAYS } from '@nexus/factory-domain/sales/quotes/terms'
import { Dec, HUNDRED, parseDecimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { chainForQuote } from '../quotes/list-price'
import { decideTreatment, type SheetCache } from '../quotes/pricing'
import { quoteRulesFor } from '../quotes/rules'
import { partySnapshotsOf } from '../quotes/send'
import { quotePartyOf, type QuoteParty } from '../quotes/store'
import { termsForParty } from '../terms/terms'
import { usableTerms } from '../terms/store'
import { assertMay, officeContextOf } from './access'
import { recordAfter } from './moves'
import { newLineDraft, priceLines, type LineDraft, type NewLineInput, type PricedLines } from './pricing'
import { makeScheduleInCommand } from './schedule'
import { asDay, dayOf, hasOrderSeries, type Reader } from './store'
import type { OrderView } from './views'

/**
 * Manual order entry (B-W2a-30; SAL-202 "direct orders without a quote for repeat business"; the design's New order
 * dialog: customer, contact, customer PO, the number it will get → the lines → Confirm order). orders.manage over the
 * company and the customer. SalesOrder has no draft state: the draft is the screen's until "Confirm order", which sends
 * everything in ONE command; the preview prices it on the way (nothing written).
 *
 *   customer   a customer of the company (never BLOCKED or ARCHIVED) with a tax identity in force (the VAT of every line);
 *              its ORDERS contact, its default invoice and delivery addresses (both needed: the order freezes them as a
 *              send does), its library terms (B-W2a-19 `quoteDefaultsOf`: the printed name in the order's language) and
 *              its deposit (its own %, else its terms' order share, else the sales settings')
 *   lines      as for a quote line (orders/pricing.ts): style and active colourway of the company, sizes offered, the
 *              customer's list price unless a price (or a discount off it) is typed, costed from today's sheet
 *   made       numbered from the company's SALES_ORDER series, CONFIRMED (quoteVersionId null), the deposit request
 *              (named on the order, no quote) when a deposit is asked: production waits for it (depositRequired); the
 *              payment schedule (SAL-216; a before-shipping step with its day gets its own deposit request, B-W2a-F2);
 *              sales_order.created
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export interface ManualOrderBody {
  readonly companyId: string
  readonly partyId: string
  readonly contactId?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly promiseDate?: BusinessDate | null | undefined
  /** Library terms; null: none (the printed text then); undefined: the customer's. */
  readonly paymentTermsId?: string | null | undefined
  readonly depositPct?: string | null | undefined
  readonly depositKind?: DepositKind | null | undefined
  readonly billToAddressId?: string | null | undefined
  readonly shipToAddressId?: string | null | undefined
  readonly language?: 'it' | 'en' | undefined
  readonly internalNote?: string | null | undefined
  readonly lines: readonly NewLineInput[]
}

interface ManualPlan {
  readonly party: QuoteParty
  readonly currency: string
  readonly taxMode: PartyTaxMode
  readonly language: 'it' | 'en'
  readonly contactId: string | null
  readonly billTo: unknown
  readonly shipTo: unknown
  readonly paymentTermsId: string | null
  readonly paymentTerms: string | null
  readonly instalments: readonly Instalment[] | null
  readonly depositPct: string | null
  readonly depositKind: DepositKind
  readonly depositAmount: MinorUnits | null
  readonly priced: PricedLines
  readonly customerRef: string | null
  readonly requestedDate: BusinessDate | null
  readonly promiseDate: BusinessDate | null
  readonly internalNote: string | null
}

/** The order as it would be made, or the problems in words (by path). A party that cannot be quoted is a 409. */
async function planManualOrder(db: Reader, body: ManualOrderBody, now: Date, picked: { id: string } | null): Promise<ManualPlan | Issue[]> {
  const today = businessDate(now)
  const issues: Issue[] = []
  const company = await db.company.findUnique({ where: { id: body.companyId }, select: { id: true, currency: true } })
  if (!company) throw new NotFoundError('Company not found.')
  const party = await quotePartyOf(db, body.partyId, today, now)
  if (!party || (party.row.companyId !== null && party.row.companyId !== company.id)) throw new NotFoundError('Customer not found.')
  if (!party.isCustomer) return [{ path: 'body/partyId', message: 'Give the party the customer (or brand) role first.' }]
  if (party.row.status === 'BLOCKED' || party.row.status === 'ARCHIVED') {
    throw new DomainError('conflict', `${party.row.legalName} is ${party.row.status.toLowerCase()}: no order is taken from it until it is active again.`, [{ path: 'body/partyId', message: `The customer is ${party.row.status}.` }])
  }
  const treatment = decideTreatment(party)
  const taxMode = versionTaxModeOf(party.identity!.taxMode, party.viesValid)

  // Its ORDERS contact, its default addresses (as a new quote takes them).
  const contactId =
    body.contactId === undefined
      ? ((await db.partyContact.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', roles: { has: 'ORDERS' } }, select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id ?? null)
      : body.contactId
  const contact = contactId ? await db.partyContact.findUnique({ where: { id: contactId }, select: { partyId: true, status: true, language: true } }) : null
  if (contactId && (!contact || contact.partyId !== party.row.id || contact.status !== 'ACTIVE')) issues.push({ path: 'body/contactId', message: 'Not an active contact of this customer.' })
  const address = async (flag: 'isDefaultBillTo' | 'isDefaultShipTo') => (await db.partyAddress.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', [flag]: true }, select: { id: true } }))?.id ?? null
  const billToAddressId = body.billToAddressId === undefined ? await address('isDefaultBillTo') : body.billToAddressId
  const shipToAddressId = body.shipToAddressId === undefined ? await address('isDefaultShipTo') : body.shipToAddressId
  const snapshots = await partySnapshotsOf(db, party, taxMode, billToAddressId, shipToAddressId, now)
  if (!snapshots.billTo) issues.push({ path: 'body/billToAddressId', message: billToAddressId ? 'Not an active invoice address of this customer.' : 'The customer has no default invoice address: add one or choose it.' })
  if (!snapshots.shipTo) issues.push({ path: 'body/shipToAddressId', message: shipToAddressId ? 'Not an active delivery address of this customer.' : 'The customer has no default delivery address: add one or choose it.' })
  const language = body.language ?? ((contact?.language ?? party.row.language) === 'it' ? 'it' : 'en')

  if (body.promiseDate && body.promiseDate < today) issues.push({ path: 'body/promiseDate', message: 'The promise date is today or later.' })
  if (body.requestedDate && body.requestedDate < today) issues.push({ path: 'body/requestedDate', message: 'The requested date is today or later.' })
  if (body.customerRef && body.customerRef.trim().length > MAX_TEXT.customerRef) issues.push({ path: 'body/customerRef', message: `At most ${MAX_TEXT.customerRef} characters.` })
  if (body.internalNote && body.internalNote.trim().length > MAX_TEXT.internalNote) issues.push({ path: 'body/internalNote', message: `At most ${MAX_TEXT.internalNote} characters.` })

  // The customer's commercial terms (B-W2a-19), or the terms chosen.
  const terms = picked ? await usableTerms(db, picked.id, company.id) : body.paymentTermsId === null ? null : await usableTerms(db, party.row.paymentTermsId, company.id)
  const rules = await quoteRulesFor(db, company.id)
  const defaults = quoteDefaultsOf({ partyDepositPct: party.row.defaultDepositPct === null ? null : party.row.defaultDepositPct.toString(), terms, partyTermsText: party.row.paymentTerms, settingsDepositPct: rules.defaultDepositPct, language })
  const depositPct = body.depositPct === undefined ? defaults.depositPct : blankToNull(body.depositPct)
  if (depositPct !== null) {
    const pct = parseDecimal(depositPct)
    if (pct === null || !fitsDecimal(depositPct, 7, 4) || pct.lte(0) || pct.gt(100)) issues.push({ path: 'body/depositPct', message: 'A deposit above 0 and at most 100 percent of the gross total, or none.' })
  }

  if (body.lines.length === 0) issues.push({ path: 'body/lines', message: 'An order has at least one line.' })
  if (body.lines.length > MAX_QUOTE_LINES) issues.push({ path: 'body/lines', message: `An order holds at most ${MAX_QUOTE_LINES} lines.` })
  const chain = await chainForQuote(db, { companyId: company.id }, { currency: company.currency, priceListVersionId: null }, party, now, [...new Set(body.lines.map((line) => line.styleId))])
  const cache: SheetCache = new Map()
  const drafts: LineDraft[] = []
  for (const [index, line] of body.lines.slice(0, MAX_QUOTE_LINES).entries()) {
    const draft = await newLineDraft(db, { companyId: company.id, taxMode, party, chain, cache, now }, line, (index + 1) * 10, `body/lines/${index}`)
    if (isIssueList(draft)) issues.push(...draft)
    else drafts.push(draft)
  }
  if (issues.length > 0) return issues
  const priced = priceLines(priceBasisOf(taxMode), company.currency, treatment, drafts)
  // The deposit as a quote asks it (sales/quotes priceVersion): gross × % ÷ 100, rounded once.
  const currency = company.currency as CurrencyCode
  const depositAmount = depositPct === null ? null : toMinorUnits(fromMinorUnits(priced.grossAmount, currency).times(new Dec(depositPct)).dividedBy(HUNDRED), currency)
  return {
    party,
    currency: company.currency,
    taxMode,
    language,
    contactId,
    billTo: snapshots.billTo,
    shipTo: snapshots.shipTo,
    paymentTermsId: terms?.id ?? null,
    paymentTerms: defaults.paymentTerms,
    instalments: terms?.instalments ?? null,
    depositPct,
    depositKind: body.depositKind ?? 'ACCONTO',
    depositAmount,
    priced,
    customerRef: blankToNull(body.customerRef),
    requestedDate: body.requestedDate ?? null,
    promiseDate: body.promiseDate ?? null,
    internalNote: blankToNull(body.internalNote),
  }
}

/** The next number of the company's SALES_ORDER series, as printed (a preview: nothing is allocated). */
async function nextNumberOf(db: Reader, companyId: string, today: BusinessDate): Promise<string | null> {
  const codes = await db.numberSeries.findMany({ where: { companyId, kind: 'SALES_ORDER', status: 'ACTIVE' }, select: { code: true }, distinct: ['code'] })
  if (codes.length !== 1) return null
  const newest = await db.numberSeries.findFirst({ where: { companyId, kind: 'SALES_ORDER', code: codes[0]!.code }, orderBy: { scopeKey: 'desc' }, select: { reset: true, scopeKey: true, pattern: true, nextValue: true, status: true } })
  if (!newest || newest.status !== 'ACTIVE') return null
  const scopeKey = scopeKeyFor(newest.reset, today)
  const value = newest.reset === 'YEARLY' && scopeKey > newest.scopeKey ? 1 : newest.nextValue
  return isNumberValue(value) ? formatNumber(newest.pattern, { value, year: yearOfScope(scopeKey) }) : null
}

/** orders.manage: the number a new order of the company will get ("The number it will get"); null without a series. */
export async function nextOrderNumber(caller: CommandCaller, companyId: string): Promise<{ number: string | null }> {
  const context = officeContextOf(caller)
  if (!can(actorOf(context), ORDERS_MANAGE, { companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => ({ number: await nextNumberOf(client, companyId, businessDate(serverClock.now())) }))
}

const linesView = (priced: PricedLines) =>
  priced.lines.map((line) => ({
    seq: line.seq,
    styleId: line.styleId,
    colourwayId: line.colourwayId,
    styleRevisionId: line.styleRevisionId,
    description: line.description,
    quantity: line.quantity,
    sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: asMoney('price', size.unitPrice) })),
    unitPrice: asMoney('price', line.unitPrice),
    netAmount: asMoney('price', line.netAmount),
    vatAmount: asMoney('price', line.vatAmount),
    vatRatePct: line.vatRatePct,
    vatNature: line.vatNature,
    costAmount: asMoney('cost', line.costAmount),
  }))

/**
 * orders.manage: the order as "Confirm order" would make it, priced (lines, VAT, totals, deposit, payment schedule, the
 * number it will get), with the problems in words. Nothing is written.
 */
export async function previewManualOrder(caller: CommandCaller, body: ManualOrderBody) {
  const context = officeContextOf(caller)
  assertMay(context, ORDERS_MANAGE, { companyId: body.companyId, partyId: body.partyId }, 'Customer')
  const picked = body.paymentTermsId ? await termsForParty(caller, body.paymentTermsId, body.companyId, 'body/paymentTermsId') : null
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const number = await nextNumberOf(client, body.companyId, businessDate(now))
    const plan = await planManualOrder(client, body, now, picked)
    const problems = isIssueList(plan) ? [...plan] : []
    if (number === null) problems.push({ path: 'body/companyId', message: 'The company has no active SALES_ORDER number series: an administrator adds one under Numbering.' })
    if (isIssueList(plan)) return { ok: false, number, problems, order: null }
    const schedule = paymentScheduleOf({ gross: plan.priced.grossAmount, instalments: plan.instalments, deposit: plan.depositAmount ? { requestId: 'pending', amount: plan.depositAmount, dueDate: businessDate(now), sharePct: plan.depositPct } : null, promiseDate: plan.promiseDate })
    return {
      ok: problems.length === 0,
      number,
      problems,
      order: {
        currency: plan.currency,
        taxMode: plan.taxMode,
        priceBasis: priceBasisOf(plan.taxMode),
        language: plan.language,
        contactId: plan.contactId,
        paymentTermsId: plan.paymentTermsId,
        paymentTerms: plan.paymentTerms,
        depositPct: plan.depositPct,
        depositAmount: asMoney('price', plan.depositAmount),
        netAmount: asMoney('price', plan.priced.netAmount),
        vatAmount: asMoney('price', plan.priced.vatAmount),
        grossAmount: asMoney('price', plan.priced.grossAmount),
        costAmount: asMoney('cost', plan.priced.costAmount),
        lines: linesView(plan.priced),
        schedule: schedule.map((step) => ({ seq: step.seq, kind: step.kind, sharePct: step.sharePct, amount: asMoney('price', step.amount), dueDate: step.kind === 'DEPOSIT' ? null : step.dueDate })),
      },
    }
  })
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The order cannot be made like this.', issues)

/** orders.manage: "Confirm order" — the order typed by the office, made in ONE command (see the module's head). */
export async function createManualOrder(caller: CommandCaller, body: ManualOrderBody, idempotencyKey?: string): Promise<{ order: OrderView }> {
  const context = officeContextOf(caller)
  assertMay(context, ORDERS_MANAGE, { companyId: body.companyId, partyId: body.partyId }, 'Customer')
  const picked = body.paymentTermsId ? await termsForParty(caller, body.paymentTermsId, body.companyId, 'body/paymentTermsId') : null
  const { result } = await command(caller, { name: 'orders.makeManual', idempotencyKey, input: body }, (tools) => makeManualOrderInCommand(tools, body, picked))
  return { order: await recordAfter(caller, result.orderId) }
}

/**
 * The manual order's work INSIDE a command (the route's, or another flow's: B-W2a-43's replacement order of a customer
 * return): the plan (refused in words), the SALES_ORDER number, the CONFIRMED order and its lines, the deposit request
 * when one is asked, the payment schedule, the audit row and sales_order.created. The caller checked orders.manage.
 */
export async function makeManualOrderInCommand(tools: CommandTools, body: ManualOrderBody, picked: { id: string } | null): Promise<{ orderId: string; number: string }> {
  const { tx, now } = tools
  const today = businessDate(now)
  if (!(await hasOrderSeries(tx, body.companyId))) throw new ConflictError('The company has no active SALES_ORDER number series: an administrator adds one under Numbering, then the order can be made.')
  const plan = await planManualOrder(tx, body, now, picked)
  if (isIssueList(plan)) throw invalid(plan)
  const id = newId()
  const number = await allocateNumber(tools, { companyId: body.companyId, kind: 'SALES_ORDER' }, { type: 'SalesOrder', id, date: today })
  const actorId = actorIdOf(tools)
  const stamp = { createdAt: now, updatedAt: now, createdById: actorId }
  const depositAsked = plan.depositAmount !== null && plan.depositAmount > 0
  await tx.salesOrder.create({
    data: {
      id,
      companyId: body.companyId,
      partyId: plan.party.row.id,
      number: number.formatted,
      quoteVersionId: null,
      customerRef: plan.customerRef,
      status: 'CONFIRMED',
      orderDate: asDay(today),
      currency: plan.currency,
      language: plan.language,
      taxMode: plan.taxMode,
      billTo: plan.billTo as Prisma.InputJsonValue,
      shipTo: plan.shipTo as Prisma.InputJsonValue,
      paymentTerms: plan.paymentTerms,
      paymentTermsId: plan.paymentTermsId,
      requestedDate: plan.requestedDate === null ? null : asDay(plan.requestedDate),
      promiseDate: plan.promiseDate === null ? null : asDay(plan.promiseDate),
      originalPromiseDate: plan.promiseDate === null ? null : asDay(plan.promiseDate),
      priority: 0,
      noWithdrawal: false,
      depositRequired: depositAsked,
      netAmount: plan.priced.netAmount,
      vatAmount: plan.priced.vatAmount,
      grossAmount: plan.priced.grossAmount,
      costAmount: plan.priced.costAmount,
      internalNote: plan.internalNote,
      ...stamp,
    },
    select: { id: true },
  })
  for (const line of plan.priced.lines) {
    const lineId = newId()
    await tx.salesOrderLine.create({
      data: {
        id: lineId,
        companyId: body.companyId,
        orderId: id,
        partyId: plan.party.row.id,
        seq: line.seq,
        kind: 'SIZE_GRID',
        styleId: line.styleId,
        styleRevisionId: line.styleRevisionId,
        colourwayId: line.colourwayId,
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        netAmount: line.netAmount,
        vatRatePct: line.vatRatePct,
        vatNature: line.vatNature,
        vatAmount: line.vatAmount,
        unitCost: line.unitCost,
        costAmount: line.costAmount,
        ...stamp,
      },
      select: { id: true },
    })
    await tx.salesOrderLineSize.createMany({ data: line.sizes.map((size) => ({ id: newId(), lineId, partyId: plan.party.row.id, size: size.size, quantity: size.quantity, unitPrice: size.unitPrice, ...stamp })) })
  }
  // The deposit (B-W1-24's rules: its legal kind and fiscal decision), named on the order: no quote version.
  let deposit: { id: string; amount: number; dueDate: Date; depositPct: Prisma.Decimal | null } | null = null
  let depositFiscal: 'TD02' | 'NONE' | null = null
  if (depositAsked) {
    const draft = depositRequestFor({ depositPct: plan.depositPct, depositKind: plan.depositKind, depositAmount: plan.depositAmount, currency: plan.currency }, today, plan.party.profile, depositDueDaysOf(plan.instalments, DEPOSIT_DUE_DAYS))
    if (draft) {
      const requestId = newId()
      deposit = await tx.depositRequest.create({
        data: {
          id: requestId,
          companyId: body.companyId,
          partyId: plan.party.row.id,
          orderId: id,
          kind: draft.kind,
          depositPct: draft.depositPct,
          currency: draft.currency,
          amount: draft.amount,
          dueDate: asDay(draft.dueDate),
          fiscalDocument: draft.fiscalDocument,
          fiscalRule: draft.fiscalRule,
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        },
        select: { id: true, amount: true, dueDate: true, depositPct: true },
      })
      depositFiscal = draft.fiscalDocument
      tools.audit({
        action: 'sales.deposits.request',
        recordType: 'DepositRequest',
        recordId: requestId,
        companyId: body.companyId,
        after: { orderId: id, kind: draft.kind, depositPct: draft.depositPct, currency: draft.currency, amount: markMoney('price', draft.amount), dueDate: draft.dueDate, fiscalDocument: draft.fiscalDocument, fiscalRule: draft.fiscalRule, reason: draft.reason, status: 'OPEN' },
      })
    }
  }
  const steps = await makeScheduleInCommand(tools, { id, number: number.formatted, companyId: body.companyId, partyId: plan.party.row.id, currency: plan.currency, grossAmount: plan.priced.grossAmount, promiseDate: plan.promiseDate === null ? null : asDay(plan.promiseDate), paymentTermsId: plan.paymentTermsId }, deposit)
  tools.audit({
    action: 'orders.makeManual',
    recordType: 'SalesOrder',
    recordId: id,
    companyId: body.companyId,
    after: {
      number: number.formatted,
      partyId: plan.party.row.id,
      status: 'CONFIRMED',
      quoteVersionId: null,
      taxMode: plan.taxMode,
      currency: plan.currency,
      paymentTermsId: plan.paymentTermsId,
      promiseDate: plan.promiseDate,
      depositRequired: depositAsked,
      depositRequestId: deposit?.id ?? null,
      milestoneIds: steps,
      lines: plan.priced.lines.length,
      pieces: plan.priced.lines.reduce((sum, line) => sum + line.quantity, 0),
      netAmount: markMoney('price', plan.priced.netAmount),
      grossAmount: markMoney('price', plan.priced.grossAmount),
      costAmount: markMoney('cost', plan.priced.costAmount),
    },
  })
  tools.emit({ type: 'sales_order.created', subject: id, companyId: body.companyId, payload: { orderId: id, number: number.formatted, quoteId: null, versionId: null, partyId: plan.party.row.id, depositRequestIds: deposit ? [deposit.id] : [] } })
  // B-W2b-16: the typed order's deposit gets its own event (the quote's deposit_request.created needs a quote version).
  if (deposit) {
    tools.emit({
      type: 'deposit_request.created_for_order',
      subject: deposit.id,
      companyId: body.companyId,
      payload: { depositRequestId: deposit.id, orderId: id, number: number.formatted, partyId: plan.party.row.id, stepKind: 'DEPOSIT', fiscalDocument: depositFiscal!, dueDate: dayOf(deposit.dueDate) },
    })
  }
  return { orderId: id, number: number.formatted }
}

