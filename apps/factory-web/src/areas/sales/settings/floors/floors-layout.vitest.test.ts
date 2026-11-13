import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen } from './fixtures'

/**
 * B-W2b-382 (follow-up XF7:04, B-W2b-361's sweep): SCR-235-floors at 390 — the In force column's "Company floor 20.0%" tag
 * (DS Tag, one line) ran 4 px off its card in the three-column SummaryTable. Below 760 px the table is the DS's stacked form
 * (`stackOnPhone`: each role a block, each cell on its own line with its column's name), so nothing scrolls sideways.
 */
const render = (id: string, locale: 'it' | 'en') =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: designScreen.cases.find((item) => item.id === id)!.model })))

describe('SCR-235-floors keeps the company floor tag on its card at phone width', () => {
  it.each(['company', 'group', 'none', 'no-right'])('%s: the floors table stacks on a phone, each cell named by its column', (id) => {
    for (const locale of ['it', 'en'] as const) {
      const html = render(id, locale)
      expect(html).toMatch(/<table class="nds-summary-table stack-phone"/)
      expect(html).toMatch(/<td[^>]*data-label="[^"]+"/)
    }
  })
  it('the tag of a role without its own floor still says the company floor, in both languages', () => {
    expect(render('none', 'en')).toMatch(/nds-tag neutral[^>]*>[^<]*20[.,]0/)
    expect(render('none', 'it')).toMatch(/nds-tag neutral[^>]*>[^<]*20[.,]0/)
  })
})
