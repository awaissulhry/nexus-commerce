import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { MailDetail, MailSummary, MailToSortViewModel, Verdicts } from '../../mail-to-sort/model'
import { MailToSortView } from '../../mail-to-sort/view/MailToSortView'
import type { QueueMail, TeamInbox, TeamInboxModel } from './model'

/**
 * SCR-438 — Home › Mail with its team inboxes (B-W2b-397; design home.mail sec:tiles "Team inboxes (orders@, quotes@)",
 * sec:mails "Assignee (team inbox)" and "assign to a person, close, snooze, follow-up", pop:create-from "Create an inquiry",
 * page head "Copy capture address") — made-up data only (PLAN §3.1): invented senders at example.invalid addresses, invented
 * colleagues and records. The page is SCR-019's (Mail to sort); these cases show what this step adds to it.
 */

const PASS: Verdicts = { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', dmarcPolicy: null, spam: 'PASS', virus: 'PASS' }
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const id = (n: number) => `0190f0e2-4380-7000-8000-${String(n).padStart(12, '0')}`
const NOW = Date.parse(at(14, 9))
const ME = { id: id(901), name: 'Olga Prova' }
const BRUNO = { id: id(902), name: 'Bruno Esempio' }
const FIONA = { id: id(903), name: 'Fiona Demo' }

const ORDERS: TeamInbox = {
  id: id(1),
  companyId: id(800),
  name: 'Ordini',
  localPart: 'ordini',
  address: 'ordini@reply.officina-demo.example.invalid',
  active: true,
  members: [ME, BRUNO, FIONA],
  member: true,
  counts: { open: 5, unassigned: 2, mine: 1, snoozed: 1, followUp: 1 },
  version: 3,
}
const QUOTES: TeamInbox = { ...ORDERS, id: id(2), name: 'Offerte', localPart: 'offerte', address: 'offerte@reply.officina-demo.example.invalid', members: [ME, FIONA], counts: { open: 3, unassigned: 3, mine: 0, snoozed: 0, followUp: 0 }, version: 1 }

const mail = (n: number, extra: Partial<QueueMail>): QueueMail => ({
  id: id(100 + n),
  status: 'MATCHED',
  receivedAt: at(14, 8, 50 - n * 7),
  from: { address: `acquisti@cliente-${n}.example.invalid`, name: `Cliente Demo ${n}` },
  subject: `Ordine di riassortimento ${n}`,
  verdicts: { dmarc: 'PASS', spam: 'PASS' },
  attachmentCount: 0,
  thread: { id: id(300 + n), recordType: 'SalesOrder', recordId: id(400 + n) },
  teamInboxId: ORDERS.id,
  state: 'OPEN',
  assignee: null,
  mine: false,
  assignedAt: null,
  closedAt: null,
  snoozedUntil: null,
  followUpUntil: null,
  inquiry: null,
  version: 4,
  ...extra,
})

const ROWS: QueueMail[] = [
  mail(1, { subject: 'Conferma taglie ordine di novembre', assignee: ME, mine: true, assignedAt: at(14, 8, 55), attachmentCount: 1 }),
  mail(2, { status: 'TRIAGE', thread: null, from: { address: 'nuovo.cliente@moto-club.example.invalid', name: 'Moto Club Esempio' }, subject: 'Richiesta 40 tute da pista' }),
  mail(3, { subject: 'Re: consegna slittata?', assignee: BRUNO, assignedAt: at(13, 16), followUpUntil: at(17, 8) }),
  mail(4, { status: 'MATCHED', thread: { id: id(304), recordType: 'Inquiry', recordId: id(404) }, subject: 'Preventivo giacche squadra', inquiry: { id: id(404), number: 'INQ-2026-0012' } }),
  mail(5, { status: 'HELD', thread: null, subject: 'Nuove coordinate bancarie', verdicts: { dmarc: 'FAIL', spam: 'PASS' }, from: { address: 'amministrazione@marchio-demo.example.invalid', name: null } }),
]
const SNOOZED: QueueMail[] = [mail(6, { state: 'SNOOZED', snoozedUntil: at(17, 8), subject: 'Listino 2027 da rivedere', assignee: ME, mine: true })]
const CLOSED: QueueMail[] = [mail(7, { state: 'CLOSED', closedAt: at(13, 17, 30), subject: 'Grazie per la consegna', assignee: FIONA })]

const inboxes = (overrides: Partial<TeamInboxModel> = {}): TeamInboxModel => ({
  inboxes: { status: 'ready', data: { inboxes: [ORDERS, QUOTES], mayManage: false } },
  queue: { inboxId: ORDERS.id, view: 'OPEN', rows: ROWS, more: false, problem: null, selected: [], updates: 0 },
  me: ME.id,
  prefix: '/w/DEMO',
  busy: false,
  notice: null,
  dialog: null,
  now: NOW,
  canInquiry: true,
  ...overrides,
})

const summary = (n: number, extra: Partial<MailSummary> & Pick<MailSummary, 'status'>): MailSummary => ({
  id: id(500 + n),
  receivedAt: at(14, 7, n),
  from: { address: `info@mittente-${n}.example.invalid`, name: `Mittente Demo ${n}` },
  subject: `Richiesta ${n}`,
  excerpt: 'Buongiorno, vi scriviamo per…',
  verdicts: PASS,
  heldReason: null,
  rejectReason: null,
  threadId: null,
  suggestedPartyId: null,
  attachmentCount: 0,
  version: 2,
  ...extra,
})
const MAILS: MailSummary[] = [
  summary(1, { status: 'TRIAGE', from: { address: 'buyer@negozio-esempio.example.invalid', name: 'Giulia Esempio' }, subject: 'Preventivo 200 giacche in pelle', excerpt: 'Vorremmo un preventivo per 200 giacche, taglie 46–56.' }),
  summary(2, { status: 'HELD', heldReason: 'UNKNOWN_SENDER', subject: 'Re: certificato aggiornato', threadId: id(600) }),
]
const TRIAGE_DETAIL: MailDetail = {
  ...MAILS[0]!,
  to: ['ordini@officina-demo.example.invalid'],
  cc: [],
  bodyText: 'Buongiorno,\n\nvorremmo un preventivo per 200 giacche in pelle, taglie 46–56, con il nostro marchio.\n\nGiulia Esempio',
  bodyHtml: null,
  attachments: [],
  thread: null,
  attempts: 1,
  fetchedAt: at(14, 7, 2),
}

const page = (overrides: Partial<MailToSortViewModel> = {}): MailToSortViewModel => ({
  filter: 'all',
  mails: { items: MAILS, more: false },
  open: null,
  canWrite: true,
  canReadFiles: true,
  assign: { candidates: [] },
  inboxes: inboxes({ queue: null }),
  capture: { status: 'ready', address: 'c-k7m2q9x4w8r3t6y1p5n0b2v7c4@reply.officina-demo.example.invalid', receivingDomain: 'reply.officina-demo.example.invalid', mayManage: false },
  prefix: '/w/DEMO',
  canInquiry: true,
  ...overrides,
})

export const designScreen = defineDesignScreen<MailToSortViewModel>({
  screen: 'SCR-438',
  title: 'Mail: team inboxes, capture address, create an inquiry',
  view: MailToSortView,
  cases: [
    { id: 'tiles', label: 'Tiles: Mail to sort and the team inboxes', model: page(), note: 'Mail to sort is chosen (its list below); each inbox tile counts its open mail, nobody’s and mine. Copy capture address at the head.' },
    { id: 'inbox-open', label: 'A team inbox: Open', model: page({ inboxes: inboxes() }), note: 'From, Subject (opens the mail), Received, Record (or the inquiry made), State with the follow-up, Assignee, ⋯ with every verb held with its reason.' },
    { id: 'inbox-selected', label: 'Two mails selected', model: page({ inboxes: inboxes({ queue: { inboxId: ORDERS.id, view: 'OPEN', rows: ROWS, more: false, problem: null, selected: [ROWS[1]!.id, ROWS[2]!.id], updates: 0 } }) }), note: 'Take 2 · Assign 2… · Close 2 replace the toolbar.' },
    { id: 'assign', label: 'Assign to…', model: page({ inboxes: inboxes({ dialog: { kind: 'assign', ids: [ROWS[1]!.id] } }) }), note: 'A member of the inbox, or nobody (back to the queue).' },
    { id: 'move', label: 'Move to another inbox', model: page({ inboxes: inboxes({ dialog: { kind: 'move', ids: [ROWS[1]!.id] } }) }) },
    { id: 'snooze', label: 'Snooze', model: page({ inboxes: inboxes({ dialog: { kind: 'snooze', id: ROWS[0]!.id } }) }), note: 'Today’s snooze choices, 90 days at most.' },
    { id: 'follow-up', label: 'Follow up', model: page({ inboxes: inboxes({ dialog: { kind: 'followUp', id: ROWS[0]!.id } }) }), note: 'Back in Open at the time unless the customer answers in the thread first.' },
    { id: 'snoozed', label: 'View: Snoozed', model: page({ inboxes: inboxes({ queue: { inboxId: ORDERS.id, view: 'SNOOZED', rows: SNOOZED, more: false, problem: null, selected: [], updates: 0 } }) }) },
    { id: 'closed', label: 'View: Closed', model: page({ inboxes: inboxes({ queue: { inboxId: ORDERS.id, view: 'CLOSED', rows: CLOSED, more: false, problem: null, selected: [], updates: 0 } }) }) },
    { id: 'updates', label: 'Live: 2 updates', model: page({ inboxes: inboxes({ queue: { inboxId: ORDERS.id, view: 'OPEN', rows: ROWS, more: true, problem: null, selected: [], updates: 2 } }) }), note: 'Rows never move under the cursor: “2 updates · Show”, and Show more.' },
    { id: 'done', label: 'Taken', model: page({ inboxes: inboxes({ notice: { key: 'inbox.done.take', tone: 'success', params: { count: 1 } } }) }) },
    { id: 'moved', label: 'Changed meanwhile', model: page({ inboxes: inboxes({ notice: { key: 'inbox.notice.moved', tone: 'warning' } }) }), note: 'A 409: the mail was read again.' },
    { id: 'inbox-empty', label: 'View: Mine, empty', model: page({ inboxes: inboxes({ queue: { inboxId: ORDERS.id, view: 'MINE', rows: [], more: false, problem: null, selected: [], updates: 0 } }) }) },
    { id: 'inbox-loading', label: 'Inbox loading', model: page({ inboxes: inboxes({ queue: { inboxId: ORDERS.id, view: 'OPEN', rows: null, more: false, problem: null, selected: [], updates: 0 } }) }) },
    { id: 'inbox-error', label: 'Inbox could not be read', model: page({ inboxes: inboxes({ queue: { inboxId: ORDERS.id, view: 'OPEN', rows: [], more: false, problem: 'inbox.problem.unavailable', selected: [], updates: 0 } }) }) },
    { id: 'inboxes-loading', label: 'Tiles loading', model: page({ inboxes: inboxes({ inboxes: { status: 'loading' }, queue: null }), capture: { status: 'loading' } }) },
    { id: 'inboxes-error', label: 'Tiles could not be read', model: page({ inboxes: inboxes({ inboxes: { status: 'error', problem: 'inbox.problem.unavailable' }, queue: null }) }), note: 'The strip says so; Mail to sort keeps working.' },
    { id: 'no-inboxes', label: 'No team inbox yet', model: page({ inboxes: inboxes({ inboxes: { status: 'ready', data: { inboxes: [], mayManage: true } }, queue: null }) }) },
    { id: 'capture-none', label: 'No capture address yet', model: page({ capture: { status: 'ready', address: null, receivingDomain: 'reply.officina-demo.example.invalid', mayManage: true } }), note: 'Copy is held with its reason; Set it up opens Admin › Connections.' },
    { id: 'capture-no-domain', label: 'No mail domain yet', model: page({ capture: { status: 'ready', address: null, receivingDomain: null, mayManage: false } }) },
    { id: 'create-inquiry', label: 'A mail: Create an inquiry', model: page({ open: { id: TRIAGE_DETAIL.id, detail: TRIAGE_DETAIL } }), note: 'One link to Sales › Inquiries’ “Make an inquiry” with this mail.' },
    { id: 'create-inquiry-held', label: 'Create an inquiry held (no right)', model: page({ open: { id: TRIAGE_DETAIL.id, detail: TRIAGE_DETAIL }, canInquiry: false }) },
    { id: 'no-permission', label: 'Without team inboxes', model: page({ inboxes: null, capture: null, canInquiry: undefined }), note: 'No email.triage over the inboxes and no email.send: the parts are absent, Mail to sort as before.' },
  ],
})
