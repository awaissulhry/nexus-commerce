import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesignScreen } from '../../design/design-screen'
import { LOCALES, type Locale } from '../../i18n/locales'
import { CATALOGUE, messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'

/**
 * Test helpers of the record thread's parts: a view drawn on the server in one language with every catalogue (as the design
 * index draws it), its text without tags, and every case of a design screen in both languages.
 */

export function render(node: ReactNode, locale: Locale = 'en'): string {
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, Object.keys(CATALOGUE[locale])) }, node))
}

export function renderView<M>(view: ComponentType<{ model: M }>, model: M, locale: Locale = 'en'): string {
  return render(createElement(view, { model }), locale)
}

/** The words a reader sees (tags out, entities back, spaces folded). */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every case of a screen, in every language: `[locale, case id, html]`. */
export function everyCase<M>(screen: DesignScreen<M>): Array<[Locale, string, string]> {
  return LOCALES.flatMap((locale) => screen.cases.map((item): [Locale, string, string] => [locale, item.id, renderView(screen.view as ComponentType<{ model: M }>, item.model, locale)]))
}

/** Text that looks like a message key left on screen (`mark.note`, `held.offline`): a missing word. */
export function leftKeys(html: string, prefixes: readonly string[]): string[] {
  const text = textOf(html)
  const pattern = new RegExp(`\\b(?:${prefixes.join('|')})\\.[A-Za-z0-9_.]+`, 'g')
  return [...new Set(text.match(pattern) ?? [])]
}
