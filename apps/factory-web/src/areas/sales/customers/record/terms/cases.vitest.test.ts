import { type ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { designScreen } from '../fixtures'
import { CT_CASES, CT_PARTS } from './_demo/fixtures'

/**
 * F-CT T.1 / T.2 (customer page › TERMS & REQUIREMENTS tab, lane ct- ct-t; 15-steps T.1, T.2) — the gallery's `ct-*` cases of SCR-033:
 * all there, each drawing the Terms & requirements tab in both languages with no key and no placeholder left on screen, split per
 * language and per part (a long gallery test is split: the lessons list), and each state saying what it is, in English and in Italian.
 * A window's case draws the tab and the window's inside on a plain card: no Modal and no Menu open on the server render.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)
const draw = (id: string, locale: Locale = 'en') => renderView(view, caseOf(id)!.model, locale)
const words = (id: string, locale: Locale = 'en') => textOf(draw(id, locale))
const CT_IDS = designScreen.cases.filter((item) => item.id.startsWith('ct-')).map((item) => item.id)
const EMAIL = /[\w.+-]+@[\w.-]+/g
/** The key prefixes the tab says words from (its own catalogue and the words it reuses): none may be left on screen. */
const KEYS = ['ct', 'terms', 'termsField', 'invoicing', 'hold', 'reason', 'req', 'po', 'kind', 'stage', 'cm', 'common', 'problem', 'part', 'identity', 'vies', 'taxMode', 'field', 'held', 'warning', 'customers']

describe('F-CT T.1: the Terms & requirements tab\'s gallery cases (SCR-033, ids ct-*)', () => {
  it('every case of 15-steps T.1 is there, once, and no other ct-* case', () => {
    expect([...CT_IDS].sort()).toEqual(Object.values(CT_PARTS).flat().sort())
    expect(new Set(CT_IDS).size).toBe(CT_IDS.length)
    expect(CT_CASES.map((item) => item.id).sort()).toEqual([...CT_IDS].sort())
    expect(CT_IDS).toHaveLength(50) // 8 customers · a sole trader × 6 roles · 4 states · 6 roles · 7 reading · 7 failed · 4 rooms · 8 windows
  })

  for (const locale of LOCALES) {
    for (const [part, ids] of Object.entries(CT_PARTS)) {
      it(`${locale} · ${part}: each case draws the tab with no key and no placeholder left on screen`, () => {
        expect(ids.length, part).toBeGreaterThan(0)
        for (const id of ids) {
          const html = draw(id, locale)
          expect(html, id).toContain('class="fw-pt fw-ctr"')
          expect(leftKeys(html.replace(EMAIL, ''), KEYS), `${id} (${locale})`).toEqual([])
          expect(textOf(html).match(/\{[a-zA-Z]+\}/)?.[0] ?? null, `${id} (${locale}) placeholder`).toBeNull()
          // never a Modal or a Menu open on the server render
          expect(html, id).not.toMatch(/role="dialog"|role="menu"/)
        }
      })
    }
  }

  it('the busy brand draws every section, each at its address, Hold first (Z10)', () => {
    const html = draw('ct-busy')
    const at = ['party-hold', 'party-commercial', 'party-requirements', 'party-identity'].map((id) => html.indexOf(`id="${id}"`))
    for (const index of at) expect(index).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  /** What each state says, in English and in Italian (the catalogues' own words, filled). */
  const STATES: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ['ct-new', ['No special requirements.', 'No tax identity yet'], ['Nessun requisito particolare.', 'Ancora nessuna identità fiscale']],
    ['ct-held', ['Q-2026-0131', 'Q-2026-0134'], ['Q-2026-0131', 'Q-2026-0134']],
    ['ct-two-companies', ['Seed Company A', 'Seed Company B', 'Bank transfer 60 days'], ['Seed Company A', 'Seed Company B', 'Bonifico 60 gg']],
    ['ct-eu-no-answer', ['No answer'], ['Senza risposta']],
    ['ct-eu-ends', ['3 days left'], ['mancano 3 giorni']],
    ['ct-many', ['Show 2 more requirements', 'Ended and replaced (3)'], ['Mostra altri 2 requisiti', 'Terminati e sostituiti (3)']],
    ['ct-busy', ['a style no longer offered', 'Printed on the delivery note (DDT)', 'Routing guide demo.pdf'], ['un modello non più offerto', 'Stampato sul documento di trasporto (DDT)', 'Routing guide demo.pdf']],
  ]
  for (const locale of LOCALES) {
    it(`${locale}: each state says what it is`, () => {
      for (const [id, en, it_] of STATES) for (const phrase of locale === 'en' ? en : it_) expect(words(id, locale), `${id} (${locale})`).toContain(phrase)
    })
  }

  it('the rooms: each case says its width; the windows: each inside drawn on a plain card under the tab', () => {
    for (const room of [343, 865, 1314, 1794]) expect(draw(`ct-room-${room}`), String(room)).toContain(`data-ct-room="${room}"`)
    // Each window's inside says its own title (the window's words) on its card — the tab alone never says them.
    const TITLES: Readonly<Record<string, string>> = {
      'ct-win-terms': 'Change the terms of Seed Brand',
      'ct-win-terms-problems': 'Change the terms of Seed Brand',
      'ct-win-terms-refused': 'Change the terms of Seed Brand',
      'ct-win-delivery': 'Change the delivery of Seed Brand',
      'ct-win-delivery-replace': 'Change the delivery of Seed Brand',
      'ct-win-company': 'Set terms for Seed Company A',
      'ct-win-company-po': 'Customer PO number',
      'ct-win-end': 'Back to the customer\'s terms with Seed Company A?',
    }
    expect(Object.keys(TITLES).sort()).toEqual([...CT_PARTS.windows].sort())
    for (const [id, title] of Object.entries(TITLES)) expect(words(id), id).toContain(title)
    expect(words('ct-busy')).not.toContain('Change the terms of Seed Brand')
  })
})
