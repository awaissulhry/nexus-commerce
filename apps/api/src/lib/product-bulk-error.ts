/** Safe, named product-write errors shared by content and fact writers and their HTTP/batch boundaries. */
export class ProductBulkError extends Error {
  /** `cause` keeps the original failure, so a lost race wrapped as a 500 is still retried (`retryableConflict`). */
  constructor(readonly statusCode: number, readonly details: Record<string, unknown>, cause?: unknown) {
    super(typeof details.error === 'string' ? details.error : 'Product edit failed')
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/** Content routes historically expose `message`; batch callers also read the named `error`. */
export function productWriteRefusal(statusCode: 400 | 404 | 409, message: string): ProductBulkError {
  return new ProductBulkError(statusCode, { error: message, message })
}
