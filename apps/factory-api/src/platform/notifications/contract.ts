import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { BULK_MAX, NOTIFICATION_CATEGORIES, NOTIFICATION_STATES, NOTIFICATION_TABS } from '@nexus/factory-domain/notifications/rules'

/**
 * The notification centre's contracts (B-W2a-20; PLT-138, PLT-142, PLT-152; design home.notifications, the bell). A
 * notification's words come as its message key and params (the web's catalogue says them in the person's language) and
 * in English (`sentence`). `params` is grained JSON: an amount in it is marked with its grain and dropped for a reader
 * without it. People are named by id, with their names in `people`.
 */

const notification = output({
  id: id(),
  category: z.enum(NOTIFICATION_CATEGORIES),
  /** The event it came from (`thread.user_mentioned`). */
  eventType: z.string(),
  /** The record it opens (Enter), at `anchor` (`message:<id>`, `task:<id>`, `today:<key>`, `approval:<id>`). */
  record: output({ type: z.string(), id: id(), label: z.string() }),
  companyId: id().nullable(),
  anchor: z.string().nullable(),
  messageKey: z.string(),
  params: grainedJson(),
  sentence: z.string(),
  actor: output({ id: id(), name: z.string() }).nullable(),
  /** The names of the people its params name, by user id. */
  people: z.record(z.string(), z.string()),
  state: z.enum(NOTIFICATION_STATES),
  read: z.boolean(),
  readAt: instant().nullable(),
  doneAt: instant().nullable(),
  /** Snoozed at, until (null: until new activity on the record). */
  snoozed: output({ at: instant(), until: instant().nullable() }).nullable(),
  createdAt: instant(),
  /** The notifications of one record and kind that came close together, shown as this one (its newest). */
  group: output({ key: z.string(), count: z.number().int(), ids: z.array(id()) }),
})

const counts = output({
  /** Unread notifications still to look at (the bell; "4 waiting for you"). */
  unread: z.number().int(),
  /** False: there are more than 1000 (the bell says "1000+"). */
  complete: z.boolean(),
  tabs: z.array(output({ tab: z.enum(NOTIFICATION_TABS), unread: z.number().int() })),
})

const live = output({ events: z.array(z.string()) })

export const listNotificationsContract = defineContract({
  querystring: input({
    tab: z.enum(NOTIFICATION_TABS).default('ALL'),
    /** OPEN (not done, not snoozed now; default), DONE or SNOOZED. */
    state: z.enum(NOTIFICATION_STATES).default('OPEN'),
    /** Only the unread ones. */
    unread: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  response: { 200: output({ asOf: instant(), tab: z.enum(NOTIFICATION_TABS), state: z.enum(NOTIFICATION_STATES), counts, items: z.array(notification), nextCursor: z.string().nullable(), live }) },
})

export const countsContract = defineContract({ response: { 200: output({ asOf: instant(), unread: z.number().int(), complete: z.boolean(), tabs: counts.shape.tabs, live }) } })

const ids = z.array(id()).min(1).max(BULK_MAX)
const changed = { 200: output({ /** How many changed (the others were so already). */ changed: z.number().int(), /** Ids that are not the reader's. */ unknown: z.array(id()) }) }

export const readContract = defineContract({
  body: input({ /** These, or every unread one of a tab (⇧E). */ ids: ids.optional(), tab: z.enum(NOTIFICATION_TABS).optional(), read: z.boolean().default(true) }),
  response: changed,
})
export const doneContract = defineContract({ body: input({ ids, /** False: back on the list (Undo). */ done: z.boolean().default(true) }), response: changed })
export const snoozeContract = defineContract({ body: input({ ids, /** Until then; null: until there is new activity on the record. */ until: instant().nullable() }), response: changed })
export const wakeContract = defineContract({ body: input({ ids }), response: changed })

const digest = output({
  /** Off by default (quiet defaults): nothing is e-mailed until the person turns it on. */
  on: z.boolean(),
  sendTime: z.string(),
  weekdays: z.array(z.number().int()),
  categories: z.array(z.enum(NOTIFICATION_CATEGORIES)),
  /** The language it is written in (the person's); null before it was ever turned on. */
  locale: z.string().nullable(),
  lastSentAt: instant().nullable(),
  /** Send it back with a change (0: never turned on). */
  version: z.number().int(),
})

export const digestContract = defineContract({ response: { 200: output({ digest }) } })
export const saveDigestContract = defineContract({
  body: input({
    on: z.boolean(),
    sendTime: z.string().max(5),
    weekdays: z.array(z.number().int()).min(1).max(7),
    categories: z.array(z.enum(NOTIFICATION_CATEGORIES)).min(1).max(NOTIFICATION_CATEGORIES.length),
    version: z.number().int().min(0),
  }),
  response: { 200: output({ digest }) },
})
