/**
 * Sheet pop-up P3, slice A2 — "Values from": the Shared per-variant attributes an axis under the operator's own name may take
 * its values from, with how many variants carry one. One read (`GET /api/products/:id/studio/own-axis-sources`); nothing here
 * writes. The design system's channel pop-up calls it when the operator opens "Your own name".
 */
import type { OwnAxisSourceOption } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'

export async function loadOwnAxisSources(productId: string, market: string): Promise<OwnAxisSourceOption[]> {
  const res = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/own-axis-sources?market=${encodeURIComponent(market)}`, {
    credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? `the attribute read failed (${res.status})`)
  return ((body as { sources?: OwnAxisSourceOption[] }).sources ?? [])
}
