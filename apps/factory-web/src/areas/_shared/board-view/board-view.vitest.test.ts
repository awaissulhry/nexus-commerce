import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BOARD_VIEW_WORDS } from '@nexus/ui/grid/views/board/index'
import { I18nProvider } from '../../../lib/i18n/provider'
import { createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { designScreen } from './fixtures'
import { BoardViewLabView } from './view/BoardViewLabView'
import { BOARD_VIEW_KIT_NAMESPACE, BOARD_VIEW_WORD_KEYS, boardViewWordsOf } from './words'

describe('boardview-kit words (DS board view, D19)', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale, messagesFor(locale, [BOARD_VIEW_KIT_NAMESPACE])[BOARD_VIEW_KIT_NAMESPACE] ?? {})

    it(`${locale}: every word the board view takes, with the DS's own placeholders`, () => {
      const words = boardViewWordsOf(t)
      for (const key of BOARD_VIEW_WORD_KEYS) {
        expect(words[key], key).not.toBe(`board.${key}`)
        expect(placeholdersOf(words[key]), key).toEqual(placeholdersOf(BOARD_VIEW_WORDS[key]))
      }
    })
  }
})

describe('SCR-244 design cases', () => {
  it('every state the design names is a case', () => {
    expect(designScreen.screen).toBe('SCR-244')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['ncr', 'holds', 'moving', 'refused', 'closing', 'list', 'loading', 'error', 'empty', 'filtered', 'no-permission', 'read-only', 'offline'])
  })

  it('draws in Italian with no key on screen and Italian numbers', () => {
    for (const item of designScreen.cases) {
      const out = render(h(I18nProvider, { locale: 'it', messages: {} }, h(BoardViewLabView, { model: item.model })))
      expect(out, item.id).not.toMatch(/board\.|lab\./)
      if (item.id === 'ncr') {
        expect(out).toContain('Non conformità')
        expect(out).toContain('Contenute')
        expect(out).toContain('6 schede')
        expect(out).toContain('La più vecchia: 12 giorni')
        expect(out).toContain('37 di 40 capi decisi')
        expect(out).toContain('Scade tra 2 giorni')
        expect(out).toContain('Sposta in…')
      }
      if (item.id === 'refused') {
        expect(out).toContain('Non si può rilasciare qui: 3 di 40 capi non decisi')
        expect(out).toContain('Solo i responsabili qualità chiudono una non conformità')
        expect(out).toContain('In attesa della firma di chiusura')
      }
      if (item.id === 'holds') expect(out).toContain('HLD-0031')
      if (item.id === 'error') expect(out).toContain('Impossibile caricare le non conformità')
      if (item.id === 'offline') expect(out).toContain('Offline: questa è l’ultima copia')
    }
  })

  it('draws in English', () => {
    const out = render(h(I18nProvider, { locale: 'en', messages: {} }, h(BoardViewLabView, { model: designScreen.cases[0]!.model })))
    expect(out).toContain('Nonconformances')
    expect(out).toContain('NCR-0108 in Open. Seam opens at the armour pocket. Severity: Major. Owner: Quality. Customer complaint')
    expect(out).toContain('Overdue by 1 day<')
    expect(out).toContain('Due in 2 days')
  })
})
