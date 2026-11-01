import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CONFIRM_PHRASE_FIELD_LABELS, DATE_FIELD_LABELS } from '@nexus/ui/components'
import { EDIT_MODE_BAR_LABELS } from '@nexus/ui/patterns'
import { ConfirmPhraseField, DateField, dsWordsFor, EditModeBar, Textarea } from './ds-parts'
import type { Locale } from './locales'
import { I18nProvider } from './provider'

/**
 * B-W2b-18 — the DS speaking parts wired to the `ds-words` catalogue once (`lib/i18n/ds-parts`): a screen that imports
 * them from here speaks the page's language with no catalogue provider of its own, its own words still win, and an
 * English page reads the DS's own English.
 */
const page = (locale: Locale, node: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, node))

describe('the DS parts in the page’s language', () => {
  it('reads the words from the catalogue by language (no provider needed), English = the DS English', () => {
    expect(dsWordsFor('en').editModeBar.discard).toBe(EDIT_MODE_BAR_LABELS.discard)
    expect(dsWordsFor('it').editModeBar.discard).not.toBe(EDIT_MODE_BAR_LABELS.discard)
    expect(dsWordsFor('it')).toBe(dsWordsFor('it'))
  })

  it('draws an Italian page in Italian and an English page in the DS English', () => {
    const bar = createElement(EditModeBar, { count: 2, onDiscard: () => undefined, onApply: () => undefined })
    const it = page('it', bar)
    expect(it).toContain(dsWordsFor('it').editModeBar.discard)
    expect(it).not.toContain(`>${EDIT_MODE_BAR_LABELS.discard}<`)
    expect(page('en', bar)).toContain(`>${EDIT_MODE_BAR_LABELS.discard}<`)
    const phrase = createElement(ConfirmPhraseField, { phrase: 'CNT-1', value: '', onChange: () => undefined })
    expect(page('it', phrase)).toContain(dsWordsFor('it').confirmPhrase.states.empty)
    expect(page('en', phrase)).toContain(CONFIRM_PHRASE_FIELD_LABELS.states.empty)
  })

  it('keeps the screen’s own words over the catalogue’s, key by key', () => {
    const html = page('it', createElement(EditModeBar, { count: 1, onDiscard: () => undefined, labels: { discard: 'Lascia stare' } }))
    expect(html).toContain('Lascia stare')
    expect(html).toContain(dsWordsFor('it').editModeBar.region)
  })

  it('draws the date field in the language (its empty word; the month names from the language’s locale)', () => {
    const it = page('it', createElement(DateField, { value: '', onChange: () => undefined }))
    expect(it).toContain(dsWordsFor('it').dateField.notSet)
    expect(it).not.toContain(DATE_FIELD_LABELS.notSet)
  })

  it('counts a text box over its limit in the language’s words', () => {
    const over = (locale: Locale) => page(locale, createElement(Textarea, { value: 'x'.repeat(12), onChange: () => undefined, limit: 10 }))
    expect(over('it')).toContain(String(dsWordsFor('it').textarea.tooLong(2)))
    expect(over('en')).toContain(String(dsWordsFor('en').textarea.tooLong(2)))
    expect(String(dsWordsFor('it').textarea.tooLong(2))).not.toBe(String(dsWordsFor('en').textarea.tooLong(2)))
  })
})
