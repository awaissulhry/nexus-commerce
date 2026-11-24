/**
 * Which of a customer's contacts gets which mail BY DEFAULT (customer page › People & addresses, lane ca-, settle Z9) — pure, one
 * rule per kind of mail, each line naming the sender it mirrors. The senders choose their recipients in their own modules (the
 * database reads below); this rule says the same in one place so the office can see it on each person ("Gets …"). A quote's own
 * contact wins over these defaults for ITS mails (its confirmation, its deposit page, its delay notice): the screen says so in words,
 * it is not computed here. The senders adopting this rule is a later job: until then a test holds both ends by name.
 *
 *   QUOTES_AND_CONFIRMATIONS  the OLDEST active ORDERS contact with an e-mail (by when it was added, then id)
 *                             apps/factory-api modules/sales/quotes/quotes.ts (a new quote's contact) ·
 *                             modules/sales/orders-depth/confirmation.ts sendConfirmation (an order without a quote's contact)
 *   SHIPPING_NOTICES          every active ORDERS contact with an e-mail, one per address, by name
 *                             modules/shipping/notices/notices.ts sendNotice · modules/shipping/tracking-link/office.ts recipientsOf
 *   DELAY_NOTICES             up to 3 active ORDERS contacts with an e-mail, by name
 *                             modules/planning/promise-keep/store.ts recipientsOf (`take: 3`)
 *   DEPOSIT_PAGES             the first active INVOICES contact with an e-mail by name, else the first active ORDERS one
 *                             modules/payments/deposit-link.ts orderContactOf
 *   INVOICES_AND_REMINDERS    every active INVOICES contact with an e-mail, by name
 *                             modules/receivables/store.ts invoiceContactsOf · modules/invoicing/sdi/copy.ts sendCourtesyCopy
 *   RECALLS                   the first active QUALITY contact with an e-mail by name, else the first active one with an e-mail
 *                             modules/compliance/recall/distributors.ts (the e-mail channel: QUALITY first, else any)
 *
 * "By name" is the database's order: the name, then the id (code-unit order here). An e-mail is a non-empty address (the contact
 * rule keeps them trimmed, lower case). A contact who is archived or erased (its e-mail blanked) gets nothing by default.
 */

export const CONTACT_MAILS = ['QUOTES_AND_CONFIRMATIONS', 'SHIPPING_NOTICES', 'DELAY_NOTICES', 'DEPOSIT_PAGES', 'INVOICES_AND_REMINDERS', 'RECALLS'] as const
export type ContactMail = (typeof CONTACT_MAILS)[number]

/** How many active ORDERS contacts a delay notice goes to at most (promise-keep's `take: 3`). */
export const DELAY_NOTICE_MAX = 3

export interface MailContact {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly roles: readonly string[]
  readonly status: string
  /** ISO instant the contact was added (the oldest ORDERS contact gets the quotes). */
  readonly createdAt: string
}

const mailable = (contact: MailContact): boolean => contact.status === 'ACTIVE' && contact.email !== null && contact.email.trim() !== ''
const has = (role: string) => (contact: MailContact): boolean => contact.roles.includes(role)
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byName = (a: MailContact, b: MailContact): number => cmp(a.name, b.name) || cmp(a.id, b.id)
const byAdded = (a: MailContact, b: MailContact): number => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id)

/** One contact per e-mail address, the first by name (the shipping notice's own rule: one mail per address). */
function onePerAddress(contacts: readonly MailContact[]): MailContact[] {
  const seen = new Set<string>()
  return contacts.filter((contact) => {
    const email = contact.email!.trim().toLowerCase()
    if (seen.has(email)) return false
    seen.add(email)
    return true
  })
}

/** Who gets each kind of mail by default. */
export function recipientsOfMails(contacts: readonly MailContact[]): Readonly<Record<ContactMail, readonly MailContact[]>> {
  const live = contacts.filter(mailable)
  const orders = live.filter(has('ORDERS'))
  const invoices = live.filter(has('INVOICES')).sort(byName)
  const ordersByName = [...orders].sort(byName)
  const quality = live.filter(has('QUALITY')).sort(byName)
  const oldestOrders = [...orders].sort(byAdded)[0]
  const deposit = invoices[0] ?? ordersByName[0]
  const recall = quality[0] ?? [...live].sort(byName)[0]
  return {
    QUOTES_AND_CONFIRMATIONS: oldestOrders ? [oldestOrders] : [],
    SHIPPING_NOTICES: onePerAddress(ordersByName),
    DELAY_NOTICES: ordersByName.slice(0, DELAY_NOTICE_MAX),
    DEPOSIT_PAGES: deposit ? [deposit] : [],
    INVOICES_AND_REMINDERS: invoices,
    RECALLS: recall ? [recall] : [],
  }
}

/** Every contact's mails by default, in the order of CONTACT_MAILS (a contact who gets none: an empty list). */
export function mailsOfContacts(contacts: readonly MailContact[]): ReadonlyMap<string, readonly ContactMail[]> {
  const recipients = recipientsOfMails(contacts)
  const out = new Map<string, ContactMail[]>(contacts.map((contact) => [contact.id, []]))
  for (const mail of CONTACT_MAILS) for (const contact of recipients[mail]) out.get(contact.id)?.push(mail)
  return out
}
