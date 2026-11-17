import { defineDesignScreen } from '../../design/design-screen'
import { demoPdf } from '../../../shell/design-data'
import { BRAND_ALPHA } from '../../testing/two-brands'
import type { ViewerFile } from './model'
import { PopupsCase, type PopupsCaseModel } from './view/PopupsCase'

/**
 * SCR-006-popups — the thread's shared pop-ups (B-TH-211, threads plan T-POP; picture 10, drawn to the approved pictures'
 * look): the one file viewer (a photo through the DS Lightbox, PDF pages through the DS PdfViewer, a card for a file it
 * cannot draw, a held file), the original e-mail in a sandbox, the send-check window's shell, "Leave with unsent text?",
 * "Close thread?" and one count popover. Made-up data only (Brand Alpha, SO-2026-0142).
 */

const id = (n: number) => `0190f0e2-7c00-7000-8000-${String(n).padStart(12, '0')}`
const picture = (label: string, shade: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720"><rect width="960" height="720" fill="${shade}"/><path d="M360 140h240l90 120-60 45-30-24v300H360V281l-30 24-60-45z" fill="#5b6573"/><text x="480" y="660" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#ffffff">${label}</text></svg>`)}`

function file(n: number, over: Partial<ViewerFile>): ViewerFile {
  return {
    id: id(n),
    name: `File ${n}`,
    contentType: 'application/pdf',
    kind: 'DOCUMENT',
    sizeBytes: 240_000,
    status: 'AVAILABLE',
    quarantineReason: null,
    src: null,
    downloadHref: '#download',
    mayOpen: true,
    messageId: id(900),
    versionNo: 1,
    ...over,
  }
}

const FRONT = file(1, { name: 'AX-100 sample front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sizeBytes: 2_400_000, src: picture('AX-100 front (made up)', '#c9ced6') })
const BACK = file(2, { name: 'AX-100 sample back.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sizeBytes: 2_100_000, src: picture('AX-100 back (made up)', '#b7bec8'), versionNo: 2 })
const TECH = file(3, { name: BRAND_ALPHA.fileName, src: demoPdf(['Tech pack AX-100 (made up)', 'Collar: yellow piping', 'Sizes 44-58', 'Made-up data for the design index']) })
const SHEET = file(4, { name: 'Size chart AX-100.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'ATTACHMENT', sizeBytes: 64_000 })
const HEIC = file(5, { name: 'Collar detail.heic', contentType: 'image/heic', kind: 'PHOTO', sizeBytes: 3_800_000 })
const HELD = file(6, { name: 'Lining photo.jpg', contentType: 'image/jpeg', kind: 'PHOTO', status: 'QUARANTINED', quarantineReason: 'scan_pending', downloadHref: null })
const HIDDEN = file(7, { name: 'Measurement sheet.pdf', mayOpen: false })
const FILES = [FRONT, BACK, TECH, SHEET, HEIC, HELD, HIDDEN]

const MAIL_HTML =
  '<p>Good morning,</p><p>here is the sample feedback for <b>SO-2026-0142</b>: keep the yellow piping on the collar.</p>' +
  '<p><img data-remote-src="https://images.brand-alpha.example/logo.png" alt="Brand Alpha logo"> <a href="https://brand-alpha.example/track">Our portal</a></p>' +
  '<p>Regards,<br>Alma Alfieri</p>'

const original = (over: Partial<Extract<PopupsCaseModel, { show: 'original' }>['original']> = {}): PopupsCaseModel => ({
  show: 'original',
  original: {
    from: `${BRAND_ALPHA.contact.name} <${BRAND_ALPHA.contact.email}>`,
    to: ['orders@factory.example.com'],
    cc: [],
    subject: 'Re: SO-2026-0142 · pre-production sample',
    receivedAt: '2026-11-12T09:20:00.000Z',
    bodyHtml: MAIL_HTML,
    bodyText: null,
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
    ...over,
  },
})

const send = (over: Partial<Extract<PopupsCaseModel, { show: 'send' }>['send']> = {}): PopupsCaseModel => ({
  show: 'send',
  send: { to: [BRAND_ALPHA.contact.email], cc: [], party: BRAND_ALPHA.tradeName, warnings: [], outside: null, sendLabel: `Send to ${BRAND_ALPHA.tradeName}`, held: null, ...over },
})

export const designScreen = defineDesignScreen<PopupsCaseModel>({
  screen: 'SCR-006-popups',
  title: 'Thread pop-ups: file viewer, original e-mail, send check, confirms (B-TH-211)',
  view: PopupsCase,
  part: true,
  cases: [
    { id: 'viewer-photo', label: 'File viewer — a photo (DS Lightbox)', model: { show: 'viewer', files: FILES, index: 0 }, note: '← / → walk the photos; Download is a real link; Go to message; "One file you cannot open" is counted, never named. Esc closes, focus returns.' },
    { id: 'viewer-pdf', label: 'File viewer — PDF pages (DS PdfViewer)', model: { show: 'viewer', files: FILES, index: 2 }, note: 'The PDF page by page; ← / → walk every file (photos open in the Lightbox).' },
    { id: 'viewer-card', label: 'File viewer — a file it cannot draw', model: { show: 'viewer', files: FILES, index: 3 }, note: 'An Office file: its kind card and Download.' },
    { id: 'viewer-heic', label: 'File viewer — a HEIC photo', model: { show: 'viewer', files: FILES, index: 4 }, note: '"HEIC photo: … Download it to open it."' },
    { id: 'viewer-held', label: 'File viewer — a held file', model: { show: 'viewer', files: FILES, index: 5 }, note: 'Lock and the reason; no Download.' },
    { id: 'viewer-opening', label: 'File viewer — opening', model: { show: 'viewer', files: [file(8, { name: 'Order confirmation.pdf', src: null, downloadHref: null })], index: 0 }, note: 'The 60-second address is being fetched: "Opening the file…", Download held with why.' },
    { id: 'original', label: 'Original e-mail — sandboxed', model: original(), note: 'Nothing runs; the link is text; the remote picture waits for "Show pictures"; the three sender checks in words.' },
    { id: 'original-failed', label: 'Original e-mail — a failed check', model: original({ verdicts: { spf: 'FAIL', dkim: 'GRAY', dmarc: 'FAIL' } }), note: 'The warning banner and each failed check said in words.' },
    { id: 'original-plain', label: 'Original e-mail — plain text only', model: original({ bodyHtml: null, bodyText: 'Good morning,\nplease send the sample on Friday.\nAlma' }) },
    { id: 'send-clear', label: 'Send check — nothing to check', model: send() },
    { id: 'send-outside', label: 'Send check — an address outside this customer', model: send({ cc: ['bruno.becker@brand-beta.example'], warnings: [{ id: 'cc', text: 'bruno.becker@brand-beta.example does not belong to Brand Alpha.', tone: 'warning' }], outside: { ticked: false } }), note: 'Send stays held until "Send outside this customer" is ticked; the tick is recorded (B-TH-004).' },
    { id: 'send-danger', label: 'Send check — a finding that holds Send', model: send({ warnings: [{ id: 'mention', text: 'The text mentions Alex Demo: mentions stay in office notes.', tone: 'danger' }] }) },
    { id: 'leave', label: 'Leave with unsent text?', model: { show: 'leave', files: 2 }, note: 'Stay has the focus; Discard drops the words and the two files.' },
    { id: 'close', label: 'Close thread? (threads.manage)', model: { show: 'close', record: 'SO-2026-0142', party: BRAND_ALPHA.tradeName, problem: null }, note: 'The consequence in words before the click; Reopen undoes it exactly.' },
    { id: 'close-conflict', label: 'Close thread? — changed meanwhile', model: { show: 'close', record: 'SO-2026-0142', party: BRAND_ALPHA.tradeName, problem: 'close.conflict' } },
    { id: 'count', label: 'One count popover', model: { show: 'count', count: { kind: 'tasks', count: 7, lines: [{ id: 'a', label: 'Check the collar piping on the sample', meta: 'Bea Esempio · due 14 Nov' }, { id: 'b', label: 'Send the size chart', meta: 'Alex Demo · due 18 Nov' }, { id: 'c', label: 'Book the courier', meta: 'Carlo Prova' }, { id: 'd', label: 'Confirm the lining colour', meta: 'Dora Campione' }, { id: 'e', label: 'Print the labels', meta: 'Alex Demo' }], held: null } }, note: 'Enter opens it; five lines, "and 2 more", one action; Esc closes and the focus returns to the chip.' },
    { id: 'count-held', label: 'Count popover — the action held', model: { show: 'count', count: { kind: 'followers', count: 2, lines: [{ id: 'a', label: 'Alex Demo', meta: 'made it' }, { id: 'b', label: 'Bea Esempio', meta: 'was mentioned' }], held: 'You need the right “Write in threads”.' } } },
  ],
})
