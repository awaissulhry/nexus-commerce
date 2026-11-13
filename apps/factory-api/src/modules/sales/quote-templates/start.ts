import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { StartQuoteBody } from '@nexus/factory-domain/sales/quote-templates/contracts'
import { planStart, templateServes, type LeftOut, type TemplateLineInput } from '@nexus/factory-domain/sales/quote-templates/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { addDays, isIssueList, piecesOf, priceBasisOf, priceText, sizeGrid, versionTaxModeOf, type DepositKind, type SalesFeeKind, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { quoteDefaultsOf } from '@nexus/factory-domain/sales/terms/terms'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { withCompanyTerms } from '../../parties/company-terms/in-force'
import { refuseLineRules } from '../line-checks/refuse'
import { defaultLineDescription, lineTarget } from '../quotes/lines'
import { chainForQuote, listPriceOf } from '../quotes/list-price'
import { decideTreatment, refreshVersion } from '../quotes/pricing'
import { assertQuotable, detailInCommand } from '../quotes/quotes'
import { quoteRulesFor } from '../quotes/rules'
import { assertMay, dayValue, grainsOf, quotePartyOf, readCurrentVersion, readQuote } from '../quotes/store'
import { forCaller, type QuoteDetail } from '../quotes/views'
import { usableTerms } from '../terms/store'
import { officeTemplate, readTemplate, sizesOf, TEMPLATE_LINE_COLUMNS } from './store'

/**
 * A quote started from a template (B-W2b-294; SAL-144 "Templates speed daily quoting"; design sales.quotes quotes.new "Start
 * from: … Template (W2b)"): POST /sales/quote-templates/:templateId/quote — quotes.manage over the company and the customer
 * (as W1's new quote), the template ACTIVE and serving the company (its own or every company's: SAL-252). ONE command:
 *
 *   the quote      W1's new quote (its number from the company's QUOTE series), naming the template (Quote.templateId, in the
 *                  insert: the database never takes it later), with the customer's contact and addresses as W1 picks them
 *   the version    the template's terms: its language, validity days (else the sales settings'), firm offer, acceptance mode,
 *                  deposit (else the customer's, its terms', the settings'), payment terms (else the customer's with this
 *                  company), T&C and their version, Incoterm and place, ship complete; the VAT from the customer as W1
 *   the lines      each template line in its section, as W1's add-line would write it: the colourway and pieces the template
 *                  names or the person picks, the sizes the colourway offers, the template's price (net quotes) or the
 *                  customer's list price, costed from today's sheets. Left out in words: a line without a colourway or pieces,
 *                  a size no longer offered, an archived style, a fee line (fees come with the waterfall), and a line the
 *                  customer and product rules refuse (another customer's private-label style, a cell not released)
 */

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export async function startFromTemplate(caller: CommandCaller, templateId: string, body: StartQuoteBody, idempotencyKey?: string): Promise<{ quote: QuoteDetail; leftOut: LeftOut[]; warnings: string[] }> {
  const { context, template } = await officeTemplate(caller, templateId)
  assertMay(context, QUOTES_MANAGE, { companyId: body.companyId, partyId: body.partyId }, 'Customer')
  if (!templateServes(template, body.companyId)) throw new ValidationError('This template belongs to another company.', [{ path: 'body/companyId', message: "A template of the quote's company, or of every company." }])
  const { result } = await command(caller, { name: 'quotes.fromTemplate', idempotencyKey, input: { templateId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const current = (await readTemplate(tx, template.id))!
    if (current.status !== 'ACTIVE') throw new InvalidStateError('The template is archived: restore it, or start from another one.')
    const company = await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true, currency: true } })
    if (!company) throw new NotFoundError('Company not found.')
    if (current.currency !== company.currency) throw new DomainError('conflict', `The template is in ${current.currency}; the company sells in ${company.currency}: start from a template in ${company.currency}.`, [{ path: 'template/currency', message: 'Another currency.' }])
    // B-W2b-290 (SAL-028): the customer's terms with this company over its own (payment terms, price list, deposit).
    const party = await withCompanyTerms(tx, await quotePartyOf(tx, body.partyId, today, now), company.id)
    if (!party || (party.row.companyId !== null && party.row.companyId !== company.id)) throw new NotFoundError('Customer not found.')
    assertQuotable(party)
    decideTreatment(party)
    const rules = await quoteRulesFor(tx, company.id)
    const taxMode = versionTaxModeOf(party.identity!.taxMode, party.viesValid)

    // The contact (the one named, else the customer's ORDERS contact with an email) and the default addresses, as W1.
    let contactId: string | null
    if (body.contactId !== undefined) {
      contactId = body.contactId
      const contact = contactId ? await tx.partyContact.findUnique({ where: { id: contactId }, select: { partyId: true, status: true } }) : null
      if (contactId && (!contact || contact.partyId !== party.row.id || contact.status !== 'ACTIVE')) throw new ValidationError('Not an active contact of this customer.', [{ path: 'body/contactId', message: 'Not an active contact of this customer.' }])
    } else contactId = (await tx.partyContact.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id ?? null
    const address = async (flag: 'isDefaultBillTo' | 'isDefaultShipTo') => (await tx.partyAddress.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', [flag]: true }, select: { id: true } }))?.id ?? null
    const billToAddressId = await address('isDefaultBillTo')
    const shipToAddressId = await address('isDefaultShipTo')
    const language = current.language === 'en' ? 'en' : 'it'

    // The template's terms, else the customer's (W1's defaults).
    const terms = (await usableTerms(tx, current.paymentTermsId, company.id)) ?? (await usableTerms(tx, party.row.paymentTermsId, company.id))
    const defaults = quoteDefaultsOf({ partyDepositPct: party.row.defaultDepositPct === null ? null : party.row.defaultDepositPct.toString(), terms, partyTermsText: party.row.paymentTerms, settingsDepositPct: rules.defaultDepositPct, language })
    const depositPct = current.depositPct === null ? defaults.depositPct : current.depositPct.toString()
    const depositKind: DepositKind | null = depositPct === null ? null : ((current.depositPct === null ? null : (current.depositKind as DepositKind | null)) ?? 'ACCONTO')
    // A paid acceptance needs a deposit (the database says so too): without one the customer signs.
    const acceptanceMode = depositPct === null ? 'SIGN' : current.acceptanceMode

    const id = newId()
    const issued = await allocateNumber(tools, { companyId: company.id, kind: 'QUOTE' }, { type: 'Quote', id })
    const actorId = actorIdOf(tools)
    await tx.quote.create({ data: { id, companyId: company.id, number: issued.formatted, partyId: party.row.id, contactId, customerRef: blank(body.customerRef), templateId: current.id, createdById: actorId }, select: { id: true } })
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
        validUntil: dayValue(addDays(today, current.validityDays ?? rules.defaultValidityDays)),
        firmOffer: current.firmOffer,
        paymentTerms: defaults.paymentTerms,
        paymentTermsId: defaults.paymentTermsId,
        termsText: current.termsText,
        termsVersion: current.termsVersion,
        depositPct,
        depositKind,
        acceptanceMode,
        incoterm: current.incoterm,
        incotermPlace: current.incoterm === null ? null : current.incotermPlace,
        shipComplete: current.shipComplete,
        marginFloorPct: rules.marginFloorPct,
        createdById: actorId,
      },
      select: { id: true },
    })
    const quote = (await readQuote(tx, id))!

    const rows = await tx.quoteTemplateLine.findMany({ where: { templateId: current.id }, select: TEMPLATE_LINE_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
    const plan = planStart(
      rows.map((row): TemplateLineInput & { id: string } => ({
        id: row.id,
        seq: row.seq,
        section: row.section,
        kind: row.kind === 'FEE' ? 'FEE' : 'SIZE_GRID',
        feeKind: row.feeKind as SalesFeeKind | null,
        styleId: row.styleId,
        colourwayId: row.colourwayId,
        sizes: sizesOf(row.sizeQuantities),
        unitPrice: row.unitPrice === null ? null : priceText(row.unitPrice.toString()),
        description: row.description,
        note: row.note,
      })),
      body.lines.map((pick) => ({ templateLineId: pick.templateLineId, colourwayId: pick.colourwayId ?? null, sizes: pick.sizes ?? null, skip: pick.skip ?? false })),
    )
    const leftOut: LeftOut[] = [...plan.leftOut]
    const warnings: string[] = []
    const net = priceBasisOf(taxMode) === 'NET'
    if (!net && plan.lines.some((line) => line.unitPrice !== null)) warnings.push("The template's prices are net; this customer buys with VAT included: its lines take the price list's prices (or none until priced).")
    const chain = await chainForQuote(tx, quote, { currency: company.currency, priceListVersionId: null, createdAt: now }, party, now, [...new Set(plan.lines.map((line) => line.styleId))])
    if (chain.keptVersionId !== null) await tx.quoteVersion.update({ where: { id: versionId }, data: { priceListVersionId: chain.keptVersionId }, select: { id: true } })

    let seq = 0
    for (const line of plan.lines) {
      let target: Awaited<ReturnType<typeof lineTarget>>
      try {
        target = await lineTarget(tx, company.id, { styleId: line.styleId, colourwayId: line.colourwayId, styleRevisionId: undefined }, null, 'body')
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error
        leftOut.push({ seq: line.seq, size: null, reason: error.message })
        continue
      }
      const offered = Object.entries(line.sizes).filter(([size]) => {
        if (target.grid.range.includes(size) && target.grid.offered.has(size)) return true
        leftOut.push({ seq: line.seq, size, reason: `Size ${size} is not offered in this colourway.` })
        return false
      })
      const grid = sizeGrid(offered.map(([size, quantity]) => ({ size, quantity })), target.grid, 'body')
      if (isIssueList(grid) || grid.length === 0) {
        leftOut.push({ seq: line.seq, size: null, reason: isIssueList(grid) && grid.length > 0 ? grid[0]!.message : 'None of its sizes is offered in this colourway: the line is not added.' })
        continue
      }
      // B-W2b-294 (QT1:01, QT1:02): the rules a line write refuses leave the line out, in their words.
      try {
        await refuseLineRules(tx, { kind: 'QUOTE', companyId: company.id, partyId: party.row.id, currency: company.currency, line: { id: null, seq: line.seq, styleId: target.style.id, colourwayId: target.colourway.id, styleRevisionId: target.revisionId, quantity: piecesOf(grid), optionItemIds: [], sizes: grid.map((row: SizeRow) => row.size) } })
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        leftOut.push({ seq: line.seq, size: null, reason: error.message })
        continue
      }
      const listed = listPriceOf(chain, taxMode, party, target.style.id, target.colourway.id)
      const unitPrice = net && line.unitPrice !== null ? line.unitPrice : (listed?.onBasis ?? '0')
      seq += 10
      const lineId = newId()
      await tx.quoteLine.create({
        data: {
          id: lineId,
          versionId,
          partyId: party.row.id,
          seq,
          section: line.section,
          kind: 'SIZE_GRID',
          styleId: target.style.id,
          styleRevisionId: target.revisionId,
          colourwayId: target.colourway.id,
          description: line.description ?? defaultLineDescription(target.style, target.colourway),
          note: line.note,
          quantity: piecesOf(grid),
          listUnitPrice: listed ? priceText(listed.onBasis) : null,
          unitPrice: priceText(unitPrice),
          netAmount: 0,
          vatRatePct: '0',
          vatAmount: 0,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.quoteLineSize.createMany({ data: grid.map((row) => ({ id: newId(), lineId, partyId: party.row.id, size: row.size, quantity: row.quantity, unitPrice: row.unitPrice, createdById: actorId })) })
    }
    await refreshVersion(tools, quote, await readCurrentVersion(tx, quote), 'all')
    tools.audit({
      action: 'quotes.fromTemplate',
      recordType: 'Quote',
      recordId: id,
      companyId: company.id,
      after: { number: issued.formatted, partyId: party.row.id, status: 'DRAFT', revision: 1, templateId: current.id, template: current.name, lines: seq / 10, leftOut, contactId, billToAddressId, shipToAddressId, depositPct, acceptanceMode, incoterm: current.incoterm, incotermPlace: current.incotermPlace, shipComplete: current.shipComplete, paymentTermsId: defaults.paymentTermsId, listVersionId: chain.keptVersionId },
    })
    tools.emit({ type: 'quote.created', subject: id, companyId: company.id, payload: { quoteId: id, versionId, number: issued.formatted, partyId: party.row.id } })
    return { ...(await detailInCommand(tools, id)), leftOut, warnings }
  })
  return forCaller(result, grainsOf(context))
}

