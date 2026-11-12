import type { Issue } from '../../core/errors'
import type { ContactRole } from '../../parties/contacts'

/**
 * Contacts by what they receive (B-W2b-311; SCM-004; the column is B-W2b-287's PartyContact.receives; design
 * purchasing.suppliers › Contacts "Contacts and what they receive"): each mail we send a supplier goes to its contacts
 * that receive that kind, as the supplier asked. Pure.
 *
 *   PO          purchase orders and their changes, the confirm link and its reminders
 *   CLAIM       claims about its deliveries
 *   REMITTANCE  remittance advices of our payments
 *   QUALITY     inspection results, nonconformances, 8Ds
 *   DOCUMENT    requests for documents (certificates, declarations, the questionnaire) and their expiry
 *
 * A contact receives a kind only while ACTIVE with an e-mail. When no contact of the supplier receives a kind by this
 * routing (every supplier before W2b: no backfill), the W1 contact roles stand in, best first: PO → ORDERS; CLAIM →
 * QUALITY, then ORDERS (W1's claims order); REMITTANCE → INVOICES; QUALITY → QUALITY; DOCUMENT → QUALITY, then ORDERS.
 */

export const CONTACT_RECEIVES = ['PO', 'CLAIM', 'REMITTANCE', 'QUALITY', 'DOCUMENT'] as const
export type ContactReceives = (typeof CONTACT_RECEIVES)[number]

export const RECEIVES_WORDS: Readonly<Record<ContactReceives, string>> = Object.freeze({
  PO: 'purchase orders',
  CLAIM: 'claims',
  REMITTANCE: 'remittance advices',
  QUALITY: 'quality mail',
  DOCUMENT: 'document requests',
})

/** The W1 contact roles a kind falls back to when no contact receives it by routing, best first. */
export const FALLBACK_ROLES: Readonly<Record<ContactReceives, readonly ContactRole[]>> = Object.freeze({
  PO: ['ORDERS'],
  CLAIM: ['QUALITY', 'ORDERS'],
  REMITTANCE: ['INVOICES'],
  QUALITY: ['QUALITY'],
  DOCUMENT: ['QUALITY', 'ORDERS'],
})

export const isContactReceives = (value: unknown): value is ContactReceives => (CONTACT_RECEIVES as readonly unknown[]).includes(value)

/** Each kind once, in the enum's order. */
export const normaliseReceives = (receives: readonly string[]): ContactReceives[] => CONTACT_RECEIVES.filter((kind) => receives.includes(kind))

export function receivesProblems(receives: readonly string[], contact: { readonly email: string | null; readonly status: string }): Issue[] {
  if (receives.some((kind) => !isContactReceives(kind))) return [{ path: 'receives', message: `Expected kinds from ${CONTACT_RECEIVES.join(', ')}.` }]
  if (receives.length > 0 && !contact.email) return [{ path: 'receives', message: 'Give the contact an e-mail first: what they receive goes by e-mail.' }]
  if (receives.length > 0 && contact.status !== 'ACTIVE') return [{ path: 'receives', message: 'The contact is archived: restore them first.' }]
  return []
}

export interface RoutableContact {
  readonly id: string
  readonly status: string
  readonly email: string | null
  readonly roles: readonly string[]
  /** Left out: an older read without the column (none by routing). */
  readonly receives?: readonly string[] | undefined
}

/** Who gets a kind of mail and why: by what they receive, by their W1 role, or nobody. */
export interface Routing<Contact> {
  readonly kind: ContactReceives
  readonly by: 'RECEIVES' | 'ROLE' | 'NONE'
  /** In order: the first is the one a single-recipient mail goes to (the order's contact). */
  readonly contacts: readonly Contact[]
}

const usable = (contact: RoutableContact): boolean => contact.status === 'ACTIVE' && contact.email !== null && contact.email !== ''

/** The contacts a kind of mail goes to (see the module comment), in the order given within each rank. */
export function routeMail<Contact extends RoutableContact>(kind: ContactReceives, contacts: readonly Contact[]): Routing<Contact> {
  const open = contacts.filter(usable)
  const receivers = open.filter((contact) => (contact.receives ?? []).includes(kind))
  if (receivers.length > 0) return { kind, by: 'RECEIVES', contacts: receivers }
  const roles = FALLBACK_ROLES[kind]
  const rank = (contact: Contact) => {
    const index = roles.findIndex((role) => contact.roles.includes(role))
    return index < 0 ? roles.length : index
  }
  const fallback = open.filter((contact) => rank(contact) < roles.length)
  if (fallback.length === 0) return { kind, by: 'NONE', contacts: [] }
  // A stable sort: the same rank keeps the order given.
  return { kind, by: 'ROLE', contacts: fallback.map((contact, index) => ({ contact, index })).sort((a, b) => rank(a.contact) - rank(b.contact) || a.index - b.index).map((entry) => entry.contact) }
}

/** A contact a purchase order may go to: one who receives POs, or (W1) one with the ORDERS role. */
export const takesOrders = (contact: { readonly roles: readonly string[]; readonly receives?: readonly string[] | undefined }): boolean =>
  (contact.receives ?? []).includes('PO') || contact.roles.includes('ORDERS')

/** The other contacts who receive the kind by routing, for the copies of a mail to `to` (their e-mails, each once). */
export function copiesOf<Contact extends RoutableContact>(kind: ContactReceives, contacts: readonly Contact[], to: string | null): string[] {
  const routing = routeMail(kind, contacts)
  if (routing.by !== 'RECEIVES') return []
  const seen = new Set<string>(to ? [to.toLowerCase()] : [])
  const out: string[] = []
  for (const contact of routing.contacts) {
    const email = contact.email!.toLowerCase()
    if (!seen.has(email)) {
      seen.add(email)
      out.push(email)
    }
  }
  return out
}

/** One line per kind for the supplier's record: who gets it and why ("Purchase orders go to 2 contacts by what they receive"). */
export function routingSentence(routing: Routing<{ readonly name: string }>): string {
  const what = RECEIVES_WORDS[routing.kind]
  const words = what.charAt(0).toUpperCase() + what.slice(1)
  if (routing.by === 'NONE') return `${words} cannot be e-mailed: no active contact with an e-mail receives them.`
  const names = routing.contacts.map((contact) => contact.name).join(', ')
  return routing.by === 'RECEIVES' ? `${words} go to ${names} (what they receive).` : `${words} go to ${names} (by their role: nobody receives them by routing yet).`
}

/**
 * The order a kind's mail offers a supplier's contacts in (a claim's recipients, a letter's addressee): those who receive
 * the kind by routing first, then W1's fallback roles in their order, then the rest. Lower first; a sort key.
 */
export function recipientRank(kind: ContactReceives, contact: { readonly roles: readonly string[]; readonly receives?: readonly string[] | undefined }): number {
  if ((contact.receives ?? []).includes(kind)) return 0
  const roles = FALLBACK_ROLES[kind]
  const index = roles.findIndex((role) => contact.roles.includes(role))
  return index < 0 ? roles.length + 1 : index + 1
}
