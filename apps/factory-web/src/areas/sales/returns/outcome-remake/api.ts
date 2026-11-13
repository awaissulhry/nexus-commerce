import { z } from 'zod'
import { remadeView, remakeView } from '@nexus/factory-domain/sales/fittings/contracts'
import type { ApiClient } from '../../../../lib/api/client'

/** B-W2b-368 (XF1:03) on B-W2b-360's API: the return's made-to-measure units and their remake orders. */
export type RemakeView = z.infer<typeof remakeView>
export type RemakeLine = RemakeView['lines'][number]

const enc = encodeURIComponent

/** GET /sales/returns/:id/remake-order (sales.returns.view). */
export async function readRemake(api: ApiClient, returnId: string, signal?: AbortSignal): Promise<RemakeView> {
  return (await api.get(`/sales/returns/${enc(returnId)}/remake-order`, { schema: z.object({ remake: remakeView }), signal })).remake
}

/** POST /sales/returns/:id/remake-order {version}: every line decided Remake, on the rider's newest revision. */
export async function makeRemakeOrder(api: ApiClient, returnId: string, version: number, idempotencyKey: string): Promise<z.infer<typeof remadeView>> {
  return api.post(`/sales/returns/${enc(returnId)}/remake-order`, { body: { version }, schema: remadeView, idempotencyKey })
}
