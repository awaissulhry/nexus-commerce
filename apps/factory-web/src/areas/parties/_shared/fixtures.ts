import { createElement, useEffect, useState, type ReactNode } from 'react'
import { permissionCheck } from '../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import { RecordPanelsView } from '../../../record-panels/view/RecordPanelsView'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { Address, Contact, Party, PartyRow, PurchaseOrderRow, QuoteRow, SalesOrderRow, TaxIdentity, ViesCheck, ViesStanding } from './api'
import { loaded, type ListCan, type PartiesListModel, type PartyRecordModel, type RecordCan, type Side } from './model'

/**
 * Made-up customers and suppliers for the design cases of SCR-032, SCR-033, SCR-056 and SCR-057 (B-W1-07 part 2):
 * "Demo", "Esempio", "Prova", "Beispiel" names, example.com addresses, VAT numbers of zeros and ones, invented VIES
 * consultation numbers. Nothing here is a real company, person or number. Design-only (a fixtures file: only fixtures and
 * tests import it); it exports no `designScreen`, so the design index skips it.
 */

export const PREFIX = '/w/DEMO'
export const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const NOW = at(29, 9, 42)
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

/** The Office shell around a page at this address (the owner's navigation). */
export function inShell(path: string, page: ReactNode, permissions: readonly string[] = OWNER_PERMISSIONS): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- VIES standings and checks ----

const standing = (state: ViesStanding['state'], extra: Partial<ViesStanding> = {}): ViesStanding => ({
  state,
  message: '',
  proofCheckId: null,
  checkedAt: null,
  validUntil: null,
  maxAgeDays: 30,
  ...extra,
})
export const VIES = {
  none: standing('NOT_APPLICABLE'),
  unchecked: standing('UNCHECKED'),
  valid: standing('VALID', { proofCheckId: uid('7777', 1), checkedAt: at(12, 9, 14), validUntil: new Date(Date.UTC(2026, 10, 11, 9, 14)).toISOString() }),
  invalid: standing('INVALID', { checkedAt: at(27, 15, 2) }),
  held: standing('HELD', { checkedAt: at(28, 11, 30) }),
  expired: standing('EXPIRED', { proofCheckId: uid('7777', 9), checkedAt: at(2, 8, 0) }),
}

const check = (n: number, result: ViesCheck['result'], country: string, number: string, day: number, extra: Partial<ViesCheck> = {}): ViesCheck => ({
  id: uid('7777', n),
  taxIdentityId: uid('8888', n),
  companyId: DEMO_COMPANIES[0].id,
  countryCode: country,
  vatNumber: number,
  requesterVatNumber: 'IT00000000000',
  requestedAt: at(day, 9, 14),
  result,
  consultationNumber: result === 'ERROR' ? null : `DEMO${String(4711 + n).padStart(12, '0')}`,
  traderName: result === 'VALID' ? 'BEISPIEL MOTORRAD GMBH' : null,
  traderAddress: result === 'VALID' ? 'MUSTERSTRASSE 1, 00000 BEISPIELSTADT' : null,
  errorCode: result === 'ERROR' ? 'MS_UNAVAILABLE' : null,
  errorMeaning: null,
  requestId: `req-demo-${n}`,
  createdById: DEMO_USER.id,
  ...extra,
})

// ---- addresses, contacts, identities ----

const address = (n: number, extra: Partial<Address> & Pick<Address, 'kinds' | 'line1' | 'city' | 'country'>): Address => ({
  id: uid('4444', n),
  name: null,
  line2: null,
  postalCode: extra.country === 'IT' ? '00000' : '00000',
  province: extra.country === 'IT' ? 'MI' : null,
  contactName: null,
  phone: null,
  deliveryNotes: null,
  isDefaultBillTo: false,
  isDefaultShipTo: false,
  status: 'ACTIVE',
  version: 2,
  createdAt: at(3, 9),
  updatedAt: at(20, 9),
  ...extra,
})

const contact = (n: number, name: string, email: string | null, roles: Contact['roles'], extra: Partial<Contact> = {}): Contact => ({
  id: uid('5555', n),
  name,
  email,
  phone: null,
  roles,
  language: null,
  status: 'ACTIVE',
  version: 1,
  createdAt: at(3, 9),
  updatedAt: at(3, 9),
  ...extra,
})

const identity = (n: number, extra: Partial<TaxIdentity> & Pick<TaxIdentity, 'country' | 'taxMode'>): TaxIdentity => ({
  id: uid('8888', n),
  vatNumber: null,
  fiscalCode: null,
  sdiRecipientCode: null,
  pec: null,
  validFrom: '2026-01-01',
  current: true,
  version: 1,
  createdAt: at(3, 9),
  updatedAt: at(3, 9),
  ...extra,
})

// ---- parties ----

type PartyInput = Partial<Party> & Pick<Party, 'code' | 'legalName' | 'roles'>

function party(n: number, input: PartyInput): Party {
  const taxIdentities = input.taxIdentities ?? []
  const current = taxIdentities.find((item) => item.current) ?? null
  const addresses = input.addresses ?? []
  const warnings = input.warnings ?? []
  return {
    id: uid('6666', n),
    companyId: null,
    kind: 'ORGANISATION',
    tradeName: null,
    status: 'ACTIVE',
    country: 'IT',
    currency: 'EUR',
    language: 'it',
    taxMode: current?.taxMode ?? null,
    vatNumber: current?.vatNumber ?? null,
    fiscalCode: current?.fiscalCode ?? null,
    city: addresses.find((item) => item.isDefaultBillTo)?.city ?? addresses[0]?.city ?? null,
    vies: VIES.none,
    attention: warnings.map((warning) => warning.code),
    invoiceBlocked: warnings.some((warning) => warning.blocksInvoice),
    version: 4,
    updatedAt: at(28, 16),
    paymentTerms: null,
    internalNote: null,
    blocked: null,
    addresses,
    contacts: [],
    taxIdentities,
    viesChecks: [],
    warnings,
    createdAt: at(3, 9),
    createdById: DEMO_USER.id,
    ...input,
  }
}

const warn = (code: Party['warnings'][number]['code'], blocksInvoice = false) => ({ code, message: '', blocksInvoice })

export const CUSTOMERS: Party[] = [
  party(1, {
    code: 'MODA-DEMO',
    legalName: 'Moda Demo S.r.l.',
    tradeName: 'Moda Demo',
    roles: ['CUSTOMER'],
    taxIdentities: [identity(1, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000000', fiscalCode: '00000000000', sdiRecipientCode: 'DEMO123' })],
    addresses: [
      address(1, { kinds: ['REGISTERED', 'BILL_TO'], line1: 'Via Esempio 10', city: 'Firenze', province: 'FI', country: 'IT', isDefaultBillTo: true }),
      address(2, {
        kinds: ['SHIP_TO'],
        name: 'Magazzino',
        line1: 'Via del Deposito 2',
        city: 'Prato',
        province: 'PO',
        country: 'IT',
        isDefaultShipTo: true,
        deliveryNotes: 'Banchina 3, dalle 8 alle 12',
        contactName: 'Anna Demo',
        phone: '+39 000 000 0000',
      }),
    ],
    contacts: [contact(1, 'Anna Demo', 'acquisti@moda-demo.example.com', ['ORDERS']), contact(2, 'Bruno Esempio', 'amministrazione@moda-demo.example.com', ['INVOICES'], { language: 'it' })],
    paymentTerms: 'Bonifico 30 gg d.f.',
  }),
  party(2, {
    code: 'MARCHIO-ESEMPIO',
    legalName: 'Marchio Esempio S.p.A.',
    tradeName: 'Marchio Esempio',
    roles: ['CUSTOMER', 'BRAND'],
    taxIdentities: [identity(2, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT11111111111' })],
    addresses: [address(3, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Corso Prova 5', city: 'Milano', province: 'MI', country: 'IT', isDefaultBillTo: true, isDefaultShipTo: true })],
    contacts: [contact(3, 'Carla Prova', 'carla@marchio-esempio.example.com', ['ORDERS', 'DESIGN'])],
    warnings: [warn('FISCAL_DRAWER')],
  }),
  party(3, {
    code: 'DE-BEISPIEL',
    legalName: 'Beispiel Motorrad GmbH',
    roles: ['CUSTOMER'],
    country: 'DE',
    language: 'de',
    taxIdentities: [identity(3, { country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE000000000' })],
    addresses: [address(4, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Musterstraße 1', city: 'Beispielstadt', country: 'DE', isDefaultBillTo: true, isDefaultShipTo: true })],
    contacts: [contact(4, 'Dana Beispiel', 'einkauf@beispiel-motorrad.example.de', ['ORDERS', 'INVOICES'], { language: 'de' })],
    vies: VIES.valid,
    viesChecks: [check(1, 'VALID', 'DE', '000000000', 12)],
  }),
  party(4, {
    code: 'FR-EXEMPLE',
    legalName: 'Exemple Moto SARL',
    roles: ['CUSTOMER'],
    country: 'FR',
    language: 'fr',
    taxIdentities: [identity(4, { country: 'FR', taxMode: 'EU_B2B', vatNumber: 'FR00000000000' })],
    addresses: [address(5, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: '1 rue Exemple', city: 'Exempleville', country: 'FR', isDefaultBillTo: true, isDefaultShipTo: true })],
    contacts: [contact(5, 'Élise Exemple', 'achats@exemple-moto.example.fr', ['ORDERS'], { language: 'fr' })],
    vies: VIES.invalid,
    viesChecks: [check(2, 'INVALID', 'FR', '00000000000', 27, { consultationNumber: 'DEMO000000004713' }), check(3, 'VALID', 'FR', '00000000000', 1)],
    warnings: [warn('VIES_NOT_PROVEN')],
  }),
  party(5, {
    code: 'AT-MUSTER',
    legalName: 'Muster Leder GmbH',
    roles: ['CUSTOMER'],
    country: 'AT',
    language: 'de',
    taxIdentities: [identity(5, { country: 'AT', taxMode: 'EU_B2B', vatNumber: 'ATU00000000' })],
    addresses: [address(6, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Mustergasse 3', city: 'Musterdorf', country: 'AT', isDefaultBillTo: true, isDefaultShipTo: true })],
    contacts: [contact(6, 'Felix Muster', 'office@muster-leder.example.at', ['ORDERS'])],
    vies: VIES.held,
    viesChecks: [check(4, 'ERROR', 'AT', 'U00000000', 28)],
    warnings: [warn('VIES_NOT_PROVEN')],
  }),
  party(6, {
    code: 'ES-PRUEBA',
    legalName: 'Prueba Motos S.L.',
    roles: ['CUSTOMER'],
    status: 'PROSPECT',
    country: 'ES',
    language: 'es',
    taxIdentities: [identity(6, { country: 'ES', taxMode: 'EU_B2B', vatNumber: 'ESX0000000X' })],
    addresses: [],
    vies: VIES.unchecked,
    warnings: [warn('VIES_NOT_PROVEN'), warn('NO_REGISTERED_ADDRESS', true), warn('NO_DEFAULT_BILL_TO'), warn('NO_DEFAULT_SHIP_TO'), warn('NO_ORDERS_CONTACT')],
  }),
  party(7, {
    code: 'CH-DEMO',
    legalName: 'Demo Racing AG',
    roles: ['CUSTOMER', 'BRAND'],
    country: 'CH',
    language: 'de',
    currency: 'CHF',
    taxIdentities: [identity(7, { country: 'CH', taxMode: 'EXTRA_EU', vatNumber: 'CHE000000000' })],
    addresses: [address(7, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Demostrasse 7', city: 'Demodorf', country: 'CH', isDefaultBillTo: true, isDefaultShipTo: true })],
    contacts: [contact(7, 'Gina Demo', 'orders@demo-racing.example.ch', ['ORDERS'])],
  }),
  party(8, {
    code: 'PILOTA-DEMO',
    kind: 'PERSON',
    legalName: 'Luca Demo',
    roles: ['CUSTOMER'],
    taxIdentities: [identity(8, { country: 'IT', taxMode: 'IT_B2C', fiscalCode: 'DMOLCU00A00Z000X' })],
    addresses: [address(8, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Via Prova 1', city: 'Bologna', province: 'BO', country: 'IT', isDefaultBillTo: true, isDefaultShipTo: true })],
    contacts: [contact(8, 'Luca Demo', 'luca.demo@example.com', ['ORDERS', 'RIDER'])],
  }),
  party(9, {
    code: 'NUOVO-PROVA',
    legalName: 'Nuovo Cliente Prova S.r.l.',
    roles: ['CUSTOMER'],
    status: 'PROSPECT',
    warnings: [warn('NO_TAX_IDENTITY', true), warn('NO_REGISTERED_ADDRESS', true), warn('NO_DEFAULT_BILL_TO'), warn('NO_DEFAULT_SHIP_TO'), warn('NO_ORDERS_CONTACT')],
  }),
  party(10, {
    code: 'BLOCCATO-DEMO',
    legalName: 'Bloccato Demo S.p.A.',
    roles: ['CUSTOMER'],
    status: 'BLOCKED',
    blocked: { reason: 'Pagamenti scaduti da agosto: nessun nuovo ordine fino al saldo.', at: at(21, 10) },
    taxIdentities: [identity(10, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT22222222222', pec: 'bloccato-demo@pec.example.com' })],
    addresses: [address(9, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Via Campione 9', city: 'Torino', province: 'TO', country: 'IT', isDefaultBillTo: true, isDefaultShipTo: true })],
    contacts: [contact(9, 'Ilaria Bozza', 'ordini@bloccato-demo.example.com', ['ORDERS'])],
  }),
  party(11, {
    code: 'PELLETTERIA-DOPPIA',
    legalName: 'Pelletteria Doppia Demo S.r.l.',
    roles: ['CUSTOMER', 'SUPPLIER'],
    taxIdentities: [identity(11, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT33333333333', sdiRecipientCode: 'PROVA77' })],
    addresses: [
      address(10, { kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO', 'PICKUP'], line1: 'Via Doppia 2', city: 'Santa Croce', province: 'PI', country: 'IT', isDefaultBillTo: true, isDefaultShipTo: true }),
    ],
    contacts: [contact(10, 'Marta Doppia', 'ufficio@pelletteria-doppia.example.com', ['ORDERS', 'INVOICES'])],
  }),
]

export const ARCHIVED_CUSTOMER: Party = party(12, {
  code: 'ARCHIVIATO-DEMO',
  legalName: 'Archiviato Demo S.r.l.',
  roles: ['CUSTOMER'],
  status: 'ARCHIVED',
  taxIdentities: [identity(12, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT44444444444', sdiRecipientCode: 'ARCH000' })],
})

export const SUPPLIERS: Party[] = [
  party(21, {
    code: 'CONCERIA-DEMO',
    legalName: 'Conceria Demo S.p.A.',
    tradeName: 'Conceria Demo',
    roles: ['SUPPLIER'],
    taxIdentities: [identity(21, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT55555555555', sdiRecipientCode: 'CONC123' })],
    addresses: [
      address(21, { kinds: ['REGISTERED', 'BILL_TO'], line1: 'Via delle Concerie 1', city: 'Santa Croce sull’Arno', province: 'PI', country: 'IT', isDefaultBillTo: true }),
      address(22, {
        kinds: ['PICKUP'],
        name: 'Magazzino pelli',
        line1: 'Via del Cuoio 8',
        city: 'Ponte a Egola',
        province: 'PI',
        country: 'IT',
        contactName: 'Nadia Esempio',
        phone: '+39 000 000 0001',
      }),
    ],
    contacts: [
      contact(21, 'Nadia Esempio', 'vendite@conceria-demo.example.com', ['ORDERS']),
      contact(22, 'Oscar Prova', 'qualita@conceria-demo.example.com', ['QUALITY']),
      contact(23, 'Paola Campione', 'amministrazione@conceria-demo.example.com', ['INVOICES']),
    ],
    paymentTerms: 'RiBa 60 gg f.m.',
    internalNote: 'Pelle bovina pieno fiore; chiusura agosto.',
  }),
  party(22, {
    code: 'TESSITURA-ESEMPIO',
    legalName: 'Tessitura Esempio S.r.l.',
    roles: ['SUPPLIER'],
    taxIdentities: [identity(22, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT66666666666', pec: 'tessitura-esempio@pec.example.com' })],
    addresses: [address(23, { kinds: ['REGISTERED', 'BILL_TO', 'PICKUP'], line1: 'Via dei Telai 4', city: 'Biella', province: 'BI', country: 'IT', isDefaultBillTo: true })],
    contacts: [contact(24, 'Rita Esempio', null, ['QUALITY'])],
    warnings: [warn('NO_ORDERS_CONTACT')],
  }),
  party(23, {
    code: 'PROTEZIONI-PROVA',
    legalName: 'Protezioni Prova S.r.l.',
    roles: ['SUPPLIER'],
    status: 'PROSPECT',
    taxIdentities: [identity(23, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT77777777777' })],
    warnings: [warn('NO_REGISTERED_ADDRESS'), warn('NO_ORDERS_CONTACT')],
  }),
  party(24, {
    code: 'TERZISTA-DEMO',
    legalName: 'Laboratorio Terzista Demo di Sara Demo',
    tradeName: 'Lab. Terzista Demo',
    roles: ['SUBCONTRACTOR'],
    taxIdentities: [identity(24, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT88888888888', fiscalCode: 'DMESRA00A00Z000Y' })],
    addresses: [address(24, { kinds: ['REGISTERED', 'PICKUP'], line1: 'Via del Lavoro 12', city: 'Empoli', province: 'FI', country: 'IT' })],
    contacts: [contact(25, 'Sara Demo', 'lab@terzista-demo.example.com', ['ORDERS', 'OWNER'])],
  }),
  party(25, {
    code: 'CORRIERE-DEMO',
    legalName: 'Corriere Demo S.r.l.',
    roles: ['CARRIER'],
    taxIdentities: [identity(25, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT99999999999' })],
    addresses: [address(25, { kinds: ['REGISTERED'], line1: 'Via dei Trasporti 3', city: 'Bologna', province: 'BO', country: 'IT' })],
    contacts: [contact(26, 'Ufficio spedizioni', 'spedizioni@corriere-demo.example.com', ['ORDERS'])],
  }),
  party(26, {
    code: 'DE-LEDER',
    legalName: 'Leder Beispiel GmbH',
    roles: ['SUPPLIER'],
    country: 'DE',
    language: 'de',
    taxIdentities: [identity(26, { country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE111111111' })],
    addresses: [address(26, { kinds: ['REGISTERED', 'BILL_TO', 'PICKUP'], line1: 'Lederweg 5', city: 'Beispielstadt', country: 'DE', isDefaultBillTo: true })],
    contacts: [contact(27, 'Tom Beispiel', 'verkauf@leder-beispiel.example.de', ['ORDERS'], { language: 'de' })],
    vies: VIES.valid,
    viesChecks: [check(5, 'VALID', 'DE', '111111111', 12, { traderName: 'LEDER BEISPIEL GMBH', traderAddress: 'LEDERWEG 5, 00000 BEISPIELSTADT' })],
  }),
  party(27, {
    code: 'PT-EXEMPLO',
    legalName: 'Curtumes Exemplo Lda',
    roles: ['SUPPLIER'],
    country: 'PT',
    language: 'pt',
    taxIdentities: [identity(27, { country: 'PT', taxMode: 'EU_B2B', vatNumber: 'PT000000000' })],
    addresses: [address(27, { kinds: ['REGISTERED', 'BILL_TO', 'PICKUP'], line1: 'Rua Exemplo 1', city: 'Exemplo', country: 'PT', isDefaultBillTo: true })],
    contacts: [contact(28, 'Vera Exemplo', 'vendas@curtumes-exemplo.example.pt', ['ORDERS'])],
    vies: VIES.unchecked,
  }),
  party(28, {
    code: 'FORN-BLOCCATO',
    legalName: 'Fornitore Bloccato Demo S.r.l.',
    roles: ['SUPPLIER'],
    status: 'BLOCKED',
    blocked: { reason: 'Due lotti fuori specifica (cromo VI): in attesa di azione correttiva.', at: at(18, 14) },
    taxIdentities: [identity(28, { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT10101010101' })],
    addresses: [address(28, { kinds: ['REGISTERED', 'BILL_TO'], line1: 'Via Ferma 1', city: 'Arzignano', province: 'VI', country: 'IT', isDefaultBillTo: true })],
    contacts: [contact(29, 'Zeno Bozza', 'ordini@forn-bloccato.example.com', ['ORDERS'])],
  }),
  CUSTOMERS[10]!,
]

/** A party as its list row (the list answer carries no children). */
export function rowOf(item: Party): PartyRow {
  const { paymentTerms, internalNote, blocked, addresses, contacts, taxIdentities, viesChecks, warnings, createdAt, createdById, ...row } = item
  void [paymentTerms, internalNote, blocked, addresses, contacts, taxIdentities, viesChecks, warnings, createdAt, createdById]
  return row
}

// ---- beside the record ----

export const QUOTES: QuoteRow[] = [
  { id: uid('9101', 1), number: 'PV-2026-00041', status: 'SENT', revision: 2, currency: 'EUR', netAmount: 1_845_000, validUntil: '2026-11-15', promiseDate: '2027-01-20', updatedAt: at(27, 11) },
  { id: uid('9101', 2), number: 'PV-2026-00039', status: 'PENDING_APPROVAL', revision: 1, currency: 'EUR', netAmount: 642_500, validUntil: '2026-11-30', promiseDate: null, updatedAt: at(26, 15) },
  { id: uid('9101', 3), number: 'PV-2026-00022', status: 'ACCEPTED', revision: 3, currency: 'EUR', netAmount: 2_310_000, validUntil: '2026-09-30', promiseDate: '2026-12-10', updatedAt: at(2, 10) },
  { id: uid('9101', 4), number: 'PV-2026-00017', status: 'DECLINED', revision: 1, currency: 'EUR', netAmount: 420_000, validUntil: '2026-08-31', promiseDate: null, updatedAt: at(1, 9) },
]
export const ORDERS: SalesOrderRow[] = [
  {
    id: uid('9102', 1),
    number: 'OV-2026-00031',
    status: 'IN_PRODUCTION',
    orderDate: '2026-10-03',
    promiseDate: '2026-12-10',
    daysLate: null,
    units: 240,
    shippedUnits: 0,
    currency: 'EUR',
    netAmount: 2_310_000,
    updatedAt: at(20, 8),
  },
  {
    id: uid('9102', 2),
    number: 'OV-2026-00012',
    status: 'SHIPPED',
    orderDate: '2026-04-14',
    promiseDate: '2026-07-01',
    daysLate: null,
    units: 120,
    shippedUnits: 120,
    currency: 'EUR',
    netAmount: 1_080_000,
    updatedAt: at(1, 8),
  },
]
export const PURCHASE_ORDERS: PurchaseOrderRow[] = [
  {
    id: uid('9103', 1),
    number: 'OA-2026-00044',
    status: 'SENT',
    currency: 'EUR',
    orderDate: '2026-10-24',
    requestedDate: '2026-11-20',
    latestConfirmedDate: null,
    lineCount: 3,
    netAmount: 1_264_000,
    sentAt: at(24, 10),
    confirmedAt: null,
    updatedAt: at(24, 10),
  },
  {
    id: uid('9103', 2),
    number: 'OA-2026-00037',
    status: 'CONFIRMED',
    currency: 'EUR',
    orderDate: '2026-10-08',
    requestedDate: '2026-11-05',
    latestConfirmedDate: '2026-11-07',
    lineCount: 2,
    netAmount: 830_500,
    sentAt: at(8, 10),
    confirmedAt: at(9, 16),
    updatedAt: at(9, 16),
  },
  {
    id: uid('9103', 3),
    number: 'OA-2026-00021',
    status: 'RECEIVED',
    currency: 'EUR',
    orderDate: '2026-09-02',
    requestedDate: '2026-09-25',
    latestConfirmedDate: '2026-09-25',
    lineCount: 4,
    netAmount: 1_902_000,
    sentAt: at(2, 10),
    confirmedAt: at(3, 9),
    updatedAt: at(26, 9),
  },
]
/** The same rows as a role without the grain sees them: the money fields are not sent. */
export const withoutMoney = <Row extends { netAmount?: number }>(rows: readonly Row[]): Row[] => rows.map(({ netAmount, ...rest }) => (void netAmount, rest as Row))

// ---- abilities ----

export const LIST_CAN: ListCan = { view: true, manage: true, block: true, vies: true }
export const RECORD_CAN: RecordCan = { view: true, manage: true, block: true, vies: true, quotes: true, orders: true, purchaseOrders: true, price: true, cost: true, threads: true }

/**
 * The list design cases keep their own selection, so ticking rows, the header box, shift-click and x work in the
 * design index as on the page (the toolbar swaps to the bulk actions); everything else stays as the case's model says.
 */
export function useDesignList(model: PartiesListModel): { model: PartiesListModel; actions: { onSelect: (ids: readonly string[]) => void } } {
  const [selected, setSelected] = useState<readonly string[]>(model.selected)
  useEffect(() => setSelected(model.selected), [model.selected])
  return { model: { ...model, selected }, actions: { onSelect: (ids) => setSelected([...ids]) } }
}

export function listModel(side: Side, over: Partial<PartiesListModel> = {}): PartiesListModel {
  const parties = side === 'customers' ? CUSTOMERS : SUPPLIERS
  return {
    side,
    prefix: PREFIX,
    rows: loaded(parties.map(rowOf)),
    total: parties.length,
    more: false,
    tiles: side === 'customers' ? { active: 7, prospects: 2, vies: 3, invoice: 2, blocked: 1 } : { active: 7, prospects: 1, blocked: 1 },
    view: 'open',
    filters: {},
    query: '',
    asOf: NOW,
    live: 'live',
    updates: 0,
    selected: [],
    can: LIST_CAN,
    companies: [],
    ...over,
  }
}

export function recordModel(side: Side, item: Party, over: Partial<PartyRecordModel> = {}): PartyRecordModel {
  return {
    side,
    prefix: PREFIX,
    tab: 'overview',
    party: item,
    can: RECORD_CAN,
    asOf: NOW,
    live: 'live',
    history: loaded(item.viesChecks),
    quotes: loaded(QUOTES),
    orders: loaded(ORDERS),
    purchaseOrders: loaded(PURCHASE_ORDERS),
    ...over,
  }
}

// ---- the record panels on a party record ----

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel
const filesCase = panelsScreen.cases.find((item) => item.id === 'files')!.model as RecordPanelsViewModel

/** The record panels as a party record mounts them (thread, files, history), with the party as the mail's recipient. */
export function panels(item: Party, tab: 'thread' | 'files' = 'thread'): ReactNode {
  const base = tab === 'files' ? filesCase : conversation
  const model: RecordPanelsViewModel = {
    ...base,
    record: { type: 'Party', id: item.id, companyId: item.companyId },
    title: item.tradeName ?? item.legalName,
    party: { id: item.id, name: item.tradeName ?? item.legalName, emails: item.contacts.flatMap((entry) => (entry.email ? [entry.email] : [])) },
    tab,
  }
  return createElement(RecordPanelsView, { model })
}
