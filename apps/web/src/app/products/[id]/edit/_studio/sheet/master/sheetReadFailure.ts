/** A product 404 is not evidence that the studio route is missing. */
export function sheetReadFailure(status: number, raw: unknown): { fallback: boolean; message: string } {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  const missingProduct = body?.code === 'unknown_product' || body?.error === 'unknown_product'
  const message = missingProduct ? 'This product is unavailable. It may have been moved to the bin.'
    : typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error
      : `Studio sheet refused (HTTP ${status})`
  return { fallback: status === 404 && !missingProduct && body?.code == null, message }
}
