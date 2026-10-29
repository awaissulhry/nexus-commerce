import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { LOCALES, type Locale } from '../../../lib/i18n/locales'
import type { SendCheck } from '../../sales/quotes/api'
import { sendModel } from '../../sales/quotes/record/fixtures'
import type { DocumentSendModel } from './model'
import { DocumentSendPreview, type DocumentSendPreviewModel } from './view/DocumentSendView'

/**
 * SCR-037 Send a document — the shared part, shown with a made-up quote (PLAN §3.1). Each case is one state: ready
 * (only a warning), held by a blocking check (the button says why, the Fix link goes to the tab), the checks still
 * running, a bad copy address, sending, sent (to whom, when, how long the link lives), a mail that failed (Send a new
 * link), a role that may not send, a contact without email, a PDF that cannot be made yet, checks that could not be
 * read. The host's words (the document's name, its checks, what freezes) come from the quote's catalogue in each language.
 */

const at = '2026-10-29T11:02:00.000Z'
const sent = { to: 'anna@squadra-fittizia.example.com', at, linkUntil: '2026-12-12T22:59:59.000Z' }
const BLOCKING: SendCheck['checks'] = [
  { code: 'APPROVAL_NEEDED', severity: 'BLOCKS', path: 'approval', message: '', lineId: null, size: null },
  { code: 'NO_PROMISE_DATE', severity: 'BLOCKS', path: 'promiseDate', message: '', lineId: null, size: null },
]

/** One case in both languages: the overrides may use the language's own words. */
function both(overrides: (locale: Locale) => Partial<DocumentSendModel> = () => ({}), checks?: SendCheck['checks']): DocumentSendPreviewModel {
  return Object.fromEntries(LOCALES.map((locale) => [locale, sendModel(overrides(locale), locale, checks)])) as DocumentSendPreviewModel
}
const words = (locale: Locale) => createTranslator(locale, CATALOGUE[locale].sales ?? {})

export const designScreen = defineDesignScreen<DocumentSendPreviewModel>({
  screen: 'SCR-037',
  title: 'Send a document (the shared send part)',
  view: DocumentSendPreview,
  cases: [
    { id: 'ready', label: 'Ready (one warning)', model: both(), note: 'Blocking checks first, then warnings, then what passes; ⌘↵ sends.' },
    { id: 'blocked', label: 'Held by a blocking check', model: both(() => ({}), BLOCKING), note: 'Send is held with the first blocking check, in words; each has its Fix link.' },
    { id: 'checking', label: 'Checks still running', model: both(() => ({ checks: { status: 'loading' }, preview: { src: null, openHref: null, problem: null, fileName: 'x.pdf' } })) },
    { id: 'bad-cc', label: 'A copy address that is not one', model: both(() => ({ fields: { cc: 'luca@squadra-fittizia.example.com, non-un-indirizzo', subject: 'Preventivo Q-2026-0142 v1', message: '' } })) },
    { id: 'sending', label: 'Sending', model: both(() => ({ sending: true })) },
    { id: 'sent', label: 'Sent', model: both(() => ({ result: { delivery: 'sent', ...sent } })) },
    { id: 'failed', label: 'The mail failed', model: both(() => ({ result: { delivery: 'failed', ...sent } })), note: 'Frozen and stored, but the mail did not leave: Send a new link.' },
    { id: 'no-permission', label: 'A role that may not send', model: both(() => ({ canSend: false })) },
    { id: 'no-email', label: 'The contact has no email', model: both(() => ({ recipient: { name: 'Luca Fittizio', email: null } })) },
    { id: 'pdf-needs', label: 'The PDF cannot be made yet', model: both((locale) => ({ preview: { src: null, openHref: null, problem: words(locale)('docs.problem.needs'), fileName: 'x.pdf' } })) },
    { id: 'error', label: "Checks couldn't be read", model: both((locale) => ({ checks: { status: 'error', problem: words(locale)('problem.read.unavailable') } })) },
  ],
})
