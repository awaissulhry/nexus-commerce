import { getBackendUrl } from '@/lib/backend-url'
export async function transferApi<T>(path: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<T> {
  const response = await fetch(`${getBackendUrl()}/api/${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'include', signal,
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body), ...(body instanceof FormData ? {} : { headers: { 'Content-Type': 'application/json' } }) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`)
  return result as T
}
