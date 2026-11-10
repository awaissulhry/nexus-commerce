import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../../quality/_shared/hooks'
import { failedRead, ready, reading } from '../../../quality/_shared/model'
import { at, COMPANY_ID, inShell, NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../../quality/_shared/fixtures'
import type { AuthorityNotice, AuthorityRequest, DistributorNotice, MarketOption, RecallDetail, RecallRow, Recipients, SendAnswer, Surveillance } from './api'
import { depthCan } from './model'
import { RecallBuilderView, type RecallDialog, type RecallPageModel } from './recall/view/RecallBuilderView'
import type { DepthDialogKind, DepthModel } from './view/types'

/**
 * The register in depth's made-up data (B-W2b-271): authority notices, requests, recalls with their progress, the
 * distributors told — "Demo" authorities, customers and styles, DEMO- numbers only. It feeds SCR-113-entry's W2b cases
 * (record/fixtures.ts), SCR-329 (notice-pdf/fixtures.ts) and SCR-328 below: the recall or withdrawal on the Builder in page
 * mode, in every state the Owner reviews (a draft before it starts, in progress with returns, its public notice live,
 * closed, cancelled, the roles, its dialogs, the step-up, loading and a failed read).
 */

const ENTRY_RISK = { id: uid('6001', 7), reference: 'REG-DEMO-2026-0007', kind: 'NON_CONFORMITY' as const, risk: 'YES' as const, status: 'OPEN' as const }
const STYLE = { id: uid('6101', 1), code: 'DEMO-JKT-01', name: 'Demo touring jacket' }
const C1 = { id: uid('6201', 1), code: 'DEMO-C01', name: 'Moto Demo S.r.l.' }
const C2 = { id: uid('6201', 2), code: 'DEMO-C02', name: 'Esempio Distribuzione S.p.A.' }
const C3 = { id: uid('6201', 3), code: 'DEMO-C03', name: 'Beispiel Motorrad GmbH' }
const PERSON = { id: uid('6901', 1), name: 'Giulia Demo' }

export const DEMO_MARKETS: MarketOption[] = [
  { code: 'IT', name: 'Italia', docLanguages: ['it'], status: 'ACTIVE' },
  { code: 'DE', name: 'Deutschland', docLanguages: ['de'], status: 'ACTIVE' },
  { code: 'FR', name: 'France', docLanguages: ['fr'], status: 'ACTIVE' },
]

const WORDS_IT =
  'Prodotto: giacca da moto DEMO-JKT-01, lotto B-DEMO-0139.\nCosa è stato riscontrato: l’etichetta CE stampata per questo lotto indica una classe inferiore a quella coperta dal certificato (dati inventati).\nRischio: il DPI può presentare un rischio.\nAzione correttiva: capi ancora in magazzino rietichettati; ai clienti chiesto di rendere i capi spediti.'
const WORDS_EN =
  'Product: motorcycle jacket DEMO-JKT-01, batch B-DEMO-0139.\nWhat was found: the CE label printed for this batch names a lower class than the certificate covers (made-up).\nRisk: the PPE may present a risk.\nCorrective action: garments still here relabelled; customers asked to return the shipped ones.'

const notice = (n: number, over: Partial<AuthorityNotice>): AuthorityNotice => ({
  id: uid('7101', n),
  companyId: COMPANY_ID,
  entryId: ENTRY_RISK.id,
  entry: ENTRY_RISK,
  marketCode: 'IT',
  market: { code: 'IT', name: 'Italia' },
  authorityName: 'Autorità di vigilanza Demo',
  channel: 'SAFETY_BUSINESS_GATEWAY',
  decision: 'RISK',
  words: { it: WORDS_IT, en: WORDS_EN },
  status: 'DRAFT',
  sentAt: null,
  sentBy: null,
  reference: null,
  file: null,
  cancelledAt: null,
  cancelReason: null,
  note: null,
  law: 'Reg. (EU) 2016/425 art. 8(8)',
  version: 2,
  createdAt: at(27, 9, 0),
  may: { edit: true, send: true, reference: false, cancel: true },
  ...over,
})

export const NOTICE_SENT = notice(1, {
  status: 'SENT',
  sentAt: at(27, 15, 10),
  sentBy: PERSON,
  reference: 'SBG-DEMO-2026-0042',
  file: { id: uid('7201', 1), name: 'notifica-SBG-DEMO.pdf', sizeBytes: 182_400, status: 'AVAILABLE' },
  version: 4,
  may: { edit: false, send: false, reference: false, cancel: false },
})
export const NOTICE_DRAFT = notice(2, {
  marketCode: 'DE',
  market: { code: 'DE', name: 'Deutschland' },
  authorityName: 'Marktüberwachung Demo',
  channel: 'AUTHORITY_SITE',
  words: { de: 'Produkt: Motorradjacke DEMO-JKT-01, Charge B-DEMO-0139 (erfundene Daten).', en: WORDS_EN },
  createdAt: at(28, 10, 0),
})
const NOTICE_CANCELLED = notice(3, { marketCode: 'FR', market: { code: 'FR', name: 'France' }, authorityName: 'Surveillance du marché Démo', status: 'CANCELLED', cancelledAt: at(27, 11, 0), cancelReason: 'Garments never reached France (made-up).', createdAt: at(26, 16, 0) })

const request = (n: number, over: Partial<AuthorityRequest>): AuthorityRequest => ({
  id: uid('7301', n),
  companyId: COMPANY_ID,
  number: `AR-DEMO-2026-${String(n).padStart(4, '0')}`,
  authorityName: 'Autorità di vigilanza Demo',
  marketCode: 'IT',
  market: { code: 'IT', name: 'Italia' },
  authorityReference: `PROT-DEMO-${100 + n}`,
  channel: 'PEC',
  receivedAt: at(25, 9, 0),
  style: STYLE,
  batchNumbers: ['B-DEMO-0139'],
  request: 'Send the declaration of conformity, the EU type-examination certificate and the production records of batch B-DEMO-0139 (made-up).',
  dueOn: '2026-11-03',
  due: { state: 'DUE_SOON', daysLeft: 5 },
  status: 'OPEN',
  answeredAt: null,
  answeredBy: null,
  answerSummary: null,
  evidence: null,
  entry: ENTRY_RISK,
  cancelledAt: null,
  cancelReason: null,
  note: null,
  law: 'Reg. (EU) 2016/425 art. 8(9); Reg. (EU) 2019/1020 art. 4(3)',
  version: 1,
  createdAt: at(25, 9, 5),
  may: { edit: true, answer: true, cancel: true, entry: false, evidence: true },
  ...over,
})

// The Countdown reads the real clock once the page runs: the near deadline is five days from today (made-up).
const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const REQUEST_SOON = request(1, { dueOn: inDays(5) })
const REQUEST_ANSWERED = request(2, {
  authorityName: 'Marktüberwachung Demo',
  marketCode: 'DE',
  market: { code: 'DE', name: 'Deutschland' },
  receivedAt: at(20, 9, 0),
  dueOn: '2026-10-24',
  due: { state: 'ANSWERED', daysLeft: null },
  status: 'ANSWERED',
  answeredAt: at(23, 12, 0),
  answeredBy: PERSON,
  answerSummary: 'Evidence pack sent by PEC.',
  evidence: { type: 'EvidencePack', id: uid('7401', 1), pack: { id: uid('7401', 1), number: 'EP-DEMO-2026-0003', status: 'BUILT', purpose: 'AUTHORITY', links: 7, builtAt: at(22, 18, 0) } },
  may: { edit: false, answer: false, cancel: false, entry: false, evidence: false },
})
const REQUEST_OVERDUE = request(3, { request: 'Explain the corrective action taken on the garments shipped (made-up).', batchNumbers: [], dueOn: '2026-10-27', due: { state: 'OVERDUE', daysLeft: -2 }, receivedAt: at(21, 9, 0) })

const progress = { customers: 2, unitsSent: 24, unitsReturned: 9, unitsRepaired: 4, unitsDestroyed: 2, unitsStillOut: 9, percentDone: 62 }

const recallRow = (n: number, over: Partial<RecallRow>): RecallRow => ({
  id: uid('7501', n),
  companyId: COMPANY_ID,
  number: `RCL-DEMO-2026-${String(n).padStart(4, '0')}`,
  kind: 'RECALL',
  status: 'ACTIVE',
  entryId: ENTRY_RISK.id,
  entry: ENTRY_RISK,
  style: STYLE,
  scope: { wholeStyle: false, batchNumbers: ['B-DEMO-0139'], serialCount: 0, workOrderCount: 1, shipmentCount: 2 },
  notice: { languages: ['it', 'en'], publishedAt: at(28, 11, 0), publishedBy: PERSON, withdrawnAt: null, live: true },
  progress,
  startedAt: at(28, 10, 30),
  startedBy: PERSON,
  closedAt: null,
  closedBy: null,
  closeNote: null,
  cancelledAt: null,
  cancelReason: null,
  note: null,
  version: 5,
  createdAt: at(28, 9, 0),
  ...over,
})

export const RECALL_ACTIVE_ROW = recallRow(2, {})
const RECALL_CANCELLED_ROW = recallRow(1, { status: 'CANCELLED', kind: 'WITHDRAWAL', startedAt: null, startedBy: null, cancelledAt: at(27, 17, 0), cancelReason: 'Replaced by the recall (made-up).', notice: { languages: [], publishedAt: null, publishedBy: null, withdrawnAt: null, live: false }, progress: { ...progress, customers: 0, unitsSent: 0, unitsReturned: 0, unitsRepaired: 0, unitsDestroyed: 0, unitsStillOut: 0, percentDone: 0 } })

const PUBLIC_WORDS = {
  it: { title: 'Richiamo della giacca DEMO-JKT-01, lotto B-DEMO-0139', problem: 'L’etichetta indica una classe di protezione più alta di quella reale (dati inventati).', action: 'Smetti di usare la giacca e riportala al negozio: la sostituiamo gratis.', contact: 'Servizio clienti Demo, +39 000 000 0000, sicurezza@example.com' },
  en: { title: 'Recall of the DEMO-JKT-01 jacket, batch B-DEMO-0139', problem: 'The label names a higher protection class than the garment has (made-up).', action: 'Stop using the jacket and bring it back to the shop: we replace it free of charge.', contact: 'Demo customer service, +39 000 000 0000, safety@example.com' },
}

export const RECALL_ACTIVE: RecallDetail = {
  ...RECALL_ACTIVE_ROW,
  serials: [],
  workOrders: [{ id: uid('6601', 39), number: 'WO-DEMO-0139', batchNumber: 'B-DEMO-0139', status: 'COMPLETED' }],
  shipments: [
    { id: uid('6801', 31), number: 'SH-DEMO-0031', status: 'DELIVERED', partyId: C1.id },
    { id: uid('6801', 29), number: 'SH-DEMO-0029', status: 'SHIPPED', partyId: C2.id },
  ],
  publicNotice: PUBLIC_WORDS,
  progressRows: [
    { id: uid('7601', 1), party: C1, shipment: { id: uid('6801', 31), number: 'SH-DEMO-0031' }, unitsSent: 14, unitsReturned: 7, unitsRepaired: 3, unitsDestroyed: 1, unitsStillOut: 3, note: null, version: 3 },
    { id: uid('7601', 2), party: C2, shipment: { id: uid('6801', 29), number: 'SH-DEMO-0029' }, unitsSent: 10, unitsReturned: 2, unitsRepaired: 1, unitsDestroyed: 1, unitsStillOut: 6, note: null, version: 2 },
  ],
  trace: {
    counts: { workOrders: 1, concerned: 126, released: 126, packed: 40, shipped: 24, returned: 9, customers: 2 },
    customers: [
      { partyId: C1.id, code: C1.code, name: C1.name, garments: 14, shipmentNumbers: ['SH-DEMO-0031'] },
      { partyId: C2.id, code: C2.code, name: C2.name, garments: 10, shipmentNumbers: ['SH-DEMO-0029'] },
    ],
    problems: [],
  },
  holds: [
    { id: uid('7701', 1), number: 'HLD-DEMO-0012', status: 'ACTIVE', subjectType: 'WorkOrder', subjects: 1, siteId: uid('6951', 1) },
    { id: uid('7701', 2), number: 'HLD-DEMO-0013', status: 'ACTIVE', subjectType: 'Shipment', subjects: 1, siteId: uid('6951', 1) },
  ],
  holdable: { workOrders: 0, serials: 0, shipments: 0 },
  distributors: { told: 1, of: 3, allTold: false },
  law: { correctiveAction: 'Reg. (EU) 2016/425 art. 8(8)', publicNotice: 'Reg. (EU) 2023/988 art. 35-36', distributors: 'Reg. (EU) 2016/425 art. 8(4)' },
  may: { edit: true, start: false, hold: false, publish: false, withdrawNotice: true, progress: true, close: true, cancel: false },
}

export const RECALL_DRAFT: RecallDetail = {
  ...RECALL_ACTIVE,
  id: uid('7501', 4),
  number: 'RCL-DEMO-2026-0004',
  status: 'DRAFT',
  startedAt: null,
  startedBy: null,
  notice: { languages: ['it', 'en'], publishedAt: null, publishedBy: null, withdrawnAt: null, live: false },
  progress: { customers: 0, unitsSent: 0, unitsReturned: 0, unitsRepaired: 0, unitsDestroyed: 0, unitsStillOut: 0, percentDone: 0 },
  progressRows: [],
  holds: [],
  holdable: { workOrders: 1, serials: 0, shipments: 1 },
  distributors: { told: 0, of: 3, allTold: false },
  trace: { ...RECALL_ACTIVE.trace, problems: [{ path: 'serials.0', code: 'UNKNOWN_SERIAL', message: 'Serial DEMO-S-009999 is not a garment of DEMO-JKT-01 (made-up).' }] },
  version: 1,
  may: { edit: true, start: true, hold: true, publish: false, withdrawNotice: false, progress: false, close: false, cancel: true },
}

const RECALL_CLOSED: RecallDetail = {
  ...RECALL_ACTIVE,
  status: 'CLOSED',
  closedAt: at(29, 8, 0),
  closedBy: PERSON,
  closeNote: 'Every garment back or remedied but three, whose riders could not be reached (made-up).',
  notice: { ...RECALL_ACTIVE.notice, withdrawnAt: at(29, 8, 5), live: false },
  may: { edit: false, start: false, hold: false, publish: false, withdrawNotice: false, progress: false, close: false, cancel: false },
}

const distributor = (n: number, over: Partial<DistributorNotice>): DistributorNotice => ({
  id: uid('7801', n),
  companyId: COMPANY_ID,
  entryId: ENTRY_RISK.id,
  recallId: RECALL_ACTIVE.id,
  recallNumber: RECALL_ACTIVE.number,
  party: C1,
  channel: 'EMAIL',
  contactName: 'Ufficio qualità Demo',
  contact: 'qualita@example.com',
  language: 'it',
  subject: 'Richiamo RCL-DEMO-2026-0002: giacca DEMO-JKT-01, lotto B-DEMO-0139',
  message: 'Gentili clienti, vi informiamo del richiamo della giacca DEMO-JKT-01 (dati inventati)…',
  status: 'DRAFT',
  sentAt: null,
  sentBy: null,
  answeredAt: null,
  answer: null,
  answeredByName: null,
  failedAt: null,
  failureReason: null,
  cancelledAt: null,
  cancelReason: null,
  mail: null,
  note: null,
  version: 1,
  createdAt: at(28, 11, 30),
  may: { edit: true, send: true, answer: false, fail: false, cancel: true },
  ...over,
})

const TOLD_C1 = distributor(1, { status: 'ANSWERED', sentAt: at(28, 12, 0), sentBy: PERSON, answeredAt: at(28, 16, 20), answer: 'Received: the 14 jackets are being called back from our shops.', answeredByName: 'M. Demo', mail: { status: 'DELIVERED' }, version: 3, may: { edit: false, send: false, answer: false, fail: false, cancel: false } })
const DRAFT_C2 = distributor(2, { party: C2, contactName: 'Qualità Esempio', contact: 'qualita@example.org' })
const FAILED_C3 = distributor(3, { party: C3, channel: 'PHONE', contactName: 'Herr Demo', contact: '+49 000 000000', language: 'de', subject: null, status: 'FAILED', sentAt: at(28, 12, 30), sentBy: PERSON, failedAt: at(28, 12, 35), failureReason: 'Nobody answered; the number is out of service (made-up).', version: 3, may: { edit: false, send: false, answer: false, fail: false, cancel: false } })

export const RECIPIENTS: Recipients = {
  entryId: ENTRY_RISK.id,
  told: 1,
  of: 3,
  allTold: false,
  informedAt: null,
  recipients: [
    { party: { ...C1, language: 'it' }, garments: 14, shipmentNumbers: ['SH-DEMO-0031'], contacts: [{ id: uid('7901', 1), name: 'Ufficio qualità Demo', email: 'qualita@example.com', phone: null, language: 'it', quality: true }], told: true, notices: [TOLD_C1] },
    { party: { ...C2, language: 'it' }, garments: 10, shipmentNumbers: ['SH-DEMO-0029'], contacts: [{ id: uid('7901', 2), name: 'Qualità Esempio', email: 'qualita@example.org', phone: null, language: 'it', quality: true }], told: false, notices: [DRAFT_C2] },
    { party: { ...C3, language: 'de' }, garments: 6, shipmentNumbers: ['SH-DEMO-0027'], contacts: [], told: false, notices: [FAILED_C3] },
  ],
  others: [],
  law: 'Reg. (EU) 2016/425 art. 8(4)',
  may: { draft: true, send: true },
}

export const RECIPIENTS_NONE: Recipients = { ...RECIPIENTS, told: 0, of: 3, recipients: RECIPIENTS.recipients.map((recipient) => ({ ...recipient, told: false, notices: [] })) }

export const SURVEILLANCE: Surveillance = {
  entry: { ...ENTRY_RISK, authorityNotifiedAt: NOTICE_SENT.sentAt, authorityReference: NOTICE_SENT.reference, distributorsInformedAt: null },
  notices: [NOTICE_SENT, NOTICE_DRAFT, NOTICE_CANCELLED],
  requests: [REQUEST_SOON, REQUEST_ANSWERED, REQUEST_OVERDUE],
  recalls: [RECALL_ACTIVE_ROW, RECALL_CANCELLED_ROW],
  distributors: { told: 1, of: 3, allTold: false },
  law: {
    authorityNotice: 'Reg. (EU) 2016/425 art. 8(8)',
    authorityRequest: 'Reg. (EU) 2016/425 art. 8(9); Reg. (EU) 2019/1020 art. 4(3)',
    distributors: 'Reg. (EU) 2016/425 art. 8(4)',
    correctiveAction: 'Reg. (EU) 2016/425 art. 8(8)',
    publicNotice: 'Reg. (EU) 2023/988 art. 35-36',
  },
  may: { manage: true, send: true },
}

export const SURVEILLANCE_EMPTY: Surveillance = { ...SURVEILLANCE, notices: [], requests: [], recalls: [], distributors: { told: 0, of: 3, allTold: false } }

export const SEND_RESULTS: SendAnswer = {
  notices: [{ ...DRAFT_C2, status: 'SENT', sentAt: NOW, sentBy: PERSON }, { ...distributor(4, { party: C3, contact: 'qualitaet@example.net', language: 'de' }) }],
  results: [
    { noticeId: DRAFT_C2.id, sent: true, problem: null },
    { noticeId: uid('7801', 4), sent: false, problem: 'The address qualitaet@example.net is on the suppression list (made-up).' },
  ],
  distributorsInformed: false,
  told: 2,
  of: 3,
}

/** The depth model of an entry for the design cases. */
export function depthOf(role: RoleCase, over: Partial<DepthModel> = {}, entry: Partial<DepthModel['entry']> = {}): DepthModel {
  return {
    prefix: PREFIX,
    can: depthCan(ROLE_PERMISSIONS[role]),
    entry: { id: ENTRY_RISK.id, companyId: COMPANY_ID, reference: ENTRY_RISK.reference, status: 'OPEN', risk: 'YES', styleId: STYLE.id, batchNumbers: ['B-DEMO-0139'], kind: 'NON_CONFORMITY', reportedAt: at(26, 11, 0), styleCode: STYLE.code, ...entry },
    surveillance: ready(SURVEILLANCE),
    recipients: ready(RECIPIENTS),
    dialog: null,
    busy: false,
    problem: null,
    noticeModal: null,
    markets: ready(DEMO_MARKETS),
    sendResults: null,
    stepUp: STEP_UP_CLOSED,
    today: '2026-10-29',
    now: Date.parse(NOW),
    ...over,
  }
}

export const noticeDialog = (notice: AuthorityNotice | null, language: string | null = null, pdfFailed = false): Partial<DepthModel> => ({
  dialog: { kind: 'notice', noticeId: notice?.id ?? null } as DepthDialogKind,
  noticeModal: notice ? { notice, pdf: pdfFailed ? failedRead('problem.unavailable') : reading(), language } : null,
})

// ---- SCR-328: the recall or withdrawal on the Builder (page mode) -----------------------------------------------------------

interface RecallDesignModel {
  readonly role: RoleCase
  readonly page: RecallPageModel
}

function recallPage(role: RoleCase, recall: RecallDetail | null, over: Partial<RecallPageModel> = {}, depth: Partial<DepthModel> = {}): RecallDesignModel {
  return {
    role,
    page: {
      prefix: PREFIX,
      can: depthCan(ROLE_PERMISSIONS[role]),
      recall: recall ? ready(recall) : reading(),
      depth: recall ? depthOf(role, depth) : null,
      reasons: ready([
        { id: uid('7951', 1), list: 'HOLD', code: 'RECALL', labelIt: 'Richiamo', labelEn: 'Recall', labelI18n: {}, icon: null, colour: null, needsDetail: false, sortOrder: 1 },
        { id: uid('7951', 2), list: 'HOLD', code: 'SUSPECT', labelIt: 'Sospetto difetto', labelEn: 'Suspected defect', labelI18n: {}, icon: null, colour: null, needsDetail: false, sortOrder: 2 },
      ]),
      dialog: null,
      busy: false,
      problem: null,
      notice: null,
      holdResult: null,
      today: '2026-10-29',
      ...over,
    },
  }
}

/** The page with its own dialog (the steps' buttons and dialogs work in review without a server). */
function RecallDesign({ model }: { model: RecallDesignModel }) {
  const [dialog, setDialog] = useState<RecallDialog | null>(model.page.dialog)
  const [depthDialog, setDepthDialog] = useState<DepthDialogKind | null>(model.page.depth?.dialog ?? null)
  useEffect(() => setDialog(model.page.dialog), [model.page.dialog])
  useEffect(() => setDepthDialog(model.page.depth?.dialog ?? null), [model.page.depth])
  const page: RecallPageModel = { ...model.page, dialog, depth: model.page.depth ? { ...model.page.depth, dialog: depthDialog } : null }
  return inShell('/compliance/register', createElement(RecallBuilderView, { model: page, actions: { onDialog: setDialog, depth: { onDialog: setDepthDialog } } }), model.role)
}

export const designScreen = defineDesignScreen<RecallDesignModel>({
  screen: 'SCR-328',
  title: 'Recall or withdrawal (Builder)',
  view: RecallDesign,
  cases: [
    {
      id: 'draft',
      label: 'A draft from the entry: scope, block stock, customers, then Start recall of 126 garments',
      model: recallPage('owner', RECALL_DRAFT, { notice: { key: 'done.recallDrafted', tone: 'success' } }, { recipients: ready(RECIPIENTS_NONE) }),
      note: 'One code could not be traced (said in words); nothing started, nothing published.',
    },
    { id: 'active', label: 'In progress: holds placed, 1 of 3 told, returns per shipment with the ProgressBar, the notice live', model: recallPage('owner', RECALL_ACTIVE) },
    { id: 'closed', label: 'Closed: how it ended; read only', model: recallPage('owner', RECALL_CLOSED) },
    {
      id: 'cancelled',
      label: 'Cancelled draft: read only',
      model: recallPage('owner', { ...RECALL_DRAFT, status: 'CANCELLED', cancelledAt: at(29, 9, 0), cancelReason: 'Opened by mistake (made-up).' }),
    },
    { id: 'withdrawal', label: 'A withdrawal (Start withdrawal of 126 garments)', model: recallPage('owner', { ...RECALL_DRAFT, kind: 'WITHDRAWAL', number: 'RCL-DEMO-2026-0005' }) },
    { id: 'dialog-hold', label: 'Block stock: the reason, one hold per kind and site', model: recallPage('owner', RECALL_DRAFT, { dialog: 'hold' }) },
    {
      id: 'holds-placed',
      label: 'Holds placed: what was held, what another hold had already',
      model: recallPage('owner', { ...RECALL_DRAFT, holds: RECALL_ACTIVE.holds, holdable: { workOrders: 0, serials: 0, shipments: 0 } }, { holdResult: { placed: [{ id: uid('7701', 1), number: 'HLD-DEMO-0012', subjectType: 'WorkOrder', subjects: 1, siteId: uid('6951', 1) }], alreadyHeld: 1 } }),
    },
    { id: 'dialog-close', label: 'Close: how it ended, with what is still out', model: recallPage('owner', RECALL_ACTIVE, { dialog: 'close' }) },
    { id: 'dialog-cancel', label: 'Cancel the draft: the reason', model: recallPage('owner', RECALL_DRAFT, { dialog: 'cancel' }) },
    { id: 'dialog-withdraw-notice', label: 'Take the public notice down', model: recallPage('owner', RECALL_ACTIVE, { dialog: 'withdrawNotice' }) },
    {
      id: 'publish-step-up',
      label: 'Publish the public notice: a fresh code first',
      model: recallPage('owner', { ...RECALL_ACTIVE, notice: { ...RECALL_ACTIVE.notice, publishedAt: null, publishedBy: null, live: false } }, {}, { stepUp: { open: true, busy: false, sentence: 'stepUp.publish', problem: null } }),
    },
    {
      id: 'send-review',
      label: 'Customers and notices: Send to 1 distributor (the review)',
      model: recallPage('owner', RECALL_ACTIVE, {}, { dialog: { kind: 'distributorSend' } }),
    },
    { id: 'send-results', label: 'A result per recipient: one sent, one address refused', model: recallPage('owner', RECALL_ACTIVE, {}, { sendResults: SEND_RESULTS }) },
    {
      id: 'refused',
      label: 'Start refused: our title with the API’s lines',
      model: recallPage('owner', RECALL_DRAFT, { problem: { key: 'refused.start', lines: ['The register entry is closed: a recall cannot start (made-up).'] } }),
    },
    { id: 'conflict', label: 'Someone changed it in the meantime: read again', model: recallPage('owner', RECALL_ACTIVE, { problem: { key: 'dialog.conflict', lines: [] } }) },
    { id: 'inspector', label: 'Quality inspector (manage + send)', model: recallPage('inspector', RECALL_ACTIVE) },
    { id: 'read-only', label: 'Read-only: every step held with its reason', model: recallPage('readOnly', RECALL_DRAFT) },
    { id: 'production', label: 'Production manager: sees it, every step held', model: recallPage('production', RECALL_ACTIVE) },
    { id: 'loading', label: 'Loading', model: recallPage('owner', null) },
    { id: 'error', label: "The API didn't answer", model: recallPage('owner', null, { recall: failedRead('problem.unavailable') }) },
    { id: 'not-found', label: 'Not found (another company’s, or gone)', model: recallPage('owner', null, { recall: failedRead('problem.notFound') }) },
  ],
})
