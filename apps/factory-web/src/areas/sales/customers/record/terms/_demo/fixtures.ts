import { createElement, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { Card } from '@nexus/ui/components'
import { grantOf } from '@nexus/factory-domain/auth/roles/roles'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { CUSTOMERS, NOW } from '../../../../../parties/_shared/fixtures'
import type { Party, TaxIdentity, ViesCheck, ViesStanding } from '../../../../../parties/_shared/api'
import type { CompanyTerms, Hold, Holds, Requirement, Requirements } from '../../../depth/api'
import { failedRead, LOADING, ready, type Read } from '../../../depth/model'
import { PAYMENT_TERMS } from '../../../_demo/fixtures'
import type { CommercialTerms, PaymentTermsRow } from '../../../terms/api'
import { LIST_ROWS } from '../../../../pricelists/_demo/fixtures'
import type { CarrierAccount } from '../api'
import { said, TERMS_TAB_NAMESPACES, termsCan, type Said } from '../model'
import { TERMS_TAB_START, termsTabModel, type TermsTabModel, type TermsTabReads, type TermsTabState } from '../tab'
import { companyEndWindowOf, companyWindowOf, deliveryWindowOf, termsWindowOf, type TermsTabWindow } from '../windows'
import { TermsTab } from '../../view/terms/TermsTab'
import { ChangeTermsBody } from '../../view/terms/ChangeTermsDialog'
import { DeliveryBody } from '../../view/terms/DeliveryDialog'
import { CompanyEndBody, CompanyTermsBody } from '../../view/terms/CompanyTermsDialog'
import { useTermsSay } from '../../view/terms/say'

/**
 * F-CT T.1 (customer page › TERMS & REQUIREMENTS tab, lane ct- ct-t; 15-steps T.1; 20-preview-terms.html) — the gallery's `ct-*` cases of
 * SCR-033: the customers of the picture (a busy brand, a new customer, on hold for missing tax data with two orders waiting, two of our
 * companies with different terms, an EU customer VIES could not check, an EU proof ending in three days, a sole trader with a codice
 * fiscale, twelve requirements with replaced and ended ones); the office roles by their template's REAL grant; each read reading and
 * failed; the rooms 343 / 865 / 1314 / 1794; and the NEW windows' insides on a plain card (never a Menu or a Modal open on the server
 * render). The tab is built by its ONE model rule from made-up reads, the server's walls applied as the API applies them (no amount
 * without the price grain, no waiting quote's number without quotes.view). Every name, number and address is made up (Seed …,
 * example.com, VAT numbers of zeros, codice fiscale of X's). Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const PREFIX = '/w/DEMO'
/** A tab read that failed, as the container hands it (the kit's `orders` key); a depth read's own key. */
const FAIL = 'problem.read.unavailable'
const DEPTH_FAIL = 'problem.offline'
const dayFrom = (days: number): string => new Date(Date.parse(NOW) + days * 86_400_000).toISOString()

// ── the readers: the office roles' templates, their REAL grant on every company ──
export const CT_ROLES = ['owner', 'sales', 'finance', 'production_manager', 'warehouse', 'read_only'] as const
export type CtRole = (typeof CT_ROLES)[number]
export const ctRoleHeld = (role: CtRole): readonly string[] => grantOf(templateOf(role)!, { allCompanies: true, companyIds: [], siteIds: [], partyIds: [] }).permissions

// ── our two companies (made up) ──
export const CT_COMPANY_A = { id: uid('ct00', 1), code: 'SEED-A', name: 'Seed Company A' }
export const CT_COMPANY_B = { id: uid('ct00', 2), code: 'SEED-B', name: 'Seed Company B' }
const NAMES: Readonly<Record<string, string>> = { [CT_COMPANY_A.id]: CT_COMPANY_A.name, [CT_COMPANY_B.id]: CT_COMPANY_B.name }

// ── the made-up records (every field of each type) ──
const MODA = CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!
const standing = (state: ViesStanding['state'], over: Partial<ViesStanding> = {}): ViesStanding => ({ state, message: '', proofCheckId: null, checkedAt: null, validUntil: null, maxAgeDays: 30, ...over })
type PartyInput = Pick<Party, 'code' | 'legalName' | 'tradeName'> & Partial<Party>
const party = (n: number, input: PartyInput): Party => ({
  ...MODA,
  id: uid('ct01', n),
  companyId: null,
  kind: 'ORGANISATION',
  roles: ['CUSTOMER', 'BRAND'],
  status: 'ACTIVE',
  country: 'IT',
  currency: 'EUR',
  language: 'it',
  taxMode: 'IT_B2B',
  vatNumber: null,
  fiscalCode: null,
  city: 'Bologna',
  vies: standing('NOT_APPLICABLE'),
  attention: [],
  invoiceBlocked: false,
  paymentTerms: null,
  internalNote: null,
  blocked: null,
  taxIdentities: [],
  viesChecks: [],
  warnings: [],
  version: 4,
  updatedAt: dayFrom(-5),
  createdAt: '2025-10-28T09:00:00.000Z',
  ...input,
})
const identity = (n: number, over: Partial<TaxIdentity> = {}): TaxIdentity => ({ id: uid('ct02', n), country: 'IT', taxMode: 'IT_B2B', vatNumber: `IT0000000000${n % 10}`, fiscalCode: null, sdiRecipientCode: 'FAKE001', pec: null, validFrom: '2026-01-01', current: true, version: 1, createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:00.000Z', ...over })
const check = (n: number, over: Partial<ViesCheck> = {}): ViesCheck => ({ id: uid('ct03', n), taxIdentityId: uid('ct02', n), companyId: null, countryCode: 'DE', vatNumber: '000000000', requesterVatNumber: null, requestedAt: dayFrom(-n), result: 'VALID', consultationNumber: `WAPIAAAA0000FAKE${n}`, traderName: null, traderAddress: null, errorCode: null, errorMeaning: null, requestId: `ct-req-${n}`, createdById: null, ...over })

const named = (row: PaymentTermsRow): NonNullable<CommercialTerms['paymentTerms']> => ({ id: row.id, code: row.code, name: row.name, nameI18n: row.nameI18n, companyId: row.companyId, status: row.status, summary: row.summary, deposit: row.deposit })
const DEP30 = PAYMENT_TERMS[0]!
const BB60 = PAYMENT_TERMS[1]!
const LIST = LIST_ROWS[1]!
const BASE = LIST_ROWS[0]!
const listRef = (row: typeof LIST) => ({ id: row.id, code: row.code, name: row.name, kind: row.kind, currency: 'EUR', status: 'ACTIVE', companyId: row.companyId })

const own = (of: Party, over: Partial<CommercialTerms> = {}): CommercialTerms => ({
  partyId: of.id,
  code: of.code,
  companyId: null,
  currency: 'EUR',
  language: 'it',
  paymentTermsId: DEP30.id,
  paymentTerms: named(DEP30),
  paymentTermsText: null,
  priceListId: LIST.id,
  priceList: listRef(LIST),
  discountGroup: null,
  priceChain: [listRef(LIST), listRef(BASE)],
  defaultDepositPct: '30',
  invoiceTiming: 'PER_SHIPMENT',
  invoiceTypePreset: 'TD01',
  incoterm: 'DAP',
  preferredCarrierCode: 'BRT',
  minimumOrderAmount: 150_000,
  version: 7,
  ...over,
})
const BLANK_OWN: Partial<CommercialTerms> = { paymentTermsId: null, paymentTerms: null, priceListId: null, priceList: null, priceChain: [], defaultDepositPct: null, invoiceTiming: 'PER_SHIPMENT', incoterm: null, preferredCarrierCode: null, minimumOrderAmount: null, version: 1 }

const carrier = (of: Party, over: Partial<CarrierAccount> = {}): CarrierAccount => ({ partyId: of.id, code: of.code, name: of.legalName, carrierCode: 'brt', carrierName: 'BRT', accountOnFile: true, freightBilling: 'COLLECT', defaultCarrierService: 'Express 24h', version: of.version, ...over })
const NO_CARRIER = (of: Party): CarrierAccount => carrier(of, { carrierCode: null, carrierName: null, accountOnFile: false, freightBilling: 'SENDER', defaultCarrierService: null })

const hold = (n: number, over: Partial<Hold> = {}): Hold => ({ id: uid('ct04', n), companyId: null, company: null, reason: 'DATA_MISSING', words: 'Waiting for the tax identity (made-up).', inForce: true, placedAt: dayFrom(-4), placedBy: 'Alex Demo', releasedAt: null, releasedBy: null, releaseWords: null, version: 1, mayRelease: true, ...over })
const NO_HOLDS: Holds = { onHold: false, holds: [], ordersWaiting: [], mayPlace: true, ordersWaitingCount: { onHold: 0, poNumber: 0, other: 0 } }
const waiting = (n: number, number: string, waitsFor: 'ACCOUNT_ON_HOLD' | 'PO_NUMBER_REQUIRED'): Holds['ordersWaiting'][number] => ({ quoteId: uid('ct05', n), number, revision: 1, quoteVersionId: uid('ct06', n), companyId: CT_COMPANY_A.id, customerRef: waitsFor === 'PO_NUMBER_REQUIRED' ? null : 'FAKE-PO-1', waitsFor })

type TermsRow = NonNullable<CompanyTerms['companies'][number]['terms']>
const termsRow = (n: number, companyId: string, over: Partial<TermsRow> = {}): TermsRow => ({ id: uid('ct07', n), companyId, paymentTermsId: null, paymentTermsLabel: null, paymentTermsText: null, priceListId: null, priceListLabel: null, depositPct: null, poNumberRequired: false, creditLimitAmount: null, creditLimitCurrency: null, setBy: 'Alex Demo', setAt: dayFrom(-20), endedAt: null, endedBy: null, version: 2, ...over })
/** One company's entry of the terms per company, in force by the server's own rule (a row's field wins, else the customer's own). */
function entry(company: typeof CT_COMPANY_A, live: TermsRow | null, of: CommercialTerms, history: readonly TermsRow[] = []): CompanyTerms['companies'][number] {
  const terms = live !== null && (live.paymentTermsId !== null || live.paymentTermsText !== null)
  const list = live !== null && live.priceListId !== null
  const deposit = live !== null && live.depositPct !== null
  const byId = (id: string | null) => PAYMENT_TERMS.find((row) => row.id === id)
  const termsId = terms ? live!.paymentTermsId : of.paymentTermsId
  return {
    company,
    terms: live,
    inForce: {
      paymentTermsId: termsId,
      paymentTermsText: terms ? live!.paymentTermsText : of.paymentTermsText,
      priceListId: list ? live!.priceListId : of.priceListId,
      depositPct: deposit ? live!.depositPct : of.defaultDepositPct,
      poNumberRequired: live?.poNumberRequired ?? false,
      source: { paymentTerms: terms ? 'COMPANY' : 'PARTY', priceList: list ? 'COMPANY' : 'PARTY', deposit: deposit ? 'COMPANY' : 'PARTY' },
      paymentTerms: byId(termsId) ? { ...named(byId(termsId)!), nameI18n: byId(termsId)!.nameI18n ?? null } : null,
      priceList: list ? { id: live!.priceListId!, code: live!.priceListLabel?.code ?? '', name: live!.priceListLabel?.name ?? '' } : of.priceList ? { id: of.priceList.id, code: of.priceList.code, name: of.priceList.name } : null,
    },
    mayChange: true,
    history: [...history],
  }
}
const companiesOf = (of: CommercialTerms, rows: readonly CompanyTerms['companies'][number][]): CompanyTerms => ({ partyId: of.partyId, code: of.code, tenantWide: rows.length > 1, partyVersion: 4, companies: [...rows] })

const rule = (n: number, over: Partial<Requirement> = {}): Requirement => ({ id: uid('ct08', n), companyId: null, companyCode: null, kind: 'PACKING', words: `Rule ${n} (made-up).`, appliesAt: ['ORDER'], styles: [], everyStyle: true, file: null, supersedesId: null, active: true, createdAt: dayFrom(-30 + n), createdBy: 'Alex Demo', endedAt: null, endedBy: null, endReason: null, version: 1, mayChange: true, ...over })
const NO_RULES: Requirements = { inForce: [], ended: [], mayAdd: true }

// ── the customers of the picture ──
export interface CtCustomer {
  readonly party: Party
  readonly commercial: CommercialTerms
  readonly carrier: CarrierAccount
  readonly holds: Holds
  readonly companies: CompanyTerms
  readonly requirements: Requirements
}

// A busy brand: something in every section.
const BUSY_PARTY = party(1, {
  code: 'SEED-BRAND',
  legalName: 'Seed Brand One S.r.l.',
  tradeName: 'Seed Brand',
  vatNumber: 'IT00000000001',
  taxIdentities: [identity(1, { vatNumber: 'IT00000000001' }), identity(11, { vatNumber: 'IT00000000011', sdiRecipientCode: null, pec: 'seed.brand@pec.example.com', validFrom: '2024-01-01', current: false })],
})
const BUSY_OWN = own(BUSY_PARTY)
const BUSY_V1 = rule(4, { kind: 'DOCUMENT', words: 'Packing list in English inside every box (made-up).', active: false, endedAt: dayFrom(-12), endedBy: 'Alex Demo', endReason: 'The new brand book asks for two languages (made-up).' })
export const CT_BUSY: CtCustomer = {
  party: BUSY_PARTY,
  commercial: BUSY_OWN,
  carrier: carrier(BUSY_PARTY),
  holds: {
    onHold: true,
    holds: [
      hold(1, { reason: 'QUALITY_DISPUTE', companyId: CT_COMPANY_A.id, company: { code: CT_COMPANY_A.code, name: CT_COMPANY_A.name }, words: 'Seam failures on a delivery; our inspection is pending (made-up).' }),
      hold(2, { reason: 'CREDIT', inForce: false, placedBy: null, words: 'Two invoices overdue (made-up).', placedAt: dayFrom(-60), releasedAt: dayFrom(-41), releasedBy: 'Franca Finance', releaseWords: 'Paid in full (made-up).' }),
    ],
    ordersWaiting: [waiting(1, 'Q-2026-0118', 'ACCOUNT_ON_HOLD')],
    mayPlace: true,
    ordersWaitingCount: { onHold: 1, poNumber: 0, other: 0 },
  },
  companies: companiesOf(BUSY_OWN, [
    entry(CT_COMPANY_A, termsRow(1, CT_COMPANY_A.id, { paymentTermsId: BB60.id, paymentTermsLabel: { code: BB60.code, name: BB60.name }, poNumberRequired: true }), BUSY_OWN, [termsRow(9, CT_COMPANY_A.id, { paymentTermsId: DEP30.id, paymentTermsLabel: { code: DEP30.code, name: DEP30.name }, depositPct: '20', setAt: dayFrom(-200), endedAt: dayFrom(-20), endedBy: 'Alex Demo' })]),
    entry(CT_COMPANY_B, null, BUSY_OWN),
  ]),
  requirements: {
    inForce: [
      rule(1, { kind: 'PACKING', words: 'Pallets no higher than 1.6 m; one style per carton (made-up).', appliesAt: ['ORDER', 'PACKING'] }),
      rule(2, { kind: 'LABEL', words: 'Hangtag with the brand barcode on the left sleeve (made-up).', everyStyle: false, styles: [{ id: uid('ct09', 1), code: 'SEED-JKT-01', name: 'Seed racing jacket' }, { id: uid('ct09', 2), code: '', name: '' }], companyId: CT_COMPANY_A.id, companyCode: CT_COMPANY_A.code }),
      rule(3, { kind: 'SHIPPING', words: 'Book the pick-up 48 h ahead; the routing guide is attached (made-up).', appliesAt: ['SHIPMENT'], file: { id: uid('ct10', 1), fileName: 'Routing guide demo.pdf' } }),
      rule(5, { kind: 'DOCUMENT', words: 'Packing list in English and Italian inside every box (made-up).', supersedesId: BUSY_V1.id, createdAt: dayFrom(-12) }),
    ],
    ended: [BUSY_V1, rule(6, { kind: 'INVOICING', words: 'One invoice per delivery note (made-up).', active: false, endedAt: dayFrom(-8), endedBy: 'Franca Finance', endReason: 'Monthly invoicing agreed instead (made-up).' })],
    mayAdd: true,
  },
}

// A new customer: the answer and one quiet line per section.
const NEW_PARTY = party(2, { code: 'SEED-NUOVO', legalName: 'Seed Customer Nuovo S.r.l.', tradeName: null, invoiceBlocked: true, warnings: [{ code: 'NO_TAX_IDENTITY', message: '', blocksInvoice: true }], attention: ['NO_TAX_IDENTITY'] })
const NEW_OWN = own(NEW_PARTY, BLANK_OWN)
export const CT_NEW: CtCustomer = { party: NEW_PARTY, commercial: NEW_OWN, carrier: NO_CARRIER(NEW_PARTY), holds: NO_HOLDS, companies: companiesOf(NEW_OWN, [entry(CT_COMPANY_A, null, NEW_OWN)]), requirements: NO_RULES }

// On hold for missing tax data: two accepted quotes wait — one for the hold, one for a PO number.
const HELD_PARTY = party(3, { code: 'SEED-FERMO', legalName: 'Seed Customer Fermo S.r.l.', tradeName: 'Seed Fermo', invoiceBlocked: true, warnings: [{ code: 'NO_TAX_IDENTITY', message: '', blocksInvoice: true }], attention: ['NO_TAX_IDENTITY'] })
const HELD_OWN = own(HELD_PARTY)
export const CT_HELD: CtCustomer = {
  party: HELD_PARTY,
  commercial: HELD_OWN,
  carrier: carrier(HELD_PARTY),
  holds: { onHold: true, holds: [hold(3, { placedBy: null, words: 'No tax identity: it cannot be invoiced yet (made-up).' })], ordersWaiting: [waiting(3, 'Q-2026-0131', 'ACCOUNT_ON_HOLD'), waiting(4, 'Q-2026-0134', 'PO_NUMBER_REQUIRED')], mayPlace: true, ordersWaitingCount: { onHold: 1, poNumber: 1, other: 0 } },
  companies: companiesOf(HELD_OWN, [entry(CT_COMPANY_A, termsRow(3, CT_COMPANY_A.id, { poNumberRequired: true }), HELD_OWN)]),
  requirements: NO_RULES,
}

// Two of our companies with different terms: a company's own row, and the customer's own.
const TWO_PARTY = party(4, { code: 'SEED-DUE', legalName: 'Seed Customer Due S.r.l.', tradeName: 'Seed Due', vatNumber: 'IT00000000004', taxIdentities: [identity(4)] })
const TWO_OWN = own(TWO_PARTY)
export const CT_TWO: CtCustomer = {
  party: TWO_PARTY,
  commercial: TWO_OWN,
  carrier: carrier(TWO_PARTY, { freightBilling: 'SENDER', accountOnFile: false }),
  holds: NO_HOLDS,
  companies: companiesOf(TWO_OWN, [
    entry(CT_COMPANY_A, termsRow(4, CT_COMPANY_A.id, { paymentTermsId: BB60.id, paymentTermsLabel: { code: BB60.code, name: BB60.name }, depositPct: '50', priceListId: BASE.id, priceListLabel: { code: BASE.code, name: BASE.name }, poNumberRequired: true }), TWO_OWN),
    entry(CT_COMPANY_B, null, TWO_OWN),
  ]),
  requirements: NO_RULES,
}

// EU: VIES could not be checked (no answer is never "not valid").
const EU_HELD_ID = identity(5, { country: 'DE', taxMode: 'EU_B2B', vatNumber: '000000000', sdiRecipientCode: null })
const EU_HELD_PARTY = party(5, { code: 'SEED-GMBH', legalName: 'Seed Customer Zwei GmbH', tradeName: null, country: 'DE', language: 'de', taxMode: 'EU_B2B', vatNumber: '000000000', taxIdentities: [EU_HELD_ID], vies: standing('HELD', { checkedAt: dayFrom(-1) }), viesChecks: [check(5, { result: 'ERROR', requestedAt: dayFrom(-1), consultationNumber: null, errorCode: 'MS_UNAVAILABLE', errorMeaning: 'Member state unavailable' })] })
const EU_HELD_OWN = own(EU_HELD_PARTY, { language: 'de', incoterm: 'DAP' })
export const CT_EU_HELD: CtCustomer = { party: EU_HELD_PARTY, commercial: EU_HELD_OWN, carrier: carrier(EU_HELD_PARTY), holds: NO_HOLDS, companies: companiesOf(EU_HELD_OWN, [entry(CT_COMPANY_A, null, EU_HELD_OWN)]), requirements: NO_RULES }

// EU: the proof ends in three days.
const EU_ENDS_ID = identity(6, { country: 'FR', taxMode: 'EU_B2B', vatNumber: '00000000000', sdiRecipientCode: null })
const EU_ENDS_CHECK = check(6, { countryCode: 'FR', vatNumber: '00000000000', requestedAt: dayFrom(-27), traderName: 'SEED CLIENT TROIS SARL', traderAddress: '1 rue Exemple, 00000 Exemple' })
const EU_ENDS_PARTY = party(6, { code: 'SEED-SARL', legalName: 'Seed Client Trois SARL', tradeName: null, country: 'FR', language: 'fr', taxMode: 'EU_B2B', vatNumber: '00000000000', taxIdentities: [EU_ENDS_ID], vies: standing('VALID', { proofCheckId: EU_ENDS_CHECK.id, checkedAt: EU_ENDS_CHECK.requestedAt, validUntil: dayFrom(3) }), viesChecks: [EU_ENDS_CHECK] })
const EU_ENDS_OWN = own(EU_ENDS_PARTY, { language: 'fr' })
export const CT_EU_ENDS: CtCustomer = { party: EU_ENDS_PARTY, commercial: EU_ENDS_OWN, carrier: carrier(EU_ENDS_PARTY), holds: NO_HOLDS, companies: companiesOf(EU_ENDS_OWN, [entry(CT_COMPANY_A, null, EU_ENDS_OWN)]), requirements: NO_RULES }

// A sole trader: a PERSON with a VAT number and a codice fiscale (D2: the codice fiscale only for those who may change customers).
export const CT_SOLE_FISCAL_CODE = 'XXXXXX00X00X000X'
const SOLE_PARTY = party(7, { code: 'SEED-SOLO', legalName: 'Solo Demo', tradeName: 'Seed Solo Moto', kind: 'PERSON', vatNumber: 'IT00000000007', fiscalCode: CT_SOLE_FISCAL_CODE, taxIdentities: [identity(7, { vatNumber: 'IT00000000007', fiscalCode: CT_SOLE_FISCAL_CODE, sdiRecipientCode: null, pec: 'seed.solo@pec.example.com' })] })
const SOLE_OWN = own(SOLE_PARTY, { paymentTermsId: BB60.id, paymentTerms: named(BB60), defaultDepositPct: null, minimumOrderAmount: null })
export const CT_SOLE: CtCustomer = { party: SOLE_PARTY, commercial: SOLE_OWN, carrier: NO_CARRIER(SOLE_PARTY), holds: NO_HOLDS, companies: companiesOf(SOLE_OWN, [entry(CT_COMPANY_A, null, SOLE_OWN)]), requirements: NO_RULES }

// Many rows: twelve requirements in force (kind chips from six), replaced and ended ones.
const KINDS = ['PACKING', 'LABEL', 'DOCUMENT', 'SHIPPING', 'QUALITY', 'INVOICING'] as const
const MANY_PARTY = party(8, { code: 'SEED-MOLTI', legalName: 'Seed Customer Molti S.r.l.', tradeName: 'Seed Molti', vatNumber: 'IT00000000008', taxIdentities: [identity(8)] })
const MANY_OWN = own(MANY_PARTY)
const MANY_OLD = [rule(40, { kind: 'PACKING', words: 'Old carton rule (made-up).', active: false, endedAt: dayFrom(-15), endedBy: 'Alex Demo', endReason: 'New carton size (made-up).' }), rule(41, { kind: 'LABEL', words: 'Old label rule (made-up).', active: false, endedAt: dayFrom(-9), endedBy: 'Alex Demo', endReason: 'Replaced by the brand book (made-up).' })]
export const CT_MANY: CtCustomer = {
  party: MANY_PARTY,
  commercial: MANY_OWN,
  carrier: carrier(MANY_PARTY),
  holds: NO_HOLDS,
  companies: companiesOf(MANY_OWN, [entry(CT_COMPANY_A, null, MANY_OWN), entry(CT_COMPANY_B, null, MANY_OWN)]),
  requirements: {
    inForce: Array.from({ length: 12 }, (_, at) =>
      rule(20 + at, { kind: KINDS[at % KINDS.length]!, words: `Requirement ${at + 1} of Seed Molti (made-up).`, appliesAt: at % 4 === 0 ? ['SHIPMENT'] : ['ORDER'], ...(at === 0 ? { supersedesId: MANY_OLD[0]!.id } : at === 1 ? { supersedesId: MANY_OLD[1]!.id } : {}) }),
    ),
    ended: [...MANY_OLD, rule(42, { kind: 'QUALITY', words: 'A first inspection on every lot (made-up).', active: false, endedAt: dayFrom(-4), endedBy: 'Alex Demo', endReason: 'No longer asked (made-up).' })],
    mayAdd: true,
  },
}

// ── one case: the customer, the reader, its reads' states, the tab's own state, the room, the window opened ──
export const CT_READS = ['commercial', 'carrier', 'holds', 'companies', 'requirements', 'history'] as const
export type CtRead = (typeof CT_READS)[number]
export type CtReadState = 'reading' | 'failed'
export type CtRoom = 343 | 865 | 1314 | 1794
/** A NEW window of the tab, its inside drawn on a plain card under the tab. */
export type CtWindow = 'terms' | 'terms-problems' | 'terms-refused' | 'delivery' | 'delivery-replace' | 'company' | 'company-po' | 'end'

export interface CtCaseModel {
  readonly customer: CtCustomer
  readonly role: CtRole
  /** The rights held; absent: the role's grant. */
  readonly held?: readonly string[]
  /** A read still out or failed (absent: in). */
  readonly reads?: Partial<Record<CtRead, CtReadState>>
  readonly state?: Partial<TermsTabState>
  /** The tab's room in px (every list chooses its columns by the room it has). */
  readonly room?: CtRoom
  readonly window?: CtWindow
  /** A VIES check runs now (Check again held by state). */
  readonly viesRunning?: boolean
}

export const ctHeld = (ct: CtCaseModel): readonly string[] => ct.held ?? ctRoleHeld(ct.role)

const readOf = <T>(value: T, state: CtReadState | undefined, problem: string = FAIL): Read<T> => (state === 'reading' ? LOADING : state === 'failed' ? failedRead(problem) : ready(value))

/** The reads of a case as the API gives them to this reader: no amount without the price grain, no quote number without quotes.view. */
function walled(customer: CtCustomer, held: readonly string[]): CtCustomer {
  const price = held.includes('money.price')
  const quotes = held.includes('quotes.view')
  return {
    ...customer,
    commercial: price ? customer.commercial : { ...customer.commercial, minimumOrderAmount: null },
    holds: quotes ? customer.holds : { ...customer.holds, ordersWaiting: [] },
    companies: price ? customer.companies : { ...customer.companies, companies: customer.companies.companies.map((item) => ({ ...item, terms: item.terms ? { ...item.terms, creditLimitAmount: null } : null })) },
  }
}

/** The window of a case, opened as the container opens it. */
function windowOf(win: CtWindow, customer: CtCustomer): TermsTabWindow {
  const first = customer.companies.companies[0]!
  if (win === 'terms') return termsWindowOf(customer.commercial)
  if (win === 'terms-problems') {
    const open = termsWindowOf(customer.commercial)
    return { ...open, draft: { ...open.draft, defaultDepositPct: '130', minimumOrder: 'abc' }, tried: true }
  }
  if (win === 'terms-refused') return { ...termsWindowOf(customer.commercial), tried: true, problem: 'terms.refused.moved' }
  if (win === 'delivery') return deliveryWindowOf(customer.carrier)
  if (win === 'delivery-replace') return { ...deliveryWindowOf(customer.carrier), account: 'replace', number: '000000' }
  if (win === 'company') return companyWindowOf(first, false)
  if (win === 'company-po') return companyWindowOf(first, true)
  return companyEndWindowOf(first.company.id)
}

export interface CtTab {
  readonly reads: TermsTabReads
  /** The tab as the view draws it: its windows closed (their insides are drawn on a plain card). */
  readonly model: TermsTabModel
  /** The same with the case's window open: the windows' own model. */
  readonly open: TermsTabModel
  readonly window: TermsTabWindow | null
}

/** The tab of a case, as the container builds it: the server's walls applied by the rights the reader holds. */
export function ctTabOf(ct: CtCaseModel, locale: 'en' | 'it' = 'en'): CtTab {
  const held = ctHeld(ct)
  const customer = walled(ct.customer, held)
  const state = ct.reads ?? {}
  const can = termsCan(held)
  const reads: TermsTabReads = {
    party: customer.party,
    prefix: PREFIX,
    can,
    locale,
    now: NOW,
    companyId: CT_COMPANY_A.id,
    companyNames: NAMES,
    commercial: readOf(customer.commercial, state.commercial),
    carrier: readOf(customer.carrier, state.carrier),
    holds: readOf(customer.holds, state.holds, DEPTH_FAIL),
    companies: readOf(customer.companies, state.companies, DEPTH_FAIL),
    requirements: readOf(customer.requirements, state.requirements, DEPTH_FAIL),
    library: can.paymentTerms ? ready(PAYMENT_TERMS) : null,
    lists: can.lists ? ready(LIST_ROWS) : null,
    history: state.history === 'reading' ? { items: null } : state.history === 'failed' ? { items: null, problem: 'problem.unavailable' } : { items: customer.party.viesChecks, more: false, next: null },
    viesRunning: ct.viesRunning === true,
  }
  const shown: TermsTabState = { ...TERMS_TAB_START, ...ct.state }
  const window = ct.window ? windowOf(ct.window, customer) : null
  return { reads, model: termsTabModel(reads, shown), open: termsTabModel(reads, { ...shown, window }), window }
}

/** A NEW window's inside on a plain card: its title, its body (the window's own part). */
function WindowInside({ window, model }: { window: TermsTabWindow; model: TermsTabModel }): ReactNode {
  const say = useTermsSay()
  const card = (title: Said, body: ReactNode) => createElement(Card, { padded: true }, createElement('div', { className: 'fw-pt-body' }, createElement('h2', { className: 'fw-pt-h2' }, say(title)), body))
  const windows = model.windows
  const company = (id: string) => NAMES[id] ?? id
  if (window.kind === 'terms') return card(said('ct.win.terms.title', { params: { customer: windows.customer } }), createElement(ChangeTermsBody, { window, windows }))
  if (window.kind === 'delivery') return card(said('ct.win.deliv.title', { params: { customer: windows.customer } }), createElement(DeliveryBody, { window, windows }))
  if (window.kind === 'company') return card(window.poOnly ? said('sales-customers-depth:po.title') : said('ct.win.co.title', { params: { company: company(window.companyId) } }), createElement(CompanyTermsBody, { window, windows }))
  return card(said('ct.win.end.title', { params: { company: company(window.companyId) } }), createElement(CompanyEndBody, { window, windows }))
}

/** The design's Terms & requirements tab of a case: the tab in its room, and the window's inside under it. */
export function CtTermsDesign({ ct }: { ct: CtCaseModel }): ReactNode {
  const locale = useLocale()
  const { model, open, window } = ctTabOf(ct, locale)
  const tab = createElement(TermsTab, { model, hold: null, requirements: null })
  const room: CSSProperties | null = ct.room ? { width: `${ct.room}px`, maxWidth: '100%' } : null
  const box: HTMLAttributes<HTMLDivElement> & { readonly 'data-ct-room'?: number } = { 'data-ct-room': ct.room, style: room ?? undefined }
  return createElement(WithMessages, { namespaces: TERMS_TAB_NAMESPACES }, createElement('div', box, tab, window ? createElement(WindowInside, { window, model: open }) : null))
}

// ── the cases (ids `ct-*`; the labels say what each shows) ──
const busy = (over: Partial<CtCaseModel> = {}): CtCaseModel => ({ customer: CT_BUSY, role: 'owner', ...over })
const every = (state: CtReadState) => Object.fromEntries(CT_READS.map((read) => [read, state])) as Record<CtRead, CtReadState>
const one = (read: CtRead, state: CtReadState) => Object.fromEntries([[read, state]]) as Partial<Record<CtRead, CtReadState>>
const ARCHIVED_BUSY: CtCustomer = { ...CT_BUSY, party: { ...CT_BUSY.party, status: 'ARCHIVED' } }
const roleId = (role: CtRole) => role.replace('_', '-')

export const CT_CASES: readonly { readonly id: string; readonly label: string; readonly ct: CtCaseModel }[] = [
  // The customers of the picture (as the Owner reads them).
  { id: 'ct-busy', label: 'ct · A busy brand: something in every section — a hold for one company, two companies, the carrier, four rules, the identity with an earlier one (the Owner)', ct: busy() },
  { id: 'ct-new', label: 'ct · A new customer: the answer and one quiet line per section', ct: { customer: CT_NEW, role: 'owner' } },
  { id: 'ct-held', label: 'ct · On hold for missing tax data: two accepted quotes wait — one for the hold, one for a PO number', ct: { customer: CT_HELD, role: 'owner' } },
  { id: 'ct-two-companies', label: 'ct · Two of our companies with different terms: Seed Company A\'s own row, Seed Company B the customer\'s own', ct: { customer: CT_TWO, role: 'owner' } },
  { id: 'ct-eu-no-answer', label: 'ct · EU: VIES could not be checked — "No answer", never "not valid"; Check again', ct: { customer: CT_EU_HELD, role: 'owner' } },
  { id: 'ct-eu-ends', label: 'ct · EU: the VIES proof ends in 3 days (a warning)', ct: { customer: CT_EU_ENDS, role: 'owner' } },
  { id: 'ct-eu-checking', label: 'ct · EU: a VIES check runs (Check again held by state)', ct: { customer: CT_EU_ENDS, role: 'owner', viesRunning: true } },
  { id: 'ct-many', label: 'ct · Many rows: 12 requirements in force (kind chips), replaced and ended ones folded', ct: { customer: CT_MANY, role: 'owner' } },
  // The sole trader, each role (D2: the codice fiscale only for those who may change customers).
  ...CT_ROLES.map((role) => ({ id: `ct-sole-${roleId(role)}`, label: `ct · A sole trader with a codice fiscale, as ${role.replace('_', ' ')}`, ct: { customer: CT_SOLE, role } })),
  // The tab's own states.
  { id: 'ct-chip-hold', label: 'ct · The hold chip pressed: Hold marks its row', ct: busy({ state: { chip: 'hold' } }) },
  { id: 'ct-folds-open', label: 'ct · Every fold open: released holds, ended company terms, ended and replaced rules, earlier identities, every VIES check', ct: busy({ state: { releasedOpen: true, endedOpen: true, requirementsEndedOpen: true, earlierOpen: true, checksOpen: true } }) },
  { id: 'ct-kind-chip', label: 'ct · A kind chip pressed: Requirements shows only its kind', ct: { customer: CT_MANY, role: 'owner', state: { kind: 'LABEL' } } },
  { id: 'ct-archived', label: 'ct · An archived customer: every change held by its state', ct: { customer: ARCHIVED_BUSY, role: 'owner' } },
  // The office roles (their template's REAL grant).
  ...CT_ROLES.map((role) => ({ id: `ct-role-${roleId(role)}`, label: `ct · As ${role.replace('_', ' ')}: the busy brand with exactly the acts and parts the role has`, ct: busy({ role }) })),
  // Reading (each read on its own; the rest of the tab draws).
  { id: 'ct-reading-all', label: 'ct · Every read out: each section says it reads', ct: busy({ reads: every('reading') }) },
  ...CT_READS.map((read) => ({ id: `ct-reading-${read}`, label: `ct · The ${read} read still out: its part waits, the rest draws`, ct: busy({ reads: one(read, 'reading') }) })),
  // Failed (each read with its own Try again; a failed read is never 0).
  { id: 'ct-failed-all', label: 'ct · Every read failed: each part its own Try again', ct: busy({ reads: every('failed') }) },
  ...CT_READS.map((read) => ({ id: `ct-failed-${read}`, label: `ct · The ${read} read failed: its own Try again, the rest draws`, ct: busy({ reads: one(read, 'failed') }) })),
  // The rooms (every list chooses its columns by the room it has).
  { id: 'ct-room-343', label: 'ct · The room of a phone (343 px): every row stacks', ct: busy({ room: 343 }) },
  { id: 'ct-room-865', label: 'ct · 865 px (the tab beside a docked thread)', ct: busy({ room: 865 }) },
  { id: 'ct-room-1314', label: 'ct · 1314 px', ct: busy({ room: 1314 }) },
  { id: 'ct-room-1794', label: 'ct · 1794 px: the widest room, every column', ct: busy({ room: 1794 }) },
  // The NEW windows' insides on a plain card (a Modal never opens on the server render).
  { id: 'ct-win-terms', label: 'ct · Change the terms (its inside): payment terms, deposit, price list, currency, minimum, language, Incoterm, invoicing', ct: busy({ window: 'terms' }) },
  { id: 'ct-win-terms-problems', label: 'ct · Change the terms (its inside): the deposit and the minimum refused at their fields', ct: busy({ window: 'terms-problems' }) },
  { id: 'ct-win-terms-refused', label: 'ct · Change the terms (its inside): someone changed them meanwhile', ct: busy({ window: 'terms-refused' }) },
  { id: 'ct-win-delivery', label: 'ct · Change delivery (its inside): carrier, service, who pays the freight, the account on file', ct: busy({ window: 'delivery' }) },
  { id: 'ct-win-delivery-replace', label: 'ct · Change delivery (its inside): a new account number typed (never shown again)', ct: busy({ window: 'delivery-replace' }) },
  { id: 'ct-win-company', label: 'ct · Terms with Seed Company A (its inside): its own payment terms, deposit, price list, PO rule', ct: busy({ window: 'company' }) },
  { id: 'ct-win-company-po', label: 'ct · Customer PO number required (its inside): the PO rule only', ct: { customer: CT_HELD, role: 'owner', window: 'company-po' } },
  { id: 'ct-win-end', label: 'ct · Back to the customer\'s terms (its inside): what ends and what takes over', ct: busy({ window: 'end' }) },
]

/** The cases by part of the picture: the gallery tests draw them per language and per part (a long gallery test is split). */
export const CT_PARTS = {
  picture: ['ct-busy', 'ct-new', 'ct-held', 'ct-two-companies', 'ct-eu-no-answer', 'ct-eu-ends', 'ct-eu-checking', 'ct-many'],
  sole: CT_ROLES.map((role) => `ct-sole-${roleId(role)}`),
  states: ['ct-chip-hold', 'ct-folds-open', 'ct-kind-chip', 'ct-archived'],
  roles: CT_ROLES.map((role) => `ct-role-${roleId(role)}`),
  reading: ['ct-reading-all', ...CT_READS.map((read) => `ct-reading-${read}`)],
  failed: ['ct-failed-all', ...CT_READS.map((read) => `ct-failed-${read}`)],
  rooms: ['ct-room-343', 'ct-room-865', 'ct-room-1314', 'ct-room-1794'],
  windows: ['ct-win-terms', 'ct-win-terms-problems', 'ct-win-terms-refused', 'ct-win-delivery', 'ct-win-delivery-replace', 'ct-win-company', 'ct-win-company-po', 'ct-win-end'],
} as const
