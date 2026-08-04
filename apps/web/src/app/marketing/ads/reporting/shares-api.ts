/** RPT.15 — client contract for read-only, expiring share links. */
import { getBackendUrl } from '@/lib/backend-url'

export interface ShareLink {
  id: string
  reportId: string
  label: string | null
  expiresAt: string
  revokedAt: string | null
  isExpired: boolean
  isActive: boolean
  viewCount: number
  lastViewedAt: string | null
  createdAt: string
}

const base = () => `${getBackendUrl()}/api/advertising/reporting/shares`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

export async function listShareLinks(): Promise<ShareLink[]> {
  const r = await call<{ items: ShareLink[] }>(base())
  return r.items
}

/**
 * The response carries the raw token, and this is the ONLY time it exists
 * outside the recipient's URL bar — the server stores just a hash and genuinely
 * cannot reproduce it. The caller must show it immediately or lose it.
 */
export async function createShareLink(input: {
  reportId: string
  query: Record<string, unknown>
  label?: string
  ttlDays?: number
}): Promise<{ link: ShareLink; token: string; note: string }> {
  return call(base(), { method: 'POST', body: JSON.stringify(input) })
}

export async function revokeShareLink(id: string): Promise<ShareLink> {
  const r = await call<{ link: ShareLink }>(`${base()}/${id}`, { method: 'DELETE' })
  return r.link
}

/** The public read. No credentials — that is the entire point of the feature. */
export async function fetchSharedReport(token: string, signal?: AbortSignal) {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/reporting/public/share/${encodeURIComponent(token)}`,
    { signal },
  )
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? 'This link is not valid, or has expired')
  return body as {
    reportId: string
    title: string
    label: string | null
    expiresAt: string
    result: {
      columns: Array<{ id: string; label: string; format?: string; align?: string }>
      rows: Array<Record<string, unknown>>
      totals?: Record<string, unknown> | null
      total: number
      elapsedMs: number
    }
  }
}

/**
 * Deliberately OUTSIDE /marketing/ads. Everything under that path is wrapped by
 * the ads layout, which renders the console sidebar — showing an external
 * recipient our whole internal navigation. A share page gets its own bare route.
 */
export function shareUrl(token: string): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/shared/report/${token}`
}
