import { z } from 'zod'
import { businessDate, id, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { COST_KINDS, DOCUMENT_NOTES, INVOICE_KINDS } from './documents'
import { FLOOR_BASES, FLOOR_SOURCES } from './floor'

/**
 * The contracts of margins in depth (B-W2b-416; FIN-050, FIN-053; design finance.margins tiles "Orders below the floor",
 * the orders grid's floor flag, pop:order "Documents"). The floor and its flag are the margin grain (the quotes' own
 * `belowFloor` is): a person without it sees neither. In the documents every amount carries its own grain: an invoice's,
 * a payment's and the freight charged are prices, a cost entry's and the freight the carrier charged are costs. A group
 * the reader may not see comes back empty with the permission it needs (`held`), never as "no documents". No person is
 * named.
 */

/** The floor an order is held to (the margin grain: the field around it is `money.margin`). */
export const floorView = output({
  /** Percent of the value, as the Sales settings write it ("25"). */
  pct: z.string(),
  /** ROLE: the lowest floor of the seller's roles; COMPANY: the company's floor. */
  from: z.enum(FLOOR_SOURCES),
  /** ROLE: the role's name. */
  role: z.string().nullable(),
  /** What the flag is judged on: the final margin, or the margin as estimated now (null: not known). */
  basis: z.enum(FLOOR_BASES).nullable(),
  /** The accepted quote version was priced under its floor (a yes let it through). */
  quotedBelow: z.boolean(),
})
export type FloorView = z.infer<typeof floorView>

/** The permission a reader lacks for a group (null: the group is shown). */
const held = z.string().nullable()

const recordRef = output({ id: id(), number: z.string().nullable() })

export const invoiceDocumentView = output({
  id: id(),
  kind: z.enum(INVOICE_KINDS),
  /** FatturaPA TipoDocumento (TD01, TD24, TD02, TD05, TD04). */
  docType: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  issueDate: businessDate().nullable(),
  currency: z.string(),
  netTotal: money.price(z.number().int()),
  grossTotal: money.price(z.number().int()),
  /** This order's part of the net (an invoice of several orders bills each its own lines). */
  forOrder: money.price(z.number().int()),
  /** It also bills other orders. */
  shared: z.boolean(),
  /** A credit note: the invoice it credits; a debit note: the invoice it adds to. */
  of: recordRef.nullable(),
})

export const costDocumentView = output({
  kind: z.enum(COST_KINDS),
  /** What the row opens: a work order's cost, a shipment (its cost of goods sold), a subcontract order, a supplier invoice. */
  record: output({ type: z.enum(['WorkOrder', 'Shipment', 'SubcontractOrder', 'SupplierInvoice']), id: id(), number: z.string().nullable() }),
  status: z.string().nullable(),
  /** The last entry's day (Europe/Rome). */
  date: businessDate().nullable(),
  currency: z.string(),
  /** Σ its entries (a work order's whole cost so far; a shipment's cost of goods sold; what a document put on the work orders). */
  amount: money.cost(z.number().int()),
  entries: z.number().int(),
  /** A work order: its garments for this order, of all its garments. */
  pieces: z.number().int().nullable(),
  ofPieces: z.number().int().nullable(),
  /** Something of it was reversed (a cost entry, a shipment's cost of goods sold taken back). */
  reversed: z.boolean(),
})

export const freightDocumentView = output({
  shipment: output({ id: id(), number: z.string(), status: z.string() }),
  /** The day it left (null: not yet). */
  date: businessDate().nullable(),
  carrier: z.string().nullable(),
  /** Charged to the customer, in the order's currency (null: none decided). */
  chargeCurrency: z.string(),
  charge: money.price(z.number().int().nullable()),
  /** What the carrier charged us (null: not recorded); its currency is a code, no figure. */
  costCurrency: notMoney(z.string().nullable()),
  cost: money.cost(z.number().int().nullable()),
})

export const paymentDocumentView = output({
  id: id(),
  /** The bank's or the card's reference. */
  reference: z.string(),
  method: z.string(),
  status: z.string(),
  receivedOn: businessDate(),
  currency: z.string(),
  /** The whole payment, and what it paid of this order (its placements on the order's invoices and deposit requests). */
  amount: money.price(z.number().int()),
  paid: money.price(z.number().int()),
  to: z.array(output({ type: z.enum(['Invoice', 'DepositRequest']), id: id(), number: z.string().nullable() })),
  /** A placement of it was taken back. */
  reversed: z.boolean(),
})

const group = <Row extends z.ZodType>(row: Row) => output({ held, rows: z.array(row) })

export const orderDocumentsView = output({
  order: output({ id: id(), number: z.string(), currency: z.string() }),
  invoices: group(invoiceDocumentView),
  creditNotes: group(invoiceDocumentView),
  costs: notMoney(group(costDocumentView)),
  freight: group(freightDocumentView),
  payments: group(paymentDocumentView),
  /** Over the documents in the order's currency (null: the reader may not see that group). */
  totals: notMoney(
    output({
      invoiced: money.price(z.number().int().nullable()),
      credited: money.price(z.number().int().nullable()),
      net: money.price(z.number().int().nullable()),
      deposits: money.price(z.number().int().nullable()),
      paid: money.price(z.number().int().nullable()),
      freightCharged: money.price(z.number().int().nullable()),
      freightCost: money.cost(z.number().int().nullable()),
      otherCurrency: z.number().int(),
    }),
  ),
  /** Why a figure is partial (codes; words on the screen). */
  notes: z.array(z.enum(DOCUMENT_NOTES)),
})
export type OrderDocumentsView = z.infer<typeof orderDocumentsView>
