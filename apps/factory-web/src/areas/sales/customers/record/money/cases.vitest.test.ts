import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { designScreen } from '../fixtures'

/**
 * F-CM T.1 (customer page › MONEY tab, cm-t; 15-steps T.1) — the gallery's `cm-*` cases of SCR-033: all there, each drawing the Money tab
 * in both languages with no key left on screen, split per language and per part (a long gallery test, Z: the lessons list), and each
 * state saying what it is. A window's case draws the tab under it: its DS Modal draws once hydrated, never on the server render.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => renderView(view, caseOf(id)!.model, locale)
const CM_IDS = designScreen.cases.filter((item) => item.id.startsWith('cm-')).map((item) => item.id)
/** The catalogues' key prefixes the tab says words from: none may be left on screen. */
const KEYS = ['cm', 'moneyTab', 'tab', 'priceCheck', 'credit', 'hold', 'reason', 'stops', 'heldReason', 'switch', 'col', 'level', 'action', 'termsField', 'invoicing', 'recordPay', 'warning', 'problem']

const PARTS = {
  picture: ['cm-busy', 'cm-late-hold', 'cm-on-account', 'cm-nothing', 'cm-new', 'cm-two-currencies', 'cm-prices-margin', 'cm-stops', 'cm-elsewhere', 'cm-reminders-off'],
  reading: ['cm-reading-page', 'cm-reading-tab', 'cm-reading-sections'],
  failed: ['cm-failed-page', 'cm-failed-tab', 'cm-failed-invoices', 'cm-failed-payments', 'cm-failed-credit', 'cm-failed-statement', 'cm-failed-price', 'cm-failed-margin'],
  rights: ['cm-no-payments', 'cm-role-owner', 'cm-role-finance', 'cm-role-sales', 'cm-role-readonly'],
  rooms: ['cm-room-343', 'cm-room-865', 'cm-room-1314'],
  windows: ['cm-win-door-reading', 'cm-win-door-held', 'cm-win-limit-change', 'cm-win-limit-set', 'cm-win-statement', 'cm-win-statement-send', 'cm-win-refund', 'cm-win-refund-move', 'cm-win-hold-place', 'cm-win-hold-release'],
} as const

describe('F-CM T.1: the Money tab\'s gallery cases (SCR-033, ids cm-*)', () => {
  it('every case of 15-steps T.1 is there, and no other cm-* case', () => {
    expect([...CM_IDS].sort()).toEqual(Object.values(PARTS).flat().sort())
  })

  for (const locale of LOCALES) {
    for (const [part, ids] of Object.entries(PARTS)) {
      it(`${locale} · ${part}: each case draws the Money tab with no key left on screen`, () => {
        for (const id of ids) {
          const html = draw(id, locale)
          expect(html, id).toContain('class="fw-pt fw-om fw-cm"')
          expect(leftKeys(html, KEYS), `${id} (${locale})`).toEqual([])
        }
      })
    }
  }

  it('the busy customer draws every section, each at its address (Z18)', () => {
    const html = draw('cm-busy')
    for (const id of ['balance', 'collect', 'invoices', 'received', 'credit', 'statement', 'price-check', 'margin']) expect(html, id).toContain(`id="${id}"`)
  })

  it('each state says what it is', () => {
    expect(textOf(draw('cm-late-hold'))).toContain('On hold')
    expect(textOf(draw('cm-late-hold'))).toContain('2 orders wait for a yes')
    expect(textOf(draw('cm-stops'))).toContain('Stops in force · 2')
    expect(textOf(draw('cm-reminders-off'))).toContain('Reminders are switched off for this company')
    expect(textOf(draw('cm-prices-margin'))).toContain('Prices differ on 3 orders')
    expect(textOf(draw('cm-prices-margin'))).toContain('2 below the floor')
    expect(textOf(draw('cm-two-currencies'))).toContain('Its orders are in two currencies: no one figure is honest.')
    expect(textOf(draw('cm-reading-sections'))).toContain('Reading the credit and the terms…')
    for (const id of PARTS.failed) expect(textOf(draw(id)), id).toContain('Try again')
    // No payments.view: To collect and Payments & refunds are left out (never 0).
    const blind = draw('cm-no-payments')
    expect(blind).not.toContain('id="collect"')
    expect(blind).not.toContain('id="received"')
  })

  it('the rooms: the tab is laid out in the room it has (343 / 865 / 1314 px)', () => {
    for (const room of [343, 865, 1314]) expect(draw(`cm-room-${room}`), String(room)).toContain(`data-cm-room="${room}"`)
  })

  it('a window\'s case never draws a Modal on the server render: the tab is there, the window draws once hydrated', () => {
    const dialogs = (html: string) => html.split('role="dialog"').length
    const page = dialogs(draw('cm-busy'))
    for (const id of PARTS.windows) expect(dialogs(draw(id)), id).toBe(page)
  })
})
