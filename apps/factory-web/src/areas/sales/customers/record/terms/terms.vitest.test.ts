import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { Party, TaxIdentity, ViesCheck } from '../../../../parties/_shared/api'
import { CUSTOMERS } from '../../../../parties/_shared/fixtures'
import type { CommercialTerms } from '../../terms/api'
import type { Holds, Requirement, Requirements } from '../../depth/api'
import { ready, failedRead, LOADING } from '../../depth/model'
import { identityFactsOf, termsAnswer, type TermsFacts } from './answer'
import { commercialSection, type CarrierFacts, type CommercialInput, type CompanyTermsRead, type CompanyTermsReadEntry, type CompanyTermsRow } from './commercial'
import { holdSection, waitingOf, type HoldFacts, type HoldsFacts, type HoldsInput } from './holds'
import { depositInForce, paymentTermsInForce, termsInForce, type TermsSources } from './in-force'
import { CT, said, sayOf, sentenceOf, TERMS_SECTIONS, TERMS_TAB_NAMESPACES, termsCan, type Said } from './model'
import { createApiClient, type ApiClient } from '../../../../../lib/api/client'
import { ApiError } from '../../../../../lib/api/errors'
import { termsAbilitiesOf } from '../../terms/model'
import { TERMS as COMPANY_TERMS } from '../../depth/_demo/fixtures'
import { endCompanyTerms, readCarrierAccount, setCarrierAccount, setCompanyTerms, type CarrierAccount } from './api'
import { TERMS_TAB_START, termsTabModel, type TermsTabReads, type TermsTabState } from './tab'
import { endedLine, keptWords, requirementsSection, versionsOf, type RequirementsInput } from './requirements'
import { datedIdentities, fiscalCodeHidden, identitySection, type IdentityInput } from './identity'
import { problemKey, refusedFields } from '../../../../parties/_shared/model'
import { companyBody, companyEndWindowOf, companyProblems, companyWindowOf, deliveryBody, deliveryProblems, deliveryRefusal, deliveryWindowOf, endLines, termsWindowOf, termsWindowPatch } from './windows'
import { createElement, type ComponentType, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TermsTab } from '../view/terms/TermsTab'
import { ChangeTermsBody } from '../view/terms/ChangeTermsDialog'
import { DeliveryBody } from '../view/terms/DeliveryDialog'
import { CompanyEndBody, CompanyTermsBody } from '../view/terms/CompanyTermsDialog'
import { TermsNotices } from '../view/terms/TermsNotices'
import { designScreen as customerRecordScreen } from '../fixtures'

/**
 * F-CT-101…105 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 15-steps W1.1) — the tab's pure rules: the ONE source of the terms
 * in force (a company's own row wins, field by field, and says so; the customer's own next; the typed text last; "30 %" as Money says
 * it), the answer line and its chips in both languages, Hold and Commercial terms, every act HIDDEN without its right and held only by
 * state, and the walls (no other customer's count of the payment-terms library). Made-up data only.
 */

const NOW = '2026-11-24T09:00:00.000Z'
const say = (locale: Locale) => sayOf(createScopedTranslator(locale, messagesFor(locale, [...TERMS_TAB_NAMESPACES]), CT), locale)
const said1 = (words: Said, locale: Locale = 'en') => say(locale)(words)
const sentence = (answer: ReturnType<typeof termsAnswer>, locale: Locale) => [answer.lead ? say(locale)(answer.lead) : '', sentenceOf(answer.words.map(say(locale)), locale)].filter(Boolean).join(' ')

// ---- made-up reads ------------------------------------------------------------------------------------------------------------

const A = { id: '0190f0e2-c700-7000-8000-000000000001', code: 'SEEDA', name: 'Seed Company A' }
const B = { id: '0190f0e2-c700-7000-8000-000000000002', code: 'SEEDB', name: 'Seed Company B' }
const PARTY_ID = '0190f0e2-c700-7000-8000-000000000101'
const NET30 = { id: '0190f0e2-c700-7000-8000-000000000201', code: 'NET30EOM', name: 'Net 30 end of month', nameI18n: { en: 'Net 30 end of month', it: 'Netto 30 fine mese' }, companyId: null, status: 'ACTIVE', summary: { en: 'Paid 30 days after the end of the invoice month', it: 'Pagato 30 giorni dopo la fine del mese della fattura' }, deposit: null }
const DEP30 = { id: '0190f0e2-c700-7000-8000-000000000202', code: 'DEP30', name: '30% deposit, balance before shipping', nameI18n: { en: '30% deposit, balance before shipping', it: 'Acconto 30%, saldo prima della spedizione' }, companyId: null, status: 'ACTIVE', summary: { en: '30% with the order, the rest before shipping', it: "30% all'ordine, il resto prima della spedizione" }, deposit: { sharePct: '30', days: 0 } }

function own(over: Partial<CommercialTerms> = {}): CommercialTerms {
  return {
    partyId: PARTY_ID,
    code: 'SEED-ONE',
    companyId: null,
    currency: 'EUR',
    language: 'it',
    paymentTermsId: NET30.id,
    paymentTerms: NET30,
    paymentTermsText: null,
    priceListId: '0190f0e2-c700-7000-8000-000000000301',
    priceList: { id: '0190f0e2-c700-7000-8000-000000000301', code: 'SEED-LIST', name: 'Seed list 2026', kind: 'CUSTOMER', currency: 'EUR', status: 'ACTIVE', companyId: null },
    discountGroup: null,
    priceChain: [],
    defaultDepositPct: '30',
    invoiceTiming: 'PER_SHIPMENT',
    invoiceTypePreset: 'TD01',
    incoterm: null,
    preferredCarrierCode: null,
    minimumOrderAmount: 150_000,
    version: 7,
    ...over,
  }
}

const row = (over: Partial<CompanyTermsRow> = {}): CompanyTermsRow => ({
  id: '0190f0e2-c700-7000-8000-000000000401',
  paymentTermsId: null,
  paymentTermsLabel: null,
  paymentTermsText: null,
  priceListId: null,
  priceListLabel: null,
  depositPct: null,
  poNumberRequired: false,
  creditLimitCurrency: null,
  setAt: '2026-11-04T10:00:00.000Z',
  endedAt: null,
  endedBy: null,
  version: 2,
  ...over,
})

/** One company's entry: its live row (or none) and what is in force, by the server's own rule (a row's field wins). */
function entry(company: typeof A, live: CompanyTermsRow | null, party: CommercialTerms, over: Partial<CompanyTermsReadEntry> = {}): CompanyTermsReadEntry {
  const terms = live !== null && (live.paymentTermsId !== null || live.paymentTermsText !== null)
  const list = live !== null && live.priceListId !== null
  const deposit = live !== null && live.depositPct !== null
  return {
    company,
    terms: live,
    inForce: {
      paymentTermsId: terms ? live!.paymentTermsId : party.paymentTermsId,
      paymentTermsText: terms ? live!.paymentTermsText : party.paymentTermsText,
      priceListId: list ? live!.priceListId : party.priceListId,
      depositPct: deposit ? live!.depositPct : party.defaultDepositPct,
      poNumberRequired: live?.poNumberRequired ?? false,
      source: { paymentTerms: terms ? 'COMPANY' : 'PARTY', priceList: list ? 'COMPANY' : 'PARTY', deposit: deposit ? 'COMPANY' : 'PARTY' },
    },
    mayChange: true,
    history: [],
    ...over,
  }
}

const OWNER = termsCan(['parties.view', 'parties.manage', 'parties.hold', 'parties.vies', 'paymentterms.view', 'pricelists.view', 'pricelists.manage', 'money.price', 'quotes.view', 'files.read', 'product.styles.view', 'audit.read', 'invoices.view'])
/** Sales (10-design §9): every act its rights allow, no selling prices. */
const SALES = termsCan(['parties.view', 'parties.manage', 'parties.hold', 'parties.vies', 'paymentterms.view', 'pricelists.view', 'quotes.view', 'files.read', 'sales.credit.view'])
/** Production manager: the facts only, no quote numbers. */
const PM = termsCan(['parties.view', 'files.read', 'audit.read'])
/** Read-only: the facts only. */
const RO = termsCan(['parties.view', 'quotes.view', 'files.read', 'receivables.view'])

const MODA = CUSTOMERS.find((party) => party.code === 'MODA-DEMO')!
const identity = (over: Partial<TaxIdentity> = {}): TaxIdentity => ({ id: '0190f0e2-c700-7000-8000-000000000501', country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000000', fiscalCode: null, sdiRecipientCode: 'FAKE001', pec: null, validFrom: '2026-01-01', current: true, version: 1, createdAt: NOW, updatedAt: NOW, ...over })
const partyWith = (over: Partial<Party>): Party => ({ ...MODA, ...over })

const hold = (over: Partial<HoldFacts> = {}): HoldFacts => ({ id: '0190f0e2-c700-7000-8000-000000000601', companyId: null, company: null, reason: 'DATA_MISSING', words: 'Waiting for the tax identity (made-up).', inForce: true, placedAt: '2026-11-20T08:00:00.000Z', placedBy: 'Alex Demo', releasedAt: null, releasedBy: null, releaseWords: null, version: 1, ...over })
const HOLDS: Holds = {
  onHold: true,
  holds: [hold(), hold({ id: '0190f0e2-c700-7000-8000-000000000602', reason: 'CREDIT', inForce: false, placedBy: null, words: 'Two invoices overdue (made-up).', releasedAt: '2026-10-09T11:00:00.000Z', releasedBy: 'Franca Finance', releaseWords: 'Paid in full (made-up).' })],
  ordersWaiting: [
    { quoteId: '0190f0e2-c700-7000-8000-000000000701', number: 'Q-2026-0118', revision: 2, quoteVersionId: '0190f0e2-c700-7000-8000-000000000711', companyId: A.id, customerRef: 'FAKE-PO-1', waitsFor: 'ACCOUNT_ON_HOLD' },
    { quoteId: '0190f0e2-c700-7000-8000-000000000702', number: 'Q-2026-0121', revision: 1, quoteVersionId: '0190f0e2-c700-7000-8000-000000000712', companyId: A.id, customerRef: null, waitsFor: 'PO_NUMBER_REQUIRED' },
  ],
  mayPlace: true,
  ordersWaitingCount: { onHold: 1, poNumber: 1, other: 0 },
}
const NAMES = { [A.id]: A.name, [B.id]: B.name }
const holdsInput = (over: Partial<HoldsInput> = {}): HoldsInput => ({ read: ready(HOLDS), can: OWNER, archived: false, hasIdentity: false, customer: 'Seed Customer One S.r.l.', companyNames: NAMES, prefix: '/w/SEEDA', partyId: PARTY_ID, releasedOpen: false, ...over })

// ---- the one source ------------------------------------------------------------------------------------------------------------

describe('the ONE source: the terms in force with a company (in-force.ts, 13-backend §4.1, Z32)', () => {
  const party = own()
  const company = row({ paymentTermsId: DEP30.id, paymentTermsLabel: { code: DEP30.code, name: DEP30.name }, depositPct: '40' })
  const sources = (over: Partial<TermsSources> = {}): TermsSources => ({ commercial: party, companies: { tenantWide: true, companies: [entry(A, company, party), entry(B, null, party)] }, companyId: A.id, typed: null, ...over })

  it("a company's own terms win, field by field, and say their source; the customer's own are next; the typed text last", () => {
    const withA = termsInForce(sources(), 'en')
    expect(withA.paymentTerms).toMatchObject({ code: 'DEP30', source: 'COMPANY', company: 'Seed Company A', typed: false })
    expect(withA.deposit).toEqual({ pct: '40', from: 'COMPANY', source: 'COMPANY' })
    expect(withA.priceList).toMatchObject({ code: 'SEED-LIST', source: 'PARTY' }) // the row gives no list: the customer's own
    const withB = termsInForce(sources({ companyId: B.id }), 'en')
    expect(withB.paymentTerms).toMatchObject({ code: 'NET30EOM', name: 'Net 30 end of month', source: 'PARTY', company: null })
    expect(withB.deposit).toEqual({ pct: '30', from: 'PARTY', source: 'PARTY' })
    const typed = paymentTermsInForce({ commercial: null, companies: null, companyId: A.id, typed: '60 days, bank transfer (typed, made-up)' }, 'en')
    expect(typed).toMatchObject({ name: '60 days, bank transfer (typed, made-up)', typed: true, source: 'PARTY' })
    expect(paymentTermsInForce({ commercial: null, companies: null, companyId: null, typed: null }, 'en')).toBeNull()
  })

  it('the payment terms are named in the page language, with their meaning (P0-B8)', () => {
    expect(paymentTermsInForce(sources({ companyId: B.id }), 'it')).toMatchObject({ name: 'Netto 30 fine mese', meaning: 'Pagato 30 giorni dopo la fine del mese della fattura' })
    // S5 on main: the company row's terms named in both languages too.
    const named = entry(A, company, party)
    const s5 = { ...named, inForce: { ...named.inForce, paymentTerms: DEP30 } }
    expect(paymentTermsInForce(sources({ companies: { tenantWide: true, companies: [s5] } }), 'it')).toMatchObject({ name: 'Acconto 30%, saldo prima della spedizione', source: 'COMPANY', orderShare: '30' })
  })

  it("the deposit: the company's percent › the customer's percent › the order share of the terms in force › the sales settings (P17)", () => {
    const noPct = own({ defaultDepositPct: null, paymentTerms: DEP30, paymentTermsId: DEP30.id })
    expect(depositInForce({ commercial: noPct, companies: null, companyId: null, typed: null })).toEqual({ pct: '30', from: 'TERMS', source: 'PARTY' })
    expect(depositInForce({ commercial: own({ defaultDepositPct: null }), companies: null, companyId: null, typed: null })).toEqual({ pct: null, from: 'SETTINGS', source: 'PARTY' })
  })

  it("invoicing and currency are always the customer's own; without the company read the customer's own terms answer (and the PO rule is unknown)", () => {
    const monthly = own({ invoiceTiming: 'MONTHLY', currency: 'CHF' })
    expect(termsInForce({ commercial: monthly, companies: { tenantWide: true, companies: [entry(A, company, monthly)] }, companyId: A.id, typed: null }, 'en')).toMatchObject({ invoicing: 'MONTHLY', currency: 'CHF', companyRead: true })
    const alone = termsInForce({ commercial: party, companies: null, companyId: A.id, typed: null }, 'en')
    expect(alone).toMatchObject({ companyRead: false, poNumberRequired: null })
    expect(alone.paymentTerms?.source).toBe('PARTY')
  })

  it('a customer of one company: its one row answers whatever company is asked', () => {
    const single = row({ poNumberRequired: true })
    expect(termsInForce({ commercial: party, companies: { tenantWide: false, companies: [entry(A, single, party)] }, companyId: B.id, typed: null }, 'en').poNumberRequired).toBe(true)
  })

  it('"30 %" as Money says it (one percent format: pctOf), in both languages', () => {
    expect(said1(said('customer-money:cm.credit.pct', { pcts: { pct: '30' } }), 'en')).toBe('30 %')
    expect(said1(said('customer-money:cm.credit.pct', { pcts: { pct: '30.5' } }), 'it')).toBe('30,5 %')
  })
})

// ---- the answer line ------------------------------------------------------------------------------------------------------------

describe('the answer line and its chips (answer.ts, 10-design §4)', () => {
  const holds = holdSection(holdsInput())
  const facts = (over: Partial<TermsFacts> = {}): TermsFacts => ({
    multi: false,
    company: A.name,
    inForce: termsInForce({ commercial: own(), companies: { tenantWide: false, companies: [entry(A, row({ poNumberRequired: true }), own())] }, companyId: A.id, typed: null }, 'en'),
    companiesFailed: false,
    blank: false,
    holds: [],
    waiting: waitingOf(null, OWNER, NAMES, '/w/SEEDA', PARTY_ID),
    requirements: 4,
    identity: identityFactsOf(partyWith({ taxIdentities: [identity()], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })),
    now: NOW,
    ...over,
  })

  it('a busy brand: one sentence, in English and in Italian', () => {
    const answer = termsAnswer(facts())
    expect(sentence(answer, 'en')).toBe('Net 30 end of month · 30 % deposit · PO number required · 4 requirements · e-invoices by SDI code.')
    const it_ = termsAnswer({ ...facts(), inForce: termsInForce({ commercial: own(), companies: { tenantWide: false, companies: [entry(A, row({ poNumberRequired: true }), own())] }, companyId: A.id, typed: null }, 'it') })
    expect(sentence(it_, 'it')).toBe("Netto 30 fine mese · acconto 30 % · numero d'ordine del cliente obbligatorio · 4 requisiti · fatture elettroniche via codice SDI.")
    expect(answer.chips).toEqual([])
    expect(answer.tone).toBe('info')
  })

  it('a new customer with nothing set: the sales settings, no requirement, no tax identity', () => {
    const nothing = termsInForce({ commercial: own({ paymentTermsId: null, paymentTerms: null, defaultDepositPct: null }), companies: { tenantWide: false, companies: [entry(A, null, own())] }, companyId: A.id, typed: null }, 'en')
    const blank = termsAnswer(facts({ blank: true, inForce: nothing, requirements: 0, identity: identityFactsOf(partyWith({ taxIdentities: [], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })) }))
    expect(sentence(blank, 'en')).toBe('Nothing set yet: a new quote takes the sales settings · no special requirements · no tax identity.')
    expect(sentence(blank, 'it')).toBe('Ancora niente di impostato: un nuovo preventivo prende le impostazioni vendite · nessun requisito particolare · nessuna identità fiscale.')
    expect(blank.chips.map((chip) => [chip.id, chip.tone, chip.section])).toEqual([['noIdentity', 'danger', 'party-identity']])
    expect(said1(blank.chips[0]!.label, 'it')).toBe('Nessuna identità fiscale: non si può fatturare')
  })

  it('on hold for missing data with two accepted quotes waiting: each chip opens EXACTLY its rows on this tab (Z6, Z27)', () => {
    const answer = termsAnswer(facts({ holds: holds.inForce, waiting: holds.waiting, identity: identityFactsOf(partyWith({ taxIdentities: [], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })) }))
    expect(answer.chips.map((chip) => [chip.id, chip.tone, chip.section, chip.rows.length, chip.door])).toEqual([
      ['hold', 'danger', 'party-hold', 1, null],
      ['waitHold', 'warning', 'party-hold', 1, null],
      ['waitPo', 'warning', 'party-commercial', 1, null],
      ['noIdentity', 'danger', 'party-identity', 0, null],
    ])
    expect(answer.chips.map((chip) => said1(chip.label, 'en'))).toEqual(['On hold: data missing', '1 accepted quote waits for the hold', '1 accepted quote waits for a PO number', 'No tax identity: it cannot be invoiced'])
    const reasonIt = said1(said('sales-customers-depth:reason.DATA_MISSING'), 'it').toLocaleLowerCase('it-IT')
    expect(answer.chips.map((chip) => said1(chip.label, 'it'))).toEqual([`In blocco: ${reasonIt}`, '1 preventivo accettato attende lo sblocco', "1 preventivo accettato attende il numero d'ordine", 'Nessuna identità fiscale: non si può fatturare'])
    expect(answer.tone).toBe('danger')
  })

  it('before S4 nobody can say why each quote waits: ONE chip, the count, a door to Quotes › Order waits (Z6)', () => {
    const old: HoldsFacts = { ...HOLDS, ordersWaitingCount: undefined, ordersWaiting: HOLDS.ordersWaiting.map(({ waitsFor: _drop, ...rest }) => rest) }
    const waiting = waitingOf(old, OWNER, NAMES, '/w/SEEDA', PARTY_ID)
    expect(waiting.byReason).toBe(false)
    const answer = termsAnswer(facts({ waiting }))
    expect(answer.chips.map((chip) => [chip.id, chip.door])).toEqual([['waitOrder', `/w/SEEDA/sales/customers/${PARTY_ID}?tab=quotes&group=ORDER_WAITS`]])
    expect(said1(answer.chips[0]!.label, 'en')).toBe('2 accepted quotes wait for their order')
  })

  it('no SDI code or PEC is a WARNING (the fiscal drawer), never "cannot be invoiced" (Z3); VIES: no answer is never "not valid" (Z23)', () => {
    const drawer = termsAnswer(facts({ identity: identityFactsOf(partyWith({ taxIdentities: [identity({ sdiRecipientCode: '0000000' })], warnings: [{ code: 'FISCAL_DRAWER', message: 'made-up', blocksInvoice: false }], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })) }))
    expect(drawer.chips.map((chip) => [chip.id, chip.tone])).toEqual([['noSdi', 'warning']])
    expect(sentence(drawer, 'en')).toContain('no SDI code or PEC')
    const eu = (state: Party['vies']['state'], validUntil: string | null) => termsAnswer(facts({ identity: identityFactsOf(partyWith({ taxIdentities: [identity({ country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE000000000', sdiRecipientCode: null })], warnings: [], vies: { ...MODA.vies, state, validUntil } })) }))
    const ends = eu('VALID', '2026-11-27T09:00:00.000Z')
    expect(ends.chips.map((chip) => [chip.id, chip.tone, said1(chip.label, 'en')])).toEqual([['viesEnds', 'warning', 'VIES proof ends in 3 days']])
    expect(sentence(ends, 'en')).toContain('VAT valid until 27/11/2026')
    expect(eu('INVALID', null).chips.map((chip) => [chip.id, chip.tone])).toEqual([['viesInvalid', 'danger']])
    expect(eu('HELD', null).chips.map((chip) => [chip.id, chip.tone])).toEqual([['viesUnchecked', 'warning']])
    expect(sentence(eu('HELD', null), 'en')).not.toContain('not valid')
  })

  it('two or more of our companies: "With {company}: …"; the company read failed: the customer\'s own terms, and it says so', () => {
    const multi = termsAnswer(facts({ multi: true }))
    expect(sentence(multi, 'en').startsWith('With Seed Company A: Net 30 end of month')).toBe(true)
    expect(sentence(multi, 'it').startsWith('Con Seed Company A:')).toBe(true)
    const failed = termsAnswer(facts({ multi: true, companiesFailed: true, inForce: termsInForce({ commercial: own(), companies: null, companyId: A.id, typed: null }, 'en'), holds: holds.inForce, waiting: holds.waiting }))
    expect(failed.fallback && said1(failed.fallback, 'en')).toBe("The terms with each company could not be read: these are the customer's own terms.")
    expect(failed.chips.some((chip) => chip.id === 'waitPo')).toBe(false)
    expect(sentence(failed, 'en')).not.toContain('PO number required')
  })
})

// ---- Hold ----------------------------------------------------------------------------------------------------------------------

describe('Hold (holds.ts, 10-design §5.1; Z10, Z22)', () => {
  it('not on hold: one quiet line, "Put on hold…" in the head, the released ones folded', () => {
    const none = holdSection(holdsInput({ read: ready({ ...HOLDS, onHold: false, holds: [HOLDS.holds[1]!], ordersWaiting: [], ordersWaitingCount: { onHold: 0, poNumber: 0, other: 0 } }) }))
    expect(said1(none.answer!, 'en')).toBe('Not on hold: new orders and shipments go ahead.')
    expect(said1(none.answer!, 'it')).toBe('Non in blocco: nuovi ordini e spedizioni procedono.')
    expect(none.inForce).toEqual([])
    expect(none.released.map((released) => released.reason)).toEqual(['CREDIT'])
    expect(none.place).toEqual({ shown: true, held: null })
    expect(none.placeInHead).toBe(true)
    expect(none.stops).toBeNull()
  })

  it('in force: since when, for whom, why — in both languages; what stops and what goes on; its cause a door only without an identity (P19)', () => {
    const one = holdSection(holdsInput())
    expect(said1(one.answer!, 'en')).toBe(`On hold since 20/11/2026, for every company (${said1(said('sales-customers-depth:reason.DATA_MISSING'), 'en').toLowerCase()}).`)
    expect(said1(one.answer!, 'it').startsWith('In blocco dal 20/11/2026, per tutte le aziende (')).toBe(true)
    expect(said1(one.stops!.title, 'en')).toBe('New orders and shipments of Seed Customer One S.r.l. wait until the hold is released.')
    expect(said1(one.stops!.desc, 'it')).toBe('I preventivi proseguono, ognuno con un avviso. Fatture e pagamenti proseguono come sempre.')
    expect(one.inForce[0]!.cause).toBe(true)
    expect(holdSection(holdsInput({ hasIdentity: true })).inForce[0]!.cause).toBe(false)
    expect(one.placeInHead).toBe(false) // Z22: the ⋯ keeps "Put on hold for another reason…"
    const two = holdSection(holdsInput({ read: ready({ ...HOLDS, holds: [hold(), hold({ id: '0190f0e2-c700-7000-8000-000000000603', reason: 'LEGAL', companyId: B.id, company: { code: B.code, name: B.name } })] }) }))
    expect(said1(two.answer!, 'en')).toMatch(/^2 holds in force: .+ \(every company\) and legal \(Seed Company B\)\.$/)
    expect(said1(two.stops!.title, 'en')).toBe('New orders and shipments of Seed Customer One S.r.l. wait until the hold is released.')
  })

  it('the waiting quotes by reason, with their numbers only with quotes.view (else the counts)', () => {
    const owner = holdSection(holdsInput())
    expect(owner.waiting.hold.map((row) => said1(row.quote))).toEqual(['Q-2026-0118 rev. 2'])
    expect(owner.waiting.po.map((row) => row.ref)).toEqual([null])
    expect(owner.waitingForHold).toBe(1)
    const pm = holdSection(holdsInput({ can: PM }))
    expect(pm.waiting.rowsShown).toBe(false)
    expect(pm.waiting.hold).toEqual([])
    expect(pm.waiting.counts).toEqual({ hold: 1, po: 1, other: 0 })
  })

  it('hidden, never held, for a right; held only by state (an archived customer)', () => {
    for (const can of [PM, RO]) {
      const model = holdSection(holdsInput({ can }))
      expect(model.place.shown).toBe(false)
      expect(model.inForce.every((row) => !row.release.shown && row.release.held === null)).toBe(true)
    }
    const refused = holdSection(holdsInput({ read: ready({ ...HOLDS, mayPlace: false, holds: [hold({ mayRelease: false })] }) }))
    expect(refused.place.shown).toBe(false)
    expect(refused.inForce[0]!.release.shown).toBe(false)
    const archived = holdSection(holdsInput({ can: SALES, archived: true }))
    expect(archived.inForce[0]!.release.shown).toBe(true)
    expect(said1(archived.inForce[0]!.release.held!, 'en')).toBe('Archived: reactivate it to change its terms')
  })

  it('a failed read is never "not on hold": the kit\'s own Try again', () => {
    const failed = holdSection(holdsInput({ read: failedRead('problem.offline') }))
    expect(failed.problem).toBe('problem.read.unavailable')
    expect(failed.answer).toBeNull()
    expect(holdSection(holdsInput({ read: LOADING })).reading).toBe(true)
  })
})

// ---- Commercial terms ------------------------------------------------------------------------------------------------------------

describe('Commercial terms (commercial.ts, 10-design §5.2; Z2, Z11, Z21, Z29, Z31)', () => {
  const CARRIER: CarrierFacts = { carrierCode: 'brt', carrierName: 'BRT', accountOnFile: true, freightBilling: 'COLLECT', defaultCarrierService: 'Express 24h', version: 7 }
  const party = own()
  const two: CompanyTermsRead = { tenantWide: true, companies: [entry(A, row({ paymentTermsId: DEP30.id, paymentTermsLabel: { code: DEP30.code, name: DEP30.name }, poNumberRequired: true, creditLimitCurrency: 'EUR' }), party), entry(B, null, party)] }
  const input = (over: Partial<CommercialInput> = {}): CommercialInput => ({ commercial: ready(party), companies: ready(two), carrier: ready(CARRIER), companyId: A.id, typed: null, can: OWNER, archived: false, prefix: '/w/SEEDA', partyId: PARTY_ID, poWaiting: [], poWaitingCount: 0, endedOpen: false, locale: 'en', ...over })
  const fact = (model: ReturnType<typeof commercialSection>, group: 'pays' | 'order' | 'delivery', key: string) => model[group].find((item) => item.key === key)

  it('the facts are the terms IN FORCE with the company you work in, each with its source (two or more companies)', () => {
    const model = commercialSection(input())
    expect(said1(fact(model, 'pays', 'paymentTerms')!.value)).toBe(DEP30.name)
    expect(fact(model, 'pays', 'paymentTerms')!.source).toEqual({ from: 'COMPANY', company: 'Seed Company A' })
    expect(said1(fact(model, 'pays', 'deposit')!.label)).toBe('Default deposit') // Money's word (Z29)
    expect(said1(fact(model, 'pays', 'deposit')!.value)).toBe('30 %')
    expect(model.answer.map((words) => said1(words))).toEqual(['New quotes and orders take these; open ones keep their own.', 'Shown for Seed Company A, the company you work in; each company is below.'])
    expect(model.companies!.map((company) => [company.name, company.current, company.own, company.po])).toEqual([['Seed Company A', true, true, true], ['Seed Company B', false, false, false]])
    expect(said1(model.foot)).toContain("the customer's own payment terms")
  })

  it('the money wall: the minimum order only with the price grain (said once without it); the credit limit a door, never an amount', () => {
    const owner = commercialSection(input())
    expect(fact(owner, 'pays', 'minimum')).toBeDefined()
    expect(fact(owner, 'pays', 'credit')!.href).toBe(`/w/SEEDA/sales/customers/${PARTY_ID}?tab=money#credit`)
    for (const can of [SALES, PM, RO]) {
      const model = commercialSection(input({ can }))
      expect(fact(model, 'pays', 'minimum'), 'no minimum').toBeUndefined()
      expect(model.noPrice).toBe(true)
      for (const item of model.pays) expect(JSON.stringify(item)).not.toMatch(/amounts|150000|1[.,]500/)
    }
    expect(fact(commercialSection(input({ can: PM })), 'pays', 'credit')).toBeUndefined() // PM does not open Money
  })

  it('Delivery: the carrier and its service, who pays, "On file · The number is never shown" (Z2)', () => {
    const model = commercialSection(input())
    expect(model.delivery.map((item) => said1(item.value))).toEqual(['None: Intrastat asks for them', 'BRT · Express 24h', 'The customer pays, on its own account (porto assegnato)', 'On file'])
    expect(fact(model, 'delivery', 'account')!.subs!.map((words) => said1(words))).toEqual(['The number is never shown'])
    expect(JSON.stringify(model.delivery)).not.toContain('endsIn')
  })

  it('a company row says "changed <date>", never "set by" (Z11); Back… is held while a credit limit is set; hidden without the company\'s right', () => {
    const model = commercialSection(input())
    expect(model.companies![0]!.changed).toBe('2026-11-04T10:00:00.000Z')
    expect(JSON.stringify(model)).not.toMatch(/setBy|Set by/)
    expect(model.companies![0]!.back.shown).toBe(true)
    expect(said1(model.companies![0]!.back.held!)).toBe('A credit limit is set with Seed Company A (Money): its own terms stay while the limit is set.')
    expect(model.companies![1]!.back.shown).toBe(false) // no own row: nothing to go back from
    const other = commercialSection(input({ companies: ready({ ...two, companies: two.companies.map((item) => ({ ...item, mayChange: item.company.id === B.id })) }) }))
    expect(other.companies!.map((company) => company.set.shown)).toEqual([false, true])
    expect(other.menu.setFor.map((item) => item.name)).toEqual(['Seed Company B'])
  })

  it('a customer of ONE company: its PO rule with "Change…" (the company window with the PO switch only, Z26)', () => {
    const single = commercialSection(input({ companies: ready({ tenantWide: false, companies: [entry(A, row({ poNumberRequired: true }), party)] }) }))
    expect(single.companies).toBeNull()
    expect(said1(fact(single, 'order', 'po')!.value)).toBe('Required on its orders')
    expect(single.poChange).toEqual({ shown: true, held: null })
    expect(single.menu.po).toEqual({ companyId: A.id, act: { shown: true, held: null } })
    expect(commercialSection(input({ can: RO, companies: ready({ tenantWide: false, companies: [entry(A, null, party)] }) })).poChange.shown).toBe(false)
  })

  it('nothing set: ONE line, no body; a read that failed is never "none"', () => {
    const blank = own({ paymentTermsId: null, paymentTerms: null, priceListId: null, priceList: null, defaultDepositPct: null, minimumOrderAmount: null })
    const model = commercialSection(input({ commercial: ready(blank), carrier: ready({ ...CARRIER, carrierCode: null, carrierName: null, accountOnFile: false, freightBilling: 'SENDER', defaultCarrierService: null }), companies: ready({ tenantWide: false, companies: [entry(A, null, blank)] }) }))
    expect(model.blank).toBe(true)
    expect(said1(model.answer[0]!, 'it').startsWith('Ancora niente di impostato')).toBe(true)
    const failed = commercialSection(input({ companies: failedRead('problem.offline') }))
    expect(failed.companiesProblem).toBe('problem.read.unavailable')
    expect(said1(fact(failed, 'order', 'po')!.value)).toBe("Couldn't be read")
    expect(commercialSection(input({ commercial: failedRead('problem.read.internal') })).problem).toBe('problem.read.internal')
  })

  it('every act hidden without its right (the server\'s mayChange first), held only by state', () => {
    for (const can of [PM, RO]) {
      const model = commercialSection(input({ can }))
      expect([model.head.change.shown, model.head.delivery.shown, model.menu.setFor.length, model.menu.po]).toEqual([false, false, 0, null])
    }
    expect(commercialSection(input({ commercial: ready({ ...party, mayChange: false }) })).head.change.shown).toBe(false)
    const archived = commercialSection(input({ archived: true }))
    expect(said1(archived.head.change.held!)).toBe('Archived: reactivate it to change its terms')
  })
})

// ---- words and walls -----------------------------------------------------------------------------------------------------------

describe('the words and the walls', () => {
  const folder = new URL('./', import.meta.url)
  const rules = readdirSync(folder).filter((name) => /\.ts$/.test(name) && !name.includes('.test.')).map((name) => ({ name, source: readFileSync(new URL(name, folder), 'utf8') }))
  const viewFolder = new URL('../view/terms/', import.meta.url)
  const views = readdirSync(viewFolder).filter((name) => /\.tsx?$/.test(name)).map((name) => ({ name, source: readFileSync(new URL(name, viewFolder), 'utf8') }))

  it("every said('…') key of the tab's rules is in its catalogue, in Italian and in English; the ct block has the same keys in both", () => {
    const keys = new Set([...rules, ...views].flatMap(({ source }) => [...source.matchAll(/said\(\s*'([^'$]+)'/g)].map((match) => match[1]!)))
    expect(keys.size).toBeGreaterThan(200)
    for (const locale of LOCALES)
      for (const key of keys) {
        const [namespace, path] = key.includes(':') ? (key.split(':') as [string, string]) : [CT, key]
        const words = CATALOGUE[locale][namespace] ?? {}
        expect(words[path] !== undefined || words[`${path}_other`] !== undefined, `${locale} ${key}`).toBe(true)
      }
    const ct = (locale: Locale) => Object.keys(CATALOGUE[locale][CT] ?? {}).filter((key) => key.startsWith('ct.')).sort()
    expect(ct('it')).toEqual(ct('en'))
  })

  it('"Customer" on screen, never "party"; Italian "Termini di pagamento" (Z30)', () => {
    for (const [key, words] of Object.entries(CATALOGUE.en[CT] ?? {})) if (key.startsWith('ct.')) expect(words, key).not.toMatch(/\bpart(y|ies)\b/i)
    expect(CATALOGUE.it[CT]?.['termsField.paymentTerms']).toBe('Termini di pagamento')
  })

  it("W4: the payment-terms library's count of OTHER customers is never read by the tab", () => {
    for (const { name, source } of [...rules, ...views]) expect(source, name).not.toMatch(/\.customers\b/)
  })

  it('the four sections keep their addresses (doors from Money, the Overview, the list and the tests land)', () => {
    expect([...TERMS_SECTIONS]).toEqual(['party-hold', 'party-commercial', 'party-requirements', 'party-identity'])
  })
})

// ---- W1.2: the reads, the windows' commands ------------------------------------------------------------------------------------

describe('the calls (W1.2): methods, paths, bodies, one Idempotency-Key per attempt', () => {
  function recorder(answers: Record<string, unknown>) {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      const path = new URL(url, 'http://x').pathname
      const answer = Object.entries(answers).find(([suffix]) => path.endsWith(suffix))?.[1] ?? {}
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }
  const ACCOUNT: CarrierAccount = { partyId: 'p', code: 'SEED-ONE', name: 'Seed Customer One S.r.l.', carrierCode: 'brt', carrierName: 'BRT', accountOnFile: true, freightBilling: 'COLLECT', defaultCarrierService: null, version: 7 }

  it('R19 reads the carrier block; R20 sends ONE command at the party version; R5 the full company body; R6 the end at the row version', async () => {
    const { api, calls } = recorder({ '/customer-carrier-accounts/p': { account: { ...ACCOUNT, freightBillingWords: 'never drawn' }, endsIn: '1234' }, '/company-terms/c1': { terms: COMPANY_TERMS }, '/company-terms/c1/end': { terms: COMPANY_TERMS } })
    const account = await readCarrierAccount(api, 'p')
    expect(account).toEqual(ACCOUNT) // the server's English is dropped by the page's own schema
    await setCarrierAccount(api, 'p', { version: 7, carrierCode: 'gls', accountNumber: null, freightBilling: 'SENDER' }, 'k1')
    await setCompanyTerms(api, 'p', 'c1', { version: 2, paymentTermsId: 't1', depositPct: '40', poNumberRequired: true }, 'k2')
    await setCompanyTerms(api, 'p', 'c1', { poNumberRequired: true }, 'k3')
    await endCompanyTerms(api, 'p', 'c1', { version: 2 }, 'k4')
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://x').pathname, call.key])).toEqual([
      ['GET', '/api/shipping/customer-carrier-accounts/p', null],
      ['PUT', '/api/shipping/customer-carrier-accounts/p', 'k1'],
      ['PUT', '/api/parties/p/company-terms/c1', 'k2'],
      ['PUT', '/api/parties/p/company-terms/c1', 'k3'],
      ['POST', '/api/parties/p/company-terms/c1/end', 'k4'],
    ])
    expect(calls.map((call) => call.body)).toEqual([undefined, { version: 7, carrierCode: 'gls', accountNumber: null, freightBilling: 'SENDER' }, { version: 2, paymentTermsId: 't1', depositPct: '40', poNumberRequired: true }, { poNumberRequired: true }, { version: 2 }])
  })

  it('Change delivery… sends only what changed; another carrier drops the account on file; who pays needs an account (Z24)', () => {
    const start = deliveryWindowOf(ACCOUNT)
    expect(deliveryBody(start, ACCOUNT)).toBeNull()
    expect(deliveryBody({ ...start, carrier: 'gls', service: '' }, ACCOUNT)).toEqual({ version: 7, carrierCode: 'gls', accountNumber: null })
    expect(deliveryProblems({ ...start, carrier: 'gls', service: '' }, ACCOUNT)).toEqual({ freight: 'ct.deliv.problem.needsAccount' })
    expect(deliveryBody({ ...start, account: 'replace', number: 'FAKE-0000-9876' }, ACCOUNT)).toEqual({ version: 7, accountNumber: 'FAKE-0000-9876' })
    expect(deliveryBody({ ...start, account: 'remove', freight: 'SENDER' }, ACCOUNT)).toEqual({ version: 7, accountNumber: null, freightBilling: 'SENDER' })
    expect(deliveryProblems({ ...start, account: 'replace', number: 'no' }, ACCOUNT)).toEqual({ number: 'ct.deliv.problem.number' })
    expect(deliveryRefusal(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/accountNumber' }]))).toEqual({ key: 'ct.deliv.problem.number', field: 'number' })
  })

  it('Set terms for {company}… sends that company\'s row only, what changed, at its version; a customer of ONE company: the PO switch only (Z26)', () => {
    const party = own()
    const live = entry(A, row({ paymentTermsId: DEP30.id, paymentTermsLabel: { code: DEP30.code, name: DEP30.name }, depositPct: '40' }), party)
    const window = companyWindowOf(live, false)
    expect([window.payment, window.deposit, window.list, window.po]).toEqual(['own', 'own', 'party', false])
    const manage = termsAbilitiesOf(['pricelists.manage'])
    expect(companyBody(window, live, manage)).toBeNull()
    expect(companyBody({ ...window, deposit: 'party', po: true }, live, manage)).toEqual({ version: 2, depositPct: null, poNumberRequired: true })
    expect(companyBody({ ...window, depositPct: '40.0' }, live, manage)).toBeNull() // the same percent, typed another way
    expect(companyProblems({ ...window, payment: 'own', paymentTermsId: '' }, manage)).toEqual({ paymentTermsId: 'ct.co.problem.terms' })
    const fresh = entry(B, null, party)
    expect(companyBody({ ...companyWindowOf(fresh, false), deposit: 'own', depositPct: '25' }, fresh, termsAbilitiesOf([]))).toEqual({ depositPct: '25' }) // no row yet: made, no version
    const single = companyWindowOf(entry(A, null, party), true)
    expect(companyBody({ ...single, payment: 'own', paymentTermsId: 'x', po: true }, entry(A, null, party), manage)).toEqual({ poNumberRequired: true })
  })

  it('Change terms… is today\'s form moved: its rules, never the carrier (Change delivery… keeps it)', () => {
    const party = own({ preferredCarrierCode: 'BRT' })
    const window = termsWindowOf(party)
    expect(termsWindowPatch({ ...window, draft: { ...window.draft, preferredCarrierCode: '' } }, party, { price: true, listsManage: true })).toEqual({})
    expect(termsWindowPatch({ ...window, draft: { ...window.draft, invoiceTiming: 'MONTHLY', language: 'en' } }, party, { price: true, listsManage: true })).toEqual({ invoiceTiming: 'MONTHLY', language: 'en' })
  })

  it('Back to the customer\'s terms… says only what is true: terms, deposit, the PO rule going, open documents keep theirs', () => {
    const party = own()
    const live = entry(A, row({ paymentTermsId: DEP30.id, paymentTermsLabel: { code: DEP30.code, name: DEP30.name }, depositPct: '40', poNumberRequired: true }), party)
    const lines = endLines(live, party, 'en').map((line) => [line.tone, said1(line.words)])
    expect(lines).toEqual([
      ['info', `Payment terms: ${DEP30.name} → the customer's Net 30 end of month`],
      ['info', 'Deposit: 40 % → 30 %'],
      ['warning', "The PO number rule goes too: orders with Seed Company A will no longer need the customer's PO number."],
      ['info', 'Open quotes and orders keep their own.'],
    ])
  })
})

describe('the tab model (tab.ts): the container and the gallery build it alike', () => {
  const reads = (over: Partial<TermsTabReads> = {}): TermsTabReads => ({
    party: partyWith({ id: PARTY_ID, taxIdentities: [], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } }),
    prefix: '/w/SEEDA',
    can: OWNER,
    locale: 'en',
    now: NOW,
    companyId: A.id,
    companyNames: NAMES,
    commercial: ready(own()),
    carrier: ready({ partyId: PARTY_ID, code: 'SEED-ONE', name: 'Seed Customer One S.r.l.', carrierCode: null, carrierName: null, accountOnFile: false, freightBilling: 'SENDER', defaultCarrierService: null, version: 7 }),
    holds: ready(HOLDS),
    companies: ready(COMPANY_TERMS),
    requirements: null,
    library: null,
    lists: null,
    history: { items: [] },
    viesRunning: false,
    ...over,
  })

  it('a chip marks exactly its rows; a door chip marks none', () => {
    const model = termsTabModel(reads(), { ...TERMS_TAB_START, chip: 'hold' })
    expect(model.chip).toBe('hold')
    expect(model.marked).toEqual([model.hold.inForce[0]!.anchor])
    expect(termsTabModel(reads(), TERMS_TAB_START).marked).toEqual([])
  })

  it('the requirements are counted only once read; the answer reads while R1 does', () => {
    expect(termsTabModel(reads({ commercial: LOADING }), TERMS_TAB_START).answerReading).toBe(true)
    expect(sentence(termsTabModel(reads(), TERMS_TAB_START).answer, 'en')).not.toMatch(/requirement/)
  })
})

// ---- W1.3: the views ------------------------------------------------------------------------------------------------------------

describe('the views of the tab (W1.3)', () => {
  const folder = new URL('../view/terms/', import.meta.url)
  const views = readdirSync(folder).filter((name) => /\.tsx?$/.test(name)).map((name) => ({ name, source: readFileSync(new URL(name, folder), 'utf8') }))
  const source = (name: string) => views.find((view) => view.name === name)!.source

  it('terms.css restyles no kit, party, Money, depth or old-terms class — only its own fw-ctr-* classes, tokens only, by the ROOM', () => {
    const css = readFileSync(new URL('terms.css', folder), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/\.fw-(pt|pty|om|cdp|ct|co|cm|ca|pa)[-\s{.,:>]/)
    expect(css).not.toMatch(/\.nds-[a-z]/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/@media/)
    const selectors = (css.match(/[^{}]+(?=\{)/g) ?? []).map((selector) => selector.trim()).filter((selector) => selector !== '' && !selector.startsWith('@'))
    expect(selectors.length).toBeGreaterThan(30)
    for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim(), part).toMatch(/^\.fw-ctr/)
  })

  it('a view fetches nothing (no API client, no session, no fetching hook, never its container) and draws no AG grid', () => {
    // ct-fx (People end check): the floor was miscounted (ct-w1 shipped 9 views, not 10) — the guard is the TRUE list of the tab's views.
    expect(views.map((view) => view.name).sort()).toEqual(['ChangeTermsDialog.tsx', 'CommercialSection.tsx', 'CompanyTermsDialog.tsx', 'DeliveryDialog.tsx', 'HoldSection.tsx', 'IdentitySection.tsx', 'RequirementsSection.tsx', 'TermsAnswer.tsx', 'TermsNotices.tsx', 'TermsTab.tsx', 'say.ts'])
    for (const { name, source: text } of views) {
      expect(text, name).not.toMatch(/lib\/api\/|lib\/session\/|use-terms-tab|use-depth|fetch\(|useRouter/)
      expect(text, name).not.toMatch(/@nexus\/ui\/grid|ListFrame|ag-grid/)
    }
  })

  it('the hold window is the depth provider\'s own HoldDialogView, imported and mounted as it is — never copied', () => {
    expect(source('TermsTab.tsx')).toContain("import { HoldDialogView, type HoldCardActions, type HoldCardModel } from '../../../depth/view/HoldCard'")
    expect(source('TermsTab.tsx')).toContain('<HoldDialogView model={hold.model} actions={hold.actions} />')
    for (const { name, source: text } of views) {
      expect(text, name).not.toMatch(/function HoldDialogView|hold\.dialog\./)
      expect(text, name).not.toMatch(/Kit\.tsx'|production\.css'/) // the kit is imported by its module, never its files edited or copied
    }
  })

  it('the tab is the kit used in place: its root, its words, its sections by their addresses, at most three head buttons', () => {
    expect(source('TermsTab.tsx')).toContain('<div className="fw-pt fw-ctr">')
    expect(source('TermsTab.tsx')).toContain('<WithMessages namespaces={TERMS_TAB_NAMESPACES}>')
    expect([...TERMS_TAB_NAMESPACES]).toEqual(['orders', CT, 'sales-customers-depth', 'parties', 'customer-money'])
    expect(source('HoldSection.tsx')).toContain("id: termsKitId('party-hold')")
    expect(source('CommercialSection.tsx')).toContain("id: termsKitId('party-commercial')")
    // Money's own parts, in place (Facts for every label → value fact, Fold for a fold): a fact Money also shows LOOKS the same.
    expect(source('CommercialSection.tsx')).toContain("import { Facts, Fold } from '../../../../orders/record/money/view/parts'")
    expect(source('HoldSection.tsx').match(/<Button key=/g)?.length ?? 0).toBeLessThanOrEqual(3)
    expect(source('CommercialSection.tsx').match(/<Button key=/g)?.length ?? 0).toBeLessThanOrEqual(3)
  })

  it('the four NEW windows are centred DS Modals (never a drawer), each with its inside exported for a design case', () => {
    for (const name of ['ChangeTermsDialog.tsx', 'DeliveryDialog.tsx', 'CompanyTermsDialog.tsx']) {
      expect(source(name), name).toContain("import { Modal } from '../../../../../../lib/i18n/ds-parts'")
      expect(source(name), name).not.toMatch(/Drawer|Sheet\b/)
    }
    expect(source('ChangeTermsDialog.tsx')).toContain('export function ChangeTermsBody')
    expect(source('DeliveryDialog.tsx')).toContain('export function DeliveryBody')
    expect(source('CompanyTermsDialog.tsx')).toMatch(/export function CompanyTermsBody[\s\S]*export function CompanyEndBody/)
    // Z8: ONE editor — the record window's currency Select and LanguageSelect, mounted as they are
    expect(source('ChangeTermsDialog.tsx')).toContain("import { LanguageSelect } from '../../../../../parties/_shared/view/dialogs'")
    expect(source('ChangeTermsDialog.tsx')).toContain('CURRENCY_CHOICES')
    expect(source('ChangeTermsDialog.tsx')).not.toMatch(/preferredCarrierCode/) // the carrier is Change delivery…'s
  })

  // ---- the tab and the windows' insides drawn on the server, in both languages, with no key left
  const LEFT = /\b(?:ct|terms|termsField|hold|reason|po|cm|tab|common|win|com|co|deliv|end)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*/
  const draw = (node: ReactElement, locale: Locale) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(WithMessages, { namespaces: [...TERMS_TAB_NAMESPACES] }, node)))
  const left = (html: string) => html.replace(/href="[^"]*"/g, '').replace(/id="[^"]*"/g, '').match(LEFT)?.[0] ?? null
  const party = partyWith({ id: PARTY_ID, taxIdentities: [], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })
  const carrier: CarrierAccount = { partyId: PARTY_ID, code: 'SEED-ONE', name: 'Seed Customer One S.r.l.', carrierCode: 'brt', carrierName: 'BRT', accountOnFile: true, freightBilling: 'COLLECT', defaultCarrierService: 'Express 24h', version: 7 }
  const two = { ...COMPANY_TERMS, companies: COMPANY_TERMS.companies.map((item, at) => (at === 0 ? { ...item, terms: { ...item.terms!, creditLimitCurrency: 'EUR' }, history: [{ ...item.terms!, id: '0190f0e2-c700-7000-8000-000000000499', endedAt: '2026-10-01T09:00:00.000Z', endedBy: 'Alex Demo' }] } : item)) }
  const reads = (locale: Locale): TermsTabReads => ({ party, prefix: '/w/SEEDA', can: OWNER, locale, now: NOW, companyId: two.companies[0]!.company.id, companyNames: {}, commercial: ready(own({ incoterm: 'DAP' })), carrier: ready(carrier), holds: ready(HOLDS), companies: ready(two), requirements: ready({ inForce: [], ended: [] }), library: ready([]), lists: ready([]), history: { items: [] }, viesRunning: false })

  it('the whole tab draws in English and in Italian with no key left (on hold, two companies, every fold open)', () => {
    for (const locale of LOCALES) {
      const model = termsTabModel(reads(locale), { ...TERMS_TAB_START, chip: 'hold', releasedOpen: true, endedOpen: true })
      const html = draw(createElement(TermsTab, { model }), locale)
      expect(left(html), locale).toBeNull()
      expect(html).toContain('id="party-hold"')
      expect(html).toContain('id="party-commercial"')
      expect(html.indexOf('id="party-hold"')).toBeLessThan(html.indexOf('id="party-commercial"')) // Z10: Hold first
      expect(html).toContain('fw-ctr-row is-h is-mark') // the pressed chip marks its row
    }
  })

  it('a reader without rights: the facts only — no act button, no minimum, the credit a door — in both languages', () => {
    for (const locale of LOCALES) {
      const html = draw(createElement(TermsTab, { model: termsTabModel({ ...reads(locale), can: PM }, TERMS_TAB_START) }), locale)
      expect(left(html), locale).toBeNull()
      const say = sayOf(createScopedTranslator(locale, messagesFor(locale, [...TERMS_TAB_NAMESPACES]), CT), locale)
      for (const act of ['ct.com.changeTerms', 'ct.com.changeDelivery', 'sales-customers-depth:hold.release', 'sales-customers-depth:hold.place']) expect(html, act).not.toContain(say(said(act)))
      expect(html).not.toContain(say(said('termsField.minimum')))
    }
  })

  it('the four NEW windows\' insides draw in both languages with no key left', () => {
    for (const locale of LOCALES) {
      const model = termsTabModel(reads(locale), TERMS_TAB_START)
      const entry = two.companies[0]!
      const windows = (window: TermsTabState['window']) => termsTabModel(reads(locale), { ...TERMS_TAB_START, window }).windows
      const bodies = [
        createElement(ChangeTermsBody, { window: termsWindowOf(own({ incoterm: 'DAP' })), windows: windows(termsWindowOf(own())) }),
        createElement(DeliveryBody, { window: deliveryWindowOf(carrier), windows: windows(deliveryWindowOf(carrier)) }),
        createElement(CompanyTermsBody, { window: companyWindowOf(entry, false), windows: windows(companyWindowOf(entry, false)) }),
        createElement(CompanyTermsBody, { window: companyWindowOf(entry, true), windows: windows(companyWindowOf(entry, true)) }),
        createElement(CompanyEndBody, { window: companyEndWindowOf(entry.company.id), windows: windows(companyEndWindowOf(entry.company.id)) }),
        createElement(TermsNotices, { notices: { own: { tone: 'success', words: said('ct.co.saved', { params: { company: 'Seed Company A' } }) }, depth: null } }),
      ]
      expect(model.windows.window).toBeNull()
      for (const body of bodies) expect(left(draw(body, locale)), locale).toBeNull()
    }
  })
})

// ---- W1.4: the page --------------------------------------------------------------------------------------------------------------

describe('the page mounts the tab (W1.4)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the record builds the container on every tab (it reads only on Terms) and the view only on ?tab=terms; the old card left the slot', () => {
    const cr = source('../CustomerRecord.tsx')
    expect(cr).toContain("const terms = useTermsTab({ partyId, party: record.party, model: record.model, reload: record.reload, actions: record.actions /* F-CT-516 */, moreHistory: record.moreHistory, depth: termsDepth, enabled: tab === 'terms' })")
    expect(cr).toContain("const termsTab = named && record.party && tab === 'terms' ? <TermsTab model={terms.model} actions={terms.actions} hold={terms.hold} requirements={terms.requirementsWindow /* F-CT-508 */} /> : null")
    expect(cr).toContain('const termsNotice = <TermsNotices notices={terms.notices} />')
    expect(cr).not.toMatch(/CommercialTerms\b|terms: \(party, reload\)/)
    // People's notice line is untouched (Z5: the depth's notice is split instead).
    expect(cr).toContain('const peopleNotice = <PeopleNotices notices={{ ...people.notices, depth: privacy.notice, onDismissDepth: privacy.onDismissNotice }')
  })

  it('the view: the tab in one line (it draws all four sections); its notices in the ONE notice area; a third of the dock (D3)', () => {
    const view = source('../view/CustomerRecordView.tsx')
    // F-CT-508 / F-CT-518 (ct-w2 W2.1, W2.2): the tab draws Requirements and Tax identity itself — no old section in the record view.
    expect(view).toContain("{tab === 'terms' && termsTab}")
    expect(view).not.toMatch(/id="party-(requirements|identity)"/)
    expect(view).toContain("{tab === 'people' ? peopleNotice : tab === 'terms' ? termsNotice : null}")
    expect(view).toContain("|| tab === 'people' || tab === 'terms' ? 'third' : undefined}")
    expect(view).not.toMatch(/customers\.anchor\.(label|commercial|hold)|href="#party-commercial"|depth\?\.tax/) // the anchor line and the old Tax part went
  })

  it('the depth provider hands the tab its part — its ONE reads, its hold window, its notice — and keeps Money\'s hold connector word for word', () => {
    const depth = source('../../depth/CustomerDepth.tsx')
    expect(depth).toContain('export function useCustomerTerms(party: Party | null | undefined): TermsDepth | null {')
    expect(depth).toContain('export function useCustomerHold(party: Party)')
    expect(depth).toContain('window: <HoldDialogView model={{ read: state.holds.read, can: state.can, status: party.status, prefix, dialog: state.holds.dialog, companies: state.companies }} actions={state.holds} />,')
    expect(depth).not.toMatch(/function TaxPart|<HoldCard |PoNumberCard|tax: </)
    expect(source('../../depth/view/HoldCard.tsx')).toContain('export function HoldDialogView(')
  })

  it('Z5: the hold, PO and requirement acts made on Terms say their result in the tab\'s notice; People\'s notice is the personal data\'s only', () => {
    const useDepth = source('../../depth/use-depth.ts')
    expect(useDepth).toContain('const [termsNotice, setTermsNotice] = useState<Notice>(null)')
    expect(useDepth).toContain("if (tab === 'terms') setTermsNotice(next)")
    expect(useDepth.match(/actNotice\(\{/g)?.length).toBe(2) // the hold window's, the requirement windows'
    expect(useDepth.match(/\bsetNotice\(\{/g)?.length).toBe(2) // the lawful basis, the objection (People's)
    // the glance after an act is read only off Terms (Money and the Overview draw it; Terms draws the holds read itself)
    expect(useDepth.match(/if \(tab !== 'terms'\) void loadGlance\(\)/g)?.length).toBe(2)
  })

  it('the hold switch and the PO loop went: ONE PUT per act and company (T1-B16), its answer kept in the provider\'s ONE read', () => {
    const useDepth = source('../../depth/use-depth.ts')
    expect(useDepth).not.toMatch(/toggleHold|savePo|poDraft|setPoNumberRequired|for \(const row of changes\)/)
    expect(useDepth).toContain('onAnswer: (answer: CompanyTerms) => setTerms(ready(answer)),')
    const container = source('./use-terms-tab.ts')
    expect(container).toContain('depth.onCompanyTerms(await setCompanyTerms(api, partyId, window.companyId, body, newIdempotencyKey()))')
  })

  it('P0-B1 (Z15, Z33): every .fw-cdp-stack has its column again — CSS only', () => {
    const css = source('../../depth/depth.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.fw-cdp-stack \{\s*display: flex;\s*flex-direction: column;/)
    // F-CT-534 (ct-w2 W2.4): the old cards' rules went with them (no reader left).
    expect(css).not.toMatch(/fw-cdp-(two-wide|now|loading|card|head|title|toggle-row|bar|clip|code|tags)\b/)
  })

  it('every Terms case of the gallery draws the new tab (its id kept): the answer line, Hold first, Commercial terms', () => {
    const screen = customerRecordScreen as unknown as { cases: Array<{ id: string; label: string; model: { tab?: string } }>; view: ComponentType<{ model: unknown }> }
    const terms = screen.cases.filter((item) => item.model.tab === 'terms')
    expect(terms.length).toBeGreaterThan(25)
    for (const id of ['terms', 'terms-blank', 'terms-edit', 'terms-saved', 'w2b-324-tax', 'w2b-324-tax-none', 'w2b-324-req']) expect(terms.map((item) => item.id), id).toContain(id)
    for (const item of terms.filter((entry) => /^(terms|w2b-324-tax)/.test(entry.id))) {
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(screen.view, { model: item.model })))
      expect(html, item.id).toContain('class="fw-pt fw-ctr"')
      expect(html.indexOf('id="party-hold"'), item.id).toBeGreaterThan(-1)
      expect(html.indexOf('id="party-hold"'), item.id).toBeLessThan(html.indexOf('id="party-identity"'))
    }
  })
})

// ---- W2.1: Requirements -----------------------------------------------------------------------------------------------------------

describe('Requirements (W2.1, 10-design §5.3; Z12, Z31, Z36)', () => {
  const rule = (n: number, over: Partial<Requirement> = {}): Requirement => ({
    id: `0190f0e2-c700-7000-8000-00000000080${n}`,
    companyId: A.id,
    companyCode: A.code,
    kind: 'PACKING',
    words: `Rule ${n} (made-up).`,
    appliesAt: ['ORDER'],
    styles: [],
    everyStyle: true,
    file: null,
    supersedesId: null,
    active: true,
    createdAt: '2026-11-04T09:00:00.000Z',
    createdBy: 'Alex Demo',
    endedAt: null,
    endedBy: null,
    endReason: null,
    version: 1,
    mayChange: true,
    ...over,
  })
  const v1 = rule(1, { active: false, endedAt: '2026-11-12T09:00:00.000Z', endedBy: 'Alex Demo', endReason: 'New brand book (made-up).' })
  const v2 = rule(2, { supersedesId: v1.id, createdAt: '2026-11-12T09:00:00.000Z', appliesAt: ['ORDER', 'SHIPMENT'], file: { id: '0190f0e2-c700-7000-8000-000000000901', fileName: 'Routing guide demo.pdf' } })
  const ended = rule(3, { kind: 'LABEL', active: false, endedAt: '2026-11-10T09:00:00.000Z', endedBy: 'Alex Demo', endReason: 'No longer asked (made-up).' })
  const READ: Requirements = { inForce: [v2], ended: [v1, ended], mayAdd: true }
  const input = (over: Partial<RequirementsInput> = {}): RequirementsInput => ({ read: ready(READ), can: OWNER, archived: false, companyNames: NAMES, kind: null, more: false, endedOpen: false, ...over })

  it('the version chain: v2 replaces v1 (of its day); replaced and ended are told apart, with no dangling " · "', () => {
    expect(versionsOf(READ).get(v2.id)).toBe(2)
    const model = requirementsSection(input())
    expect(said1(said('ct.req.version', { params: { version: model.rows[0]!.version, before: model.rows[0]!.replaces!.version }, days: { date: model.rows[0]!.replaces!.on } }))).toBe('v2 · replaces v1 of 04/11/2026')
    expect(model.ended.map((row) => [row.replaced, row.nextVersion])).toEqual([[true, 2], [false, null]])
    expect(said1(endedLine(model.ended[0]!))).toBe('v1 · replaced by v2 on 12/11/2026 by Alex Demo: “New brand book (made-up).”')
    expect(said1(endedLine(model.ended[1]!), 'it')).toBe('Terminato il 10/11/2026 da Alex Demo: “No longer asked (made-up).”')
    expect(said1(endedLine({ ...model.ended[1]!, reason: null }))).toBe('Ended on 10/11/2026 by Alex Demo')
  })

  it('where it really shows (Z12): a shipping rule is printed on the delivery note; every other stage is kept, not on that screen yet', () => {
    const row = requirementsSection(input()).rows[0]!
    expect([row.ddt, row.kept]).toEqual([true, ['ORDER']])
    expect(said1(keptWords(row.kept)!)).toBe(`Kept for ${said1(said('sales-customers-depth:stage.ORDER'))} — not on that screen yet`)
    expect(said1(said('ct.req.ddtUnless'))).toBe('Unless the office types its own remarks')
    expect(said1(requirementsSection(input()).answer!)).toBe(`1 requirement in force: ${said1(said('sales-customers-depth:kind.PACKING')).toLowerCase()} · 1 printed on the delivery note (DDT).`)
  })

  it('Z36: a style saved before the wall that is not ours or this customer\'s is never named — "a style no longer offered"', () => {
    const gone = requirementsSection(input({ read: ready({ ...READ, inForce: [{ ...v2, everyStyle: false, styles: [{ id: 's1', code: 'SEED-01', name: 'Seed jacket' }, { id: 's2', code: '', name: '' }] }] }) }))
    expect(gone.rows[0]!.styles).toEqual([{ id: 's1', code: 'SEED-01', name: 'Seed jacket' }, { id: 's2', code: null, name: '' }])
    expect(said1(said('ct.req.styleGone'), 'it')).toBe('un modello non più offerto')
  })

  it('kind chips from six rules in force (Z31); ten rows, then "Show n more"; a chip shows only its kind', () => {
    const many: Requirement[] = Array.from({ length: 12 }, (_, at) => rule(at, { id: `r-${at}`, kind: at < 3 ? 'LABEL' : 'PACKING' }))
    const model = requirementsSection(input({ read: ready({ inForce: many, ended: [] }) }))
    expect(model.kinds).toEqual([{ kind: 'LABEL', count: 3 }, { kind: 'PACKING', count: 9 }])
    expect([model.rows.length, model.hidden]).toEqual([10, 2])
    expect(requirementsSection(input({ read: ready({ inForce: many, ended: [] }), kind: 'LABEL' })).rows.map((row) => row.kind)).toEqual(['LABEL', 'LABEL', 'LABEL'])
    expect(requirementsSection(input({ read: ready({ inForce: many.slice(0, 5), ended: [] }) })).kinds).toBeNull()
  })

  it('hidden, never held, for a right (the server\'s mayAdd / mayChange first); held only by state; the file a door only with files.read', () => {
    for (const can of [PM, RO]) {
      const model = requirementsSection(input({ can }))
      expect([model.add.shown, model.rows[0]!.replace.shown, model.rows[0]!.end.shown]).toEqual([false, false, false])
    }
    expect(requirementsSection(input({ read: ready({ ...READ, mayAdd: false, inForce: [{ ...v2, mayChange: false }] }) })).add.shown).toBe(false)
    expect(said1(requirementsSection(input({ archived: true })).add.held!)).toBe('Archived: reactivate it to change its terms')
    expect(requirementsSection(input()).rows[0]!.fileDoor).toBe(true)
    expect(requirementsSection(input({ can: termsCan(['parties.view']) })).rows[0]!.fileDoor).toBe(false)
  })

  it('the wall: the style search names THIS customer (forCustomer) — one search per typed pause, an older answer never lands over a newer one', () => {
    const useDepth = readFileSync(new URL('../../depth/use-depth.ts', import.meta.url), 'utf8')
    expect(useDepth).toContain('searchStyles(api, styleQuery, partyId, controller.signal)')
    expect(useDepth).toMatch(/setTimeout\(\(\) => \{[\s\S]*?\}, 300\)/)
    expect(useDepth).toContain('controller.abort()')
    expect(readFileSync(new URL('../../depth/api.ts', import.meta.url), 'utf8')).toContain("query: { q: q.trim() || undefined, status: 'OPEN', limit: 50, forCustomer }")
    // the windows are the provider's own, exported and mounted as they are; the old card went
    const windows = readFileSync(new URL('../../depth/view/RequirementsTab.tsx', import.meta.url), 'utf8')
    expect(windows).toContain('export function RequirementWindows(')
    expect(windows).not.toMatch(/export function RequirementsTab\(|DepthCard|SummaryTable/)
    expect(readFileSync(new URL('../view/terms/TermsTab.tsx', import.meta.url), 'utf8')).toContain('<RequirementWindows model={requirements.model} actions={requirements.actions} />')
  })
})

// ---- W2.2: Tax identity & e-invoice -------------------------------------------------------------------------------------------------

describe('Tax identity & e-invoice (W2.2, 10-design §5.4; D2, Z3, Z7, Z21, Z23, Z37)', () => {
  const DE = identity({ id: 'id-de', country: 'DE', taxMode: 'EU_B2B', vatNumber: '000000000', sdiRecipientCode: null, validFrom: '2026-03-01' })
  const check = (over: Partial<ViesCheck> = {}): ViesCheck => ({ id: 'vc-1', taxIdentityId: DE.id, companyId: null, countryCode: 'DE', vatNumber: '000000000', requesterVatNumber: null, requestedAt: '2026-11-20T08:00:00.000Z', result: 'VALID', consultationNumber: 'WAPIAAAA0000FAKE', traderName: 'Seed Customer Two GmbH', traderAddress: 'Musterstraße 1, 00000 Example', errorCode: null, errorMeaning: null, requestId: 'r-1', createdById: null, ...over })
  const eu = (over: Partial<Party> = {}): Party => partyWith({ id: PARTY_ID, legalName: 'Seed Customer Two GmbH', taxIdentities: [DE], viesChecks: [check()], vies: { state: 'VALID', message: '', proofCheckId: 'vc-1', checkedAt: '2026-11-20T08:00:00.000Z', validUntil: '2026-11-28T08:00:00.000Z', maxAgeDays: 30 }, ...over })
  const input = (party: Party, over: Partial<IdentityInput> = {}): IdentityInput => ({ party, can: OWNER, history: { items: party.viesChecks }, viesRunning: false, now: NOW, earlierOpen: false, laterOpen: false, checksOpen: false, ...over })
  const all = (model: ReturnType<typeof identitySection>, locale: Locale = 'en') => [model.answer, ...model.facts.flatMap((fact) => [fact.value, ...(fact.subs ?? [])]), ...(model.vies?.facts ?? []).map((fact) => fact.value)].map((words) => said1(words, locale)).join(' | ')

  it('Z23: an outage is never "not valid" — the last attempt says no answer, the older proof still counts, with its days left', () => {
    const outage = eu({ viesChecks: [check({ id: 'vc-2', result: 'ERROR', requestedAt: '2026-11-24T08:00:00.000Z', consultationNumber: null, traderName: null, traderAddress: null }), check()] })
    const model = identitySection(input(outage))
    expect(model.vies!.noAnswer).toEqual({ at: '2026-11-24T08:00:00.000Z' })
    expect(model.vies!.proof).toEqual({ result: 'VALID', at: '2026-11-20T08:00:00.000Z', stillCounts: true })
    expect(model.vies!.until).toEqual({ date: '2026-11-28T08:00:00.000Z', days: 3, warning: true })
    expect(said1(model.answer)).toBe('EU business in Germany · VAT 000000000 · VIES: valid until 28/11/2026; the last check got no answer.')
    const held = identitySection(input(eu({ viesChecks: [check({ result: 'ERROR' })], vies: { ...outage.vies, state: 'HELD', proofCheckId: null, validUntil: null } })))
    for (const model of [identitySection(input(outage)), held]) expect(all(model)).not.toMatch(/not valid/i)
    expect(said1(held.answer, 'it')).toBe('Azienda UE · Germania · Partita IVA 000000000 · VIES: ancora senza risposta, non è un rifiuto; ricontrolla più tardi.')
    expect(held.vies!.proof).toBeNull()
  })

  it('Z21: the VIES row is under the facts, only for an EU business outside Italy; a name that differs is marked, never written over ours', () => {
    const differs = identitySection(input(eu({ viesChecks: [check({ traderName: 'Another Name GmbH' })] })))
    expect(said1(differs.vies!.facts.find((fact) => fact.key === 'name')!.subs![0]!)).toBe('Differs from ours: Seed Customer Two GmbH')
    const italian = identitySection(input(partyWith({ taxIdentities: [identity()], vies: { ...eu().vies, state: 'NOT_APPLICABLE' } })))
    expect(italian.vies).toBeNull()
    expect(said1(italian.viesNotNeeded!)).toBe('VIES is not needed: it checks EU VAT numbers outside Italy.')
    // Z3: the e-invoice is ONE fact; the fiscal drawer is a warning, never "cannot be invoiced"
    const drawer = identitySection(input(partyWith({ taxIdentities: [identity({ sdiRecipientCode: '0000000' })], vies: { ...eu().vies, state: 'NOT_APPLICABLE' } })))
    expect(drawer.facts.filter((fact) => fact.key === 'einvoice')).toHaveLength(1)
    expect(drawer.facts.find((fact) => fact.key === 'einvoice')!.warning).toBe(true)
    expect(all(drawer)).not.toMatch(/cannot be invoiced/i)
    expect(said1(italian.answer)).toBe('Italian business · Partita IVA IT00000000000 · e-invoices by SDI code FAKE001.')
  })

  it('the dated identities: the earlier ones "From … to …", one that starts later "From {date} (n)"; Correct… only with one in force', () => {
    const before = identity({ id: 'id-0', vatNumber: 'IT00000000001', validFrom: '2025-01-01', current: false })
    const now = identity({ id: 'id-1', validFrom: '2026-01-01' })
    const later = identity({ id: 'id-2', vatNumber: 'IT00000000002', validFrom: '2027-01-01', current: false })
    const party = partyWith({ taxIdentities: [later, now, before], vies: { ...eu().vies, state: 'NOT_APPLICABLE' } })
    expect(datedIdentities(party)).toMatchObject({ current: { id: 'id-1' }, earlier: [{ id: 'id-0' }], later: [{ id: 'id-2' }] })
    const model = identitySection(input(party))
    expect(said1(model.earlier[0]!.when)).toBe('From 01/01/2025 to 01/01/2026')
    expect(said1(model.later[0]!.when, 'it')).toBe('Dal 01/01/2027')
    expect(model.laterFrom).toBe('2027-01-01')
    expect(said1(model.later[0]!.subs[0]!)).toBe('VAT number IT00000000002')
    expect([model.correct.shown, model.add.shown]).toEqual([true, true])
    const none = identitySection(input(partyWith({ taxIdentities: [], vies: { ...eu().vies, state: 'NOT_APPLICABLE' } })))
    expect([none.none, none.correct.shown, none.add.shown]).toEqual([true, false, true])
    expect(identitySection(input(party, { can: PM })).add.shown).toBe(false)
  })

  it('D2: a PERSON\'s codice fiscale only for those who may change customers — said once, never in the answer line', () => {
    const cf = 'XXXXXX00X00X000X'
    const person = partyWith({ kind: 'PERSON', taxIdentities: [identity({ taxMode: 'IT_B2C', vatNumber: null, fiscalCode: cf, sdiRecipientCode: null })], vies: { ...eu().vies, state: 'NOT_APPLICABLE' } })
    expect(fiscalCodeHidden(person, RO)).toBe(true)
    const hidden = identitySection(input(person, { can: RO }))
    expect(all(hidden)).not.toContain(cf)
    expect(hidden.hiddenFiscalCode).toBe(true)
    expect(said1(hidden.facts.find((fact) => fact.key === 'fiscalCode')!.value, 'it')).toBe('Nascosto per il tuo ruolo')
    expect(all(hidden).match(/personal data/g)).toHaveLength(1)
    expect(said1(hidden.answer)).toBe('Italian consumer.')
    const shown = identitySection(input(person, { can: OWNER }))
    expect(said1(shown.answer)).toBe(`Italian consumer · codice fiscale ${cf}.`)
    expect(fiscalCodeHidden({ kind: 'ORGANISATION' }, RO)).toBe(false)
  })

  it('Z7: every check folded — "The 50 newest · Show 50 more" with the server\'s cursor, never a total; Check again held by state only', () => {
    const model = identitySection(input(eu(), { history: { items: [check()], more: true, next: 'cursor-1' }, viesRunning: true, checksOpen: true }))
    expect([model.vies!.more, model.vies!.checksOpen]).toEqual([true, true])
    expect(said1(model.vies!.checkAgain.held!)).toBe('A check is running')
    expect(identitySection(input(eu(), { can: termsCan(['parties.view', 'parties.manage']) })).vies!.checkAgain.shown).toBe(false)
    const record = readFileSync(new URL('../../../../parties/_shared/PartyRecord.tsx', import.meta.url), 'utf8')
    expect(record).toContain('viesHistory(api, partyId, history.next)')
    expect(record).toContain('next: answer.nextCursor')
    expect(said1(said('ct.id.moreChecks'))).toBe('Show 50 more')
    expect(said1(said('ct.id.checksNewest', { params: { count: 50 } }), 'it')).toBe('Gli ultimi 50')
  })

  it('Z37: a VAT number another business partner holds marks its field — a refused value, not "someone else changed it"', () => {
    const clash = new ApiError('conflict', 409, 'conflict', 'This VAT number belongs to another business partner: one record per business partner.', null, [{ path: 'body/vatNumber', message: 'x' }])
    expect(problemKey(clash)).toBe('new.conflictNumber')
    expect(refusedFields(clash)).toEqual(['vatNumber'])
    expect(problemKey(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/taxIdentity/fiscalCode', message: 'x' }]))).toBe('new.conflictNumber')
    expect(problemKey(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/addresses/0/city', message: 'x' }]))).toBe('problem.invalid')
    expect(problemKey(new ApiError('conflict', 409, 'conflict', 'stale'))).toBe('problem.conflict')
    expect(problemKey(new ApiError('conflict', 409, 'conflict', 'stale', null, [{ path: 'body/version', message: 'x' }]))).toBe('problem.conflict')
  })

  it('the record view draws Terms in one line; the identity window and VIES act are the record\'s own (the supplier\'s cards untouched)', () => {
    const view = readFileSync(new URL('../view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{tab === 'terms' && termsTab}")
    expect(view).not.toMatch(/<IdentityCard|<ViesCard/)
    const container = readFileSync(new URL('./use-terms-tab.ts', import.meta.url), 'utf8')
    expect(container).toContain("onCorrectIdentity: () => input.actions?.onDialog?.({ kind: 'identity', mode: 'correct' })")
    expect(container).toContain("onNewIdentity: () => input.actions?.onDialog?.({ kind: 'identity', mode: 'new' })")
    expect(readFileSync(new URL('../../../../parties/_shared/view/PartyRecordView.tsx', import.meta.url), 'utf8')).toContain('<IdentityCard')
  })
})

// ---- W2.3: one source in Money and the Overview; one editor ------------------------------------------------------------------------

describe('one source, one editor (W2.3; 13-backend §4, Z8, Z32)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('Terms, Money and the Overview ask the ONE helper — no tab says the payment terms its own way', () => {
    expect(read('../money/model.ts')).toMatch(/export function paymentTermsOf\([\s\S]*?paymentTermsInForce\(moneyTermsSources\(terms, input\)/)
    expect(read('../money/credit.ts')).toContain('termsInForce(moneyTermsSources(terms.value, input)')
    expect(read('../overview/rows.ts')).toContain('paymentTermsInForce({ commercial: null, companies, companyId: input.companyId ?? null, typed: party.paymentTerms }')
    // The Overview's terms per company are the depth provider's ONE read (read on the Overview and on Terms), no second read.
    expect(read('../../depth/use-depth.ts')).toContain("if (tab === 'overview') void Promise.all([loadGlance(), loadTerms()])")
    expect(read('../../depth/CustomerDepth.tsx')).toContain('export function useCustomerCompanyTerms(): CustomerDepthState[\'terms\'][\'read\'] {')
    expect(read('../overview/CustomerOverview.tsx')).toContain('const companyTerms = useCustomerCompanyTerms()')
  })

  it('Z8: the customer\'s Edit window leaves out currency, document language and payment terms; New and the supplier\'s form keep them', () => {
    const dialogs = read('../../../../parties/_shared/view/dialogs.tsx')
    expect(dialogs).toContain('side={side} withTerms withCommercial={false} roles={')
    expect(dialogs.match(/withCommercial=\{false\}/g)).toHaveLength(1)
    expect(dialogs).toContain('withCommercial = true,')
    expect(read('../../../../parties/_shared/view/PartyRecordView.tsx')).not.toContain('withCommercial')
    for (const locale of LOCALES) {
      const words = createScopedTranslator(locale, messagesFor(locale, ['parties']), 'parties')('edit.subtitle')
      expect(words, locale).toContain(locale === 'en' ? 'Terms & requirements' : 'Condizioni e requisiti')
      expect(words, locale).not.toMatch(/\bparty\b/i)
    }
  })
})

// ---- W2.4: the old code out ----------------------------------------------------------------------------------------------------

describe('the old parts went; the supplier\'s record stays as it was (W2.4; D1)', () => {
  const at = (path: string) => new URL(path, import.meta.url)
  const read = (path: string) => readFileSync(at(path), 'utf8')
  const gone = (path: string) => expect(() => readFileSync(at(path), 'utf8'), path).toThrow()

  it('the old Commercial terms card, its container and styles, the PO number card and the Hold card are gone; the hold window stays', () => {
    for (const path of ['../../terms/CommercialTerms.tsx', '../../terms/view/CommercialTermsCard.tsx', '../../terms/terms.css', '../../depth/view/PoNumberCard.tsx']) gone(path)
    const hold = read('../../depth/view/HoldCard.tsx')
    expect(hold).toContain('export function HoldDialogView(')
    expect(hold).not.toMatch(/export function HoldCard\(|onToggle|DepthCard|ReadOr/)
    expect(read('../../depth/view/parts.tsx')).not.toMatch(/export function (DepthCard|ReadOr|Head)\(/)
    expect(read('../../depth/model.ts')).not.toMatch(/toggleHeld|poRows|poChanges|poHeld|shownOnKeys|export const valueOf/)
    // cu/terms/api.ts and model.ts stay (the Quotes record and Home approvals read them)
    for (const path of ['../../terms/api.ts', '../../terms/model.ts']) expect(read(path).length, path).toBeGreaterThan(0)
    expect(read('../view/CustomerRecordView.tsx')).not.toMatch(/SupplierDepth|\bdepth=\{|\bterms=\{/)
    expect(read('../CustomerRecord.tsx')).not.toContain('depth={record.depth}')
  })

  it('D1: the VIES card was the customer\'s only — it went; the supplier keeps its compact identity card and its VIES row', () => {
    const cards = read('../../../../parties/_shared/view/cards.tsx')
    expect(cards).not.toContain('export function ViesCard(')
    expect(cards).toContain('export function IdentityCard({ model, party, current, actions, editable, compact = false, viesHeld }')
    expect(cards).toContain('...(compact && viesApplies(party)')
    expect(read('../../../../parties/_shared/view/PartyRecordView.tsx')).toMatch(/<IdentityCard [^>]*compact viesHeld=\{viesHeld\} \/>/)
  })

  it('the list\'s office chip opens Tax identity & e-invoice; the words nothing says any more went, in both languages', () => {
    expect(read('../../list/columns.tsx')).toContain("href={`${recordHref(prefix, SIDES.customers, row.id, 'terms')}#party-identity`")
    for (const locale of LOCALES) {
      // ct-w2 lead fix: the catalogues are FLAT maps ("vies.notApplicable"), so the keys are checked as they are — each a real check.
      const keys = (ns: string): string[] => Object.keys(messagesFor(locale, [ns])[ns] ?? {})
      expect(keys('parties').length, locale).toBeGreaterThan(400)
      expect(keys('parties').filter((key) => /\.(notApplicable|recheck)$/.test(key) || key.startsWith('customers.anchor.')), locale).toEqual([])
      expect(keys('sales-customers-depth').filter((key) => ['po.toggle', 'po.save', 'po.setBy', 'hold.toggle', 'hold.toggleMany', 'hold.on', 'hold.off'].includes(key)), locale).toEqual([])
      expect(keys('sales-customers-depth').length, locale).toBeGreaterThan(50)
      expect(keys('customer-terms'), locale).not.toContain('termsField.carrier')
      expect(keys('customer-terms'), locale).toContain('termsField.paymentTerms')
    }
  })
})

// ---- ct-fx3: the walk's gaps (30-walk.md) ---------------------------------------------------------------------------------------

describe('ct-fx3 G-W01: the terms per company in flight are reading — never the customer\'s own as if in force (P0-B4, Z32)', () => {
  const reads = (over: Partial<TermsTabReads> = {}): TermsTabReads => ({
    party: partyWith({ id: PARTY_ID, taxIdentities: [], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } }),
    prefix: '/w/SEEDA',
    can: OWNER,
    locale: 'en',
    now: NOW,
    companyId: A.id,
    companyNames: NAMES,
    commercial: ready(own()),
    carrier: ready({ partyId: PARTY_ID, code: 'SEED-ONE', name: 'Seed Customer One S.r.l.', carrierCode: null, carrierName: null, accountOnFile: false, freightBilling: 'SENDER', defaultCarrierService: null, version: 7 }),
    holds: ready(HOLDS),
    companies: ready(COMPANY_TERMS),
    requirements: null,
    library: null,
    lists: null,
    history: { items: [] },
    viesRunning: false,
    ...over,
  })

  it('the answer line and Commercial terms wait (the kit\'s reading state) while the company-terms read is not in', () => {
    for (const companies of [LOADING, null]) {
      const model = termsTabModel(reads({ companies }), TERMS_TAB_START)
      expect(model.answerReading, String(companies)).toBe(true)
      expect(model.commercial.reading, String(companies)).toBe(true)
    }
    const answered = termsTabModel(reads(), TERMS_TAB_START)
    expect([answered.answerReading, answered.commercial.reading]).toEqual([false, false])
    // a failed read is no reading: the fallback says so (Z41)
    expect(termsTabModel(reads({ companies: failedRead('problem.offline') }), TERMS_TAB_START).commercial.reading).toBe(false)
  })
})

describe('ct-fx3 G-W02: a door lands under the record\'s sticky band (Z26; People\'s F-CA-fx5)', () => {
  it('the answer line and the four sections land on the band\'s measured line; the rows land on the same line', () => {
    const css = readFileSync(new URL('../view/terms/terms.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toContain('.fw-ctr { --fw-ctr-land: var(--fw-rcf-top, calc(var(--nds-space-48) + var(--nds-space-16))); }')
    for (const id of ['answer', 'party-hold', 'party-commercial', 'party-requirements', 'party-identity']) expect(css, id).toMatch(new RegExp(`\\.fw-ctr > #${id}[,\\s][^}]*scroll-margin-top: var\\(--fw-ctr-land\\)`))
    expect(css).not.toContain('96px')
    expect(css.match(/scroll-margin-top: var\(--fw-ctr-land\)/g)).toHaveLength(4) // the five ids' one rule + the warning chip, rows, VIES row
    // the ids are the tab root's own children (a `>` rule reaches them)
    const tab = readFileSync(new URL('../view/terms/TermsTab.tsx', import.meta.url), 'utf8')
    expect(tab).toMatch(/<div className="fw-pt fw-ctr">\s*<TermsAnswer [^>]*\/>\s*<HoldSection [^>]*\/>\s*<CommercialSection [^>]*\/>\s*<RequirementsSection [^>]*\/>\s*<IdentitySection [^>]*\/>/)
  })
})

describe('ct-fx3 G-W03: the requirement\'s file opens where this browser reaches it (Z12)', () => {
  it('the file door opens the store address through storeUrl, as Work and the order page do (a local store\'s path goes through /api)', async () => {
    const container = readFileSync(new URL('./use-terms-tab.ts', import.meta.url), 'utf8')
    expect(container).toContain("window.open(storeUrl(url), '_blank', 'noopener')")
    expect(container).not.toMatch(/window\.open\(url,/)
    const { storeUrl } = await import('../../../../../record-panels/store')
    expect(storeUrl('/local-files?token=made-up')).toBe('/api/local-files?token=made-up')
    expect(storeUrl('https://files.example.com/a.pdf')).toBe('https://files.example.com/a.pdf')
  })
})

describe('ct-fx3 G-W04: a company row\'s tags wrap inside their cell (Italian at 865)', () => {
  it('the row\'s tags carry the tab\'s own class, and only inside a company row they wrap (the DS\'s own wrap pattern; no DS class restyled)', () => {
    const css = readFileSync(new URL('../view/terms/terms.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toContain('.fw-ctr-row.is-c .fw-ctr-tag { max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: start; }')
    expect(css).not.toMatch(/\.nds-/)
    const view = readFileSync(new URL('../view/terms/CommercialSection.tsx', import.meta.url), 'utf8')
    expect(view.match(/className="fw-ctr-tag"/g)).toHaveLength(3) // the source tag, "You work here", the PO tag
    const it_ = createScopedTranslator('it', messagesFor('it', [...TERMS_TAB_NAMESPACES]), CT)('ct.com.poTag')
    expect(it_.length).toBeGreaterThan(20) // the Italian word that ran out of its cell
  })
})

/** The answer's facts for the walk's gaps (the answer line's own describe keeps its own). */
const gapFacts = (over: Partial<TermsFacts> = {}): TermsFacts => ({
  multi: false,
  company: A.name,
  inForce: termsInForce({ commercial: own(), companies: { tenantWide: false, companies: [entry(A, row({ poNumberRequired: true }), own())] }, companyId: A.id, typed: null }, 'en'),
  companiesFailed: false,
  blank: false,
  holds: [],
  waiting: waitingOf(null, OWNER, NAMES, '/w/SEEDA', PARTY_ID),
  requirements: 4,
  identity: identityFactsOf(partyWith({ taxIdentities: [identity()], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })),
  now: NOW,
  ...over,
})

describe('ct-fx3 G-W05: an Italian consumer\'s answer says no e-invoice word (only what a section shows; Z3)', () => {
  const facts = gapFacts
  it('IT_B2C: no "no SDI code or PEC" in the answer, as Tax identity draws no E-invoice fact; IT_B2B keeps its word', () => {
    const consumer = partyWith({ kind: 'PERSON', taxIdentities: [identity({ taxMode: 'IT_B2C', vatNumber: null, fiscalCode: 'XXXXXX00X00X000X', sdiRecipientCode: '0000000' })], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })
    const answer = termsAnswer(facts({ identity: identityFactsOf(consumer) }))
    for (const locale of LOCALES) expect(sentence(answer, locale), locale).not.toContain(said1(said('ct.answer.noSdi'), locale))
    for (const key of ['ct.answer.noSdi', 'ct.answer.sdi', 'ct.answer.pec']) expect(answer.words.map((words) => words.key), key).not.toContain(key)
    expect(identitySection({ party: consumer, can: OWNER, history: { items: [] }, viesRunning: false, now: NOW, earlierOpen: false, laterOpen: false, checksOpen: false }).facts.map((fact) => fact.key)).not.toContain('einvoice')
    const business = partyWith({ taxIdentities: [identity({ sdiRecipientCode: '0000000' })], warnings: [], vies: { ...MODA.vies, state: 'NOT_APPLICABLE' } })
    expect(termsAnswer(facts({ identity: identityFactsOf(business) })).words.map((words) => words.key)).toContain('ct.answer.noSdi')
  })
})

describe('ct-fx3 G-W06: the facts are balanced by their count — no line holds a lone fact beside a hole (AAA)', () => {
  /** The columns the auto-fit grid gives in a room (190 px + 20 px gap), and the ones terms.css sets instead (by count). */
  const css = readFileSync(new URL('../view/terms/terms.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const autoFit = (width: number, n: number) => Math.max(1, Math.min(n, Math.floor((width + 20) / 210)))
  const set = (width: number, n: number): number | null => {
    for (const block of css.matchAll(/@container ctfx \(min-width: (\d+)px\) and \(max-width: ([\d.]+)px\) \{([\s\S]*?)\n\}/g)) {
      if (width < Number(block[1]) || width > Number(block[2])) continue
      for (const rule of block[3]!.matchAll(/([^{}]+)\{ grid-template-columns: repeat\((\d), minmax\(0, 1fr\)\); \}/g)) if (rule[1]!.includes(`[data-n="${n}"]`)) return Number(rule[2])
    }
    return null
  }

  it('every count from 4 to 9, at every room from a phone to the widest: the last line is full, or holds at least half a line', () => {
    let checked = 0
    for (let width = 190; width <= 1900; width += 5) {
      for (let n = 4; n <= 9; n += 1) {
        const columns = set(width, n) ?? autoFit(width, n)
        const last = n % columns
        if (columns >= 3) expect(last === 0 || last >= columns / 2, `${n} facts in ${width} px: ${columns} columns`).toBe(true)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(1500)
    // the walk's own cases: 6 facts at 1150 px (1920 open) and at 830 px (1440 open), 4 VIES facts at 801 px
    expect([set(1150, 6), set(830, 6), set(801, 4)]).toEqual([3, 3, 2])
  })

  it('the sections draw Money\'s facts in the counted box (Facts itself untouched); the box is its own size container', () => {
    expect(css).toContain('.fw-ctr-fx { container: ctfx / inline-size; min-width: 0; }')
    const commercial = readFileSync(new URL('../view/terms/CommercialSection.tsx', import.meta.url), 'utf8')
    expect(commercial).toContain('<div className="fw-ctr-fx" data-n={facts.length}>')
    expect(commercial.match(/<BalancedFacts /g)).toHaveLength(3)
    expect(readFileSync(new URL('../view/terms/IdentitySection.tsx', import.meta.url), 'utf8').match(/<BalancedFacts /g)).toHaveLength(2)
    for (const name of ['CommercialSection.tsx', 'IdentitySection.tsx']) expect(readFileSync(new URL(`../view/terms/${name}`, import.meta.url), 'utf8'), name).not.toMatch(/<Facts facts=\{(?!facts\})/)
  })
})

describe('ct-fx3 G-W07: the refused page sends no Terms read (P0-B3, Z43)', () => {
  it('the depth provider\'s tab loads return at once for a reader without parties.view (People\'s F-CA-fx5 lines kept)', () => {
    const depth = readFileSync(new URL('../../depth/use-depth.ts', import.meta.url), 'utf8')
    expect(depth).toMatch(/const loadTab = useCallback\(\(\) => \{\s*\/\/[^\n]*\n\s*if \(!readsCustomer\) return\n[\s\S]*?else if \(tab === 'terms'\) void Promise\.all\(\[loadHolds\(\), loadTerms\(\), loadRequirements\(\)\]\)/)
    expect(depth).toContain('}, [loadGlance, loadHolds, loadPrivacy, loadRequirements, loadTerms, readsCustomer, tab])')
    expect(depth).toContain("const readsCustomer = session.permissions.includes('parties.view') // F-CA-fx5")
    expect(depth.match(/F-CA-fx5/g)).toHaveLength(2)
  })
})
