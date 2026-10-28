import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from './client'

/**
 * A one-off link (apps/factory-api platform/links): `POST /link/open` with the token in `x-factory-link` and an
 * Idempotency-Key. The API answers what the link opens and what its holder may answer — or ONE 404
 * (`LINK_UNAVAILABLE`) whatever was wrong (revoked, used up, expired, unknown), so a link never tells a stranger why.
 */
export const openedLinkSchema = z.object({
  link: z.object({
    purpose: z.string(),
    record: z.object({ type: z.string(), id: z.string() }),
    expiresAt: z.string(),
    usesLeft: z.number(),
    answers: z.array(
      z.object({
        action: z.string(),
        typedName: z.enum(['required', 'optional', 'none']),
        email: z.boolean(),
      }),
    ),
  }),
})
export type OpenedLink = z.infer<typeof openedLinkSchema>['link']

export async function openLink(api: ApiClient): Promise<OpenedLink> {
  const answer = await api.post('/link/open', { body: {}, schema: openedLinkSchema, idempotencyKey: newIdempotencyKey() })
  return answer.link
}
