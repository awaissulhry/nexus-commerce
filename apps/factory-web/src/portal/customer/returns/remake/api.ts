import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import type { RemakeBody } from './model'

/**
 * A remake asked from the portal (B-W2b-346; apps/factory-api modules/sales/returns-outcomes `POST /portal/returns/remake`):
 * the return request it made (its id) and the end's numbers. One Idempotency-Key per body, as the start's other asks.
 */

const words = z.object({ it: z.string(), en: z.string() })
const sentSchema = z.object({ number: z.string(), answerBy: z.string().nullable(), words })

export const requestRemake = (api: ApiClient, body: RemakeBody, idempotencyKey: string): Promise<{ id: string; sent: z.infer<typeof sentSchema> }> =>
  api.post('/portal/returns/remake', { body, schema: z.object({ return: z.object({ id: z.string() }), sent: sentSchema }), idempotencyKey }).then((read) => ({ id: read.return.id, sent: read.sent }))
