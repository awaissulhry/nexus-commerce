import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { REASON_GRID_WORDS } from '@nexus/ui/floor/ReasonGrid/index'
import { I18nProvider } from '../../lib/i18n/provider'
import { createTranslator, messagesFor, placeholdersOf } from '../../lib/i18n/messages'
import { LOCALES } from '../../lib/i18n/locales'
import { REASON_KIT_NAMESPACE, REASON_WORD_KEYS, reasonWordsOf } from '../../lib/ds-words/reason-grid'
import { designScreen } from './fixtures'
import { ReasonGridLabView } from './view/ReasonGridLabView'

describe('reason-kit words (DS reason grid, D20)', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale, messagesFor(locale, [REASON_KIT_NAMESPACE])[REASON_KIT_NAMESPACE] ?? {})

    it(`${locale}: every word the reason grid takes, with the DS's own placeholders`, () => {
      const words = reasonWordsOf(t)
      for (const key of REASON_WORD_KEYS) {
        expect(words[key], key).not.toBe(`reasons.${key}`)
        expect(placeholdersOf(words[key]), key).toEqual(placeholdersOf(REASON_GRID_WORDS[key]))
      }
    })
  }
})

describe('SCR-246 design cases', () => {
  it('every state the design names is a case', () => {
    expect(designScreen.screen).toBe('SCR-246')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['pick', 'picked', 'count', 'more', 'held', 'photos', 'symptom', 'empty'])
  })

  it('draws in Italian with no key on screen', () => {
    for (const item of designScreen.cases) {
      const out = render(h(I18nProvider, { locale: 'it', messages: {} }, h(ReasonGridLabView, { model: item.model })))
      expect(out, item.id).not.toMatch(/reasons\.|lab\./)
      if (item.id === 'pick') {
        expect(out).toContain('Perché ti sei fermato?')
        expect(out).toContain('Macchina guasta')
        expect(out).toContain('Prima scegli un motivo')
      }
      if (item.id === 'count') {
        expect(out).toContain('Contati in tutto: 3')
        expect(out).toContain('Togli uno da Foro')
      }
      if (item.id === 'more') {
        expect(out).toContain('Pagina 2 di 2')
        expect(out).toContain('Serve una foto')
      }
      if (item.id === 'held') expect(out).toContain('Non controllato in questa postazione')
      if (item.id === 'empty') expect(out).toContain('Nessun motivo impostato per questa postazione.')
    }
  })

  it('draws in English', () => {
    const out = render(h(I18nProvider, { locale: 'en', messages: {} }, h(ReasonGridLabView, { model: designScreen.cases[2]!.model })))
    expect(out).toContain('Defects in this bundle')
    expect(out).toContain('aria-label="Hole, 2"')
    expect(out).toContain('Counted in all: 3')
    expect(out).toContain('More reasons')
  })
})
