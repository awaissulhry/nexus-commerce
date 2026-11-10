import { z } from 'zod'
import { protectorPlacementView, type PlacementView, type ProtectorPlacementView } from '@nexus/factory-domain/product/protectors/contracts'
import type { ProtectorLevel, ProtectorPocket } from '@nexus/factory-domain/product/protectors/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * The calls of the Protector placement section (B-W2b-233; SCR-287, Style › Sizes & measurements), each answer checked
 * against the API's own contract (factory-domain product/protectors/contracts). A cell's change sends the PLACEMENT's
 * version; every write an idempotency key; a 409 reads the section again.
 */

export type { PlacementView, ProtectorPlacementView }
export type PlacementFinding = ProtectorPlacementView['findings'][number]
export type ProtectorChoice = ProtectorPlacementView['choices'][number]

/** The fields a placement write may send (only what changed). */
export interface PlacementPatch {
  pocket?: ProtectorPocket
  protectorItemId?: string
  standard?: string
  level?: ProtectorLevel
  sizes?: string[]
  positionNote?: string | null
}

const one = z.object({ protectors: protectorPlacementView })
const enc = encodeURIComponent
const base = (styleId: string, revisionId: string) => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}/protectors`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export function getProtectors(api: ApiClient, styleId: string, revisionId: string): Promise<ProtectorPlacementView> {
  return api.get(base(styleId, revisionId), { schema: one }).then((answer) => answer.protectors)
}

export function addPlacement(api: ApiClient, styleId: string, revisionId: string, body: PlacementPatch & { pocket: ProtectorPocket; protectorItemId: string }): Promise<ProtectorPlacementView> {
  return api.post(base(styleId, revisionId), { body, schema: one, ...key() }).then((answer) => answer.protectors)
}

export function updatePlacement(api: ApiClient, styleId: string, revisionId: string, placement: { id: string; version: number }, patch: PlacementPatch): Promise<ProtectorPlacementView> {
  return api.request('PATCH', `${base(styleId, revisionId)}/${enc(placement.id)}`, { body: { ...patch, version: placement.version }, schema: one, ...key() }).then((answer) => answer.protectors)
}

export function removePlacements(api: ApiClient, styleId: string, revisionId: string, placements: readonly { id: string; version: number }[]): Promise<ProtectorPlacementView> {
  return api.post(`${base(styleId, revisionId)}/remove`, { body: { placements: placements.map((entry) => ({ id: entry.id, version: entry.version })) }, schema: one, ...key() }).then((answer) => answer.protectors)
}

export function orderPlacements(api: ApiClient, styleId: string, revisionId: string, placementIds: readonly string[]): Promise<ProtectorPlacementView> {
  return api.request('PUT', `${base(styleId, revisionId)}/order`, { body: { placementIds }, schema: one, ...key() }).then((answer) => answer.protectors)
}
