import type { FactoryClient } from '@nexus/factory-db'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney, type Money } from '@nexus/factory-domain/money/marked'
import { invoicedOf, type Invoiced } from '@nexus/factory-domain/sales/orders/invoiced'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandTx } from '../../../core/command'
import { hasSmallPreview } from '../../../platform/files/thumbs/small'
import { mainPictureThumbnails } from '../../product/images/main-picture'

/**
 * What a Sales › Orders row carries beside the order (B-TH-017; threads plan TH-1a, pictures 23 + 24; features
 * O-SAL-ORD-LIST.grid-F01, -F03, -F04, -F27): read for one page of rows, one query per kind, each part only for a reader
 * who may see it.
 *
 *   picture   the main picture of the first line's style (modules/product/images/main-picture.ts: the style's one main
 *             picture, AVAILABLE, a browser type), its file only with files.read over the file's company; `small` says its
 *             ~320 px preview exists (platform/files/thumbs/small.ts), which GET /sales/orders/:orderId/picture serves:
 *             the sheet never loads the original. None yet: a placeholder. `styleCount`: the order's styles ("+2").
 *   brands    the label on the garment (Style.brandPartyId: the private-label customer; null = our own collection), one
 *             entry per label across the lines; the label's name only when it is the order's own customer or a party the
 *             reader's orders.view reaches (a person limited to customer A never reads another customer's name here).
 *   invoiced  None / Part / All by pieces on issued invoices less issued credit notes, drafts and deposit invoices left
 *             out (factory-domain sales/orders/invoiced.ts, rule C8); the pieces for every reader, the net amount only
 *             with the price grain (money.price: the grain filter drops it).
 *   doors     the ids each cell opens, only those the reader may open (the word stays on the row for everyone):
 *               quote           quotes.view over the order's company and customer
 *               depositInvoice  the issued TD02 of the order's deposit, with invoices.view
 *               deliveryNotes   the order's DDTs not cancelled that the reader's shipping.view reaches: their count, the one DDT when
 *                               there is one, the shipment term when one shipment carries them all
 *               invoices        the issued invoices and credit notes of the order, with invoices.view: their count, the
 *                               one document when there is one (the invoice list has no order term: several open the
 *                               order's own invoices)
 */

type Reader = FactoryClient | CommandTx

export interface PageOrder {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly quote: { readonly id: string; readonly versionId: string } | null
}

export interface RowPicture {
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  readonly fileId: string | null
  readonly contentType: string | null
  readonly small: boolean
}

export interface RowBrand {
  /** The label's party; null with `own` (our own collection) or when the reader may not see whose label it is. */
  readonly partyId: string | null
  readonly name: string | null
  readonly own: boolean
}

export interface RowDoors {
  readonly quote: { readonly id: string; readonly versionId: string } | null
  readonly depositInvoice: { readonly id: string; readonly number: string | null } | null
  readonly deliveryNotes: { readonly count: number; readonly only: { readonly id: string; readonly number: string } | null; readonly shipmentId: string | null } | null
  readonly invoices: { readonly count: number; readonly only: { readonly id: string; readonly number: string | null; readonly docType: string } | null } | null
}

export interface OrderRowExtras {
  readonly picture: RowPicture | null
  readonly styleCount: number
  readonly brands: RowBrand[]
  readonly invoiced: Omit<Invoiced, 'amount'> & { readonly amount: Money<'price', number> }
  readonly doors: RowDoors
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]
const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}
/** Documents that bill or credit the goods and that a reader opens from the Invoiced cell. */
const GOODS_DOCUMENTS = new Set(['TD01', 'TD24', 'TD04'])

/** The extras of each order of the page, by order id. */
export async function orderRowExtras(
  client: Reader,
  actor: Actor,
  orders: readonly PageOrder[],
  deposits: readonly { readonly id: string; readonly orderId: string | null }[],
  shipments: readonly { readonly id: string; readonly salesOrderId: string | null }[],
): Promise<Map<string, OrderRowExtras>> {
  const out = new Map<string, OrderRowExtras>()
  if (orders.length === 0) return out
  const orderIds = orders.map((order) => order.id)

  // ---- lines, styles, labels, pictures ----------------------------------------------------------------------------------
  const lines = await client.salesOrderLine.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true, seq: true, kind: true, styleId: true, quantity: true, closedShortQuantity: true, feeCreditedAt: true },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  const styles = lines.length > 0 ? await client.style.findMany({ where: { id: { in: unique(lines.map((line) => line.styleId)) } }, select: { id: true, code: true, name: true, brandPartyId: true } }) : []
  const styleOf = new Map(styles.map((style) => [style.id, style]))
  const brandIds = unique(styles.flatMap((style) => (style.brandPartyId ? [style.brandPartyId] : [])))
  const brandNames = new Map(brandIds.length > 0 ? (await client.party.findMany({ where: { id: { in: brandIds } }, select: { id: true, legalName: true } })).map((party) => [party.id, party.legalName]) : [])
  const linesOf = new Map<string, typeof lines>()
  for (const line of lines) push(linesOf, line.orderId, line)
  const firstStyleIds = unique(orders.flatMap((order) => (linesOf.get(order.id)?.[0] ? [linesOf.get(order.id)![0]!.styleId] : [])))
  const thumbnails = await mainPictureThumbnails(client, actor, firstStyleIds)
  const fileIds = unique([...thumbnails.values()].map((thumbnail) => thumbnail.fileId))
  const prepared = new Map(
    fileIds.length > 0 ? (await client.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, contentType: true, thumbnailKey: true } })).map((file) => [file.id, hasSmallPreview(file)]) : [],
  )

  // ---- invoices -----------------------------------------------------------------------------------------------------------
  const lineIds = lines.map((line) => line.id)
  const billed = lineIds.length > 0 ? await client.invoiceLine.findMany({ where: { salesOrderLineId: { in: lineIds }, kind: { in: ['GOODS', 'SERVICE'] } }, select: { invoiceId: true, salesOrderLineId: true, kind: true, quantity: true, netAmount: true } }) : []
  const depositIds = deposits.map((deposit) => deposit.id)
  const invoices = await client.invoice.findMany({
    where: { OR: [{ salesOrderId: { in: orderIds } }, ...(billed.length > 0 ? [{ id: { in: unique(billed.map((row) => row.invoiceId)) } }] : []), ...(depositIds.length > 0 ? [{ depositRequestId: { in: depositIds } }] : [])] },
    select: { id: true, number: true, docType: true, status: true, salesOrderId: true, depositRequestId: true, issueDate: true },
    orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
  })
  const invoiceOf = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  const orderOfLine = new Map(lines.map((line) => [line.id, line.orderId]))
  const orderOfDeposit = new Map(deposits.map((deposit) => [deposit.id, deposit.orderId]))
  // Grouped once for the page: each order's invoice lines, and the issued documents that name it (by its id, its deposit or
  // one of its lines; a deferred TD24 may bill several orders).
  const billedOf = new Map<string, typeof billed>()
  const documentsOf = new Map<string, Set<string>>()
  const name = (orderId: string | null | undefined, invoiceId: string): void => {
    if (!orderId) return
    documentsOf.set(orderId, (documentsOf.get(orderId) ?? new Set<string>()).add(invoiceId))
  }
  for (const row of billed) {
    const orderId = row.salesOrderLineId === null ? undefined : orderOfLine.get(row.salesOrderLineId)
    if (!orderId) continue
    push(billedOf, orderId, row)
    name(orderId, row.invoiceId)
  }
  for (const invoice of invoices) {
    name(invoice.salesOrderId, invoice.id)
    if (invoice.depositRequestId !== null) name(orderOfDeposit.get(invoice.depositRequestId), invoice.id)
  }

  // ---- delivery notes -----------------------------------------------------------------------------------------------------
  const shipmentIds = shipments.map((shipment) => shipment.id)
  const ddts = shipmentIds.length > 0 ? await client.ddt.findMany({ where: { shipmentId: { in: shipmentIds }, cancellations: { none: {} } }, select: { id: true, number: true, shipmentId: true, companyId: true, siteId: true, partyId: true }, orderBy: [{ documentDate: 'asc' }, { number: 'asc' }] }) : []
  const orderOfShipment = new Map(shipments.map((shipment) => [shipment.id, shipment.salesOrderId]))
  const ddtsOf = new Map<string, typeof ddts>()
  for (const ddt of ddts) {
    const orderId = ddt.shipmentId === null ? null : orderOfShipment.get(ddt.shipmentId)
    if (orderId) push(ddtsOf, orderId, ddt)
  }

  for (const order of orders) {
    const own = linesOf.get(order.id) ?? []
    const scope = { companyId: order.companyId, partyId: order.partyId }

    const first = own[0]
    const firstStyle = first ? styleOf.get(first.styleId) : undefined
    const thumbnail = first ? thumbnails.get(first.styleId) : undefined
    const picture: RowPicture | null = firstStyle
      ? { styleId: firstStyle.id, styleCode: firstStyle.code, styleName: firstStyle.name, fileId: thumbnail?.fileId ?? null, contentType: thumbnail?.contentType ?? null, small: thumbnail ? prepared.get(thumbnail.fileId) === true : false }
      : null

    const labels = unique(own.map((line) => styleOf.get(line.styleId)?.brandPartyId ?? null))
    const brands: RowBrand[] = labels
      .map((partyId): RowBrand => {
        if (partyId === null) return { partyId: null, name: null, own: true }
        const seen = partyId === order.partyId || can(actor, ORDERS_VIEW, { partyId })
        return seen ? { partyId, name: brandNames.get(partyId) ?? null, own: false } : { partyId: null, name: null, own: false }
      })
      .sort((a, b) => Number(a.own) - Number(b.own) || (a.name ?? '').localeCompare(b.name ?? ''))

    const documentLines = (billedOf.get(order.id) ?? []).flatMap((row) => {
      const invoice = invoiceOf.get(row.invoiceId)
      return invoice ? [{ docType: invoice.docType, status: invoice.status, kind: row.kind, salesOrderLineId: row.salesOrderLineId, quantity: row.quantity.toString(), netAmount: row.netAmount }] : []
    })
    const invoiced = invoicedOf(
      own.map((line) => ({ id: line.id, kind: line.kind, quantity: line.quantity, closedShortQuantity: line.closedShortQuantity, feeCredited: line.kind === 'FEE' && line.feeCreditedAt !== null })),
      documentLines,
    )

    const mayInvoices = can(actor, INVOICES_VIEW, scope)
    const named = documentsOf.get(order.id)
    const related = named ? invoices.filter((invoice) => invoice.status !== 'DRAFT' && named.has(invoice.id)) : []
    const goods = related.filter((invoice) => GOODS_DOCUMENTS.has(invoice.docType))
    const deposit = related.filter((invoice) => invoice.docType === 'TD02' && invoice.depositRequestId !== null && orderOfDeposit.get(invoice.depositRequestId) === order.id).at(-1)

    const notes = (ddtsOf.get(order.id) ?? []).filter((ddt) => can(actor, SHIPPING_VIEW, { companyId: ddt.companyId, siteId: ddt.siteId, partyId: ddt.partyId }))
    const mayShipping = can(actor, SHIPPING_VIEW, scope) || notes.length > 0
    const noteShipments = unique(notes.map((ddt) => ddt.shipmentId))

    out.set(order.id, {
      picture,
      styleCount: unique(own.map((line) => line.styleId)).length,
      brands,
      invoiced: { state: invoiced.state, pieces: invoiced.pieces, toInvoice: invoiced.toInvoice, amount: asMoney('price', invoiced.amount) },
      doors: {
        quote: order.quote && can(actor, QUOTES_VIEW, scope) ? { id: order.quote.id, versionId: order.quote.versionId } : null,
        depositInvoice: mayInvoices && deposit ? { id: deposit.id, number: deposit.number } : null,
        deliveryNotes: mayShipping ? { count: notes.length, only: notes.length === 1 ? { id: notes[0]!.id, number: notes[0]!.number } : null, shipmentId: noteShipments.length === 1 ? noteShipments[0]! : null } : null,
        invoices: mayInvoices ? { count: goods.length, only: goods.length === 1 ? { id: goods[0]!.id, number: goods[0]!.number, docType: goods[0]!.docType } : null } : null,
      },
    })
  }
  return out
}
