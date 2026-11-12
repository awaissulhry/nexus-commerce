import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { QuoteBody, SourceQuery } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_MANAGE, SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { quotableLines, quoteRefusal, sizesOf, type InquirySource, type InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceBasisOf, versionTaxModeOf } from '@nexus/factory-domain/sales/quotes/quotes'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { duplicateInto } from '../quotes/duplicate'
import { quotePartyOf } from '../quotes/store'
import { emitClosed, lockForChange, viewInCommand, writeInquiry } from './inquiries'
import { databaseRefusal, dayOrNull, factsOf, INQUIRY_COLUMNS, LINE_COLUMNS, may, officeInquiry, officeOf, refuse } from './store'
import { price, techPackOf } from './views'

/**
 * The quote an inquiry becomes, and the inquiry a quote or an order came from (B-W2b-295; SAL-032 "make a quote from it, and
 * the inquiry shows its quote"; SAL-305 the brand's tech pack carried to the quote and the order; design sales.inquiries
 * inquiries.detail "Make quote (pre-filled: customer, contact, styles, sizes, target date)").
 *
 *   POST /sales/inquiries/:inquiryId/quote   sales.inquiries.manage and quotes.manage over the company and the customer: in
 *                                            ONE command, W1's new quote (its number from the company's QUOTE series, a first
 *                                            DRAFT version with the customer's defaults) with the inquiry's lines that name a
 *                                            style, a colourway and pieces by size (at the customer's list price when it has
 *                                            one, else 0 until the office prices them; the others left out and said), the
 *                                            wanted date as the promise date while it is ahead, and the inquiry QUOTED with it
 *   GET  /sales/inquiries/source             the inquiry a quote (quotes.view) or an order (orders.view) came from, with the
 *                                            tech pack in force: each named file as the newest version of its series
 *
 * A prospect is matched to a customer first (a quote is made for a party). One inquiry per quote, one quote per inquiry.
 */

/** POST /sales/inquiries/:inquiryId/quote: "Make quote" (Q). */
export async function quoteInquiry(caller: CommandCaller, inquiryId: string, body: QuoteBody, idempotencyKey?: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  refuse(quoteRefusal(factsOf(inquiry)))
  if (!can(actorOf(context), QUOTES_MANAGE, { companyId: inquiry.companyId, partyId: inquiry.partyId! })) throw new ForbiddenError('Making the quote needs quotes.manage for this company and customer.')
  const { result } = await command(caller, { name: 'sales.inquiries.quote', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, inquiryId, body.version)
    refuse(quoteRefusal(factsOf(row)))
    const partyId = row.partyId!
    const lines = await tx.inquiryLine.findMany({ where: { inquiryId: row.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const { copy, leftOut } = quotableLines(lines.map((line) => ({ seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, description: line.description, note: line.note, sizes: sizesOf(line.sizes) })))
    const party = await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { language: true, paymentTermsId: true, paymentTerms: true, defaultDepositPct: true } })
    const taxed = await quotePartyOf(tx, partyId, businessDate(now), now)
    const wanted = dayOrNull(row.wantedDate)
    const made = await duplicateInto(
      tools,
      {
        from: { inquiryId: row.id },
        emptyAllowed: true,
        action: 'quotes.fromInquiry',
        companyId: row.companyId,
        partyId,
        basis: taxed?.identity ? priceBasisOf(versionTaxModeOf(taxed.identity.taxMode, taxed.viesValid)) : 'NET',
        contactId: row.contactId,
        language: party.language,
        billToAddressId: null,
        shipToAddressId: null,
        promiseDate: wanted,
        paymentTermsId: party.paymentTermsId,
        paymentTerms: party.paymentTerms,
        termsText: null,
        termsVersion: null,
        depositPct: party.defaultDepositPct === null ? null : party.defaultDepositPct.toString(),
        depositKind: null,
        // A line is offered at the customer's list price when it has one (the copy's rule for a line at its list price);
        // without one, at 0 until the office prices it on the quote. The target price stays the inquiry's.
        lines: copy.map((line) => ({
          seq: line.seq,
          kind: 'SIZE_GRID' as const,
          styleId: line.styleId!,
          colourwayId: line.colourwayId!,
          // The customer's words stay on the inquiry; the quote's line takes its style and colourway's description.
          description: null,
          note: null,
          unitPrice: '0',
          listUnitPrice: '0',
          sizes: Object.entries(line.sizes).map(([size, quantity]) => ({ size, quantity, unitPrice: null })),
        })),
      },
      { ...(body.customerRef ? { customerRef: body.customerRef } : {}) },
    )
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: made.quoteId }, select: { id: true, number: true } })
    await writeInquiry(tools, row, { status: 'QUOTED', quoteId: quote.id, closedAt: now, closedById: context.actorId })
    tools.audit({ action: 'sales.inquiries.quote', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'QUOTED', quoteId: quote.id, quoteNumber: quote.number, closedAt: toUtcIso(now), leftOut: [...leftOut, ...made.dropped] } })
    emitClosed(tools, row, 'QUOTED', quote.id, null)
    return { inquiry: await viewInCommand(tools, row.id), quote, leftOut: [...leftOut, ...made.dropped], warnings: made.warnings }
  }).catch(databaseRefusal)
  return result
}

/** GET /sales/inquiries/source?quoteId=|salesOrderId=: the inquiry it came from, with the tech pack in force (null: none). */
export async function inquirySource(caller: CommandCaller, query: SourceQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if ((query.quoteId === undefined) === (query.salesOrderId === undefined)) throw new ValidationError('Name the quote or the order (one of the two).', [{ path: 'query', message: 'quoteId or salesOrderId, one of the two.' }])
  return caller.withClient(async (db) => {
    let quoteId: string | null = null
    if (query.quoteId) {
      const quote = isUuid(query.quoteId) ? await db.quote.findUnique({ where: { id: query.quoteId }, select: { id: true, companyId: true, partyId: true } }) : null
      if (!quote || !can(actor, QUOTES_VIEW, { companyId: quote.companyId, partyId: quote.partyId })) throw new NotFoundError('Quote not found.')
      quoteId = quote.id
    } else {
      const order = isUuid(query.salesOrderId!) ? await db.salesOrder.findUnique({ where: { id: query.salesOrderId! }, select: { id: true, companyId: true, partyId: true, quoteVersionId: true } }) : null
      if (!order || !can(actor, ORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Order not found.')
      const version = order.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { quoteId: true } }) : null
      quoteId = version?.quoteId ?? null
    }
    const row = quoteId ? await db.inquiry.findFirst({ where: { quoteId }, select: INQUIRY_COLUMNS }) : null
    if (!row || !may(context, SALES_INQUIRIES_VIEW, row)) return { inquiry: null }
    return {
      inquiry: {
        id: row.id,
        number: row.number,
        status: row.status as InquiryStatus,
        source: row.source as InquirySource,
        receivedAt: toUtcIso(row.receivedAt),
        wantedDate: dayOrNull(row.wantedDate),
        targetUnitPrice: asMoney('price', price(row.targetUnitPrice)),
        currency: row.currency,
        techPack: await techPackOf(db, row),
      },
    }
  })
}
