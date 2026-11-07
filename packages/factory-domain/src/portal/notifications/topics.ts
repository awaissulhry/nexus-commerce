import type { Issue } from '../../core/errors'

/**
 * A partner person's e-mail settings (B-W2b-167; COL-063, PLT-148; SAL-056 is its DUP; design portal.frame E-mail settings,
 * portal.signin first-visit "E-mail summaries", portal.customer.account › E-mail settings). One frequency per person and topic
 * (portal-frame.prisma PartnerEmailPreference; no row: the default below):
 *
 *   INSTANT  as it happens       DAILY  in the daily summary       WEEKLY  in the weekly summary       OFF  not e-mailed
 *
 * The TRANSACTIONAL topics (orders, shipped, invoices: "order, delivery and invoice mail always on") are locked on, as it
 * happens, with the reason "Needed to run your orders": the API never stores another value for them. Everything else is
 * non-essential: a daily summary by default, and one switch (or the unsubscribe link in every mail) turns all of it off
 * (GDPR). Notifications stay in the portal's bell whatever the e-mail settings say.
 */

export const PARTNER_EMAIL_TOPICS = ['ORDERS', 'DATES', 'SHIPPED', 'INVOICES', 'CLAIMS', 'DOCUMENTS', 'MESSAGES', 'REMINDERS'] as const
export type PartnerEmailTopic = (typeof PARTNER_EMAIL_TOPICS)[number]
export const PARTNER_EMAIL_FREQUENCIES = ['INSTANT', 'DAILY', 'WEEKLY', 'OFF'] as const
export type PartnerEmailFrequency = (typeof PARTNER_EMAIL_FREQUENCIES)[number]

export const TRANSACTIONAL_TOPICS: readonly PartnerEmailTopic[] = Object.freeze(['ORDERS', 'SHIPPED', 'INVOICES'])
export const isTransactional = (topic: PartnerEmailTopic): boolean => TRANSACTIONAL_TOPICS.includes(topic)
export const NON_ESSENTIAL_TOPICS: readonly PartnerEmailTopic[] = Object.freeze(PARTNER_EMAIL_TOPICS.filter((topic) => !isTransactional(topic)))

/** A transactional topic's one frequency; a non-essential topic's default (no row). */
export const TRANSACTIONAL_FREQUENCY: PartnerEmailFrequency = 'INSTANT'
export const DEFAULT_FREQUENCY: PartnerEmailFrequency = 'DAILY'

export const LOCKED_REASON = { it: 'Servono per gestire i tuoi ordini.', en: 'Needed to run your orders.' } as const

export const TOPIC_WORDS: Readonly<Record<PartnerEmailTopic, { readonly it: string; readonly en: string }>> = Object.freeze({
  ORDERS: { it: 'Ordini confermati', en: 'Orders confirmed' },
  DATES: { it: 'Date cambiate', en: 'Dates changed' },
  SHIPPED: { it: 'Spedizioni', en: 'Shipped' },
  INVOICES: { it: 'Fatture', en: 'Invoices' },
  CLAIMS: { it: 'Reclami', en: 'Claims' },
  DOCUMENTS: { it: 'Documenti pronti', en: 'Documents ready' },
  MESSAGES: { it: 'Messaggi', en: 'Messages' },
  REMINDERS: { it: 'Promemoria', en: 'Reminders' },
})

export const isTopic = (value: unknown): value is PartnerEmailTopic => typeof value === 'string' && (PARTNER_EMAIL_TOPICS as readonly string[]).includes(value)
export const isFrequency = (value: unknown): value is PartnerEmailFrequency => typeof value === 'string' && (PARTNER_EMAIL_FREQUENCIES as readonly string[]).includes(value)

/** How often a topic reaches the person: a transactional one always as it happens; else the stored row, else daily. */
export function frequencyOf(topic: PartnerEmailTopic, stored: ReadonlyMap<PartnerEmailTopic, PartnerEmailFrequency>): PartnerEmailFrequency {
  if (isTransactional(topic)) return TRANSACTIONAL_FREQUENCY
  return stored.get(topic) ?? DEFAULT_FREQUENCY
}

/** Every topic with its frequency, whether it is locked, and whether it is the default (no row). */
export function settingsOf(stored: ReadonlyMap<PartnerEmailTopic, PartnerEmailFrequency>) {
  return PARTNER_EMAIL_TOPICS.map((topic) => ({ topic, frequency: frequencyOf(topic, stored), locked: isTransactional(topic), stored: !isTransactional(topic) && stored.has(topic) }))
}

/** All non-essential mail is off (the one switch, or the unsubscribe link). */
export const allNonEssentialOff = (stored: ReadonlyMap<PartnerEmailTopic, PartnerEmailFrequency>): boolean => NON_ESSENTIAL_TOPICS.every((topic) => frequencyOf(topic, stored) === 'OFF')

export interface SettingsChange {
  /** Per topic. A transactional topic may be sent only as INSTANT (it changes nothing). */
  readonly topics?: readonly { readonly topic: PartnerEmailTopic; readonly frequency: PartnerEmailFrequency }[] | undefined
  /** One frequency for every non-essential topic (the first visit's "E-mail summaries"; OFF = unsubscribe from all). */
  readonly nonEssential?: PartnerEmailFrequency | undefined
}

/** What is wrong with a change: a transactional topic set to anything but as it happens, a topic named twice, nothing asked. */
export function changeProblems(change: SettingsChange): Issue[] {
  const problems: Issue[] = []
  if ((change.topics?.length ?? 0) === 0 && change.nonEssential === undefined) problems.push({ path: 'body', message: 'Name the topics to change, or one frequency for all non-essential mail.' })
  const seen = new Set<string>()
  for (const [index, entry] of (change.topics ?? []).entries()) {
    if (seen.has(entry.topic)) problems.push({ path: `body/topics/${index}/topic`, message: 'Each topic once.' })
    seen.add(entry.topic)
    if (isTransactional(entry.topic) && entry.frequency !== TRANSACTIONAL_FREQUENCY) {
      problems.push({ path: `body/topics/${index}/frequency`, message: `Order, delivery and invoice mail is always sent as it happens: ${LOCKED_REASON.en.toLowerCase()}` })
    }
  }
  return problems
}

/** The non-essential rows a change writes (topic → frequency), after `nonEssential` and then the per-topic entries. */
export function rowsOfChange(change: SettingsChange): Map<PartnerEmailTopic, PartnerEmailFrequency> {
  const rows = new Map<PartnerEmailTopic, PartnerEmailFrequency>()
  if (change.nonEssential !== undefined) for (const topic of NON_ESSENTIAL_TOPICS) rows.set(topic, change.nonEssential)
  for (const entry of change.topics ?? []) if (!isTransactional(entry.topic)) rows.set(entry.topic, entry.frequency)
  return rows
}
