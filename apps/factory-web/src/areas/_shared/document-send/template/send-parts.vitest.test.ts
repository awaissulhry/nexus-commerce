import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { recipientLanguage } from '../language/api'
import { languageHeld, preselected, recipientDiffers, type SendLanguageModel } from '../language/model'
import { LanguagePick } from '../language/view/LanguagePick'
import { MessageTemplatePick } from './view/MessageTemplatePick'
import { fillReply, listReplies, type SavedReply } from './api'
import { designScreen } from './fixtures'
import { orderedReplies, type MessageTemplateModel } from './model'

/**
 * B-W2b-432 — the send panel's language and message template (SCR-635 on SCR-037): the contact's language preselected,
 * Send waiting while the language on screen is not the document's (said with why), the templates in order, the calls, and
 * every design case in both languages with no key left on screen.
 */

describe('the send panel’s language', () => {
  it('the contact’s preselected, else the document’s; Send waits while they differ', () => {
    expect(preselected({ language: 'en' }, 'it')).toBe('en')
    expect(preselected(null, 'it')).toBe('it')
    expect(languageHeld({ picked: 'en', documentLanguage: 'it' })).toBe('tpl.send.held.language')
    expect(languageHeld({ picked: 'it', documentLanguage: 'it' })).toBeNull()
    expect(languageHeld(null)).toBeNull()
    expect(recipientDiffers({ recipient: { language: 'en', source: 'CONTACT', notOffered: null }, documentLanguage: 'it' })).toBe(true)
  })

  it('the office’s templates first, then one’s own, each by name', () => {
    const reply = (id: string, name: string, shared: boolean) => ({ id, name, shared }) as SavedReply
    expect(orderedReplies([reply('a', 'Zeta', false), reply('b', 'Beta', true), reply('c', 'Alfa', false), reply('d', 'Alfa', true)], 'it').map((entry) => entry.id)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('reads the contact’s language and the templates; fills one for the record', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = []
    const answers = [
      { partyId: 'p1', contactId: 'k1', language: 'en', source: 'CONTACT', notOffered: null },
      { replies: [], placeholders: {}, mayShare: false },
      { body: 'Gentile Anna', language: 'it', missing: [] },
    ]
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch
    const api = createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf' })
    expect((await recipientLanguage(api, { partyId: 'p1', contactId: 'k1' })).language).toBe('en')
    expect(await listReplies(api, { language: 'it', recordType: 'Quote' })).toEqual([])
    expect((await fillReply(api, 'r1', { recordType: 'Quote', recordId: 'q1', contactId: null })).body).toBe('Gentile Anna')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/templates/language?partyId=p1&contactId=k1', 'GET /api/templates/replies?language=it&recordType=Quote', 'POST /api/templates/replies/r1/fill'])
    expect(calls[2]!.body).toEqual({ recordType: 'Quote', recordId: 'q1' })
  })
})

const LEFT_KEY = /\b(?:tpl|send|held|check)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
type PartsCase = { language: SendLanguageModel; templates: MessageTemplateModel | null }
/** The dialog is a DS Modal, drawn in a browser only (the Playwright pass and the design index): the parts are drawn alone. */
const draw = (id: string, locale: (typeof LOCALES)[number]) => {
  const model = designScreen.cases.find((item) => item.id === id)!.model as unknown as PartsCase
  const parts = createElement('div', null, createElement(LanguagePick, { model: model.language, recordType: 'Quote' }), model.templates ? createElement(MessageTemplatePick, { model: model.templates, language: model.language.picked }) : null)
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, parts)).replace(/<!-- -->/g, '')
}

describe('SCR-635 draws every case in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = draw(item.id, locale)
        expect(html.length, item.id).toBeGreaterThan(300)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('the contact’s language and its reason are said; a language other than the quote’s says it goes out in its own', () => {
    expect(draw('differs', 'en')).toContain('This quote is written in Italiano: it goes out in Italiano.')
    expect(draw('contact-language', 'en')).toContain('The contact&#x27;s own language.')
    expect(draw('not-offered', 'it')).toContain('Legge tedesco')
    expect(draw('filled', 'en')).toContain('Put back what I wrote')
    expect(draw('no-templates', 'it')).toContain('Ancora nessun modello di messaggio in Italiano.')
  })

  it('Send waits with the reason in the reader’s language', () => {
    const words = createTranslator('en', CATALOGUE.en['admin-templates'] ?? {})
    expect(words('tpl.send.held.language', { language: words('tpl.language.it') })).toBe("The document goes out in Italiano, its own language: pick it to send, or change the record's language first.")
  })
})
