import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { Party, TaxIdentity } from '../../../../parties/_shared/api'
import { CUSTOMERS } from '../../../../parties/_shared/fixtures'
import type { CommercialTerms } from '../../terms/api'
import type { Holds } from '../../depth/api'
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
import { companyBody, companyEndWindowOf, companyProblems, companyWindowOf, deliveryBody, deliveryProblems, deliveryRefusal, deliveryWindowOf, endLines, termsWindowOf, termsWindowPatch } from './windows'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TermsTab } from '../view/terms/TermsTab'
import { ChangeTermsBody } from '../view/terms/ChangeTermsDialog'
import { DeliveryBody } from '../view/terms/DeliveryDialog'
import { CompanyEndBody, CompanyTermsBody } from '../view/terms/CompanyTermsDialog'
import { TermsNotices } from '../view/terms/TermsNotices'

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
    expect(views.length).toBeGreaterThanOrEqual(10)
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
  const reads = (locale: Locale): TermsTabReads => ({ party, prefix: '/w/SEEDA', can: OWNER, locale, now: NOW, companyId: two.companies[0]!.company.id, companyNames: {}, commercial: ready(own({ incoterm: 'DAP' })), carrier: ready(carrier), holds: ready(HOLDS), companies: ready(two), requirements: ready({ inForce: [], ended: [] }), library: ready([]), lists: ready([]) })

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
