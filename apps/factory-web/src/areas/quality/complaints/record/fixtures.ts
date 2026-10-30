import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { RecordProblem, RecordSkeleton } from '../../_shared/parts'
import type { Complaint } from '../api'
import { canFor, complaintOf, forRole, inShell, ME, NOW, PREFIX, ROWS, SAFETY_ID, STYLES, TODAY, type RoleCase } from '../demo/fixtures'
import { ComplaintsMessages, useWords } from '../view/parts'
import { triageModel } from '../fixtures'
import type { ComplaintRecordModel, FactsDraft, RecordDialog, RecordTab } from './view-model'
import { ComplaintRecordView } from './view/ComplaintRecordView'

/**
 * Design cases of a complaint's record (SCR-113, the W2a part: Complaint · Linked records · Activity; the band's steps
 * held with their reasons; the dialogs). Made-up data only (../demo.ts). The Activity tab mounts the record panels in the
 * running app; here it shows a stand-in sentence.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly record: ComplaintRecordModel | 'loading' | 'notFound' | 'forbidden'
}

const rowOf = (id: string) => ROWS.find((row) => row.id === id)!
const NEW = rowOf(ROWS.find((row) => row.status === 'NEW')!.id)
const SAFETY = rowOf(SAFETY_ID)
const INVESTIGATING = ROWS.find((row) => row.status === 'INVESTIGATING')!
const ANSWERED = ROWS.find((row) => row.status === 'ANSWERED')!
const CLOSED = ROWS.find((row) => row.status === 'CLOSED')!

const ACKNOWLEDGED: Complaint = complaintOf(
  { ...SAFETY, safety: { state: 'ACKNOWLEDGED', raisedAt: SAFETY.safety.raisedAt, acknowledgedAt: NOW, acknowledgedById: ME } },
  { repairs: [{ id: '0190f0e2-6510-7000-8000-000000000001', number: 'REP-DEMO-0004', stage: 'AWAITING_GOODS' }] },
)

function recordModel(complaint: Complaint, role: RoleCase, over: Partial<ComplaintRecordModel> = {}): ComplaintRecordModel {
  return {
    prefix: PREFIX,
    can: canFor(role),
    tab: 'complaint',
    complaint: forRole(complaint, role),
    photos: [
      { id: 'demo-photo-1', name: 'shoulder.jpg', src: null },
      { id: 'demo-photo-2', name: 'label.jpg', src: null },
    ],
    asOf: NOW,
    live: 'live',
    offline: false,
    today: TODAY,
    notice: null,
    changedAt: null,
    edit: null,
    styles: STYLES,
    dialog: null,
    dialogBusy: false,
    dialogProblem: null,
    sites: [{ id: '0190f0e2-2222-7000-8000-000000000001', companyId: complaint.companyId, code: 'DEMO-A1', name: 'Demo plant' }],
    triage: null,
    dockOpen: false,
    hrefs: {},
    ...over,
  }
}

const facts = (complaint: Complaint): FactsDraft => ({
  description: complaint.description,
  customerRef: complaint.customerRef ?? '',
  channel: 'EMAIL',
  styleId: complaint.style?.id ?? '',
  size: complaint.size ?? '',
  serial: complaint.serial ?? '',
  batchNumber: complaint.batchNumber ?? '',
  internalNote: '',
})

/** The record panels' place (they read the API in the running app). */
function PanelsStandIn() {
  const t = useWords()
  return createElement('p', { className: 'fw-q-hint' }, t('photos.addInActivity'))
}

/** ‹ Complaints, in the page's language. */
function Back() {
  const t = useWords()
  return createElement('a', { className: 'fw-q-link', href: `${PREFIX}/quality/complaints` }, t('record.back'))
}

function RecordDesign({ model }: { model: DesignModel }) {
  const [record, setRecord] = useState(model.record)
  useEffect(() => setRecord(model.record), [model.record])
  if (record === 'loading' || record === 'notFound' || record === 'forbidden') {
    const body =
      record === 'loading'
        ? createElement(RecordSkeleton)
        : createElement(RecordProblem, { problem: record === 'notFound' ? 'problem.notFound' : 'problem.forbidden', back: createElement(Back) })
    return inShell('/quality/complaints', createElement(ComplaintsMessages, null, body), model.role)
  }
  const panels = createElement(PanelsStandIn)
  return inShell(
    '/quality/complaints',
    createElement(ComplaintRecordView, {
      model: record,
      panels,
      actions: {
        onDialog: (dialog: RecordDialog | null) => setRecord((current) => (typeof current === 'string' ? current : { ...current, dialog })),
        onEdit: (on: boolean) => setRecord((current) => (typeof current === 'string' ? current : { ...current, edit: on ? { draft: facts(current.complaint), busy: false, problem: null } : null })),
        onEditDraft: (patch: Partial<FactsDraft>) => setRecord((current) => (typeof current === 'string' || !current.edit ? current : { ...current, edit: { ...current.edit, draft: { ...current.edit.draft, ...patch } } })),
        onTriage: () => setRecord((current) => (typeof current === 'string' ? current : { ...current, triage: triageModel(NEW.id, { queue: [NEW.id] }) })),
        onTriageClose: () => setRecord((current) => (typeof current === 'string' ? current : { ...current, triage: null })),
        onTriageDraft: (patch) => setRecord((current) => (typeof current === 'string' || !current.triage ? current : { ...current, triage: { ...current.triage, draft: { ...current.triage.draft, ...patch } } })),
      },
    }),
    model.role,
  )
}

const tab = (value: RecordTab) => ({ tab: value })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-113-complaint',
  title: 'Complaint (W2a: record, linked records, activity)',
  view: RecordDesign,
  cases: [
    { id: 'new', label: 'New: Triage first (the owner)', model: { role: 'owner', record: recordModel(complaintOf(NEW), 'owner') } },
    {
      id: 'safety-raised',
      label: 'Triaged Safety: the alert not yet acknowledged; Close held',
      model: { role: 'owner', record: recordModel(complaintOf(SAFETY), 'owner') },
      note: 'The banner stays until the owner acknowledges it; Close is held: a safety complaint closes only after that.',
    },
    {
      id: 'safety-inspector',
      label: 'Quality inspector on the same: Acknowledge held (only the owner)',
      model: { role: 'inspector', record: recordModel(complaintOf(SAFETY), 'inspector') },
    },
    {
      id: 'acknowledged',
      label: 'Acknowledged and in the PPE register; a repair made from it',
      model: { role: 'owner', record: recordModel(ACKNOWLEDGED, 'owner') },
    },
    { id: 'linked', label: 'Linked records: NCR, register entry, shipment, order, garment', model: { role: 'owner', record: recordModel(ACKNOWLEDGED, 'owner', tab('linked')) } },
    { id: 'activity', label: 'Activity: the record panels', model: { role: 'owner', record: recordModel(ACKNOWLEDGED, 'owner', tab('activity')) } },
    { id: 'investigating', label: 'Investigating: Mark answered; answer overdue', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner') } },
    { id: 'answered', label: 'Answered: Close; back to investigating under ⋯', model: { role: 'owner', record: recordModel(complaintOf(ANSWERED), 'owner') } },
    { id: 'closed', label: 'Closed: read-only, every step held', model: { role: 'owner', record: recordModel(complaintOf(CLOSED), 'owner') } },
    { id: 'sales', label: 'Sales: sees and edits a new one; triage held', model: { role: 'sales', record: recordModel(complaintOf(NEW), 'sales') } },
    { id: 'read-only', label: 'Read-only: every step held with its permission', model: { role: 'readOnly', record: recordModel(complaintOf(INVESTIGATING), 'readOnly') } },
    { id: 'edit', label: 'Edit the facts (EditModeBar, ⌘S)', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { edit: { draft: facts(complaintOf(INVESTIGATING)), busy: false, problem: null } }) } },
    { id: 'triage', label: 'Triage from the record', model: { role: 'owner', record: recordModel(complaintOf(NEW), 'owner', { triage: triageModel(NEW.id, { queue: [NEW.id] }) }) } },
    { id: 'dialog-close', label: 'Close: the reason (required)', model: { role: 'owner', record: recordModel(complaintOf(ANSWERED), 'owner', { dialog: { kind: 'close', reason: '' } }) } },
    { id: 'dialog-answered', label: 'Mark answered with a note', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'move', to: 'ANSWERED', note: '' } }) } },
    { id: 'dialog-ncr', label: 'Create NCR: site and severity', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'ncr', siteId: '', severity: 'MAJOR' } }) } },
    { id: 'dialog-repair', label: 'Make a repair from the complaint', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'repair', siteId: '', received: false } }) } },
    { id: 'dialog-register', label: 'Add to the PPE register (a non-safety complaint)', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'register', risk: 'NO' } }) } },
    { id: 'dialog-acknowledge', label: 'Acknowledge the safety alert', model: { role: 'owner', record: recordModel(complaintOf(SAFETY), 'owner', { dialog: { kind: 'acknowledge' } }) } },
    {
      id: 'dialog-refused',
      label: 'Close refused: the owner has not acknowledged it (in words)',
      model: { role: 'owner', record: recordModel(complaintOf(SAFETY), 'owner', { dialog: { kind: 'close', reason: 'Answered.' }, dialogProblem: 'held.SAFETY_NOT_ACKNOWLEDGED' }) },
    },
    { id: 'changed', label: 'Changed by someone else while open: Reload', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { changedAt: NOW }) } },
    { id: 'offline', label: 'Offline: the last copy, writes held', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { live: 'offline', offline: true }) } },
    { id: 'loading', label: 'Loading', model: { role: 'owner', record: 'loading' } },
    { id: 'not-found', label: 'Not found', model: { role: 'owner', record: 'notFound' } },
    { id: 'no-permission', label: 'No permission', model: { role: 'none', record: 'forbidden' } },
  ],
})
