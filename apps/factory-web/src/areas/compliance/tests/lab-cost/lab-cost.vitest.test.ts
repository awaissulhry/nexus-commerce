import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { LOCALES, type Locale } from '../../../../lib/i18n/locales'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as listScreen } from '../fixtures'
import { designScreen as lotScreen } from '../record/fixtures'
import { LabCostField } from './view/LabCostField'
import { BLANK_LAB_COST, costWords, holdsCostGrain, LAB_COST_NAMESPACE, labCostBody, labCostProblem, listHasLabCost, lotCostWords, minorUnitsOf } from './lab-cost'

/** B-W2b-288 (FU2:03) — the lab's price of a result: the rules, and the screens show it to the cost grain only. */

function render(screen: DesignScreen<unknown>, model: unknown, locale: Locale): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'quality', 'lab', LAB_COST_NAMESPACE]) }, createElement(View, { model })))
}

describe('the lab’s price', () => {
  it('reads an amount typed with a comma or a point, at most two decimals, into cents', () => {
    expect(minorUnitsOf('85')).toBe(8500)
    expect(minorUnitsOf('85,5')).toBe(8550)
    expect(minorUnitsOf('85.50')).toBe(8550)
    expect(minorUnitsOf('1.234,50')).toBe(123450)
    expect(minorUnitsOf('1,234')).toBe(123400)
    expect(minorUnitsOf('ottanta')).toBeNull()
    expect(minorUnitsOf('')).toBeNull()
  })

  it('is optional; a wrong one is refused in words; what the API is sent', () => {
    expect(labCostProblem(BLANK_LAB_COST)).toBeNull()
    expect(labCostBody(BLANK_LAB_COST)).toBeNull()
    expect(labCostProblem({ text: 'abc', currency: 'EUR' })).toBe('labCost.problem.amount')
    expect(labCostProblem({ text: '2000000', currency: 'EUR' })).toBe('labCost.problem.tooLarge')
    expect(labCostProblem({ text: '85', currency: 'eu' })).toBe('labCost.problem.currency')
    expect(labCostBody({ text: '85,50', currency: 'EUR' })).toEqual({ cents: 8550, currency: 'EUR' })
  })

  it('is the cost grain’s: the column shows only when the API sent the field', () => {
    expect(holdsCostGrain(['quality.lots.view', 'money.cost'])).toBe(true)
    expect(holdsCostGrain(['quality.lots.view'])).toBe(false)
    expect(listHasLabCost([{}, { labCost: [] }])).toBe(true)
    expect(listHasLabCost([{}, {}])).toBe(false)
    expect(costWords({ cents: 8500, currency: 'EUR' }, 'it')).toMatch(/85,00/)
    expect(lotCostWords([{ currency: 'CHF', cents: 12000, results: 1 }, { currency: 'EUR', cents: 8500, results: 1 }], 'en')).toMatch(/120\.00.*·.*85\.00/)
    expect(lotCostWords([], 'en')).toBeNull()
  })

  it('every word in it and en', () => {
    const keys = ['labCost.field', 'labCost.fieldHint', 'labCost.amount', 'labCost.currency', 'labCost.result', 'labCost.column', 'labCost.problem.amount', 'labCost.problem.tooLarge', 'labCost.problem.currency']
    for (const locale of LOCALES) for (const key of keys) expect(key in (CATALOGUE[locale][LAB_COST_NAMESPACE] ?? {}), `${locale} ${key}`).toBe(true)
  })

  it('the priced cases show the price; without the grain no price, no column', () => {
    const at = (screen: DesignScreen<unknown>, id: string) => screen.cases.find((entry) => entry.id === id)!
    // The grid draws its rows in the browser (no server render): the list's rows decide whether the column shows.
    const rowsOf = (id: string) => ((at(listScreen as DesignScreen<unknown>, id).model as { model: { rows: { value: { labCost?: unknown }[] } } }).model.rows.value)
    expect(listHasLabCost(rowsOf('w2b-288-lab-cost') as never)).toBe(true)
    expect(listHasLabCost(rowsOf('w2b-288-lab-cost-no-grain') as never)).toBe(false)
    // The result read back: its price in the page's language.
    expect(render(lotScreen as DesignScreen<unknown>, at(lotScreen as DesignScreen<unknown>, 'w2b-288-lab-cost-results').model, 'it')).toMatch(/Prezzo del laboratorio.*85,00/s)
    // The dialog's field (a dialog draws in the browser): its words and a refused amount in words, no key left.
    for (const locale of LOCALES) {
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, [LAB_COST_NAMESPACE]) }, createElement(LabCostField, { value: { text: 'ottanta', currency: 'EUR' }, problem: labCostProblem({ text: 'ottanta', currency: 'EUR' }), onChange: () => undefined })))
      expect(html).toContain(locale === 'it' ? 'Prezzo del laboratorio' : 'Lab&#x27;s price')
      expect(html).not.toMatch(/labCost\./)
    }
  })
})
