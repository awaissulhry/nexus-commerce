import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PARTY_ATTENTION } from '@nexus/factory-domain/parties/contracts'
import { PARTY_WARNINGS as DOMAIN_WARNINGS } from '@nexus/factory-domain/parties/warnings'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { hasRecordPage, listAddress, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { newVerbsFor } from '../../home/today/model'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as supplierRecordScreen } from '../../purchasing/suppliers/record/fixtures'
import { designScreen as suppliersScreen } from '../../purchasing/suppliers/fixtures'
import { designScreen as customerRecordScreen } from '../../sales/customers/record/fixtures'
import { designScreen as customersScreen } from '../../sales/customers/fixtures'
import {
  ADDRESS_KINDS,
  CONTACT_ROLES,
  PARTY_KINDS,
  PARTY_ROLES,
  PARTY_STATUSES,
  PARTY_TAX_MODES,
  PARTY_WARNINGS,
  partyQueryParams,
  partySchema,
  PURCHASE_ORDER_STATUSES,
  QUOTE_STATUSES,
  SALES_ORDER_STATUSES,
  VIES_RESULTS,
  VIES_STATES,
} from './api'
import { CUSTOMERS, ORDERS, QUOTES, rowOf, SUPPLIERS, withoutMoney } from './fixtures'
import {
  addressDraftProblems,
  blankAddress,
  blankIdentity,
  blankNewParty,
  bulkReach,
  contactDraftProblems,
  dealRows,
  identityBody,
  identityProblems,
  identityWanted,
  keyNumbers,
  loaded,
  money,
  newPartyProblems,
  partyPatch,
  partyDraftOf,
  recordTabs,
  // F-SA-271: the customer's tabs, its old addresses and the part an address opens at.
  anchorOnArrival,
  MERGED_TABS,
  MERGED_TERMS,
  partyTabOf,
  reasonProblem,
  recordHref, // F-SA-225
  sdiState,
  SIDES,
  suggestCode,
  TILE_VIEW,
  viewQuery,
  WARNING_ACTION,
} from './model'

/**
 * Customers and suppliers (B-W1-07 part 2), the rules a person meets: the two sides of one party record, the saved
 * filters as the API's query, the form checks (the API's own rules, in this app's words), money only with its grain,
 * the reach of a bulk action, and every string in both languages with no key left on screen in any design case.
 */

describe('one party record, two sides (SCR-032, SCR-056)', () => {
  it('lists the roles each side sells to or buys from, and a tile is a saved view', () => {
    expect(viewQuery(SIDES.customers, 'open')).toEqual({ roles: ['CUSTOMER', 'BRAND'], q: '' })
    expect(viewQuery(SIDES.suppliers, 'open').roles).toEqual(['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'])
    expect(viewQuery(SIDES.customers, 'vies')).toMatchObject({ attention: 'VIES' })
    expect(viewQuery(SIDES.customers, 'invoice')).toMatchObject({ attention: 'INVOICE' })
    expect(viewQuery(SIDES.customers, 'archived')).toMatchObject({ statuses: ['ARCHIVED'] })
    expect(viewQuery(SIDES.customers, 'all')).toMatchObject({ statuses: ['ALL'] })
    expect(viewQuery(SIDES.suppliers, 'subcontractors')).toMatchObject({ roles: ['SUBCONTRACTOR'] })
    expect(viewQuery(SIDES.customers, 'brands', { kind: 'PERSON', taxMode: 'IT_B2C' }, ' rossi ')).toMatchObject({ roles: ['BRAND'], kind: 'PERSON', taxMode: 'IT_B2C', q: ' rossi ' })
    // B-W2b-324: Riders (people) = the customers that are people.
    expect(viewQuery(SIDES.customers, 'riders', { kind: 'ORGANISATION' })).toMatchObject({ roles: ['CUSTOMER', 'BRAND'], kind: 'PERSON' })
    for (const side of Object.values(SIDES)) for (const tile of side.tiles) expect(side.views).toContain(TILE_VIEW[tile])
  })

  it('sends the filters as the API reads them (factory-domain listPartiesQuery)', () => {
    expect(partyQueryParams({ roles: ['CUSTOMER', 'BRAND'], statuses: ['ACTIVE'], q: '  demo ', attention: 'VIES', cursor: 'abc' })).toEqual({
      role: 'CUSTOMER,BRAND',
      status: 'ACTIVE',
      q: 'demo',
      kind: undefined,
      taxMode: undefined,
      attention: 'VIES',
      limit: 50,
      cursor: 'abc',
    })
    expect(partyQueryParams({ roles: ['SUPPLIER'], q: '   ' }).q).toBeUndefined()
    // The web asks only what the API knows.
    expect(['VIES', 'INVOICE']).toEqual([...PARTY_ATTENTION])
    expect([...PARTY_WARNINGS]).toEqual([...DOMAIN_WARNINGS])
  })

  it('reads a party as the API answers it, and a row without its children', () => {
    for (const party of [...CUSTOMERS, ...SUPPLIERS]) expect(partySchema.safeParse(party).success, party.code).toBe(true)
    const row = rowOf(CUSTOMERS[0]!)
    expect(row).not.toHaveProperty('addresses')
    expect(row.code).toBe('MODA-DEMO')
  })

  it('shows the SDI column only for an Italian business customer', () => {
    expect(sdiState({ taxMode: 'IT_B2B', attention: [], roles: ['CUSTOMER'] })).toBe('set')
    expect(sdiState({ taxMode: 'IT_B2B', attention: ['FISCAL_DRAWER'], roles: ['BRAND'] })).toBe('missing')
    expect(sdiState({ taxMode: 'EU_B2B', attention: [], roles: ['CUSTOMER'] })).toBeNull()
    expect(sdiState({ taxMode: 'IT_B2B', attention: [], roles: ['SUPPLIER'] })).toBeNull()
  })

  it('a record shows the tabs whose reads the person may make', () => {
    const can = { view: true, manage: true, block: true, vies: true, quotes: true, orders: true, purchaseOrders: true, price: true, cost: true, threads: true }
    // B-TH-260: Terms & requirements (Tax & terms + Requirements); Documents and Activity went to the docked thread.
    // F-SA-271 (R5): Work with orders.view, Quotes & incoming with quotes or incoming, Money with any of its rights, Portal settings with partners.view.
    expect(recordTabs(SIDES.customers, can)).toEqual(['work', 'quotes', 'overview', 'people', 'terms'])
    expect(recordTabs(SIDES.customers, { ...can, quotes: false, orders: false, threads: false })).toEqual(['overview', 'people', 'terms'])
    expect(recordTabs(SIDES.customers, { ...can, quotes: false, inquiries: true })).toEqual(['work', 'quotes', 'overview', 'people', 'terms'])
    expect(recordTabs(SIDES.customers, { ...can, depth: true, partners: true, money: true })).toEqual(['work', 'quotes', 'overview', 'money', 'people', 'terms', 'portal'])
    // B-W2a-69: Items & prices stays in view without purchasing.view: the tab says what is missing. B-TH-260: Contacts is part of
    // Overview & contacts; Documents & questionnaire with the depth slot or the questionnaire.
    expect(recordTabs(SIDES.suppliers, { ...can, purchaseOrders: false })).toEqual(['overview', 'items'])
    expect(recordTabs(SIDES.suppliers, { ...can, questionnaire: true })).toEqual(['overview', 'items', 'documents', 'orders'])
  })

  it('a party opens on its record page from anywhere (Today, the palette); New party opens New customer', () => {
    expect(hasRecordPage('Party', OFFICE_PAGES)).toBe(true)
    expect(recordAddress({ type: 'Party', id: 'p 1' }, OFFICE_PAGES)).toBe('/sales/customers/p%201')
    expect(recordAddress({ type: 'Party', id: 'p1' }, new Set(['/me']))).toBe('/records/Party/p1')
    expect(listAddress('/parties', {}, OFFICE_PAGES)).toBe('/sales/customers')
    expect(newVerbsFor(new Set(['parties.manage']), OFFICE_PAGES, '/w/DEMO')).toEqual([{ id: 'party', labelKey: 'today.new.party', href: '/w/DEMO/sales/customers?new=1' }])
  })

  it('every warning the API sends has its next step', () => {
    for (const code of PARTY_WARNINGS) expect(WARNING_ACTION[code], code).toBeDefined()
  })
})

describe('the forms check what the API checks, before they send', () => {
  it('a tax identity: the VAT check digit, the prefix, the format, the codice fiscale, the 7-character SDI code', () => {
    const it = blankIdentity('IT', true)
    expect(identityProblems({ ...it, vatNumber: '' }).vatNumber?.key).toBe('form.identity.vatNeededIt')
    expect(identityProblems({ ...it, vatNumber: '12345678901' }).vatNumber?.key).toBe('form.identity.vatCheckDigit')
    expect(identityProblems({ ...it, vatNumber: '00000000000' })).toEqual({})
    expect(identityProblems({ ...it, vatNumber: 'IT00000000000', sdiRecipientCode: 'AB12' }).sdiRecipientCode?.key).toBe('form.identity.sdiShape')
    expect(identityProblems({ ...it, vatNumber: 'IT00000000000', sdiRecipientCode: 'ABC123' }).sdiRecipientCode?.key).toBe('form.identity.sdiPublic')
    expect(identityProblems({ ...it, vatNumber: 'IT00000000000', pec: 'not-mail' }).pec?.key).toBe('form.identity.pecShape')
    const de = blankIdentity('DE', true)
    expect(de.taxMode).toBe('EU_B2B')
    expect(identityProblems({ ...de, vatNumber: 'DE12345' }).vatNumber).toEqual({ key: 'form.identity.vatShape', params: { country: 'DE' } })
    expect(identityProblems({ ...de, vatNumber: 'FR00000000000' }).vatNumber).toEqual({ key: 'form.identity.vatPrefix', params: { prefix: 'DE' } })
    expect(identityProblems({ ...de, vatNumber: '000000000' })).toEqual({})
    expect(identityProblems({ ...blankIdentity('GR', true), vatNumber: '000000000' })).toEqual({})
    expect(identityProblems({ ...blankIdentity('IT', false), fiscalCode: '' }).fiscalCode?.key).toBe('form.identity.fiscalNeeded')
    expect(identityProblems({ ...de, taxMode: 'IT_B2B', vatNumber: '00000000000' }).country?.key).toBe('form.identity.countryMode.IT_B2B')
    expect(identityProblems({ ...it, vatNumber: '00000000000' }, true).validFrom?.key).toBe('form.identity.validFrom')
  })

  it('sends only the fields a tax mode uses', () => {
    expect(identityBody({ ...blankIdentity('DE', true), vatNumber: ' DE000000000 ', fiscalCode: 'x', sdiRecipientCode: 'y' }, false)).toEqual({
      country: 'DE',
      taxMode: 'EU_B2B',
      vatNumber: 'DE000000000',
      fiscalCode: null,
      sdiRecipientCode: null,
      pec: null,
    })
    expect(identityBody({ ...blankIdentity('IT', true), vatNumber: '00000000000', validFrom: '2026-11-01' }, true)).toMatchObject({ validFrom: '2026-11-01' })
  })

  it('a new party: its fields and its first identity; an EU consumer with nothing typed sends no identity', () => {
    const draft = blankNewParty(SIDES.customers)
    expect(Object.keys(newPartyProblems(draft)).sort()).toEqual(['code', 'identity.vatNumber', 'legalName'])
    const ready = { ...draft, party: { ...draft.party, legalName: 'Moda Demo S.r.l.', code: 'MODA-DEMO' }, identity: { ...draft.identity, vatNumber: '00000000000' } }
    expect(newPartyProblems(ready)).toEqual({})
    const consumer = { ...ready, party: { ...ready.party, country: 'FR' }, identity: { ...blankIdentity('FR', false), vatNumber: '' } }
    expect(identityWanted(consumer)).toBe(false)
    expect(blankNewParty(SIDES.suppliers).party.roles).toEqual(['SUPPLIER'])
  })

  it('suggests a code from the name, without the legal form', () => {
    expect(suggestCode('Conceria Demo S.p.A.')).toBe('CONCERIA-DEMO')
    expect(suggestCode('Muster Leder GmbH')).toBe('MUSTER-LEDER')
    expect(suggestCode('Pelletteria Èsempio')).toBe('PELLETTERIA-ESEMPIO')
    expect(suggestCode('Una ragione sociale molto lunga davvero').length).toBeLessThanOrEqual(24)
  })

  it('changes only what changed (null clears an optional text)', () => {
    const before = partyDraftOf(CUSTOMERS[0]!)
    expect(partyPatch(before, { ...before })).toEqual({})
    expect(partyPatch(before, { ...before, tradeName: '', roles: ['CUSTOMER', 'BRAND'], code: 'moda-demo-2' })).toEqual({ tradeName: null, roles: ['CUSTOMER', 'BRAND'], code: 'MODA-DEMO-2' })
  })

  it('an address: the Italian CAP and province, a default needs its use', () => {
    const address = { ...blankAddress('IT', false), line1: 'Via Esempio 1', city: 'Firenze', postalCode: '501', province: 'XX' }
    const problems = addressDraftProblems(address)
    expect(problems.postalCode?.key).toBe('form.address.capIt')
    expect(problems.province?.key).toBe('form.address.provinceIt')
    expect(addressDraftProblems({ ...address, postalCode: '50100', province: 'FI' })).toEqual({})
    expect(addressDraftProblems({ ...address, postalCode: '50100', province: 'FI', isDefaultBillTo: true }).isDefaultBillTo?.key).toBe('form.address.defaultBillTo')
    expect(addressDraftProblems({ ...blankAddress('DE', true), line1: 'Musterstraße 1', city: 'Beispielstadt', postalCode: '00000' })).toEqual({})
  })

  it('a contact who receives documents has an email, never one another contact holds', () => {
    expect(contactDraftProblems({ name: 'Anna Demo', email: '', phone: '', roles: ['ORDERS'], language: '' }).email?.key).toBe('form.contact.emailForDocuments')
    expect(contactDraftProblems({ name: 'Anna Demo', email: 'x', phone: '', roles: [], language: '' }).email?.key).toBe('form.contact.email')
    expect(contactDraftProblems({ name: 'Anna Demo', email: 'Acquisti@Moda-Demo.example.com', phone: '', roles: ['ORDERS'], language: '' }, CUSTOMERS[0]!.contacts).email?.key).toBe(
      'form.contact.emailTwice',
    )
    expect(contactDraftProblems({ name: '', email: '', phone: '12', roles: [], language: '' })).toMatchObject({ name: { key: 'form.contact.name' }, phone: { key: 'form.contact.phone' } })
  })

  it('a block needs its reason', () => {
    expect(reasonProblem('  ', true)).toBe('form.reasonNeeded')
    expect(reasonProblem('', false)).toBeNull()
    expect(reasonProblem('x'.repeat(501), true)).toBe('form.reasonLong')
  })
})

describe('money only with its grain; a bulk action says its reach before the click', () => {
  it('draws an amount only when the API sent it', () => {
    const spaced = (text: string | null) => text?.replace(/\s/g, ' ') ?? null
    expect(spaced(money(1_845_000, 'EUR', 'it'))).toBe('18.450,00 €')
    expect(money(undefined, 'EUR', 'en')).toBeNull()
    expect(money(150, 'JPY', 'en')).toBe('JP¥150')
  })

  it('the key numbers count without amounts when the price grain is missing, and never sum mixed currencies', () => {
    const numbers = keyNumbers(loaded(QUOTES), loaded(ORDERS), '2026')
    expect(numbers.openQuotes).toEqual({ count: 2, amount: 2_487_500, currency: 'EUR' })
    expect(numbers.backlog).toMatchObject({ count: 1, units: 240, amount: 2_310_000 })
    expect(numbers.orderedThisYear).toMatchObject({ count: 2, amount: 3_390_000 })
    const hidden = keyNumbers(loaded(withoutMoney(QUOTES)), loaded(withoutMoney(ORDERS)), '2026')
    expect(hidden.openQuotes).toEqual({ count: 2, amount: null, currency: 'EUR' })
    expect(keyNumbers(loaded([{ ...QUOTES[0]!, currency: 'CHF' }, QUOTES[1]!]), loaded([]), '2026').openQuotes?.amount).toBeNull()
    // Unknown is not zero: an unread list or one cut short gives no number.
    expect(keyNumbers({ items: null }, loaded(ORDERS, true), '2026')).toEqual({ openQuotes: null, backlog: null, orderedThisYear: null })
  })

  it('quotes and orders in one list, newest first, by open / won / lost', () => {
    expect(dealRows(QUOTES, ORDERS, 'open').map((row) => row.number)).toEqual(['PV-2026-00041', 'PV-2026-00039', 'OV-2026-00031'])
    expect(dealRows(QUOTES, ORDERS, 'lost').map((row) => row.number)).toEqual(['PV-2026-00017'])
    expect(dealRows(QUOTES, ORDERS, 'all')).toHaveLength(6)
  })

  it('VIES reaches only EU numbers outside Italy; archive never a blocked party', () => {
    const rows = CUSTOMERS.map(rowOf)
    const vies = bulkReach('vies', rows)
    expect(vies.reach.map((row) => row.code)).toEqual(['DE-BEISPIEL', 'FR-EXEMPLE', 'AT-MUSTER', 'ES-PRUEBA'])
    expect(bulkReach('archive', rows).skipped.map((row) => row.code)).toEqual(['BLOCCATO-DEMO'])
    // Block N reaches the active ones only (a prospect is approved or archived, a blocked one is blocked already).
    expect(bulkReach('block', rows).skipped.map((row) => row.code).sort()).toEqual(['BLOCCATO-DEMO', 'ES-PRUEBA', 'NUOVO-PROVA'])
    expect(bulkReach('block', rows).reach.every((row) => row.status === 'ACTIVE')).toBe(true)
  })

})

// ---- every string in both languages ----

const SRC = fileURLToPath(new URL('../..', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
const PREFIXES = [
  'common',
  'problem',
  'live',
  'list',
  'row',
  'held',
  'csv',
  'new',
  'edit',
  'block',
  'archive',
  'address',
  'contact',
  'identity',
  'field',
  'form',
  'done',
  'bulk',
  'keys',
  'overview',
  'numbers',
  'side',
  'deals',
  'pos',
  'record',
  'vies',
  'step',
  'tile',
  'sdi',
  'customers',
  'suppliers',
]
/** Strings shaped like keys that are not: the New dialog's field paths. */
const NOT_KEYS: ReadonlySet<string> = new Set(['identity.vatNumber', 'identity.fiscalCode'])
function literalKeys(): string[] {
  const pattern = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
  const keys = new Set<string>()
  for (const dir of ['parties', 'sales/customers', 'purchasing/suppliers'])
    // B-W2a-69: purchasing/suppliers/sources speaks its own catalogue (purchasing-sources), checked by its own test.
    // B-W2b-180: the Portal access tab (sales/customers/portal, purchasing/suppliers/portal) speaks `portal-access` (its own test).
    // B-W2b-172: the Questionnaire tab (purchasing/suppliers/questionnaire) speaks `purchasing-questionnaire` (its own test).
    // B-W2b-334: the supplier in depth (purchasing/suppliers/depth, /list) speaks `purchasing-suppliers-depth` (its own test).
    // B-W2b-324: the customer in depth (sales/customers/depth) speaks `sales-customers-depth` (its own test).
    for (const file of sources(join(SRC, dir)).filter((path) => !path.includes(`${join('suppliers', 'sources')}`) && !path.includes(`${join('customers', 'portal')}`) && !path.includes(`${join('suppliers', 'portal')}`) && !path.includes(`${join('suppliers', 'questionnaire')}`) && !path.includes(`${join('suppliers', 'depth')}`) && !path.includes(`${join('suppliers', 'list')}`) && !path.includes(`${join('customers', 'depth')}`) && !path.includes(`${join('customers', 'list')}`) /* T.2: the list folder speaks customers-list (its own key test) */))
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) if (!NOT_KEYS.has(match[1]!) && !ORDERS_READ.test(match.input.slice(Math.max(0, match.index - 2), match.index))) keys.add(match[1]!)
  return [...keys].sort()
}
// ---- op-fx1: F-OP-203's customer dock reads two of the order dock's words through the orders translator (`const o = useT('orders')`,
// its WithMessages loads 'orders'): those keys are the orders catalogue's, checked there (both locales), never taken for parties keys.
const ORDERS_READ = /\bo\($/
function ordersReadKeys(): string[] {
  const keys = new Set<string>()
  for (const file of sources(join(SRC, 'sales/customers'))) for (const match of readFileSync(file, 'utf8').matchAll(/\bo\(['"`]([A-Za-z0-9_.]+)['"`]/g)) keys.add(match[1]!)
  return [...keys].sort()
}
// ---- end op-fx1
const has = (key: string) =>
  LOCALES.every((locale) => key in (CATALOGUE[locale].parties ?? {}) || (`${key}_one` in (CATALOGUE[locale].parties ?? {}) && `${key}_other` in (CATALOGUE[locale].parties ?? {})))

const built = [
  ...PARTY_STATUSES.map((value) => `status.${value}`),
  ...PARTY_ROLES.map((value) => `role.${value}`),
  ...PARTY_KINDS.map((value) => `kind.${value}`),
  ...PARTY_TAX_MODES.flatMap((value) => [`taxMode.${value}`, `taxModeHint.${value}`, `field.vatHint.${value}`, `form.identity.countryMode.${value}`]),
  ...ADDRESS_KINDS.map((value) => `addressKind.${value}`),
  ...CONTACT_ROLES.flatMap((value) => [`contactRole.${value}`, `customers.contactRoleHint.${value}`, `suppliers.contactRoleHint.${value}`]),
  ...QUOTE_STATUSES.map((value) => `quoteStatus.${value}`),
  ...SALES_ORDER_STATUSES.map((value) => `orderStatus.${value}`),
  ...PURCHASE_ORDER_STATUSES.map((value) => `poStatus.${value}`),
  ...PARTY_WARNINGS.map((value) => `warning.${value}`),
  ...Object.values(WARNING_ACTION).map((value) => `step.action.${value}`),
  ...VIES_STATES.flatMap((value) => [`vies.state.${value}`, `vies.meaning.${value}`]),
  ...['VALID', 'EXPIRED', 'INVALID', 'HELD'].map((value) => `vies.stateOn.${value}`),
  ...VIES_RESULTS.flatMap((value) => [`vies.result.${value}`, `vies.done.${value}`]),
  ...['connecting', 'live', 'offline'].map((value) => `live.${value}`),
  ...['ACTIVE', 'ARCHIVED'].map((value) => `master.${value}`),
  ...['block', 'unblock', 'reactivate', 'activate', 'archive'].map((value) => `done.${value}`),
  ...['vies', 'archive', 'block'].flatMap((value) => [`bulk.${value}.title`, `bulk.${value}.done`]),
  ...['billTo', 'shipTo'].map((value) => `address.default.${value}`),
  ...['open', 'won', 'lost', 'all', 'quote', 'order'].map((value) => `deals.${value}`),
  ...Object.values(SIDES).flatMap((side) => [
    ...side.views.map((view) => `view.${view}`),
    ...side.tiles.flatMap((tile) => [`tile.${side.side}.${tile}`, `tile.${side.side}.${tile}Hint`]),
    ...side.tabs.map((tab) => `${side.side}.tab.${tab}`),
    ...[
      'title',
      'intro',
      'search',
      'table',
      // F-SA-225: no CSV is made in the browser any more (Export N goes through the export job), so `<side>.file` went with it.
      'failedTitle',
      'empty.title',
      'empty.body',
      'noAccess.title',
      'noAccess.body',
      'activate',
      'blockedBanner',
      'keys.new',
      'side.contacts',
      'side.noContacts',
      'address.emptyBody',
      'identity.none',
      'step.none',
    ].map((key) => `${side.side}.${key}`),
    ...['action', 'title', 'subtitle', 'go', 'after'].map((key) => `${side.side}.new.${key}`),
    ...['title', 'titleMany', 'go', 'stops1', 'stops2'].map((key) => `${side.side}.block.${key}`),
    ...['titleOne', 'titleMany', 'reach1'].map((key) => `${side.side}.archive.${key}`),
    ...['empty', 'emptyBody', 'addFirst'].map((key) => `${side.side}.contacts.${key}`),
  ]),
]

describe('every string of the four screens exists in it and en (PLAN §4.6)', () => {
  it('every key the code names (literally or from an enum) exists in both catalogues', () => {
    const keys = [...literalKeys(), ...built]
    expect(keys.length).toBeGreaterThan(400)
    expect([...new Set(keys)].filter((key) => !has(key))).toEqual([])
    // op-fx1: the keys read through the orders translator exist in the orders catalogue, in both languages.
    // F-CP-113: + the made order's toast of the lines window (an orders word).
    expect(ordersReadKeys()).toEqual(['newOrder.window.made', 'record.dock.writeGeneral', 'record.dock.writeIn', 'rows.IN_PRODUCTION' /* F-CW-101 (cw W1): the Work tab's started-orders view */])
    expect(ordersReadKeys().filter((key) => !LOCALES.every((locale) => key in (CATALOGUE[locale].orders ?? {})))).toEqual([])
  })
})

const LEFT_KEY =
  /\b(?:common|problem|list|row|held|new|edit|block|archive|address|contact|identity|field|form|done|bulk|keys|overview|numbers|side|deals|pos|record|vies|step|tile|sdi|status|role|kind|taxMode|warning|view|customers|suppliers|quoteStatus|orderStatus|poStatus|addressKind|contactRole|master|live|panels|nav)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [customersScreen, customerRecordScreen, suppliersScreen, supplierRecordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          // Email addresses (anna@moda-demo.example.com) look like keys after the @; drop them first.
          const text = html.replace(/[\w.+-]+@[\w.-]+/g, '')
          expect(text.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the four screens have the states the design asks for', () => {
    const ids = (screen: DesignScreen<unknown>) => screen.cases.map((item) => item.id)
    for (const screen of [customersScreen, suppliersScreen] as DesignScreen<unknown>[])
      expect(ids(screen)).toEqual(expect.arrayContaining(['list', 'loading', 'error', 'empty', 'filtered-empty', 'no-access', 'read-only', 'selection', 'new', 'block', 'archive']))
    for (const screen of [customerRecordScreen, supplierRecordScreen] as DesignScreen<unknown>[])
      expect(ids(screen)).toEqual(expect.arrayContaining(['loading', 'not-found', 'no-access', 'read-only', 'blocked', 'thread-docked', 'thread-no-right', 'notices'])) // B-TH-260
  })

  it('a role without the grain sees no amount at all', () => {
    const html = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'quotes-orders-no-price')!.model, 'en')
    expect(html).not.toMatch(/€/)
    // F-SA-276: Work is the Orders sheet now (its money columns are absent without the grain); the amounts of the grain show on Money.
    const withPrice = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'tab-money')!.model, 'en')
    expect(withPrice).toMatch(/€/)
    const supplier = render(supplierRecordScreen as DesignScreen<unknown>, supplierRecordScreen.cases.find((item) => item.id === 'orders-no-cost')!.model, 'it')
    expect(supplier).not.toMatch(/€/)
  })
})

// ---- F-SA-225 (sales page plan N5, picks P18, P23; 12-lists-board §5 rules 1 and 2): one row-click and one Export N rule ----------
describe('Customers and Purchasing › Suppliers (one list): a row opens its record, the file is the export job\'s, the terms in the address (F-SA-225)', () => {
  const view = readFileSync(new URL('./view/PartiesListView.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./PartiesList.tsx', import.meta.url), 'utf8')

  it('the rest of a row opens the record on both sides (⌘ / Ctrl: a new tab)', () => {
    expect(view).toContain("onRowClick={(row, event) => (event.metaKey || event.ctrlKey ? window.open(recordHref(model.prefix, config, row.id), '_blank', 'noopener') : actions?.onOpen?.(row))}")
    expect(recordHref('/w/DEMO', SIDES.customers, 'p1')).toContain('/sales/customers/p1')
    expect(recordHref('/w/DEMO', SIDES.suppliers, 'p1')).toContain('/purchasing/suppliers/p1')
  })

  it('Export N goes through the export job with the picked rows; no CSV is made in the browser, on either side', () => {
    expect(view).toContain('exportSelected: true')
    expect(view).not.toContain('onExport')
    expect(page).not.toContain('downloadText')
    expect(page).not.toContain('partiesCsv')
    for (const locale of LOCALES) for (const key of ['list.exportView', 'list.bulkExport_one', 'csv']) expect(key in (CATALOGUE[locale].parties ?? {}), `${locale} ${key}`).toBe(false)
  })

  it('the view, the search and the chips are address terms (the file reads the screen\'s address: screen = file)', () => {
    expect(page).toContain("if (nextQuery) search.set('q', nextQuery)")
    expect(page).toContain("if (nextFilters.kind) search.set('kind', nextFilters.kind)")
    expect(page).toContain("if (nextFilters.taxMode) search.set('taxMode', nextFilters.taxMode)")
    expect(page).toContain("const query = (params?.get('q') ?? '').slice(0, 100)")
  })
})
// ---- end F-SA-225

// ---- F-SA-271 (sales page plan N5, picks R5, P10; 11-customer-page §2): the customer's seven tabs, the landing tab, old addresses, the band
describe('F-SA-271: the customer’s seven tabs and band', () => {
  const can = { view: true, manage: true, block: true, vies: true, quotes: true, orders: true, purchaseOrders: true, price: true, cost: true, threads: true }
  it('no tab asked: the first tab the reader sees (Work for Sales; Overview without orders.view); a supplier still lands on its Overview', () => {
    expect(partyTabOf('customers', null, recordTabs(SIDES.customers, can))).toBe('work')
    expect(partyTabOf('customers', undefined, recordTabs(SIDES.customers, { ...can, orders: false, quotes: false }))).toBe('overview')
    expect(partyTabOf('customers', 'nope', recordTabs(SIDES.customers, can))).toBe('work')
    expect(partyTabOf('suppliers', null, recordTabs(SIDES.suppliers, can))).toBe('overview')
  })

  it('every old ?tab= keeps working: orders → Work (All orders), addresses → People & addresses, requirements → Terms at its part', () => {
    expect(partyTabOf('customers', 'orders')).toBe('work')
    expect(MERGED_TERMS.customers.orders).toEqual({ rows: 'all' })
    expect(partyTabOf('customers', 'addresses')).toBe('people')
    expect(partyTabOf('customers', 'tax')).toBe('terms')
    expect(partyTabOf('customers', 'requirements')).toBe('terms')
    expect(anchorOnArrival('customers', 'requirements')).toBe('party-requirements')
    expect(anchorOnArrival('customers', 'terms')).toBeNull()
    expect(partyTabOf('customers', 'portal')).toBe('portal')
    for (const old of ['documents', 'activity']) expect(partyTabOf('customers', old)).toBe('overview')
    // The supplier's tabs and old ids are untouched.
    expect(SIDES.suppliers.tabs).toEqual(['overview', 'items', 'documents', 'orders', 'quality', 'bank', 'portal'])
    expect(MERGED_TABS.suppliers).toEqual({ contacts: 'overview', questionnaire: 'documents', activity: 'overview' })
    expect(MERGED_TERMS.suppliers).toEqual({})
  })

  it('the band: New order for an active customer with orders.manage (the sheet with this customer chosen), held with why without it', () => {
    const id = CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!.id
    const html = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'band-doors')!.model, 'en')
    expect(html).toContain(`/sales/orders?party=${id}&amp;new=1`)
    expect(html).toContain('New order')
    const held = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'band-held')!.model, 'en')
    expect(held).not.toContain(`/sales/orders?party=${id}&amp;new=1`)
    expect(held).toContain('New order')
    // A prospect keeps Activate; a blocked customer has no primary.
    const prospect = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'blocked')!.model, 'en')
    expect(prospect).not.toContain('&amp;new=1')
  })

  it('its words exist in it and en with the same placeholders', () => {
    for (const key of ['customers.band.newOrder', 'customers.band.addTask', 'customers.band.importOrders', 'customers.band.workOrders', 'held.right', 'deals.titleQuotes', 'deals.titleOrders']) {
      const en = CATALOGUE.en.parties![key]
      const it = CATALOGUE.it.parties![key]
      expect(en, key).toBeTruthy()
      expect(it, key).toBeTruthy()
      expect((it!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((en!.match(/\{\w+\}/g) ?? []).sort())
    }
    expect(CATALOGUE.it.parties!['customers.tab.money']).toBe('Importi')
  })
})
// ---- end F-SA-271

// ---- F-SA-274 → F-CA-120 (customer People & addresses, lane ca-; Z1; 13-backend §5.8): one row per person (the same-e-mail tag became
// the join), and the invitation from a contact opened in place
describe('F-SA-274 → F-CA-120: People & addresses', () => {
  it('a contact and the portal person of its e-mail (letters aside) are ONE row with its portal state; a portal person who is no contact is "Portal only"', () => {
    const peopleCase = customerRecordScreen.cases.find((item) => item.id === 'people-portal')!.model
    const html = render(customerRecordScreen as DesignScreen<unknown>, peopleCase, 'en')
    expect((html.match(/id="person-c-/g) ?? []).length).toBe(2)
    expect((html.match(/id="person-u-/g) ?? []).length).toBe(1)
    expect(html).toContain('Portal only')
    expect(html).not.toContain('Has portal access')
    expect(render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'addresses')!.model, 'en')).not.toContain('Portal only')
    expect(render(customerRecordScreen as DesignScreen<unknown>, peopleCase, 'it')).toContain('Solo portale')
  })

  it('the invitation from a contact opens the portal\'s own window in place, its e-mail and name filled in (?invite= still opens it once on arrival)', () => {
    const tab = readFileSync(new URL('../../sales/customers/record/people/use-people-tab.ts', import.meta.url), 'utf8')
    expect(tab).toContain("portalActions.onDialog?.({ kind: 'invite', email: contact.email, name: contact.name })")
    const portal = readFileSync(new URL('../../sales/customers/portal/PortalAccess.tsx', import.meta.url), 'utf8')
    expect(portal).toContain("setDialog({ kind: 'invite', email,")
    const dialog = readFileSync(new URL('../../sales/customers/portal/view/PortalDialogs.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain('{ ...blankInvite(access, locale), ...from }')
  })
})
// ---- end F-SA-274 → F-CA-120

// ---- F-CL-101 (customers list plan §2, K12, settles T10 / T15 / T16): the shared rule fixes, on Customers and Suppliers alike ---
// (imported here, below the pinned lines above, so those lines stay where they were)
import { ARCHIVED_CUSTOMER } from './fixtures'
import { emptyWordsOf, listCanOf, rowActsOf, viewsOf } from './model'

describe('F-CL-101: one Views ▾, an empty view says its own words, an act without its right is not drawn', () => {
  const ROLES: Readonly<Record<string, readonly string[]>> = {
    owner: ['parties.view', 'parties.manage', 'parties.block', 'parties.vies', 'views.export'],
    sales: ['parties.view', 'parties.manage', 'parties.vies', 'views.export'],
    finance: ['parties.view', 'parties.manage', 'parties.block', 'parties.vies', 'views.export'],
    productionManager: ['parties.view', 'views.export'],
    warehouse: ['parties.view', 'views.export'],
    readOnly: ['parties.view'],
  }
  const byCode = (code: string) => rowOf(CUSTOMERS.find((item) => item.code === code)!)

  it('Views ▾ lists the side’s own views, the one in the address checked; the customers’ five tiles went, the suppliers keep theirs', () => {
    expect(viewsOf('customers', 'blocked')).toEqual({ ids: SIDES.customers.views, active: 'blocked' })
    expect(viewsOf('suppliers', 'carriers').active).toBe('carriers')
    // A view of the other side is not one of these: no view is checked.
    expect(viewsOf('customers', 'carriers').active).toBeNull()
    expect(SIDES.customers.tiles).toEqual([])
    expect(SIDES.suppliers.tiles).toEqual(['active', 'prospects', 'blocked'])
  })

  it('an empty list names what is empty — the search, the chips, the view — and the first day stays the side’s own', () => {
    expect(emptyWordsOf('customers', 'blocked', {}, '')).toEqual({ kind: 'view', key: 'empty.customers.blocked', view: 'blocked' })
    expect(emptyWordsOf('customers', 'archived', {}, '')).toMatchObject({ key: 'empty.customers.archived' })
    expect(emptyWordsOf('customers', 'brands', {}, '')).toEqual({ kind: 'view', key: 'empty.customers.other', view: 'brands' })
    expect(emptyWordsOf('suppliers', 'blocked', {}, '')).toMatchObject({ key: 'empty.suppliers.blocked' })
    expect(emptyWordsOf('suppliers', 'prospects', {}, '')).toMatchObject({ key: 'empty.suppliers.other' })
    expect(emptyWordsOf('customers', 'blocked', {}, ' Seed Zeta ')).toEqual({ kind: 'search', key: 'empty.customers.search', q: 'Seed Zeta' })
    expect(emptyWordsOf('customers', 'open', { kind: 'PERSON' }, '')).toEqual({ kind: 'filters', key: 'empty.customers.filters' })
    expect(emptyWordsOf('customers', 'open', {}, '  ')).toEqual({ kind: 'none' })
  })

  it('every empty word exists in it and en with the same placeholders (customers-list)', () => {
    const keys = ['empty.clear', 'empty.clearSearch', ...(['customers', 'suppliers'] as const).flatMap((side) => SIDES[side].views.map((view) => emptyWordsOf(side, view, {}, '').kind === 'view' ? (emptyWordsOf(side, view, {}, '') as { key: string }).key : `empty.${side}.search`)), 'empty.customers.filters', 'empty.suppliers.filters']
    for (const key of new Set(keys)) {
      const en = CATALOGUE.en['customers-list']?.[key]
      const it = CATALOGUE.it['customers-list']?.[key]
      expect(en, key).toBeTruthy()
      expect(it, key).toBeTruthy()
      expect((it!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((en!.match(/\{\w+\}/g) ?? []).sort())
    }
  })

  it('each role sees only the row acts its own rights allow; Archive of a blocked one stays, held by state', () => {
    const active = byCode('DE-BEISPIEL')
    const blocked = byCode('BLOCCATO-DEMO')
    const archived = rowOf(ARCHIVED_CUSTOMER)
    const acts = (role: string) => [active, blocked, archived].map((row) => rowActsOf(row, listCanOf(ROLES[role]!)))
    expect(acts('owner')).toEqual([['vies', 'block', 'archive'], ['unblock', 'archive-held'], ['reactivate']])
    expect(acts('finance')).toEqual(acts('owner'))
    expect(acts('sales')).toEqual([['vies', 'archive'], ['archive-held'], ['reactivate']])
    for (const role of ['productionManager', 'warehouse', 'readOnly']) expect(acts(role), role).toEqual([[], [], []])
    expect(listCanOf(ROLES.readOnly!)).toEqual({ view: true, manage: false, block: false, vies: false, export: false })
    expect(listCanOf(ROLES.warehouse!).export).toBe(true)
  })

  it('without the right to manage there is no New customer and no Import (hidden, not held)', () => {
    const count = (id: string) => (render(customersScreen as DesignScreen<unknown>, customersScreen.cases.find((item) => item.id === id)!.model, 'en').match(/New customer/g) ?? []).length
    expect(count('read-only')).toBeLessThan(count('list'))
    const imports = (id: string) => (render(customersScreen as DesignScreen<unknown>, customersScreen.cases.find((item) => item.id === id)!.model, 'en').match(/Import<\/button>/g) ?? []).length
    expect(imports('list')).toBeGreaterThan(0)
    expect(imports('import-held')).toBe(0)
    expect(imports('import-held-manage')).toBe(0)
  })

  it('no keys window and no Rows ▾: the keys live in the footer’s icon, the views in the one Views ▾', () => {
    const view = readFileSync(new URL('./view/PartiesListView.tsx', import.meta.url), 'utf8')
    const dialogs = readFileSync(new URL('./view/dialogs.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('ShortcutsModal')
    expect(view).not.toContain("kind: 'shortcuts'")
    expect(dialogs).not.toContain('export function ShortcutsModal')
    expect(view).not.toContain("t('list.rows'")
    expect(view).toContain('builtInViews={builtInViews')
    for (const screen of [customersScreen, suppliersScreen] as DesignScreen<unknown>[]) expect(screen.cases.map((item) => item.id)).not.toContain('shortcuts')
  })

  it('the no-access words name no role, in both languages', () => {
    for (const locale of LOCALES)
      for (const side of ['customers', 'suppliers'] as const) {
        const body = CATALOGUE[locale].parties![`${side}.noAccess.body`]!
        expect(body, `${locale} ${side}`).not.toMatch(/Sales|Buyer|Finance|Vendite|Acquisti|Amministrazione/)
      }
  })
})
// ---- end F-CL-101
