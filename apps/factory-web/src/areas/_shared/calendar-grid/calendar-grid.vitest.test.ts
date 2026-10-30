import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CALENDAR_GRID_WORDS } from '@nexus/ui/components/CalendarGrid/index'
import { I18nProvider } from '../../../lib/i18n/provider'
import { createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { designScreen } from './fixtures'
import { CalendarGridLabView } from './view/CalendarGridLabView'
import { CALENDAR_KIT_NAMESPACE, CALENDAR_WORD_KEYS, calendarWordsOf } from './words'

describe('calendar-kit words (DS calendar grid)', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale, messagesFor(locale, [CALENDAR_KIT_NAMESPACE])[CALENDAR_KIT_NAMESPACE] ?? {})

    it(`${locale}: every word the calendar takes, with the DS's own placeholders`, () => {
      const words = calendarWordsOf(t)
      for (const key of CALENDAR_WORD_KEYS) {
        expect(words[key], key).not.toBe(`calendar.${key}`)
        expect(placeholdersOf(words[key]), key).toEqual(placeholdersOf(CALENDAR_GRID_WORDS[key]))
      }
    })
  }
})

const draw = (locale: 'it' | 'en', index: number) => render(h(I18nProvider, { locale, messages: {} }, h(CalendarGridLabView, { model: designScreen.cases[index]!.model })))
const caseAt = (id: string) => designScreen.cases.findIndex((item) => item.id === id)

describe('SCR-245 design cases', () => {
  it('every state the design names is a case', () => {
    expect(designScreen.screen).toBe('SCR-245')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['month', 'year', 'exceptions', 'range', 'empty', 'loading', 'error', 'read-only', 'list'])
  })

  it('draws in Italian with no key on screen, Italian months and weekdays', () => {
    designScreen.cases.forEach((item, index) => {
      const out = draw('it', index)
      expect(out, item.id).not.toMatch(/calendar\.|lab\./)
      if (item.id === 'month') {
        expect(out).toContain('Agosto 2026')
        expect(out).toContain('abbr="lunedì"')
        expect(out).toContain('aria-label="Sabato 15 agosto 2026, Festività: Ferragosto"')
        expect(out).toContain('aria-label="Martedì 4 agosto 2026, Giorno lavorativo. Oggi"')
        expect(out).toContain('Chiusura: 10 giorni')
        expect(out).toContain('Legenda')
      }
      if (item.id === 'year') expect(out).toContain('aria-label="Apri dicembre 2026"')
      if (item.id === 'range') expect(out).toContain('Selezionati da lunedì 28 dicembre a giovedì 31 dicembre (4 giorni)')
      if (item.id === 'empty') expect(out).toContain('vale quello predefinito del sito')
      if (item.id === 'error') expect(out).toContain('Impossibile caricare calendari e turni')
      if (item.id === 'read-only') expect(out).toContain('serve il permesso Impostazioni di pianificazione')
      if (item.id === 'list') expect(out).toContain('Giorni diversi dalla settimana tipo')
    })
  })

  it('draws in English', () => {
    const out = draw('en', caseAt('exceptions'))
    expect(out).toContain('December 2026')
    expect(out).toContain('aria-label="Saturday, 5 December 2026, Extra shift: Winter order peak. 06:00–12:00"')
    expect(out).toContain('aria-label="Wednesday, 16 December 2026, Line closed: Machine overhaul"')
    expect(out).toMatch(/data-cal-date="2026-12-16"[^>]*data-tone="danger"[^>]*data-pattern="outline"/)
    expect(out).toContain('Public holiday: 3 days')
  })

  it('the loading case draws the closures first and skeletons for the rest', () => {
    const out = draw('en', caseAt('loading'))
    expect(out).toContain('aria-label="Monday, 10 August 2026, Closure: Summer closure"')
    expect(out).toContain('aria-label="Monday, 3 August 2026"')
    expect(out).toContain('nds-skeleton')
  })
})
