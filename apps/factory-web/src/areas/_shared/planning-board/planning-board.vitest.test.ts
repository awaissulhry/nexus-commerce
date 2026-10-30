import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOAD_BAR_WORDS, PLANNING_BOARD_WORDS } from '@nexus/ui/patterns/planning-board/index'
import { I18nProvider } from '../../../lib/i18n/provider'
import { createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { designScreen } from './fixtures'
import { PlanningBoardLabView } from './view/PlanningBoardLabView'
import { BOARD_KIT_NAMESPACE, BOARD_WORD_KEYS, LOAD_WORD_KEYS, boardWordsOf, loadWordsOf } from './words'

describe('board-kit words (DS planning board, D18)', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale, messagesFor(locale, [BOARD_KIT_NAMESPACE])[BOARD_KIT_NAMESPACE] ?? {})

    it(`${locale}: every word the board and the load bar take, with the DS's own placeholders`, () => {
      const board = boardWordsOf(t)
      for (const key of BOARD_WORD_KEYS) {
        expect(board[key], key).not.toBe(`board.${key}`)
        expect(placeholdersOf(board[key]), key).toEqual(placeholdersOf(PLANNING_BOARD_WORDS[key]))
      }
      const load = loadWordsOf(t)
      for (const key of LOAD_WORD_KEYS) {
        expect(load[key], key).not.toBe(`load.${key}`)
        expect(placeholdersOf(load[key]), key).toEqual(placeholdersOf(LOAD_BAR_WORDS[key]))
      }
    })
  }
})

describe('SCR-243 design cases', () => {
  it('every state the design names is a case', () => {
    expect(designScreen.screen).toBe('SCR-243')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['week', 'over', 'moving', 'held', 'allocation', 'list', 'empty', 'loading', 'error', 'read-only', 'offline', 'load-bars'])
  })

  it('draws in Italian with no key on screen and Italian numbers and days', () => {
    for (const item of designScreen.cases) {
      const out = render(h(I18nProvider, { locale: 'it', messages: {} }, h(PlanningBoardLabView, { model: item.model })))
      expect(out, item.id).not.toMatch(/board\.|load\.|lab\./)
      if (item.id === 'week') {
        expect(out).toContain('Tabellone di pianificazione')
        expect(out).toContain('lun 7 dic')
        expect(out).toContain('Chiuso: Immacolata Concezione')
        expect(out).toContain('Non pianificati')
        expect(out).toContain('Linea · 8 persone · efficienza 80%')
      }
      if (item.id === 'over') expect(out).toContain('+405 min oltre')
      if (item.id === 'error') expect(out).toContain('Impossibile caricare la pianificazione')
    }
  })

  it('draws in English', () => {
    const out = render(h(I18nProvider, { locale: 'en', messages: {} }, h(PlanningBoardLabView, { model: designScreen.cases[1]!.model })))
    expect(out).toContain('Mon 7 Dec')
    expect(out).toContain('+405 min over')
    expect(out).toContain('Line 2, Wed 9 Dec: 2,700 of 2,295 min booked, 118%, 405 min over capacity.')
  })
})
