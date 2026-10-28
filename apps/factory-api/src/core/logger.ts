import type { FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify'

/**
 * The redacting logger (plan A1 §5.4, §5.5): structured JSON lines (Fastify's pino) in which a secret never appears.
 *
 *   - Every object logged is copied with the value of a secret key replaced by REDACTED, at any depth: passwords,
 *     PINs, one-time codes, tokens, cookies, authorization headers, API keys, signatures, hashes of secrets, bank
 *     details, and the money fields the roles step marks with a grain (cost, margin, price, amount, total, wages).
 *   - A request is logged by its method, its route pattern (`/l/:token`, never the token itself) and its id; headers,
 *     cookies, query strings and bodies are not logged at all.
 *   - Errors are logged with type, code, message and stack (server side only; the answer never carries them).
 * Never put a secret in the message text itself: only objects are redacted.
 */

export const REDACTED = '[redacted]'

/** A key whose value is never logged, compared word by word (`resetToken` → reset, token). */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'token',
  'tokens',
  'authorization',
  'auth',
  'cookie',
  'cookies',
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
  'recovery',
  'csrf',
  'jwt',
  'bearer',
  // `…Enc`: an encrypted credential (A1 §2.3 secretEnc, credentialsEnc).
  'enc',
  // Money fields with a grain (A1 §2.6): hidden from logs as they are from callers without the grain.
  'cost',
  'costs',
  'margin',
  'margins',
  'price',
  'prices',
  'amount',
  'amounts',
  'total',
  'totals',
  'wage',
  'wages',
  'salary',
])
/** Keys secret as a whole, whatever their words. */
const SECRET_KEYS = new Set(['apikey', 'privatekey', 'accesskey', 'setcookie', 'xapikey', 'sessionkey'])

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** True when the value under this key must not be logged. */
export function isSecretKey(key: string, extra: ReadonlySet<string> = new Set()): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (SECRET_KEYS.has(compact) || extra.has(compact)) return true
  const parts = words(key)
  return parts.some((part) => SECRET_WORDS.has(part) || extra.has(part))
}

const MAX_DEPTH = 8
const MAX_ENTRIES = 200

/**
 * A copy of `value` with every secret key's value replaced by REDACTED, at any depth and whatever the object's
 * prototype (route params, Node headers and class instances are objects too). A value with `toJSON` (a Date, a
 * decimal) is redacted in its JSON form; a nested Error becomes its type and message; binary data is not logged.
 */
export function redact(value: unknown, extra: ReadonlySet<string> = new Set(), depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  // A nested error keeps its type and message; its other fields (a driver's `detail`, `query` …) are not logged.
  if (value instanceof Error) return { type: value.name, message: value.message }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]'
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[too deep]'
  const json = (value as { toJSON?: unknown }).toJSON
  if (typeof json === 'function') return redact(json.call(value), extra, depth, seen)
  seen.add(value)
  try {
    if (value instanceof Map) return redact(Object.fromEntries(value), extra, depth, seen)
    if (value instanceof Set || Array.isArray(value)) {
      return [...value].slice(0, MAX_ENTRIES).map((item) => redact(item, extra, depth + 1, seen))
    }
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
      copy[key] = isSecretKey(key, extra) ? REDACTED : redact(item, extra, depth + 1, seen)
    }
    return copy
  } finally {
    seen.delete(value)
  }
}

/** The log line's own fields: `req`, `res` and `err` go to their serializers, everything else is redacted. */
function redactLine(line: Record<string, unknown>, extra: ReadonlySet<string>): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(line)) {
    copy[key] = key === 'req' || key === 'res' || key === 'err' ? item : isSecretKey(key, extra) ? REDACTED : redact(item, extra, 1)
  }
  return copy
}

/** A path segment that looks like a token or an id is not logged (an unmatched URL has no route pattern). */
function maskPath(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? ''
  return path
    .split('/')
    .map((segment) => (segment.length >= 16 && /^[A-Za-z0-9_.~%-]+$/.test(segment) ? ':masked' : segment))
    .join('/')
}

function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    id: request.id,
    method: request.method,
    route: request.routeOptions?.url ?? null,
    ...(request.routeOptions?.url ? {} : { path: maskPath(request.url) }),
  }
}

function serializeReply(reply: FastifyReply): Record<string, unknown> {
  return { statusCode: reply.statusCode }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  const { code, statusCode } = error as Error & { code?: unknown; statusCode?: unknown }
  return {
    type: error.name,
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    stack: error.stack,
  }
}

export interface LoggerSettings {
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  /** Where the lines go (tests); default standard output. */
  readonly stream?: { write(line: string): void }
  /** More secret words or whole keys (compared in lower case, without separators). */
  readonly secretKeys?: readonly string[]
}

/** The `logger` option for Fastify. */
export function loggerOptions(settings: LoggerSettings): NonNullable<FastifyServerOptions['logger']> {
  const extra = new Set((settings.secretKeys ?? []).map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '')))
  return {
    level: settings.level,
    ...(settings.stream ? { stream: settings.stream } : {}),
    serializers: { req: serializeRequest, res: serializeReply, err: serializeError },
    formatters: {
      log: (object: Record<string, unknown>) => redactLine(object, extra),
    },
    // A second net for the usual places, in case a serializer above is replaced.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: REDACTED },
  } as NonNullable<FastifyServerOptions['logger']>
}
