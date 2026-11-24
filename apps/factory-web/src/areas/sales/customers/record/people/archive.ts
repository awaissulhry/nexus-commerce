import { mailsOfContacts } from '@nexus/factory-domain/parties/contact-mails'
import type { Address, Contact } from '../../../../parties/_shared/api'
import { invoiceAddressOf, registeredOffices } from './addresses'
import type { AddressUsage, ContactUsage } from './api'
import { said, type Said } from './model'

/**
 * F-CA-216 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-w2 W2.4; 10-design §6 windows 2 and 3; P14) — what archiving a contact
 * or an address would change, pure: ONLY what is true from the data already read (the party, the portal, the usage read of D3). The
 * windows warn, never refuse (the server allows every archive); Restore brings it back.
 */

export interface ArchiveWarning {
  readonly tone: 'info' | 'warning' | 'danger'
  readonly words: Said
}

const contactsOf = (contacts: readonly Contact[]) => contacts.map((contact) => ({ id: contact.id, name: contact.name, email: contact.email, roles: contact.roles, status: contact.status, createdAt: contact.createdAt }))

export interface ContactArchiveFacts {
  readonly contact: Contact
  readonly contacts: readonly Contact[]
  readonly customer: string
  /** The person signs in to the portal (or is invited), as the reader may see it; null: not shown or none. */
  readonly portal: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | null
  /** The customer's named production approver in the portal. */
  readonly approver: boolean
  readonly usage: ContactUsage | null
}

/** Archive {name}? — who gets its mails after (the mail rule run without it), its portal access, the open quotes that name it. */
export function contactArchiveWarnings(facts: ContactArchiveFacts): ArchiveWarning[] {
  const now = mailsOfContacts(contactsOf(facts.contacts)).get(facts.contact.id) ?? []
  const others = facts.contacts.filter((contact) => contact.id !== facts.contact.id)
  const after = mailsOfContacts(contactsOf(others))
  const nextOf = (mail: 'QUOTES_AND_CONFIRMATIONS' | 'INVOICES_AND_REMINDERS') => others.filter((contact) => (after.get(contact.id) ?? []).includes(mail)).map((contact) => contact.name)
  const out: ArchiveWarning[] = []
  if (now.includes('QUOTES_AND_CONFIRMATIONS')) {
    const next = nextOf('QUOTES_AND_CONFIRMATIONS')
    out.push(next.length > 0 ? { tone: 'warning', words: said('archive.contact.quotesNext', { params: { name: next[0]! } }) } : { tone: 'danger', words: said('archive.contact.quotesNobody') })
  }
  if (now.includes('INVOICES_AND_REMINDERS')) {
    const next = nextOf('INVOICES_AND_REMINDERS')
    out.push(next.length > 0 ? { tone: 'warning', words: said('archive.contact.invoicesStill', { lists: { names: next } }) } : { tone: 'danger', words: said('archive.contact.invoicesNobody') })
  }
  if (facts.portal) out.push({ tone: 'warning', words: said(facts.portal === 'INVITED' ? 'archive.contact.invited' : 'archive.contact.signsIn') })
  if (facts.approver) out.push({ tone: 'warning', words: said('archive.contact.approver') })
  if (facts.usage && facts.usage.openQuotes > 0) {
    const next = nextOf('QUOTES_AND_CONFIRMATIONS')
    out.push(next.length > 0 ? { tone: 'info', words: said('archive.contact.openQuotes', { params: { count: facts.usage.openQuotes, name: next[0]! } }) } : { tone: 'warning', words: said('archive.contact.openQuotesNobody', { params: { count: facts.usage.openQuotes } }) })
  }
  out.push({ tone: 'info', words: said('archive.contact.mailIn', { params: { customer: facts.customer } }) })
  return out
}

export interface AddressArchiveFacts {
  readonly address: Address
  readonly addresses: readonly Address[]
  readonly usage: AddressUsage | null
}

/** Archive "{address}"? — its defaults, the e-invoices (the invoicing rule run without it), the draft quotes and shipments that name it. */
export function addressArchiveWarnings(facts: AddressArchiveFacts): ArchiveWarning[] {
  const { address } = facts
  const out: ArchiveWarning[] = [{ tone: 'info', words: said('archive.address.copies') }]
  if (address.isDefaultShipTo) out.push({ tone: 'warning', words: said('archive.address.shipTo') })
  if (address.isDefaultBillTo) out.push({ tone: 'warning', words: said('archive.address.billTo') })
  if (invoiceAddressOf(facts.addresses)?.id === address.id) {
    const rest = facts.addresses.filter((other) => other.id !== address.id)
    const next = invoiceAddressOf(rest)
    out.push(next ? { tone: 'warning', words: said(registeredOffices(rest).length > 0 ? 'archive.address.einvoiceOther' : 'archive.address.einvoiceBillTo', { params: { city: next.city } }) } : { tone: 'danger', words: said('archive.address.einvoiceNone') })
  }
  if (facts.usage && facts.usage.draftQuoteVersions > 0) out.push({ tone: 'warning', words: said('archive.address.draftQuotes', { params: { count: facts.usage.draftQuoteVersions } }) })
  if (facts.usage && facts.usage.preparedShipments > 0) out.push({ tone: 'info', words: said('archive.address.shipments', { params: { count: facts.usage.preparedShipments } }) })
  return out
}
