import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The order profitability report's documents (B-W2b-416; FIN-053; design finance.margins pop:order "Documents (W2b)"):
 * `GET /costing/margins/orders/:id/documents`, the answer's shape checked (zod; unknown fields dropped). Mirrors factory-domain
 * costing/profitability/contracts orderDocumentsView; the enum lists mirror factory-domain costing/profitability/documents
 * (documents.vitest.test.ts holds them equal). Every amount carries its grain and is absent for a person without it (an
 * invoice's, a payment's and the freight charged: price; a cost entry's and the freight cost: cost). A group the person may
 * not see comes with the permission it needs (`held`) and no rows.
 */

export const INVOICE_KINDS = ['INVOICE', 'DEFERRED_INVOICE', 'DEPOSIT_INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'OTHER'] as const
export type InvoiceKind = (typeof INVOICE_KINDS)[number]
export const COST_KINDS = ['WORK_ORDER', 'COST_OF_SALES', 'SUBCONTRACT_ORDER', 'SUPPLIER_INVOICE'] as const
export type CostKind = (typeof COST_KINDS)[number]
export const DOCUMENT_NOTES = ['OTHER_CURRENCY', 'SHARED_INVOICE', 'SHARED_WORK_ORDER', 'FREIGHT_COST_MISSING', 'NOT_ISSUED'] as const
export type DocumentNote = (typeof DOCUMENT_NOTES)[number]

const grain = <T extends z.ZodTypeAny>(schema: T) => schema.optional()
const ref = z.object({ id: z.string(), number: z.string().nullable() })

export const invoiceDocumentSchema = z.object({
  id: z.string(),
  kind: z.enum(INVOICE_KINDS),
  docType: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  issueDate: z.string().nullable(),
  currency: z.string(),
  netTotal: grain(z.number()),
  grossTotal: grain(z.number()),
  forOrder: grain(z.number()),
  shared: z.boolean(),
  of: ref.nullable(),
})
export type InvoiceDocument = z.infer<typeof invoiceDocumentSchema>

export const costDocumentSchema = z.object({
  kind: z.enum(COST_KINDS),
  record: z.object({ type: z.enum(['WorkOrder', 'Shipment', 'SubcontractOrder', 'SupplierInvoice']), id: z.string(), number: z.string().nullable() }),
  status: z.string().nullable(),
  date: z.string().nullable(),
  currency: z.string(),
  amount: grain(z.number()),
  entries: z.number(),
  pieces: z.number().nullable(),
  ofPieces: z.number().nullable(),
  reversed: z.boolean(),
})
export type CostDocument = z.infer<typeof costDocumentSchema>

export const freightDocumentSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  date: z.string().nullable(),
  carrier: z.string().nullable(),
  chargeCurrency: z.string(),
  charge: grain(z.number().nullable()),
  costCurrency: z.string().nullable(),
  cost: grain(z.number().nullable()),
})
export type FreightDocument = z.infer<typeof freightDocumentSchema>

export const paymentDocumentSchema = z.object({
  id: z.string(),
  reference: z.string(),
  method: z.string(),
  status: z.string(),
  receivedOn: z.string(),
  currency: z.string(),
  amount: grain(z.number()),
  paid: grain(z.number()),
  to: z.array(z.object({ type: z.enum(['Invoice', 'DepositRequest']), id: z.string(), number: z.string().nullable() })),
  reversed: z.boolean(),
})
export type PaymentDocument = z.infer<typeof paymentDocumentSchema>

const group = <Row extends z.ZodTypeAny>(row: Row) => z.object({ held: z.string().nullable(), rows: z.array(row) })

export const orderDocumentsSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), currency: z.string() }),
  invoices: group(invoiceDocumentSchema),
  creditNotes: group(invoiceDocumentSchema),
  costs: group(costDocumentSchema),
  freight: group(freightDocumentSchema),
  payments: group(paymentDocumentSchema),
  totals: z.object({
    invoiced: grain(z.number().nullable()),
    credited: grain(z.number().nullable()),
    net: grain(z.number().nullable()),
    deposits: grain(z.number().nullable()),
    paid: grain(z.number().nullable()),
    freightCharged: grain(z.number().nullable()),
    freightCost: grain(z.number().nullable()),
    otherCurrency: z.number(),
  }),
  notes: z.array(z.enum(DOCUMENT_NOTES)),
})
export type OrderDocuments = z.infer<typeof orderDocumentsSchema>

/** GET /costing/margins/orders/:id/documents: every document of the order, each a link. */
export function getOrderDocuments(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderDocuments> {
  return api.get(`/costing/margins/orders/${encodeURIComponent(orderId)}/documents`, { schema: orderDocumentsSchema, signal })
}
