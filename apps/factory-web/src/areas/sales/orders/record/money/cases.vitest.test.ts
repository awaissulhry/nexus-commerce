import { readFileSync } from 'node:fs'
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
    for (const id of ['om-short', 'om-dlg-short', 'om-dlg-undo', 'om-accepted-short', 'om-waived-again', 'om-replaced', 'om-extra', 'om-on-invoice', 'om-invoices-sales', 'om-undo-held', 'om-settled', 'om-cancelled', 'om-stop-page', 'om-price-diff', 'om-dlg-accept', 'om-price-accepted', 'om-margin', 'om-dlg-cost', 'om-dlg-target', 'om-failed', 'om-role-owner', 'om-role-finance', 'om-role-sales', 'om-role-manager', 'om-role-readonly', /* F-OM-fx3 (W-27) */ 'om-dlg-deposit', 'om-dlg-move', 'om-dlg-terms', 'om-dlg-add', /* F-OM-fx5w (N1) */ 'om-extra-no-deposit']) expect(OM_CASES, id).toContain(id)
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

  // ---- F-OM-fx3 (fix wave 3): the walk's gaps, seen in the gallery ----
  it('W-01 / W-02: short within the tolerance is "short — probably bank charges" with its hint; over it, "part paid", never short', () => {
    const short = textOf(draw('om-short'))
    expect(short).toContain('short — probably bank charges')
    expect(short).toContain('banks often keep a fee on a transfer')
    expect(short).toContain('Accept short (bank charges)…')
    const part = textOf(draw('om-undo-held'))
    expect(part).toContain('The deposit is part paid')
    expect(part).not.toContain('short — probably')
    expect(part).not.toContain('Accept short')
    expect(part).toContain('TD02 FA-2026-00031 was issued for it')
  })

  it('W-03 / W-05 / W-25: an accepted short leaves its trace; a cancelled order owes nothing; the shipped case is not "everything is paid"', () => {
    const accepted = textOf(draw('om-accepted-short'))
    for (const words of ['Set by hand', 'Bea Esempio', 'stays owed and goes on the final invoice']) expect(accepted, words).toContain(words)
    const cancelled = textOf(draw('om-cancelled'))
    expect(cancelled).toContain('Not owed: the order is cancelled')
    expect(cancelled).toContain('Nothing is owed: the order is cancelled')
    const shipped = textOf(draw('om-on-invoice'))
    expect(shipped).not.toContain('Everything is paid')
    expect(shipped).toContain('Part paid')
    expect(shipped).toContain('Rejected — fix and resend')
  })

  it('W-04: no band notice over the Money tab\'s answer (the cancelled reason, a deposit open)', () => {
    expect(textOf(draw('om-cancelled'))).not.toContain('Il cliente ha ritirato')
    expect(textOf(draw('om-role-owner'))).not.toContain('Deposit open — due')
  })

  it('W-22: the Owner reads Totals\' four tiles and How it adds up; W-23: Waive… is the Owner\'s; W-27: the four hand windows draw', () => {
    const owner = draw('om-role-owner')
    for (const tile of ['Order total · VAT incl.', 'Invoiced', 'Paid', 'Still to pay', 'How it adds up']) expect(textOf(owner), tile).toContain(tile)
    // A DS window never draws on the server: the gallery keeps its own window state on Money (a ⋯ item opens, Escape closes).
    const gallery = readFileSync(new URL('../fixtures.ts', import.meta.url), 'utf8')
    expect(gallery).toContain("if (model.record.tab === 'money') return inShell(path, createElement(MoneyDesign, { record: model.record, thread, customFields }), model.role)")
    expect(gallery).toContain('actions: { onDialog: setDialog }')
  })

  // ---- F-OM-fx5w (fix wave 4, the walk 31-A's N1): no deposit needed, a priced change's extra deposit open ----
  it('N1: the head, Totals and Payments agree — the extra deposit is money to collect, production does not wait for it', () => {
    const text = textOf(draw('om-extra-no-deposit'))
    expect(text).toContain('open (change rev 1)')
    expect(text).toContain('Not needed · extra')
    expect(text).toContain('next: the extra deposit')
    expect(text).not.toContain('Nothing to collect yet')
    expect(text).not.toContain('New work orders wait for it')
    expect(text).not.toContain('production waits for it')
  })
})
