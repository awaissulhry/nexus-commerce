import { z } from 'zod'
import { gateView, releasedScopeView, type GateView, type ReleasedScopeView } from '@nexus/factory-domain/product/release/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The release gate's calls (B-W2b-231; design products.styles pop:styles.release "Release revision N"): the gate of one
 * revision — a draft checked for the scope asked (a preview of "Release only some colourways or sizes"), a released revision
 * for the cells a later release would add — the scope planned on a draft or widened on a released revision, and what a
 * style's current revision is released for. Every answer is checked against factory-domain's contracts; a write carries the
 * revision's version and one Idempotency-Key per attempt. The release itself stays W1's route (styles/api releaseRevision).
 * The API's English (`message`, `heldBy`, `effects`, scope `words`) is never shown: the screens say their own words.
 */

export type { GateView, ReleasedScopeView }
export type GateItemView = GateView['items'][number]
export type GateFindingView = GateItemView['findings'][number]

const enc = encodeURIComponent
const revisionPath = (styleId: string, revisionId: string) => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}`

/** What the release takes: colourway ids and size codes, each empty = every one. */
export interface ScopeAsk {
  colourwayIds: readonly string[]
  sizes: readonly string[]
}

const oneGate = z.object({ gate: gateView })

/** The gate of a revision; `asked` previews another scope (left out: the scope planned on a draft, as released on a frozen one). */
export function readGate(api: ApiClient, styleId: string, revisionId: string, asked?: ScopeAsk | null, signal?: AbortSignal): Promise<GateView> {
  const query = asked ? { colourwayIds: asked.colourwayIds.join(','), sizes: asked.sizes.join(',') } : undefined
  return api.get(`${revisionPath(styleId, revisionId)}/release-gate`, { query, schema: oneGate, signal }).then((answer) => answer.gate)
}

/** A draft's planned scope, or a later release of a released revision (only wider); answers the gate as the command left it. */
export function setScope(api: ApiClient, styleId: string, revision: { id: string; version: number }, scope: ScopeAsk, idempotencyKey?: string): Promise<GateView> {
  return api
    .request('PUT', `${revisionPath(styleId, revision.id)}/release-scope`, {
      body: { version: revision.version, colourwayIds: [...scope.colourwayIds], sizes: [...scope.sizes] },
      schema: oneGate,
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
    .then((answer) => answer.gate)
}

/** What the style's current (RELEASED) revision is released for, and what waits (product.styles.view). */
export function readReleasedScope(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<ReleasedScopeView> {
  return api.get(`/product/styles/${enc(styleId)}/release-scope`, { schema: z.object({ released: releasedScopeView }), signal }).then((answer) => answer.released)
}
