import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
import {
  APPROVAL,
  APPROVAL_ASKED,
  APPROVAL_CE,
  APPROVAL_REJECTED,
  APPROVAL_REQUESTED,
  APPROVAL_SALES_READER,
  canFor,
  CE_ROUND,
  DECIDED_ROUND,
  FIT,
  FIT_CLOSED,
  FIT_NO_SPEC,
  inShell,
  JACKET_DETAIL,
  ME,
  NOW,
  PREFIX,
  REQUESTED_ROUND,
  ROUND,
  TODAY,
  WO_OPTIONS,
  WO_OPTIONS_NONE,
  type RoleCase,
} from '../demo/fixtures'
import { requestDraftOf, type RecordTab } from '../model'
import type { RoundView } from '../api'
import type { RecordDialog, SampleRecordModel } from './view-model'
import { SampleRecordView } from './view/SampleRecordView'

/**
 * SCR-110-record — a sample round (Products › Samples & prototypes › a round), made-up data only: SR-DEMO-0003 Fit · round
 * 2 under review, every tab (Request read and changed, Sample with its work order, Fit & comments with values outside the
 * tolerance, Approval waiting / asked / rejected with the next round and a change / a CE test sample, Shipments, Activity),
 * every dialog, a requested proto (revision changeable, Make sample work order with and without order lines), a decided
 * round read-only, the page's states and the role cases.
 */

interface RecordCase {
  readonly role: RoleCase
  readonly record: SampleRecordModel
  readonly panels: RecordPanelsViewModel | null
}

const PANELS = (panelsScreen.cases.find((one) => one.id === 'conversation') ?? panelsScreen.cases[0]!).model
const panelsOf = (round: RoundView): RecordPanelsViewModel => ({ ...PANELS, record: { type: 'SampleRound', id: round.id, companyId: round.companyId, siteId: null }, title: `${round.number} · ${round.style.code}` })

function recordCase(tab: RecordTab, over: Partial<SampleRecordModel> = {}, role: RoleCase = 'owner', round: RoundView = ROUND): RecordCase {
  return {
    role,
    panels: tab === 'activity' ? panelsOf(round) : null,
    record: {
      prefix: PREFIX,
      me: ME,
      today: TODAY,
      can: canFor(role),
      tab,
      panel: null,
      loaded: { status: 'ready', round },
      asOf: NOW,
      live: 'live',
      stale: null,
      notice: null,
      lines: [],
      busy: false,
      request: { draft: null, style: { value: JACKET_DETAIL, problem: null }, saving: false },
      fit: { part: { value: FIT, problem: null }, cells: {}, savedAt: null, failed: null, comment: { pointOfMeasureId: '', bodyArea: '', text: '', busy: false, notice: null }, working: null },
      approval: { value: APPROVAL, problem: null },
      shipmentCells: {},
      decide: null,
      dialog: null,
      ...over,
    },
  }
}

const dialog = (value: RecordDialog, tab: RecordTab = 'request', round: RoundView = ROUND, over: Partial<SampleRecordModel> = {}) => recordCase(tab, { dialog: value, ...over }, 'owner', round)
const EDITED = { ...requestDraftOf(ROUND, 'en'), dueDate: '2026-11-18', instructions: `${ROUND.instructions ?? ''} Use the new collar pattern.`, grid: { ...requestDraftOf(ROUND, 'en').grid } }

function RecordDesign({ model }: { model: RecordCase }) {
  const [record, setRecord] = useState(model.record)
  useEffect(() => setRecord(model.record), [model])
  const view = createElement(SampleRecordView, {
    model: record,
    panelsPreview: model.panels ?? undefined,
    actions: {
      onRequestDraft: (patch) => setRecord((now) => (now.loaded.status === 'ready' ? { ...now, request: { ...now.request, draft: { ...(now.request.draft ?? requestDraftOf(now.loaded.round, 'en')), ...patch } } } : now)),
      onRequestGrid: (grid) => setRecord((now) => (now.loaded.status === 'ready' ? { ...now, request: { ...now.request, draft: { ...(now.request.draft ?? requestDraftOf(now.loaded.round, 'en')), grid } } } : now)),
      onRequestDiscard: () => setRecord((now) => ({ ...now, request: { ...now.request, draft: null } })),
      onRequestSave: () => setRecord((now) => ({ ...now, request: { ...now.request, draft: null }, notice: { key: 'request.saved', tone: 'success' } })),
      onDialog: (value) => setRecord((now) => ({ ...now, dialog: value })),
      onDialogPatch: (patch) => setRecord((now) => (now.dialog ? { ...now, dialog: { ...now.dialog, ...patch } as RecordDialog } : now)),
      onDialogSubmit: () => setRecord((now) => ({ ...now, dialog: null })),
      onComment: (patch) => setRecord((now) => ({ ...now, fit: { ...now.fit, comment: { ...now.fit.comment, ...patch } } })),
      onDismissNotice: () => setRecord((now) => ({ ...now, notice: null, lines: [] })),
      decide: {
        onClose: () => setRecord((now) => ({ ...now, decide: null })),
        onSubmit: () => setRecord((now) => ({ ...now, decide: null })),
        onDraft: (patch) => setRecord((now) => (now.decide ? { ...now, decide: { ...now.decide, draft: { ...now.decide.draft, ...patch } } } : now)),
      },
    },
  })
  return inShell('/products/samples', view, model.role)
}

const workOrderDialog = (options = WO_OPTIONS, made: { id: string; number: string } | null = null): RecordDialog => ({ kind: 'workOrder', options, problem: null, lineIds: options.lines.map((line) => line.id), siteId: options.sites[0]?.id ?? '', dueDate: '2026-11-12', busy: false, notice: null, made })

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-110-record',
  title: 'Sample round — the record',
  view: RecordDesign,
  holdsPage: true,
  cases: [
    { id: 'request', label: 'Request: Fit · round 2 under review — style, pinned revision, type and round, sizes and colours, due, charge, instructions', model: recordCase('request'), note: 'Change a field: the EditModeBar counts the changes and saves with ⌘S.' },
    { id: 'request-editing', label: 'Request changed: due day and instructions (the EditModeBar)', model: recordCase('request', { request: { draft: EDITED, style: { value: JACKET_DETAIL, problem: null }, saving: false } }) },
    { id: 'request-revision', label: 'Request of a requested proto: the revision may still change', model: recordCase('request', {}, 'owner', REQUESTED_ROUND) },
    { id: 'request-read-only', label: 'Request of a decided round: read-only, said in a banner', model: recordCase('request', { approval: { value: APPROVAL_REJECTED, problem: null } }, 'owner', DECIDED_ROUND) },
    { id: 'request-planner', label: 'Request for the planner: "You can view, not change" (no charge without the price grain)', model: recordCase('request', {}, 'planner') },
    { id: 'request-stale', label: 'Changed elsewhere while you edited (Read it again)', model: recordCase('request', { request: { draft: EDITED, style: { value: JACKET_DETAIL, problem: null }, saving: false }, stale: '10:42' }) },
    { id: 'sample', label: 'Sample: what was made (the sample work order, its plant and progress; never a worker)', model: recordCase('sample') },
    { id: 'sample-none', label: 'Sample of a requested proto: no work order yet (Make sample work order)', model: recordCase('sample', { approval: { value: APPROVAL_REQUESTED, problem: null } }, 'owner', REQUESTED_ROUND) },
    { id: 'make-work-order', label: 'Make sample work order: the order line it is made on, the plant, the due day; the draft revision warned', model: dialog(workOrderDialog(), 'sample', REQUESTED_ROUND) },
    { id: 'make-work-order-none', label: 'Make sample work order held: no confirmed order line of the style', model: dialog(workOrderDialog(WO_OPTIONS_NONE), 'sample', REQUESTED_ROUND) },
    { id: 'make-work-order-made', label: 'Make sample work order: made (the receipt with its link)', model: dialog(workOrderDialog(WO_OPTIONS, { id: ROUND.workOrdersList[0]!.id, number: 'WO-DEMO-0043' }), 'sample', REQUESTED_ROUND) },
    { id: 'sample-sales', label: 'Sample for sales: Make sample work order held (needs the right to make work orders)', model: recordCase('sample', {}, 'sales', REQUESTED_ROUND) },
    { id: 'fit', label: 'Fit & comments: spec ± tolerance, measured, difference per size; two values outside listed above; comments', model: recordCase('fit'), note: 'Type a value or paste a column; each cell saves alone. "abc" is refused and the value stays.' },
    { id: 'fit-saving', label: 'Fit: two cells saving', model: recordCase('fit', { fit: { ...recordCase('fit').record.fit, cells: { a: 'saving', b: 'saving' } } }) },
    { id: 'fit-refused', label: 'Fit: a typed word refused (the value stays)', model: recordCase('fit', { fit: { ...recordCase('fit').record.fit, failed: { key: 'fit.notNumber', params: { size: '52', text: 'abc' } } } }) },
    { id: 'fit-closed', label: 'Fit of a decided round: read-only with the reason', model: recordCase('fit', { fit: { ...recordCase('fit').record.fit, part: { value: FIT_CLOSED, problem: null } } }, 'owner', DECIDED_ROUND) },
    { id: 'fit-no-spec', label: 'Fit: the pinned revision has no measurement spec yet', model: recordCase('fit', { fit: { ...recordCase('fit').record.fit, part: { value: FIT_NO_SPEC, problem: null } } }) },
    { id: 'fit-sales', label: 'Fit for sales: read (measuring is production and quality)', model: recordCase('fit', {}, 'sales') },
    { id: 'fit-error', label: "Fit: couldn't load measurements (the rest stays usable)", model: recordCase('fit', { fit: { ...recordCase('fit').record.fit, part: { value: null, problem: 'problem.unavailable' } } }) },
    { id: 'approval', label: 'Approval: waiting for a decision — Record decision, Ask the customer; the leather swatch sent', model: recordCase('approval') },
    { id: 'approval-asked', label: 'Approval: the customer asked by link, answer due; Record decision held', model: recordCase('approval', { approval: { value: APPROVAL_ASKED, problem: null } }) },
    { id: 'approval-rejected', label: 'Approval: rejected by the customer by link — Make the next round, Raise a change, the change raised', model: recordCase('approval', { approval: { value: APPROVAL_REJECTED, problem: null } }, 'owner', DECIDED_ROUND) },
    { id: 'approval-ce', label: 'Approval of a CE test sample: notified body, zones, result, certificate', model: recordCase('approval', { approval: { value: APPROVAL_CE, problem: null } }, 'owner', CE_ROUND) },
    { id: 'approval-reader', label: 'Approval for a reader: each step held with the right it needs', model: recordCase('approval', { approval: { value: APPROVAL_SALES_READER, problem: null } }, 'planner') },
    { id: 'decide', label: 'Decide on the sample (d): approved with comments, on revision 1', model: recordCase('approval', { decide: { subject: 'round', id: ROUND.id, name: { key: 'decide.subject', params: { number: ROUND.number, kind: 'kind.FIT', n: 2 } }, revision: 1, blocked: null, reading: false, problem: null, draft: { decision: 'APPROVED_WITH_COMMENTS', comments: 'Approved; sleeve −1 cm in production.' }, busy: false, notice: null, offline: false } }) },
    { id: 'decide-swatch', label: 'Decide on a leather swatch', model: recordCase('approval', { decide: { subject: 'swatch', id: APPROVAL.swatches[0]!.id, name: { key: 'decide.swatchName', params: { item: 'DEMO-COW-12 · Demo cowhide 1.2 mm', colour: 'Black' } }, revision: null, blocked: null, reading: false, problem: null, draft: { decision: 'APPROVED', comments: '' }, busy: false, notice: null, offline: false } }) },
    { id: 'next-round', label: 'Make the next round after a rejection', model: dialog({ kind: 'nextRound', dueDate: '2026-11-24', instructions: '', busy: false, notice: null }, 'approval', DECIDED_ROUND, { approval: { value: APPROVAL_REJECTED, problem: null } }) },
    { id: 'raise-change', label: 'Raise a change from the rejected round', model: dialog({ kind: 'change', title: 'Collar 52: open the neck by 1 cm', reason: DECIDED_ROUND.decisionComments ?? '', busy: false, notice: null }, 'approval', DECIDED_ROUND, { approval: { value: APPROVAL_REJECTED, problem: null } }) },
    { id: 'test-result', label: "The notified body's result of a CE test sample", model: dialog({ kind: 'testResult', result: null, busy: false, notice: null }, 'approval', CE_ROUND, { approval: { value: APPROVAL_CE, problem: null } }) },
    { id: 'shipments', label: 'Shipments: courier, tracking, sent and received (autosave per cell)', model: recordCase('shipments') },
    { id: 'shipments-ce', label: 'Shipments of a CE test sample: sent to the notified body, Received now', model: recordCase('shipments', { approval: { value: APPROVAL_CE, problem: null } }, 'owner', CE_ROUND) },
    { id: 'shipments-none', label: 'Shipments: not sent yet (Add shipment)', model: recordCase('shipments', {}, 'owner', REQUESTED_ROUND) },
    { id: 'shipments-saving', label: 'Shipments: a cell saving, one refused', model: recordCase('shipments', { shipmentCells: { [`${ROUND.shipmentsList[0]!.id}/note`]: 'saving', [`${ROUND.shipmentsList[0]!.id}/trackingNumber`]: 'failed' }, notice: { key: 'refusal.RECEIVED_ONCE', tone: 'danger' } }) },
    { id: 'add-shipment', label: 'Add shipment: courier, tracking, the tracking page', model: dialog({ kind: 'shipment', direction: 'OUTBOUND', carrierName: 'Demo Courier', trackingNumber: 'DEMO654321', trackingUrl: 'http://tracking.example.com', note: '', busy: false, notice: null, lines: [] }, 'shipments') },
    { id: 'activity', label: 'Activity: the record panels (thread, files, history, approvals)', model: recordCase('activity') },
    { id: 'cancel', label: 'Cancel round: why', model: dialog({ kind: 'cancel', reason: '', busy: false, notice: null }) },
    { id: 'moved', label: 'Moved (the receipt)', model: recordCase('request', { notice: { key: 'board.moved', params: { number: ROUND.number, stage: 'stage.SENT' }, tone: 'success' } }) },
    { id: 'refused', label: 'A save refused (our words; the field named)', model: recordCase('request', { request: { draft: EDITED, style: { value: JACKET_DETAIL, problem: null }, saving: false }, notice: { key: 'problem.invalid', tone: 'danger' }, lines: [{ key: 'field.dueDate' }] }) },
    { id: 'offline', label: 'Offline: the round as last read, every step held', model: recordCase('request', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: recordCase('request', { loaded: { status: 'loading' }, asOf: null, live: 'connecting' }) },
    { id: 'not-found', label: 'Not found', model: recordCase('request', { loaded: { status: 'notFound' } }) },
    { id: 'error', label: "Couldn't load the round (Try again)", model: recordCase('request', { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'no-permission', label: 'Warehouse: no access', model: recordCase('request', {}, 'warehouse') },
  ],
})
