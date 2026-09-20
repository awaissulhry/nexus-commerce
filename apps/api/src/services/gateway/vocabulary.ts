/**
 * P1.1 (docs/channel-connections/FINAL-PLAN.md, section 5 item 1, step 8) — the ONE error vocabulary for
 * every channel call. Before this there were six (the ledger's errorType, the CX ErrorClass, eBay
 * Marketing's EbayErrorKind, classifyEbayFailure, SyncErrorType, PublishOutcome) and none was shared.
 *
 * `classifyChannelAnswer` reads a non-2xx (or a 2xx that carries errors) and returns the class, whether
 * a retry can help, and the channel's own code and words. P3.1 extends the per-channel tables; the
 * classes themselves are the contract other packages build on.
 */

export type GatewayErrorClass =
  | 'auth_revoked'
  | 'auth_expired'
  | 'forbidden'
  | 'signature'
  | 'configuration'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'transient'
  | 'network'
  | 'timeout'
  | 'unknown'

export const GATEWAY_ERROR_CLASSES: readonly GatewayErrorClass[] = [
  'auth_revoked', 'auth_expired', 'forbidden', 'signature', 'configuration', 'validation', 'not_found',
  'conflict', 'rate_limited', 'transient', 'network', 'timeout', 'unknown',
]

const RETRYABLE = new Set<GatewayErrorClass>(['rate_limited', 'transient', 'network', 'timeout'])
export const isRetryableClass = (cls: GatewayErrorClass): boolean => RETRYABLE.has(cls)

export type GatewayChannel = 'EBAY' | 'AMAZON_SP' | 'SHOPIFY' | 'AMAZON_ADS' | 'ETSY'

export interface ChannelVerdict {
  errorClass: GatewayErrorClass
  retryable: boolean
  /** The channel's own error code (eBay errorId, Amazon code, Shopify extension code…). */
  channelCode: string | null
  /** The channel's own words, capped at 500 characters. */
  channelMessage: string | null
}

const cap = (text: unknown): string | null => {
  if (text === null || text === undefined) return null
  const s = String(text).trim()
  return s ? (s.length > 500 ? `${s.slice(0, 499)}…` : s) : null
}

function parseJson(text: string): any {
  try { return JSON.parse(text) } catch { return null }
}

/** By HTTP status alone, when the body says nothing more precise. */
function byStatus(status: number): GatewayErrorClass {
  if (status === 401) return 'auth_expired'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409 || status === 412) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 408) return 'timeout'
  if (status === 400 || status === 422) return 'validation'
  if (status >= 500) return 'transient'
  return 'unknown'
}

function verdict(errorClass: GatewayErrorClass, channelCode: unknown, channelMessage: unknown): ChannelVerdict {
  return { errorClass, retryable: isRetryableClass(errorClass), channelCode: channelCode == null ? null : String(channelCode), channelMessage: cap(channelMessage) }
}

/** eBay Trading (XML) error codes with a class of their own; any other Trading failure is validation. */
const TRADING_CODES: Record<string, GatewayErrorClass> = {
  '931': 'auth_revoked', '17470': 'auth_revoked', '16110': 'auth_revoked',
  '932': 'auth_expired', '21917053': 'auth_expired',
  '518': 'rate_limited', '21919144': 'rate_limited',
  '10007': 'transient', '21916984': 'transient',
  '488': 'conflict', '21060': 'conflict',
}

/** eBay Trading answers in XML, with its errors inside an HTTP 200. */
function ebayTrading(status: number, text: string): ChannelVerdict {
  const code = /<ErrorCode>([^<]+)<\/ErrorCode>/.exec(text)?.[1] ?? null
  const message = /<LongMessage>([^<]+)<\/LongMessage>/.exec(text)?.[1] ?? /<ShortMessage>([^<]+)<\/ShortMessage>/.exec(text)?.[1] ?? null
  const known = code ? TRADING_CODES[code] : undefined
  return verdict(known ?? (status >= 200 && status < 300 ? 'validation' : byStatus(status)), code, message)
}

function ebay(status: number, text: string): ChannelVerdict {
  if (/^\s*</.test(text) && /<(Errors|Ack)>/.test(text)) return ebayTrading(status, text)
  const body = parseJson(text)
  const first = Array.isArray(body?.errors) ? body.errors[0] : Array.isArray(body?.error) ? body.error[0] : null
  const id = Number(first?.errorId)
  const message = first?.longMessage ?? first?.message ?? (text || null)
  // 215000–215122: the RFC 9421 digital-signature family (EU/UK sellers on money calls).
  if (id >= 215000 && id <= 215122) return verdict('signature', id, message)
  if (/invalid_grant/i.test(text)) return verdict('auth_revoked', first?.errorId ?? 'invalid_grant', message)
  if (/invalid_client/i.test(text)) return verdict('configuration', first?.errorId ?? 'invalid_client', message)
  if (status === 401 && /expired/i.test(text)) return verdict('auth_expired', first?.errorId, message)
  return verdict(byStatus(status), Number.isFinite(id) ? id : null, message)
}

function amazonSp(status: number, text: string): ChannelVerdict {
  const body = parseJson(text)
  const first = Array.isArray(body?.errors) ? body.errors[0] : null
  const code: string | undefined = first?.code
  const message = first ? [first.message, first.details].filter(Boolean).join(' — ') : text || null
  if (/invalid_grant/i.test(text)) return verdict('auth_revoked', code ?? 'invalid_grant', message)
  if (/invalid_client|LWA secret token you provided has expired/i.test(text)) return verdict('configuration', code ?? 'invalid_client', message)
  if (code === 'QuotaExceeded' || status === 429) return verdict('rate_limited', code ?? 429, message)
  if (code === 'Unauthorized' && status === 403) return verdict('forbidden', code, message)
  if (code === 'InvalidInput' || code === 'InvalidParameterValue') return verdict('validation', code, message)
  if (code === 'NotFound') return verdict('not_found', code, message)
  return verdict(byStatus(status), code ?? null, message)
}

function shopify(status: number, text: string): ChannelVerdict {
  const body = parseJson(text)
  const errors = Array.isArray(body?.errors) ? body.errors : null
  const first = errors?.[0]
  const code: string | undefined = first?.extensions?.code
  const message = first?.message ?? (typeof body?.errors === 'string' ? body.errors : null) ?? (text || null)
  if (code === 'THROTTLED' || status === 429) return verdict('rate_limited', code ?? 429, message)
  if (code === 'ACCESS_DENIED') return verdict('forbidden', code, message)
  if (status === 401) return verdict('auth_revoked', code ?? 401, message)
  if (status === 402 || status === 423) return verdict('forbidden', status, message) // payment required / shop locked
  if (status === 200 && errors) return verdict('validation', code ?? null, message) // GraphQL errors on a 200
  return verdict(byStatus(status), code ?? null, message)
}

function amazonAds(status: number, text: string): ChannelVerdict {
  const body = parseJson(text)
  const code: string | undefined = body?.code ?? body?.errorCode
  const message = body?.details ?? body?.message ?? (text || null)
  if (/invalid_grant/i.test(text)) return verdict('auth_revoked', code ?? 'invalid_grant', message)
  if (status === 401) return verdict('auth_expired', code ?? 401, message)
  return verdict(byStatus(status), code ?? null, message)
}

function etsy(status: number, text: string): ChannelVerdict {
  const body = parseJson(text)
  const message = body?.error_description ?? body?.error ?? (text || null)
  if (/invalid_grant/i.test(text)) return verdict('auth_revoked', 'invalid_grant', message)
  if (status === 401) return verdict('auth_expired', 401, message)
  return verdict(byStatus(status), body?.error ?? null, message)
}

/** Classify a channel's answer. `status` 0 = no answer (network); `timedOut` wins over everything. */
export function classifyChannelAnswer(channel: GatewayChannel, status: number, text: string, opts: { timedOut?: boolean } = {}): ChannelVerdict {
  if (opts.timedOut) return verdict('timeout', null, 'The channel did not answer in time.')
  if (status === 0) return verdict('network', null, text || 'No answer from the channel.')
  switch (channel) {
    case 'EBAY': return ebay(status, text)
    case 'AMAZON_SP': return amazonSp(status, text)
    case 'SHOPIFY': return shopify(status, text)
    case 'AMAZON_ADS': return amazonAds(status, text)
    case 'ETSY': return etsy(status, text)
  }
}
