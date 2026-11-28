import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { ORDER_LIFE } from '../order-life'
import { LOG_SUBJECT_KINDS } from './build'
import { ORDER_LOG_ACTIONS, WHO_FACES } from './faces'

/**
 * The ONE answer shape of the order log (owb- order workflow, b3.1; the Shapes the web builders code against — a change is told
 * to the base lead first). Four routes answer it: office GET /sales/orders/:orderId/log and /sales/order-requests/:requestId/log,
 * portal GET /portal/sales-orders/:orderId/log and /portal/order-requests/:requestId/log.
 */

export const LOG_PAGE_MAX = 100
export const LOG_PAGE_DEFAULT = 50

/** ?cursor=&limit= of every log route. */
export const orderLogQuery = input({
  cursor: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(LOG_PAGE_MAX).default(LOG_PAGE_DEFAULT),
})

const life = z.enum(ORDER_LIFE)

export const logValueSchema = z.discriminatedUnion('kind', [
  output({ kind: z.literal('LIFE'), life }),
  output({ kind: z.literal('DEPT'), no: z.number().int() }),
  output({ kind: z.literal('DATE'), date: z.string() }),
  output({ kind: z.literal('TEXT'), text: z.string() }),
  output({ kind: z.literal('COUNT'), n: z.number().int() }),
  output({ kind: z.literal('PICTURE'), fileId: id().nullable() }),
])

export const orderLogRowSchema = output({
  id: id(),
  at: instant(),
  who: output({ face: z.enum(WHO_FACES), name: z.string().nullable(), departmentNo: z.number().int().nullable() }),
  /** An ORDER_LOG_ACTIONS key (the web's words `action.<KEY>`). */
  action: z.enum(ORDER_LOG_ACTIONS),
  /** ONE lucide icon id. */
  icon: z.string(),
  subject: output({ kind: z.enum(LOG_SUBJECT_KINDS), label: z.string().nullable() }),
  from: logValueSchema.nullable(),
  to: logValueSchema.nullable(),
  /** The office's only; always null in a portal answer. */
  reason: z.string().nullable(),
})

export const orderLogAnswerSchema = output({
  rows: z.array(orderLogRowSchema),
  nextCursor: z.string().nullable(),
})
export type OrderLogAnswerView = z.infer<typeof orderLogAnswerSchema>

/** POST …/picture's body: the file (null: back to the default, the first line's design) and the record's version. */
export const pictureSetBody = input({
  fileId: id().nullable(),
  version: z.number().int().min(1),
})

/** POST …/picture's answer. */
export const pictureSetAnswer = output({
  pictureFileId: id().nullable(),
  pictureSetAt: instant().nullable(),
  version: z.number().int(),
})
