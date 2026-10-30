import { z } from 'zod'
import { scaleRow, scaleView, type ScaleRow, type ScaleView } from '@nexus/factory-domain/product/sizes/contracts'
import { styleRow, type StyleRow } from '@nexus/factory-domain/product/styles/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call Sizes & measurements makes (SCR-049, size scales), each answer checked against the API's own contract
 * (factory-domain product/sizes; the routes live in product/styles): the list and its counts, one scale with every size
 * and its body measures, its writes (product.styles.manage: create, rename, add sizes, reorder while no style uses it,
 * change a size's label, code (while unused), body measures and state, archive / reactivate), and the styles on it.
 */

export type { ScaleRow, ScaleView, StyleRow }
export type SizeView = ScaleView['sizes'][number]
export type BodyMeasures = NonNullable<SizeView['bodyMeasures']>

const enc = encodeURIComponent
const path = (scaleId: string) => `/product/size-scales/${enc(scaleId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export interface ScaleQuery {
  q?: string
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'
  limit?: number
  cursor?: string | null
}

const page = z.object({ scales: z.array(scaleRow), nextCursor: z.string().nullable(), count: z.number().int() })
export type ScalePage = z.infer<typeof page>

export function listScales(api: ApiClient, query: ScaleQuery): Promise<ScalePage> {
  return api.get('/product/size-scales', { query: { q: query.q?.trim() || undefined, status: query.status ?? 'ACTIVE', limit: query.limit ?? 50, cursor: query.cursor ?? undefined }, schema: page })
}

export async function countScales(api: ApiClient, query: ScaleQuery): Promise<number> {
  return (await listScales(api, { ...query, limit: 1, cursor: null })).count
}

const one = z.object({ scale: scaleView })

export function getScale(api: ApiClient, scaleId: string): Promise<ScaleView> {
  return api.get(path(scaleId), { schema: one }).then((answer) => answer.scale)
}

export interface SizeInput {
  code: string
  label?: string | null
  bodyMeasures?: BodyMeasures | null
}

export function createScale(api: ApiClient, body: { companyId: string | null; code: string; name: string; sizes: SizeInput[] }): Promise<ScaleView> {
  return api.post('/product/size-scales', { body, schema: one, ...key() }).then((answer) => answer.scale)
}

export function updateScale(api: ApiClient, scale: Pick<ScaleView, 'id' | 'version'>, patch: { code?: string; name?: string }): Promise<ScaleView> {
  return api.request('PATCH', path(scale.id), { body: { ...patch, version: scale.version }, schema: one, ...key() }).then((answer) => answer.scale)
}

export function addSizes(api: ApiClient, scale: Pick<ScaleView, 'id' | 'version'>, sizes: SizeInput[], before: string | null): Promise<ScaleView> {
  return api.post(`${path(scale.id)}/sizes`, { body: { version: scale.version, sizes, ...(before ? { before } : {}) }, schema: one, ...key() }).then((answer) => answer.scale)
}

export function reorderSizes(api: ApiClient, scale: Pick<ScaleView, 'id' | 'version'>, codes: string[]): Promise<ScaleView> {
  return api.request('PUT', `${path(scale.id)}/order`, { body: { version: scale.version, codes }, schema: one, ...key() }).then((answer) => answer.scale)
}

/** A size's label, body measures, code (while unused) or state — on the size's own version. */
export function updateSize(api: ApiClient, scaleId: string, size: Pick<SizeView, 'id' | 'version'>, patch: { code?: string; label?: string | null; bodyMeasures?: BodyMeasures | null; status?: 'ACTIVE' | 'ARCHIVED' }): Promise<ScaleView> {
  return api.request('PATCH', `${path(scaleId)}/sizes/${enc(size.id)}`, { body: { ...patch, version: size.version }, schema: one, ...key() }).then((answer) => answer.scale)
}

export function archiveScale(api: ApiClient, scale: Pick<ScaleRow, 'id' | 'version'>, reason?: string): Promise<ScaleView> {
  return api.post(`${path(scale.id)}/archive`, { body: { version: scale.version, ...(reason ? { reason } : {}) }, schema: one, ...key() }).then((answer) => answer.scale)
}

export function reactivateScale(api: ApiClient, scale: Pick<ScaleRow, 'id' | 'version'>): Promise<ScaleView> {
  return api.post(`${path(scale.id)}/reactivate`, { body: { version: scale.version }, schema: one, ...key() }).then((answer) => answer.scale)
}

const stylePage = z.object({ styles: z.array(styleRow), nextCursor: z.string().nullable(), count: z.number().int() })

/** The styles on this scale, any status (Where used). */
export function stylesOn(api: ApiClient, scaleId: string): Promise<{ styles: StyleRow[]; count: number }> {
  return api.get('/product/styles', { query: { sizeScaleId: scaleId, status: 'ALL', limit: 200 }, schema: stylePage }).then((answer) => ({ styles: answer.styles, count: answer.count }))
}
