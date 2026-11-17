import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { REPLY_RECORD_TYPES } from '@nexus/factory-domain/templates/replies'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { draftBody, draftOf, REPLY_LANGUAGES, replyPreview, SAMPLE_VALUES } from './model' // th-backend-g step 3

/**
 * B-TH-279 — Admin › Documents › E-mail templates › Saved replies (SCR-632-replies): every design case in both languages with no key
 * left on screen, the editor drawn in place (the DS Modal opens only in a browser), and the words that say what a saved reply is.
 * The rules and the calls are held in template-editor/templates.vitest.test.ts.
 */

vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

const LEFT_KEY = /\b(?:tpl|docs|problem|common|list|held)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model }))).replace(/<!-- -->/g, '')
}
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(designScreen.cases.find((item) => item.id === id)!.model, locale)

describe('Saved replies draw every case in both languages with no key left on screen', () => {
  it('has its states', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['loading', 'failed', 'read-only', 'th3-279-empty', 'th3-279-no-match', 'th3-279-new', 'th3-279-confirm']) expect(ids).toContain(id)
  })

  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = render(item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('says what it is: a saved reply sends nothing; Italian · English; the requests of Incoming; the held words', () => {
    expect(draw('th3-279-replies')).toContain('A saved reply sends nothing by itself')
    expect(draw('th3-279-replies')).toContain('written in Italian, English, German, French or Spanish') // th-backend-g step 3
    expect(draw('th3-279-replies', 'it')).toContain('Risposte salvate')
    expect(draw('th3-279-requests')).toContain('A request (Sales › Incoming)')
    expect(draw('th3-279-new-no-share')).toContain('Sharing with the office needs the right to keep the shared replies.')
    // th-backend-g step 1 (§0.5): the sample names the request as the customer reads it (its own "#7"), never the office's series.
    expect(draw('th3-279-new')).toContain('#7')
    expect(draw('th3-279-new')).not.toContain('INQ-2026-0007')
    expect(draw('th3-279-problems')).toContain('{{order.number}} is not offered here')
    expect(draw('th3-279-empty')).toContain('No saved reply yet')
    expect(draw('read-only')).toContain('Keeping saved replies needs the right to send e-mail.')
  })

  it('names every kind of record and each part in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['admin-templates'] ?? {}
      for (const type of [...REPLY_RECORD_TYPES, 'ANY']) expect(words[`tpl.replies.record.${type}`], `${locale} ${type}`).toBeTruthy()
      expect(words['tpl.replies.part.templates']).toBeTruthy()
      expect(words['tpl.replies.part.replies']).toBeTruthy()
    }
  })
})

// ---- th-backend-g step 3 (B-TH-098's web half): the five languages, each named right; a reply keeps its own language when edited.
describe('th-backend-g step 3: saved replies in the five languages', () => {
  it('offers it, en, de, fr, es; a German reply opens German (never turned into Italian); its preview fills the sample', () => {
    expect([...REPLY_LANGUAGES]).toEqual(['it', 'en', 'de', 'fr', 'es'])
    const german = { id: 'r-de', companyId: null, name: 'Anfrage erhalten', language: 'de', body: 'Ihre Anfrage {{inquiry.yourNumber}} ist da, {{today}}.', recordType: 'Inquiry', shared: true, owner: null, mayChange: true, updatedAt: '2026-11-17T08:00:00.000Z', version: 1 }
    const draft = draftOf(german)
    expect(draft.language).toBe('de')
    expect(replyPreview(draft)).toBe('Ihre Anfrage 7 ist da, 29/10/2026.')
    expect(draftBody(german, draft, null)).toBeNull()
    for (const language of REPLY_LANGUAGES) expect(SAMPLE_VALUES[language]['inquiry.number']).toBe('#7')
  })

  it('names each language in both languages of the screen', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['admin-templates'] ?? {}
      for (const language of ['it', 'en', 'de', 'fr', 'es']) expect(words[`tpl.language.${language}`], `${locale} ${language}`).toBeTruthy()
      expect(words['tpl.mail.draftUnread']).toBeTruthy()
      expect(words['tpl.mail.draftUnreadHint']).toContain('{language}')
    }
  })
})
// ---- end th-backend-g step 3
