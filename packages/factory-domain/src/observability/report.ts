/**
 * Error tracking with redaction (PLT-218; B-W2a-42), the part the API and the web share: what an error report may
 * hold, and the filter every report passes before any sink sees it. Pure TypeScript, no I/O.
 *
 * An error report is for finding a bug, never for reading the business: it carries
 *   - the error's name, code, message and stack frames (and up to three causes), each SCRUBBED;
 *   - an allow-listed context (CONTEXT_KEYS: the route pattern, the method and status, the request id, the audience,
 *     the tenant, the job, queue or cron, the page path with its ids replaced, the release); every other key is
 *     dropped, so a new field never reaches a sink by accident.
 * It never carries a person (no user, worker or device id, no name field, no e-mail, phone, tax id or IBAN), a secret
 * (passwords, PINs, tokens, cookies, keys, signatures, long hex or base64 runs, device and session tokens, query
 * strings) or money (amounts with a currency, values under price/cost/margin/amount/total/wage keys). Free text is
 * scrubbed by pattern: quoted literals that are not code-like words become `[text]`, file paths lose the folders above
 * the repository (a home folder names its owner). What a pattern cannot know (a bare first name typed into a free-text
 * error message) is kept out by the rule that only UNEXPECTED errors are reported: their messages come from code
 * (TypeError, a database or network error), never from a person's input; domain refusals (4xx) are never reported.
 */

export const REPORT_SOURCES = ['api', 'worker', 'scheduler', 'web', 'floor'] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

/** The only context keys a report keeps; values are scrubbed strings, small whole numbers or booleans. */
export const CONTEXT_KEYS = [
  'route',
  'method',
  'statusCode',
  'requestId',
  'audience',
  'tenantId',
  'job',
  'queue',
  'cron',
  'handler',
  'eventType',
  'attempt',
  'final',
  'path',
  'release',
  'environment',
  'component',
] as const
export type ContextKey = (typeof CONTEXT_KEYS)[number]
export type ReportContext = Partial<Record<ContextKey, string | number | boolean | null | undefined>>

/** Keys whose number is kept (a status code, an attempt); any other number in the context is dropped. */
const NUMERIC_KEYS: ReadonlySet<string> = new Set(['statusCode', 'attempt'])

export interface ReportCause {
  readonly name: string
  readonly message: string
}

export interface ErrorReport {
  readonly id: string
  /** ISO time the report was made. */
  readonly at: string
  readonly source: ReportSource
  readonly name: string
  /** A stable code when the error had one (`P2002`, `ECONNREFUSED`, `not_ready`). */
  readonly code: string | null
  readonly message: string
  /** At most STACK_FRAMES frames, scrubbed. */
  readonly stack: readonly string[]
  readonly causes: readonly ReportCause[]
  readonly context: Readonly<Record<string, string | number | boolean | null>>
}

export const LIMITS = Object.freeze({ message: 500, frame: 300, contextValue: 200, stackFrames: 30, causes: 3 })

const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'token',
  'authorization',
  'auth',
  'cookie',
  'pin',
  'otp',
  'totp',
  'mfa',
  'credential',
  'credentials',
  'signature',
  'hash',
  'salt',
  'iban',
  'csrf',
  'jwt',
  'bearer',
  'key',
  'apikey',
  'session',
  'code',
])
const MONEY_WORDS = new Set(['cost', 'costs', 'margin', 'margins', 'price', 'prices', 'amount', 'amounts', 'total', 'totals', 'wage', 'wages', 'salary', 'value', 'net', 'gross', 'vat'])
const PERSON_WORDS = new Set(['email', 'mail', 'phone', 'mobile', 'name', 'surname', 'firstname', 'lastname', 'address', 'street', 'fiscal', 'taxcode', 'vatnumber', 'birth', 'badge'])

/** The words of a key (`resetToken` → reset, token; `unit_price` → unit, price). */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** True when a value under this key never reaches a report: a secret, money or a person. */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key)
  const compact = words.join('')
  if (PERSON_WORDS.has(compact) || SECRET_WORDS.has(compact)) return true
  return words.some((word) => SECRET_WORDS.has(word) || MONEY_WORDS.has(word) || PERSON_WORDS.has(word))
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const SENSITIVE_KEY_SOURCE = '[A-Za-z_][A-Za-z0-9_]*'

/**
 * A long run that looks like a key or a secret, not like a path: some part of it (between slashes) of 16 characters
 * or more mixes digits, capitals and small letters (base64), or it has no slash and mixes digits and letters.
 */
function secretLike(run: string): boolean {
  const mixed = (part: string) => /\d/.test(part) && /[A-Z]/.test(part) && /[a-z]/.test(part)
  if (!run.includes('/')) return /\d/.test(run) && /[A-Za-z]/.test(run) && (mixed(run) || /^[A-Za-z0-9_-]+$/.test(run))
  return run.split('/').some((part) => part.length >= 16 && mixed(part))
}

/** The scrubbing rules, in order: the first ones take whole tokens out before the general ones run. */
const RULES: ReadonlyArray<readonly [RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // A floor token or code: <tenant>.<site>.<id>.<secret> (platform/auth/floor tokens).
  [/\b[0-9a-f]{8}-[0-9a-f-]{27}\.[0-9a-f]{8}-[0-9a-f-]{27}\.[0-9a-f]{8}-[0-9a-f-]{27}\.[A-Za-z0-9_-]+/gi, '[token]'],
  // JWT-like (three base64url parts).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[token]'],
  // Record ids: a user's or a worker's id is personal data too.
  [UUID, '[id]'],
  // Authorization / cookie headers written out.
  [/\b(authorization|cookie|set-cookie|x-csrf-token|x-factory-link)\s*[:=]\s*[^\n,;]+/gi, (_match, name: string) => `${name}: [redacted]`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  // A URL's query string and fragment (tokens, codes, search words).
  [/(https?:\/\/[^\s"'`?#]+|\/[A-Za-z0-9_./:-]*)[?#][^\s"'`)]*/g, (_match, base: string) => `${base}?[redacted]`],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // IBAN (with or without spaces).
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, '[iban]'],
  // Italian codice fiscale.
  [/\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/gi, '[tax-id]'],
  // VAT numbers: IT + 11 digits (and other EU prefixes with 8-12 digits).
  [/\b(?:IT|DE|FR|ES|AT|NL|BE|PT|PL|RO|HU|CZ|SK|SI|HR|GR|EL|IE|LU|MT|CY|BG|DK|SE|FI|EE|LV|LT)\d{8,12}\b/g, '[tax-id]'],
  // Money with a currency sign or code: € 1.234,56 · 12.50 EUR · EUR 12.
  [/(?:€|EUR|USD|GBP|CHF|\$|£)\s?-?\d[\d.,']*|-?\d[\d.,']*\s?(?:€|EUR|USD|GBP|CHF)\b/g, '[money]'],
  // PostgreSQL's detail: Key ("code")=(ABC-1) already exists.
  [/=\(([^)]*)\)/g, '=([value])'],
  // Long hex and base64 runs (hashes, keys, secrets), and long digit runs (cards, phone numbers, account numbers).
  [/\b[0-9a-f]{32,}\b/gi, '[secret]'],
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, (match) => (secretLike(match) ? '[secret]' : match)],
  [/\+?\d[\d ().-]{8,}\d/g, (match) => (/^\d{4}-\d{2}-\d{2}/.test(match) ? match : '[number]')],
]

/** A quoted literal that is code-like (an identifier, a model or column name, a path piece) stays; anything else goes. */
const CODE_WORD = /^[A-Za-z_$][A-Za-z0-9_$.:/()-]{0,63}$/
function scrubQuoted(text: string): string {
  return text.replace(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g, (match, double?: string, single?: string, back?: string) => {
    const inner = double ?? single ?? back ?? ''
    if (inner === '' || CODE_WORD.test(inner) || /^\[[a-z-]+\]$/.test(inner)) return match
    const quote = match[0]
    return `${quote}[text]${quote}`
  })
}

/** Where a path inside the repository starts (`…/apps/…`): the folders above it are cut. */
const REPOSITORY_PARTS = ['/apps/', '/packages/', '/node_modules/', '/scripts/', '/.next/']
const PATH = /(?:file:\/\/)?(?:[A-Za-z]:)?(?:[\\/][^\\/\s():'"`,]+){2,}/g

/** A file path without the folders above the repository (a home folder names its owner): `…/apps/…`, else `/~/…`. */
function scrubPaths(text: string): string {
  return text.replace(PATH, (match) => {
    const path = match.replace(/^file:\/\//, '').replace(/\\/g, '/')
    const cut = REPOSITORY_PARTS.map((part) => path.indexOf(part)).filter((index) => index >= 0)
    if (cut.length > 0) return `…${path.slice(Math.min(...cut))}`
    return path.replace(/^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+/i, '/~')
  })
}

/** `key: value`, `key=value`, `"key": value`: the value goes when the key names a secret, money or a person. */
const PAIR = new RegExp(`(["'\`]?)(${SENSITIVE_KEY_SOURCE})\\1\\s*[:=]\\s*`, 'g')
const VALUE = /^(?:new [A-Za-z.]+\([^)]*\)|"[^"]*"|'[^']*'|`[^`]*`|[^\s,;)}\]]+)/

function redactPairs(text: string): string {
  let out = ''
  let from = 0
  for (const match of text.matchAll(PAIR)) {
    const start = match.index ?? 0
    if (start < from) continue
    const key = match[2] ?? ''
    if (!isSensitiveKey(key)) continue
    const valueAt = start + match[0].length
    const value = VALUE.exec(text.slice(valueAt))?.[0] ?? ''
    if (value === '' || value === '[redacted]') continue
    out += `${text.slice(from, valueAt)}[redacted]`
    from = valueAt + value.length
  }
  return out + text.slice(from)
}

/** Every rule on a piece of free text, then the length limit. */
export function scrubText(text: string, limit: number = LIMITS.message): string {
  let out = scrubPaths(String(text))
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as never)
  out = redactPairs(out)
  out = scrubQuoted(out)
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out
}

/** A page path with its record ids and numbers replaced (`/w/<id>/sales/orders/<id>?tab=x` → `/w/:id/sales/orders/:id`). */
export function scrubPath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? ''
  return bare
    .replace(UUID, ':id')
    .split('/')
    .map((part) => (/\d/.test(part) && part !== ':id' ? ':n' : part))
    .join('/')
    .slice(0, LIMITS.contextValue)
}

/** The allow-listed context, scrubbed. A number is kept only under a numeric key; an id-like value only as tenant or request. */
export function scrubContext(context: ReportContext | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (!context) return out
  for (const key of CONTEXT_KEYS) {
    const value = context[key]
    if (value === undefined) continue
    if (value === null || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number') {
      if (NUMERIC_KEYS.has(key) && Number.isSafeInteger(value) && value >= 0 && value < 100_000) out[key] = value
    } else if (key === 'path' || key === 'route') out[key] = scrubPath(value)
    else if (key === 'tenantId' || key === 'requestId') out[key] = /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : '[redacted]'
    else out[key] = scrubText(value, LIMITS.contextValue)
  }
  return out
}

const CODE_OF = /^(?:[A-Z][A-Z0-9_]{1,39}|[a-z][a-z0-9_]{1,39}|P\d{4})$/

function codeOf(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && CODE_OF.test(code) ? code : null
}

function nameOf(error: unknown): string {
  if (error instanceof Error) return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error'
  return typeof error === 'string' ? 'Thrown' : 'NonError'
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return scrubText(error.message)
  if (typeof error === 'string') return scrubText(error)
  // Never JSON a thrown object: its fields would come along.
  return 'A value that is not an Error was thrown.'
}

function framesOf(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return []
  return error.stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') || /^[\w$.<>]*@/.test(line))
    .slice(0, LIMITS.stackFrames)
    .map((line) => scrubText(line, LIMITS.frame))
}

function causesOf(error: unknown): ReportCause[] {
  const causes: ReportCause[] = []
  let current: unknown = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  while (current !== undefined && current !== null && causes.length < LIMITS.causes) {
    causes.push({ name: nameOf(current), message: messageOf(current) })
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined
  }
  return causes
}

/** The report of one error: scrubbed, allow-listed, bounded. Never throws. */
export function errorReportOf(error: unknown, input: { id: string; at: string; source: ReportSource; context?: ReportContext }): ErrorReport {
  try {
    return {
      id: input.id,
      at: input.at,
      source: input.source,
      name: nameOf(error),
      code: codeOf(error),
      message: messageOf(error),
      stack: framesOf(error),
      causes: causesOf(error),
      context: scrubContext(input.context),
    }
  } catch {
    return { id: input.id, at: input.at, source: input.source, name: 'Error', code: null, message: 'The error could not be described.', stack: [], causes: [], context: {} }
  }
}
