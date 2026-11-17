import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import type { MentionPerson, SavedRepliesModel } from './model'
import { HelpersCase, type HelpersCaseModel } from './view/HelpersCase'

/**
 * SCR-006-helpers — write faster and safer (B-TH-208, threads plan T8; picture 6, drawn to the approved pictures' look):
 * MentionInput's @ suggestions (office readers only, tagged people first, "cannot read this record"), the typed-name and
 * too-many warnings, Saved replies ▾ (shared / mine, Italian · English, the customer's language first) and the blanks a
 * record could not fill, "Draft kept on this device". The amount field (B-TH-049) and "Remind me in 3 days" (B-TH-096)
 * are not drawn until their back end exists. Made-up data only.
 */

const id = (n: number) => `0190f0e2-7e00-7000-8000-${String(n).padStart(12, '0')}`

const PEOPLE: MentionPerson[] = [
  { id: id(1), name: 'Alex Demo' },
  { id: id(2), name: 'Bea Esempio', tag: 'Supervisor' },
  { id: id(3), name: 'Carlo Prova' },
  { id: id(4), name: 'Dora Campione', canRead: false },
  { id: id(5), name: 'Bruno Inattivo', active: false },
  // Never offered: a customer's portal person and a floor account (W08, W34).
  { id: id(6), name: BRAND_BETA.portalPerson.name, audience: 'partner' },
  { id: id(7), name: 'Banco Taglio 2', audience: 'floor' },
]

const REPLIES: SavedRepliesModel = {
  status: 'ready',
  language: 'en',
  replies: [
    { id: id(101), name: 'Sample on its way', language: 'en', shared: true },
    { id: id(102), name: 'Campione in arrivo', language: 'it', shared: true },
    { id: id(103), name: 'Delivery date moved', language: 'en', shared: true },
    { id: id(104), name: 'My thanks for the order', language: 'en', shared: false },
    { id: id(105), name: 'Grazie per l’ordine', language: 'it', shared: false },
  ],
}

const FILLED = {
  [id(101)]: `Dear ${BRAND_ALPHA.contact.name},\nthe pre-production sample for SO-2026-0142 left today. Tracking follows by e-mail.\nAlex Demo`,
  [id(103)]: `Dear ${BRAND_ALPHA.contact.name},\nthe delivery of SO-2026-0142 moves to {{order.promiseDate}}. We are sorry for the wait.\nAlex Demo`,
}

const c = (over: Partial<HelpersCaseModel> = {}): HelpersCaseModel => ({ mode: 'note', text: '', people: PEOPLE, replies: REPLIES, filled: FILLED, draft: null, ...over })

export const designScreen = defineDesignScreen<HelpersCaseModel>({
  screen: 'SCR-006-helpers',
  title: 'Composer helpers: @ mentions, saved replies, local draft (B-TH-208)',
  view: HelpersCase,
  cases: [
    { id: 'mention-open', label: '@ suggestions while typing', model: c({ text: 'Can you check the collar piping, @' }), note: 'Office people who may read the record: Bea Esempio (Supervisor) first; Dora Campione shown "cannot read this record" and cannot be picked; the inactive person, the customer’s portal person and the floor account are never offered. ↑ / ↓ pick, Enter or Tab inserts, Esc closes.' },
    { id: 'mention-narrow', label: '@ narrowed by the name', model: c({ text: 'Please look at this, @Ca' }), note: 'Only Carlo Prova.' },
    { id: 'mention-warnings', label: 'Warnings under the box', model: c({ text: 'Thanks @Alex Demo. @Dora Campione please confirm, and @Mario Esempio too.' }), note: 'Dora Campione cannot read this record; nobody called Mario Esempio can read it: nobody is told. Never a silent mention.' },
    { id: 'reply-mode', label: 'Reply to the customer: no mentions', model: c({ mode: 'reply', text: 'Dear Alma, @' }), note: 'Mentions belong to office notes: the reply box offers none (TH-1b’s send check says so if one is typed).' },
    { id: 'replies', label: 'Saved replies ▾', model: c(), note: 'Open "Saved replies": shared with the office, then mine; the customer’s language (English) first, each line with its language. Picking fills the box from THIS record; nothing is sent.' },
    { id: 'replies-missing', label: 'A blank the record could not fill', model: c({ text: FILLED[id(103)]!, replies: { ...REPLIES, missing: ['order.promiseDate'] } }), note: 'The blank stays in the text and is named under the box.' },
    { id: 'replies-filling', label: 'Filling a saved reply', model: c({ replies: { ...REPLIES, filling: true } }) },
    { id: 'replies-loading', label: 'Saved replies loading', model: c({ replies: { ...REPLIES, status: 'loading', replies: [] } }) },
    { id: 'replies-failed', label: 'Saved replies could not be read', model: c({ replies: { ...REPLIES, status: 'failed', replies: [] } }), note: 'One line with Try again.' },
    { id: 'replies-none', label: 'No saved replies yet', model: c({ replies: { ...REPLIES, replies: [] } }) },
    { id: 'replies-request', label: 'A request: none for this kind yet', model: c({ replies: { ...REPLIES, status: 'notForThis', replies: [] } }), note: 'Requests get saved replies with N5; the menu says so.' },
    { id: 'draft', label: 'Draft kept on this device', model: c({ text: 'Ask the cutting room whether the lining arrives on Friday', draft: { text: 'Ask the cutting room whether the lining arrives on Friday', savedAt: Date.UTC(2026, 10, 17, 9, 42) } }), note: 'Until drafts live on the server (N6): said, so nobody expects it on another computer.' },
  ],
})
