import { z } from 'zod'
import { prepackView, stylePrepacksView, type PrepackView, type StylePrepacksView } from '@nexus/factory-domain/product/prepacks/contracts'
import type { PrepackScope, PrepackStatus } from '@nexus/factory-domain/product/prepacks/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * The calls of the Prepacks section (B-W2b-233; SCR-287, Style › Sizes & measurements), each answer checked against the
 * API's own contract (factory-domain product/prepacks/contracts). A change sends the PREPACK's version and an idempotency
 * key; a 409 reads the section again.
 */

export type { PrepackView, StylePrepacksView }
export type PrepackLine = PrepackView['lines'][number]

/** A line as a write sends it. */
export interface PrepackLineInput {
  size: string
  colourwayId: string | null
  quantity: number
}

const enc = encodeURIComponent
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export function getStylePrepacks(api: ApiClient, styleId: string): Promise<StylePrepacksView> {
  return api.get(`/product/styles/${enc(styleId)}/prepacks`, { schema: z.object({ prepacks: stylePrepacksView }) }).then((answer) => answer.prepacks)
}

export function createPrepack(api: ApiClient, styleId: string, body: { scope: PrepackScope; code: string; name: string; lines: PrepackLineInput[] }): Promise<PrepackView> {
  return api.post(`/product/styles/${enc(styleId)}/prepacks`, { body, schema: z.object({ prepack: prepackView }), ...key() }).then((answer) => answer.prepack)
}

export function updatePrepack(api: ApiClient, prepack: { id: string; version: number }, patch: { code?: string; name?: string; lines?: PrepackLineInput[] }): Promise<PrepackView> {
  return api.request('PATCH', `/product/prepacks/${enc(prepack.id)}`, { body: { ...patch, version: prepack.version }, schema: z.object({ prepack: prepackView }), ...key() }).then((answer) => answer.prepack)
}

export function setPrepackStatus(api: ApiClient, prepacks: readonly { id: string; version: number }[], status: PrepackStatus): Promise<PrepackView[]> {
  return api
    .post('/product/prepacks/status', { body: { prepacks: prepacks.map((entry) => ({ id: entry.id, version: entry.version })), status }, schema: z.object({ prepacks: z.array(prepackView) }), ...key() })
    .then((answer) => answer.prepacks)
}
