import { createElement } from 'react'
import { REPLY_PLACEHOLDERS, REPLY_RECORD_TYPES } from '@nexus/factory-domain/templates/replies'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { at, COMPANIES, inShell } from '../../../shared/fixtures'
import { DEMO } from '../../doc-templates/fixtures'
import type { SavedRepliesAnswer, SavedReply } from './api'
import { newDraft, type RecordChoice, type SavedRepliesModel } from './model'
import { SavedRepliesView } from './view/SavedRepliesView'

/**
 * B-TH-279 — made-up saved replies of the Demo company (the reader's own and the office's shared ones, Italian and English, for
 * requests, orders, purchase orders and any record), for the design cases of Admin › Documents › E-mail templates › Saved replies.
 * Never a real customer, person or number.
 */

const rid = (n: number) => `0190f0e2-7c40-7000-8000-${String(n).padStart(12, '0')}`
const ME = { id: '0190f0e2-1111-7000-8000-000000000031', name: 'Lucia Esempio' }

function reply(n: number, over: Partial<SavedReply>): SavedReply {
  return { id: rid(n), companyId: DEMO.id, name: 'Reply', language: 'it', body: 'Gentile {{contact.name}},', recordType: null, shared: true, owner: null, mayChange: true, updatedAt: at(20 + (n % 8), 9 + n), version: 1, ...over }
}

export const REPLIES: SavedReply[] = [
  reply(1, { name: 'Ci servono le taglie', recordType: 'Inquiry', body: 'Gentile {{contact.name}},\ngrazie per la richiesta {{inquiry.number}} ({{inquiry.subject}}).\nPer prepararle un preventivo ci servono le taglie e le quantità per colore.\n\n{{me.name}} · {{company.name}}' }),
  reply(2, { name: 'Sizes and quantities, please', language: 'en', recordType: 'Inquiry', body: 'Dear {{contact.name}},\nthank you for your request {{inquiry.number}} ({{inquiry.subject}}).\nTo prepare a quote we need the sizes and the quantities per colour.\n\n{{me.name}} · {{company.name}}' }),
  reply(3, { name: 'Ritardo di qualche giorno', recordType: 'SalesOrder', body: 'Gentile {{contact.name}},\nl’ordine {{order.number}} (vostro riferimento {{order.customerRef}}) sarà pronto qualche giorno dopo il {{order.promiseDate}}. Le scriviamo appena parte.\n\n{{me.name}}' }),
  reply(4, { name: 'Conferma data di consegna', recordType: 'PurchaseOrder', body: 'Buongiorno,\nci confermate la consegna dell’ordine {{order.number}} entro il {{order.deliveryDate}}?\n\n{{me.name}} · {{company.name}}', mayChange: false }),
  reply(5, { name: 'Grazie, a presto', recordType: null, shared: false, owner: ME, body: 'Grazie {{contact.name}}, a presto!\n{{me.name}}', updatedAt: at(28, 16, 5), version: 3 }),
  reply(6, { name: 'Thanks, talk soon', language: 'en', recordType: null, shared: false, owner: ME, body: 'Thank you {{contact.name}}, talk soon!\n{{me.name}}' }),
]

export function repliesAnswer(replies: readonly SavedReply[] = REPLIES, mayShare = true): SavedRepliesAnswer {
  return { replies: [...replies], placeholders: Object.fromEntries(REPLY_RECORD_TYPES.map((type) => [type, [...REPLY_PLACEHOLDERS[type]]])), mayShare }
}

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName }))

const base = (over: Partial<SavedRepliesModel> = {}): SavedRepliesModel => ({
  prefix: '/w/DEMO',
  companies,
  companyId: DEMO.id,
  read: { status: 'ready', answer: repliesAnswer() },
  mayWrite: true,
  selected: [],
  editor: null,
  confirm: null,
  busy: false,
  notice: null,
  asOf: at(29, 9, 42),
  updates: 0,
  ...over,
})

function SavedRepliesDesign({ model }: { model: SavedRepliesModel }) {
  return inShell('/admin/documents', createElement(SavedRepliesView, { model }), model.mayWrite ? undefined : ['home.view', 'numbering.view', 'documents.view'])
}

const editOf = (n: number) => {
  const one = REPLIES[n - 1]!
  return { draft: { id: one.id, version: one.version, name: one.name, language: one.language === 'en' ? ('en' as const) : ('it' as const), record: (one.recordType ?? 'ANY') as RecordChoice, shared: one.shared, body: one.body }, problem: null }
}

export const designScreen = defineDesignScreen<SavedRepliesModel>({
  screen: 'SCR-632-replies',
  title: 'Documents & numbering › E-mail templates › Saved replies',
  view: SavedRepliesDesign,
  cases: [
    { id: 'th3-279-replies', label: 'Saved replies: the office’s shared ones and yours, Italian · English, for requests, orders, purchase orders, any record', model: base(), note: 'A saved reply sends nothing: it fills a message the person reads, changes and sends. The shared purchase-order reply is held for this reader (no share right over it).' },
    { id: 'th3-279-requests', label: 'For: a request (Sales › Incoming) — the replies Ask for info offers', model: base({ filter: { language: null, record: 'Inquiry', q: '' } }) },
    { id: 'th3-279-english', label: 'Language: English', model: base({ filter: { language: 'en', record: null, q: '' } }) },
    { id: 'th3-279-new', label: 'New saved reply: name, language, for, Share with the office, the words with the record’s placeholders, the preview on a made-up record', model: base({ editor: { draft: { ...newDraft({ language: 'it', record: 'Inquiry', q: '' }, true), name: 'Ci serve una foto', body: 'Gentile {{contact.name}},\nper la richiesta {{inquiry.number}} ci serve una foto del capo.\n\n{{me.name}}' }, problem: null } }) },
    { id: 'th3-279-new-no-share', label: 'New saved reply without the right to keep the shared ones: Share held, said why', model: base({ read: { status: 'ready', answer: repliesAnswer(REPLIES, false) }, editor: { draft: { ...newDraft(), name: 'Promemoria' }, problem: null } }) },
    { id: 'th3-279-problems', label: 'The words name a placeholder the record does not offer, and the name is two lines', model: base({ editor: { draft: { ...editOf(5).draft, name: 'Grazie\nper tutto', body: 'Grazie {{contact.name}}, l’ordine {{order.number}} è partito.' }, problem: null } }) },
    { id: 'th3-279-edit', label: 'Edit a shared reply (changed: Save)', model: base({ editor: { ...editOf(1), draft: { ...editOf(1).draft, body: `${REPLIES[0]!.body}\nGrazie!` } } }) },
    { id: 'th3-279-refused', label: 'Save refused: someone changed it meanwhile (read again)', model: base({ editor: { ...editOf(3), problem: { key: 'tpl.problem.stale' } } }) },
    { id: 'th3-279-selected', label: 'Two ticked: Delete 2 (a shared reply this reader may not change cannot be ticked)', model: base({ selected: [rid(1), rid(5)] }) },
    { id: 'th3-279-confirm', label: 'Delete 2 saved replies? (the DS ActionConfirm; a shared one asks to acknowledge)', model: base({ selected: [rid(1), rid(5)], confirm: { rows: [REPLIES[0]!, REPLIES[4]!] } }) },
    { id: 'th3-279-done', label: 'After a save', model: base({ notice: { key: 'tpl.replies.done.created', tone: 'success', params: { name: 'Ci serve una foto' } } }) },
    { id: 'th3-279-empty', label: 'No saved reply yet', model: base({ read: { status: 'ready', answer: repliesAnswer([]) } }) },
    { id: 'th3-279-no-match', label: 'Nothing matches the search', model: base({ filter: { language: null, record: null, q: 'zzz' } }) },
    { id: 'read-only', label: 'Read only: no right to send e-mail (the list says why; nothing to write)', model: base({ mayWrite: false, read: { status: 'ready', answer: repliesAnswer(REPLIES.filter((one) => one.shared).map((one) => ({ ...one, mayChange: false })), false) } }) },
    { id: 'loading', label: 'Reading the saved replies', model: base({ read: { status: 'loading' }, asOf: null }) },
    { id: 'failed', label: 'The saved replies could not be read', model: base({ read: { status: 'failed', problem: 'problem.unavailable' } }) },
  ],
})
