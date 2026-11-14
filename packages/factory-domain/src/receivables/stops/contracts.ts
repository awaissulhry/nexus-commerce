import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { MAX_STOP_TEXT, STOP_REASONS, STOP_STATES } from './stops'

/**
 * The contracts of reminder stops (B-W2b-402; FIN-112; design finance.receivables "Held (W2b stop rules)"). No money here.
 * Words are English; the screens draw them from the codes.
 */

const version = () => z.number().int().min(1)
const ref = output({ id: id(), code: z.string(), name: z.string() })
const words = output({ en: z.string(), it: z.string() })
const note = () => z.string().trim().min(1).max(MAX_STOP_TEXT.note)

export const stopParams = input({ stopId: id() })

export const stopsQuery = input({
  companyId: id().optional(),
  partyId: id().optional(),
  invoiceId: id().optional(),
  state: z.enum(STOP_STATES).default('holding'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export const addStopBody = input({ invoiceId: id(), reason: z.enum(STOP_REASONS), until: businessDate().nullish(), note: note().nullish() })
export type AddStopBody = z.infer<typeof addStopBody>

export const changeStopBody = input({ version: version(), until: businessDate().nullish(), note: note().nullish() })
export type ChangeStopBody = z.infer<typeof changeStopBody>

export const liftStopBody = input({ version: version(), reason: z.string().trim().min(1).max(MAX_STOP_TEXT.liftReason).nullish() })
export type LiftStopBody = z.infer<typeof liftStopBody>

export const stopView = output({
  id: id(),
  company: ref,
  customer: ref,
  invoice: output({ id: id(), number: z.string().nullable() }),
  reason: z.enum(STOP_REASONS),
  reasonWords: words,
  until: businessDate().nullable(),
  note: z.string().nullable(),
  state: z.enum(['holding', 'lifted', 'over']),
  /** The reminders waiting for approval it holds now (their ids). */
  holdsReminders: z.array(id()),
  createdAt: instant(),
  createdBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  liftedAt: instant().nullable(),
  liftedBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  liftReason: z.string().nullable(),
  can: output({ change: z.boolean(), lift: z.boolean() }),
  version: z.number().int(),
})

export const stopAnswer = output({ stop: stopView })
export const stopsAnswer = output({ stops: z.array(stopView) })
