/**
 * PO.9 — Supplier-side email + ack URL minting.
 *
 * When the operator transitions an APPROVED PO to SUBMITTED via
 * `transition('send')`, this service mints a fresh URL-safe token,
 * writes it onto the PO row (`supplierAckToken` + `supplierAckExpiresAt`),
 * and emails the supplier with:
 *   - the factory PDF as an attachment
 *   - a confirmation URL the supplier can click to confirm / decline
 *     / propose a new ETA
 *
 * Default token TTL: 30 days. Override via NEXUS_PO_ACK_TTL_DAYS.
 *
 * dryRun behavior matches the rest of the transactional-email surface:
 * unless NEXUS_ENABLE_OUTBOUND_EMAILS=true, the call console-logs a
 * one-line summary and returns ok=true. That keeps Xavia's local-dev
 * + Railway-staging flows safe while the operator wires up the live
 * env vars.
 */

import crypto from 'crypto'
import prisma from '../db.js'
import { sendEmail } from './email/transport.js'

const DEFAULT_TTL_DAYS = 30

function ttlDays(): number {
  const n = Number(process.env.NEXUS_PO_ACK_TTL_DAYS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS
}

function ackBaseUrl(): string {
  return process.env.NEXUS_PUBLIC_WEB_URL?.trim().replace(/\/+$/, '') || 'http://localhost:3000'
}

/**
 * Generate a URL-safe random token. 32 bytes → ~43 base64url chars.
 * base64url avoids '+' / '/' / '=' so the token is safe in URLs without
 * encoding.
 */
function mintToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

interface SendOptions {
  /** Operator-facing knob to skip the actual email send (e.g. for a
   *  retry that only wants to mint a new token + ack URL). */
  skipEmail?: boolean
}

export interface PoSupplierEmailResult {
  ok: boolean
  token: string
  ackUrl: string
  emailDelivery: {
    sent: boolean
    dryRun: boolean
    error?: string
    skipped?: boolean
  }
}

/**
 * Mint a fresh ack token onto the PO + send the supplier email.
 * Designed to be called from po-workflow.service:transitionPo on
 * the APPROVED → SUBMITTED edge.
 *
 * Idempotency: re-running rotates the token (new URL) — that's
 * deliberate. PO.8 revisions rely on this to invalidate stale links.
 */
export async function sendPoToSupplier(
  poId: string,
  opts: SendOptions = {},
): Promise<PoSupplierEmailResult> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      supplier: true,
      items: { orderBy: [{ lineOrder: 'asc' }, { id: 'asc' }] },
      warehouse: true,
    },
  })
  if (!po) throw new Error(`PO not found: ${poId}`)

  // Mint a fresh token + expiry.
  const token = mintToken()
  const expiresAt = new Date(Date.now() + ttlDays() * 86400_000)
  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: {
      supplierAckToken: token,
      supplierAckExpiresAt: expiresAt,
    },
  })

  const ackUrl = `${ackBaseUrl()}/po/ack/${token}`

  if (opts.skipEmail) {
    return {
      ok: true,
      token,
      ackUrl,
      emailDelivery: { sent: false, dryRun: false, skipped: true },
    }
  }

  // No supplier email on file → token still minted (so the operator
  // can share the URL out-of-band), but no send.
  if (!po.supplier?.email) {
    return {
      ok: true,
      token,
      ackUrl,
      emailDelivery: {
        sent: false,
        dryRun: false,
        error: 'Supplier has no email on file; ack URL minted only',
      },
    }
  }

  // Brand context.
  const brand = (await prisma.brandSettings.findFirst()) ?? null
  const expectedDate = po.expectedDeliveryDate
    ? po.expectedDeliveryDate.toISOString().slice(0, 10)
    : '—'

  // PDF attachment is deferred — the supplier ack page (PO.9) and the
  // existing /factory.pdf endpoint cover the rendering paths. PO.12
  // (Italian fiscal block) revisits whether to inline the PDF here.

  const companyName = brand?.companyName || 'Nexus operations'
  const supplierName = po.supplier?.contactName || po.supplier?.name || 'there'

  const subject = `Purchase order ${po.poNumber} from ${companyName}`
  const html = renderEmailHtml({
    companyName,
    supplierName,
    poNumber: po.poNumber,
    totalLabel: formatTotal(po.totalCents, po.currencyCode),
    expectedDate,
    lineCount: po.items.length,
    ackUrl,
    expiresAt: expiresAt.toISOString().slice(0, 10),
    notes: po.notes,
  })
  const text = renderEmailText({
    companyName,
    supplierName,
    poNumber: po.poNumber,
    totalLabel: formatTotal(po.totalCents, po.currencyCode),
    expectedDate,
    lineCount: po.items.length,
    ackUrl,
    expiresAt: expiresAt.toISOString().slice(0, 10),
    notes: po.notes,
  })

  const send = await sendEmail({
    to: po.supplier.email,
    from: brand?.factoryEmailFrom ?? undefined,
    subject,
    html,
    text,
    tag: `po-send:${po.poNumber}`,
  })

  return {
    ok: send.ok,
    token,
    ackUrl,
    emailDelivery: {
      sent: send.ok && !send.dryRun,
      dryRun: send.dryRun,
      error: send.ok ? undefined : send.error,
    },
  }
}

function formatTotal(cents: number, code: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`
  }
}

interface EmailCtx {
  companyName: string
  supplierName: string
  poNumber: string
  totalLabel: string
  expectedDate: string
  lineCount: number
  ackUrl: string
  expiresAt: string
  notes: string | null
}

function renderEmailHtml(ctx: EmailCtx): string {
  const notesBlock = ctx.notes
    ? `<p style="margin: 16px 0; padding: 12px; background: #f9fafb; border-left: 3px solid #94a3b8; font-size: 14px; white-space: pre-wrap;">${escapeHtml(ctx.notes)}</p>`
    : ''
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; margin: 0 0 8px;">${escapeHtml(ctx.companyName)} — purchase order ${escapeHtml(ctx.poNumber)}</h1>
  <p>Hi ${escapeHtml(ctx.supplierName)},</p>
  <p>Please find attached purchase order <strong>${escapeHtml(ctx.poNumber)}</strong> for ${ctx.lineCount} ${ctx.lineCount === 1 ? 'line' : 'lines'}, total <strong>${escapeHtml(ctx.totalLabel)}</strong>, expected delivery <strong>${escapeHtml(ctx.expectedDate)}</strong>.</p>
  ${notesBlock}
  <p style="margin: 24px 0;">
    <a href="${ctx.ackUrl}" style="display: inline-block; background: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">Confirm or decline this PO →</a>
  </p>
  <p style="font-size: 13px; color: #64748b;">
    The confirmation link is valid until <strong>${escapeHtml(ctx.expiresAt)}</strong>. If you can't open the button, paste this URL into your browser:<br>
    <a href="${ctx.ackUrl}" style="color: #2563eb; word-break: break-all;">${ctx.ackUrl}</a>
  </p>
  <p style="font-size: 13px; color: #64748b; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
    Sent by ${escapeHtml(ctx.companyName)} via Nexus operations.
  </p>
</body></html>`
}

function renderEmailText(ctx: EmailCtx): string {
  const notesBlock = ctx.notes ? `\n\nNotes:\n${ctx.notes}\n` : ''
  return `${ctx.companyName} — purchase order ${ctx.poNumber}

Hi ${ctx.supplierName},

Please find attached purchase order ${ctx.poNumber} for ${ctx.lineCount} ${ctx.lineCount === 1 ? 'line' : 'lines'}, total ${ctx.totalLabel}, expected delivery ${ctx.expectedDate}.${notesBlock}

Confirm or decline this PO at:
${ctx.ackUrl}

The confirmation link is valid until ${ctx.expiresAt}.

— ${ctx.companyName} (via Nexus operations)
`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
