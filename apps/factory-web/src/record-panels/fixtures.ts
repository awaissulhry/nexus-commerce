import { defineDesignScreen } from '../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES, demoPdf } from '../shell/design-data'
import type { PanelFile, PanelFollowers, PanelMessage, PanelParty, PanelTask, PanelTasks, PanelTimelineEntry, RecordPanelsViewModel } from './model'
import { RecordPanelsView } from './view/RecordPanelsView'

/**
 * SCR-006 record panels — made-up data only (PLAN §3.1): a demo certificate held by a demo brand, demo people at
 * example.com, invented numbers. Each case is one state the Owner reviews: empty, a long conversation (internal notes vs
 * shared mail), the email composer, a record without a party, read-only, a closed thread, files (versions, audiences,
 * a quarantined file, a retained fiscal file, a legal hold), uploads in progress, the PDF viewer, the history, errors.
 */

const RECORD = { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000001', companyId: DEMO_COMPANIES[0].id, siteId: DEMO_SITES[0].id }
const PARTY: PanelParty = { id: '0190f0e2-6666-7000-8000-000000000001', name: 'Marchio Demo S.r.l.', emails: ['acquisti@marchio-demo.example.com'] }
const PEOPLE = [
  { id: '0190f0e2-3333-7000-8000-000000000002', name: 'Bea Esempio' },
  { id: '0190f0e2-3333-7000-8000-000000000003', name: 'Carlo Prova' },
  { id: '0190f0e2-3333-7000-8000-000000000004', name: 'Dora Campione' },
]
const ALL = { post: true, email: true, manage: true, readFiles: true, upload: true, share: true }
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const fid = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
const mid = (n: number) => `0190f0e2-8888-7000-8000-${String(n).padStart(12, '0')}`

const file = (n: number, name: string, extra: Partial<PanelFile> = {}): PanelFile => ({
  id: fid(n),
  name,
  kind: 'DOCUMENT',
  contentType: 'application/pdf',
  sizeBytes: 182_000 + n * 7_300,
  status: 'AVAILABLE',
  visibility: ['OFFICE'],
  partyId: null,
  retainUntil: null,
  legalHold: false,
  quarantineReason: null,
  availableAt: at(20 + (n % 7), 9 + (n % 8)),
  createdAt: at(20 + (n % 7), 9 + (n % 8)),
  ...extra,
})

const FILES: PanelFile[] = [
  file(1, 'Certificato EN 17092-3.pdf', { kind: 'CERTIFICATE', visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id, createdAt: at(27, 10), availableAt: at(27, 10) }),
  file(2, 'Certificato EN 17092-3.pdf', { kind: 'CERTIFICATE', visibility: ['OFFICE'], createdAt: at(21, 9), availableAt: at(21, 9), sizeBytes: 171_400 }),
  file(3, 'Certificato EN 17092-3.pdf', { kind: 'CERTIFICATE', visibility: ['OFFICE'], createdAt: at(14, 16), availableAt: at(14, 16), sizeBytes: 166_900 }),
  file(4, 'Rapporto di prova laboratorio.pdf', { visibility: ['OFFICE', 'FLOOR'], createdAt: at(26, 15), availableAt: at(26, 15) }),
  file(5, 'Foto etichetta campione.jpg', { kind: 'PHOTO', contentType: 'image/jpeg', sizeBytes: 2_480_000, visibility: ['OFFICE', 'LINK'], partyId: PARTY.id, createdAt: at(25, 11), availableAt: at(25, 11) }),
  file(6, 'Fattura acconto FT-2026-0042.xml', { kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', sizeBytes: 9_400, retainUntil: '2036-10-24T08:00:00.000Z', createdAt: at(24, 8), availableAt: at(24, 8) }),
  file(7, 'Dichiarazione di conformità.pdf', { legalHold: true, retainUntil: '2031-10-23T08:00:00.000Z', createdAt: at(23, 12), availableAt: at(23, 12) }),
  file(8, 'Scheda tecnica vecchia.pdf', { status: 'QUARANTINED', quarantineReason: 'checksum_mismatch', availableAt: null, createdAt: at(22, 17) }),
]

const message = (n: number, extra: Partial<PanelMessage> & Pick<PanelMessage, 'direction' | 'body'>): PanelMessage => ({
  id: mid(n),
  channel: extra.direction === 'INTERNAL_NOTE' ? 'APP' : 'EMAIL',
  authorKind: extra.direction === 'INBOUND' ? 'PARTY' : 'USER',
  authorName: extra.direction === 'INBOUND' ? 'Ufficio acquisti Marchio Demo' : 'Alex Demo',
  at: at(28, 9),
  mentions: [],
  attachments: [],
  email: null,
  ...extra,
})

const MESSAGES: PanelMessage[] = [
  message(9, { direction: 'INTERNAL_NOTE', at: at(28, 11, 40), authorName: 'Bea Esempio', body: 'Il laboratorio conferma: il rapporto definitivo arriva venerdì. Tengo io il punto con loro.', mentions: ['Alex Demo'] }),
  message(8, {
    direction: 'INBOUND',
    at: at(28, 10, 5),
    body: 'Buongiorno, grazie per il certificato aggiornato. Ci servirebbe anche la foto dell\'etichetta del campione per il nostro fascicolo tecnico.\n\nCordiali saluti\nUfficio acquisti',
  }),
  message(7, {
    direction: 'OUTBOUND',
    at: at(27, 16, 20),
    body: 'Buongiorno, in allegato il certificato EN 17092-3 aggiornato per la giacca. Restiamo a disposizione.',
    attachments: [{ id: fid(1), name: 'Certificato EN 17092-3.pdf', sizeBytes: 189_300, contentType: 'application/pdf', status: 'AVAILABLE' }],
    email: { to: ['acquisti@marchio-demo.example.com'], subject: 'Certificato EN 17092-3 aggiornato', status: 'DELIVERED' },
  }),
  message(6, {
    direction: 'INTERNAL_NOTE',
    at: at(27, 15, 2),
    body: 'Prima di inviarlo al marchio controlliamo che il numero dell\'organismo notificato sia quello giusto.',
    mentions: ['Carlo Prova', null],
    attachments: [{ id: fid(2), name: 'Certificato EN 17092-3.pdf', sizeBytes: 171_400, contentType: 'application/pdf', status: 'AVAILABLE' }],
  }),
  message(5, {
    direction: 'OUTBOUND',
    at: at(26, 9, 45),
    body: 'Vi confermiamo la ricezione della richiesta, vi aggiorniamo entro la settimana.',
    email: { to: ['acquisti@marchio-demo.example.com', 'qualita@marchio-demo.example.com'], subject: 'Richiesta certificato', status: 'QUEUED' },
  }),
  message(4, {
    direction: 'OUTBOUND',
    at: at(24, 14, 10),
    body: 'Inviamo il listino aggiornato al vecchio indirizzo indicato.',
    email: { to: ['vecchio-indirizzo@marchio-demo.example.com'], subject: 'Listino', status: 'BOUNCED' },
  }),
  message(3, { direction: 'INTERNAL_NOTE', at: at(23, 8, 30), authorName: 'Carlo Prova', body: 'Il certificato precedente scade a dicembre: serve il rinnovo.' }),
]

const TIMELINE: PanelTimelineEntry[] = [
  { kind: 'message', id: mid(9), at: at(28, 11, 40), direction: 'INTERNAL_NOTE', channel: 'APP', authorName: 'Bea Esempio', excerpt: 'Il laboratorio conferma: il rapporto definitivo arriva venerdì.', attachmentCount: 0 },
  { kind: 'message', id: mid(8), at: at(28, 10, 5), direction: 'INBOUND', channel: 'EMAIL', authorName: 'Ufficio acquisti Marchio Demo', excerpt: 'Buongiorno, grazie per il certificato aggiornato.', attachmentCount: 0 },
  { kind: 'file', id: fid(1), at: at(27, 10), name: 'Certificato EN 17092-3.pdf', fileKind: 'CERTIFICATE', status: 'AVAILABLE', visibility: ['OFFICE', 'PARTNER'] },
  {
    kind: 'change',
    id: '0190f0e2-9999-7000-8000-000000000003',
    at: at(27, 9, 30),
    action: 'compliance.certificates.issue',
    actorName: 'Alex Demo',
    actorAudience: 'OFFICE',
    status: { from: 'DRAFT', to: 'VALID' },
    fields: ['status', 'validFrom', 'validTo'],
    values: { before: { status: 'DRAFT', validFrom: null, validTo: null }, after: { status: 'VALID', validFrom: '2026-10-27', validTo: '2031-10-26' } },
    reason: null,
  },
  {
    kind: 'change',
    id: '0190f0e2-9999-7000-8000-000000000002',
    at: at(25, 14, 15),
    action: 'compliance.certificates.update',
    actorName: null,
    actorAudience: 'OFFICE',
    status: null,
    fields: ['modelReference', 'note'],
    values: null,
    reason: 'Riferimento del modello corretto dal laboratorio',
  },
  { kind: 'file', id: fid(8), at: at(22, 17), name: 'Scheda tecnica vecchia.pdf', fileKind: 'DOCUMENT', status: 'QUARANTINED', visibility: ['OFFICE'] },
  {
    kind: 'change',
    id: '0190f0e2-9999-7000-8000-000000000001',
    at: at(20, 8),
    action: 'compliance.certificates.create',
    actorName: 'Carlo Prova',
    actorAudience: 'OFFICE',
    status: { from: null, to: 'DRAFT' },
    fields: [],
    values: null,
    reason: null,
  },
]

const base: RecordPanelsViewModel = {
  record: RECORD,
  title: 'Certificato 0000-17092-A',
  party: PARTY,
  can: ALL,
  thread: { status: 'OPEN', version: 4 },
  messages: { items: MESSAGES, more: true },
  files: { items: FILES, more: false },
  uploads: [],
  timeline: { items: TIMELINE, more: false },
  timelineFilter: 'all',
  people: PEOPLE,
  me: '0190f0e2-3333-7000-8000-000000000001',
}

// ── B-W2a-40: tasks on the record, Follow / Followers, @mention (made-up people and dates) ─────────────────────────
const ME = { id: '0190f0e2-3333-7000-8000-000000000001', name: 'Alex Demo', me: true }
const tid = (n: number) => `0190f0e2-4444-7000-8000-${String(n).padStart(12, '0')}`
const TASKS: PanelTask[] = [
  { id: tid(1), title: 'Chiedere il rapporto definitivo al laboratorio', href: `/w/DEMO/home/tasks?open=${tid(1)}`, due: { date: '2026-10-27', days: -2, word: 'OVERDUE' }, assignee: ME, progress: { done: 1, total: 3 }, canChange: true },
  { id: tid(2), title: 'Inviare la foto dell\'etichetta al marchio', href: `/w/DEMO/home/tasks?open=${tid(2)}`, due: { date: '2026-10-29', days: 0, word: 'TODAY' }, assignee: { id: PEOPLE[0]!.id, name: PEOPLE[0]!.name, me: false }, progress: null, canChange: true },
  { id: tid(3), title: 'Controllare la scadenza del certificato', href: `/w/DEMO/home/tasks?open=${tid(3)}`, due: null, assignee: null, progress: null, canChange: true },
]
const tasksOf = (extra: Partial<PanelTasks> = {}): PanelTasks => ({ items: TASKS, problem: null, addHeld: null, dialog: null, undo: null, busy: false, ...extra })
const FOLLOWERS: PanelFollowers = {
  count: 4,
  me: { following: true, muted: false },
  list: [
    { userId: ME.id, name: ME.name, me: true, reason: 'CREATOR', muted: false, since: at(14, 9), addedBy: null },
    { userId: PEOPLE[0]!.id, name: PEOPLE[0]!.name, me: false, reason: 'ASSIGNEE', muted: false, since: at(27, 16), addedBy: null },
    { userId: PEOPLE[1]!.id, name: PEOPLE[1]!.name, me: false, reason: 'MENTIONED', muted: true, since: at(28, 11), addedBy: null },
    { userId: '0190f0e2-3333-7000-8000-000000000005', name: 'Elio Fittizio', me: false, reason: 'CHOSE', muted: false, since: at(28, 15), addedBy: PEOPLE[0]!.name },
  ],
  candidates: [PEOPLE[2]!],
  canAdd: true,
  problem: null,
  busy: false,
}
const w2a = { ...base, tasks: tasksOf(), followers: FOLLOWERS }

export const designScreen = defineDesignScreen<RecordPanelsViewModel>({
  screen: 'SCR-006',
  title: 'Record panels: thread, files, history',
  view: RecordPanelsView,
  cases: [
    {
      id: 'empty',
      label: 'Empty record',
      model: { ...base, thread: null, messages: { items: [], more: false }, files: { items: [], more: false }, timeline: { items: [], more: false } },
      note: 'A new record: no message, no file. The composer offers an internal note or an email to the brand.',
    },
    {
      id: 'conversation',
      label: 'Many messages: internal vs shared',
      model: base,
      note: 'Internal notes (lock, grey edge) and mail with the brand (blue edge: sent, delivered, waiting, bounced; a reply). Mentions, attachments, "Show older".',
    },
    {
      id: 'email',
      label: 'Composer: email to the party',
      model: { ...base, composerMode: 'email', composerText: 'Buongiorno, vi inviamo la foto dell\'etichetta richiesta.' },
      note: 'To prefilled with the brand\'s address. Only files already shared with the brand can be attached.',
    },
    {
      id: 'no-party',
      label: 'Record without a party',
      model: {
        ...base,
        record: { type: 'Company', id: DEMO_COMPANIES[0].id, companyId: DEMO_COMPANIES[0].id, siteId: null },
        title: DEMO_COMPANIES[0].name,
        party: null,
        messages: { items: MESSAGES.filter((item) => item.direction === 'INTERNAL_NOTE'), more: false },
      },
      note: 'Only internal notes: a record without a customer or supplier has no email.',
    },
    {
      id: 'read-only',
      label: 'Read only',
      model: { ...base, can: { post: false, email: false, manage: false, readFiles: true, upload: false, share: false } },
      note: 'Someone who reads the thread: no composer, no upload; files open.',
    },
    {
      id: 'closed',
      label: 'Closed thread',
      model: { ...base, thread: { status: 'CLOSED', version: 5 } },
      note: 'Nobody writes in a closed thread; a manager reopens it (version-guarded: a conflict reloads it).',
    },
    {
      id: 'files',
      label: 'Files: versions, audiences, retention',
      model: { ...base, tab: 'files' },
      note: 'Versions of one certificate; office only, floor, portal and link; a fiscal file kept ten years; a legal hold; a quarantined file.',
    },
    {
      id: 'uploading',
      label: 'Upload in progress',
      model: {
        ...base,
        tab: 'files',
        uploads: [
          { key: 'u1', name: 'Rapporto di prova finale.pdf', sizeBytes: 1_204_000, phase: 'uploading' },
          { key: 'u2', name: 'Foto cucitura.heic', sizeBytes: 3_900_000, phase: 'hashing' },
          { key: 'u3', name: 'Dichiarazione firmata.pdf', sizeBytes: 240_000, phase: 'confirming' },
          { key: 'u4', name: 'Macro listino.xlsm', sizeBytes: 80_000, phase: 'failed', problem: 'files.problem.type' },
        ],
      },
      note: 'Each upload says where it is; a refused one says why.',
    },
    {
      id: 'quarantined',
      label: 'Quarantined file notice',
      model: { ...base, tab: 'files', notice: { key: 'files.notice.quarantined', tone: 'danger' } },
    },
    {
      id: 'pdf-preview',
      label: 'PDF viewer',
      model: {
        ...base,
        tab: 'files',
        preview: { fileId: fid(1), name: 'Certificato EN 17092-3.pdf', src: demoPdf(['Certificato di esempio', 'EN 17092-3 - Classe A', 'Organismo notificato 0000 (inventato)', 'Dati inventati per il design']) },
      },
      note: 'The design system\'s PDF viewer with this app\'s pdf.js.',
    },
    {
      id: 'history',
      label: 'History',
      model: { ...base, tab: 'history' },
      note: 'Messages, changes and files in one feed. A change shows values only when the API gives them (audit.read).',
    },
    {
      id: 'history-changes',
      label: 'History: changes only',
      model: { ...base, tab: 'history', timelineFilter: 'change', timeline: { items: TIMELINE.filter((entry) => entry.kind === 'change'), more: true } },
    },
    {
      id: 'note-added',
      label: 'Note added',
      model: { ...base, notice: { key: 'notice.noteAdded', tone: 'success' } },
    },
    {
      id: 'loading',
      label: 'Loading',
      model: { ...base, thread: null, messages: { items: null, more: false }, files: { items: null, more: false }, timeline: { items: null, more: false } },
    },
    {
      id: 'tasks',
      label: 'W2a · Tasks on this record',
      model: { ...w2a, tab: 'tasks' },
      note: 'Open tasks with their due day in words (overdue, today, none), whose it is and the checklist; a tick marks one done with Undo; "+ Add task". Follow and Followers (4) above the tabs.',
    },
    {
      id: 'tasks-done-undo',
      label: 'W2a · A task ticked done (Undo)',
      model: { ...w2a, tab: 'tasks', tasks: tasksOf({ items: TASKS.slice(1), undo: { title: TASKS[0]!.title } }) },
    },
    {
      id: 'tasks-none',
      label: 'W2a · No open tasks',
      model: { ...w2a, tab: 'tasks', tasks: tasksOf({ items: [] }) },
    },
    {
      id: 'tasks-held',
      label: 'W2a · Read-only person (tasks held)',
      model: { ...w2a, tab: 'tasks', can: { ...ALL, post: false, email: false }, tasks: tasksOf({ addHeld: 'tasks.held.noPost', items: TASKS.map((task) => ({ ...task, canChange: false })) }), followers: { ...FOLLOWERS, me: { following: false, muted: false }, canAdd: false } },
      note: '"+ Add task" and the ticks say why they are held; Follow is still open to them (threads.read), adding a colleague is not.',
    },
    {
      id: 'task-new',
      label: 'W2a · New task on this record',
      model: { ...w2a, tab: 'tasks', tasks: tasksOf({ dialog: { people: { status: 'ready', data: [ME, ...PEOPLE.slice(0, 2).map((person) => ({ ...person, me: false }))] } } }) },
      note: 'Title, for whom (people who keep tasks here and may see the record; me by default), due day, checklist one per line, description. ⌘Enter creates.',
    },
    {
      id: 'tasks-error',
      label: 'W2a · Tasks could not be read',
      model: { ...w2a, tab: 'tasks', tasks: tasksOf({ items: null, problem: 'tasks.problem.offline' }) },
    },
    {
      id: 'followers',
      label: 'W2a · Followers (4)',
      model: { ...w2a, followers: { ...FOLLOWERS, open: true } },
      note: 'Who follows and why (made it, was given something on it, was mentioned, chose to; added by), muted ones marked; Unfollow / Mute for me; add a colleague who may read the record.',
    },
    {
      id: 'mention-typed',
      label: 'W2a · @mention typed in a note',
      model: { ...w2a, composerText: 'Il laboratorio ha confermato. @Bea Esempio puoi inviare la foto? @Car' },
      note: 'A colleague named after @ is mentioned (told, and follows the record); the word being typed offers whom it names.',
    },
    {
      id: 'error',
      label: 'Could not be read',
      model: { ...base, messages: { items: null, more: false, problem: 'panels.problem.unavailable' }, notice: { key: 'notice.statusConflict', tone: 'warning' } },
      note: 'A failed read with Try again; an edit conflict notice (COL-078).',
    },
  ],
})
