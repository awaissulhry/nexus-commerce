import { getBackendUrl } from '@/lib/backend-url'

/** A missing response is uncertain; abort waiting without retrying a channel submission. */
export async function publicationRequest<T>(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Confirmation is taking longer than expected. Check publication status before trying again.')), method === 'GET' ? 30_000 : 120_000)
  try {
    const response = await fetch(`${getBackendUrl()}${path}`, { method, credentials: 'include', cache: 'no-store', signal: controller.signal,
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) })
    const data = await response.json().catch(() => { if (controller.signal.aborted) throw controller.signal.reason; return null })
    if (!response.ok) throw Object.assign(new Error(data?.message ?? data?.error ?? `Publication request failed (${response.status}).`), { status: response.status })
    if (!data) throw new Error('The publication response was empty. Check its status before trying again.')
    return data as T
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}
