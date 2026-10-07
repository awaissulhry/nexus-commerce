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
  /** Optional extra SMTP headers. Used for RFC 8058 List-Unsubscribe
   *  + List-Unsubscribe-Post so Gmail/Apple Mail show the one-click
   *  Unsubscribe button. */
  headers?: Record<string, string>
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

/** Whether a value can go in an HTTP header as is: printable ASCII only (fetch refuses anything above 255). */
function isHeaderSafe(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value)
}

/**
 * Where each part of a message goes, and why none of it can break the request (2026-10-07):
 *   · the subject, the sender (with its display name), the recipients and the bodies go in the JSON BODY, the fields
 *     Resend expects (`subject`, `from`, `to`, `html`, `text`), as UTF-8: "…", "€", "à" arrive as written, and Resend
 *     encodes them for the mail itself;
 *   · the HTTP request headers carry only the API key and the content type. A header value must be a ByteString (no
 *     character above 255): fetch threw "Cannot convert argument to a ByteString because the character at index 10 has
 *     a value of 8230" for a shortened placeholder key "re_…" ("Bearer " is 7 characters, "re_" 3: index 10 is its
 *     "…"). The key is checked before the call (`isHeaderSafe`);
 *   · the message's own extra headers (`msg.headers`, e.g. List-Unsubscribe) go in the JSON body too, but Resend writes
 *     them into the mail as raw header lines, which must be ASCII (RFC 5322). `mailHeaderValue` encodes any other
 *     character per RFC 2047, so the meaning is kept whole.
 */

/** A header field name as RFC 5322 allows it: printable ASCII, no colon. */
function isHeaderName(name: string): boolean {
  return /^[\x21-\x39\x3b-\x7e]+$/.test(name)
}

/** One RFC 2047 encoded-word holds at most 75 characters: "=?UTF-8?B?" + base64 + "?=", so 45 bytes of text. */
const ENCODED_WORD_BYTES = 45

/**
 * A mail header value that a raw header line can carry. Printable ASCII (with spaces) is returned as it is. A value
 * with any other character (…, €, à) becomes RFC 2047 encoded-words (`=?UTF-8?B?…?=`, base64 of the UTF-8 bytes, a
 * character never split between two words, the words separated by a space, which a decoder drops), so every mail
 * client shows the value exactly as written. A line break would start a new header line: it is unfolded to one space.
 */
export function mailHeaderValue(value: string): string {
  const unfolded = value.replace(/[\t ]*(?:\r\n|\r|\n)[\t ]*/g, ' ')
  if (/^[\x20-\x7e\t]*$/.test(unfolded)) return unfolded
  const words: string[] = []
  let chunk = ''
  for (const ch of unfolded) {
    if (chunk && Buffer.byteLength(chunk + ch, 'utf8') > ENCODED_WORD_BYTES) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ')
}

/** The message's extra headers, ready for Resend; a name no header can have is a refusal (named), never dropped. */
function mailHeaders(headers: Record<string, string>): { headers: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!isHeaderName(name)) return { error: `the e-mail header name ${JSON.stringify(name)} is not a valid header name (printable ASCII, no colon)` }
    out[name] = mailHeaderValue(String(value ?? ''))
  }
  return { headers: out }
}

/** The sender when a message names none (Xavia's; every other business names its own, O3). */
export function defaultFrom(): string {
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

  // Surrounding whitespace (a trailing newline from a paste) is trimmed, as fetch itself trims a header value.
  const apiKey = process.env.RESEND_API_KEY?.trim()
  if (!apiKey) {
    return {
      ok: false,
      provider: 'resend',
      dryRun: false,
      error: 'RESEND_API_KEY not set',
    }
  }
  // A key that cannot go in an HTTP header (a pasted, shortened placeholder) made fetch throw "Cannot convert
  // argument to a ByteString" on every send. Say what is wrong instead; never echo the key.
  if (!isHeaderSafe(apiKey)) {
    return {
      ok: false,
      provider: 'resend',
      dryRun: false,
      error: 'RESEND_API_KEY is not a real key: it holds characters an API key never has (a shortened placeholder?) — paste the full key from Resend',
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
  // RV.9.5 — Resend forwards `headers` as raw SMTP headers, which is
  // how List-Unsubscribe + List-Unsubscribe-Post get to the inbox. Raw header lines are ASCII: see `mailHeaderValue`.
  if (msg.headers && Object.keys(msg.headers).length > 0) {
    const safe = mailHeaders(msg.headers)
    // (`in`, not a flag: this tsconfig is not strict, so a literal `ok` would not narrow.)
    if ('error' in safe) return { ok: false, provider: 'resend', dryRun: false, error: safe.error }
    payload.headers = safe.headers
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

export const __test = { isReal, defaultFrom, encodeAttachment, isHeaderName, mailHeaders }
