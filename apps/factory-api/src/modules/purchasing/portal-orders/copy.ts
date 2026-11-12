import type { FastifyRequest } from 'fastify'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import type { DocumentParty } from '@nexus/factory-domain/documents/model'
import { identityAt } from '@nexus/factory-domain/parties/tax'
import { purchaseOrderDocument, type SupplierLine, type SupplierOrder } from '@nexus/factory-domain/purchasing/document'
import { priceFreeCopy } from '@nexus/factory-domain/purchasing/portal-orders/copy'
import type { RevisionState } from '@nexus/factory-domain/purchasing/revisions/revisions'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { systemCallerOf } from '../../../platform/files/files'
import { TAX_COLUMNS, taxFieldsOf } from '../../parties/store'
import { dayOf, decimal, quantityText, type Reader } from '../store'
import { siteAddressOf } from '../views'
import { heldLines, heldOrder, localeOf } from './read'

/**
 * The price-free copy of a purchase order (B-W2b-174; Owner answer C2 "a price-free PO copy, price talk only in the PO's
 * thread"; design portal.supplier.orders tab "PO PDF (as sent)" and Documents "PO versions as sent"): GET
 * /portal/purchase-orders/:purchaseOrderId/copy paints, on request, the order the supplier holds with the fixed
 * PURCHASE_ORDER layout (its letterhead, parties, facts, every line in the supplier's terms with the leather specs and the
 * Cr VI test) and NO price: the order and its lines are read in the session's own scope (the partner role's grants hold no
 * price, amount or internal note), the composer is given zero prices, and factory-domain purchasing/portal-orders/copy
 * strips the priced columns and the totals before the PDF is painted. What the partner role may not read but the order's
 * paper says anyway comes from the tenant's system scope for this order only: the letterhead, the supplier's own legal
 * block, the delivery site, the material's and colour's names. Nothing is stored (the mailed PDF with the prices stays the
 * order's document, on its thread); a draft we are changing prints the revision the supplier holds, as sent.
 */

const ZERO_PRICE = '0.000000'

/** The supplier as its own copy prints it: legal name, registered (else invoice, else any) address, VAT number today. */
async function supplierBlock(tenant: Reader, partyId: string, contactId: string | null, today: string): Promise<DocumentParty> {
  const party = await tenant.party.findUniqueOrThrow({ where: { id: partyId }, select: { legalName: true } })
  const addresses = await tenant.partyAddress.findMany({
    where: { partyId, status: 'ACTIVE' },
    select: { kinds: true, isDefaultBillTo: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const address = addresses.find((row) => row.kinds.includes('REGISTERED')) ?? addresses.find((row) => row.isDefaultBillTo) ?? addresses[0] ?? null
  const identity = identityAt((await tenant.partyTaxIdentity.findMany({ where: { partyId }, select: TAX_COLUMNS })).map(taxFieldsOf), today)
  const contact = contactId ? await tenant.partyContact.findUnique({ where: { id: contactId }, select: { email: true } }) : null
  return {
    name: party.legalName,
    address: address ? { line1: address.line1, line2: address.line2, postalCode: address.postalCode, city: address.city, province: address.province, country: address.country } : null,
    vatNumber: identity?.vatNumber ?? null,
    fiscalCode: identity?.vatNumber ? null : (identity?.fiscalCode ?? null),
    email: contact?.email ?? null,
  }
}

/** GET /portal/purchase-orders/:purchaseOrderId/copy: the PDF without prices (an attachment, never stored). */
export async function portalOrderCopy(request: FastifyRequest, orderId: string, asked?: string | null): Promise<{ pdf: Buffer; fileName: string }> {
  const session: PortalSession = portalSessionOf(request)
  const language = localeOf(session, asked)
  const own = await request.withClient(async (client) => {
    const order = await heldOrder(client, session, orderId)
    const lines = await heldLines(client, order.id)
    const head = await client.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, select: { currency: true, contactId: true } })
    // B-W2b-305: an order waiting for its yes is not sent yet either.
    const held = order.status === 'DRAFT' || order.status === 'PENDING_APPROVAL' ? await client.purchaseOrderRevision.findFirst({ where: { purchaseOrderId: order.id, revision: order.revision - 1 }, select: { after: true } }) : null
    return { order, lines, head, held: held ? (held.after as unknown as RevisionState) : null }
  })
  const { order, lines, head, held } = own
  const tenantCaller = systemCallerOf(request)(session.tenantId)
  const company = await companyLegalOf(tenantCaller, order.companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) throw new DomainError('conflict', 'The copy of this order cannot be made right now: ask the buyer.', [...problems])
  const today = dayOf(order.orderDate)!
  const facts = await tenantCaller.withClient(async (tenant) => {
    const itemIds = [...lines.map((line) => line.itemId), ...(held?.lines ?? []).map((line) => line.itemId)]
    const colourIds = [...lines, ...(held?.lines ?? [])].flatMap((line) => (line.itemColourId ? [line.itemColourId] : []))
    const items = new Map((await tenant.item.findMany({ where: { id: { in: [...new Set(itemIds)] } }, select: { id: true, code: true, name: true, kind: true, baseUom: true } })).map((item) => [item.id, item]))
    const colours = new Map((colourIds.length === 0 ? [] : await tenant.itemColour.findMany({ where: { id: { in: [...new Set(colourIds)] } }, select: { id: true, name: true } })).map((colour) => [colour.id, colour.name]))
    const site = await tenant.site.findUnique({ where: { id: order.siteId }, select: { name: true, address: true } })
    return { items, colours, site, supplier: await supplierBlock(tenant, order.partyId, head.contactId, today) }
  })
  const liveById = new Map(lines.map((line) => [line.id, line]))
  const printed: SupplierLine[] = held
    ? held.lines
        .filter((line) => !line.cancelled)
        .map((line) => {
          const item = facts.items.get(line.itemId)
          const live = liveById.get(line.id)
          return {
            seq: line.seq,
            code: line.supplierArticleCode ?? item?.code ?? '',
            name: item?.name ?? '',
            colour: line.itemColourId ? { name: facts.colours.get(line.itemColourId) ?? '', supplierCode: line.supplierColourCode ?? null } : null,
            description: line.description,
            quantity: line.quantity,
            uom: line.uom,
            unitPrice: ZERO_PRICE,
            netAmount: 0,
            needDate: line.needDate,
            leather:
              item?.kind === 'LEATHER'
                ? { grade: line.grade ?? null, thicknessMinMm: line.thicknessMinMm ?? null, thicknessMaxMm: line.thicknessMaxMm ?? null, oneDyeBatch: line.oneDyeBatch ?? false, areaTolerancePct: line.areaTolerancePct ?? null, estimatedHides: null, baseQuantity: line.quantity, baseUom: item.baseUom }
                : null,
            requiresCrViTest: live?.requiresCrViTest ?? false,
            note: line.note ?? null,
          }
        })
    : lines
        .filter((line) => line.cancelledAt === null)
        .map((line) => {
          const item = facts.items.get(line.itemId)
          return {
            seq: line.seq,
            code: line.supplierArticleCode ?? item?.code ?? '',
            name: item?.name ?? '',
            colour: line.itemColourId ? { name: facts.colours.get(line.itemColourId) ?? '', supplierCode: line.supplierColourCode } : null,
            description: line.description,
            quantity: quantityText(line.quantity),
            uom: line.uom,
            unitPrice: ZERO_PRICE,
            netAmount: 0,
            needDate: dayOf(line.needDate)!,
            leather:
              item?.kind === 'LEATHER'
                ? {
                    grade: line.grade,
                    thicknessMinMm: decimal(line.thicknessMinMm),
                    thicknessMaxMm: decimal(line.thicknessMaxMm),
                    oneDyeBatch: line.oneDyeBatch,
                    areaTolerancePct: decimal(line.areaTolerancePct),
                    estimatedHides: line.estimatedHides,
                    baseQuantity: quantityText(line.baseQuantity),
                    baseUom: item.baseUom,
                  }
                : null,
            requiresCrViTest: line.requiresCrViTest,
            note: line.note,
          }
        })
  const copy: SupplierOrder = {
    number: order.number,
    revision: held ? order.revision - 1 : order.revision,
    language,
    date: today,
    currency: head.currency,
    supplier: facts.supplier,
    deliverTo: facts.site ? siteAddressOf(facts.site) : null,
    requestedDate: held ? held.requestedDate : dayOf(order.requestedDate),
    incoterms: held ? held.incoterms : order.incoterms,
    paymentTerms: held ? held.paymentTerms : order.paymentTerms,
    note: held ? held.note : order.note,
    lines: printed,
    netAmount: 0,
  }
  const composed = priceFreeCopy(composeDocument({ ...purchaseOrderDocument(copy), company, sample: false }))
  return { pdf: await renderDocumentPdf(composed), fileName: documentFileName(composed) }
}
