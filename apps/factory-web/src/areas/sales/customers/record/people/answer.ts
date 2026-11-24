import type { Party, PartyKind } from '../../../../parties/_shared/api'
import { addressShort, invoiceAddressOf, registeredOffices, type AddressRow } from './addresses'
import { said, type PeopleSectionId, type Said } from './model'
import { isLive, type PersonRow } from './people'

/**
 * F-CA-105 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §4, §5.1, §5.2; 18-lead-settles Z4, Z5) — the tab's answer line,
 * pure: ONE sentence (who works with us, who signs in, how many addresses and riders) and the chips of what waits on us, each a door to
 * EXACTLY its rows (its section shows only those, "Show all" leaves the filter). The sections' own answers. The tab's count = the
 * addresses waiting for our check only (from the party read: no new read on other tabs). Only what is true and read is said: a read
 * not in is left out, a failed read is never 0.
 */

export const PEOPLE_CHIPS = ['check', 'basis', 'expired', 'ends', 'seats', 'noQuotes', 'noInvoices', 'registered', 'noRegistered'] as const
export type PeopleChip = (typeof PEOPLE_CHIPS)[number]

export interface AnswerChip {
  readonly id: PeopleChip
  readonly tone: 'warning' | 'danger' | 'info'
  readonly label: Said
  /** The section it opens. */
  readonly section: Extract<PeopleSectionId, 'people' | 'addresses'>
  /** It filters the section to exactly its rows (false: it only opens the section — nothing to list, e.g. no registered office). */
  readonly filters: boolean
}

/** The portal as the reader sees it here (null: not shown — no right, not read yet, or failed). */
export interface PortalFacts {
  readonly on: boolean
  readonly seats: { readonly taken: number; readonly max: number | null }
}

export interface PeopleFacts {
  readonly kind: PartyKind
  readonly people: readonly PersonRow[]
  readonly addresses: readonly AddressRow[]
  readonly portal: PortalFacts | null
  /** The reader has the portal right (else the People answer says once that portal access is not shown). */
  readonly portalRight: boolean
  /** The privacy read is in (the lawful-basis chip needs it). */
  readonly privacyIn: boolean
  /** Riders of this organisation (null: a riders read still out or failed — never a partial count; or withheld). */
  readonly riders: number | null
  /** The team of a rider (a person customer), by its display name (trade name, else legal name), else null. */
  readonly team: string | null
}

const activeContacts = (facts: PeopleFacts): PersonRow[] => facts.people.filter((row) => row.contact !== null && isLive(row))
const portalLive = (facts: PeopleFacts): PersonRow[] => (facts.portal?.on ? facts.people.filter((row) => row.portal !== null && row.portal.status !== 'DEACTIVATED') : [])
const seatsFull = (portal: PortalFacts | null): boolean => !!portal?.on && portal.seats.max !== null && portal.seats.taken >= portal.seats.max
const getsQuotes = (row: PersonRow): boolean => row.mails.includes('QUOTES_AND_CONFIRMATIONS')
const getsInvoices = (row: PersonRow): boolean => row.mails.includes('INVOICES_AND_REMINDERS')

// ---- the filters a chip sets (the rows it opens) ------------------------------------------------------------------------------

/** The people a chip opens (null: the chip filters no people). */
export function personFilterOf(chip: PeopleChip | null): ((row: PersonRow) => boolean) | null {
  switch (chip) {
    case 'basis':
      return (row) => row.basisMissing
    case 'expired':
      return (row) => row.expired
    case 'ends':
      return (row) => row.endsIn !== null
    case 'seats':
      return (row) => row.portal !== null && row.portal.status !== 'DEACTIVATED'
    case 'noQuotes':
      return (row) => row.contact !== null && isLive(row) && row.contact.roles.includes('ORDERS')
    case 'noInvoices':
      return (row) => row.contact !== null && isLive(row) && row.contact.roles.includes('INVOICES')
    default:
      return null
  }
}

/** The addresses a chip opens (null: the chip filters no addresses). */
export function addressFilterOf(chip: PeopleChip | null): ((row: AddressRow) => boolean) | null {
  if (chip === 'check') return (row) => row.waiting
  if (chip === 'registered') return (row) => row.address.status === 'ACTIVE' && row.address.kinds.includes('REGISTERED')
  return null
}

/** The line over a filtered section: "Showing the 1 person without a lawful basis." */
export function filterWords(chip: PeopleChip, count: number): Said {
  return said(`filter.${chip}`, { params: { count } })
}

// ---- the answer line ------------------------------------------------------------------------------------------------------------

export interface PeopleAnswer {
  /** The sentence's parts, said joined with " · " and a full stop. */
  readonly words: readonly Said[]
  readonly chips: readonly AnswerChip[]
  /** A chip of warning or danger shows: the banner speaks as a warning. */
  readonly tone: 'warning' | 'info'
}

export function peopleAnswer(facts: PeopleFacts): PeopleAnswer {
  const live = facts.people.filter(isLive)
  const contacts = activeContacts(facts)
  const active = facts.addresses.filter((row) => row.address.status === 'ACTIVE')
  const words: Said[] = []
  const organisation = facts.kind === 'ORGANISATION'
  // F-CA-fx4 (walk W-06): nobody and no address is said as such — the riders or a rider's team follow it, never "0 people · 0 addresses".
  if (live.length === 0 && facts.addresses.length === 0) words.push(said('answer.nothing'))
  else {
    // F-CA-fx7 (re-walk R-01): a part with nothing says it in words, never "0 people" / "0 addresses".
    words.push(live.length > 0 ? said('answer.people', { params: { count: live.length } }) : said('answer.nobody'))
    // F-CA-fx4 (walk W-01): a portal that is off while people still hold an account says so (they are counted among the people).
    if (facts.portal && !facts.portal.on && facts.people.some((row) => row.portal !== null && row.portal.status !== 'DEACTIVATED')) words.push(said('people.answer.portalOff'))
    if (facts.portal?.on) {
      const portal = portalLive(facts)
      const signIn = portal.filter((row) => row.portal!.status === 'ACTIVE').length
      const invited = portal.filter((row) => row.portal!.status === 'INVITED').length
      const seats = facts.portal.seats.max !== null ? said('answer.portal.seats', { params: { taken: facts.portal.seats.taken, max: facts.portal.seats.max } }) : null
      const who = signIn > 0 ? (invited > 0 ? said('answer.portal.both', { words: { signIn: said('answer.portal.signIn', { params: { count: signIn } }), invited: said('answer.portal.invited', { params: { count: invited } }) } }) : said('answer.portal.signIn', { params: { count: signIn } })) : invited > 0 ? said('answer.portal.invitedOnly', { params: { count: invited } }) : said('answer.portal.nobody')
      words.push(seats ? said('answer.portal.withSeats', { words: { who, seats } }) : who)
    }
    words.push(active.length > 0 ? said('answer.addresses', { params: { count: active.length } }) : said('answer.noAddress')) // F-CA-fx7 (R-01)
  }
  if (organisation && facts.riders !== null && facts.riders > 0) words.push(said('answer.riders', { params: { count: facts.riders } }))
  if (!organisation && facts.team) words.push(said('answer.riderOf', { params: { team: facts.team } }))
  const chips: AnswerChip[] = []
  const waiting = facts.addresses.filter((row) => row.waiting).length
  if (waiting > 0) chips.push({ id: 'check', tone: 'warning', label: said('chip.check', { params: { count: waiting } }), section: 'addresses', filters: true })
  const noBasis = facts.privacyIn ? facts.people.filter((row) => row.basisMissing).length : 0
  if (noBasis > 0) chips.push({ id: 'basis', tone: 'warning', label: said('chip.basis', { params: { count: noBasis } }), section: 'people', filters: true })
  if (facts.portal?.on) {
    const expired = facts.people.filter((row) => row.expired).length
    if (expired > 0) chips.push({ id: 'expired', tone: 'warning', label: said('chip.expired', { params: { count: expired } }), section: 'people', filters: true })
    const ends = facts.people.filter((row) => row.endsIn !== null).length
    if (ends > 0) chips.push({ id: 'ends', tone: 'info', label: said('chip.ends', { params: { count: ends } }), section: 'people', filters: true })
    if (seatsFull(facts.portal)) chips.push({ id: 'seats', tone: 'info', label: said('chip.seats', { params: { taken: facts.portal.seats.taken, max: facts.portal.seats.max ?? 0 } }), section: 'people', filters: true })
  }
  if (contacts.length > 0 && !contacts.some(getsQuotes)) chips.push({ id: 'noQuotes', tone: 'danger', label: said('chip.noQuotes'), section: 'people', filters: true })
  if (contacts.length > 0 && !contacts.some(getsInvoices)) chips.push({ id: 'noInvoices', tone: 'danger', label: said('chip.noInvoices'), section: 'people', filters: true })
  const offices = registeredOffices(facts.addresses.map((row) => row.address))
  if (offices.length > 1) chips.push({ id: 'registered', tone: 'info', label: said('chip.registered', { params: { count: offices.length } }), section: 'addresses', filters: true })
  // "Can't invoice yet" only when it is true: no active registered office AND no default invoice address (the invoicing rule).
  if (invoiceAddressOf(facts.addresses.map((row) => row.address)) === null) chips.push({ id: 'noRegistered', tone: 'danger', label: said('chip.noRegistered'), section: 'addresses', filters: false })
  return { words, chips, tone: chips.some((chip) => chip.tone !== 'info') ? 'warning' : 'info' }
}

// ---- the sections' own answers ------------------------------------------------------------------------------------------------

/** People's answer (10-design §5.1): the counts, the seats, who gets quotes and invoices, what the reader does not see — said once. */
export function peopleSectionAnswer(facts: PeopleFacts): Said[] {
  const live = facts.people.filter(isLive)
  const contacts = activeContacts(facts)
  if (live.length === 0) return [said('people.answer.none')]
  const out: Said[] = []
  // F-CA-fx4 (walk W-01): the people only in the portal count whenever they are shown (the portal read in — on or off).
  const portalOnly = live.filter((row) => row.contact === null).length
  out.push(portalOnly > 0 ? said('people.answer.contactsAndPortal', { words: { contacts: said('people.answer.contacts', { params: { count: contacts.length } }) }, params: { count: portalOnly } }) : said('people.answer.contacts', { params: { count: contacts.length } }))
  if (facts.portal?.on && facts.portal.seats.max !== null) out.push(said(seatsFull(facts.portal) ? 'people.answer.seatsFull' : 'people.answer.seats', { params: { taken: facts.portal.seats.taken, max: facts.portal.seats.max } }))
  const quotes = contacts.filter(getsQuotes)
  const invoices = contacts.filter(getsInvoices)
  const name = (row: PersonRow) => row.contact?.name ?? ''
  if (quotes.length === 1 && invoices.length === 1 && quotes[0] === invoices[0]) out.push(said('people.answer.allTo', { params: { name: name(quotes[0]!) } }))
  else {
    out.push(quotes.length > 0 ? said('people.answer.quotesTo', { params: { name: name(quotes[0]!) } }) : said('people.answer.noQuotes'))
    out.push(invoices.length > 0 ? said('people.answer.invoicesTo', { lists: { names: invoices.map(name) } }) : said('people.answer.noInvoices'))
  }
  if (!facts.portalRight) out.push(said('people.answer.portalHidden'))
  else if (facts.portal && !facts.portal.on) out.push(said('people.answer.portalOff'))
  return out
}

/** Addresses' answer (10-design §5.2): the count, where invoices and deliveries go, what waits, two registered offices. */
export function addressesSectionAnswer(facts: PeopleFacts): Said[] {
  if (facts.addresses.length === 0) return [said('addresses.answer.none')]
  const active = facts.addresses.filter((row) => row.address.status === 'ACTIVE').map((row) => row.address)
  const out: Said[] = [said('answer.addresses', { params: { count: active.length } })]
  const billTo = active.find((address) => address.isDefaultBillTo)
  const shipTo = active.find((address) => address.isDefaultShipTo)
  out.push(billTo ? said('addresses.answer.invoicesTo', { params: { where: addressShort(billTo) } }) : said('addresses.answer.noInvoices'))
  out.push(shipTo ? (shipTo === billTo ? said('addresses.answer.deliveriesToo') : said('addresses.answer.deliveriesTo', { params: { where: addressShort(shipTo) } })) : said('addresses.answer.noDeliveries'))
  const waiting = facts.addresses.filter((row) => row.waiting).length
  if (waiting > 0) out.push(said('addresses.answer.waits', { params: { count: waiting } }))
  const offices = registeredOffices(active)
  if (offices.length > 1) out.push(said('addresses.answer.registered', { params: { count: offices.length } }))
  return out
}

// ---- the tab's count ------------------------------------------------------------------------------------------------------------

/**
 * The tab's count (Z4): the addresses waiting for our check — from the party read (no new read on any tab), marked like Work and Quotes
 * when > 0; null: none (no chip, never "0"). Everything else that waits on us is a chip of the answer line.
 */
export function peopleBadge(party: Pick<Party, 'addresses'>): { readonly count: number; readonly attention: true } | null {
  const count = party.addresses.filter((address) => address.status === 'ACTIVE' && address.approval?.status === 'WAITING').length
  return count > 0 ? { count, attention: true } : null
}

// ---- F-CA-218 (ca-w2 W2.4; 10-design §5.4; Z8): Personal data — the summary and ONLY what needs a look ----------------------------

export type PrivacyException = 'basis' | 'objected' | 'erased'

/** The people whose personal data needs a look: no lawful basis, an objection, an erasure (each once, in that order). */
export function privacyExceptions(rows: readonly PersonRow[]): Array<{ readonly row: PersonRow; readonly kind: PrivacyException }> {
  return [
    ...rows.filter((row) => row.basisMissing).map((row) => ({ row, kind: 'basis' as const })),
    ...rows.filter((row) => row.contact !== null && !row.erased && row.privacy?.objectedAt).map((row) => ({ row, kind: 'objected' as const })),
    ...rows.filter((row) => row.erased && row.privacy).map((row) => ({ row, kind: 'erased' as const })),
  ]
}

/** Personal data's answer: "Lawful basis recorded for 4 of 5 contacts · no objection · nothing erased." (the privacy read's own facts). */
export function privacySectionAnswer(rows: readonly PersonRow[]): Said[] {
  const contacts = rows.filter((row) => row.contact !== null && isLive(row) && row.privacy !== null)
  const erased = rows.filter((row) => row.erased && row.privacy)
  if (contacts.length === 0 && erased.length === 0) return [said('privacy.answer.none')]
  const objected = rows.filter((row) => row.contact !== null && !row.erased && row.privacy?.objectedAt).length
  const first = erased[0]?.privacy?.erasedAt ?? null
  return [
    said('privacy.answer.basis', { params: { count: contacts.filter((row) => row.privacy?.lawfulBasis).length, total: contacts.length } }),
    objected > 0 ? said('privacy.answer.objections', { params: { count: objected } }) : said('privacy.answer.noObjection'),
    erased.length === 0 ? said('privacy.answer.nothingErased') : erased.length === 1 && first ? said('privacy.answer.erasedOn', { days: { date: first } }) : said('privacy.answer.erased', { params: { count: erased.length } }),
  ]
}
