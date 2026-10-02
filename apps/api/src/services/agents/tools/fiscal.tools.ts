/**
 * MCP full control 07 O14 — `issue-fiscal-document`: take the fiscal number of invoices (orders) and credit notes
 * (refunds), through the services the Nexus pages use (fiscal-invoice.service.ts, credit-note.service.ts).
 *
 *   - The business's OWN series (O2): Xavia keeps 'XAVIA', every other business its own issuer.
 *   - Idempotent: a document already numbered keeps its number; nothing new is taken for it.
 *   - Refused without the company's name, full address and P.IVA (Settings › Company): an invoice is never issued with
 *     missing or made-up company details, so no number is taken (decision of 2026-10-01: a business without them —
 *     Motovento today — is refused).
 *   - Only for a paid order (not cancelled, pending or awaiting payment) and a POSTED refund (the Returns page's rule).
 *   - Never sends anything to SDI or the RT: numbering only; the XML and its dispatch stay manual in Nexus.
 *
 * Numbers are permanent and gap-free (a mistake needs a credit note): it always waits for a person's approval in Nexus,
 * and cannot be undone.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { auditLogService } from '../../audit-log.service.js'
import { currentInvoiceIssuer, MissingBusinessIdentityError, requireInvoiceIdentity } from '../../business-identity.service.js'
import { assignInvoiceNumber } from '../../fiscal-invoice.service.js'
import { assignCreditNoteNumber } from '../../credit-note.service.js'
import { staleRefusal } from './stale-preview.js'
import type { AgentTool, ToolResult } from '../tool-types.js'

const MAX_DOCUMENTS = 50
/** An invoice is numbered only for an order that was paid. */
const NOT_PAID = ['CANCELLED', 'PENDING', 'AWAITING_PAYMENT']
const ids = (what: string) => z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_DOCUMENTS).describe(what)
const unique = (list: string[]) => new Set(list).size === list.length

const input = z.object({
  orderIds: ids(`orders to number an invoice for (at most ${MAX_DOCUMENTS}); an order numbered already keeps its number`).optional(),
  refundIds: ids(`refunds to number a credit note (nota di credito) for (at most ${MAX_DOCUMENTS}); each POSTED`).optional(),
  causale: z.string().trim().min(3).max(200).optional().describe('credit notes: the reason printed on them; default "Resa merce — <RMA>"'),
})
type Args = z.infer<typeof input>

async function preview(a: Args): Promise<ToolResult> {
  const orderIds = a.orderIds ?? []
  const refundIds = a.refundIds ?? []
  if (!orderIds.length && !refundIds.length) return { ok: false, error: 'Name the orders to invoice (orderIds) or the refunds to credit (refundIds). Nothing was queued.' }
  if (!unique(orderIds) || !unique(refundIds)) return { ok: false, error: 'A document is named twice. Nothing was queued.' }

  const orders = await prisma.order.findMany({ where: { id: { in: orderIds }, deletedAt: null }, select: { id: true, channelOrderId: true, status: true } })
  const missingOrder = orderIds.find((id) => !orders.some((o) => o.id === id))
  if (missingOrder) return { ok: false, error: `Order not found: ${missingOrder}. Nothing was queued.` }
  const refunds = await prisma.refund.findMany({
    where: { id: { in: refundIds } },
    select: { id: true, channelStatus: true, amountCents: true, currencyCode: true, return: { select: { rmaNumber: true, order: { select: { channelOrderId: true } } } } },
  })
  const missingRefund = refundIds.find((id) => !refunds.some((r) => r.id === id))
  if (missingRefund) return { ok: false, error: `Refund not found: ${missingRefund}. Nothing was queued.` }
  for (const o of orders) {
    if (NOT_PAID.includes(o.status)) return { ok: false, error: `Order ${o.channelOrderId} is ${o.status}: an invoice is numbered only for a paid order. Nothing was queued.` }
  }
  for (const r of refunds) {
    if (r.channelStatus !== 'POSTED') return { ok: false, error: `Refund ${r.id} (return ${r.return.rmaNumber ?? '?'}) is ${r.channelStatus}: a credit note is numbered only for a POSTED refund. Nothing was queued.` }
  }
  try {
    await requireInvoiceIdentity(orderIds.length ? 'the invoice' : 'the credit note')
  } catch (error) {
    if (error instanceof MissingBusinessIdentityError) return { ok: false, error: error.message }
    throw error
  }

  const invoiced = await prisma.fiscalInvoice.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, invoiceNumber: true } })
  const credited = await prisma.creditNote.findMany({ where: { refundId: { in: refundIds } }, select: { refundId: true, creditNoteNumber: true } })
  const invoices = orderIds.map((id) => {
    const o = orders.find((x) => x.id === id)!
    const done = invoiced.find((x) => x.orderId === id)
    return { orderId: id, channelOrderId: o.channelOrderId, outcome: done ? `already ${done.invoiceNumber} (kept)` : 'new number' }
  })
  const creditNotes = refundIds.map((id) => {
    const r = refunds.find((x) => x.id === id)!
    const done = credited.find((x) => x.refundId === id)
    return {
      refundId: id, rmaNumber: r.return.rmaNumber, channelOrderId: r.return.order?.channelOrderId ?? null, amount: r.amountCents / 100, currencyCode: r.currencyCode,
      outcome: done ? `already ${done.creditNoteNumber} (kept)` : 'new number',
    }
  })
  const newNumbers = [...invoices, ...creditNotes].filter((d) => d.outcome === 'new number').length
  return {
    ok: true,
    preview: {
      action: 'issue-fiscal-document',
      series: { issuer: currentInvoiceIssuer(), fiscalYear: new Date().getFullYear() },
      invoices,
      creditNotes,
      causale: a.causale ?? null,
      newNumbers,
      note: 'Takes permanent, gap-free fiscal numbers in this business\'s own series (a mistake needs a credit note). Nothing is sent to SDI or the RT.',
    },
  }
}

const issueFiscalDocument: AgentTool = {
  name: 'issue-fiscal-document',
  title: 'Number invoices and credit notes',
  input,
  requires: [F.ordersEdit],
  category: 'orders',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Take the fiscal number of invoices (paid orders) and credit notes (POSTED refunds) of this business, in its own '
    + 'gap-free series; a document numbered already keeps its number. Refused while the company\'s name, full address '
    + 'or P.IVA is missing in Settings › Company. Numbering only: nothing is sent to SDI or the RT. Numbers are permanent: '
    + 'it always waits for a person to approve it in Nexus and cannot be undone.',
  handler: (args) => preview(args as Args),
  async execute(args, ctx) {
    const a = args as Args
    const fresh = await preview(a)
    if (!fresh.ok) return fresh
    const stale = staleRefusal(ctx.approvedPreview, fresh.preview, ['series', 'invoices', 'creditNotes'], 'a document')
    if (stale) return { ok: false, error: stale }
    const who = { userId: ctx.userId ?? null, ip: null }
    const invoices = []
    for (const orderId of a.orderIds ?? []) {
      const out = await assignInvoiceNumber(orderId)
      invoices.push({ orderId, number: out.invoiceNumber, issuer: out.issuer, fiscalYear: out.fiscalYear, newlyAssigned: out.newlyAssigned })
      if (out.newlyAssigned) void auditLogService.write({ ...who, entityType: 'Order', entityId: orderId, action: 'invoice-assign', after: { invoiceNumber: out.invoiceNumber, fiscalYear: out.fiscalYear, sequenceNumber: out.sequenceNumber }, metadata: { via: ctx.via } })
    }
    const creditNotes = []
    for (const refundId of a.refundIds ?? []) {
      const out = await assignCreditNoteNumber(refundId, { causale: a.causale })
      creditNotes.push({ refundId, number: out.creditNoteNumber, issuer: out.issuer, fiscalYear: out.fiscalYear, newlyAssigned: out.newlyAssigned })
      if (out.newlyAssigned) void auditLogService.write({ ...who, entityType: 'Refund', entityId: refundId, action: 'credit-note-assign', after: { creditNoteNumber: out.creditNoteNumber, fiscalYear: out.fiscalYear, sequenceNumber: out.sequenceNumber, newlyAssigned: true }, metadata: { via: ctx.via } })
    }
    return {
      ok: true,
      data: { invoices, creditNotes, note: 'Numbered only: the XML and its dispatch to SDI stay on the order and refund pages in Nexus.' },
      change: { before: { orderIds: a.orderIds ?? [], refundIds: a.refundIds ?? [] }, after: { invoices: invoices.map((i) => ({ orderId: i.orderId, number: i.number })), creditNotes: creditNotes.map((c) => ({ refundId: c.refundId, number: c.number })) } },
    }
  },
}

export const FISCAL_TOOLS: AgentTool[] = [issueFiscalDocument]
