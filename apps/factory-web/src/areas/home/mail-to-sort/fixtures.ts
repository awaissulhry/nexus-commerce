import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { MailDetail, MailSummary, MailToSortViewModel, RecordCandidate, Verdicts } from './model'
import { MailToSortView } from './view/MailToSortView'

/**
 * SCR-019 Mail to sort — made-up mail only (PLAN §3.1): invented senders at example.com domains, invented records. Each
 * case is one state the Owner reviews: the list, nothing to sort, a held mail (with its checks, its pictures blocked
 * and its attachments), a mail without a record being assigned, a mail that could not be read, the release and the
 * reject dialogs, read only, loading, an error and an edit conflict.
 */

const PASS: Verdicts = { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', dmarcPolicy: null, spam: 'PASS', virus: 'PASS' }
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const id = (n: number) => `0190f0e2-aaaa-7000-8000-${String(n).padStart(12, '0')}`

const summary = (n: number, extra: Partial<MailSummary> & Pick<MailSummary, 'status'>): MailSummary => ({
  id: id(n),
  receivedAt: at(28, 8 + n),
  from: { address: `ordini@cliente-${n}.example.com`, name: `Cliente Demo ${n}` },
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
  summary(9, {
    status: 'HELD',
    heldReason: 'DMARC_FAIL',
    from: { address: 'amministrazione@marchio-demo.example.net', name: 'Marchio Demo' },
    subject: 'Nuove coordinate bancarie',
    excerpt: 'Gentile cliente, da oggi i pagamenti vanno sul nuovo conto indicato in allegato.',
    verdicts: { ...PASS, spf: 'FAIL', dmarc: 'FAIL', dmarcPolicy: 'reject' },
    threadId: '0190f0e2-bbbb-7000-8000-000000000001',
    attachmentCount: 2,
  }),
  summary(8, {
    status: 'TRIAGE',
    from: { address: 'buyer@negozio-esempio.example.com', name: 'Giulia Esempio' },
    subject: 'Preventivo 200 giacche in pelle',
    excerpt: 'Buongiorno, vorremmo un preventivo per 200 giacche taglie 46–56, consegna a febbraio.',
    suggestedPartyId: '0190f0e2-6666-7000-8000-000000000002',
    attachmentCount: 1,
  }),
  summary(7, {
    status: 'HELD',
    heldReason: 'UNKNOWN_SENDER',
    from: { address: 'nuovo.contatto@marchio-demo.example.com', name: null },
    subject: 'Re: Certificato EN 17092-3 aggiornato',
    excerpt: 'Grazie, ricevuto. Potete mandarci anche la dichiarazione di conformità?',
    threadId: '0190f0e2-bbbb-7000-8000-000000000002',
  }),
  summary(6, {
    status: 'HELD',
    heldReason: 'SPAM',
    from: { address: 'offerte@promo.example.org', name: 'Super Offerte' },
    subject: 'Solo oggi: macchine da cucire al 70%',
    excerpt: 'Approfitta subito di questa offerta irripetibile…',
    verdicts: { ...PASS, spam: 'FAIL' },
  }),
  summary(5, {
    status: 'HELD',
    heldReason: 'THREAD_CLOSED',
    from: { address: 'qualita@fornitore-demo.example.com', name: 'Fornitore Demo' },
    subject: 'Re: Lotto pellame 2026-114',
    excerpt: 'Vi giriamo il rapporto di prova del lotto, come chiesto.',
    threadId: '0190f0e2-bbbb-7000-8000-000000000003',
    attachmentCount: 1,
  }),
  summary(4, { status: 'FAILED', from: { address: 'scanner@sede.example.com', name: null }, subject: null, excerpt: '' }),
  summary(3, { status: 'TRIAGE', from: { address: 'info@associazione.example.org', name: 'Associazione Demo' }, subject: 'Newsletter di ottobre', excerpt: 'Le novità del mese per il settore moda e pelletteria.' }),
]

const HTML = [
  '<p>Gentile cliente,</p>',
  '<p>da oggi i pagamenti delle nostre fatture vanno sul <b>nuovo conto</b> indicato nel documento allegato.</p>',
  '<p><img data-remote-src="https://images.example.com/firma.png" alt="Firma"> <img data-remote-src="https://images.example.com/logo.png" alt="Logo"></p>',
  '<p>Cordiali saluti<br>Amministrazione</p>',
  '<p><a href="https://example.com/conferma" target="_blank" rel="noopener noreferrer nofollow">Conferma i dati</a></p>',
].join('')

const HELD_DETAIL: MailDetail = {
  ...MAILS[0],
  to: ['ordini@reply.officina-demo.example.com'],
  cc: ['amministrazione@officina-demo.example.com'],
  bodyText: 'Gentile cliente, da oggi i pagamenti delle nostre fatture vanno sul nuovo conto indicato nel documento allegato.',
  bodyHtml: HTML,
  attachments: [
    { name: 'Coordinate bancarie.pdf', contentType: 'application/pdf', sizeBytes: 84_000, kept: true, skipReason: null, fileId: '0190f0e2-cccc-7000-8000-000000000001' },
    { name: 'verifica.html', contentType: 'text/html', sizeBytes: 3_200, kept: false, skipReason: 'type_not_allowed', fileId: null },
    { name: 'logo.png', contentType: 'image/png', sizeBytes: 12_000, kept: false, skipReason: 'inline', fileId: null },
  ],
  thread: { recordType: 'Certificate', recordId: '0190f0e2-5555-7000-8000-000000000001', status: 'OPEN' },
  attempts: 1,
  fetchedAt: at(28, 17, 1),
}

const TRIAGE_DETAIL: MailDetail = {
  ...MAILS[1],
  to: ['ordini@officina-demo.example.com'],
  cc: [],
  bodyText: 'Buongiorno,\n\nvorremmo un preventivo per 200 giacche in pelle, taglie 46–56, con il nostro marchio. Consegna entro febbraio.\n\nGrazie\nGiulia Esempio\nNegozio Esempio',
  bodyHtml: null,
  attachments: [{ name: 'Scheda modello.pdf', contentType: 'application/pdf', sizeBytes: 412_000, kept: true, skipReason: null, fileId: '0190f0e2-cccc-7000-8000-000000000002' }],
  thread: null,
  attempts: 1,
  fetchedAt: at(28, 16, 2),
}

const FAILED_DETAIL: MailDetail = { ...MAILS[5], to: ['ordini@officina-demo.example.com'], cc: [], bodyText: null, bodyHtml: null, attachments: [], thread: null, attempts: 5, fetchedAt: null }
const SPAM_DETAIL: MailDetail = { ...MAILS[3], to: ['ordini@officina-demo.example.com'], cc: [], bodyText: 'Approfitta subito di questa offerta irripetibile: macchine da cucire al 70%.', bodyHtml: null, attachments: [], thread: null, attempts: 1, fetchedAt: at(28, 14, 1) }

const CANDIDATES: RecordCandidate[] = [
  { type: 'Quote', id: '0190f0e2-dddd-7000-8000-000000000001', number: 'OF-2026/0042', title: 'Negozio Esempio', hasParty: true },
  { type: 'SalesOrder', id: '0190f0e2-dddd-7000-8000-000000000002', number: 'OV-2026/0017', title: 'Negozio Esempio', hasParty: true },
  { type: 'PurchaseOrder', id: '0190f0e2-dddd-7000-8000-000000000003', number: 'OA-2026/0103', title: 'Conceria Demo', hasParty: true },
  { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000001', number: '0000-17092-A', title: 'EN 17092-3:2020 · A', hasParty: true },
  { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000002', number: '0000-17092-AA', title: 'EN 17092-2:2020 · AA', hasParty: true },
  { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000003', number: '0000-1621-2', title: 'EN 1621-1:2012 · 2', hasParty: false },
]

const base: MailToSortViewModel = {
  filter: 'all',
  mails: { items: MAILS, more: false },
  open: null,
  canWrite: true,
  canReadFiles: true,
  assign: { candidates: CANDIDATES },
}

export const designScreen = defineDesignScreen<MailToSortViewModel>({
  screen: 'SCR-019',
  title: 'Mail to sort',
  view: MailToSortView,
  cases: [
    { id: 'list', label: 'Mail to sort', model: base, note: 'Held (each reason), no record, not read. A row opens the mail.' },
    { id: 'empty', label: 'Nothing to sort', model: { ...base, mails: { items: [], more: false } } },
    {
      id: 'held',
      label: 'Held mail (DMARC failed)',
      model: { ...base, open: { id: HELD_DETAIL.id, detail: HELD_DETAIL } },
      note: 'Why it is held, its checks, the sanitised mail in a sandboxed frame with remote pictures blocked, kept and skipped attachments.',
    },
    {
      id: 'held-pictures',
      label: 'Held mail, pictures shown',
      model: { ...base, open: { id: HELD_DETAIL.id, detail: HELD_DETAIL }, showPictures: true },
      note: 'The person allowed the pictures (https only; the made-up ones do not load).',
    },
    {
      id: 'release',
      label: 'Release a held mail',
      model: { ...base, open: { id: HELD_DETAIL.id, detail: HELD_DETAIL }, dialog: 'release' },
      note: 'Into the thread it answers; a failed check warns first.',
    },
    { id: 'triage', label: 'Mail without a record', model: { ...base, filter: 'TRIAGE', mails: { items: MAILS.filter((mail) => mail.status === 'TRIAGE'), more: false }, open: { id: TRIAGE_DETAIL.id, detail: TRIAGE_DETAIL } } },
    {
      id: 'assign',
      label: 'Assign to a record',
      model: { ...base, open: { id: TRIAGE_DETAIL.id, detail: TRIAGE_DETAIL }, dialog: 'assign' },
      note: 'Find the record by its number; records without a customer or supplier are not offered.',
    },
    {
      id: 'reject',
      label: 'Throw away (spam)',
      model: { ...base, open: { id: SPAM_DETAIL.id, detail: SPAM_DETAIL }, dialog: 'reject' },
    },
    { id: 'failed', label: 'Mail that could not be read', model: { ...base, open: { id: FAILED_DETAIL.id, detail: FAILED_DETAIL } }, note: 'Only throwing it away is possible.' },
    {
      id: 'read-only',
      label: 'Read only (no thread writing)',
      model: { ...base, canWrite: false, open: { id: HELD_DETAIL.id, detail: HELD_DETAIL } },
      note: 'Assign and release are held and say why; throwing away stays.',
    },
    { id: 'conflict', label: 'Sorted meanwhile', model: { ...base, notice: { key: 'mailToSort.notice.conflict', tone: 'warning' } }, note: 'COL-078: the version moved; the mail was read again.' },
    { id: 'assigned', label: 'Assigned', model: { ...base, mails: { items: MAILS.slice(2), more: true }, notice: { key: 'mailToSort.notice.assigned', tone: 'success' } } },
    { id: 'loading', label: 'Loading', model: { ...base, mails: { items: null, more: false } } },
    { id: 'error', label: 'Could not be read', model: { ...base, mails: { items: null, more: false, problem: 'mailToSort.problem.unavailable' } } },
  ],
})
