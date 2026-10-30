import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { addDays, piecesOf, priceBasisOf, priceText, versionTaxModeOf, type DepositKind, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { quoteDefaultsOf } from '@nexus/factory-domain/sales/terms/terms'
import type { PriceBasis } from '@nexus/factory-domain/tax/vat-summary'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { usableTerms } from '../terms/store'
import { defaultLineDescription, lineTarget } from './lines'
import { chainForQuote, listPriceOf } from './list-price'
import { decideTreatment, refreshVersion } from './pricing'
import { assertQuotable, detailInCommand } from './quotes'
import { quoteRulesFor } from './rules'
import { assertMay, decimal, dayValue, grainsOf, officeContextOf, officeQuote, quotePartyOf, readCurrentVersion, readQuote, type Reader } from './store'
import { forCaller, type QuoteDetail } from './views'

/**
 * Duplicate a quote (B-W2a-30; SAL-155 "copying quotes speeds daily work"; the design's row verb "Duplicate", the cancel
 * dialog's "Duplicate it to start again", New quote "Start from: Past quote") and copy an order as a new quote (the
 * order's "Copy as new quote", the reversal its cancel names): a NEW quote — its own number from the company's QUOTE
 * series, a first DRAFT version from today — for the same customer or another one of the company, with the source's
 * lines copied. Never the source's sends, links, approvals or acceptance: the copy starts again.
 *
 *   lines     each size-grid line again: the style and colourway (archived ones are left out and named), the sizes the
 *             colourway still offers (the others named), the unit price as sold — a line sold at its list price takes the
 *             customer's list price now, a discounted or hand-priced one keeps its price — and costed again from today's
 *             sheets; made-to-measure lines are left out (they come later, Q9)
 *   terms     the same customer: the source's terms, deposit, addresses, contact and language (when still active);
 *             another customer: its own defaults (B-W2a-19 quoteDefaultsOf), as a new quote
 *   the rest  a new validity from today, the promise date only when still ahead, no firm offer
 */

export interface DuplicateBody {
  /** The version to copy (a quote's): its current one when none. */
  readonly versionId?: string | undefined
  /** Another customer of the company; none: the same. */
  readonly partyId?: string | undefined
  readonly contactId?: string | null | undefined
  readonly customerRef?: string | null | undefined
}

/** What the copy left out, and why (in words). */
export interface Dropped {
  readonly seq: number
  readonly size: string | null
  readonly reason: string
}

interface SourceLine {
  readonly seq: number
  readonly kind: 'SIZE_GRID' | 'MADE_TO_MEASURE'
  readonly styleId: string
  readonly colourwayId: string
  readonly description: string | null
  readonly note: string | null
  readonly unitPrice: string
  readonly listUnitPrice: string | null
  readonly sizes: readonly SizeRow[]
}

interface Source {
  readonly from: { readonly quoteId: string; readonly versionId: string } | { readonly orderId: string }
  readonly companyId: string
  readonly partyId: string
  readonly basis: PriceBasis
  readonly contactId: string | null
  readonly language: string
  readonly billToAddressId: string | null
  readonly shipToAddressId: string | null
  readonly promiseDate: BusinessDate | null
  readonly paymentTermsId: string | null
  readonly paymentTerms: string | null
  readonly termsText: string | null
  readonly termsVersion: string | null
  readonly depositPct: string | null
  readonly depositKind: DepositKind | null
  readonly lines: readonly SourceLine[]
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

async function activeContact(db: Reader, partyId: string, contactId: string | null): Promise<string | null> {
  if (contactId === null) return null
  const row = await db.partyContact.findUnique({ where: { id: contactId }, select: { partyId: true, status: true } })
  return row && row.partyId === partyId && row.status === 'ACTIVE' ? contactId : null
}

async function activeAddress(db: Reader, partyId: string, addressId: string | null): Promise<string | null> {
  if (addressId === null) return null
  const row = await db.partyAddress.findUnique({ where: { id: addressId }, select: { partyId: true, status: true } })
  return row && row.partyId === partyId && row.status === 'ACTIVE' ? addressId : null
}

/** Inside the copy's command: the new quote with its first DRAFT version and the source's lines. */
async function duplicateInto(tools: CommandTools, source: Source, body: DuplicateBody): Promise<{ quoteId: string; dropped: Dropped[]; warnings: string[] }> {
  const { tx, now } = tools
  const today = businessDate(now)
  const targetPartyId = body.partyId ?? source.partyId
  const same = targetPartyId === source.partyId
  const company = await tx.company.findUnique({ where: { id: source.companyId }, select: { id: true, currency: true } })
  if (!company) throw new NotFoundError('Company not found.')
  const party = await quotePartyOf(tx, targetPartyId, today, now)
  if (!party || (party.row.companyId !== null && party.row.companyId !== company.id)) throw new NotFoundError('Customer not found.')
  assertQuotable(party)
  decideTreatment(party)
  const taxMode = versionTaxModeOf(party.identity!.taxMode, party.viesValid)
  const rules = await quoteRulesFor(tx, company.id)

  const defaultContact = async () => (await tx.partyContact.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id ?? null
  const defaultAddress = async (flag: 'isDefaultBillTo' | 'isDefaultShipTo') => (await tx.partyAddress.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', [flag]: true }, select: { id: true } }))?.id ?? null
  let contactId: string | null
  if (body.contactId !== undefined) {
    contactId = body.contactId
    if (contactId !== null && (await activeContact(tx, party.row.id, contactId)) === null) throw new ValidationError('Not an active contact of this customer.', [{ path: 'body/contactId', message: 'Not an active contact of this customer.' }])
  } else contactId = (same ? await activeContact(tx, party.row.id, source.contactId) : null) ?? (await defaultContact())
  const billToAddressId = (same ? await activeAddress(tx, party.row.id, source.billToAddressId) : null) ?? (await defaultAddress('isDefaultBillTo'))
  const shipToAddressId = (same ? await activeAddress(tx, party.row.id, source.shipToAddressId) : null) ?? (await defaultAddress('isDefaultShipTo'))
  const contact = contactId ? await tx.partyContact.findUnique({ where: { id: contactId }, select: { language: true } }) : null
  const language = same ? (source.language === 'it' ? 'it' : 'en') : (contact?.language ?? party.row.language) === 'it' ? 'it' : 'en'
  const keptTerms = same ? await usableTerms(tx, source.paymentTermsId, company.id) : null
  const terms = keptTerms ?? (await usableTerms(tx, party.row.paymentTermsId, company.id))
  const defaults = quoteDefaultsOf({ partyDepositPct: party.row.defaultDepositPct === null ? null : party.row.defaultDepositPct.toString(), terms, partyTermsText: party.row.paymentTerms, settingsDepositPct: rules.defaultDepositPct, language })
  const useSource = same && (keptTerms !== null || source.paymentTermsId === null)
  const depositPct = useSource && source.depositPct !== null ? source.depositPct : defaults.depositPct

  const id = newId()
  const issued = await allocateNumber(tools, { companyId: company.id, kind: 'QUOTE' }, { type: 'Quote', id })
  const actorId = actorIdOf(tools)
  await tx.quote.create({ data: { id, companyId: company.id, number: issued.formatted, partyId: party.row.id, contactId, customerRef: blankToNull(body.customerRef), createdById: actorId }, select: { id: true } })
  const versionId = newId()
  await tx.quoteVersion.create({
    data: {
      id: versionId,
      quoteId: id,
      partyId: party.row.id,
      revision: 1,
      currency: company.currency,
      language,
      taxMode,
      taxIdentityId: party.identityId,
      billToAddressId,
      shipToAddressId,
      validUntil: dayValue(addDays(today, rules.defaultValidityDays)),
      firmOffer: false,
      promiseDate: source.promiseDate !== null && source.promiseDate >= today ? dayValue(source.promiseDate) : null,
      paymentTerms: useSource ? source.paymentTerms : defaults.paymentTerms,
      paymentTermsId: useSource ? source.paymentTermsId : defaults.paymentTermsId,
      termsText: same ? source.termsText : null,
      termsVersion: same ? source.termsVersion : null,
      depositPct,
      depositKind: depositPct === null ? null : (useSource ? source.depositKind : null) ?? 'ACCONTO',
      marginFloorPct: rules.marginFloorPct,
      createdById: actorId,
    },
    select: { id: true },
  })
  const quote = (await readQuote(tx, id))!
  const chain = await chainForQuote(tx, quote, { currency: company.currency, priceListVersionId: null }, party, now, [...new Set(source.lines.map((line) => line.styleId))])
  if (chain.keptVersionId !== null) await tx.quoteVersion.update({ where: { id: versionId }, data: { priceListVersionId: chain.keptVersionId }, select: { id: true } })

  const dropped: Dropped[] = []
  const warnings: string[] = []
  if (source.basis !== priceBasisOf(taxMode)) warnings.push(`The source was priced ${source.basis === 'NET' ? 'without VAT' : 'with VAT included'}; this customer buys ${priceBasisOf(taxMode) === 'NET' ? 'without VAT' : 'with VAT included'}: check the prices kept as typed.`)
  let seq = 0
  for (const line of [...source.lines].sort((a, b) => a.seq - b.seq)) {
    if (line.kind === 'MADE_TO_MEASURE') {
      dropped.push({ seq: line.seq, size: null, reason: 'Made-to-measure comes later: the unit is not copied.' })
      continue
    }
    let target: Awaited<ReturnType<typeof lineTarget>>
    try {
      target = await lineTarget(tx, company.id, { styleId: line.styleId, colourwayId: line.colourwayId, styleRevisionId: undefined }, null, 'body')
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
      dropped.push({ seq: line.seq, size: null, reason: error.message })
      continue
    }
    const sizes = line.sizes.filter((size) => {
      if (target.grid.range.includes(size.size) && target.grid.offered.has(size.size)) return true
      dropped.push({ seq: line.seq, size: size.size, reason: `Size ${size.size} is no longer offered in this colourway.` })
      return false
    })
    if (sizes.length === 0) {
      dropped.push({ seq: line.seq, size: null, reason: 'None of its sizes is offered any more: the line is not copied.' })
      continue
    }
    const listed = listPriceOf(chain, taxMode, party, target.style.id, target.colourway.id)
    const atList = line.listUnitPrice !== null && priceText(line.listUnitPrice) === priceText(line.unitPrice)
    const unitPrice = atList && listed ? listed.onBasis : line.unitPrice
    const listUnitPrice = listed?.onBasis ?? line.listUnitPrice
    seq += 10
    const lineId = newId()
    await tx.quoteLine.create({
      data: {
        id: lineId,
        versionId,
        partyId: party.row.id,
        seq,
        kind: 'SIZE_GRID',
        styleId: target.style.id,
        styleRevisionId: target.revisionId,
        colourwayId: target.colourway.id,
        description: line.description ?? defaultLineDescription(target.style, target.colourway),
        note: line.note,
        quantity: piecesOf(sizes),
        listUnitPrice: listUnitPrice === null ? null : priceText(listUnitPrice),
        unitPrice: priceText(unitPrice),
        netAmount: 0,
        vatRatePct: '0',
        vatAmount: 0,
        createdById: actorId,
      },
      select: { id: true },
    })
    await tx.quoteLineSize.createMany({ data: sizes.map((size) => ({ id: newId(), lineId, partyId: party.row.id, size: size.size, quantity: size.quantity, unitPrice: size.unitPrice, createdById: actorId })) })
  }
  if (seq === 0) throw new ValidationError('Nothing could be copied: every line was left out.', dropped.map((entry) => ({ path: 'body', message: `Line ${entry.seq}${entry.size ? ` size ${entry.size}` : ''}: ${entry.reason}` })))
  await refreshVersion(tools, quote, await readCurrentVersion(tx, quote), 'all')
  tools.audit({
    action: 'quotes.duplicate',
    recordType: 'Quote',
    recordId: id,
    companyId: company.id,
    after: { number: issued.formatted, partyId: party.row.id, status: 'DRAFT', revision: 1, from: source.from, sameCustomer: same, lines: seq / 10, dropped, contactId, billToAddressId, shipToAddressId, depositPct, paymentTermsId: useSource ? source.paymentTermsId : defaults.paymentTermsId, listVersionId: chain.keptVersionId },
  })
  tools.emit({ type: 'quote.created', subject: id, companyId: company.id, payload: { quoteId: id, versionId, number: issued.formatted, partyId: party.row.id } })
  return { quoteId: id, dropped, warnings }
}

/** quotes.view on the source, quotes.manage over its company and the customer the copy is for. */
export async function duplicateQuote(caller: CommandCaller, quoteId: string, body: DuplicateBody, idempotencyKey?: string): Promise<{ quote: QuoteDetail; dropped: Dropped[]; warnings: string[] }> {
  const context = officeContextOf(caller)
  const quote = await officeQuote(caller, quoteId)
  assertMay(context, QUOTES_MANAGE, { companyId: quote.companyId, partyId: body.partyId ?? quote.partyId }, 'Customer')
  const { result } = await command(caller, { name: 'quotes.duplicate', idempotencyKey, input: { quoteId, ...body } }, async (tools) => {
    const { tx } = tools
    const current = (await readQuote(tx, quote.id))!
    const version = body.versionId ? await tx.quoteVersion.findUnique({ where: { id: body.versionId }, select: { id: true, quoteId: true } }) : await readCurrentVersion(tx, current)
    if (!version || version.quoteId !== quote.id) throw new ValidationError('Not a version of this quote.', [{ path: 'body/versionId', message: 'Not a version of this quote.' }])
    const row = await tx.quoteVersion.findUniqueOrThrow({
      where: { id: version.id },
      select: { id: true, taxMode: true, language: true, billToAddressId: true, shipToAddressId: true, promiseDate: true, paymentTermsId: true, paymentTerms: true, termsText: true, termsVersion: true, depositPct: true, depositKind: true },
    })
    const lines = await tx.quoteLine.findMany({ where: { versionId: row.id }, select: { id: true, seq: true, kind: true, styleId: true, colourwayId: true, description: true, note: true, unitPrice: true, listUnitPrice: true }, orderBy: { seq: 'asc' } })
    const sizes = lines.length > 0 ? await tx.quoteLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true } }) : []
    const made = await duplicateInto(
      tools,
      {
        from: { quoteId: quote.id, versionId: row.id },
        companyId: current.companyId,
        partyId: current.partyId,
        basis: priceBasisOf(row.taxMode),
        contactId: current.contactId,
        language: row.language,
        billToAddressId: row.billToAddressId,
        shipToAddressId: row.shipToAddressId,
        promiseDate: row.promiseDate === null ? null : row.promiseDate.toISOString().slice(0, 10),
        paymentTermsId: row.paymentTermsId,
        paymentTerms: row.paymentTerms,
        termsText: row.termsText,
        termsVersion: row.termsVersion,
        depositPct: decimal(row.depositPct),
        depositKind: row.depositKind,
        lines: lines.map((line) => ({
          seq: line.seq,
          kind: line.kind,
          styleId: line.styleId,
          colourwayId: line.colourwayId,
          description: line.description,
          note: line.note,
          unitPrice: decimal(line.unitPrice)!,
          listUnitPrice: decimal(line.listUnitPrice),
          sizes: sizes.filter((size) => size.lineId === line.id).map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: decimal(size.unitPrice) })),
        })),
      },
      body,
    )
    return { ...(await detailInCommand(tools, made.quoteId)), dropped: made.dropped, warnings: made.warnings }
  })
  return forCaller(result, grainsOf(context))
}

/**
 * The order's lines as a new quote (orders.view on the order; quotes.manage over its company and the customer the copy
 * is for): the order's unit prices as sold, today's list prices beside them. Any state, a cancelled order included (its
 * cancel dialog's way back).
 */
export async function copyOrderAsQuote(caller: CommandCaller, order: { readonly id: string; readonly companyId: string; readonly partyId: string }, body: Omit<DuplicateBody, 'versionId'>, idempotencyKey?: string): Promise<{ quote: QuoteDetail; dropped: Dropped[]; warnings: string[] }> {
  const context = officeContextOf(caller)
  assertMay(context, QUOTES_MANAGE, { companyId: order.companyId, partyId: body.partyId ?? order.partyId }, 'Customer')
  const { result } = await command(caller, { name: 'quotes.copyOrder', idempotencyKey, input: { orderId: order.id, ...body } }, async (tools) => {
    const { tx } = tools
    const row = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, companyId: true, partyId: true, taxMode: true, language: true, promiseDate: true, paymentTermsId: true, paymentTerms: true, quoteVersionId: true } })
    const version = row.quoteVersionId ? await tx.quoteVersion.findUnique({ where: { id: row.quoteVersionId }, select: { billToAddressId: true, shipToAddressId: true, termsText: true, termsVersion: true, quoteId: true } }) : null
    const sourceQuote = version ? await tx.quote.findUnique({ where: { id: version.quoteId }, select: { contactId: true } }) : null
    const lines = await tx.salesOrderLine.findMany({ where: { orderId: row.id }, select: { id: true, seq: true, kind: true, styleId: true, colourwayId: true, description: true, note: true, unitPrice: true }, orderBy: { seq: 'asc' } })
    const sizes = lines.length > 0 ? await tx.salesOrderLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true } }) : []
    const made = await duplicateInto(
      tools,
      {
        from: { orderId: row.id },
        companyId: row.companyId,
        partyId: row.partyId,
        basis: priceBasisOf(row.taxMode),
        contactId: sourceQuote?.contactId ?? null,
        language: row.language,
        billToAddressId: version?.billToAddressId ?? null,
        shipToAddressId: version?.shipToAddressId ?? null,
        promiseDate: null,
        paymentTermsId: row.paymentTermsId,
        paymentTerms: row.paymentTerms,
        termsText: version?.termsText ?? null,
        termsVersion: version?.termsVersion ?? null,
        depositPct: null,
        depositKind: null,
        lines: lines.map((line) => ({
          seq: line.seq,
          kind: line.kind,
          styleId: line.styleId,
          colourwayId: line.colourwayId,
          description: line.description,
          note: line.note,
          unitPrice: decimal(line.unitPrice)!,
          listUnitPrice: null,
          sizes: sizes.filter((size) => size.lineId === line.id).map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: decimal(size.unitPrice) })),
        })),
      },
      body,
    )
    return { ...(await detailInCommand(tools, made.quoteId)), dropped: made.dropped, warnings: made.warnings }
  })
  return forCaller(result, grainsOf(context))
}
