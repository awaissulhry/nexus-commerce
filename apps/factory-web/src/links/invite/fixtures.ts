import { defineDesignScreen } from '../../lib/design/design-screen'
import type { ShareMessage, SharePage } from './api'
import { START, type InviteViewModel } from './model'
import { InviteView } from './view/InviteView'

/**
 * SCR-270 — Join a record (design links.invite: sec:why, sec:summary, sec:files, sec:thread, sec:notify, tab:file; B-W2b-200;
 * COL-061, COL-062), MADE-UP data only (Studio Demo invites an invented brand designer to order SO-2026-0042): what the person
 * may do (read · write · upload) and until when, the order's shared fields, the shared files with Open and Upload, the thread
 * with ⌘Enter, "E-mail me"; read only (writing and upload held with the reason), comment only, a closed conversation, nothing
 * shared yet, an upload on its way and refused, earlier messages, the last day, a narrowed share caught on send, loading, a
 * failed read, and the dead link (withdrawn or ended). Measure at 390 first.
 */

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-10T09:00:00.000Z')
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const id = (n: number) => `0190f0e2-8200-7000-8000-${String(n).padStart(12, '0')}`

const message = (n: number, over: Partial<ShareMessage>): ShareMessage => ({
  id: id(100 + n),
  side: 'COMPANY',
  channel: 'EMAIL',
  author: { name: 'Carlo Prova', mine: false },
  body: '',
  attachments: [],
  at: at(-48 + n),
  ...over,
})

const MESSAGES: ShareMessage[] = [
  message(5, { side: 'PARTNER', channel: 'PORTAL', author: { name: 'Dana Esempio', mine: true }, body: 'Il collo va bene così. Allego lo schizzo con la tasca spostata di 1 cm.', attachments: [{ id: id(203), kind: 'ATTACHMENT', originalName: 'schizzo-tasca.pdf', contentType: 'application/pdf', sizeBytes: 241_664 }] }),
  message(3, { side: 'PARTNER', channel: 'EMAIL', author: { name: 'Marco Esempio', mine: false }, body: 'Ricevuto, grazie. Dana ci dice la sua sul collo entro domani.' }),
  message(1, { body: 'Buongiorno, vi mandiamo le foto del campione della giacca, taglia 48. Il collo è stato ridotto come chiesto.', attachments: [{ id: id(201), kind: 'PHOTO', originalName: 'campione-fronte.jpg', contentType: 'image/jpeg', sizeBytes: 184_320 }] }),
]

function page(over: { share?: Partial<SharePage['share']>; thread?: Partial<SharePage['thread']>; upload?: Partial<SharePage['upload']>; files?: SharePage['files'] } = {}): SharePage {
  return {
    share: { id: id(1), permissions: ['VIEW', 'COMMENT', 'UPLOAD'], notifyByEmail: true, expiresAt: at(20 * 24), invitedAt: at(-72), invitedBy: 'Carlo Prova', version: 2, ...over.share },
    from: { companyName: 'Studio Demo' },
    record: {
      type: 'SalesOrder',
      reference: 'SO-2026-0042',
      theirRef: 'PO-77/2026',
      fields: [
        { key: 'number', kind: 'text', value: 'SO-2026-0042' },
        { key: 'theirRef', kind: 'text', value: 'PO-77/2026' },
        { key: 'status', kind: 'code', value: 'IN_PRODUCTION' },
        { key: 'orderDate', kind: 'date', value: '2026-10-28' },
        { key: 'requestedDate', kind: 'date', value: '2026-12-05' },
        { key: 'promiseDate', kind: 'date', value: null },
      ],
    },
    files: over.files ?? [
      { id: id(201), kind: 'PHOTO', originalName: 'campione-fronte.jpg', contentType: 'image/jpeg', sizeBytes: 184_320, at: at(-48), mine: false },
      { id: id(202), kind: 'DOCUMENT', originalName: 'scheda-tecnica-giacca-48.pdf', contentType: 'application/pdf', sizeBytes: 1_203_712, at: at(-47), mine: false },
      { id: id(203), kind: 'ATTACHMENT', originalName: 'schizzo-tasca.pdf', contentType: 'application/pdf', sizeBytes: 241_664, at: at(-43), mine: true },
    ],
    thread: { status: 'OPEN', shared: true, messages: MESSAGES, nextCursor: null, canPost: true, held: null, replyByEmail: true, ...over.thread },
    upload: { canUpload: true, held: null, contentTypes: ['application/pdf', 'image/jpeg', 'image/png', 'text/csv', 'text/plain'], maxBytes: 25 * 1_048_576, ...over.upload },
    locale: 'it',
  }
}

const base = (over: Partial<InviteViewModel> = {}): InviteViewModel => ({ ...START, page: page(), now: NOW, timeZone: 'Europe/Rome', ...over })
const readOnly = page({ share: { permissions: ['VIEW'] }, thread: { canPost: false, held: 'NO_COMMENT' }, upload: { canUpload: false, held: 'NO_UPLOAD' } })

export const designScreen = defineDesignScreen<InviteViewModel>({
  screen: 'SCR-270',
  title: 'Join a record (links.invite)',
  view: InviteView,
  cases: [
    { id: 'record', label: 'Read, write and upload', model: base(), note: 'Why you are here (who invited you, what you can do, until when), the order’s shared fields only, the shared files with Open (a new tab) and Add files, the thread (⌘Enter sends), E-mail me. No price anywhere.' },
    { id: 'writing', label: 'A message being written', model: base({ draft: 'Va bene anche il colore della fodera.' }) },
    { id: 'posting', label: 'Sending a message', model: base({ draft: 'Va bene anche il colore della fodera.', posting: true }) },
    { id: 'attaching', label: 'A shared file goes with the message', model: base({ draft: 'Le misure sono nella scheda, pagina 2.', attached: [id(202)] }), note: 'Post, attach: only the record’s files shared with the person can be ticked.' },
    { id: 'read-only', label: 'Read only', model: base({ page: readOnly }), note: 'Writing and Add files are held with the reason; nothing is drawn as disabled.' },
    { id: 'comment-only', label: 'Read and write, no uploads', model: base({ page: page({ share: { permissions: ['VIEW', 'COMMENT'] }, upload: { canUpload: false, held: 'NO_UPLOAD' } }) }) },
    { id: 'narrowed', label: 'The share was narrowed a moment ago', model: base({ page: readOnly, draft: 'Ancora una cosa.', postProblem: { key: 'held.NO_COMMENT' } }), note: 'The office took writing away while the message was being written: the page says so and reads the share again.' },
    { id: 'closed', label: 'The conversation was closed', model: base({ page: page({ thread: { status: 'CLOSED', canPost: false, held: 'CLOSED' } }) }) },
    { id: 'empty', label: 'Nothing shared yet', model: base({ page: page({ files: [], thread: { messages: [], replyByEmail: false } }) }) },
    { id: 'uploading', label: 'A file on its way', model: base({ upload: { busy: true, name: 'misure-campione.pdf', problem: null, done: null } }) },
    { id: 'uploaded', label: 'A file added', model: base({ upload: { busy: false, name: 'misure-campione.pdf', problem: null, done: { key: 'files.uploaded', params: { name: 'misure-campione.pdf' } } } }) },
    { id: 'upload-refused', label: 'A file refused', model: base({ upload: { busy: false, name: 'video.mov', problem: { key: 'files.problem.type' }, done: null } }) },
    { id: 'upload-closed', label: 'Uploads closed (no virus scanner yet)', model: base({ upload: { busy: false, name: 'misure.pdf', problem: { key: 'files.problem.closed' }, done: null } }) },
    { id: 'opening', label: 'Opening a file in a new tab', model: base({ opening: id(202) }) },
    { id: 'earlier', label: 'Earlier messages to load', model: base({ cursor: 'cursor-demo' }) },
    { id: 'notify-off', label: 'E-mail me switched off', model: base({ page: page({ share: { notifyByEmail: false } }) }) },
    { id: 'last-day', label: 'The last day of the invitation', model: base({ page: page({ share: { expiresAt: at(6) } }) }) },
    { id: 'loading', label: 'Loading', model: base({ page: null }) },
    { id: 'error', label: 'The record could not be read', model: base({ page: null, problem: 'problem.read' }) },
    { id: 'withdrawn', label: 'The invitation was withdrawn or ended', model: base({ link: 'unavailable', page: null }), note: 'The frame’s dead link: whom to ask (a new invitation is the office’s).' },
    { id: 'expired', label: 'The link expired', model: base({ link: 'expired', page: null }) },
  ],
})
