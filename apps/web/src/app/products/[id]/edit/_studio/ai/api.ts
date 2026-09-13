/**
 * PES.8 — the studio's calls to the enrichment API.
 *
 * Three endpoints, and the split between them is the permission model, not tidiness: reading and
 * deciding drafts sits under `/api/products/...` (products:view / products:edit), while generation
 * sits under `/api/ai/...` (ai:run). This file deliberately does NOT expose generate — under hub
 * ruling #13 the Owner has held live generation, and a UI that cannot call it is a stronger
 * guarantee than a UI that chooses not to.
 *
 * ⚠ Local dev hits the PROD API unless NEXT_PUBLIC_API_URL is set. Approving a draft here writes a
 * real catalogue value (reference_local_dev_hits_prod_api).
 */
import { getBackendUrl } from '@/lib/backend-url'

import type { AiDraftsResponse, ApproveResponse } from './types'

export interface LoadDraftsQuery {
  productIds: string[]
  /** `null` = the master scope; a channel key otherwise. */
  channel: string | null
  marketplace: string | null
  /**
   * The locale on screen. Absent/null returns only the master's own values — a translation draft
   * for another language must never tint the cell the operator is looking at.
   */
  locale?: string | null
  locales?: readonly string[] | null
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string }
    return body.error ?? body.message ?? `${res.status} ${res.statusText}`
  } catch {
    return `${res.status} ${res.statusText}`
  }
}

/**
 * Pending + failed drafts for the products on screen.
 *
 * `master` is sent as the literal string for the master scope, because an ABSENT channel means
 * "any scope" to the endpoint while a null one means "the master scope" — two different questions
 * that a bare empty parameter cannot tell apart.
 */
export async function loadDrafts(q: LoadDraftsQuery, signal?: AbortSignal): Promise<AiDraftsResponse> {
  if (q.productIds.length === 0) {
    return { drafts: [], counts: { total: 0, pending: 0, failed: 0, stale: 0 } }
  }
  if (q.locales?.length) {
    const responses = await Promise.all(q.locales.map(locale => loadDrafts({ ...q, locale, locales: null }, signal)))
    return { drafts: responses.flatMap(response => response.drafts), counts: responses.reduce((counts, response) => ({
      total: counts.total + response.counts.total, pending: counts.pending + response.counts.pending,
      failed: counts.failed + response.counts.failed, stale: counts.stale + response.counts.stale,
    }), { total: 0, pending: 0, failed: 0, stale: 0 }) }
  }
  const params = new URLSearchParams({
    productIds: q.productIds.join(','),
    status: 'pending,failed',
  })
  params.set('channel', q.channel ?? 'master')
  if (q.locale) params.set('locale', q.locale)
  if (q.channel !== null && q.marketplace) params.set('marketplace', q.marketplace)
  else if (q.channel === null) params.set('marketplace', 'master')

  const res = await fetch(`${getBackendUrl()}/api/products/ai/drafts?${params.toString()}`, {
    credentials: 'include',
    signal,
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AiDraftsResponse
}

/**
 * Approve drafts. Each one is replayed by the server through `PATCH /api/products/bulk`, so it
 * meets the same validation, the same version conflict and the same audit trail as a typed edit.
 *
 * `allowStale` is passed explicitly, per call, and defaults to false. It means "I have seen the
 * value that is there now and I still want mine" — so the surface must only ever send it from a
 * control that showed the operator that value.
 */
export async function approveDrafts(
  draftIds: string[],
  opts: { allowStale?: boolean } = {},
): Promise<ApproveResponse> {
  const res = await fetch(`${getBackendUrl()}/api/products/ai/drafts/approve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draftIds, allowStale: opts.allowStale === true }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ApproveResponse
}

export async function rejectDrafts(draftIds: string[]): Promise<{ rejected: number }> {
  const res = await fetch(`${getBackendUrl()}/api/products/ai/drafts/reject`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draftIds }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as { rejected: number }
}
