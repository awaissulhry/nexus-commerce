/**
 * PO-Plus.2 — Approver email + ack URL minting.
 *
 * When `transitionPo('submit-for-review')` lands on REVIEW because
 * `totalCents > BrandSettings.poApprovalThresholdCents`, this service:
 *
 *   1. Mints a fresh URL-safe `approverAckToken` (rotates on every
 *      submit-for-review so a stale email can't be replayed).
 *   2. Writes the token + `approverAckExpiresAt` (default 14d via
 *      NEXUS_PO_APPROVER_ACK_TTL_DAYS — shorter than the 30d supplier
 *      ack window since approvals shouldn't sit indefinitely).
 *   3. Emails the configured `BrandSettings.poApprovalApproverEmail`
 *      with a summary + the public approve URL.
 *
 * dryRun behavior matches the rest of the transactional-email surface
 * (NEXUS_ENABLE_OUTBOUND_EMAILS guard from services/email/transport).
 * Without the gate the call logs + returns ok=true so local dev
 * doesn't blast real inboxes.
 */

import crypto from 'crypto'
import prisma from '../db.js'
import { sendEmail } from './email/transport.js'

const DEFAULT_TTL_DAYS = 14

function ttlDays(): number {
  const n = Number(process.env.NEXUS_PO_APPROVER_ACK_TTL_DAYS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS
}

function ackBaseUrl(): string {
  return (
    process.env.NEXUS_PUBLIC_WEB_URL?.trim().replace(/\/+$/, '') ||
    'http://localhost:3000'
  )
}

function mintToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export interface PoApproverEmailResult {
  ok: boolean
  token: string
  approveUrl: string
  emailDelivery: {
    sent: boolean
    dryRun: boolean
    error?: string
    skipped?: boolean
  }
}

interface SendOptions {
  /** Operator-facing knob to skip the actual send (re-mint a token
   *  without re-emailing). */
  skipEmail?: boolean
}

export async function notifyApprover(
  poId: string,
  opts: SendOptions = {},
): Promise<PoApproverEmailResult> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      supplier: { select: { name: true } },
      items: { select: { sku: true, quantityOrdered: true } },
    },
  })
  if (!po) throw new Error(`PO not found: ${poId}`)

  const brand = await prisma.brandSettings.findFirst({
    select: {
      companyName: true,
      poApprovalApproverEmail: true,
      poApprovalThresholdCents: true,
      factoryEmailFrom: true,
    },
  })

  const token = mintToken()
  const expiresAt = new Date(Date.now() + ttlDays() * 86400_000)
  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: {
      approverAckToken: token,
      approverAckExpiresAt: expiresAt,
    },
  })
  const approveUrl = `${ackBaseUrl()}/po/approve/${token}`

  if (opts.skipEmail) {
    return {
      ok: true,
      token,
      approveUrl,
      emailDelivery: { sent: false, dryRun: false, skipped: true },
    }
  }

  if (!brand?.poApprovalApproverEmail) {
    return {
      ok: true,
      token,
      approveUrl,
      emailDelivery: {
        sent: false,
        dryRun: false,
        error: 'No approver email configured; URL minted only',
      },
    }
  }

  const companyName = brand.companyName || 'Nexus operations'
  const totalLabel = formatTotal(po.totalCents, po.currencyCode)
  const supplierName = po.supplier?.name ?? 'unassigned supplier'
  const thresholdLabel =
    brand.poApprovalThresholdCents != null
      ? formatTotal(brand.poApprovalThresholdCents, po.currencyCode)
      : null
  const lineCount = po.items.length
  const totalUnits = po.items.reduce((s, i) => s + i.quantityOrdered, 0)

  const subject = `Approval needed: ${po.poNumber} (${totalLabel})`
  const html = renderHtml({
    companyName,
    poNumber: po.poNumber,
    supplierName,
    totalLabel,
    lineCount,
    totalUnits,
    thresholdLabel,
    approveUrl,
    expiresAt: expiresAt.toISOString().slice(0, 10),
  })
  const text = renderText({
    companyName,
    poNumber: po.poNumber,
    supplierName,
    totalLabel,
    lineCount,
    totalUnits,
    thresholdLabel,
    approveUrl,
    expiresAt: expiresAt.toISOString().slice(0, 10),
  })

  const send = await sendEmail({
    to: brand.poApprovalApproverEmail,
    from: brand.factoryEmailFrom ?? undefined,
    subject,
    html,
    text,
    tag: `po-approve:${po.poNumber}`,
  })

  return {
    ok: send.ok,
    token,
    approveUrl,
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

interface Ctx {
  companyName: string
  poNumber: string
  supplierName: string
  totalLabel: string
  lineCount: number
  totalUnits: number
  thresholdLabel: string | null
  approveUrl: string
  expiresAt: string
}

function renderHtml(ctx: Ctx): string {
  const thresholdLine = ctx.thresholdLabel
    ? `<p style="font-size: 14px; color: #64748b;">Exceeds the configured approval threshold of <strong>${escapeHtml(ctx.thresholdLabel)}</strong>.</p>`
    : ''
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; margin: 0 0 8px;">Approval needed: ${escapeHtml(ctx.poNumber)}</h1>
  <p>${escapeHtml(ctx.companyName)} has a purchase order awaiting your approval.</p>
  <table style="border-collapse: collapse; margin: 16px 0; font-size: 14px;">
    <tr><td style="padding: 4px 12px 4px 0; color: #64748b;">Supplier</td><td style="padding: 4px 0;">${escapeHtml(ctx.supplierName)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #64748b;">Total</td><td style="padding: 4px 0;"><strong>${escapeHtml(ctx.totalLabel)}</strong></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #64748b;">Lines</td><td style="padding: 4px 0;">${ctx.lineCount} (${ctx.totalUnits} units)</td></tr>
  </table>
  ${thresholdLine}
  <p style="margin: 24px 0;">
    <a href="${ctx.approveUrl}" style="display: inline-block; background: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">Review and approve →</a>
  </p>
  <p style="font-size: 13px; color: #64748b;">
    The link is valid until <strong>${escapeHtml(ctx.expiresAt)}</strong>. If the button doesn't open, paste this URL into your browser:<br>
    <a href="${ctx.approveUrl}" style="color: #2563eb; word-break: break-all;">${ctx.approveUrl}</a>
  </p>
  <p style="font-size: 13px; color: #64748b; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
    Sent by ${escapeHtml(ctx.companyName)} via Nexus operations.
  </p>
</body></html>`
}

function renderText(ctx: Ctx): string {
  const thresholdLine = ctx.thresholdLabel
    ? `\nExceeds the configured approval threshold of ${ctx.thresholdLabel}.\n`
    : ''
  return `Approval needed: ${ctx.poNumber}

${ctx.companyName} has a purchase order awaiting your approval.

  Supplier: ${ctx.supplierName}
  Total:    ${ctx.totalLabel}
  Lines:    ${ctx.lineCount} (${ctx.totalUnits} units)
${thresholdLine}
Review and approve at:
${ctx.approveUrl}

The link is valid until ${ctx.expiresAt}.

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
