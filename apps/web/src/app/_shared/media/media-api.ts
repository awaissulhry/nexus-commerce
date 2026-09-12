import { getBackendUrl } from '@/lib/backend-url'

export async function mediaRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getBackendUrl()}/api/assets/${path}`, { credentials: 'include', cache: 'no-store', ...options })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.message ?? body?.error ?? `The media request failed (${response.status}).`)
  if (!body) throw new Error('The media response could not be read. Refresh the library.')
  return body as T
}
