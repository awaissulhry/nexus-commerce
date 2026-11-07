import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PARTNER_EMAIL_FREQUENCIES, PARTNER_EMAIL_TOPICS } from '@nexus/factory-domain/portal/notifications/topics'
import { READ_MAX } from './inbox'

/**
 * The partner's bell and e-mail settings (B-W2b-167; PLT-148, COL-063). A notification's sentence comes in both languages;
 * never an amount, never an office person. The unsubscribe routes take the mail link's token in the body (never a query).
 */

const words = output({ it: z.string(), en: z.string() })
const live = output({ events: z.array(z.string()) })

const notification = output({
  id: id(),
  category: z.string(),
  eventType: z.string(),
  record: output({ type: z.string(), id: id(), label: z.string() }),
  messageKey: z.string(),
  sentence: words,
  /** The record's page in the portal, at the tab or row (`/p/<party>/open/<type>/<id>#task:<id>`). */
  link: z.string(),
  read: z.boolean(),
  createdAt: instant(),
  group: output({ key: z.string(), count: z.number().int(), ids: z.array(id()) }),
})

export const portalNotificationsContract = defineContract({
  querystring: input({
    unread: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
  response: { 200: output({ asOf: instant(), unread: z.number().int(), complete: z.boolean(), items: z.array(notification), nextCursor: z.string().nullable(), live }) },
})

export const portalCountsContract = defineContract({ response: { 200: output({ asOf: instant(), unread: z.number().int(), complete: z.boolean(), live }) } })

export const portalReadContract = defineContract({
  body: input({ ids: z.array(id()).min(1).max(READ_MAX).optional(), /** Every unread one ("Mark all as read"). */ all: z.boolean().optional(), read: z.boolean().default(true) }),
  response: { 200: output({ changed: z.number().int(), unknown: z.array(id()) }) },
})

const topic = z.enum(PARTNER_EMAIL_TOPICS)
const frequency = z.enum(PARTNER_EMAIL_FREQUENCIES)
const settings = output({
  topics: z.array(output({ topic, frequency, /** Order, delivery and invoice mail: always on, as it happens. */ locked: z.boolean(), /** Chosen by the person (else the default: daily). */ stored: z.boolean(), words, reason: words.nullable() })),
  /** Every non-essential topic is off (the one switch, or the unsubscribe link). */
  nonEssentialOff: z.boolean(),
})

export const readSettingsContract = defineContract({ response: { 200: settings } })
export const saveSettingsContract = defineContract({
  body: input({
    topics: z.array(input({ topic, frequency })).max(PARTNER_EMAIL_TOPICS.length).optional(),
    /** One frequency for every non-essential topic (the first visit's summaries; OFF: no non-essential mail). */
    nonEssential: frequency.optional(),
  }),
  response: { 200: settings },
})

const token = input({ token: z.string().min(1).max(200) })
export const unsubscribePreviewContract = defineContract({
  body: token,
  response: { 200: output({ email: z.string(), topics: z.array(output({ topic, words })), alreadyOff: z.boolean(), keeps: words }) },
})
export const unsubscribeContract = defineContract({ body: token, response: { 200: output({ email: z.string(), unsubscribed: z.boolean(), keeps: words }) } })
