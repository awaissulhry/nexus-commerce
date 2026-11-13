import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { curveSchema, listCurves, type SizeCurve } from '../../quotes/record/lines-depth/api'

/**
 * Sales settings › Size curves (B-W2b-316 on B-W2b-302's /sales/size-curves; SAL-269): the curves (active, archived, all),
 * a new one or a change — shares in percent per size code of the scale, totalling exactly 100 — and archive / restore all
 * or none; the size scales a new curve picks from (product.styles.view). No money.
 */

export { listCurves, type SizeCurve }

const one = z.object({ curve: curveSchema })

export async function createCurve(api: ApiClient, body: { companyId: string | null; sizeScaleId: string; name: string; shares: Record<string, string> }): Promise<SizeCurve> {
  return (await api.post('/sales/size-curves', { body, schema: one, idempotencyKey: newIdempotencyKey() })).curve
}

export async function updateCurve(api: ApiClient, curve: Pick<SizeCurve, 'id' | 'version'>, patch: { name?: string; shares?: Record<string, string> }): Promise<SizeCurve> {
  return (await api.request('PATCH', `/sales/size-curves/${encodeURIComponent(curve.id)}`, { body: { version: curve.version, ...patch }, schema: one, idempotencyKey: newIdempotencyKey() })).curve
}

export async function setCurvesStatus(api: ApiClient, curves: ReadonlyArray<Pick<SizeCurve, 'id' | 'version'>>, status: 'ACTIVE' | 'ARCHIVED'): Promise<SizeCurve[]> {
  return (await api.post('/sales/size-curves/status', { body: { curves: curves.map((curve) => ({ id: curve.id, version: curve.version })), status }, schema: z.object({ curves: z.array(curveSchema) }), idempotencyKey: newIdempotencyKey() })).curves
}

const scaleSchema = z.object({ id: z.string(), companyId: z.string().nullable(), code: z.string(), name: z.string(), codes: z.array(z.string()), status: z.string() })
export type SizeScaleRow = z.infer<typeof scaleSchema>

export async function listScales(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<SizeScaleRow[]> {
  return (await api.get('/product/size-scales', { query: { companyId: companyId ?? undefined, status: 'ACTIVE', limit: 200 }, schema: z.object({ scales: z.array(scaleSchema) }), signal })).scales
}
