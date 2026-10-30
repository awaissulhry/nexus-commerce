import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_ROWS } from '../pricelists/_demo/fixtures'
import { BLANK_TERMS, demoCustomersImport, PAYMENT_TERMS, TERMS } from './_demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import { importHeldOf } from './import/CustomersImport'
import { CustomersImportView } from './import/view/CustomersImportView'
import { chainText, listChoices, minorOf, termsAbilitiesOf, termsChoices, termsDraftOf, termsHeld, termsPatch, termsProblems } from './terms/model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * B-W2a-49 on the W1 customer screens: Customer › Tax & terms › Commercial terms (SAL-012; the library's payment terms,
 * the price list, the defaults new quotes and orders take) and Customers › Import (the customers and suppliers importer).
 * The W1 tests (parties/_shared/parties.vitest.test.ts) stay as they were.
 */

const owner = termsAbilitiesOf(['parties.view', 'parties.manage', 'paymentterms.view', 'pricelists.view', 'pricelists.manage', 'money.price'])

describe('Commercial terms: who may change them, and why not', () => {
  it('customers only; archived and view-only roles are held in words', () => {
    expect(termsHeld({ status: 'ACTIVE', roles: ['CUSTOMER'] }, owner)).toBeNull()
    expect(termsHeld({ status: 'ACTIVE', roles: ['SUPPLIER'] }, owner)).toBe('terms.held.notCustomer')
    expect(termsHeld({ status: 'ARCHIVED', roles: ['CUSTOMER'] }, owner)).toBe('terms.held.archived')
    expect(termsHeld({ status: 'ACTIVE', roles: ['CUSTOMER'] }, { ...owner, manage: false })).toBe('terms.held.noManage')
  })
})

describe('Commercial terms: the form sends only what changed', () => {
  const before = termsDraftOf(TERMS)
  it('reads the terms into the form (minimum order as typed, in the currency)', () => {
    expect(before).toMatchObject({ currency: 'EUR', paymentTermsId: PAYMENT_TERMS[0]!.id, incoterm: 'DAP', preferredCarrierCode: 'BRT', minimumOrder: '500.00', invoiceTiming: 'MONTHLY' })
  })
  it('a typed amount in either language is minor units; a field emptied is null', () => {
    expect(minorOf('1.250,50')).toBe(125050)
    expect(minorOf('500')).toBe(50000)
    expect(minorOf('12.345')).toBeNull()
    expect(termsPatch(before, { ...before, minimumOrder: '1.250,50', incoterm: '', preferredCarrierCode: ' gls ' }, owner)).toEqual({ minimumOrderAmount: 125050, incoterm: null, preferredCarrierCode: 'gls' })
    expect(termsPatch(before, before, owner)).toEqual({})
  })
  it('a price list only with pricelists.manage; the minimum order only with the price grain', () => {
    const after = { ...before, priceListId: '', minimumOrder: '' }
    expect(termsPatch(before, after, owner)).toEqual({ priceListId: null, minimumOrderAmount: null })
    expect(termsPatch(before, after, { ...owner, listsManage: false, price: false })).toEqual({})
  })
  it('checks the fields before Save', () => {
    expect(termsProblems({ ...before, defaultDepositPct: '130', currency: 'EU', minimumOrder: 'x' })).toEqual({ defaultDepositPct: 'terms.problem.deposit', currency: 'terms.problem.currency', minimumOrder: 'terms.problem.minimum' })
    expect(termsProblems(before)).toEqual({})
  })
  it("offers the library's active terms and the active lists in the customer's currency (its own stays offered)", () => {
    expect(termsChoices(PAYMENT_TERMS, TERMS).map((row) => row.code)).toEqual(['DEP30', 'BB60', 'CONSEGNA'])
    expect(termsChoices([], TERMS).map((row) => row.code)).toEqual(['DEP30'])
    expect(listChoices(LIST_ROWS, TERMS, 'EUR').map((row) => row.code)).toEqual(['BASE-EUR', 'MODA-DEMO', 'GRUPPO-DEALER', 'FIERA-2027', 'ESEMPIO-2025'])
    expect(listChoices(LIST_ROWS, BLANK_TERMS, 'CHF').map((row) => row.code)).toEqual(['PROVA-CH'])
    expect(chainText(TERMS)).toBe('MODA-DEMO → BASE-EUR')
  })
})

describe('Customers › Import: held with its reason, the parties importer', () => {
  it('needs parties.manage, imports.run and files.upload', () => {
    expect(importHeldOf(['parties.manage', 'imports.run', 'files.upload'])).toBeNull()
    expect(importHeldOf(['imports.run', 'files.upload'])).toBe('import.held.manage')
    expect(importHeldOf(['parties.manage', 'imports.run'])).toBe('import.held.run')
  })
  it('the wizard names the customers and suppliers importer in both languages, at every step', () => {
    for (const locale of LOCALES) {
      for (const step of ['upload', 'planned', 'applied'] as const) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(CustomersImportView, { model: { held: null, sheet: demoCustomersImport(step), inline: true } })))
        expect(html.match(/\b(?:imp|import)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/)?.[0] ?? null, `${step} (${locale})`).toBeNull()
        expect(html).toContain(locale === 'it' ? 'Importa' : 'Import')
      }
    }
  })
})

const LEFT_KEY = /\b(?:terms|termsField|import|incoterm|invoicing|language|imp|problem|kind|common)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const render = (view: ComponentType<{ model: unknown }>, model: unknown, locale: (typeof LOCALES)[number]) =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(view, { model })))

describe('every W2a design case of SCR-032 and SCR-033 draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      const cases = screen.cases.filter((item) => item.label.startsWith('W2a'))
      it(`${screen.screen} in ${locale}: ${cases.length} W2a cases`, () => {
        expect(cases.length).toBeGreaterThan(5)
        for (const item of cases) {
          const html = render(screen.view as ComponentType<{ model: unknown }>, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/[\w.-]+@example\.com/g, '')
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
  it('the Commercial terms card says the terms in words, with the minimum order only with the price grain', () => {
    const terms = recordScreen.cases.find((item) => item.id === 'terms')!
    const noPrice = recordScreen.cases.find((item) => item.id === 'terms-no-price')!
    const en = render(recordScreen.view as ComponentType<{ model: unknown }>, terms.model, 'en')
    expect(en).toContain('Commercial terms')
    expect(en).toContain('30 % with the order (at once)')
    expect(en).toContain('MODA-DEMO → BASE-EUR')
    expect(en).toContain('€500.00')
    expect(render(recordScreen.view as ComponentType<{ model: unknown }>, noPrice.model, 'en')).not.toContain('€500.00')
    expect(render(recordScreen.view as ComponentType<{ model: unknown }>, terms.model, 'it')).toContain('Condizioni commerciali')
  })
})
