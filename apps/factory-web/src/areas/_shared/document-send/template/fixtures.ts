import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES, type Locale } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { useLocale } from '../../../../lib/i18n/provider'
import { sendModel } from '../../../sales/quotes/record/fixtures'
import { languageHeld, type SendLanguageModel } from '../language/model'
import { LanguagePick } from '../language/view/LanguagePick'
import type { DocumentSendModel } from '../model'
import { DocumentSendView } from '../view/DocumentSendView'
import { NO_TEMPLATES, type MessageTemplateModel } from './model'
import { MessageTemplatePick } from './view/MessageTemplatePick'

/**
 * SCR-635 — the send panel's language and message template (B-W2b-432; design shell.preview sec:language-version and
 * sec:send-panel, PLT-131) on the shared send dialog (SCR-037) with a made-up quote: the contact's language preselected and
 * why (their own, their organisation's), a contact who reads German (English, said so), the contact's language other than
 * the quote's (the preview follows the pick; Send waits with why and the Fix link to Terms), a template picked (the message
 * filled, a value missing, "Put back what I wrote"), no template in that language, reading, and without the right to read
 * parties (the document's language, no pick from the contact).
 */

const fix = { label: 'Terms', href: '/w/DEMO/sales/quotes/q1?tab=terms' }
const REPLIES: MessageTemplateModel['replies'] = [
  { id: 'r1', name: 'Offerta con campioni', shared: true },
  { id: 'r2', name: 'Promemoria validità', shared: true },
  { id: 'r3', name: 'La mia nota di accompagnamento', shared: false },
]

interface SendPartsCase {
  send: Readonly<Record<Locale, DocumentSendModel>>
  language: SendLanguageModel
  templates: MessageTemplateModel | null
}

const lang = (over: Partial<SendLanguageModel> = {}): SendLanguageModel => ({ picked: 'it', documentLanguage: 'it', recipient: { language: 'it', source: 'CONTACT', notOffered: null }, status: 'ready', fix, ...over })
const ready = (over: Partial<MessageTemplateModel> = {}): MessageTemplateModel => ({ ...NO_TEMPLATES, status: 'ready', replies: REPLIES, ...over })
const both = (over: (locale: Locale) => Partial<DocumentSendModel> = () => ({})): SendPartsCase['send'] => Object.fromEntries(LOCALES.map((locale) => [locale, sendModel(over(locale), locale)])) as SendPartsCase['send']
const make = (language: SendLanguageModel, templates: MessageTemplateModel | null, send = both()): SendPartsCase => ({ send, language, templates })

/** The dialog as a host opens it: the parts built from their models, Send held while the language is not the quote's. */
function SendPartsPreview({ model }: { model: SendPartsCase }) {
  const locale = useLocale()
  const words = createTranslator(locale, CATALOGUE[locale]['admin-templates'] ?? {})
  const held = languageHeld(model.language)
  return createElement(DocumentSendView, {
    open: true,
    model: { ...model.send[locale], language: model.language.documentLanguage },
    parts: {
      language: createElement(LanguagePick, { model: model.language, recordType: 'Quote' }),
      messageTemplate: model.templates ? createElement(MessageTemplatePick, { model: model.templates, language: model.language.picked }) : undefined,
      held: held ? words(held, { language: words(`tpl.language.${model.language.documentLanguage}`) }) : null,
    },
  })
}

const filled = 'Gentile Anna Esempio,\nin allegato il preventivo Q-2026-0142 con i campioni richiesti.\nResto a disposizione.\n\nLucia Esempio'

export const designScreen = defineDesignScreen<SendPartsCase>({
  screen: 'SCR-635',
  title: 'Send a document › language and message template',
  view: SendPartsPreview,
  cases: [
    { id: 'contact-language', label: "The contact's own language preselected, the templates of that language", model: make(lang(), ready()), note: 'Italiano · English as a SegmentedControl; the message templates list the office’s and the person’s own.' },
    { id: 'organisation', label: "Their organisation's language (the contact has none of their own)", model: make(lang({ recipient: { language: 'it', source: 'PARTY', notOffered: null } }), ready()) },
    { id: 'differs', label: "The contact reads English, the quote is in Italian: Send waits with why", model: make(lang({ picked: 'en', recipient: { language: 'en', source: 'CONTACT', notOffered: null } }), ready()), note: 'The preview shows the English version of the same quote; the Fix link opens Terms, where the quote’s language is set.' },
    { id: 'picked-document', label: 'The person picked the quote’s language: Send goes, the contact’s language still said', model: make(lang({ picked: 'it', recipient: { language: 'en', source: 'CONTACT', notOffered: null } }), ready()) },
    { id: 'not-offered', label: 'A contact who reads German: English is preselected, said so', model: make(lang({ picked: 'en', documentLanguage: 'en', recipient: { language: 'en', source: 'CONTACT', notOffered: 'de' } }), ready({ replies: [{ id: 'r4', name: 'Offer with samples', shared: true }] }), both(() => ({ language: 'en', fields: { cc: '', subject: 'Quote Q-2026-0142 v1', message: '' } })) ) },
    { id: 'filled', label: 'A template picked: the message filled, one value missing, Put back', model: make(lang(), ready({ pickedId: 'r1', missing: ['quote.validUntil'], previous: 'Ciao Anna, ecco il preventivo.' }), both(() => ({ fields: { cc: '', subject: 'Preventivo Q-2026-0142 v1', message: filled } }))) },
    { id: 'no-templates', label: 'No message template in that language yet', model: make(lang(), ready({ replies: [] })) },
    { id: 'reading', label: "Reading the contact's language and the templates", model: make(lang({ status: 'loading', recipient: null }), { ...NO_TEMPLATES, status: 'loading' }) },
    { id: 'failed', label: "The contact's language and the templates could not be read", model: make(lang({ status: 'failed', recipient: null }), { ...NO_TEMPLATES, status: 'failed' }) },
    { id: 'no-parties-right', label: 'Without parties.view: the quote’s own language, no pick from the contact', model: make(lang({ status: 'none', recipient: null }), ready()) },
    { id: 'fill-refused', label: 'A template that could not be filled', model: make(lang(), ready({ problem: 'tpl.send.template.failed' })) },
  ],
})
