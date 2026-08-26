/**
 * GX.8 — client contract for saved Reporting views.
 *
 * Its own prefix rather than the platform's `/api/saved-views`, which is mapped to the PRODUCTS
 * permissions: an operator with the ads role and no products access could read this page and not
 * save what they were reading. Same table underneath, under surface `ads-reporting`.
 */
import { getBackendUrl } from '@/lib/backend-url'

export interface ReportingViewPayload {
  tab: string
  market: string
  /** localStorage key → the raw stored string, exactly as the browser held it. */
  keys: Record<string, string>
}

export interface ReportingView {
  id: string
  name: string
  payload: ReportingViewPayload
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

const base = () => `${getBackendUrl()}/api/advertising/reporting/views`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

export async function listViews(): Promise<ReportingView[]> {
  const r = await call<{ items: ReportingView[] }>(base())
  return r.items
}

export const createView = (input: { name: string; payload: ReportingViewPayload; isDefault?: boolean }) =>
  call<ReportingView>(base(), { method: 'POST', body: JSON.stringify(input) })

export const updateView = (id: string, input: { name?: string; payload?: ReportingViewPayload; isDefault?: boolean }) =>
  call<ReportingView>(`${base()}/${id}`, { method: 'PATCH', body: JSON.stringify(input) })

export const deleteView = (id: string) =>
  call<{ ok: true }>(`${base()}/${id}`, { method: 'DELETE' })
