/** Safe, named product-write errors shared by content and fact writers and their HTTP/batch boundaries. */
export class ProductBulkError extends Error {
  /** `cause` keeps the original failure, so a lost race wrapped as a 500 is still retried (`retryableConflict`). */
  constructor(readonly statusCode: number, readonly details: Record<string, unknown>, cause?: unknown) {
    super(typeof details.error === 'string' ? details.error : 'Product edit failed')
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/**
 * Refusals other services raise inside a product write, by their `code`: each is a sentence written for the operator, and
 * each says the same thing whatever path the write took (the single-row PATCH, a bulk-save unit, a formula write).
 * An error with a status but no code here is not named: its text was never written for an operator.
 */
const NAMED_CODES = new Set([
  'AMBIGUOUS_CONNECTION', 'NO_CONNECTION', // connection-resolver.service.ts
  'LISTING_SCOPE_MISMATCH', // listing-alias.service.ts
  'INVALID_REQUEST', 'MARKET_UNAVAILABLE', 'ALIAS_LISTING_MISSING', 'COORDINATE_TAKEN', 'NO_ACTIVE_ACCOUNT', 'ACCOUNT_UNAVAILABLE', 'PRODUCT_UNAVAILABLE', // draft-listing.service.ts
])

/** A named refusal from another service: a 4xx status, a known code and its own sentence. */
export function namedRefusal(error: unknown): error is Error & { statusCode: number; code: string } {
  const e = error as { statusCode?: unknown; code?: unknown } | null
  return error instanceof Error && typeof e?.code === 'string' && NAMED_CODES.has(e.code)
    && typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500
}

/** What a lost race answers once its restarts are spent, on every product-write path. */
export const WRITE_BUSY = { error: 'The database was busy. Nothing of this change was saved. Try again.', retryable: true, nothingSaved: true } as const

/** A write that failed in a way no refusal names. The cause is logged where it happened; never sent. */
export const WRITE_FAILED = 'This change could not be saved. Try again; if it keeps failing, reload the page.'

/**
 * The ONE answer to a failed product write (`PATCH /products/bulk`, a `POST /products/bulk-save` unit or operation, the
 * AI draft apply …), so the same refusal reads the same everywhere:
 *   - a named refusal keeps its status and its body: `error` is the sentence (and names the cell in `errors[]` when it is
 *     a cell's), `code` names the refusal; `message` repeats the sentence for clients that read it;
 *   - a race lost after every restart (`restartable`) is 503 `WRITE_BUSY`;
 *   - anything else is 500 with a stable sentence: no driver, Prisma or stack text reaches a client.
 * `restartable` is `transactionMustRestart` plus the pool's P2028/P2024, passed in so this module stays dependency-free.
 */
export function productWriteReply(error: unknown, restartable: (error: unknown) => boolean): { status: number; body: Record<string, unknown> } {
  if (error instanceof ProductBulkError && error.statusCode !== 500) return { status: error.statusCode, body: error.details }
  if (namedRefusal(error)) return { status: error.statusCode, body: { error: error.message, message: error.message, code: error.code } }
  if (restartable(error)) return { status: 503, body: { ...WRITE_BUSY } }
  return { status: 500, body: { error: WRITE_FAILED } }
}
