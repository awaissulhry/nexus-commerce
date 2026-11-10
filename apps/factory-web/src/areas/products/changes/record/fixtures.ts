import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
import { ACCEPTED_REQUEST, APPROVED_ORDER, APPROVER_OPTIONS, canFor, COMPARE, DRAFT_ORDER, DRIFT, inShell, JACKET_DETAIL, ME, NOW, ORDER, PREFIX, REJECTED_REQUEST, REQUEST, REQUESTS, type RoleCase } from '../demo/fixtures'
import { approversOf, orderDraftOf, requestDraftOf, rowOfOrder, rowOfRequest, wipLinesOf, type RecordKind, type RecordTab } from '../model'
import type { OrderView, RequestView } from '../api'
import type { ChangeRecordModel, RecordDialog } from './view-model'
import { ChangeRecordView } from './view/ChangeRecordView'

/**
 * SCR-117-record — a change (Products › Changes & versions › a change request or a change order), made-up data only:
 * ECO-DEMO-0001 waiting for approval (every tab: Change with its redline, Impact with the work in progress and quotes on
 * an older revision, Approvals "1 of 2", Affected records, Activity), a draft change order (edit, start the draft revision,
 * approvers, work in progress, submit held), an approved one (Release held before its day), a floor request to triage, an
 * accepted request (Write a change order), a rejected one read-only, every dialog, the page's states and the role cases.
 */

interface RecordCase {
  readonly role: RoleCase
  readonly record: ChangeRecordModel
  readonly panels: RecordPanelsViewModel | null
}

const PANELS = (panelsScreen.cases.find((one) => one.id === 'conversation') ?? panelsScreen.cases[0]!).model
const panelsOf = (kind: RecordKind, value: OrderView | RequestView): RecordPanelsViewModel => ({
  ...PANELS,
  record: { type: kind === 'order' ? 'ChangeOrder' : 'ChangeRequest', id: value.id, companyId: value.companyId, siteId: null },
  title: `${value.number ?? ''} · ${value.style.code}`,
})

function base(kind: RecordKind, tab: RecordTab, value: OrderView | RequestView, role: RoleCase): ChangeRecordModel {
  return {
    prefix: PREFIX,
    me: ME,
    can: canFor(role),
    kind,
    tab,
    loaded: kind === 'order' ? { status: 'ready', order: value as OrderView } : { status: 'ready', request: value as RequestView },
    asOf: NOW,
    live: 'live',
    stale: null,
    notice: null,
    lines: [],
    busy: false,
    request: { draft: null, style: { value: JACKET_DETAIL, problem: null }, saving: false, photos: { busy: false, failed: 0 } },
    order: { draft: null, saving: false, redline: kind === 'order' ? ((value as OrderView).compare ? { compare: COMPARE, problem: null } : { compare: null, problem: null, none: true }) : null, drift: { value: DRIFT, problem: null } },
    wip: { lines: null, saving: false },
    approvers: { lines: null, options: null, pick: '', saving: false },
    carried: { ids: null, options: null, saving: false },
    dialog: null,
    decide: null,
  }
}

function order(tab: RecordTab, over: Partial<ChangeRecordModel> = {}, value: OrderView = ORDER, role: RoleCase = 'owner'): RecordCase {
  return { role, panels: tab === 'activity' ? panelsOf('order', value) : null, record: { ...base('order', tab, value, role), ...over } }
}
function request(tab: RecordTab, over: Partial<ChangeRecordModel> = {}, value: RequestView = REQUEST, role: RoleCase = 'owner'): RecordCase {
  return { role, panels: tab === 'activity' ? panelsOf('request', value) : null, record: { ...base('request', tab, value, role), ...over } }
}
const dialog = (value: RecordDialog, of: OrderView = ORDER, tab: RecordTab = 'change') => order(tab, { dialog: value }, of)

function RecordDesign({ model }: { model: RecordCase }) {
  const [record, setRecord] = useState(model.record)
  useEffect(() => setRecord(model.record), [model])
  const loadedRequest = record.loaded.status === 'ready' ? (record.loaded.request ?? null) : null
  const loadedOrder = record.loaded.status === 'ready' ? (record.loaded.order ?? null) : null
  const view = createElement(ChangeRecordView, {
    model: record,
    panelsPreview: model.panels ?? undefined,
    actions: {
      onRequestDraft: (patch) => setRecord((now) => (loadedRequest ? { ...now, request: { ...now.request, draft: { ...(now.request.draft ?? requestDraftOf(loadedRequest)), ...patch } } } : now)),
      onRequestDiscard: () => setRecord((now) => ({ ...now, request: { ...now.request, draft: null } })),
      onRequestSave: () => setRecord((now) => ({ ...now, request: { ...now.request, draft: null }, notice: { key: 'record.saved', tone: 'success' } })),
      onOrderDraft: (patch) => setRecord((now) => (loadedOrder ? { ...now, order: { ...now.order, draft: { ...(now.order.draft ?? orderDraftOf(loadedOrder)), ...patch } } } : now)),
      onOrderDiscard: () => setRecord((now) => ({ ...now, order: { ...now.order, draft: null } })),
      onOrderSave: () => setRecord((now) => ({ ...now, order: { ...now.order, draft: null }, notice: { key: 'record.saved', tone: 'success' } })),
      onUseAsNote: (note) => setRecord((now) => (loadedOrder ? { ...now, order: { ...now.order, draft: { ...(now.order.draft ?? orderDraftOf(loadedOrder)), description: note } } } : now)),
      onDisposition: (workOrderId, disposition) => setRecord((now) => (loadedOrder ? { ...now, wip: { ...now.wip, lines: (now.wip.lines ?? wipLinesOf(loadedOrder)).map((line) => (line.workOrderId === workOrderId ? { ...line, disposition } : line)) } } : now)),
      onWipDiscard: () => setRecord((now) => ({ ...now, wip: { lines: null, saving: false } })),
      onApproversEdit: () => setRecord((now) => (loadedOrder ? { ...now, approvers: { lines: approversOf(loadedOrder), options: { value: APPROVER_OPTIONS, problem: null }, pick: '', saving: false } } : now)),
      onApproverPick: (userId) => setRecord((now) => ({ ...now, approvers: { ...now.approvers, pick: userId } })),
      onApproversDiscard: () => setRecord((now) => ({ ...now, approvers: { lines: null, options: null, pick: '', saving: false } })),
      onDialog: (value) => setRecord((now) => ({ ...now, dialog: value })),
      onDialogPatch: (patch) => setRecord((now) => (now.dialog ? { ...now, dialog: { ...now.dialog, ...patch } as RecordDialog } : now)),
      onDialogSubmit: () => setRecord((now) => ({ ...now, dialog: null })),
      onDismissNotice: () => setRecord((now) => ({ ...now, notice: null, lines: [] })),
      decide: {
        onClose: () => setRecord((now) => ({ ...now, decide: null })),
        onDecide: () => setRecord((now) => ({ ...now, decide: null })),
        onReason: (reason) => setRecord((now) => (now.decide ? { ...now, decide: { ...now.decide, reason } } : now)),
      },
    },
  })
  return inShell('/products/changes', view, model.role)
}

const EDITED_ORDER = { ...orderDraftOf(DRAFT_ORDER), description: 'Pocket opening +2 cm on both knees.', effect: 'DATE' as const, effectiveDate: '2026-11-20' }
const DECIDE = { row: rowOfOrder(ORDER), ids: [rowOfOrder(ORDER).id], reading: false, problem: null, order: ORDER, request: null, minutes: null, redline: { compare: COMPARE, problem: null }, drift: { value: DRIFT, problem: null }, holds: {}, reason: '', busy: false, notice: null, offline: false }

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-117-record',
  title: 'Change — the record',
  view: RecordDesign,
  holdsPage: true,
  cases: [
    { id: 'order', label: 'Change order waiting for approval: what and why, the requests it carries, the redline (BOM, routing)', model: order('change'), note: 'Read-only while it waits: only its priority still changes.' },
    { id: 'order-impact', label: 'Impact: work in progress per open work order (what is made), quotes on an older revision', model: order('impact') },
    { id: 'order-approvals', label: 'Approvals: 1 of 2 — Carla approved, you are asked (Approve…)', model: order('approvals') },
    { id: 'order-affected', label: 'Affected records: revision 2 → 3, open orders on older revisions', model: order('affected') },
    { id: 'order-activity', label: 'Activity: the record panels (thread, files, history)', model: order('activity') },
    { id: 'decide', label: 'Approve… (A): the redline and the impact, Approve / Reject', model: order('approvals', { decide: DECIDE }) },
    { id: 'draft', label: 'A draft change order: edit what, why, when; Start the draft revision; Submit held (no draft revision)', model: order('change', {}, DRAFT_ORDER) },
    { id: 'draft-editing', label: 'A draft changed: description and the day it takes effect (the EditModeBar)', model: order('change', { order: { draft: EDITED_ORDER, saving: false, redline: { compare: null, problem: null, none: true }, drift: null } }, DRAFT_ORDER) },
    { id: 'draft-impact', label: 'A draft: the work in progress chosen per work order (saved as one list)', model: order('impact', { wip: { lines: wipLinesOf(DRAFT_ORDER).map((line) => ({ ...line, disposition: 'HOLD' as const })), saving: false } }, DRAFT_ORDER) },
    { id: 'draft-approvers', label: 'A draft: Change approvers (never the author; required or optional)', model: order('approvals', { approvers: { lines: [{ userId: APPROVER_OPTIONS.people[1]!.id, name: APPROVER_OPTIONS.people[1]!.name, required: true, decided: false }], options: { value: APPROVER_OPTIONS, problem: null }, pick: '', saving: false } }, DRAFT_ORDER) },
    { id: 'start-draft', label: 'Start the draft revision (a copy of the released one holds the change)', model: dialog({ kind: 'startDraft', changeNote: DRAFT_ORDER.title, busy: false, notice: null }, DRAFT_ORDER) },
    { id: 'approved', label: 'An approved change order: Release revision 4 held until its day', model: order('affected', {}, APPROVED_ORDER) },
    { id: 'release', label: 'Release revision 4 (the release check; the old revision becomes obsolete)', model: dialog({ kind: 'release', changeNote: APPROVED_ORDER.title, busy: false, notice: null }, APPROVED_ORDER, 'affected') },
    { id: 'cancel', label: 'Cancel change order: why', model: dialog({ kind: 'cancel', reason: '', busy: false, notice: null }) },
    { id: 'request', label: 'A floor request to triage: what and why, the work order, photos (Accept or reject…)', model: request('change') },
    { id: 'request-editing', label: 'A request changed: its priority (the EditModeBar)', model: request('change', { request: { draft: { ...requestDraftOf(REQUEST), priority: 'NORMAL' }, style: { value: JACKET_DETAIL, problem: null }, saving: false, photos: { busy: false, failed: 0 } } }) },
    { id: 'request-impact', label: 'A request: the work order where it was seen, what is already made', model: request('impact') },
    { id: 'request-approvals', label: 'A request: not sent for approval yet', model: request('approvals') },
    { id: 'request-decide', label: 'Accept or reject… (the triage)', model: request('change', { decide: { ...DECIDE, row: rowOfRequest(REQUEST), order: null, request: REQUEST, redline: null, drift: null } }) },
    { id: 'request-accepted', label: 'An accepted request: Write a change order', model: request('approvals', {}, ACCEPTED_REQUEST) },
    { id: 'request-rejected', label: 'A rejected request: read-only, the reason in a banner', model: request('change', {}, REJECTED_REQUEST) },
    { id: 'request-photos-failed', label: 'Two photos could not be sent', model: request('change', { request: { draft: null, style: { value: JACKET_DETAIL, problem: null }, saving: false, photos: { busy: false, failed: 2 } } }) },
    { id: 'request-affected', label: 'A request: the style and revision it is about', model: request('affected', {}, { ...REQUEST, ...REQUESTS[2]!, photosList: [], made: null, moves: REQUEST.moves }) },
    { id: 'refused', label: 'A save refused (our words; the field named)', model: order('change', { order: { draft: EDITED_ORDER, saving: false, redline: null, drift: null }, notice: { key: 'problem.invalid', tone: 'danger' }, lines: [{ key: 'field.effectiveDate' }] }, DRAFT_ORDER) },
    { id: 'stale', label: 'Changed elsewhere while you edited (Read it again)', model: order('change', { order: { draft: EDITED_ORDER, saving: false, redline: null, drift: null }, stale: '10:42' }, DRAFT_ORDER) },
    { id: 'offline', label: 'Offline: the change as last read, every step held', model: order('change', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: order('change', { loaded: { status: 'loading' }, asOf: null, live: 'connecting' }) },
    { id: 'not-found', label: 'Not found', model: order('change', { loaded: { status: 'notFound' } }) },
    { id: 'error', label: "Couldn't load the change (Try again)", model: order('change', { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'quality', label: 'Quality inspector: reads and approves; writes nothing on the order', model: order('approvals', {}, ORDER, 'quality') },
    { id: 'planner', label: 'Planner: reads; every act held with the reason', model: order('change', {}, ORDER, 'planner') },
    { id: 'no-permission', label: 'Warehouse: no access', model: order('change', {}, ORDER, 'warehouse') },
  ],
})
