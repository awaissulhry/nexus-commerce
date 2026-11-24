import { createElement, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { Card } from '@nexus/ui/components'
import { grantOf } from '@nexus/factory-domain/auth/roles/roles'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NOW, VIES } from '../../../../../parties/_shared/fixtures'
import type { Address, Contact, Party } from '../../../../../parties/_shared/api'
import type { PartnerPerson, PortalAccess } from '../../../../../admin/users/partners/api'
import type { PortalAccessModel } from '../../../portal/model'
import { customerAccess, portalModel } from '../../../portal/demo'
import type { Privacy, PrivacyContact } from '../../../depth/api'
import type { ProfileRow, ProfilesView } from '../../../../mtm/api'
import type { AddressUsage, ContactUsage, PartyUsage, RiderParty, RidersView } from '../api'
import { failedRead, PEOPLE_TAB_NAMESPACES, peopleCan, READING, readyRead, said, type Read, type Said } from '../model'
import { PEOPLE_TAB_START, peopleTabModel, type AddRiderDialog, type FoundParty, type PeopleTabModel, type PeopleTabReads, type PeopleTabState, type RefuseDialog, type TeamDialog } from '../tab'
import { PeopleTab } from '../../view/people/PeopleTab'
import { RefuseAddressBody } from '../../view/people/RefuseAddressDialog'
import { AddRiderBody } from '../../view/people/AddRiderDialog'
import { ChangeTeamBody } from '../../view/people/ChangeTeamDialog'
import { ArchiveBody } from '../../view/people/ArchiveDialogs'
import { usePeopleSay } from '../../view/people/say'

/**
 * F-CA T.1 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-t; 15-steps T.1; 20-preview-people.html) — the gallery's `ca-*` cases of
 * SCR-033: the customers of the picture (a busy team, a new customer, an address waiting and one refused, erased + objected + no lawful
 * basis, seats full + an invitation expired + access ending, two registered offices + nobody gets invoices, a rider's own page with its
 * team, many rows), each with what its people and addresses are used on; no partners.view; no sales.measurements.view; each read
 * reading and failed; the office roles by their template's REAL grant; the rooms 343 / 865 / 1314 / 1794; and the NEW windows' insides
 * on a plain card (never a Menu or a Modal open on the server render). The tab is built by its ONE model rule from made-up reads, the
 * server's walls applied as the API applies them (no portal read without partners.view; no profile read, and no rider's profile count,
 * without the measurements right). Every name, address and e-mail is made up (Seed …, example.com). Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const PREFIX = '/w/DEMO'
/** A read that failed, as the container hands it (the kit's `orders` key). */
const FAIL = 'problem.read.unavailable'
const dayOf = (n: number) => new Date(Date.UTC(2026, 0, n, 9)).toISOString()

// ── the readers: the office roles' templates, their REAL grant on every company ──
export const CA_ROLES = ['owner', 'sales', 'finance', 'production_manager', 'warehouse', 'read_only'] as const
export type CaRole = (typeof CA_ROLES)[number]
export const caRoleHeld = (role: CaRole): readonly string[] => grantOf(templateOf(role)!, { allCompanies: true, companyIds: [], siteIds: [], partyIds: [] }).permissions

// ── the made-up records (every field of each type) ──
type PartyInput = Pick<Party, 'code' | 'legalName' | 'tradeName' | 'city' | 'contacts' | 'addresses'> & Partial<Party>
const party = (n: number, input: PartyInput): Party => ({
  id: uid('ca01', n),
  companyId: null,
  kind: 'ORGANISATION',
  roles: ['CUSTOMER'],
  status: 'ACTIVE',
  country: 'IT',
  currency: 'EUR',
  language: 'it',
  taxMode: 'IT_B2B',
  vatNumber: null,
  fiscalCode: null,
  vies: VIES.none,
  attention: [],
  invoiceBlocked: false,
  version: 4,
  updatedAt: NOW,
  paymentTerms: null,
  internalNote: null,
  blocked: null,
  taxIdentities: [],
  viesChecks: [],
  warnings: [],
  createdAt: dayOf(1),
  createdById: null,
  ...input,
})

const contact = (n: number, name: string, email: string | null, roles: Contact['roles'], over: Partial<Contact> = {}): Contact => ({
  id: uid('ca02', n),
  name,
  email,
  phone: null,
  roles,
  language: null,
  status: 'ACTIVE',
  version: 2,
  createdAt: dayOf(n),
  updatedAt: NOW,
  ...over,
})

const address = (n: number, over: Partial<Address> & Pick<Address, 'kinds' | 'name' | 'line1' | 'postalCode' | 'city' | 'province'>): Address => ({
  id: uid('ca03', n),
  line2: null,
  country: 'IT',
  contactName: null,
  phone: null,
  deliveryNotes: null,
  isDefaultBillTo: false,
  isDefaultShipTo: false,
  status: 'ACTIVE',
  approval: null,
  version: 2,
  createdAt: dayOf(n),
  updatedAt: NOW,
  ...over,
})

type Approval = NonNullable<Address['approval']>
/** An address the customer added in the portal, waiting for our check. */
const waiting = (by: string, at: string): Approval => ({ status: 'WAITING', requestedAt: at, requestedBy: by, decidedAt: null, decidedBy: null, refuseReason: null })
/** Refused after our check (the customer reads the reason, never who decided). */
const refused = (by: string, at: string, decidedBy: string, decidedAt: string, reason: string): Approval => ({ status: 'REFUSED', requestedAt: at, requestedBy: by, decidedAt, decidedBy, refuseReason: reason })

const person = (n: number, displayName: string, email: string, over: Partial<PartnerPerson> = {}): PartnerPerson => ({
  id: uid('ca04', n),
  displayName,
  email,
  kind: 'CUSTOMER',
  status: 'ACTIVE',
  roleKey: 'customer-buyer',
  roleName: 'Buyer',
  seesPrices: false,
  admin: false,
  capabilities: ['comment'],
  accessUntil: null,
  accessEndsSoon: false,
  lastSignInAt: '2026-10-20T15:10:00.000Z',
  invitation: null,
  version: 2,
  ...over,
})

const privacyOf = (row: Contact, over: Partial<PrivacyContact> = {}): PrivacyContact => ({
  id: row.id,
  name: row.name,
  erased: false,
  status: row.status,
  lawfulBasis: 'CONTRACT',
  consentAt: null,
  consentSource: null,
  objectedAt: null,
  erasedAt: null,
  erasedBy: null,
  version: row.version,
  ...over,
})

const contactUse = (row: Contact, over: Partial<ContactUsage> = {}): ContactUsage => ({ contactId: row.id, openQuotes: 0, lastQuoteAt: null, openReturns: 0, openComplaints: 0, openServiceCases: 0, lastMailInAt: null, ...over })
const addressUse = (row: Address, over: Partial<AddressUsage> = {}): AddressUsage => ({ addressId: row.id, draftQuoteVersions: 0, preparedShipments: 0, openSampleShipments: 0, openPortalRequests: 0, openChangeRequests: 0, ...over })

const profile = (n: number, of: Party, over: Partial<ProfileRow> & Pick<ProfileRow, 'riderName' | 'garmentType'>): ProfileRow => ({
  id: uid('ca05', n),
  partyId: of.id,
  customer: { code: of.code, name: of.legalName },
  contactId: null,
  revision: 1,
  takenAt: '2026-10-04T09:00:00.000Z',
  takenBy: 'Demo Fitter',
  measuredPlace: 'Showroom',
  baseSize: null,
  review: { status: 'WAITING', at: null },
  byLink: false,
  privacyNoticeAt: '2026-10-04T09:05:00.000Z',
  old: false,
  openUnits: 0,
  nextFittingAt: null,
  range: { inside: null, points: [] },
  ...over,
})

const riderOf = (id: string, code: string, legalName: string, measurementProfiles: number): RiderParty => ({ id, code, legalName, tradeName: null, status: 'ACTIVE', country: 'IT', language: 'it', measurementProfiles, version: 3, updatedAt: NOW })

/** One customer of the picture: its party and every read the tab makes of it (as the API answers them for the Owner). */
export interface CaCustomer {
  readonly party: Party
  readonly access: PortalAccess
  readonly privacy: Privacy
  readonly usage: PartyUsage
  readonly profiles: ProfilesView
  readonly riders: RidersView
  /** The portal user who approves production (the limits read); null: anyone. */
  readonly approverId: string | null
}

interface CustomerInput {
  readonly people?: readonly PartnerPerson[]
  readonly seats?: PortalAccess['seats']
  readonly portalOn?: boolean
  readonly privacy?: readonly PrivacyContact[]
  readonly notRecorded?: number
  readonly contactsUsed?: readonly ContactUsage[]
  readonly addressesUsed?: readonly AddressUsage[]
  readonly profiles?: readonly ProfileRow[]
  readonly riders?: readonly RiderParty[]
  readonly team?: RidersView['team']
  readonly approverId?: string | null
}

/** A customer and its reads: the portal of THIS customer, every contact's personal data (contract unless said), its usage (0 unless said). */
function customerOf(of: Party, input: CustomerInput = {}): CaCustomer {
  const seats = input.seats ?? { taken: input.people?.length ?? 0, max: 5 }
  const privacy = input.privacy ?? of.contacts.map((row) => privacyOf(row))
  const rows = input.profiles ?? []
  return {
    party: of,
    access: customerAccess({
      party: { id: of.id, code: of.code, name: of.tradeName ?? of.legalName, roles: [...of.roles], status: of.status, companyId: of.companyId },
      people: [...(input.people ?? [])],
      seats,
      settings: { portalOn: input.portalOn ?? true, maxUsers: seats.max, allowedRoleKeys: [], version: 3 },
    }),
    privacy: { contacts: [...privacy], notRecorded: input.notRecorded ?? privacy.filter((row) => !row.erased && row.lawfulBasis === null).length },
    usage: {
      partyId: of.id,
      asOf: NOW,
      contacts: of.contacts.map((row) => input.contactsUsed?.find((entry) => entry.contactId === row.id) ?? contactUse(row)),
      addresses: of.addresses.map((row) => input.addressesUsed?.find((entry) => entry.addressId === row.id) ?? addressUse(row)),
    },
    profiles: {
      rows: [...rows],
      matching: rows.length,
      tiles: { waitingReview: rows.filter((row) => row.review.status === 'WAITING').length, needMore: rows.filter((row) => row.review.status === 'NEED_MORE').length, older: rows.filter((row) => row.old).length, fittingsThisWeek: 0, outsideRange: null },
      asOf: NOW,
    },
    riders: { partyId: of.id, code: of.code, kind: of.kind, team: input.team ?? null, riders: [...(input.riders ?? [])], version: of.version },
    approverId: input.approverId ?? null,
  }
}

// ── the customers of the picture (20-preview-people.html), all made up ──

/** A rider with its own page (a person customer under Seed Racing): the busy team lists it; its own page is a case of its own. */
const RIDER_PARTY_ID = uid('ca01', 7)
const SEED_RACING_ID = uid('ca01', 1)
const SEED_LEGAL = 'Seed Customer One S.r.l.'

// The busy team: something in every section.
const BUSY_C = {
  giada: contact(1, 'Giada Seed', 'giada@seed-racing.example.com', ['ORDERS', 'OWNER'], { phone: '+39 051 000 1201' }),
  marco: contact(2, 'Marco Esempio', 'fatture@seed-racing.example.com', ['INVOICES'], { phone: '+39 051 000 1204' }),
  anna: contact(3, 'Anna Prova', 'qualita@seed-racing.example.com', ['QUALITY'], { language: 'en' }),
  sara: contact(4, 'Sara Demo', 'design@seed-racing.example.com', ['DESIGN']),
  davide: contact(5, 'Davide Campione', 'davide.campione@example.com', ['RIDER'], { phone: '+39 333 000 4410' }),
  paolo: contact(6, 'Paolo Bozza', 'ordini@seed-racing.example.com', ['ORDERS'], { status: 'ARCHIVED' }),
}
const BUSY_A = {
  office: address(1, { kinds: ['REGISTERED', 'BILL_TO'], name: SEED_LEGAL, line1: 'Via Esempio 14', postalCode: '40121', city: 'Bologna', province: 'BO', isDefaultBillTo: true }),
  workshop: address(2, { kinds: ['SHIP_TO'], name: 'Officina', line1: 'Via Prova 8/B', postalCode: '40026', city: 'Imola', province: 'BO', isDefaultShipTo: true, contactName: 'Giada Seed', phone: '+39 0542 000 330', deliveryNotes: 'Mornings only: the dock is at the back' }),
  pit: address(3, { kinds: ['SHIP_TO'], name: 'Box Misano', line1: 'Via del Circuito 3', postalCode: '47843', city: 'Misano Adriatico', province: 'RN', contactName: 'Giada Seed', deliveryNotes: 'Race weekends only, Friday before 16:00', approval: waiting('Giada Seed', '2026-10-27T15:10:00.000Z') }),
  collect: address(4, { kinds: ['PICKUP'], name: 'Magazzino ritiro', line1: 'Via Emilia 120', postalCode: '40064', city: 'Ozzano dell’Emilia', province: 'BO' }),
}
const BUSY_P = {
  giada: person(1, 'Giada Seed', 'Giada@seed-racing.example.com', { roleKey: 'customer-admin', roleName: 'Admin', admin: true, seesPrices: true, capabilities: ['comment', 'upload', 'approve'], lastSignInAt: '2026-10-29T08:12:00.000Z' }),
  marco: person(2, 'Marco Esempio', 'fatture@seed-racing.example.com', { roleKey: 'customer-finance', roleName: 'Finance', seesPrices: true, accessUntil: '2026-11-04T22:59:00.000Z', accessEndsSoon: true, lastSignInAt: '2026-10-18T10:00:00.000Z' }),
  sara: person(3, 'Sara Demo', 'design@seed-racing.example.com', { roleKey: 'customer-designer', roleName: 'Designer', lastSignInAt: '2026-10-14T11:00:00.000Z' }),
  elena: person(4, 'Elena Esempio', 'elena.esempio@example.com', { status: 'INVITED', lastSignInAt: null, invitation: null }),
  tommaso: person(5, 'Tommaso Demo', 'tommaso.demo@example.com', { status: 'DEACTIVATED', capabilities: [], lastSignInAt: '2026-09-02T09:00:00.000Z' }),
}
const BUSY_PARTY = party(1, { code: 'SEED-RACING', legalName: SEED_LEGAL, tradeName: 'Seed Racing', roles: ['CUSTOMER', 'BRAND'], city: 'Bologna', contacts: Object.values(BUSY_C), addresses: Object.values(BUSY_A) })
export const BUSY: CaCustomer = customerOf(BUSY_PARTY, {
  people: Object.values(BUSY_P),
  seats: { taken: 4, max: 5 },
  privacy: [
    privacyOf(BUSY_C.giada),
    privacyOf(BUSY_C.marco, { lawfulBasis: 'LEGAL_DUTY' }),
    privacyOf(BUSY_C.anna),
    privacyOf(BUSY_C.sara, { lawfulBasis: null }),
    privacyOf(BUSY_C.davide, { lawfulBasis: 'CONSENT', consentAt: '2026-03-12T09:00:00.000Z', consentSource: 'Form signed at the fitting' }),
    privacyOf(BUSY_C.paolo),
  ],
  contactsUsed: [
    contactUse(BUSY_C.giada, { openQuotes: 2, lastQuoteAt: '2026-10-27T10:00:00.000Z', lastMailInAt: '2026-10-28T16:20:00.000Z' }),
    contactUse(BUSY_C.marco, { lastMailInAt: '2026-10-20T08:40:00.000Z' }),
    contactUse(BUSY_C.anna, { openComplaints: 1, openReturns: 1, lastMailInAt: '2026-10-12T14:00:00.000Z' }),
  ],
  addressesUsed: [addressUse(BUSY_A.workshop, { draftQuoteVersions: 1, preparedShipments: 1 }), addressUse(BUSY_A.pit, { openPortalRequests: 1 })],
  profiles: [
    profile(1, BUSY_PARTY, { contactId: BUSY_C.davide.id, riderName: 'Davide Campione', garmentType: 'SUIT', revision: 3, baseSize: '52', review: { status: 'CONFIRMED', at: '2026-10-06T10:00:00.000Z' }, openUnits: 1, nextFittingAt: '2026-11-05T09:30:00.000Z' }),
    profile(2, BUSY_PARTY, { contactId: BUSY_C.davide.id, riderName: 'Davide Campione', garmentType: 'GLOVES', baseSize: '9', byLink: true, takenAt: '2026-10-19T18:00:00.000Z', privacyNoticeAt: '2026-10-19T17:58:00.000Z' }),
    profile(3, BUSY_PARTY, { riderName: 'Marta Demo', garmentType: 'SUIT', baseSize: '44', review: { status: 'NEED_MORE', at: '2026-10-09T11:00:00.000Z' }, takenAt: '2026-10-08T09:00:00.000Z' }),
    profile(4, BUSY_PARTY, { riderName: 'Marta Demo', garmentType: 'JACKET', revision: 2, baseSize: '46', review: { status: 'CONFIRMED', at: '2025-09-12T09:00:00.000Z' }, takenAt: '2025-09-10T09:00:00.000Z', privacyNoticeAt: '2025-09-10T09:05:00.000Z', old: true }),
  ],
  riders: [riderOf(RIDER_PARTY_ID, 'SEED-P01', 'Pilota Seed', 2), riderOf(uid('ca01', 8), 'SEED-P02', 'Nico Prova', 1)],
  approverId: BUSY_P.giada.id,
})

// A new customer: one quiet line per section.
export const NEW: CaCustomer = customerOf(party(2, { code: 'SEED-NUOVO', legalName: 'Seed Customer Two S.r.l.', tradeName: 'Seed Nuovo', city: null, contacts: [], addresses: [] }), { seats: { taken: 0, max: 5 } })

// An address the customer added in the portal waits for our check; one was refused ten days ago.
const CHECK_C = {
  irene: contact(11, 'Irene Seed', 'irene@seed-ponte.example.com', ['ORDERS', 'INVOICES'], { phone: '+39 011 000 5520' }),
  stefano: contact(12, 'Stefano Prova', 'qualita@seed-ponte.example.com', ['QUALITY']),
}
const CHECK_A = {
  office: address(11, { kinds: ['REGISTERED', 'BILL_TO'], name: 'Seed Customer Three S.r.l.', line1: 'Via Garibaldi 3', postalCode: '10121', city: 'Torino', province: 'TO', isDefaultBillTo: true }),
  warehouse: address(12, { kinds: ['SHIP_TO'], name: 'Magazzino squadra', line1: 'Strada Prova 140', postalCode: '10135', city: 'Torino', province: 'TO', isDefaultShipTo: true, contactName: 'Portineria', phone: '+39 011 000 5599' }),
  monza: address(13, { kinds: ['SHIP_TO'], name: 'Ospitalità Monza', line1: 'Viale Esempio 5', postalCode: '20900', city: 'Monza', province: 'MB', deliveryNotes: 'Paddock gate C, ask for the team truck', approval: waiting('Irene Seed', '2026-10-27T15:10:00.000Z') }),
  home: address(14, { kinds: ['SHIP_TO'], name: 'Casa privata', line1: 'Via Po 18', postalCode: '10123', city: 'Torino', province: 'TO', status: 'ARCHIVED', approval: refused('Irene Seed', '2026-10-18T17:40:00.000Z', 'Carlo Prova', '2026-10-19T09:00:00.000Z', 'We ship to business addresses only: please add the team warehouse.') }),
}
const CHECK_PARTY = party(3, { code: 'SEED-PONTE', legalName: 'Seed Customer Three S.r.l.', tradeName: 'Seed Ponte Team', roles: ['CUSTOMER', 'BRAND'], city: 'Torino', contacts: Object.values(CHECK_C), addresses: Object.values(CHECK_A) })
export const CHECK: CaCustomer = customerOf(CHECK_PARTY, {
  people: [
    person(11, 'Irene Seed', 'irene@seed-ponte.example.com', { roleKey: 'customer-admin', roleName: 'Admin', admin: true, seesPrices: true, lastSignInAt: '2026-10-28T17:40:00.000Z' }),
    person(12, 'Stefano Prova', 'qualita@seed-ponte.example.com', { roleKey: 'customer-quality', roleName: 'Quality', lastSignInAt: '2026-10-10T09:00:00.000Z' }),
  ],
  seats: { taken: 2, max: 3 },
  addressesUsed: [addressUse(CHECK_A.warehouse, { preparedShipments: 2 }), addressUse(CHECK_A.monza, { openPortalRequests: 1 })],
})

// Personal data: an erased contact, an objection, a lawful basis missing.
const PRIVACY_C = {
  chiara: contact(21, 'Chiara Seed', 'ordini@seed-lago.example.com', ['ORDERS'], { phone: '+39 031 000 7710' }),
  fabio: contact(22, 'Fabio Esempio', 'amministrazione@seed-lago.example.com', ['INVOICES']),
  rita: contact(23, 'Rita Prova', 'qualita@seed-lago.example.com', ['QUALITY']),
  erased: contact(24, '', null, ['ORDERS'], { status: 'ARCHIVED' }),
}
const PRIVACY_PARTY = party(4, {
  code: 'SEED-LAGO',
  legalName: 'Seed Customer Four S.n.c.',
  tradeName: 'Seed Lago Sport',
  city: 'Como',
  contacts: Object.values(PRIVACY_C),
  addresses: [address(21, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], name: 'Seed Customer Four S.n.c.', line1: 'Via Borgo Prova 31', postalCode: '22100', city: 'Como', province: 'CO', isDefaultBillTo: true, isDefaultShipTo: true })],
})
export const PRIVACY: CaCustomer = customerOf(PRIVACY_PARTY, {
  people: [person(21, 'Chiara Seed', 'ordini@seed-lago.example.com', { seesPrices: true })],
  privacy: [
    privacyOf(PRIVACY_C.chiara),
    privacyOf(PRIVACY_C.fabio, { lawfulBasis: 'LEGITIMATE_INTEREST', objectedAt: '2026-10-03T10:00:00.000Z' }),
    privacyOf(PRIVACY_C.rita, { lawfulBasis: null }),
    privacyOf(PRIVACY_C.erased, { erased: true, erasedAt: '2026-10-05T11:00:00.000Z', erasedBy: 'Alex Demo' }),
  ],
  contactsUsed: [contactUse(PRIVACY_C.chiara, { openQuotes: 1, lastQuoteAt: '2026-10-22T09:00:00.000Z' })],
  addressesUsed: [addressUse(PRIVACY_PARTY.addresses[0]!, { preparedShipments: 1 })],
})

// The portal: seats full, an invitation expired, an access ending, one suspended.
const SEATS_C = {
  roberto: contact(31, 'Roberto Seed', 'ordini@seed-sette.example.com', ['ORDERS'], { phone: '+39 06 000 3301' }),
  valeria: contact(32, 'Valeria Esempio', 'amministrazione@seed-sette.example.com', ['INVOICES']),
  matteo: contact(33, 'Matteo Prova', 'design@seed-sette.example.com', ['DESIGN']),
  giorgio: contact(34, 'Giorgio Campione', 'qualita@seed-sette.example.com', ['QUALITY']),
}
const SEATS_PARTY = party(5, {
  code: 'SEED-SETTE',
  legalName: 'Seed Customer Five S.r.l.',
  tradeName: 'Seed Sette Moto',
  roles: ['CUSTOMER', 'BRAND'],
  city: 'Roma',
  contacts: Object.values(SEATS_C),
  addresses: [address(31, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], name: 'Seed Customer Five S.r.l.', line1: 'Via Appia Prova 220', postalCode: '00183', city: 'Roma', province: 'RM', isDefaultBillTo: true, isDefaultShipTo: true })],
})
export const SEATS: CaCustomer = customerOf(SEATS_PARTY, {
  people: [
    person(31, 'Roberto Seed', 'ordini@seed-sette.example.com', { roleKey: 'customer-admin', roleName: 'Admin', admin: true, seesPrices: true, lastSignInAt: '2026-10-29T08:05:00.000Z' }),
    person(32, 'Valeria Esempio', 'amministrazione@seed-sette.example.com', { roleKey: 'customer-finance', roleName: 'Finance', seesPrices: true, accessUntil: '2026-11-04T22:59:00.000Z', accessEndsSoon: true, lastSignInAt: '2026-10-22T16:00:00.000Z' }),
    person(33, 'Matteo Prova', 'design@seed-sette.example.com', { roleKey: 'customer-designer', roleName: 'Designer', lastSignInAt: '2026-10-11T10:00:00.000Z' }),
    person(34, 'Giorgio Campione', 'qualita@seed-sette.example.com', { status: 'INVITED', roleKey: 'customer-quality', roleName: 'Quality', lastSignInAt: null, invitation: null }),
    person(35, 'Laura Demo', 'laura.demo@example.com', { status: 'INVITED', roleKey: 'customer-production', roleName: 'Production', lastSignInAt: null, invitation: { id: uid('ca06', 1), expiresAt: '2026-11-01T09:00:00.000Z' } }),
    person(36, 'Bruno Seed', 'bruno.seed@example.com', { status: 'SUSPENDED', roleKey: 'customer-viewer', roleName: 'Viewer', capabilities: [], lastSignInAt: '2026-09-30T10:00:00.000Z' }),
  ],
  seats: { taken: 5, max: 5 },
  privacy: [privacyOf(SEATS_C.roberto), privacyOf(SEATS_C.valeria, { lawfulBasis: 'LEGAL_DUTY' }), privacyOf(SEATS_C.matteo), privacyOf(SEATS_C.giorgio)],
})

// Two registered offices (the e-invoices use the oldest) and nobody gets invoices; an Orders contact with no e-mail.
const INVOICES_PARTY = party(6, {
  code: 'SEED-DOPPIA',
  legalName: 'Seed Customer Six S.r.l.',
  tradeName: 'Seed Riva Doppia',
  city: 'Bergamo',
  contacts: [contact(41, 'Pietro Seed', 'pietro@seed-doppia.example.com', ['ORDERS'], { phone: '+39 035 000 8812' }), contact(42, 'Ufficio acquisti', null, ['ORDERS'], { phone: '+39 035 000 8800' })],
  addresses: [
    address(41, { kinds: ['REGISTERED'], name: 'Seed Customer Six S.r.l. (old office)', line1: 'Corso Prova 41', postalCode: '20121', city: 'Milano', province: 'MI', createdAt: '2025-03-01T09:00:00.000Z' }),
    address(42, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], name: 'Seed Customer Six S.r.l.', line1: 'Via Borgo Esempio 77', postalCode: '24125', city: 'Bergamo', province: 'BG', isDefaultBillTo: true, isDefaultShipTo: true }),
  ],
})
export const INVOICES: CaCustomer = customerOf(INVOICES_PARTY, {
  seats: { taken: 0, max: 5 },
  contactsUsed: [contactUse(INVOICES_PARTY.contacts[0]!, { openQuotes: 1, lastQuoteAt: '2026-10-25T10:00:00.000Z' })],
  addressesUsed: [addressUse(INVOICES_PARTY.addresses[1]!, { draftQuoteVersions: 1 })],
})

// A rider's OWN page: a person customer under the busy team, its own profiles, its team on top.
const RIDER_C = contact(70, 'Pilota Seed', 'pilota.seed@example.com', ['ORDERS', 'INVOICES', 'RIDER'], { phone: '+39 347 000 2290' })
const RIDER_PARTY = party(7, {
  code: 'SEED-P01',
  kind: 'PERSON',
  legalName: 'Pilota Seed',
  tradeName: null,
  taxMode: 'IT_B2C',
  city: 'Bologna',
  contacts: [RIDER_C],
  addresses: [address(70, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], name: 'Casa', line1: 'Via Prova 61', postalCode: '40123', city: 'Bologna', province: 'BO', isDefaultBillTo: true, isDefaultShipTo: true, deliveryNotes: 'Second floor' })],
})
export const RIDER: CaCustomer = customerOf(RIDER_PARTY, {
  portalOn: false,
  seats: { taken: 0, max: 5 },
  privacy: [privacyOf(RIDER_C, { lawfulBasis: 'CONSENT', consentAt: '2026-02-02T10:00:00.000Z', consentSource: 'Measurement link, notice accepted' })],
  contactsUsed: [contactUse(RIDER_C, { openQuotes: 1, lastQuoteAt: '2026-10-21T10:00:00.000Z' })],
  profiles: [
    profile(70, RIDER_PARTY, { contactId: RIDER_C.id, riderName: 'Pilota Seed', garmentType: 'SUIT', revision: 2, baseSize: '50', review: { status: 'CONFIRMED', at: '2026-02-04T10:00:00.000Z' }, openUnits: 1, nextFittingAt: '2026-11-12T14:00:00.000Z', takenAt: '2026-02-02T10:00:00.000Z', privacyNoticeAt: '2026-02-02T10:00:00.000Z' }),
    profile(71, RIDER_PARTY, { contactId: RIDER_C.id, riderName: 'Pilota Seed', garmentType: 'BOOTS', baseSize: '43', byLink: true, takenAt: '2026-10-21T18:00:00.000Z', privacyNoticeAt: '2026-10-21T17:58:00.000Z' }),
  ],
  team: { id: SEED_RACING_ID, code: 'SEED-RACING', legalName: SEED_LEGAL, tradeName: 'Seed Racing' /* F-CA-fx4 (W-07): named as its own page names it */, status: 'ACTIVE' },
})

// Many rows: 14 people, 7 addresses, 15 riders (each list shows its first rows and "Show N more").
const FIRST = ['Alessia', 'Bruno', 'Carla', 'Dario', 'Erika', 'Fausto', 'Gaia', 'Ivo', 'Lia', 'Mauro', 'Nadia', 'Oscar', 'Pia', 'Rocco'] as const
const LAST = ['Demo', 'Esempio', 'Prova', 'Seed'] as const
const ROLE_SETS: ReadonlyArray<Contact['roles']> = [['ORDERS', 'OWNER'], ['INVOICES'], ['ORDERS'], ['QUALITY'], ['DESIGN'], ['RIDER'], ['ORDERS'], ['INVOICES'], [], ['RIDER'], ['DESIGN'], ['QUALITY'], [], ['RIDER']]
const MANY_C = FIRST.map((first, index) => contact(101 + index, `${first} ${LAST[index % LAST.length]}`, `${first.toLowerCase()}@seed-squadra.example.com`, [...ROLE_SETS[index]!]))
const MANY_PARTY = party(9, {
  code: 'SEED-SQUADRA',
  legalName: 'Seed Customer Nine S.r.l.',
  tradeName: 'Seed Squadra',
  roles: ['CUSTOMER', 'BRAND'],
  city: 'Modena',
  contacts: MANY_C,
  addresses: [
    address(101, { kinds: ['REGISTERED', 'BILL_TO'], name: 'Seed Customer Nine S.r.l.', line1: 'Via Esempio 1', postalCode: '41121', city: 'Modena', province: 'MO', isDefaultBillTo: true }),
    ...[1, 2, 3, 4, 5, 6].map((n) => address(101 + n, { kinds: ['SHIP_TO'], name: `Magazzino ${n}`, line1: `Via Prova ${n * 10}`, postalCode: '41122', city: 'Modena', province: 'MO', isDefaultShipTo: n === 1 })),
  ],
})
const RIDER_NAMES = ['Ada', 'Bea', 'Cora', 'Dino', 'Elio', 'Fede', 'Gino', 'Ines', 'Leo', 'Mara', 'Nino', 'Olga'] as const
export const MANY: CaCustomer = customerOf(MANY_PARTY, {
  people: MANY_C.slice(0, 9).map((row, index) => person(101 + index, row.name, row.email!, { seesPrices: index % 2 === 0 })),
  seats: { taken: 9, max: 12 },
  profiles: RIDER_NAMES.map((name, index) => profile(101 + index, MANY_PARTY, { riderName: `${name} Seed`, garmentType: 'SUIT', baseSize: String(44 + (index % 6) * 2), review: { status: index % 3 === 0 ? 'WAITING' : 'CONFIRMED', at: index % 3 === 0 ? null : '2026-10-10T09:00:00.000Z' } })),
})

// ── one case: the customer, the reader, its reads' states, the tab's own state, the room, the window opened ──
export type CaReadState = 'reading' | 'failed'
export type CaRoom = 343 | 865 | 1314 | 1794
/** A NEW window of the tab, its inside drawn on a plain card under the tab (the tab's state names it). */
export type CaWindow =
  | { readonly kind: 'refuse'; readonly dialog: RefuseDialog }
  | { readonly kind: 'addRider'; readonly dialog: AddRiderDialog }
  | { readonly kind: 'team'; readonly dialog: TeamDialog }
  | { readonly kind: 'archive'; readonly target: { readonly kind: 'contact' | 'address'; readonly id: string } }

export interface CaCaseModel {
  readonly customer: CaCustomer
  readonly role: CaRole
  /** The rights held; absent: the role's grant. */
  readonly held?: readonly string[]
  /** A read still out or failed (absent: in). */
  readonly reads?: Partial<Record<'portal' | 'privacy' | 'usage' | 'profiles' | 'riders', CaReadState>>
  readonly state?: Partial<PeopleTabState>
  /** The tab's room in px (every list chooses its columns by the room it has). */
  readonly room?: CaRoom
  readonly window?: CaWindow
}

export const caHeld = (ca: CaCaseModel): readonly string[] => ca.held ?? caRoleHeld(ca.role)

const readOf = <T>(value: T, state: CaReadState | undefined): Read<T> => (state === 'reading' ? READING : state === 'failed' ? failedRead(FAIL) : readyRead(value))

/** The portal container's model of THIS customer as the reader holds it (its own rights; reading or failed as the case says). */
function portalOf(customer: CaCustomer, held: readonly string[], state: CaReadState | undefined): PortalAccessModel {
  const has = (right: string) => held.includes(right)
  return portalModel('customers', {
    partyName: customer.party.tradeName ?? customer.party.legalName,
    access: state ? null : customer.access,
    problem: state === 'failed' ? FAIL : null,
    can: { view: has('partners.view'), invite: has('partners.invite'), manage: has('partners.manage'), preview: has('partners.preview'), requests: has('partners.tasks.manage') },
    requests: { items: [], problem: null, selected: [] },
    limits: null,
  })
}

export interface CaTab {
  readonly reads: PeopleTabReads
  /** The tab as the view draws it: its windows closed (their insides are drawn on a plain card). */
  readonly model: PeopleTabModel
  /** The same with the case's window open: the window's own model (the Archive window's warnings). */
  readonly open: PeopleTabModel
  readonly portal: PortalAccessModel | null
}

/** The tab of a case, as the container builds it: the server's walls applied by the rights the reader holds. */
export function caTabOf(ca: CaCaseModel): CaTab {
  const held = caHeld(ca)
  const can = peopleCan(held)
  const { customer } = ca
  const state = ca.reads ?? {}
  // R-B10: without the measurements right the API sends no profile and no rider's profile count (null, never 0).
  const riders: RidersView = can.measurements ? customer.riders : { ...customer.riders, riders: customer.riders.riders.map((rider) => ({ ...rider, measurementProfiles: null })) }
  const portal = can.portal ? portalOf(customer, held, state.portal) : null
  const reads: PeopleTabReads = {
    party: customer.party,
    prefix: PREFIX,
    can,
    now: NOW,
    portal,
    privacy: readOf(customer.privacy, state.privacy),
    usage: can.view ? readOf(customer.usage, state.usage) : null,
    approverId: can.portal ? customer.approverId : null,
    profiles: can.measurements ? readOf(customer.profiles, state.profiles) : null,
    riders: can.view ? readOf(riders, state.riders) : null,
  }
  const shown: PeopleTabState = { ...PEOPLE_TAB_START, ...ca.state }
  const win = ca.window
  const opened: Partial<PeopleTabState> = !win ? {} : win.kind === 'refuse' ? { refuse: win.dialog } : win.kind === 'addRider' ? { addRider: win.dialog } : win.kind === 'team' ? { team: win.dialog } : { archive: win.target }
  return { reads, model: peopleTabModel(reads, shown), open: peopleTabModel(reads, { ...shown, ...opened }), portal }
}

/** A NEW window's inside on a plain card: its title, its body (the window's own part). */
function WindowInside({ win, model }: { win: CaWindow; model: PeopleTabModel }): ReactNode {
  const say = usePeopleSay()
  const card = (title: Said, body: ReactNode) => createElement(Card, { padded: true }, createElement('div', { className: 'fw-pt-body' }, createElement('h2', { className: 'fw-pt-h2' }, say(title)), body))
  if (win.kind === 'refuse') {
    const row = model.addresses.all.find((entry) => entry.id === win.dialog.addressId)
    return row ? card(said('refuse.title'), createElement(RefuseAddressBody, { dialog: win.dialog, address: row.address, customer: model.name })) : null
  }
  if (win.kind === 'addRider') return card(said('rider.title', { params: { team: model.name } }), createElement(AddRiderBody, { dialog: win.dialog, team: model.name }))
  if (win.kind === 'team') return card(said('team.title', { params: { name: win.dialog.riderName } }), createElement(ChangeTeamBody, { dialog: win.dialog }))
  const archive = model.archive
  return archive ? card(said(archive.kind === 'contact' ? 'archive.contact.title' : 'archive.address.title', { params: { name: archive.name } }), createElement(ArchiveBody, { model: archive })) : null
}

/** The design's People tab of a case: the tab in its room, and the window's inside under it. */
export function CaPeopleDesign({ ca }: { ca: CaCaseModel }): ReactNode {
  const { model, open, portal } = caTabOf(ca)
  const tab = createElement(PeopleTab, { model, portal: portal ? { model: portal } : null, recordHref: `${PREFIX}/sales/customers/${ca.customer.party.id}`, privacy: null, mtm: null })
  const room: CSSProperties | null = ca.room ? { width: `${ca.room}px`, maxWidth: '100%' } : null
  const box: HTMLAttributes<HTMLDivElement> & { readonly 'data-ca-room'?: number } = { 'data-ca-room': ca.room, style: room ?? undefined }
  return createElement(WithMessages, { namespaces: PEOPLE_TAB_NAMESPACES }, createElement('div', box, tab, ca.window ? createElement(WindowInside, { win: ca.window, model: open }) : null))
}

// ── the windows' made-up states ──
const REFUSE: RefuseDialog = { addressId: CHECK_A.monza.id, reason: 'An event address: we deliver to the team warehouse only.', tried: false, busy: false, problem: null }
const RIDER_DRAFT: AddRiderDialog = { kind: 'own', name: '', email: '', phone: '', language: 'it', search: '', found: null, picked: null, tried: false, busy: false, problem: null, made: null }
const FOUND_RIDERS: readonly FoundParty[] = [
  { id: uid('ca01', 20), code: 'SEED-P03', name: 'Pilota Esempio', city: 'Bologna', version: 2 },
  { id: uid('ca01', 21), code: 'SEED-P04', name: 'Pilota Prova', city: 'Parma', version: 1 },
]
const OTHER_TEAM: FoundParty = { id: uid('ca01', 23), code: 'SEED-CORSE', name: 'Seed Corse Due', city: 'Modena', version: 4 }
const TEAM: TeamDialog = { riderId: RIDER_PARTY.id, riderName: RIDER_PARTY.legalName, version: RIDER_PARTY.version, current: { id: SEED_RACING_ID, name: 'Seed Racing' /* F-CA-fx4 (W-07) */ }, choice: 'move', search: 'seed', found: readyRead<readonly FoundParty[]>([OTHER_TEAM]), picked: OTHER_TEAM, tried: false, busy: false, problem: null }

const busy = (over: Partial<CaCaseModel> = {}): CaCaseModel => ({ customer: BUSY, role: 'owner', ...over })
const ALL_READS = ['portal', 'privacy', 'usage', 'profiles', 'riders'] as const
const every = (state: CaReadState) => Object.fromEntries(ALL_READS.map((read) => [read, state])) as Record<(typeof ALL_READS)[number], CaReadState>
const ARCHIVED_BUSY: CaCustomer = { ...BUSY, party: { ...BUSY.party, status: 'ARCHIVED' }, access: { ...BUSY.access, party: { ...BUSY.access.party, status: 'ARCHIVED' } } }

// ── the cases (ids `ca-*`; the labels say what each shows) ──
export const CA_CASES: readonly { readonly id: string; readonly label: string; readonly ca: CaCaseModel }[] = [
  // The customers of the picture (as the Owner reads them).
  { id: 'ca-busy', label: 'ca · Busy team: something in every section — the portal column, what each person and address is used on, both kinds of rider (the Owner)', ca: busy() },
  { id: 'ca-new', label: 'ca · A new customer: one quiet line per section', ca: { customer: NEW, role: 'owner' } },
  { id: 'ca-check', label: 'ca · An address added in the portal waits for our check (Approve · Refuse…); one refused ten days ago, its reason', ca: { customer: CHECK, role: 'owner' } },
  { id: 'ca-privacy', label: 'ca · Personal data: an erased contact, an objection, a lawful basis missing', ca: { customer: PRIVACY, role: 'owner' } },
  { id: 'ca-seats', label: 'ca · The portal: seats full, an invitation expired, an access ending, one suspended', ca: { customer: SEATS, role: 'owner' } },
  { id: 'ca-invoices', label: 'ca · Two registered offices (e-invoices use the oldest) · nobody gets invoices · an Orders contact with no e-mail', ca: { customer: INVOICES, role: 'owner' } },
  { id: 'ca-rider', label: 'ca · A rider\'s own page: its team on top, its own profiles as one row, the portal off', ca: { customer: RIDER, role: 'owner' } },
  { id: 'ca-many', label: 'ca · Many rows: 14 people, 7 addresses, 15 riders — each list its first rows and "Show N more"', ca: { customer: MANY, role: 'owner' } },
  // The tab's own states.
  { id: 'ca-chip-check', label: 'ca · A chip pressed: Addresses shows exactly the address that waits, with "Show all"', ca: { customer: CHECK, role: 'owner', state: { filter: 'check' } } },
  { id: 'ca-archived', label: 'ca · An archived customer: every change held by its state ("Archived: reactivate it first")', ca: { customer: ARCHIVED_BUSY, role: 'owner' } },
  // Rights (each act its own right: hidden without it, never held for it).
  { id: 'ca-no-portal-right', label: 'ca · No partners.view: no portal column, no Invite, "portal access is not shown for your role" once', ca: busy({ held: caRoleHeld('owner').filter((right) => !right.startsWith('partners.')) }) },
  { id: 'ca-no-measurements-right', label: 'ca · No sales.measurements.view: the riders\' names only, said once; no profile, size or review', ca: busy({ held: caRoleHeld('owner').filter((right) => right !== 'sales.measurements.view') }) },
  // The office roles (their template's REAL grant).
  ...CA_ROLES.map((role) => ({ id: `ca-role-${role.replace('_', '-')}`, label: `ca · As ${role.replace('_', ' ')}: the busy team with exactly the acts and parts the role has`, ca: busy({ role }) })),
  // Reading (each read on its own; the rest of the tab draws).
  { id: 'ca-reading-all', label: 'ca · Every read out: the portal column waits, Personal data and Riders read, the usage lines left out', ca: busy({ reads: every('reading') }) },
  { id: 'ca-reading-portal', label: 'ca · The portal still reads: the contacts draw, the portal column waits', ca: busy({ reads: { portal: 'reading' } }) },
  { id: 'ca-reading-privacy', label: 'ca · The personal data still reads: Personal data says so', ca: busy({ reads: { privacy: 'reading' } }) },
  { id: 'ca-reading-riders', label: 'ca · The riders and the profiles still read: Riders & measurements says so', ca: busy({ reads: { riders: 'reading', profiles: 'reading' } }) },
  // Failed (each read with its own Try again; a failed read is never 0).
  { id: 'ca-failed-all', label: 'ca · Every read failed: each part its own Try again; the contacts and addresses still draw', ca: busy({ reads: every('failed') }) },
  { id: 'ca-failed-portal', label: 'ca · The portal read failed: its own Try again, the contacts draw', ca: busy({ reads: { portal: 'failed' } }) },
  { id: 'ca-failed-privacy', label: 'ca · The personal data read failed: its own Try again', ca: busy({ reads: { privacy: 'failed' } }) },
  { id: 'ca-failed-usage', label: 'ca · The usage read failed: ONE quiet line in People and ONE in Addresses with its Try again (Z25) — never 0, never a line per row', ca: busy({ reads: { usage: 'failed' } }) },
  { id: 'ca-failed-profiles', label: 'ca · The profiles read failed: its own Try again, the riders\' names still draw', ca: busy({ reads: { profiles: 'failed' } }) },
  { id: 'ca-failed-riders', label: 'ca · The riders read failed: its own Try again', ca: busy({ reads: { riders: 'failed' } }) },
  // The rooms (every list chooses its columns by the room it has).
  { id: 'ca-room-343', label: 'ca · The room of a phone (343 px): every row stacks', ca: busy({ room: 343 }) },
  { id: 'ca-room-865', label: 'ca · 865 px (the tab beside a docked thread)', ca: busy({ room: 865 }) },
  { id: 'ca-room-1314', label: 'ca · 1314 px', ca: busy({ room: 1314 }) },
  { id: 'ca-room-1794', label: 'ca · 1794 px: the widest room, every column', ca: busy({ room: 1794 }) },
  // The NEW windows' insides on a plain card (a Modal never opens on the server render).
  { id: 'ca-win-refuse', label: 'ca · Refuse the delivery address (its inside): the address, the reason the customer reads, what a refusal does', ca: { customer: CHECK, role: 'owner', window: { kind: 'refuse', dialog: REFUSE } } },
  { id: 'ca-win-refuse-short', label: 'ca · Refuse… (its inside): the reason too short, said at the field', ca: { customer: CHECK, role: 'owner', window: { kind: 'refuse', dialog: { ...REFUSE, reason: 'No', tried: true } } } },
  { id: 'ca-win-refuse-failed', label: 'ca · Refuse… (its inside): the refusal was refused (the address changed meanwhile)', ca: { customer: CHECK, role: 'owner', window: { kind: 'refuse', dialog: { ...REFUSE, problem: 'problem.conflict' } } } },
  { id: 'ca-win-rider', label: 'ca · Add a rider to Seed Racing (its inside): the two kinds, the new rider\'s fields, the search for an existing one', ca: busy({ window: { kind: 'addRider', dialog: RIDER_DRAFT } }) },
  { id: 'ca-win-rider-found', label: 'ca · Add rider (its inside): two person customers found by the search', ca: busy({ window: { kind: 'addRider', dialog: { ...RIDER_DRAFT, search: 'pilota', found: readyRead<readonly FoundParty[]>(FOUND_RIDERS) } } }) },
  { id: 'ca-win-rider-made', label: 'ca · Add rider (its inside): made, not yet under the team — Try again sends only that step', ca: busy({ window: { kind: 'addRider', dialog: { ...RIDER_DRAFT, name: 'Nuovo Pilota Seed', email: 'nuovo.pilota@example.com', made: { id: uid('ca01', 22), name: 'Nuovo Pilota Seed', version: 1 }, problem: 'problem.unavailable' } } }) },
  { id: 'ca-win-team-move', label: 'ca · Change the team of Pilota Seed (its inside): moved to another team found by name', ca: { customer: RIDER, role: 'owner', window: { kind: 'team', dialog: TEAM } } },
  { id: 'ca-win-team-off', label: 'ca · Change team (its inside): taken off any team — it stays a customer of its own', ca: { customer: RIDER, role: 'owner', window: { kind: 'team', dialog: { ...TEAM, choice: 'off', search: '', found: null, picked: null } } } },
  { id: 'ca-win-archive-contact', label: 'ca · Archive Giada Seed? (its inside): who gets the quotes after, the portal access, the production approver, the open quotes that name her', ca: busy({ window: { kind: 'archive', target: { kind: 'contact', id: BUSY_C.giada.id } } }) },
  { id: 'ca-win-archive-address', label: 'ca · Archive "Officina"? (its inside): the default for deliveries, the draft quote and the prepared shipment that name it', ca: busy({ window: { kind: 'archive', target: { kind: 'address', id: BUSY_A.workshop.id } } }) },
]

/** The cases by part of the picture: the gallery tests draw them per language and per part (a long gallery test is split). */
export const CA_PARTS = {
  picture: ['ca-busy', 'ca-new', 'ca-check', 'ca-privacy', 'ca-seats', 'ca-invoices', 'ca-rider', 'ca-many'],
  states: ['ca-chip-check', 'ca-archived'],
  rights: ['ca-no-portal-right', 'ca-no-measurements-right'],
  roles: ['ca-role-owner', 'ca-role-sales', 'ca-role-finance', 'ca-role-production-manager', 'ca-role-warehouse', 'ca-role-read-only'],
  reading: ['ca-reading-all', 'ca-reading-portal', 'ca-reading-privacy', 'ca-reading-riders'],
  failed: ['ca-failed-all', 'ca-failed-portal', 'ca-failed-privacy', 'ca-failed-usage', 'ca-failed-profiles', 'ca-failed-riders'],
  rooms: ['ca-room-343', 'ca-room-865', 'ca-room-1314', 'ca-room-1794'],
  windows: ['ca-win-refuse', 'ca-win-refuse-short', 'ca-win-refuse-failed', 'ca-win-rider', 'ca-win-rider-found', 'ca-win-rider-made', 'ca-win-team-move', 'ca-win-team-off', 'ca-win-archive-contact', 'ca-win-archive-address'],
} as const
