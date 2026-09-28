/**
 * Sheet pop-up P3, slice A2 — "Values from": the Shared per-variant attributes an axis under the operator's own name may take
 * its values from, with how many variants carry one. One read (`GET /api/products/:id/studio/own-axis-sources`). The design
 * system's channel pop-up calls it when the operator opens "Your own name".
 *
 * Slice A3 — the same read says whether "New attribute" may run here (`newAttribute`), and `createOwnAxisAttribute` makes (or
 * places) the attribute in the product's family (`POST …/studio/own-axis-attribute`). That call WRITES at once.
 */
import { CHANNEL_AXES_COPY, type NewAttributeState, type OwnAxisAttributeResult, type OwnAxisSourceOption, type OwnAxisSourcesRead } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'

const studioUrl = (productId: string, path: string, market: string) =>
  `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/${path}?market=${encodeURIComponent(market)}`

export async function loadOwnAxisSources(productId: string, market: string): Promise<OwnAxisSourcesRead> {
  const res = await fetch(studioUrl(productId, 'own-axis-sources', market), {
    credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? `the attribute read failed (${res.status})`)
  const read = body as { sources?: OwnAxisSourceOption[]; newAttribute?: NewAttributeState }
  return { sources: read.sources ?? [], newAttribute: read.newAttribute ?? null }
}

/**
 * What the create route answered, as the pop-up reads it. Pure (the suite drives it): a source → done; the 409 offer → "Use
 * it"; a refusal → the server's sentence; 403 → the permission sentence (the permission layer answers before the route's own).
 * Anything else throws with the server's words, and the pop-up says the call failed.
 */
export function ownAxisAttributeAnswer(status: number, body: unknown): OwnAxisAttributeResult {
  const b = (body ?? {}) as { outcome?: string; source?: OwnAxisSourceOption; message?: string; error?: string; offer?: { label?: string } }
  if (status >= 200 && status < 300 && b.source && (b.outcome === 'created' || b.outcome === 'placed' || b.outcome === 'present')) {
    return { outcome: b.outcome, source: b.source }
  }
  if (status === 409 && b.error === 'own_axis_attribute_exists' && b.message) return { outcome: 'offer', message: b.message, label: b.offer?.label ?? '' }
  if (status === 400 && b.error === 'own_axis_attribute_refused' && b.message) return { outcome: 'refused', message: b.message }
  if (status === 403) return { outcome: 'refused', message: CHANNEL_AXES_COPY.noPermission }
  throw new Error(b.message ?? b.error ?? `the attribute call failed (${status})`)
}

export async function createOwnAxisAttribute(productId: string, market: string, name: string, useExisting: boolean): Promise<OwnAxisAttributeResult> {
  const res = await fetch(studioUrl(productId, 'own-axis-attribute', market), {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(useExisting ? { name, useExisting: true } : { name }),
    signal: AbortSignal.timeout(30_000),
  })
  return ownAxisAttributeAnswer(res.status, await res.json().catch(() => ({})))
}
