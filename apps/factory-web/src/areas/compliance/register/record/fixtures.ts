import { createElement, useEffect, useState, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { RecordPanelsView } from '../../../../record-panels/view/RecordPanelsView'
import { canFor, inShell, NOW, PREFIX, type RoleCase } from '../../../quality/_shared/fixtures'
import { RecordProblem, RecordSkeleton } from '../../../quality/_shared/parts'
import type { EntryDetail } from '../api'
import { detailOf, ENTRIES, PARTIES, RELEASES, TRACE, TRACE_NOTHING_LEFT } from '../fixtures'
import type { EntryAction, EntryRecordModel, RecordTab } from '../model'
import { RegisterMessages } from '../view/parts'
import { EntryRecordView } from './view/EntryRecordView'
// B-W2b-271: the W2b cases (Authority notices, recall progress and the distributor log, their dialogs).
import { depthOf, NOTICE_DRAFT, NOTICE_SENT, RECIPIENTS_NONE, SEND_RESULTS, SURVEILLANCE_EMPTY } from '../depth/fixtures'
import { failedRead, ready, reading } from '../../../quality/_shared/model'
import type { DepthDialogKind, DepthModel } from '../depth/view/types'

/**
 * SCR-113-entry a PPE register entry — made-up data only (the entries of SCR-113's fixtures). Each case is one state the
 * Owner reviews: each tab, the next duty as the primary (assess → corrective action → distributors → authority →
 * close), an entry opened by a release taken back (its link), one from a lab result (the lot's link), risk yes with the
 * authority duty, a closed entry (read only: notes only), every dialog, a refused close with the API's lines, a change
 * by someone else while a dialog is open, the roles (read-only and production manager: every action held; sales: no
 * permission), loading and a failed read.
 */

const byRef = (n: number) => ENTRIES.find((row) => row.reference.endsWith(String(n).padStart(4, '0')))!

const complaint = detailOf(byRef(8), TRACE, [
  { code: 'RISK_NOT_ASSESSED', message: 'Decide whether the PPE may present a risk (yes or no) before closing.' },
  { code: 'NO_CORRECTIVE_ACTION', message: 'Record the corrective action taken, or why none is needed (Reg. (EU) 2016/425 art. 8(8)).' },
  { code: 'DISTRIBUTORS_NOT_INFORMED', message: 'Garments have left (SH-DEMO-0031, SH-DEMO-0029): record that the distributors were informed.' },
])
const reversal = detailOf(byRef(7), TRACE, [
  { code: 'AUTHORITY_NOT_NOTIFIED', message: 'The PPE may present a risk: record the notice to the market surveillance authority (Reg. (EU) 2016/425 art. 8(8)).' },
])
const recall = detailOf(byRef(6), { ...TRACE_NOTHING_LEFT, workOrders: TRACE.workOrders.map((order) => ({ ...order, reach: 'PART' as const, via: ['SERIAL' as const] })) })
const lab = detailOf(byRef(5), TRACE_NOTHING_LEFT, [{ code: 'CORRECTIVE_ACTION_NOT_DONE', message: 'Mark the corrective action as done before closing.' }])
const closed = detailOf(byRef(4), TRACE)
const readyToClose: EntryDetail = detailOf({ ...byRef(6) }, TRACE_NOTHING_LEFT)

export interface EntryDesignModel {
  readonly role: RoleCase
  readonly state: 'ready' | 'loading' | 'problem'
  readonly problem?: string
  readonly record?: EntryRecordModel
  /** B-W2b-271: the entry's W2b parts. */
  readonly depth?: DepthModel
}

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

/** The record panels as the entry mounts them (the made-up conversation of SCR-006, on this entry). */
function panelsOf(entry: EntryDetail, role: RoleCase): ReactNode {
  const model: RecordPanelsViewModel = {
    ...conversation,
    record: { type: 'PpeRegisterEntry', id: entry.id, companyId: entry.companyId, siteId: null },
    title: entry.reference,
    party: entry.party ? { id: entry.party.id, name: entry.party.name, emails: [] } : null,
    can: role === 'readOnly' ? { ...conversation.can, post: false, email: false, manage: false, upload: false, share: false } : conversation.can,
  }
  return createElement(RecordPanelsView, { model })
}

function record(role: RoleCase, entry: EntryDetail, over: Partial<EntryRecordModel> = {}): EntryDesignModel {
  return {
    role,
    state: 'ready',
    record: {
      prefix: PREFIX,
      can: canFor(role),
      tab: 'event',
      entry,
      releases: RELEASES,
      asOf: NOW,
      live: 'live',
      notice: null,
      dialog: null,
      busy: false,
      dialogProblem: null,
      changedAt: null,
      dockOpen: false,
      today: '2026-10-29',
      ...over,
    },
  }
}

/** The record with its own tab and dialog (link tabs and dialogs work in review without a server). */
function EntryDesign({ model }: { model: EntryDesignModel }) {
  const [dialog, setDialog] = useState<EntryAction | null>(model.record?.dialog ?? null)
  const [depthDialog, setDepthDialog] = useState<DepthDialogKind | null>(model.depth?.dialog ?? null)
  useEffect(() => setDepthDialog(model.depth?.dialog ?? null), [model.depth])
  const [tab, setTab] = useState<RecordTab>(model.record?.tab ?? 'event')
  useEffect(() => setDialog(model.record?.dialog ?? null), [model.record])
  useEffect(() => setTab(model.record?.tab ?? 'event'), [model.record])
  const path = '/compliance/register'
  if (model.state === 'loading') return inShell(path, createElement(RegisterMessages, null, createElement(RecordSkeleton)), model.role)
  if (model.state === 'problem' || !model.record)
    return inShell(path, createElement(RegisterMessages, null, createElement(RecordProblem, { problem: model.problem ?? 'problem.unavailable', back: null })), model.role)
  const recordModel: EntryRecordModel = { ...model.record, dialog, tab }
  const canSeeThread = model.role !== 'sales'
  return inShell(
    path,
    createElement(EntryRecordView, {
      model: recordModel,
      panels: canSeeThread ? panelsOf(model.record.entry, model.role) : undefined,
      parties: PARTIES,
      actions: { onDialog: setDialog, onCloseDialog: () => setDialog(null) },
      depth: model.depth ? { model: { ...model.depth, dialog: depthDialog }, actions: { onDialog: setDepthDialog } } : undefined,
    }),
    model.role,
  )
}

export const designScreen = defineDesignScreen<EntryDesignModel>({
  screen: 'SCR-113-entry',
  title: 'PPE register entry',
  view: EntryDesign,
  cases: [
    { id: 'event', label: 'Owner: a complaint being assessed (Event)', model: record('owner', complaint), note: 'The primary is the next duty: Assess the risk.' },
    { id: 'affected', label: 'Affected units: work orders, cells, shipments with DDTs, customers', model: record('owner', complaint, { tab: 'affected' }) },
    { id: 'actions', label: 'Actions: the duties in words with the law, what stops the close', model: record('owner', complaint, { tab: 'actions' }) },
    { id: 'activity', label: 'Activity: the thread, files and history', model: record('owner', complaint, { tab: 'activity' }) },
    { id: 'dock', label: 'The thread beside the record on a wide screen (⌘J)', model: record('owner', complaint, { dockOpen: true }) },
    {
      id: 'from-reversal',
      label: 'Opened by a release taken back: the link to the release; risk yes, the authority next',
      model: record('owner', reversal),
      note: 'Source: Release REL-DEMO-2026-0031, taken back (opens it on Inspections).',
    },
    { id: 'from-reversal-actions', label: 'Risk yes: the authority duty open', model: record('owner', reversal, { tab: 'actions' }) },
    { id: 'from-reversal-no-link', label: 'Opened by a reversal, without the right to see releases: words, no link', model: record('owner', reversal, { releases: null }) },
    { id: 'from-lab', label: 'Opened by a later Cr VI fail: the lot’s link, nothing shipped', model: record('owner', lab) },
    { id: 'recall', label: 'A recall by serials, the authority notified with its reference', model: record('owner', recall, { tab: 'actions' }) },
    { id: 'ready-to-close', label: 'Every duty met: Close entry is the primary', model: record('owner', readyToClose) },
    { id: 'closed', label: 'Closed: read only, a correction is a note', model: record('owner', closed), note: 'Every action is held: a closed entry never changes.' },
    { id: 'closed-actions', label: 'Closed: the reason and the day', model: record('owner', closed, { tab: 'actions' }) },
    { id: 'dialog-edit', label: 'Dialog: edit the event', model: record('owner', complaint, { dialog: 'edit' }) },
    { id: 'dialog-risk', label: 'Dialog: assess the risk', model: record('owner', complaint, { dialog: 'risk' }) },
    { id: 'dialog-action', label: 'Dialog: corrective action (and mark it done)', model: record('owner', lab, { dialog: 'action' }) },
    { id: 'dialog-distributors', label: 'Dialog: distributors informed (records only, sends nothing)', model: record('owner', complaint, { dialog: 'distributors' }) },
    { id: 'dialog-authority', label: 'Dialog: authority notified with its reference', model: record('owner', reversal, { dialog: 'authority' }) },
    { id: 'dialog-close', label: 'Dialog: close, with what still stops it', model: record('owner', complaint, { dialog: 'close' }) },
    {
      id: 'close-refused',
      label: 'Close refused: our title with the API’s lines',
      model: record('owner', reversal, {
        dialog: 'close',
        dialogProblem: {
          key: 'dialog.refused.close',
          lines: ['The PPE may present a risk: record the notice to the market surveillance authority (Reg. (EU) 2016/425 art. 8(8)).', "Record the authority's reference of the notice."],
        },
      }),
    },
    { id: 'conflict', label: 'Someone changed it in the meantime (read again, confirm again)', model: record('owner', complaint, { dialog: 'risk', dialogProblem: { key: 'dialog.conflict', lines: [] } }) },
    { id: 'changed', label: 'Changed by someone else while a dialog was open: Reload', model: record('owner', complaint, { changedAt: NOW }) },
    { id: 'saved', label: 'A receipt after saving', model: record('owner', reversal, { notice: { key: 'done.informed', tone: 'success', params: { reference: reversal.reference } } }) },
    { id: 'inspector', label: 'Quality inspector (view + manage)', model: record('inspector', complaint) },
    { id: 'read-only', label: 'Read-only: every action held with its reason', model: record('readOnly', complaint, { tab: 'actions' }) },
    { id: 'production', label: 'Production manager: sees the entry, every action held', model: record('production', complaint) },
    { id: 'sales', label: 'Sales: no permission', model: { role: 'sales', state: 'problem', problem: 'problem.forbidden' } },
    // B-W2b-271: the W2b parts (design rec:Register entry/authority, rg-actions W2b, pop:rg-notice, the record band's Start recall).
    ...w2bCases(),
    { id: 'not-found', label: 'Not found (another company’s, or gone)', model: { role: 'owner', state: 'problem', problem: 'problem.notFound' } },
    { id: 'loading', label: 'Loading', model: { role: 'owner', state: 'loading' } },
    { id: 'error', label: "The API didn't answer", model: { role: 'owner', state: 'problem', problem: 'problem.unavailable' } },
  ],
})

/** B-W2b-271: the entry's W2b cases — the Authority notices tab, recall progress and the distributor log, the dialogs. */
function w2bCases() {
  const w2b = (role: RoleCase, tab: RecordTab, depth: Partial<DepthModel> = {}, entry: EntryDetail = reversal): EntryDesignModel => ({ ...record(role, entry, { tab }), depth: depthOf(role, depth) })
  return [
    {
      id: 'w2b-authority',
      label: 'W2b · Authority notices: notices sent (date, authority, reference, copy) and requests (deadline, documents sent)',
      model: w2b('owner', 'authority'),
      note: 'One notice sent with its copy, one draft for Germany, one cancelled; a request due in 5 days, one answered with its evidence pack, one overdue.',
    },
    { id: 'w2b-authority-empty', label: 'W2b · Authority notices: none yet (the risk is yes: draft one per market)', model: w2b('owner', 'authority', { surveillance: ready(SURVEILLANCE_EMPTY) }) },
    { id: 'w2b-authority-loading', label: 'W2b · Authority notices: loading', model: w2b('owner', 'authority', { surveillance: reading() }) },
    { id: 'w2b-authority-error', label: 'W2b · Authority notices: the read failed (Try again)', model: w2b('owner', 'authority', { surveillance: failedRead('problem.unavailable') }) },
    {
      id: 'w2b-actions',
      label: 'W2b · Actions: recall progress (returned / remedied / disposed) and the distributor log (who, when, how, answer)',
      model: w2b('owner', 'actions'),
      note: 'Below W1’s duties. RCL-DEMO-2026-0002 in progress with its ProgressBar; 1 of 3 distributors told: one answered, one draft, one call that failed.',
    },
    { id: 'w2b-actions-none', label: 'W2b · Actions: no recall yet, nobody told (Start recall, Draft notices for 3)', model: w2b('owner', 'actions', { surveillance: ready(SURVEILLANCE_EMPTY), recipients: ready(RECIPIENTS_NONE) }) },
    { id: 'w2b-send-results', label: 'W2b · Sent: a result per recipient (one address refused)', model: w2b('owner', 'actions', { sendResults: SEND_RESULTS }) },
    { id: 'w2b-notice-new', label: 'W2b · Authority notice (new): market, channel, authority, the decision', model: w2b('owner', 'authority', { dialog: { kind: 'notice', noticeId: null } }) },
    {
      id: 'w2b-notice-new-no-markets',
      label: 'W2b · Authority notice (new), the markets unreadable: the code typed',
      model: w2b('owner', 'authority', { dialog: { kind: 'notice', noticeId: null }, markets: failedRead('problem.forbidden') }),
    },
    {
      id: 'w2b-notice-draft',
      label: 'W2b · Authority notice (draft): words per language, the PDF, Mark notice as sent with day, reference and copy',
      model: w2b('owner', 'authority', { dialog: { kind: 'notice', noticeId: NOTICE_DRAFT.id }, noticeModal: { notice: NOTICE_DRAFT, pdf: reading(), language: 'en' } }),
      note: 'Nothing is sent from here; Mark notice as sent asks a fresh code. The PDF is read from the API (here: loading).',
    },
    {
      id: 'w2b-notice-pdf-failed',
      label: 'W2b · Authority notice (draft): the PDF could not be made',
      model: w2b('owner', 'authority', { dialog: { kind: 'notice', noticeId: NOTICE_DRAFT.id }, noticeModal: { notice: NOTICE_DRAFT, pdf: failedRead('problem.unavailable'), language: 'de' } }),
    },
    {
      id: 'w2b-notice-sent',
      label: 'W2b · Authority notice (sent): read only with its reference and copy',
      model: w2b('owner', 'authority', { dialog: { kind: 'notice', noticeId: NOTICE_SENT.id }, noticeModal: { notice: NOTICE_SENT, pdf: reading(), language: 'it' } }),
    },
    {
      id: 'w2b-notice-step-up',
      label: 'W2b · Mark notice as sent: the fresh code',
      model: w2b('owner', 'authority', {
        dialog: { kind: 'notice', noticeId: NOTICE_DRAFT.id },
        noticeModal: { notice: NOTICE_DRAFT, pdf: reading(), language: 'en' },
        stepUp: { open: true, busy: false, sentence: 'stepUp.noticeSent', problem: null },
      }),
    },
    {
      id: 'w2b-notice-refused',
      label: 'W2b · Mark notice as sent refused: our title with the API’s lines',
      model: w2b('owner', 'authority', {
        dialog: { kind: 'notice', noticeId: NOTICE_DRAFT.id },
        noticeModal: { notice: NOTICE_DRAFT, pdf: reading(), language: 'en' },
        problem: { key: 'refused.noticeSent', lines: ["A notice of risk is sent only once the entry's risk is decided as yes (made-up)."] },
      }),
    },
    {
      id: 'w2b-notice-risk-held',
      label: 'W2b · A risk not decided: the RISK notice held with its reason',
      model: w2b('owner', 'authority', { dialog: { kind: 'notice', noticeId: NOTICE_DRAFT.id }, noticeModal: { notice: NOTICE_DRAFT, pdf: reading(), language: 'en' } }, { ...reversal, risk: 'ASSESSING' }),
    },
    { id: 'w2b-request-log', label: 'W2b · Log a request: authority, market, their reference, received, deadline, what they ask', model: w2b('owner', 'authority', { dialog: { kind: 'request' } }) },
    { id: 'w2b-request-evidence', label: 'W2b · Build an evidence pack for a request', model: w2b('owner', 'authority', { dialog: { kind: 'requestEvidence', requestId: depthOf('owner').surveillance.value!.requests[0]!.id } }) },
    { id: 'w2b-request-answer', label: 'W2b · Record the answer to a request', model: w2b('owner', 'authority', { dialog: { kind: 'requestAnswer', requestId: depthOf('owner').surveillance.value!.requests[0]!.id } }) },
    { id: 'w2b-distributor-edit', label: 'W2b · Review the message to one distributor (its language)', model: w2b('owner', 'actions', { dialog: { kind: 'distributorEdit', noticeId: depthOf('owner').recipients!.value!.recipients[1]!.notices[0]!.id } }) },
    { id: 'w2b-distributor-answer', label: 'W2b · Record a distributor’s answer', model: w2b('owner', 'actions', { dialog: { kind: 'distributorAnswer', noticeId: depthOf('owner').recipients!.value!.recipients[0]!.notices[0]!.id } }) },
    { id: 'w2b-send', label: 'W2b · Send to 1 distributor: the review before the code', model: w2b('owner', 'actions', { dialog: { kind: 'distributorSend' } }) },
    { id: 'w2b-start-recall', label: 'W2b · Start a recall or withdrawal (the draft comes from the entry)', model: w2b('owner', 'actions', { dialog: { kind: 'startRecall' }, surveillance: ready(SURVEILLANCE_EMPTY) }) },
    { id: 'w2b-read-only', label: 'W2b · Read-only: the notices and the log, every action held with its reason', model: w2b('readOnly', 'authority') },
    { id: 'w2b-production', label: 'W2b · Production manager: actions held', model: w2b('production', 'actions') },
    { id: 'w2b-inspector', label: 'W2b · Quality inspector (manage + send)', model: w2b('inspector', 'authority') },
  ] satisfies { id: string; label: string; model: EntryDesignModel; note?: string }[]
}
