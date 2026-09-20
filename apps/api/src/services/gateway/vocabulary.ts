/**
 * P1.1 (docs/channel-connections/FINAL-PLAN.md, section 5 item 1, step 8) — the ONE error vocabulary for
 * every channel call. Before this there were six (the ledger's errorType, the CX ErrorClass, eBay
 * Marketing's EbayErrorKind, classifyEbayFailure, SyncErrorType, PublishOutcome) and none was shared.
 *
 * `classifyChannelAnswer` reads a non-2xx (or a 2xx that carries errors) and returns the class, whether
 * a retry can help, and the channel's own code and words. P3.1 extends the per-channel tables; the
 * classes themselves are the contract other packages build on.
 */

import { resolveIssueAttributes } from '../channel-issue-attributes.js'

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

/**
 * P3.1 — how bad the channel says it is.
 *
 * `error` stops the change; `warning` is a channel accepting it while telling us
 * something. Amazon's listings previews and eBay's `Ack: Warning` both return problems
 * that did NOT block the write, and reading those as failures would have an operator
 * chasing a listing that published perfectly well.
 */
export type GatewaySeverity = 'error' | 'warning'

export interface ChannelVerdict {
  errorClass: GatewayErrorClass
  retryable: boolean
  /** The channel's own error code (eBay errorId, Amazon code, Shopify extension code…). */
  channelCode: string | null
  /** The channel's own words, capped at 500 characters. */
  channelMessage: string | null
  /**
   * P3.1 — WHICH field the channel is complaining about, in the channel's own naming.
   *
   * eBay puts it in `parameters[0].name`, Amazon SP in the issue's `attributeNames`,
   * Shopify in a `field` path. Without it P3.2 cannot put an error on the attribute it
   * belongs to, and an operator is told "the change was rejected" with no way to find
   * out which of forty fields did it.
   */
  attribute: string | null
  severity: GatewaySeverity
}

const cap = (text: unknown): string | null => {
  if (text === null || text === undefined) return null
  const s = String(text).trim()
  return s ? (s.length > 500 ? `${s.slice(0, 499)}…` : s) : null
}

/**
 * Parse a channel's body, unwrapping it when it has been encoded twice.
 *
 * **161 of the 201 stored failed bodies in `OutboundApiCallLog` are double-encoded** —
 * a JSON *string* whose contents are JSON — which is 81 of 81 Amazon and 80 of 120
 * eBay. One `JSON.parse` on those yields a string, every field read off it is
 * `undefined`, and the classifier fell through to the raw text: the error code was lost
 * on every one, and the operator was shown an escaped JSON blob instead of the
 * channel's sentence.
 *
 * Measured, not assumed: a real eBay 62005 came back with `code=null` and a message
 * beginning `"{\"errors\":[{\"errorId\":62005…` before this.
 *
 * Bounded to two unwraps. A body that is still a string after that is genuinely a
 * string, and looping on it would turn a malformed answer into a hang.
 */
function parseJson(text: string): any {
  let value: unknown = text
  for (let depth = 0; depth < 2; depth++) {
    if (typeof value !== 'string') break
    try { value = JSON.parse(value) } catch { return depth === 0 ? null : value }
  }
  return typeof value === 'string' ? null : value
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

function verdict(
  errorClass: GatewayErrorClass,
  channelCode: unknown,
  channelMessage: unknown,
  extra: { attribute?: unknown; severity?: GatewaySeverity } = {},
): ChannelVerdict {
  return {
    errorClass,
    retryable: isRetryableClass(errorClass),
    channelCode: channelCode == null ? null : String(channelCode),
    channelMessage: cap(channelMessage),
    attribute: extra.attribute == null || String(extra.attribute).trim() === '' ? null : String(extra.attribute).trim(),
    severity: extra.severity ?? 'error',
  }
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

/**
 * The field an eBay error is about.
 *
 * `parameters` is a list of `{name, value}` and the FIRST entry names the attribute —
 * a real 62005 carries `[{name:'category_id',value:'177104'},{name:'queryParam',…}]`,
 * so taking the last, or joining them, would report `queryParam`, which is eBay
 * describing its own envelope rather than the seller's field.
 */
function ebayAttribute(first: any): string | null {
  const parameters = Array.isArray(first?.parameters) ? first.parameters : null
  return parameters?.[0]?.name ?? null
}

function ebay(status: number, text: string): ChannelVerdict {
  if (/^\s*</.test(text) && /<(Errors|Ack)>/.test(text)) return ebayTrading(status, text)
  const body = parseJson(text)
  // eBay's OAuth endpoints answer in a SHAPE OF THEIR OWN: `{error, error_description}`,
  // with no `errors` array at all. Every real `invalid_grant` and `invalid_client` in
  // the call ledger is that shape, and reading only `errors[]` left the operator with
  // the raw JSON instead of eBay's sentence.
  const oauthError = typeof body?.error === 'string' ? body.error : null
  const oauthMessage = typeof body?.error_description === 'string' ? body.error_description : null
  const first = Array.isArray(body?.errors) ? body.errors[0] : Array.isArray(body?.error) ? body.error[0] : null
  const id = Number(first?.errorId)
  const message = first?.longMessage ?? first?.message ?? oauthMessage ?? (text || null)
  const attribute = ebayAttribute(first)
  // 215000–215122: the RFC 9421 digital-signature family (EU/UK sellers on money calls).
  if (id >= 215000 && id <= 215122) return verdict('signature', id, message, { attribute })
  if (/invalid_grant/i.test(text)) return verdict('auth_revoked', first?.errorId ?? oauthError ?? 'invalid_grant', message, { attribute })
  if (/invalid_client/i.test(text)) return verdict('configuration', first?.errorId ?? oauthError ?? 'invalid_client', message, { attribute })
  if (status === 401 && /expired/i.test(text)) return verdict('auth_expired', first?.errorId, message, { attribute })
  return verdict(byStatus(status), Number.isFinite(id) ? id : (oauthError ?? null), message, { attribute })
}

function amazonSp(status: number, text: string): ChannelVerdict {
  const body = parseJson(text)
  const first = Array.isArray(body?.errors) ? body.errors[0] : null
  const code: string | undefined = first?.code
  // Not every SP-API failure uses the `errors[]` envelope. A throttle answers with a
  // bare `{"message":"Too Many Requests"}`, and reading only `errors[]` left the
  // operator with the escaped JSON instead of those three words — on all 81 stored
  // Amazon failures, every one of which is double-encoded as well.
  const message = first
    ? [first.message, first.details].filter(Boolean).join(' — ')
    : (typeof body?.message === 'string' ? body.message : null) ?? text ?? null
  // SP-API names the offending attributes on a listings issue. `attributeNames` is a
  // list; the first is the one to put the error on.
  //
  // P3.2 — but Amazon sends `attributeNames: []` on every real rejection we hold (140
  // of 140 stored feed issues), and an `Array.isArray` read of that yields `undefined`.
  // The attribute is in the message, in the seller's language; resolveIssueAttributes
  // reads the identifier out of it. ONE accessor, shared with the feed-report parser.
  const attribute = resolveIssueAttributes(
    Array.isArray(first?.attributeNames) ? first.attributeNames
      : first?.attributeName ? [first.attributeName] : [],
    message,
  )[0] ?? null
  if (/invalid_grant/i.test(text)) return verdict('auth_revoked', code ?? 'invalid_grant', message, { attribute })
  if (/invalid_client|LWA secret token you provided has expired/i.test(text)) return verdict('configuration', code ?? 'invalid_client', message, { attribute })
  if (code === 'QuotaExceeded' || status === 429) return verdict('rate_limited', code ?? 429, message, { attribute })
  if (code === 'Unauthorized' && status === 403) return verdict('forbidden', code, message, { attribute })
  if (code === 'InvalidInput' || code === 'InvalidParameterValue') return verdict('validation', code, message, { attribute })
  if (code === 'NotFound') return verdict('not_found', code, message, { attribute })
  return verdict(byStatus(status), code ?? null, message, { attribute })
}

function shopify(status: number, text: string): ChannelVerdict {
  const body = parseJson(text)
  const errors = Array.isArray(body?.errors) ? body.errors : null
  const first = errors?.[0]
  const code: string | undefined = first?.extensions?.code
  const message = first?.message ?? (typeof body?.errors === 'string' ? body.errors : null) ?? (text || null)
  // Shopify names the field two ways: `field` on a userError (an array path such as
  // ['input','title']) and `path` on a GraphQL error. The LAST segment is the field;
  // the earlier ones are the mutation's own envelope.
  const fieldPath = Array.isArray(first?.field) ? first.field : Array.isArray(first?.path) ? first.path : null
  // P3.2 — a Shopify userError can carry `field: []`, and a plain GraphQL error carries
  // no path at all. Fall back to the message, which names the field often enough to be
  // worth reading, through the same accessor the other connectors use.
  const attribute = fieldPath?.length
    ? String(fieldPath[fieldPath.length - 1])
    : resolveIssueAttributes([], message)[0] ?? null
  if (code === 'THROTTLED' || status === 429) return verdict('rate_limited', code ?? 429, message, { attribute })
  if (code === 'ACCESS_DENIED') return verdict('forbidden', code, message, { attribute })
  if (status === 401) return verdict('auth_revoked', code ?? 401, message, { attribute })
  if (status === 402 || status === 423) return verdict('forbidden', status, message, { attribute }) // payment required / shop locked
  if (status === 200 && errors) return verdict('validation', code ?? null, message, { attribute }) // GraphQL errors on a 200
  return verdict(byStatus(status), code ?? null, message, { attribute })
}

function amazonAds(status: number, text: string): ChannelVerdict {
  const body = parseJson(text)
  const code: string | undefined = body?.code ?? body?.errorCode
  // `detail` AND `details`. Amazon Ads sends both spellings and only the plural was
  // read — so the singular, which is the one most of the real bodies use, fell through
  // to the raw text. In the call ledger, four of six sampled Ads errors say `detail`.
  const message = body?.detail ?? body?.details ?? body?.message ?? (text || null)
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
