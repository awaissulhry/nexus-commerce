/** Bounded GETs for the editor. Only transient transport/server failures are retried. */
export async function fetchStudioRead(url: string, signal?: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.timeout(30_000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  for (let attempt = 0; ; attempt++) {
    combined.throwIfAborted()
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: combined })
      if (attempt > 0 || ![502, 503, 504].includes(response.status)) return response
      await response.body?.cancel()
    } catch (error) {
      if (combined.aborted) throw combined.reason
      if (attempt > 0 || !(error instanceof TypeError)) throw error
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(combined.reason) }
      const timer = setTimeout(() => { combined.removeEventListener('abort', abort); resolve() }, 300)
      combined.addEventListener('abort', abort, { once: true })
      if (combined.aborted) abort()
    })
  }
}

export class StudioReadError extends Error {
  readonly backendMissing: boolean
  constructor(readonly status: number, body: unknown) {
    const data = body && typeof body === 'object' ? body as Record<string, unknown> : null
    const code = data?.code ?? data?.error
    const message = status === 401 ? 'Your session has expired. Sign in again to continue.'
      : status === 403 ? 'You do not have access to this product. Ask an administrator to check your permissions.'
      : status === 404 && code === 'unknown_product' ? 'This product is unavailable. It may have been moved to the bin.'
      : status === 429 ? 'Nexus is receiving too many requests. Wait a moment and try again.'
      : status >= 500 ? 'Nexus could not finish loading this information. Try again in a moment.'
      : typeof data?.message === 'string' ? data.message
      : 'This information could not be loaded. Try again.'
    super(message)
    this.backendMissing = status === 501 || status === 404 && code !== 'unknown_product' && data?.code == null
  }
}

export function studioReadMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'Nexus took too long to load this information. Try again.'
  if (error instanceof TypeError) return 'Nexus could not be reached. Check your connection and try again.'
  if (error instanceof SyntaxError) return 'Nexus returned an incomplete response. Try again.'
  return error instanceof Error ? error.message : 'This information could not be loaded. Try again.'
}
