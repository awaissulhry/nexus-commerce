/**
 * MCP full control 08 S9 — an e-mail to a supplier, moved unchanged out of `POST /api/fulfillment/suppliers/:id/comms/email`
 * (routes/fulfillment.routes.ts), so the page and Claude's `email-supplier` send it the same way: through the shared
 * e-mail transport (a dry run that only logs it unless NEXUS_ENABLE_OUTBOUND_EMAILS=true), then one entry in the
 * supplier's comms log with whether it went out. The route keeps its own checks and default subject; it answers with
 * what this returns, byte for byte as before. `from` is the sender (the business's identity, 07 O3); left out, the
 * transport's own default.
 */
import prisma from '../../db.js'

export interface SupplierEmail {
  supplierId: string
  to: string
  subject: string
  text: string
  contactId?: string | null
  /** The person it is sent as: the comms log names them. */
  byUserId: string | null
  from?: string
}

export async function sendSupplierEmail(input: SupplierEmail) {
  const { sendEmail } = await import('../email/transport.js')
  const html = `<div style="font-family:Inter,-apple-system,sans-serif;font-size:14px;color:#0f172a;white-space:pre-wrap;">${input.text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))}</div>`
  const result = await sendEmail({ to: input.to, subject: input.subject, html, text: input.text, tag: `supplier-comms:${input.supplierId}`, ...(input.from ? { from: input.from } : {}) })

  const created = await prisma.supplierComm.create({
    data: {
      supplierId: input.supplierId,
      contactId: input.contactId ?? null,
      channel: 'EMAIL',
      direction: 'OUT',
      subject: input.subject,
      body: input.text,
      emailTo: input.to,
      emailOk: result.ok,
      byUserId: input.byUserId,
    },
  })
  return { comm: created, delivery: result }
}
