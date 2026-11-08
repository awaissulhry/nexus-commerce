import { createElement } from 'react'
import { defineDesignScreen } from '../../lib/design/design-screen'
import type { RecordPanelsViewModel } from '../model'
import { RecordPanelsView } from '../view/RecordPanelsView'
import type { OfficeRequest } from './api'
import type { ApprovalsPanelModel } from './model'

/**
 * SCR-006-approvals — the record panels' Approvals tab (B-W2b-188; "Ask a partner to approve"): made-up order, customer,
 * people and addresses only. The requests in every state (waiting, approved with changes by link with a marked photo,
 * refused in the portal, withdrawn, expired), the empty tab, loading, a read error, no right to ask, a record that
 * cannot be asked about now (the API's words), the ask dialog (open, its checks, a refusal), the link given once, and
 * the withdraw confirm.
 */

const id = (n: number) => `0190f0e2-5151-7000-8000-${String(n).padStart(12, '0')}`
const RECORD = { type: 'SalesOrder', id: id(1), companyId: id(2), siteId: null }
const NOW = Date.parse('2026-11-10T09:00:00.000Z')

function request(n: number, over: Partial<OfficeRequest> = {}): OfficeRequest {
  return {
    id: id(100 + n),
    companyId: id(2),
    kind: 'SAMPLE',
    record: { type: 'SalesOrder', id: id(1), words: { it: 'SO-2026-0042', en: 'SO-2026-0042' } },
    party: { id: id(3), name: 'Squadra Corse Fittizia S.r.l.' },
    contactId: null,
    question: 'Vi mandiamo le foto del campione della giacca in pelle nera, taglia 48. Va bene così per la produzione?',
    dueAt: '2026-11-17T16:00:00.000Z',
    status: 'OPEN',
    answer: null,
    withdrawn: null,
    askedBy: 'Carlo Prova',
    createdAt: '2026-11-10T08:30:00.000Z',
    files: [{ id: id(200 + n), originalName: 'campione-fronte.jpg', contentType: 'image/jpeg', sizeBytes: 184_320 }],
    links: [{ id: id(300 + n), email: 'anna@squadra-fittizia.example.com', expiresAt: '2026-11-17T16:00:00.000Z', used: false, revoked: false, lastUsedAt: null }],
    may: { withdraw: true },
    version: 1,
    ...over,
  }
}

const REQUESTS: OfficeRequest[] = [
  request(1),
  request(2, {
    kind: 'COLOUR',
    status: 'APPROVED_WITH_CHANGES',
    question: 'Il rosso della fodera: va bene questa tonalità?',
    answer: { at: '2026-11-08T10:42:00.000Z', typedName: 'Anna Esempio', words: 'Un po’ più scuro, come il campione di ottobre.', via: 'LINK', personName: null, markup: { fileId: id(202), page: null, shapes: [{}, {}], note: 'Questa zona' } },
    links: [{ id: id(302), email: 'anna@squadra-fittizia.example.com', expiresAt: '2026-11-12T16:00:00.000Z', used: true, revoked: false, lastUsedAt: '2026-11-08T10:42:00.000Z' }],
    may: { withdraw: false },
    version: 2,
  }),
  request(3, {
    kind: 'ARTWORK',
    status: 'REFUSED',
    question: 'Il logo sul petto: posizione e misura come nel file?',
    answer: { at: '2026-11-06T15:05:00.000Z', typedName: 'Marco Esempio', words: 'Il logo va 2 cm più in alto.', via: 'PORTAL', personName: 'Marco Esempio', markup: null },
    links: [],
    may: { withdraw: false },
    version: 2,
  }),
  request(4, { kind: 'LEATHER', status: 'WITHDRAWN', withdrawn: { at: '2026-11-05T09:00:00.000Z', byName: 'Carlo Prova', reason: 'Cambiato fornitore della pelle.' }, links: [{ id: id(304), email: null, expiresAt: '2026-11-09T16:00:00.000Z', used: false, revoked: true, lastUsedAt: null }], may: { withdraw: false }, version: 2 }),
  request(5, { kind: 'SAMPLE', status: 'EXPIRED', dueAt: '2026-11-01T16:00:00.000Z', may: { withdraw: false } }),
]

const KINDS: ApprovalsPanelModel['read'] = { status: 'ready', kinds: ['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK'], held: null, requests: REQUESTS }
const FILES = [
  { id: id(401), name: 'campione-fronte.jpg', contentType: 'image/jpeg' },
  { id: id(402), name: 'campione-retro.jpg', contentType: 'image/jpeg' },
  { id: id(403), name: 'scheda-tecnica.pdf', contentType: 'application/pdf' },
]
const PARTY = { name: 'Squadra Corse Fittizia S.r.l.', emails: ['anna@squadra-fittizia.example.com'] }
const DRAFT = { kind: 'SAMPLE' as const, question: 'Ecco il campione rifatto con la cucitura corretta. Va bene per la produzione?', dueAt: '2026-11-17T16:00:00.000Z', fileIds: [id(401), id(402)], send: true, email: 'anna@squadra-fittizia.example.com', language: '' as const }

function approvals(over: Partial<ApprovalsPanelModel> = {}): ApprovalsPanelModel {
  return { can: { ask: true }, read: KINDS, ask: null, files: FILES, party: PARTY, withdraw: null, busy: false, notice: null, link: null, now: NOW, ...over }
}

const base = (over: Partial<ApprovalsPanelModel> = {}): RecordPanelsViewModel => ({
  record: RECORD,
  title: 'Ordine SO-2026-0042',
  party: { id: id(3), name: PARTY.name, emails: PARTY.emails },
  can: { post: true, email: true, manage: true, readFiles: true, upload: true, share: true },
  thread: null,
  messages: { items: [], more: false },
  files: { items: [], more: false },
  uploads: [],
  timeline: { items: [], more: false },
  timelineFilter: 'all',
  people: [],
  tab: 'approvals',
  approvals: approvals(over),
})

function ApprovalsDesign({ model }: { model: RecordPanelsViewModel }) {
  return createElement(RecordPanelsView, { model })
}

export const designScreen = defineDesignScreen<RecordPanelsViewModel>({
  screen: 'SCR-006-approvals',
  title: 'Record panels › Approvals: ask a partner to approve',
  view: ApprovalsDesign,
  cases: [
    { id: 'list', label: 'Requests in every state', model: base(), note: 'Waiting (Withdraw), approved with changes by link with a marked photo, refused in the portal, withdrawn with its reason, expired. The tab counts the ones that wait.' },
    { id: 'empty', label: 'Nothing asked yet', model: base({ read: { ...KINDS, requests: [] } }) },
    { id: 'loading', label: 'Loading', model: base({ read: { status: 'loading' } }) },
    { id: 'error', label: 'The requests could not be read', model: base({ read: { status: 'failed', problem: 'problem.read' } }), note: 'Our words and Try again; never an empty list.' },
    { id: 'no-right', label: 'A person who may only see (production manager)', model: base({ can: { ask: false } }), note: 'Ask and Withdraw held with the reason.' },
    { id: 'held', label: 'The record cannot be asked about now', model: base({ read: { ...KINDS, held: 'SO-2026-0042 è annullato.', requests: [] } }), note: 'The API’s words hold Ask.' },
    { id: 'ask', label: 'Ask a partner to approve (the dialog)', model: base({ ask: { draft: DRAFT, problems: {}, problem: null } }), note: 'What to approve, the question, by when, the files, by e-mail or a link to pass on, the language.' },
    { id: 'ask-checks', label: 'The dialog’s own checks', model: base({ ask: { draft: { ...DRAFT, question: '', fileIds: [], email: 'anna@' }, problems: { question: 'ask.problem.question', fileIds: 'ask.problem.files', email: 'ask.problem.email' }, problem: null } }) },
    { id: 'ask-link', label: 'Ask · a link to pass on', model: base({ ask: { draft: { ...DRAFT, send: false, email: '' }, problems: {}, problem: null } }) },
    { id: 'ask-refused', label: 'Ask refused: one already waits', model: base({ ask: { draft: DRAFT, problems: {}, problem: 'ask.problem.open' } }) },
    { id: 'link-once', label: 'The link given once', model: base({ link: { url: 'https://factory.example.com/l#token=demo-token-not-real', label: 'SO-2026-0042' }, notice: { key: 'note.linkOnce', tone: 'info' } }), note: 'Copy the link; it is not shown again.' },
    { id: 'mailed', label: 'Asked by e-mail', model: base({ notice: { key: 'note.mailed', tone: 'success' } }) },
    { id: 'withdraw', label: 'Withdraw (the confirm)', model: base({ withdraw: { requestId: REQUESTS[0]!.id, reason: '' } }) },
  ],
})
