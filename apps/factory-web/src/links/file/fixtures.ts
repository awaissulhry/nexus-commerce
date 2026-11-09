import { defineDesignScreen } from '../../lib/design/design-screen'
import type { LinkRenew, RenewState } from '../../shell/links/renew/model'
import { emptyModel, type FilePage, type PageFile } from './model'
import { FileLinkView, type FileLinkDesignModel } from './view/FileLinkView'

/**
 * SCR-272 Secure file (design links.file; the plan's SCR-200 is W1's Hides on main, so the next free id; MES-274, LOG-124;
 * B-W2b-169) — made-up data only (PLAN §3.1): a made-up
 * workshop "Officina Demo" sends a made-up labour consultant three office files (a tech pack, a cutting plan, a fabric
 * sheet) by a SECURE_FILE link with a password sent apart, five downloads, the receipt asked; and the payroll file of
 * October 2026 by its DOCUMENT_VIEW link (B-W2b-54: the hours file and its summary, no pay figures). Phone first: open a
 * case with `?width=phone`. Each case is one state the person can meet.
 */

const SENDER = 'Officina Demo'
const NOW = '2026-11-09T09:45:00.000Z'
const uid = (n: number) => `0190f0e2-7169-7000-8000-${String(n).padStart(12, '0')}`
const sha = (n: number) => `${n}f2a9c1e77b04d5e6a8c3b2f1e0d9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a3`.slice(0, 64).padEnd(64, '0')

const file = (n: number, over: Partial<PageFile> = {}): PageFile => ({
  id: uid(n),
  position: n,
  name: `file-${n}.pdf`,
  sizeBytes: 182_311,
  sha256: sha(n),
  contentType: 'application/pdf',
  preview: false,
  available: true,
  newer: null,
  payrollKind: null,
  ...over,
})

const TECH_PACK = file(1, { name: 'Scheda tecnica DEMO-JKT-01.pdf', sizeBytes: 2_480_112 })
const CUT_PLAN = file(2, { name: 'Piano di taglio DEMO-JKT-01.xlsx', sizeBytes: 48_201, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
const FABRIC = file(3, { name: 'Scheda tessuto DEMO-MESH.pdf', sizeBytes: 311_904 })

const secure = (over: Partial<FilePage> = {}): FilePage => ({
  kind: 'secure',
  sender: SENDER,
  expiresAt: '2026-11-16T17:00:00.000Z',
  usesLeft: 5,
  password: { asked: true, unlocked: true, heldUntil: null },
  receipt: { asked: true, at: null, name: null },
  count: 3,
  files: [TECH_PACK, CUT_PLAN, FABRIC],
  payroll: null,
  ...over,
})

const lockedPage = (over: Partial<FilePage> = {}) => secure({ password: { asked: true, unlocked: false, heldUntil: null }, files: [], ...over })

const PAYROLL: FilePage = {
  kind: 'payroll',
  sender: 'Officina Demo S.r.l.',
  expiresAt: '2026-12-09T17:00:00.000Z',
  usesLeft: 18,
  password: { asked: false, unlocked: false, heldUntil: null },
  receipt: { asked: false, at: null, name: null },
  count: 2,
  files: [
    file(11, { name: 'PAGHE-2026-10-OFFDEMO.txt', sizeBytes: 9_812, contentType: 'application/octet-stream', payrollKind: 'DATA' }),
    file(12, { name: 'Riepilogo ore ottobre 2026.pdf', sizeBytes: 61_407, payrollKind: 'SUMMARY', position: 2 }),
  ],
  payroll: { month: '2026-10', number: 'PAY-2026-0010', revision: 1 },
}

const renew = (state: RenewState = 'idle', waitUntil: string | null = null): LinkRenew => ({ state, waitUntil, ask: () => undefined })

const model = (over: Partial<FileLinkDesignModel> = {}): FileLinkDesignModel => ({ ...emptyModel(), link: 'valid', page: secure(), now: NOW, renew: renew(), ...over })

export const designScreen = defineDesignScreen<FileLinkDesignModel>({
  screen: 'SCR-272',
  title: 'Secure file (link): the password, the files, Download all, the receipt; the payroll file',
  view: FileLinkView,
  cases: [
    {
      id: 'password',
      label: 'The password first: three files wait (sent apart, never in the e-mail)',
      model: model({ page: lockedPage() }),
      note: 'SECURE_FILE with a password: GET /link/files lists nothing until POST /link/password answers the unlock key.',
    },
    { id: 'password-shown', label: 'Password typed and shown', model: model({ page: lockedPage(), password: { value: 'demo-pass-2026', shown: true, busy: false, problem: null } }) },
    { id: 'password-checking', label: 'Checking the password', model: model({ page: lockedPage(), password: { value: 'demo-pass-2026', shown: false, busy: true, problem: null } }) },
    { id: 'password-wrong', label: 'Wrong password: 3 tries left', model: model({ page: lockedPage(), password: { value: 'not-the-one', shown: false, busy: false, problem: { kind: 'wrong', triesLeft: 3 } } }) },
    { id: 'password-last-try', label: 'Wrong password: the last try before the hold', model: model({ page: lockedPage(), password: { value: 'not-the-one', shown: false, busy: false, problem: { kind: 'wrong', triesLeft: 1 } } }) },
    { id: 'password-empty', label: 'Open pressed with nothing typed', model: model({ page: lockedPage(), password: { value: '', shown: false, busy: false, problem: { kind: 'empty' } } }) },
    {
      id: 'password-held',
      label: 'Five wrong passwords: held until 10:57 (form read-only, the button says why)',
      model: model({ page: lockedPage(), password: { value: 'not-the-one', shown: false, busy: false, problem: { kind: 'held', until: '2026-11-09T09:57:00.000Z' } } }),
    },
    { id: 'password-held-arrival', label: 'Held on arrival (another try held the link)', model: model({ page: lockedPage({ password: { asked: true, unlocked: false, heldUntil: '2026-11-09T09:57:00.000Z' } }) }) },
    { id: 'password-relock', label: 'The 30 minutes passed: type the password again', model: model({ page: lockedPage(), password: { value: '', shown: false, busy: false, problem: { kind: 'relock' } } }) },
    { id: 'password-failed', label: 'The password did not reach us', model: model({ page: lockedPage(), password: { value: 'demo-pass-2026', shown: false, busy: false, problem: { kind: 'failed' } } }) },
    {
      id: 'files',
      label: 'Open: three files, 5 downloads left, Download all uses 3 (the receipt below)',
      model: model(),
      note: 'Name · size · checksum short · Download. Never shown in the browser (no Read it here on a secure file).',
    },
    { id: 'no-password', label: 'No password set: the files at once', model: model({ page: secure({ password: { asked: false, unlocked: false, heldUntil: null } }) }) },
    { id: 'one-file', label: 'One file: its Download is the primary', model: model({ page: secure({ count: 1, files: [TECH_PACK] }) }) },
    { id: 'downloading-all', label: 'Download all: 1 of 3 done', model: model({ all: { busy: true, done: 1, of: 3 }, downloads: { [TECH_PACK.id]: 'done', [CUT_PLAN.id]: 'busy' }, page: secure({ usesLeft: 4 }) }) },
    { id: 'downloaded', label: 'All three downloaded: 2 downloads left', model: model({ all: { busy: false, done: 3, of: 3 }, downloads: { [TECH_PACK.id]: 'done', [CUT_PLAN.id]: 'done', [FABRIC.id]: 'done' }, page: secure({ usesLeft: 2 }) }) },
    { id: 'uses-short', label: 'Two downloads left for three files: Download all held with why', model: model({ page: secure({ usesLeft: 2 }) }) },
    { id: 'last-download', label: 'One download left: the page says it is the last (confirm receipt first)', model: model({ page: secure({ usesLeft: 1 }) }) },
    { id: 'download-failed', label: 'A download did not complete: Try again', model: model({ downloads: { [CUT_PLAN.id]: 'failed' } }) },
    { id: 'file-gone', label: 'A file no longer available: ask the sender', model: model({ page: secure({ files: [TECH_PACK, { ...CUT_PLAN, available: false }, FABRIC] }) }) },
    { id: 'receipt-typed', label: 'The receipt with a name typed', model: model({ receipt: { name: 'Studio Demo', busy: false, failed: false } }) },
    { id: 'receipt-failed', label: 'The receipt did not reach us', model: model({ receipt: { name: 'Studio Demo', busy: false, failed: true } }) },
    {
      id: 'receipt-done',
      label: 'Receipt confirmed: the sender sees "Received by Studio Demo at 10:42"',
      model: model({ page: secure({ receipt: { asked: true, at: '2026-11-09T09:42:00.000Z', name: 'Studio Demo' } }) }),
    },
    {
      id: 'used',
      label: 'The page’s own last download used the link up: the end, Ask for a new link',
      model: model({ link: 'used', downloads: { [TECH_PACK.id]: 'done', [FABRIC.id]: 'done' }, page: secure({ usesLeft: 0, receipt: { asked: true, at: '2026-11-09T09:42:00.000Z', name: null } }) }),
    },
    { id: 'used-asked', label: 'Used up · a new link asked', model: model({ link: 'used', downloads: { [TECH_PACK.id]: 'done' }, page: secure({ usesLeft: 0 }), renew: renew('done') }) },
    {
      id: 'payroll',
      label: 'The payroll file of October 2026: the hours file and its summary (no pay figures)',
      model: model({ page: PAYROLL }),
      note: 'DOCUMENT_VIEW of a PayrollExport (B-W2b-54’s routes): each download counts; no password, no receipt.',
    },
    { id: 'payroll-correction', label: 'The payroll file, correction 2', model: model({ page: { ...PAYROLL, payroll: { month: '2026-10', number: 'PAY-2026-0010', revision: 2 } } }) },
    { id: 'payroll-downloaded', label: 'The payroll data file downloaded', model: model({ page: { ...PAYROLL, usesLeft: 17 }, downloads: { [uid(11)]: 'done' } }) },
    { id: 'expired', label: 'Expired while open: the frame’s end with Ask for a new link', model: model({ link: 'expired', expiredAt: '2026-11-16T17:00:00.000Z' }) },
    { id: 'unavailable', label: 'Withdrawn or used up meanwhile (the one 404)', model: model({ link: 'unavailable', page: null }) },
    { id: 'unavailable-asked', label: 'Opens nothing · a new link asked', model: model({ link: 'unavailable', page: null, renew: renew('done') }) },
    { id: 'loading', label: 'Loading: the shape of the content', model: model({ link: 'loading', page: null }) },
    { id: 'loading-slow', label: 'Still loading after a second', model: model({ link: 'loading', page: null, slow: true }) },
    { id: 'error', label: 'The files could not be read: Try again (never drawn as empty)', model: model({ link: 'error', page: null }) },
  ],
})
