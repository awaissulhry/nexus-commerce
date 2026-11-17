import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { accountConversationHref } from '../../shell/record/model'
import { PREFIX, STYLES } from '../neworder/design-data'
import { opensCatalogueDoor, stylesText } from '../neworder/request-model'
import { designScreen } from './fixtures'
import { askStyleHeld, askStyleHref, NS } from './model'

/**
 * B-TH-276 (threads plan TH-6; P-CUS-CAT.lists; tree P-CUS-CAT): the Catalogue's two doors to a question — "Ask about this style"
 * opens New order (the request like an e-mail) with the subject filled and the style named in the message; "Ask us" / "Ask a
 * question" opens the account conversation as its own page, never a pop-up. Walls W12, W13: the style is one the person's own
 * catalogue listed, and New order reads it again through the portal's style read.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const STYLE_ID = STYLES[0]!.id
const FACTS = { mayOrder: true, preview: false, offline: false }

const render = (id: string, locale: 'it' | 'en' = 'en') => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  const entry = screen.cases.find((item) => item.id === id)!
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))
}

describe('B-TH-276 — "Ask about this style" opens New order with the style carried in', () => {
  it('the address is New order’s request like an e-mail with the style (never the catalogue door: no way, draft or reorder)', () => {
    const href = askStyleHref(PREFIX, STYLE_ID)
    expect(href).toBe(`${PREFIX}/orders/new?styles=${STYLE_ID}`)
    expect(opensCatalogueDoor(new URL(href, 'http://local').searchParams)).toBe(false)
    expect(href.match(/[0-9a-f-]{36}/gi)).toEqual([STYLE_ID])
  })

  it('New order fills the subject and names the style in the message, in the page’s language', () => {
    const style = STYLES[0]!
    for (const locale of ['it', 'en'] as const) {
      const carried = stylesText([style], locale, t(locale))!
      expect(carried.subject).toContain(style.code)
      expect(carried.lines).toHaveLength(1)
      expect(carried.lines[0]).toContain(style.code)
    }
  })

  it('it sends a request: a person who may not send one is told why (and who may); a preview and offline hold it too', () => {
    expect(askStyleHeld(FACTS)).toBeNull()
    expect(askStyleHeld({ ...FACTS, mayOrder: false })).toBe('held.mayNotAsk')
    expect(askStyleHeld({ ...FACTS, preview: true })).toBe('held.preview')
    expect(askStyleHeld({ ...FACTS, offline: true })).toBe('held.offline')
  })

  it('the detail draws it as a real link (⌘-click: a new tab) beside Add to order, held with the reason otherwise', () => {
    const dialog = readFileSync(new URL('./view/StyleDetailDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toMatch(/<a href=\{model\.askHref\}>/)
    expect(dialog).toContain("heldReason={style ? t(model.askHeld ?? 'detail.reading') : t('detail.reading')}")
    const page = readFileSync(new URL('./CataloguePage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('askHref: askStyleHref(frame.prefix, detail.id)')
    expect(page).toContain('askHeld: askStyleHeld({ mayOrder, preview: frame.me.preview, offline })')
  })
})

describe('B-TH-276 — "Ask us" / "Ask a question" opens the account conversation as a page, not a modal', () => {
  it('nothing open yet: "Ask us" is a link to the account conversation’s page', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = render('empty', locale)
      expect(html).toContain(`href="${accountConversationHref(PREFIX, '0194f0e2-1940-7000-8000-000000000a01')}"`)
      expect(html).toContain(t(locale)('catalogue.ask'))
    }
  })

  it('the page opens no pop-up for a question: no frame.ask, the person’s own party only', () => {
    const page = readFileSync(new URL('./CataloguePage.tsx', import.meta.url), 'utf8')
    expect(page).not.toContain('frame.ask(')
    expect(page).toContain('askHref: accountConversationHref(frame.prefix, frame.me.party.id)')
    const view = readFileSync(new URL('./view/CatalogueView.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('onAsk')
  })

  it('the new words exist in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale][NS] ?? {}
      for (const key of ['detail.ask', 'held.mayNotAsk', 'catalogue.ask']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('the held case draws in both languages with no key left on screen', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = render('detail-ask-held', locale)
      expect(html).toContain('main-content')
      expect(html).not.toMatch(/\b(?:detail|held|catalogue)\.[a-zA-Z_]+\b/)
    }
  })
})
