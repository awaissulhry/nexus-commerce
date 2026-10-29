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
  partiesCsv,
  partyPatch,
  partyDraftOf,
  recordTabs,
  reasonProblem,
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
    expect(recordTabs(SIDES.customers, can)).toEqual(['overview', 'addresses', 'tax', 'orders', 'documents', 'activity'])
    expect(recordTabs(SIDES.customers, { ...can, quotes: false, orders: false, threads: false })).toEqual(['overview', 'addresses', 'tax'])
    expect(recordTabs(SIDES.suppliers, { ...can, purchaseOrders: false })).toEqual(['overview', 'contacts', 'activity'])
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
  })

  it('exports the view with its words, quoting what needs it', () => {
    const csv = partiesCsv([rowOf(CUSTOMERS[0]!)], { header: ['Code', 'Name'], status: () => 'Active', roles: () => 'Customer', vies: () => 'Not needed', taxMode: () => 'Italian business' })
    expect(csv.split('\r\n')[1]).toBe('MODA-DEMO,Moda Demo S.r.l.,Moda Demo,Customer,Active,IT,Firenze,Italian business,IT00000000000,00000000000,Not needed,it')
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
    for (const file of sources(join(SRC, dir))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) if (!NOT_KEYS.has(match[1]!)) keys.add(match[1]!)
  return [...keys].sort()
}
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
  ...['vies', 'archive'].flatMap((value) => [`bulk.${value}.title`, `bulk.${value}.done`]),
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
      'file',
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
    ...['title', 'go', 'stops1', 'stops2'].map((key) => `${side.side}.block.${key}`),
    ...['titleOne', 'titleMany', 'reach1'].map((key) => `${side.side}.archive.${key}`),
    ...['empty', 'emptyBody', 'addFirst'].map((key) => `${side.side}.contacts.${key}`),
  ]),
]

describe('every string of the four screens exists in it and en (PLAN §4.6)', () => {
  it('every key the code names (literally or from an enum) exists in both catalogues', () => {
    const keys = [...literalKeys(), ...built]
    expect(keys.length).toBeGreaterThan(400)
    expect([...new Set(keys)].filter((key) => !has(key))).toEqual([])
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
      expect(ids(screen)).toEqual(expect.arrayContaining(['loading', 'not-found', 'no-access', 'read-only', 'blocked', 'activity', 'dock']))
  })

  it('a role without the grain sees no amount at all', () => {
    const html = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'quotes-orders-no-price')!.model, 'en')
    expect(html).not.toMatch(/€/)
    const withPrice = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((item) => item.id === 'quotes-orders-all')!.model, 'en')
    expect(withPrice).toMatch(/€/)
    const supplier = render(supplierRecordScreen as DesignScreen<unknown>, supplierRecordScreen.cases.find((item) => item.id === 'orders-no-cost')!.model, 'it')
    expect(supplier).not.toMatch(/€/)
  })
})
