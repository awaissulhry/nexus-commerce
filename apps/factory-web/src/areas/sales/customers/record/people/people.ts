import { MAILED_CONTACT_ROLES, normaliseEmail } from '@nexus/factory-domain/parties/contacts'
import type { ContactMail } from '@nexus/factory-domain/parties/contact-mails'
import type { Contact } from '../../../../parties/_shared/api'
import type { PartnerPerson, PortalAccess } from '../../../../admin/users/partners/api'
import { inviteHeld, type PartnerCan, type RowAction } from '../../../../admin/users/partners/model'
import type { PrivacyContact } from '../../depth/api'
import type { ContactUsage } from './api'
import { ACCESS_ENDS_WITHIN_DAYS, daysUntil, personAnchor, said, type PeopleCan, type Said } from './model'

/**
 * F-CA-103 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §5.1; 18-lead-settles Z1, Z7, Z13) — the People section's rows,
 * pure: ONE row per person. A contact and a portal person are the same person when their e-mail is exactly the same (trimmed, lower
 * case) — both lists are THIS customer's (the party read, the portal read of this party), never another's; a typo in an e-mail shows two
 * rows (honest). The personal-data state comes by the contact's id (the privacy read). A portal person who is no contact is "Portal
 * only"; an erased contact is "Erased contact" with nothing to edit. Each row's ⋯ holds only the acts the reader has the right for (an
 * act without its right is HIDDEN); a state holds an act with words (no e-mail, seats full, the portal terms not published, the
 * customer archived, the person erased or gone).
 */

export interface PersonRow {
  /** `c-<contactId>` or `u-<portal user id>` (a portal-only person). */
  readonly id: string
  readonly contact: Contact | null
  /** The portal person of the same e-mail (null: none, or the portal is not read / not shown to the reader). */
  readonly portal: PartnerPerson | null
  readonly privacy: PrivacyContact | null
  /** The contact was erased (its name, e-mail and phone blanked for good). */
  readonly erased: boolean
  /** The contact is archived (not erased). */
  readonly archived: boolean
  /** A portal-only person who left (deactivated). */
  readonly left: boolean
  /** What the contact gets by e-mail by default (the domain's mail rule). */
  readonly mails: readonly ContactMail[]
  /** An active contact whose role is mailed (orders, invoices, quality) and who has no e-mail: gets nothing. */
  readonly noMail: boolean
  /** The customer's production approver in the portal (the limits read). */
  readonly approver: boolean
  /** Invited, and the invitation is no longer open (it expired). */
  readonly expired: boolean
  /** Days until the access ends, when it ends within 14 days and is not over (null: no end soon). */
  readonly endsIn: number | null
  /** An active contact with no lawful basis recorded (only once the privacy read is in). */
  readonly basisMissing: boolean
  /** What the contact is used on (the usage read); null: not read, failed, or nothing. */
  readonly usage: ContactUsage | null
  /** A portal-only person with the name of a contact here: probably the same person under another e-mail. */
  readonly sameName: string | null
}

export interface PeopleInput {
  readonly contacts: readonly Contact[]
  /** The portal people of THIS customer (null: not read, failed, or not shown to the reader). */
  readonly portal: readonly PartnerPerson[] | null
  /** The contacts' personal data (null: not read yet, or failed). */
  readonly privacy: readonly PrivacyContact[] | null
  readonly mails: ReadonlyMap<string, readonly ContactMail[]>
  readonly usage: readonly ContactUsage[] | null
  /** The portal user who approves production (null: anyone, or not read). */
  readonly approverId: string | null
  /** ISO now (the end of access, the expired invitation). */
  readonly now: string
}

const keyOf = (email: string | null | undefined): string | null => normaliseEmail(email)
const nameKey = (name: string): string => name.trim().toLocaleLowerCase()
const MAILED: readonly string[] = MAILED_CONTACT_ROLES

/** Every person of the customer, joined (the toggles decide which are SHOWN: `shownPeople`). */
export function peopleRows(input: PeopleInput): PersonRow[] {
  const privacyOf = new Map((input.privacy ?? []).map((row) => [row.id, row]))
  const usageOf = new Map((input.usage ?? []).map((row) => [row.contactId, row]))
  const people = input.portal ?? []
  // A portal person joins ONE contact: the active one of its e-mail, else the first archived one.
  const byEmail = new Map<string, PartnerPerson>()
  for (const person of people) {
    const key = keyOf(person.email)
    if (key && !byEmail.has(key)) byEmail.set(key, person)
  }
  const joined = new Set<string>()
  const contactOf = new Map<string, PartnerPerson>()
  for (const pass of ['ACTIVE', 'ARCHIVED'] as const)
    for (const contact of input.contacts) {
      if (contact.status !== pass) continue
      const key = keyOf(contact.email)
      const person = key ? byEmail.get(key) : undefined
      if (!person || joined.has(person.id)) continue
      joined.add(person.id)
      contactOf.set(contact.id, person)
    }
  const portalFacts = (person: PartnerPerson | null) => {
    if (!person) return { approver: false, expired: false, endsIn: null }
    const days = person.status === 'DEACTIVATED' ? null : daysUntil(person.accessUntil, input.now)
    return {
      approver: input.approverId !== null && person.id === input.approverId && person.status !== 'DEACTIVATED',
      expired: person.status === 'INVITED' && person.invitation === null,
      endsIn: days !== null && days > 0 && days <= ACCESS_ENDS_WITHIN_DAYS ? days : null,
    }
  }
  const contactRows: PersonRow[] = input.contacts.map((contact) => {
    const privacy = privacyOf.get(contact.id) ?? null
    // While the privacy read is out, a contact with no name is an erased one (a name is 1–120 characters otherwise).
    const erased = privacy ? privacy.erased : contact.name.trim() === ''
    const active = contact.status === 'ACTIVE' && !erased
    const portal = contactOf.get(contact.id) ?? null
    return {
      id: `c-${contact.id}`,
      contact,
      portal,
      privacy,
      erased,
      archived: contact.status === 'ARCHIVED' && !erased,
      left: false,
      mails: active ? (input.mails.get(contact.id) ?? []) : [],
      noMail: active && !contact.email && contact.roles.some((role) => MAILED.includes(role)),
      ...portalFacts(portal),
      basisMissing: active && privacy !== null && privacy.lawfulBasis === null,
      usage: usageOf.get(contact.id) ?? null,
      sameName: null,
    }
  })
  const contactNames = new Map(input.contacts.filter((contact) => contact.status === 'ACTIVE' && contact.name.trim() !== '').map((contact) => [nameKey(contact.name), contact.name]))
  const portalRows: PersonRow[] = people
    .filter((person) => !joined.has(person.id))
    .map((person) => ({
      id: `u-${person.id}`,
      contact: null,
      portal: person,
      privacy: null,
      erased: false,
      archived: false,
      left: person.status === 'DEACTIVATED',
      mails: [],
      noMail: false,
      ...portalFacts(person),
      basisMissing: false,
      usage: null,
      sameName: contactNames.get(nameKey(person.displayName)) ?? null,
    }))
  return [...contactRows, ...portalRows]
}

/** A person who counts as "here now": an active contact, or a portal-only person who has not left. */
export const isLive = (row: PersonRow): boolean => (row.contact ? row.contact.status === 'ACTIVE' && !row.erased : !row.left)

/**
 * The rows shown: archived contacts (an erased one is archived too) only with "Show archived contacts", people who left only with
 * "Show people who left"; live rows first, each group by name.
 */
export function shownPeople(rows: readonly PersonRow[], show: { readonly archived: boolean; readonly left: boolean }): PersonRow[] {
  const rank = (row: PersonRow) => (isLive(row) ? 0 : 1)
  const nameOf = (row: PersonRow) => row.contact?.name ?? row.portal?.displayName ?? ''
  return rows
    .filter((row) => (row.contact ? isLive(row) || show.archived : !row.left || show.left))
    .sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)))
}

/** How many rows each toggle brings back (the head ⋯ says it: "Show archived contacts (2)"). */
export const hiddenCounts = (rows: readonly PersonRow[]): { readonly archived: number; readonly left: number } => ({
  archived: rows.filter((row) => row.contact !== null && !isLive(row)).length,
  left: rows.filter((row) => row.contact === null && row.left).length,
})

/** The portal state of a row as the reader may see it (a person who left only when "Show people who left" is on). */
export const portalStateOf = (row: PersonRow, showLeft: boolean): PartnerPerson | null => (row.portal && (row.portal.status !== 'DEACTIVATED' || showLeft) ? row.portal : null)

/** A row a tick can act on (the portal's own rule: a person who left is not ticked). */
export const tickable = (row: PersonRow): boolean => row.portal !== null && row.portal.status !== 'DEACTIVATED'

// ---- the row's ⋯ -------------------------------------------------------------------------------------------------------------

/** What an item of a row's ⋯ does (the view runs it through the tab's container). */
export type PersonAct = 'edit' | 'addContact' | 'copyEmail' | 'invite' | RowAction | 'change' | 'archive' | 'restore' | 'link'

export interface PersonItem {
  readonly id: string
  readonly label: Said
  readonly act?: PersonAct
  readonly href?: string
  /** Held by STATE (never by a right: an act without its right is not offered). */
  readonly held?: Said
  readonly danger?: boolean
  readonly separator?: true
}

export interface PersonMenuContext {
  readonly can: PeopleCan
  /** The portal read (null: not read, failed, or not shown to the reader: no portal act is offered). */
  readonly access: PortalAccess | null
  /** The customer is archived: every change held ("Archived: reactivate it first"). */
  readonly archivedCustomer: boolean
  /** `/w/<company>` (History ›). */
  readonly prefix: string
}

const ARCHIVED_HELD = said('parties:held.archived')
const sep = (id: string): PersonItem => ({ id, label: said(''), separator: true })

/** Why Invite is held for a contact, by state (null: it may be sent); the portal's own rule after the contact's e-mail. */
function inviteHeldOf(row: PersonRow, access: PortalAccess, can: PartnerCan): Said | null {
  if (!row.contact?.email) return said('held.noEmailInvite')
  const held = inviteHeld(access, can)
  return held ? said(`portal-access:${held}`) : null
}

/** The acts of a row's ⋯, in their groups; empty groups leave no separator. */
export function personMenu(row: PersonRow, context: PersonMenuContext): PersonItem[] {
  const { can, access } = context
  const link: PersonItem = { id: 'link', label: said('row.copyLink'), act: 'link' }
  // An erased contact: nothing more can be done with it (R-B4) — one held line and the link.
  if (row.erased) return [{ id: 'erased', label: said('row.erasedLine'), held: said('row.erasedHeld') }, link]
  const manageHeld = context.archivedCustomer ? ARCHIVED_HELD : undefined
  const contact = row.contact
  const groups: PersonItem[][] = []
  // 1. The contact itself.
  const own: PersonItem[] = []
  if (contact && can.manage) own.push({ id: 'edit', label: said('parties:common.edit'), act: 'edit', ...(manageHeld ? { held: manageHeld } : {}) })
  if (!contact && row.portal && !row.left && can.manage) own.push({ id: 'addContact', label: said('row.addContact'), act: 'addContact', ...(manageHeld ? { held: manageHeld } : {}) })
  const email = contact?.email ?? row.portal?.email ?? null
  if (email) own.push({ id: 'copyEmail', label: said('row.copyEmail'), act: 'copyEmail' })
  groups.push(own)
  // 2. The portal (only with the portal read in, each act with its own right).
  const portal: PersonItem[] = []
  const person = row.portal
  if (access && can.portal) {
    if (!person && contact && contact.status === 'ACTIVE' && can.invite) {
      const held = inviteHeldOf(row, access, { view: can.portal, invite: can.invite, manage: can.portalManage, preview: false, requests: false })
      portal.push({ id: 'invite', label: said('parties:contact.invite'), act: 'invite', ...(held ? { held } : {}) })
    }
    if (person) {
      if (can.portalManage) portal.push({ id: 'change', label: said('portal-access:row.change'), act: 'change', ...(person.status === 'DEACTIVATED' ? { held: said('portal-access:held.left') } : {}) })
      if (person.status === 'INVITED' && can.invite) {
        portal.push({ id: 'resend', label: said('portal-access:row.resend'), act: 'resend' })
        if (person.invitation !== null) portal.push({ id: 'revoke', label: said('portal-access:row.revoke'), act: 'revoke', danger: true })
      }
      if (can.portalManage) {
        if (person.status === 'ACTIVE') portal.push({ id: 'suspend', label: said('portal-access:row.suspend'), act: 'suspend' })
        if (person.status === 'SUSPENDED') portal.push({ id: 'reactivate', label: said('portal-access:row.reactivate'), act: 'reactivate' })
        if (person.status === 'ACTIVE' || person.status === 'SUSPENDED') portal.push({ id: 'deactivate', label: said('portal-access:row.deactivate'), act: 'deactivate', danger: true })
      }
    }
  }
  groups.push(portal)
  // 3. History (audit.read): the contact's own changes.
  groups.push(contact && can.audit ? [{ id: 'history', label: said('row.history'), href: `${context.prefix}/admin/audit?${new URLSearchParams({ type: 'PartyContact', record: contact.id }).toString()}` }] : [])
  // 4. Archive / Restore (today's one-click PATCH; the Archive window with its warnings comes in ca-w2).
  const status: PersonItem[] = []
  if (contact && can.manage) {
    if (contact.status === 'ACTIVE') status.push({ id: 'archive', label: said('parties:contact.archive'), act: 'archive', ...(manageHeld ? { held: manageHeld } : {}) })
    else status.push({ id: 'restore', label: said('parties:contact.restore'), act: 'restore', ...(manageHeld ? { held: manageHeld } : {}) })
  }
  groups.push(status)
  groups.push([link])
  const items: PersonItem[] = []
  groups
    .filter((group) => group.length > 0)
    .forEach((group, index) => {
      if (index > 0) items.push(sep(`sep-${index}`))
      items.push(...group)
    })
  return items
}

/** The row's address (a chip's door marks it; "Copy link to this row"). */
export const personRowAnchor = (row: PersonRow): string => personAnchor(row.id)
