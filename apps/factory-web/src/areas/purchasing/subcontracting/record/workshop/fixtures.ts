import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { SubcontractOrder } from '../../api'
import { at, BUNDLES, canFor, CELLS, inShell, kitLine, order, panelsModel, PREFIX, TIME_ZONE, TODAY, uid, withoutFees, type RoleCase } from '../../demo/fixtures'
import { words } from '../../model'
import type { SubcontractRecordModel } from '../record-model'
import { SubcontractRecordView } from '../view/SubcontractRecordView'
import type { WorkshopAnswer, WorkshopJob } from './api'
import { answerDraft, cellKey, kitDraft, linkDraft, progressDraft, returnsDraft, type WorkshopDialog, type WorkshopPanelModel } from './model'
import { WorkshopSection } from './view/WorkshopPanelView'

/**
 * SCR-128-workshop — what the workshop said, under the subcontract order's Kit tab (B-W2b-176; design
 * purchasing.subcontracting › Kit "received by the workshop (W2b link or portal)"; Owner answer C3), a suffix id of SCR-128
 * like SCR-128-record. Made-up data only (the demo workshop "Laboratorio Cuciture Demo", its made-up people and DDTs): the
 * job waiting for its answer with the link to send, the link handed out once, a workshop with neither e-mail nor portal, a
 * date proposed and our answer, declined, accepted waiting for the kit, the kit checked with a shortfall and a photo,
 * progress with reports (one entered by us), send-backs announced / received / cancelled, each dialog, a refusal, a role
 * that only reads (every act held with why), loading, slow and failed. No price anywhere (C2).
 */

const SEW = uid('8282', 30)
const POCKETS = uid('8282', 50)
const sizes = (finished: readonly number[]) => CELLS.map((cell, index) => ({ workOrderSizeId: cell.workOrderSizeId, colourway: cell.colourway, size: cell.size, pieces: cell.quantity, finished: finished[index] ?? 0 }))
const NONE = { accept: null, decline: null, kit: null, progress: null, sendBack: null }
const HELD = 'held'
const SCRAP = ['LEATHER_FLAW', 'CUT_WRONG', 'STITCHING', 'STAIN', 'TEAR', 'MACHINE', 'OTHER'].map((code) => ({ code, words: code }))

function operations(finished: readonly number[] = [0, 0, 0, 0, 0], sent = 0, over: Partial<WorkshopJob['operations'][number]> = {}): WorkshopJob['operations'] {
  const done = finished.reduce((sum, value) => sum + value, 0)
  return [
    { id: SEW, seq: 10, code: 'CUC', name: 'Cucitura completa (CMT)', pieces: 30, sizes: sizes(finished), expectedBackDate: '2026-11-20', piecesSent: sent, back: { good: 0, defective: 0, scrapped: 0 }, finished: done, announced: 0, ready: Math.min(done, sent), announceable: sent, ...over },
    { id: POCKETS, seq: 20, code: 'TAS', name: 'Tasche per protezioni', pieces: 30, sizes: [], expectedBackDate: '2026-11-20', piecesSent: sent, back: { good: 0, defective: 0, scrapped: 0 }, finished: 0, announced: 0, ready: 0, announceable: sent },
  ]
}

const kitLines = (checks: 'none' | 'some' | 'all'): WorkshopJob['kit']['lines'] => [
  {
    id: kitLine(1).id,
    seq: 10,
    item: { code: 'DEMO-FOD-02', name: 'Fodera rete traspirante' },
    colour: 'Nero',
    lot: 'LT-DEMO-FOD-11',
    hide: null,
    quantity: '42.6000',
    uom: 'M',
    status: 'SENT',
    sentAt: at(10, 8),
    ddt: { number: '212/2026', date: '2026-11-10' },
    check: checks === 'none' ? null : { at: at(11, 9, 40), quantity: '40.0000', note: 'Un rotolo bagnato in fondo alla scatola, 2,6 m da buttare.', short: true },
    photos: checks === 'none' ? [] : [{ id: uid('9393', 1), originalName: 'rotolo-bagnato.jpg', createdAt: at(11, 9, 41) }],
  },
  {
    id: kitLine(2).id,
    seq: 20,
    item: { code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2' },
    colour: null,
    lot: null,
    hide: null,
    quantity: '60.0000',
    uom: 'PCS',
    status: 'SENT',
    sentAt: at(10, 8),
    ddt: { number: '212/2026', date: '2026-11-10' },
    check: checks === 'all' ? { at: at(11, 9, 40), quantity: '60.0000', note: null, short: false } : null,
    photos: [],
  },
  { id: kitLine(3).id, seq: 30, item: { code: 'DEMO-FIL-05', name: 'Filo poliestere 40' }, colour: 'Nero', lot: null, hide: null, quantity: '6.0000', uom: 'PCS', status: 'PLANNED', sentAt: null, ddt: null, check: null, photos: [] },
]

const REPLY_NONE: WorkshopJob['answer'] = { acceptedAt: null, acceptedByName: null, proposedDate: null, proposedDateReason: null, declinedAt: null, declinedByName: null, declineReason: null, dateDecision: null }
const ACCEPTED: WorkshopJob['answer'] = { ...REPLY_NONE, acceptedAt: at(9, 14, 5), acceptedByName: 'Rosa Esempio' }

function job(over: Partial<WorkshopJob>): WorkshopJob {
  return {
    id: uid('8181', 50),
    number: 'SC-2026-0008',
    status: 'ISSUED',
    state: 'TO_ANSWER',
    chip: 'NEW',
    nextStep: 'ACCEPT',
    orderDate: '2026-11-09',
    expectedBackDate: '2026-11-20',
    note: 'Cuciture a doppio ago sulle spalle, come da campione.',
    answer: REPLY_NONE,
    operations: operations(),
    bundles: [],
    kit: { sentOn: [], toConfirm: 0, lines: kitLines('none').map((line) => ({ ...line, status: 'PLANNED' as const, sentAt: null, ddt: null })) },
    finishBy: null,
    reports: [],
    returns: [],
    acts: { ...NONE, kit: HELD, progress: HELD, sendBack: HELD },
    choices: { scrapReasons: SCRAP },
    version: 4,
    ...over,
  }
}

const CONTACT = { id: uid('9494', 1), name: 'Rosa Esempio', email: 'laboratorio@cuciture-demo.example', language: 'it' }

function answerOf(value: WorkshopJob, over: Partial<WorkshopAnswer> = {}): WorkshopAnswer {
  return {
    job: value,
    links: [],
    prefills: [],
    reach: { contacts: [CONTACT], portalOn: false, portalPeople: 0 },
    office: { manage: true, receive: true, decideDate: value.answer.proposedDate && !value.answer.dateDecision ? null : HELD, sendLink: value.answer.acceptedAt || value.answer.declinedAt ? HELD : null },
    ...over,
  }
}

const waiting = answerOf(job({}))
const LINK_LIVE = { id: uid('9595', 1), email: CONTACT.email, state: 'LIVE', expiresAt: at(16, 9), usedAt: null, createdAt: at(9, 11, 2) }
const proposedJob = job({ state: 'WAITING_KIT', chip: 'WORK', nextStep: 'WAIT_KIT', answer: { ...ACCEPTED, proposedDate: '2026-11-24', proposedDateReason: 'Due macchine in manutenzione questa settimana.' }, acts: { ...NONE, accept: HELD, decline: HELD, kit: HELD, sendBack: HELD } })
const proposed = answerOf(proposedJob, { links: [{ ...LINK_LIVE, state: 'USED_UP', usedAt: at(9, 14, 5) }] })
const dateAccepted = answerOf(job({ ...proposedJob, expectedBackDate: '2026-11-24', answer: { ...proposedJob.answer, dateDecision: { decision: 'ACCEPTED', at: at(9, 16) } } }), { links: proposed.links })
const declined = answerOf(job({ state: 'DECLINED', chip: 'DONE', nextStep: 'NONE', answer: { ...REPLY_NONE, declinedAt: at(9, 15), declinedByName: 'Rosa Esempio', declineReason: 'No capacity: Pieni fino a fine mese.' }, acts: { accept: HELD, decline: HELD, kit: HELD, progress: HELD, sendBack: HELD } }), { links: proposed.links })
const waitingKit = answerOf(job({ state: 'WAITING_KIT', chip: 'WORK', nextStep: 'WAIT_KIT', answer: ACCEPTED, acts: { ...NONE, accept: HELD, decline: HELD, kit: HELD, sendBack: HELD } }), { links: proposed.links })

const BUNDLE_A = { id: BUNDLES[1]!.id, code: BUNDLES[1]!.code, workOrderSizeId: CELLS[1]!.workOrderSizeId, colourway: 'BLK', size: '50', quantity: 8, sentAt: at(10, 8) }
const atWorkshopJob = (checks: 'none' | 'some' | 'all', over: Partial<WorkshopJob> = {}) =>
  job({
    status: 'AT_WORKSHOP',
    state: 'IN_WORK',
    chip: checks === 'all' ? 'WORK' : 'KIT',
    nextStep: checks === 'all' ? 'REPORT' : 'CONFIRM_KIT',
    answer: ACCEPTED,
    operations: operations([0, 0, 0, 0, 0], 30),
    bundles: [BUNDLE_A],
    kit: { sentOn: ['2026-11-10'], toConfirm: checks === 'none' ? 2 : checks === 'some' ? 1 : 0, lines: kitLines(checks) },
    acts: { ...NONE, accept: HELD, decline: HELD, ...(checks === 'all' ? { kit: HELD } : {}) },
    ...over,
  })

const kitPart = answerOf(atWorkshopJob('some'), { links: proposed.links })
const REPORTS: WorkshopJob['reports'] = [
  { id: uid('9696', 1), at: at(13, 17, 30), operationId: SEW, operationSeq: 10, workOrderSizeId: CELLS[1]!.workOrderSizeId, colourway: 'BLK', size: '50', bundle: { id: BUNDLE_A.id, code: BUNDLE_A.code }, finished: 8, finishBy: '2026-11-19', byName: 'Rosa Esempio', byOffice: false, note: null },
  { id: uid('9696', 2), at: at(16, 11, 5), operationId: SEW, operationSeq: 10, workOrderSizeId: CELLS[2]!.workOrderSizeId, colourway: 'BLK', size: '52', bundle: null, finished: 6, finishBy: null, byName: 'Gino al telefono', byOffice: true, note: 'Detto al telefono, manca il filo nero per il resto.' },
]
const progressJob = atWorkshopJob('all', { chip: 'BACK', nextStep: 'SEND_BACK', operations: operations([0, 8, 6, 0, 0], 30), reports: REPORTS, finishBy: '2026-11-19' })
const progress = answerOf(progressJob, { links: proposed.links })

const NOTICE_ANNOUNCED: WorkshopJob['returns'][number] = {
  id: uid('9797', 2),
  seq: 2,
  status: 'ANNOUNCED',
  expectedDate: '2026-11-19',
  parcels: 2,
  weCollect: false,
  ddt: { number: 'LCD-95/26', date: TODAY },
  pieces: 7,
  quantities: [
    { operationId: SEW, operationSeq: 10, workOrderSizeId: CELLS[2]!.workOrderSizeId, colourway: 'BLK', size: '52', bundle: null, finished: 5, scrapped: 1, reasonCode: 'STAIN' },
    { operationId: SEW, operationSeq: 10, workOrderSizeId: null, colourway: '', size: '', bundle: null, finished: 1, scrapped: 0, reasonCode: null },
  ],
  materialBack: [{ kitLineId: kitLine(1).id, seq: 10, item: { code: 'DEMO-FOD-02', name: 'Fodera rete traspirante' }, quantity: '2.5000', uom: 'M' }],
  byName: 'Rosa Esempio',
  byOffice: false,
  note: 'Il resto la settimana prossima.',
  announcedAt: at(18, 8, 10),
  receivedAt: null,
  cancelledAt: null,
  cancelReason: null,
}
const NOTICE_RECEIVED: WorkshopJob['returns'][number] = { ...NOTICE_ANNOUNCED, id: uid('9797', 1), seq: 1, status: 'RECEIVED', expectedDate: '2026-11-14', pieces: 8, quantities: [{ ...NOTICE_ANNOUNCED.quantities[0]!, workOrderSizeId: CELLS[1]!.workOrderSizeId, size: '50', bundle: { id: BUNDLE_A.id, code: BUNDLE_A.code }, finished: 8, scrapped: 0, reasonCode: null }], materialBack: [], ddt: { number: 'LCD-88/26', date: '2026-11-14' }, receivedAt: at(16, 10, 15), note: null }
const NOTICE_CANCELLED: WorkshopJob['returns'][number] = { ...NOTICE_ANNOUNCED, id: uid('9797', 3), seq: 3, status: 'CANCELLED', pieces: 1, quantities: [NOTICE_ANNOUNCED.quantities[1]!], materialBack: [], ddt: null, weCollect: true, byName: 'Bianca Demo', byOffice: true, note: null, cancelledAt: at(18, 9), cancelReason: 'Il laboratorio porta tutto insieme la settimana prossima.' }
const returnsJob = job({
  ...progressJob,
  status: 'PARTLY_RECEIVED',
  state: 'PARTLY_BACK',
  chip: 'WORK',
  nextStep: 'REPORT',
  operations: operations([0, 8, 6, 0, 0], 30, { back: { good: 8, defective: 0, scrapped: 0 }, announced: 7, ready: 0, announceable: 15 }),
  returns: [NOTICE_RECEIVED, NOTICE_ANNOUNCED, NOTICE_CANCELLED],
})
const PREFILL = {
  returnNoticeId: NOTICE_ANNOUNCED.id,
  lines: [
    { operationId: SEW, bundleId: null, good: 5, defective: 0, scrapped: 1, reason: 'STAIN' },
    { operationId: SEW, bundleId: null, good: 1, defective: 0, scrapped: 0, reason: null },
  ],
  supplierDdt: { number: 'LCD-95/26', date: TODAY },
  returns: [{ kitLineId: kitLine(1).id, itemId: kitLine(1).item.id, itemColourId: kitLine(1).colour!.id, lotId: kitLine(1).lot!.id, hideId: null, quantity: '2.5000', uom: 'M' }],
  note: 'Il resto la settimana prossima.',
}
const returns = answerOf(returnsJob, { links: proposed.links, prefills: [PREFILL] })
const noEmail = answerOf(job({}), { reach: { contacts: [], portalOn: false, portalPeople: 0 } })
const readOnly = answerOf(returnsJob, { links: proposed.links, prefills: [PREFILL], office: { manage: false, receive: false, decideDate: HELD, sendLink: HELD } })

// ---- the panel's states and the record around it ----------------------------------------------------------------------------

const panel = (answer: WorkshopAnswer | null, over: Partial<WorkshopPanelModel> = {}): WorkshopPanelModel => ({
  answer: answer ? { status: 'ready', value: answer } : { status: 'loading' },
  slow: false,
  busy: false,
  dialog: null,
  problem: null,
  notice: null,
  handed: null,
  timeZone: TIME_ZONE,
  today: TODAY,
  ...over,
})

export interface WorkshopCase {
  role: RoleCase
  record: SubcontractRecordModel
}

function workshopCase(role: RoleCase, value: SubcontractOrder, model: WorkshopPanelModel): WorkshopCase {
  const can = canFor(role)
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      tab: 'kit',
      order: { status: 'ready', value: can.cost ? value : withoutFees(value) },
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      marks: {},
      pdf: null,
      panelsPreview: panelsModel(value.id, value.number),
      timeZone: TIME_ZONE,
      today: TODAY,
      workshop: createElement(WorkshopSection, { model }),
    },
  }
}

function WorkshopDesign({ model }: { model: WorkshopCase }) {
  const value = model.record.order.status === 'ready' ? model.record.order.value : null
  return inShell(`/purchasing/subcontracting/${value?.id ?? 'demo'}`, createElement(SubcontractRecordView, { model: model.record }), model.role)
}

const issued = order('ISSUED')
const atWorkshop = order('AT_WORKSHOP')
const partly = order('PARTLY_RECEIVED')
const dialogOf = (dialog: WorkshopDialog, answer: WorkshopAnswer, over: Partial<WorkshopPanelModel> = {}) => panel(answer, { dialog, ...over })
const HANDED = 'https://factory.example/l#token=DEMO.0190f0e2.SOLO-ESEMPIO.non-un-link-vero'

export const designScreen = defineDesignScreen<WorkshopCase>({
  screen: 'SCR-128-workshop',
  title: 'Subcontract order · what the workshop said',
  view: WorkshopDesign,
  cases: [
    { id: 'waiting', label: 'Sent, waiting for the workshop’s answer; a contact with e-mail, no link yet (buyer)', model: workshopCase('buyer', issued, panel(waiting)) },
    { id: 'link-mail', label: 'Send the job link: by e-mail to the workshop’s contact', model: workshopCase('buyer', issued, dialogOf(linkDraft(waiting), waiting)) },
    { id: 'link-hand', label: 'Send the job link: get the link to pass on (a workshop on the phone)', model: workshopCase('buyer', issued, dialogOf({ kind: 'link', mode: 'hand', contactId: '', email: '', language: 'it' }, waiting)) },
    { id: 'link-handed', label: 'The link handed out ONCE, with Copy; the link list', model: workshopCase('buyer', issued, panel({ ...waiting, links: [{ ...LINK_LIVE, email: null }] }, { handed: HANDED, notice: { tone: 'success', words: words('notice.linkHanded') } })) },
    { id: 'link-refused', label: 'Send the job link refused: the address bounced (in words)', model: workshopCase('buyer', issued, dialogOf({ kind: 'link', mode: 'mail', contactId: '', email: 'rosa@cuciture-demo.example', language: '' }, waiting, { problem: words('refused.address') })) },
    { id: 'no-email', label: 'No e-mail and no portal: record its answers here (C3)', model: workshopCase('buyer', issued, panel(noEmail)) },
    { id: 'answer-move', label: 'Record its answer for it: accepts with another day and why (C3)', model: workshopCase('buyer', issued, dialogOf({ ...answerDraft(noEmail), mode: 'move', proposedDate: '2026-11-24', reason: 'Due macchine in manutenzione.', name: 'Gino al telefono' } as WorkshopDialog, noEmail)) },
    { id: 'answer-decline', label: 'Record its answer for it: declines, Other needs its words (held)', model: workshopCase('buyer', issued, dialogOf({ ...answerDraft(noEmail), mode: 'decline', declineReason: 'OTHER' } as WorkshopDialog, noEmail)) },
    { id: 'answer-refused', label: 'Record its answer refused: the day was not accepted', model: workshopCase('buyer', issued, dialogOf({ ...answerDraft(noEmail), mode: 'move', proposedDate: '2026-11-24', reason: 'Ferie.' } as WorkshopDialog, noEmail, { problem: words('refused.proposedDate') })) },
    { id: 'proposed', label: 'Accepted, another day proposed: Accept the date / Refuse', model: workshopCase('buyer', issued, panel(proposed)) },
    { id: 'date-accept', label: 'Accept the proposed date: the expected-back day moves', model: workshopCase('buyer', issued, dialogOf({ kind: 'date', decision: 'ACCEPTED' }, proposed)) },
    { id: 'date-refuse', label: 'Refuse the proposed date: our day stays', model: workshopCase('buyer', issued, dialogOf({ kind: 'date', decision: 'REFUSED' }, proposed)) },
    { id: 'date-accepted', label: 'The date accepted: the due-back day is the workshop’s', model: workshopCase('buyer', issued, panel(dateAccepted, { notice: { tone: 'success', words: words('notice.dateAccepted') } })) },
    { id: 'declined', label: 'Declined, with its reason: every act held', model: workshopCase('buyer', issued, panel(declined)) },
    { id: 'waiting-kit', label: 'Accepted, the kit not sent yet', model: workshopCase('buyer', issued, panel(waitingKit)) },
    { id: 'kit-checked', label: 'In work: a kit line counted short with words and a photo, one to confirm (warehouse)', model: workshopCase('warehouse', atWorkshop, panel({ ...kitPart, office: { ...kitPart.office, manage: false } })) },
    { id: 'kit-dialog', label: 'Record its kit check for it: line by line, the shortfall in words', model: workshopCase('buyer', atWorkshop, dialogOf({ ...kitDraft(answerOf(atWorkshopJob('none')).job), all: false, lines: { [kitLine(1).id]: { quantity: '40', note: 'Rotolo bagnato.' }, [kitLine(2).id]: { quantity: '60', note: '' } } } as WorkshopDialog, answerOf(atWorkshopJob('none')))) },
    { id: 'kit-dialog-held', label: 'Record its kit check held: less than sent without words', model: workshopCase('buyer', atWorkshop, dialogOf({ kind: 'kit', all: false, lines: { [kitLine(1).id]: { quantity: '40', note: '' }, [kitLine(2).id]: { quantity: '60', note: '' } } }, answerOf(atWorkshopJob('none')))) },
    { id: 'progress', label: 'Progress by line and size, finish-by, reports (one entered by us)', model: workshopCase('buyer', atWorkshop, panel(progress)) },
    { id: 'progress-dialog', label: 'Record finished pieces for it: per size, finish-by, its name', model: workshopCase('buyer', atWorkshop, dialogOf({ ...progressDraft(), cells: { [cellKey(SEW, CELLS[0]!.workOrderSizeId)]: '2', [cellKey(POCKETS, null)]: '10' }, finishBy: '2026-11-19', name: 'Gino al telefono' } as WorkshopDialog, progress)) },
    { id: 'progress-held', label: 'Record finished pieces held: more than the size has left', model: workshopCase('buyer', atWorkshop, dialogOf({ ...progressDraft(), cells: { [cellKey(SEW, CELLS[1]!.workOrderSizeId)]: '3' } } as WorkshopDialog, progress)) },
    { id: 'returns', label: 'Send-backs: one received, one announced (Receive back from this / Cancel), one cancelled', model: workshopCase('warehouse', partly, panel({ ...returns, office: { ...returns.office, manage: false } })) },
    { id: 'returns-dialog', label: 'Record a send-back for it: finished, scrapped with why, material, parcels, its DDT', model: workshopCase('buyer', partly, dialogOf({ ...(returnsDraft(returnsJob, TODAY) as Extract<WorkshopDialog, { kind: 'returns' }>), rows: { [SEW]: { finished: '6', scrapped: '1', reasonCode: 'STAIN' } }, material: { [kitLine(1).id]: '1.5' }, parcels: '1', ddtNumber: 'LCD-97/26', ddtDate: TODAY }, returns)) },
    { id: 'returns-held', label: 'Record a send-back held: scrapped without why', model: workshopCase('buyer', partly, dialogOf({ ...(returnsDraft(returnsJob, TODAY) as Extract<WorkshopDialog, { kind: 'returns' }>), rows: { [SEW]: { finished: '2', scrapped: '1', reasonCode: '' } } }, returns)) },
    { id: 'cancel-return', label: 'Cancel an announced send-back: the reason', model: workshopCase('warehouse', partly, dialogOf({ kind: 'cancelReturn', returnNoticeId: NOTICE_ANNOUNCED.id, reason: 'Arriva tutto insieme.' }, returns)) },
    { id: 'read-only', label: 'Read-only: everything read, every act held with why', model: workshopCase('readOnly', partly, panel(readOnly)) },
    { id: 'loading', label: 'Loading', model: workshopCase('buyer', atWorkshop, panel(null)) },
    { id: 'slow', label: 'Still loading after a second', model: workshopCase('buyer', atWorkshop, panel(null, { slow: true })) },
    { id: 'error', label: 'Couldn’t be read (never drawn as empty), Try again', model: workshopCase('buyer', atWorkshop, { ...panel(null), answer: { status: 'error', problem: 'problem.offline' } }) },
  ],
})
