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
    { id: 'not-found', label: 'Not found (another company’s, or gone)', model: { role: 'owner', state: 'problem', problem: 'problem.notFound' } },
    { id: 'loading', label: 'Loading', model: { role: 'owner', state: 'loading' } },
    { id: 'error', label: "The API didn't answer", model: { role: 'owner', state: 'problem', problem: 'problem.unavailable' } },
  ],
})
