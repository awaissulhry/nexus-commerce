import { z } from 'zod'
import { OPTION_GROUP_TAKES } from '@nexus/factory-domain/product/options/takes'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * What a chosen value of an option group takes (B-W2b-374; XF3:05): GET and PUT /product/option-groups/:groupId/takes
 * (product.styles.view to read, product.options.manage to change; the group's version guards the change).
 */

const enc = encodeURIComponent
const words = z.object({ it: z.string(), en: z.string() })

export const takesSchema = z.object({
  groupId: z.string(),
  code: z.string(),
  version: z.number(),
  takes: z.enum(OPTION_GROUP_TAKES).nullable(),
  picking: z.object({ colours: z.number(), materials: z.number() }),
  may: z.object({ change: z.boolean(), held: words.nullable() }),
})
export type TakesView = z.infer<typeof takesSchema>
export type Takes = TakesView['takes']

export function readTakes(api: ApiClient, groupId: string, signal?: AbortSignal): Promise<TakesView> {
  return api.get(`/product/option-groups/${enc(groupId)}/takes`, { schema: takesSchema, signal })
}

export function saveTakes(api: ApiClient, groupId: string, version: number, takes: Takes, idempotencyKey = newIdempotencyKey()): Promise<TakesView> {
  return api.request('PUT', `/product/option-groups/${enc(groupId)}/takes`, { body: { version, takes }, schema: takesSchema, idempotencyKey })
}
