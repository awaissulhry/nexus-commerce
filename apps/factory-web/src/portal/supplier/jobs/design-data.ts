import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { badgesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import type { Job, JobPage, JobRow, JobsRead } from './api'
import { NS, type PersonFacts } from './model'

/**
 * SCR-192 / SCR-193's made-up world (B-W2b-181; PLAN §3.1): an invented maker (Officina Demo, its planner Paola Esempio) and
 * an invented stitching workshop (Laboratorio Prova, its person Rosa Prova) on a phone; jobs SC-2026-0012… with a jacket
 * style in two colourways and five sizes. Never a real company, person or number; never a fee or a price.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const dayAt = (days: number) => at(days * 24).slice(0, 10)
export const TODAY = dayAt(0)
export const PREFIX = '/p/LAB-PROVA'
export const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})

const id = (n: number) => `0190f0e2-8181-7000-8000-${String(n).padStart(12, '0')}`
export const JOB_ID = id(1)

const LEGAL = {
  it: { name: 'Officina Demo S.r.l.', lines: ['Sede legale: Via Fittizia 22, 20900 Monza (MB)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Officina Demo S.r.l.', lines: ['Registered office: Via Fittizia 22, 20900 Monza (MB)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const

const CAN = (permission: string) => permission.startsWith('portal.') || permission === 'threads.read' || permission === 'files.read'

export const FACTS: PersonFacts = { preview: false, offline: false, busy: false, mayAct: { approve: true, comment: true, upload: true } }

export function shellOf(locale: Locale, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return {
    brand: null,
    companyName: 'Officina Demo',
    partyName: 'Laboratorio Prova',
    person: { displayName: 'Rosa Prova', email: 'rosa@laboratorio-prova.example' },
    nav: portalNavFor({ can: CAN, kinds: ['SUBCONTRACTOR'] }),
    path: '/jobs',
    prefix: PREFIX,
    badges: badgesOf([{ area: 'orders', count: 2, words: { it: '2 da fare', en: '2 to do' } }], locale),
    bell: { unread: 1, complete: true },
    notice: null,
    band: null,
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: true,
    preview: false,
    canSearch: true,
    ...over,
  }
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const STYLE = { code: 'GIA-204', name: 'Giacca Aria' }
const STITCHING = { seq: 10, code: 'CUC', name: 'Cucitura' }
const EDGE = { seq: 20, code: 'BOR', name: 'Bordatura' }

const row = (n: number, over: Partial<JobRow> & Pick<JobRow, 'state' | 'chip' | 'nextStep'>): JobRow => ({
  id: id(n),
  number: `SC-2026-00${String(10 + n).padStart(2, '0')}`,
  status: 'AT_WORKSHOP',
  operations: [STITCHING],
  workOrder: { number: `WO-2026-04${String(n).padStart(2, '0')}`, style: STYLE },
  pieces: 120,
  finished: 0,
  kitDate: dayAt(-2),
  dueBack: dayAt(8 + n),
  late: false,
  proposedDate: null,
  version: 4,
  ...over,
})

export const ROWS: readonly JobRow[] = [
  row(2, { state: 'TO_ANSWER', chip: 'NEW', nextStep: 'ACCEPT', status: 'ISSUED', kitDate: null, operations: [STITCHING, EDGE] }),
  row(3, { state: 'TO_ANSWER', chip: 'NEW', nextStep: 'ACCEPT', status: 'ISSUED', kitDate: null, pieces: 60, dueBack: dayAt(14) }),
  row(4, { state: 'IN_WORK', chip: 'KIT', nextStep: 'CONFIRM_KIT', kitDate: dayAt(-1) }),
  row(5, { state: 'IN_WORK', chip: 'WORK', nextStep: 'REPORT', finished: 48, dueBack: dayAt(3) }),
  row(6, { state: 'IN_WORK', chip: 'WORK', nextStep: 'REPORT', finished: 70, late: true, dueBack: dayAt(-2) }),
  row(7, { state: 'PARTLY_BACK', chip: 'BACK', nextStep: 'SEND_BACK', status: 'PARTLY_RECEIVED', finished: 118, dueBack: dayAt(1) }),
  row(8, { state: 'WAITING_KIT', chip: 'WORK', nextStep: 'WAIT_KIT', status: 'ISSUED', kitDate: null, proposedDate: dayAt(20) }),
  row(9, { state: 'BACK', chip: 'DONE', nextStep: 'NONE', status: 'RECEIVED', finished: 120, dueBack: dayAt(-10) }),
]

const CHIPS = ['NEW', 'KIT', 'WORK', 'BACK', 'DONE'] as const

export function jobsRead(chip: JobsRead['chip'] = 'NEW', items?: readonly JobRow[]): JobsRead {
  const count = (entry: (typeof CHIPS)[number]) => ROWS.filter((job) => job.chip === entry).length
  return {
    asOf: at(0),
    chip,
    chips: CHIPS.map((entry) => ({ chip: entry, count: count(entry) })),
    counts: { toAccept: count('NEW'), kitToConfirm: count('KIT'), readyToSendBack: count('BACK'), late: 1 },
    items: [...(items ?? ROWS.filter((job) => job.chip === chip))],
    complete: true,
    live: { events: ['subcontract_order.job_answered', 'partner_task.opened'] },
  }
}

// ── one job ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const SIZES = ['S', 'M', 'L', 'XL', 'XXL']
const cells = (op: number, colourway: string, pieces: readonly number[], finished: readonly number[]) =>
  SIZES.map((size, index) => ({ workOrderSizeId: id(100 + op * 20 + (colourway === 'Nero' ? 0 : 10) + index), colourway, size, pieces: pieces[index]!, finished: finished[index]! }))

export function jobOf(over: Partial<Job> = {}): Job {
  const sizes = [...cells(1, 'Nero', [8, 16, 16, 12, 8], [8, 10, 6, 0, 0]), ...cells(1, 'Cuoio', [6, 14, 18, 14, 8], [6, 8, 10, 0, 0])]
  return {
    id: JOB_ID,
    number: 'SC-2026-0012',
    status: 'AT_WORKSHOP',
    state: 'IN_WORK',
    chip: 'WORK',
    nextStep: 'REPORT',
    from: { companyName: 'Officina Demo' },
    workOrder: { number: 'WO-2026-0401', style: STYLE },
    orderDate: dayAt(-6),
    expectedBackDate: dayAt(9),
    issuedAt: at(-24 * 6),
    note: 'Cuciture a vista doppie sul collo; filo in tinta.',
    answer: { acceptedAt: at(-24 * 5), acceptedByName: 'Rosa Prova', proposedDate: null, proposedDateReason: null, declinedAt: null, declinedByName: null, dateDecision: null },
    operations: [
      {
        id: id(11),
        seq: 10,
        code: 'CUC',
        name: 'Cucitura',
        pieces: 120,
        sizes,
        expectedBackDate: dayAt(9),
        piecesSent: 120,
        back: { good: 0, defective: 0, scrapped: 0 },
        finished: 48,
        announced: 0,
        ready: 48,
        announceable: 120,
        note: null,
      },
    ],
    bundles: [
      { id: id(31), code: 'B-0412', workOrderSizeId: sizes[1]!.workOrderSizeId, colourway: 'Nero', size: 'M', quantity: 16, sentAt: at(-48) },
      { id: id(32), code: 'B-0413', workOrderSizeId: sizes[2]!.workOrderSizeId, colourway: 'Nero', size: 'L', quantity: 16, sentAt: at(-48) },
      { id: id(33), code: 'B-0420', workOrderSizeId: sizes[7]!.workOrderSizeId, colourway: 'Cuoio', size: 'L', quantity: 18, sentAt: at(-48) },
    ],
    kit: {
      sentOn: [dayAt(-2)],
      toConfirm: 0,
      lines: [
        { id: id(41), seq: 10, item: { code: 'FOD-NY', name: 'Fodera nylon' }, colour: 'Nero', lot: 'L-2231', hide: null, quantity: '84.0000', uom: 'M', status: 'SENT', sentAt: at(-48), ddt: { number: 'DDT-2026-0331', date: dayAt(-2) }, check: { at: at(-40), quantity: '84.0000', note: null, short: false }, photos: [] },
        { id: id(42), seq: 20, item: { code: 'ZIP-60', name: 'Zip 60 cm' }, colour: 'Nero', lot: null, hide: null, quantity: '120.0000', uom: 'PCS', status: 'SENT', sentAt: at(-48), ddt: { number: 'DDT-2026-0331', date: dayAt(-2) }, check: { at: at(-40), quantity: '118.0000', note: 'Due zip con il cursore rotto.', short: true }, photos: [{ id: id(51), originalName: 'SC-2026-0012-kit-20.jpg', createdAt: at(-40) }] },
        { id: id(43), seq: 30, item: { code: 'FIL-40', name: 'Filo 40 in tinta' }, colour: null, lot: null, hide: null, quantity: '12.0000', uom: 'CONE', status: 'SENT', sentAt: at(-48), ddt: { number: 'DDT-2026-0331', date: dayAt(-2) }, check: { at: at(-40), quantity: '12.0000', note: null, short: false }, photos: [] },
      ],
    },
    finishBy: dayAt(8),
    reports: [
      { id: id(61), at: at(-30), operationId: id(11), operationSeq: 10, workOrderSizeId: sizes[0]!.workOrderSizeId, colourway: 'Nero', size: 'S', bundle: null, finished: 8, finishBy: null, byName: 'Rosa Prova', byOffice: false, note: null },
      { id: id(62), at: at(-6), operationId: id(11), operationSeq: 10, workOrderSizeId: sizes[1]!.workOrderSizeId, colourway: 'Nero', size: 'M', bundle: null, finished: 10, finishBy: dayAt(8), byName: 'Rosa Prova', byOffice: false, note: 'Taglie L domani.' },
      { id: id(63), at: at(-5), operationId: id(11), operationSeq: 10, workOrderSizeId: null, colourway: '', size: '', bundle: null, finished: 30, finishBy: null, byName: 'Gino Prova', byOffice: true, note: null },
    ],
    returns: [],
    acts: { accept: true, decline: true, kit: true, progress: false, sendBack: false },
    choices: { declineReasons: [{ code: 'NO_CAPACITY' }, { code: 'DATES' }, { code: 'OTHER' }], scrapReasons: ['LEATHER_FLAW', 'CUT_WRONG', 'STITCHING', 'STAIN', 'TEAR', 'MACHINE', 'OTHER'].map((code) => ({ code })) },
    version: 7,
    ...over,
  }
}

/** A New job: issued, waiting for the answer; our kit not sent yet. */
export function newJob(): Job {
  const base = jobOf()
  return jobOf({
    status: 'ISSUED',
    state: 'TO_ANSWER',
    chip: 'NEW',
    nextStep: 'ACCEPT',
    answer: { acceptedAt: null, acceptedByName: null, proposedDate: null, proposedDateReason: null, declinedAt: null, declinedByName: null, dateDecision: null },
    operations: base.operations.map((operation) => ({ ...operation, piecesSent: 0, finished: 0, ready: 0, announceable: 0, sizes: operation.sizes.map((cell) => ({ ...cell, finished: 0 })) })),
    bundles: [],
    kit: { sentOn: [], toConfirm: 0, lines: base.kit.lines.map((line) => ({ ...line, status: 'PLANNED', sentAt: null, ddt: null, check: null, photos: [] })) },
    finishBy: null,
    reports: [],
    acts: { accept: false, decline: false, kit: true, progress: true, sendBack: true },
  })
}

/** The kit arrived: three lines wait for the workshop's count. */
export function kitJob(): Job {
  const base = jobOf()
  return jobOf({
    chip: 'KIT',
    nextStep: 'CONFIRM_KIT',
    operations: base.operations.map((operation) => ({ ...operation, finished: 0, ready: 0, sizes: operation.sizes.map((cell) => ({ ...cell, finished: 0 })) })),
    kit: { sentOn: [dayAt(-1)], toConfirm: 3, lines: base.kit.lines.map((line) => ({ ...line, check: null, photos: [] })) },
    reports: [],
    acts: { accept: true, decline: true, kit: false, progress: false, sendBack: false },
  })
}

/** Work finished and with the workshop: ready to send back; one send-back announced already. */
export function backJob(): Job {
  const base = jobOf()
  return jobOf({
    status: 'PARTLY_RECEIVED',
    state: 'PARTLY_BACK',
    chip: 'BACK',
    nextStep: 'SEND_BACK',
    operations: base.operations.map((operation) => ({ ...operation, finished: 118, back: { good: 40, defective: 0, scrapped: 0 }, announced: 20, ready: 58, announceable: 60, sizes: operation.sizes.map((cell) => ({ ...cell, finished: cell.pieces })) })),
    returns: [
      { id: id(71), seq: 1, status: 'RECEIVED', expectedDate: dayAt(-3), parcels: 2, weCollect: false, ddt: { number: 'LP-118', date: dayAt(-4) }, pieces: 40, quantities: [], materialBack: [], byName: 'Rosa Prova', byOffice: false, note: null, announcedAt: at(-24 * 4), receivedAt: at(-24 * 3), cancelledAt: null, cancelReason: null },
      { id: id(72), seq: 2, status: 'ANNOUNCED', expectedDate: dayAt(1), parcels: 1, weCollect: true, ddt: { number: 'LP-121', date: dayAt(0) }, pieces: 20, quantities: [], materialBack: [], byName: 'Rosa Prova', byOffice: false, note: null, announcedAt: at(-3), receivedAt: null, cancelledAt: null, cancelReason: null },
    ],
  })
}

/** Proposed another due-back day; we have not answered yet. */
export function proposedJob(decision: 'ACCEPTED' | 'REFUSED' | null = null): Job {
  const base = newJob()
  return jobOf({
    ...base,
    state: 'WAITING_KIT',
    chip: 'WORK',
    nextStep: 'WAIT_KIT',
    answer: { ...base.answer, acceptedAt: at(-20), acceptedByName: 'Rosa Prova', proposedDate: dayAt(16), proposedDateReason: 'Abbiamo due macchine ferme fino a lunedì.', dateDecision: decision ? { decision, at: at(-2) } : null },
    acts: { accept: true, decline: true, kit: true, progress: false, sendBack: true },
  })
}

export const pageOf = (job: Job, mayAct: Partial<JobPage['mayAct']> = {}): JobPage => ({ job, mayAct: { approve: true, comment: true, upload: true, ...mayAct }, live: { events: ['subcontract_order.job_answered'] } })

export function threadOf(locale: Locale): ThreadViewModel {
  const portal = words(locale, 'portal')
  const messages: PartnerMessage[] = [
    {
      id: 'm1',
      side: 'company',
      channel: 'email',
      author: { name: 'Paola Esempio', mine: false },
      body: locale === 'it' ? 'Buongiorno Rosa, il kit di SC-2026-0012 parte domani con il nostro DDT.' : 'Good morning Rosa, the kit of SC-2026-0012 leaves tomorrow with our DDT.',
      attachments: [],
      at: at(-50),
      atText: formatDateTime(at(-50), { locale }),
    },
    {
      id: 'm2',
      side: 'partner',
      channel: 'portal',
      author: { name: 'Rosa Prova', mine: true },
      body: locale === 'it' ? 'Materiale mancante — due zip hanno il cursore rotto.' : 'Material missing — two zips have a broken slider.',
      at: at(-39),
      atText: formatDateTime(at(-39), { locale }),
    },
  ]
  return { state: 'ready', record: null, companyName: 'Officina Demo', messages, composer: { value: '', busy: false, heldReason: null, hint: portal('thread.hint'), limit: 20_000 }, loadMore: null, accessLine: null, failed: null }
}
