/**
 * MCP full control P4–P6 — what a platform read may hand Claude, in one place.
 *
 * The platform reads (accounts, team, audit trail, sync activity, …) sit next to the things that are never for Claude
 * (09 §2): channel tokens, app secrets, passwords, API keys, and people's personal data. The rows these reads come
 * from are not all built for a model: a connection event's `detail`, an audit row's `before`/`after`, an API error
 * message can carry a key name like `refreshToken` or, worse, a token itself. Every such free-form value passes
 * through here before it is returned:
 *
 *   · a key that names a secret (token, secret, password, hash, credential, API key, one-time code, recovery code)
 *     keeps its name and loses its value;
 *   · a key that names personal contact data (e-mail, phone, street address, post code) loses its value;
 *   · a string that LOOKS like a credential (an eBay user token, an Amazon LWA token, a Shopify admin token, a JWT,
 *     a bearer header) is replaced wherever it appears, under any key;
 *   · an e-mail address anywhere is masked to its first letter and domain;
 *   · strings are clipped and nesting is capped, so a large blob cannot flood the conversation.
 *
 * Money is not handled here: the door (call-tool.ts `visibleTo`) strips every money key, at any depth, for a person
 * who may not see it — inside these values too.
 */

export const HIDDEN = '[hidden]'

/** Key names whose values are secrets. Matched anywhere in the key, case-insensitive. */
const SECRET_KEY = /token|secret|password|passwd|hash|credential|api_?key|apikey|otp|recovery|signature|private_?key|client_?secret|cookie|session_?id|authorization/i

/** Key names whose values are a person's contact data. */
const PERSONAL_KEY = /e-?mail|phone|mobile|address|street|postcode|postal|zip|^ip$|ipAddress|userAgent/i

/**
 * Strings that are credentials whatever key they sit under: eBay user tokens (v^1.1#…), Amazon LWA access and
 * refresh tokens (Atza|…, Atzr|…), Shopify admin and storefront tokens (shpat_…, shpca_…, shpss_…), JSON web tokens,
 * and "Bearer …" headers.
 */
const CREDENTIAL_TEXT = /(v\^1\.1#[^\s"',;]+|Atz[ar]\|[^\s"',;]+|shp(?:at|ca|ss|pa)_[0-9a-fA-F]+|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|[Bb]earer\s+\S+)/g

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g

/** A text as Claude may read it: credentials removed, e-mail addresses masked, at most `cap` characters. */
export function safeText(text: string, cap = 300): string {
  const cleaned = text.replace(CREDENTIAL_TEXT, HIDDEN).replace(EMAIL, '$1***@$2')
  return cleaned.length > cap ? `${cleaned.slice(0, cap - 1)}…` : cleaned
}

/** The same, for a value that may be null. */
export const safeTextOrNull = (text: string | null | undefined, cap = 300): string | null => (text == null ? null : safeText(text, cap))

const MAX_DEPTH = 6
const MAX_KEYS = 40
const MAX_ITEMS = 20

/**
 * A free-form JSON value (an event detail, an audit diff) as Claude may read it: secret and personal keys hidden,
 * credential-looking strings removed, e-mails masked, strings clipped, at most MAX_KEYS keys per object and
 * MAX_ITEMS items per list (with a note of what was left out), nesting cut at MAX_DEPTH.
 */
export function safeValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return safeText(value, 200)
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_DEPTH) return '…'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => safeValue(item, depth + 1))
    return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items
  }
  if (typeof value === 'object') {
    // A Prisma Decimal or other class instance: its text.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return safeText(String(value), 200)
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, item] of entries.slice(0, MAX_KEYS)) {
      out[key] = SECRET_KEY.test(key) || PERSONAL_KEY.test(key) ? (item == null ? item : HIDDEN) : safeValue(item, depth + 1)
    }
    if (entries.length > MAX_KEYS) out['…'] = `${entries.length - MAX_KEYS} more keys`
    return out
  }
  return safeText(String(value), 200)
}

/** A person as Claude names them: their display name, never their e-mail. */
export const personName = (displayName: string | null | undefined): string => displayName?.trim() || 'a team member'

/** At most `cap` items, and how many were left out. */
export function capped<T>(items: readonly T[], cap = 10): { items: T[]; more: number } {
  return { items: items.slice(0, cap), more: Math.max(0, items.length - cap) }
}
