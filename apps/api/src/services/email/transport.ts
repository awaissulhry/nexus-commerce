/**
 * TECH_DEBT #51 — shared transactional email transport.
 *
 * Until this commit, two services duplicated the Resend HTTP shape +
 * dryRun gate + env-var lookups: `services/email/index.ts` (O.30
 * shipment emails) and `services/return-comms/return-emails.service.ts`
 * (R6.3 return-event emails). The duplication was small enough to
 * tolerate at two callsites but blocked any third caller (alert
 * notifications, H.17 supplier discrepancy reports) from picking a
 * single implementation to follow.
 *
 * `sendEmail()` is the one provider-touching function. Template
 * services (O.30, R6.3, future ones) keep their own `render()` and
 * call `sendEmail()` to do the actual delivery.
 *
 * dryRun rule (unchanged): unless `NEXUS_ENABLE_OUTBOUND_EMAILS=true`
 * the call returns `{ok: true, dryRun: true, provider: 'mock'}` and
 * console-logs a one-line summary. This matches the safety pattern
 * the rest of Wave 7+ uses for outbound side effects (Sendcloud,
 * tracking emails, refund publishes).
 *
 * Provider: Resend by default. The shape is generic enough that
 * swapping to Postmark / SES later is a single function rewrite —
 * the same property the original O.30 service held.
 */

export interface EmailAttachment {
  filename: string
  content: Buffer | string
  contentType?: string
}

export interface EmailMessage {
  to: string | string[]
  subject: string
  html: string
  /** Optional plain-text alternative. Resend renders both when present. */
  text?: string
  /** Sender override; defaults to NEXUS_EMAIL_FROM. */
  from?: string
  attachments?: EmailAttachment[]
  /** Identifier surfaced in dryRun logs (e.g. 'shipment-shipped',
   *  'return-received', 'alert-critical'). Aids debugging when
   *  outbound is disabled. */
  tag?: string
}

export interface SendResult {
  ok: boolean
  provider: 'resend' | 'mock'
  messageId?: string
  error?: string
  dryRun: boolean
}

function isReal(): boolean {
  return process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true'
}

function defaultFrom(): string {
  return process.env.NEXUS_EMAIL_FROM ?? 'Xavia <ship@xavia.it>'
}

function encodeAttachment(att: EmailAttachment): {
  filename: string
  content: string
  content_type?: string
} {
  const buf = Buffer.isBuffer(att.content)
    ? att.content
    : Buffer.from(att.content, 'utf8')
  return {
    filename: att.filename,
    content: buf.toString('base64'),
    content_type: att.contentType,
  }
}

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const from = msg.from ?? defaultFrom()
  const to = Array.isArray(msg.to) ? msg.to : [msg.to]

  if (!isReal()) {
    const tag = msg.tag ?? 'untagged'
    // eslint-disable-next-line no-console
    console.log(`[email:dry-run] ${tag} → ${to.join(', ')} | "${msg.subject}"`)
    return { ok: true, provider: 'mock', dryRun: true, messageId: `mock-${Date.now()}` }
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      provider: 'resend',
      dryRun: false,
      error: 'RESEND_API_KEY not set',
    }
  }

  const payload: Record<string, unknown> = {
    from,
    to,
    subject: msg.subject,
    html: msg.html,
  }
  if (msg.text) payload.text = msg.text
  if (msg.attachments?.length) {
    payload.attachments = msg.attachments.map(encodeAttachment)
  }

  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    return {
      ok: false,
      provider: 'resend',
      dryRun: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const body: any = await res.json().catch(() => null)
  if (!res.ok) {
    return {
      ok: false,
      provider: 'resend',
      dryRun: false,
      error: body?.message ?? `HTTP ${res.status}`,
    }
  }
  return {
    ok: true,
    provider: 'resend',
    dryRun: false,
    messageId: body?.id,
  }
}

export const __test = { isReal, defaultFrom, encodeAttachment }
