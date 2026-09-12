import { getBackendUrl } from '@/lib/backend-url'

export const linkedEndpoint = (path: string, suffix: string, params: Record<string, string | undefined> = {}) => {
  const [base, query] = path.split('?'), search = new URLSearchParams(query)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value)
  return `${base}${suffix}?${search}`
}
export async function linkedRequest<T>(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    const timeout = AbortSignal.timeout(method === 'GET' ? 60000 : 120000)
    response = await fetch(`${getBackendUrl()}${path}`, { method, credentials: 'include', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(method === 'GET' ? 'Shopify could not be reached. Try again.' : 'The response was interrupted. Keep your edits and reload the saved status before retrying; the request may have completed.')
  }
  let data: any
  try { data = await response.json() } catch { throw new Error('The response could not be read. Reload the saved status before retrying.') }
  if (!response.ok) throw new Error(data.error ?? `The request failed (${response.status}).`)
  return data as T
}
