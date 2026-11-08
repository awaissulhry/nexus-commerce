import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
import { at, inShell, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../_shared/fixtures'
import type { CapaRecord } from '../api'
import { ACTIONS, CUSTOMERS, ME, NOW, PEOPLE, recordOf, RECORD, REPORT_EN, REPORT_IT, ROWS, TODAY } from '../demo/fixtures'
import { capaCan, closeLinesOfRecord, emptyActionDraft, problemDraftOf, type ProblemDraft, type RecordTab } from '../model'
import type { CloseDialogModel } from '../view/CloseCapaDialog'
import type { CapaRecordModel, DrawerModel, RecordDialog, ReportModel } from './view-model'
import { CapaRecordView } from './view/CapaRecordView'

/**
 * SCR-146-record — a CAPA or an 8D (Quality › Corrective actions › a record) with made-up data only (CAPA-DEMO-…, Demo
 * people): each tab of an 8D at D3, the Problem form editing and read-only, the actions with the docked drawer, every
 * dialog, the 8D report and its versions, Share with the customer, a CAPA ready to close and its close, a closed and a
 * cancelled one, refusals, the stale banner, the page's states and the role cases.
 */

type RoleKey = 'owner' | 'inspector' | 'production' | 'sales' | 'noAccess'

interface RecordCase {
  readonly role: RoleKey
  readonly record: CapaRecordModel
  readonly panels: RecordPanelsViewModel | null
}

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const PERMISSIONS: Readonly<Record<RoleKey, readonly string[]>> = {
  owner: [...ROLE_PERMISSIONS.owner, 'quality.capa.view', 'quality.capa.manage', 'quality.ncr.view', 'quality.complaints.view', 'quality.complaints.manage', 'files.manage'],
  inspector: template('quality_inspector'),
  production: template('production_manager'),
  sales: template('sales'),
  noAccess: template('warehouse'),
}
const SHELL_ROLE: Readonly<Record<RoleKey, RoleCase>> = { owner: 'owner', inspector: 'inspector', production: 'production', sales: 'sales', noAccess: 'warehouse' }
const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

const REPORT: ReportModel = { language: 'it', pdf: REPORT_IT, problem: null, keeping: false, sharing: null }

function recordCase(over: Partial<CapaRecordModel> = {}, role: RoleKey = 'owner', record: CapaRecord = RECORD): RecordCase {
  return {
    role,
    panels: (over.tab ?? 'problem') === 'activity' ? conversation : null,
    record: {
      prefix: PREFIX,
      me: ME,
      today: TODAY,
      can: capaCan(PERMISSIONS[role]),
      tab: 'problem',
      loaded: { status: 'ready', record },
      live: 'live',
      asOf: NOW,
      people: PEOPLE,
      draft: null,
      saving: false,
      cells: {},
      customers: { items: null, problem: null },
      dialog: null,
      close: null,
      notice: null,
      stale: null,
      busy: false,
      keysOpen: false,
      copied: false,
      drawer: null,
      report: REPORT,
      ...over,
    },
  }
}
const tab = (name: RecordTab, over: Partial<CapaRecordModel> = {}, role: RoleKey = 'owner', record: CapaRecord = RECORD) => recordCase({ tab: name, ...over }, role, record)
const dialog = (value: RecordDialog, over: Partial<CapaRecordModel> = {}, role: RoleKey = 'owner') => tab('actions', { dialog: value, ...over }, role)
const drawerOf = (actionId: string, over: Partial<DrawerModel> = {}): DrawerModel => ({ actionId, files: { items: [], problem: null }, uploading: false, ...over })
const closeOf = (record: CapaRecord, over: Partial<CloseDialogModel> = {}): CloseDialogModel => ({ capaId: record.capa.id, number: record.capa.number, type: record.capa.type, version: record.capa.version, lines: closeLinesOfRecord(record), note: '', busy: false, notice: null, offline: false, canClose: true, ...over })

const READY = recordOf(ROWS.find((row) => row.status === 'CHECK')!, {
  actions: ACTIONS.map((action) => ({ ...action, status: 'DONE' as const, overdue: false, doneAt: at(27, 16), doneById: action.ownerId, evidenceNote: 'Done and checked on three lots.' })),
})
const CLOSED = recordOf(ROWS.find((row) => row.status === 'CLOSED')!, { actions: ACTIONS.map((action) => ({ ...action, status: 'DONE' as const, overdue: false, doneAt: at(14), doneById: action.ownerId })) })
const CANCELLED = recordOf(ROWS.find((row) => row.status === 'CANCELLED')!)
const EDITED: ProblemDraft = { ...problemDraftOf(RECORD.capa), howMany: '6 of 120 sold; 2 more in the shop', team: [...problemDraftOf(RECORD.capa).team, { userId: PEOPLE[3]!.id, role: '' }] }
const MY_ACTION = recordOf(ROWS[0]!, { actions: ACTIONS.map((action, index) => (index === 1 ? { ...action, ownerId: ME } : action)) })

/** In the browser the drafts, dialogs, the drawer and the keys work for real (the wrapper keeps them); nothing is sent. */
function RecordDesign({ model }: { model: RecordCase }) {
  const [dialogNow, setDialog] = useState<RecordDialog | null>(model.record.dialog)
  const [draft, setDraft] = useState<ProblemDraft | null>(model.record.draft)
  const [keys, setKeys] = useState(model.record.keysOpen)
  const [close, setClose] = useState<CloseDialogModel | null>(model.record.close)
  const [drawer, setDrawer] = useState<DrawerModel | null>(model.record.drawer)
  const [report, setReport] = useState<ReportModel>(model.record.report)
  useEffect(() => {
    setDialog(model.record.dialog)
    setDraft(model.record.draft)
    setKeys(model.record.keysOpen)
    setClose(model.record.close)
    setDrawer(model.record.drawer)
    setReport(model.record.report)
  }, [model])
  const value = model.record.loaded.status === 'ready' ? model.record.loaded.record : null
  const view = createElement(CapaRecordView, {
    model: { ...model.record, dialog: dialogNow, draft, keysOpen: keys, close, drawer, report },
    panelsPreview: model.panels ?? undefined,
    actions: {
      onDialog: setDialog,
      onDialogChange: (patch) => setDialog((now) => (now ? ({ ...now, ...patch } as RecordDialog) : now)),
      onSubmitDialog: () => setDialog(null),
      onDraft: (patch) => value && setDraft((now) => ({ ...(now ?? problemDraftOf(value.capa)), ...patch })),
      onDiscard: () => setDraft(null),
      onSave: () => setDraft(null),
      onKeys: setKeys,
      onClose: () => value && setClose(closeOf(value)),
      close: { onNote: (note) => setClose((now) => (now ? { ...now, note } : now)), onCancel: () => setClose(null), onSubmit: () => setClose(null) },
      onOpenAction: (id) => setDrawer(id ? drawerOf(id) : null),
      onStepAction: (by) => {
        if (!value || !drawer) return
        const index = value.actions.findIndex((action) => action.id === drawer.actionId)
        const next = value.actions[index + by]
        if (next) setDrawer(drawerOf(next.id))
      },
      onLanguage: (language) => setReport((now) => ({ ...now, language, pdf: language === 'en' ? REPORT_EN : REPORT_IT })),
    },
  })
  return inShell('/quality/capa', view, SHELL_ROLE[model.role])
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-146-record',
  title: 'Corrective action — the record',
  view: RecordDesign,
  cases: [
    { id: 'problem', label: 'Problem: an 8D at D3 — the head, D1 team, D2 problem; stage, sources, D3 containment from the NCR, causes', model: tab('problem'), note: 'Click a stage in the Stepper to move it. The band\'s primary is the next stage.' },
    { id: 'problem-editing', label: 'Problem: changed (a person added to the team without a role: Save held with the reason)', model: tab('problem', { draft: EDITED }) },
    { id: 'problem-customer', label: 'Problem: the customer picker read', model: tab('problem', { customers: { items: CUSTOMERS, problem: null } }) },
    { id: 'problem-read-only', label: 'Problem for sales: read-only, said in a banner', model: tab('problem', {}, 'sales') },
    { id: 'problem-stale', label: 'Changed elsewhere while you worked (Read it again)', model: tab('problem', { draft: EDITED, stale: '10:42' }) },
    { id: 'actions', label: 'Actions: one overdue and escalated, one open, one done with its evidence', model: tab('actions'), note: 'Cells autosave; Enter on a row docks the action beside the list.' },
    { id: 'actions-saving', label: 'Actions: a cell saving, one saved, one refused', model: tab('actions', { cells: { [`${ACTIONS[0]!.id}:dueOn`]: { state: 'saving' }, [`${ACTIONS[1]!.id}:ownerId`]: { state: 'saved' }, [`${ACTIONS[1]!.id}:description`]: { state: 'failed' } }, notice: { say: { key: 'problem.stale' }, tone: 'danger' } }) },
    { id: 'drawer', label: 'The action drawer (docked): owner, due, escalation path, reminders, evidence, history', model: tab('actions', { drawer: drawerOf(ACTIONS[0]!.id) }), note: '⌘↑ / ⌘↓ between actions.' },
    { id: 'drawer-done', label: 'The drawer of a done action: its evidence file', model: tab('actions', { drawer: drawerOf(ACTIONS[2]!.id, { files: { items: [{ id: 'demo-file-1', name: 'checked-jackets.jpg', contentType: 'image/jpeg', createdAt: at(24, 15) }], problem: null } }) }) },
    { id: 'drawer-files-reading', label: 'The drawer: its files still being read', model: tab('actions', { drawer: drawerOf(ACTIONS[1]!.id, { files: { items: null, problem: null } }) }) },
    { id: 'add', label: 'Add action (a): kind, what to do, owner, due, escalation path', model: dialog({ kind: 'addAction', draft: { ...emptyActionDraft(TODAY, ME), description: 'Change the seam allowance in the pattern', ownerId: PEOPLE[2]!.id }, busy: false, notice: null }) },
    { id: 'add-empty', label: 'Add action: held until it says what to do', model: dialog({ kind: 'addAction', draft: emptyActionDraft(TODAY, ME), busy: false, notice: null }) },
    { id: 'done', label: 'Done: the evidence in a note', model: dialog({ kind: 'done', actionId: ACTIONS[1]!.id, evidence: 'Checklist updated and shown to line 2.', busy: false, notice: null }) },
    { id: 'done-held', label: 'Done: held until the evidence is said (no file yet)', model: dialog({ kind: 'done', actionId: ACTIONS[1]!.id, evidence: '', busy: false, notice: null }) },
    { id: 'done-refused', label: 'Done refused by the factory (our words for the field)', model: dialog({ kind: 'done', actionId: ACTIONS[1]!.id, evidence: 'ok', busy: false, notice: { say: { key: 'problem.fields' }, tone: 'danger', lines: [{ key: 'field.evidenceNote' }] } }) },
    { id: 'own-action', label: 'Sales owning an action: Done open for their own action, the rest held', model: tab('actions', {}, 'sales', MY_ACTION) },
    { id: 'cancel-action', label: 'Cancel an action: the reason', model: dialog({ kind: 'cancelAction', actionId: ACTIONS[1]!.id, reason: 'Covered by action 1.', busy: false, notice: null }) },
    { id: 'stage', label: 'Move to a stage (any stage of its type, either way)', model: tab('problem', { dialog: { kind: 'stage', to: 'D2', busy: false, notice: null } }) },
    { id: 'remove-source', label: 'Remove a source (the complaint)', model: tab('problem', { dialog: { kind: 'removeSource', sourceId: RECORD.sources[1]!.id, busy: false, notice: null } }) },
    { id: 'cancel', label: 'Cancel the CAPA: the reason', model: tab('problem', { dialog: { kind: 'cancelCapa', reason: '', busy: false, notice: null } }) },
    { id: 'report', label: 'Report: the 8D preview in Italian, a version kept, Share with the customer', model: tab('report') },
    { id: 'report-english', label: 'Report in English', model: tab('report', { report: { ...REPORT, language: 'en', pdf: REPORT_EN } }) },
    { id: 'report-loading', label: 'Report: being made', model: tab('report', { report: { ...REPORT, pdf: null } }) },
    { id: 'report-error', label: 'Report: could not be made (Try again)', model: tab('report', { report: { ...REPORT, pdf: null, problem: 'problem.unavailable' } }) },
    { id: 'report-kept', label: 'Report: a version kept (the receipt)', model: tab('report', { notice: { say: { key: 'report.kept', params: { version: 2 } }, tone: 'success' } }) },
    { id: 'report-no-share', label: 'Report for an inspector without the complaint rights: Share held with the reason', model: tab('report', {}, 'inspector') },
    { id: 'activity', label: 'Activity: the record panels (thread, files, history, tasks)', model: tab('activity') },
    { id: 'ready', label: 'A CAPA at Check, every action done: the primary is Close…', model: tab('actions', {}, 'owner', READY) },
    { id: 'close', label: 'Close: every check met, the closing words written', model: tab('problem', { close: closeOf(READY, { note: 'Shade checked hide by hide since; no repeat in four orders.' }) }, 'owner', READY) },
    { id: 'close-held', label: 'Close held on the 8D: not at D8, actions open (in words)', model: tab('problem', { close: closeOf(RECORD) }) },
    { id: 'closed', label: 'A closed CAPA: read-only, the closing words', model: tab('problem', {}, 'owner', CLOSED) },
    { id: 'cancelled', label: 'A cancelled CAPA: read-only, its reason', model: tab('actions', {}, 'owner', CANCELLED) },
    { id: 'moved', label: 'Moved to the next stage (the receipt)', model: tab('problem', { notice: { say: { key: 'record.moved', params: { stage: 'D4' } }, tone: 'success' } }) },
    { id: 'refused', label: 'A step refused by the factory (our words for its codes)', model: tab('problem', { notice: { say: { key: 'problem.held' }, tone: 'danger', lines: [{ key: 'refused.NOT_LAST_STAGE' }, { key: 'refused.ACTIONS_OPEN' }] } }) },
    { id: 'shortcuts', label: 'The keys dialog (?)', model: tab('actions', { keysOpen: true }) },
    { id: 'production', label: 'Production manager: follows CAPAs up', model: tab('actions', {}, 'production') },
    { id: 'offline', label: 'Offline: the last copy, every step held', model: tab('actions', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: recordCase({ loaded: { status: 'loading' }, asOf: null, live: 'connecting' }) },
    { id: 'not-found', label: 'Not found', model: recordCase({ loaded: { status: 'notFound' } }) },
    { id: 'error', label: 'The API did not answer (Try again)', model: recordCase({ loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'no-permission', label: 'Warehouse: no permission', model: recordCase({}, 'noAccess') },
  ],
})
