import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { designScreen } from '../fixtures'

/**
 * F-OM T.1 (order MONEY tab, 15-steps T.1) — the gallery cases for the money states the seed lacks (SCR-039, ids `om-…`): each draws
 * in both languages with no key left on screen; the roles on ONE order keep the money wall (Sales, the Production manager and Read-only
 * read words, never an amount); and the states say what they are. Every name and number is made up.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => renderView(view, caseOf(id)!.model, locale)
const OM_CASES = designScreen.cases.filter((item) => item.id.startsWith('om-')).map((item) => item.id)
/** An amount on screen: a currency sign or a figure with cents. */
const AMOUNT = /€|EUR|\d[.,]\d{2}\b/

describe('F-OM T.1: the Money lane\'s gallery cases', () => {
  it('the states the seed lacks are all there (15-steps T.1; not the Simple company)', () => {
    for (const id of ['om-short', 'om-dlg-short', 'om-dlg-undo', 'om-accepted-short', 'om-waived-again', 'om-replaced', 'om-extra', 'om-on-invoice', 'om-invoices-sales', 'om-undo-held', 'om-settled', 'om-cancelled', 'om-stop-page', 'om-price-diff', 'om-dlg-accept', 'om-price-accepted', 'om-margin', 'om-dlg-cost', 'om-dlg-target', 'om-failed', 'om-role-owner', 'om-role-finance', 'om-role-sales', 'om-role-manager', 'om-role-readonly']) expect(OM_CASES, id).toContain(id)
  })

  for (const locale of LOCALES) {
    it(`${locale}: every case draws its Money tab with no key left on screen`, () => {
      for (const id of OM_CASES) {
        const html = draw(id, locale)
        expect(html, id).toContain('class="fw-pt fw-om"')
        expect(leftKeys(html, ['moneyTab', 'priceCheck', 'money', 'deposit', 'schedule', 'settlement', 'invoiceStatus', 'docType']), `${id} (${locale})`).toEqual([])
      }
    })
  }

  it('the roles on ONE order: Sales, the Production manager and Read-only read words, never an amount, and no Price check or Margin', () => {
    for (const id of ['om-role-sales', 'om-role-manager', 'om-role-readonly', 'om-invoices-sales']) {
      const html = draw(id)
      expect(textOf(html), id).not.toMatch(AMOUNT)
      expect(html, id).not.toContain('id="price-check"')
      expect(html, id).not.toContain('id="margin"')
    }
    // The Owner and Finance read the amounts, the Price check and the Margin.
    for (const id of ['om-role-owner', 'om-role-finance']) {
      const html = draw(id)
      expect(textOf(html), id).toMatch(AMOUNT)
      expect(html, id).toContain('id="price-check"')
      expect(html, id).toContain('id="margin"')
    }
  })

  it('each state says what it is', () => {
    expect(textOf(draw('om-extra'))).toContain('Extra deposit')
    expect(textOf(draw('om-replaced'))).toContain('Set by hand')
    expect(textOf(draw('om-on-invoice'))).toContain('Credit note')
    expect(textOf(draw('om-invoices-sales'))).toContain('Part paid')
    expect(textOf(draw('om-cancelled'))).toContain('nothing more is owed')
    expect(textOf(draw('om-price-accepted'))).toContain('Accepted by hand')
    expect(textOf(draw('om-price-accepted'))).toContain('Bea Esempio')
    const margin = textOf(draw('om-margin'))
    for (const words of ['Based on: cost at quote', 'rev 2', 'Commission', 'Target', 'From the shipments']) expect(margin, words).toContain(words)
    const failed = textOf(draw('om-failed'))
    expect(failed).toContain('Part of the money could not be read')
    expect(failed).not.toContain('Nothing to collect')
    expect(failed).toContain('Try again')
  })
})
