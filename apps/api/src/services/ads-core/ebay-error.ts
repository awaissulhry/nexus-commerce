/**
 * eBay Marketing (Promoted Listings) error classification.
 *
 * Why this exists: eBay answers a blocked account with HTTP 409 + errorId
 * 35077 and a perfectly clear sentence. We used to throw a bare Error, which
 * Fastify rendered as "Internal Server Error" — so an operator whose seller
 * level had slipped saw a generic 500 with no way to know that eBay, not
 * Nexus, was refusing, and that no code change could fix it.
 *
 * Pure and unit-tested: no I/O, no Prisma. Classification only.
 */

export type EbayErrorKind =
  /** The account itself cannot use Promoted Listings right now. */
  | 'ACCOUNT_BLOCKED'
  /** This listing cannot be advertised (ended, auction, category, market). */
  | 'LISTING_INELIGIBLE'
  /** The request contradicts campaign state or eBay's immutability rules. */
  | 'CONFLICT'
  /** Already done — safe to treat as success (at-least-once delivery). */
  | 'IDEMPOTENT'
  /** Back off and retry later. */
  | 'RATE_LIMITED'
  /** We sent something malformed. */
  | 'BAD_REQUEST'
  /** Entity is gone. */
  | 'NOT_FOUND'
  /** Unrecognised — surfaced verbatim rather than swallowed. */
  | 'UNKNOWN'

export interface EbayErrorInfo {
  kind: EbayErrorKind
  /** HTTP status Nexus should answer its own caller with. */
  httpStatus: number
  /** Operator-facing sentence: what is wrong and who can fix it. */
  operatorMessage: string
  /** True when retrying the identical request can never succeed. */
  terminal: boolean
}

interface Rule { kind: EbayErrorKind; httpStatus: number; terminal: boolean; message: string }

/**
 * Codes verified against eBay's Marketing API docs and, where marked
 * (observed), against live 2026-07-28 responses on this account.
 */
const RULES: Record<number, Rule> = {
  // ── account-level gates ───────────────────────────────────────────────
  35077: {
    kind: 'ACCOUNT_BLOCKED', httpStatus: 409, terminal: true,
    message:
      'eBay is blocking all Promoted Listings operations on this account: your seller level must be Top Rated or Above Standard (and meet eBay\'s recent-sales threshold). '
      + 'This is an eBay account-standing gate, not a Nexus problem — no setting here can bypass it. '
      + 'Check Seller Hub → Performance → Seller level; campaigns stay SYSTEM_PAUSED until standing recovers.', // observed 2026-07-28
  },
  35078: {
    kind: 'ACCOUNT_BLOCKED', httpStatus: 409, terminal: true,
    message: 'eBay reports this seller account is not in good standing, so Promoted Listings is unavailable. Resolve the account issue in Seller Hub first.',
  },

  // ── listing-level eligibility (no pre-check API exists; classify post-hoc)
  35048: { kind: 'LISTING_INELIGIBLE', httpStatus: 422, terminal: true, message: 'That listing has ended, so it cannot be advertised.' },
  35058: { kind: 'LISTING_INELIGIBLE', httpStatus: 422, terminal: true, message: 'Only fixed-price listings can be promoted — this one is not.' },
  35052: { kind: 'LISTING_INELIGIBLE', httpStatus: 422, terminal: true, message: 'That listing\'s category is not eligible for Promoted Listings.' },
  35075: { kind: 'LISTING_INELIGIBLE', httpStatus: 422, terminal: true, message: 'That listing\'s category is not eligible for this campaign type.' },
  35054: { kind: 'LISTING_INELIGIBLE', httpStatus: 422, terminal: true, message: 'That listing belongs to a different eBay marketplace than the campaign.' },

  // ── idempotency: eBay has no keys, so these ARE the dedupe primitives ──
  35036: { kind: 'IDEMPOTENT', httpStatus: 200, terminal: false, message: 'That listing already has an ad in this campaign — treated as already done.' },
  35018: { kind: 'BAD_REQUEST', httpStatus: 400, terminal: true, message: 'The request repeated the same id more than once — de-duplicate and resend.' },

  // ── campaign state / immutability ─────────────────────────────────────
  35010: { kind: 'CONFLICT', httpStatus: 409, terminal: true, message: 'This campaign uses the DYNAMIC ad-rate strategy, so per-listing rates cannot be set programmatically. Switch it to FIXED first.' },
  35113: { kind: 'CONFLICT', httpStatus: 409, terminal: true, message: 'Bid writes are blocked while the campaign\'s ad-rate strategy is DYNAMIC. Switch it to FIXED first.' },
  35045: { kind: 'NOT_FOUND', httpStatus: 404, terminal: true, message: 'eBay has no campaign with that id for this program type — it may have been ended or created under a different funding model.' }, // observed 2026-07-28
  35051: { kind: 'CONFLICT', httpStatus: 409, terminal: true, message: 'That campaign type is not supported on this eBay marketplace.' },

  // ── throttling ────────────────────────────────────────────────────────
  35071: { kind: 'RATE_LIMITED', httpStatus: 429, terminal: false, message: 'eBay is throttling bulk operations — the batch will be retried with backoff.' },

  // ── report-task constraints ───────────────────────────────────────────
  35090: { kind: 'BAD_REQUEST', httpStatus: 400, terminal: true, message: 'A report task can span at most 7 days — the window must be chunked.' },
  35107: { kind: 'BAD_REQUEST', httpStatus: 400, terminal: true, message: 'This report type rejects the `day` dimension.' },
  35118: { kind: 'BAD_REQUEST', httpStatus: 400, terminal: true, message: 'Report format must be TSV_GZIP.' },
  35119: { kind: 'BAD_REQUEST', httpStatus: 400, terminal: true, message: 'The report request did not meet eBay\'s minimum dimension requirements for that grain.' },
}

/** One error as eBay returns it inside `{ errors: [...] }`. */
export interface RawEbayError { errorId?: number; message?: string; longMessage?: string; category?: string; domain?: string }

/** Pull the `errors[]` array out of an eBay error body, tolerating junk. */
export function parseEbayErrors(body: string): RawEbayError[] {
  try {
    const j = JSON.parse(body) as { errors?: RawEbayError[] }
    return Array.isArray(j.errors) ? j.errors : []
  } catch {
    return []
  }
}

/**
 * Classify an eBay failure. `httpStatus` is the transport status; `errors` is
 * whatever eBay put in the body. The first recognised errorId wins; an
 * unrecognised code is reported verbatim rather than flattened to a 500.
 */
export function classifyEbayError(httpStatus: number, errors: RawEbayError[]): EbayErrorInfo {
  for (const e of errors) {
    const rule = e.errorId != null ? RULES[e.errorId] : undefined
    if (rule) {
      return { kind: rule.kind, httpStatus: rule.httpStatus, terminal: rule.terminal, operatorMessage: rule.message }
    }
  }

  const first = errors[0]
  const verbatim = first?.longMessage ?? first?.message
  if (verbatim) {
    return {
      kind: 'UNKNOWN',
      // Preserve eBay's own status for 4xx; never masquerade a client-side
      // refusal as our own server fault.
      httpStatus: httpStatus >= 400 && httpStatus < 500 ? httpStatus : 502,
      terminal: httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429,
      operatorMessage: `eBay rejected the request${first?.errorId != null ? ` (error ${first.errorId})` : ''}: ${verbatim}`,
    }
  }

  return {
    kind: 'UNKNOWN',
    httpStatus: httpStatus >= 400 && httpStatus < 500 ? httpStatus : 502,
    terminal: false,
    operatorMessage: `eBay returned HTTP ${httpStatus} with no error detail.`,
  }
}

/** A classified eBay Marketing API failure. Carries everything a route needs. */
export class EbayApiError extends Error {
  readonly kind: EbayErrorKind
  readonly httpStatus: number
  readonly terminal: boolean
  readonly errorIds: number[]
  readonly ebayStatus: number

  constructor(what: string, ebayStatus: number, errors: RawEbayError[], rawBody?: string) {
    const info = classifyEbayError(ebayStatus, errors)
    super(`${what}: ${info.operatorMessage}`)
    this.name = 'EbayApiError'
    this.kind = info.kind
    this.httpStatus = info.httpStatus
    this.terminal = info.terminal
    this.ebayStatus = ebayStatus
    this.errorIds = errors.map((e) => e.errorId).filter((n): n is number => n != null)
    if (rawBody && !errors.length) this.message = `${what}: eBay HTTP ${ebayStatus}: ${rawBody.slice(0, 300)}`
  }
}
