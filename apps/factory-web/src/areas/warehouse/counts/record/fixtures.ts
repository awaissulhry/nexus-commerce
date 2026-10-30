import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import {
  CANCELLED,
  COUNTING,
  CYCLE_DRAFT,
  DIFFS,
  DONE_DIFFS,
  DONE_LINES,
  inShell,
  LINES,
  MATERIALS,
  OWN_VARIANCE,
  PLACES,
  recordModel,
  SUBMITTED,
  YEAR_END_APPLIED,
  YEAR_END_DRAFT,
  YEAR_END_SIGNED,
  type CountRole,
} from '../demo/fixtures'
import type { CountRecord } from '../api'
import type { CountRecordModel } from '../view-model'
import { CountRecordView } from './view/CountRecordView'

/**
 * SCR-132 record — a count (Warehouse › Counts › a count) with made-up data only: Lines while counting (typed counts
 * saving, saved and refused, a recount due, a hide, a found line, ⌘Z), Differences (values with the cost grain, reasons,
 * recounts, the selection's Ask recount / Give a reason, "No differences ✓"), Approval (waiting, the counter's own
 * variance held, under the limit, applied, the year-end sign-off and its frozen valued list), every dialog (Apply N
 * differences, Approve, Send back, Year-end sign-off, Found stock, Give a reason, Edit, Cancel) and the states. Roles:
 * Owner, Warehouse (the counter: no money; may not approve their own variance), Finance (signs off), Read-only, Sales.
 */

interface RecordCase {
  role: CountRole
  record: CountRecordModel
}

const recordCase = (role: CountRole, record: CountRecord | null, over: Partial<CountRecordModel> = {}): RecordCase => ({ role, record: recordModel(role, record, over) })

function RecordDesign({ model }: { model: RecordCase }) {
  return inShell('/warehouse/counts/[id]', createElement(CountRecordView, { model: model.record }), model.role)
}

const lines = (items: typeof LINES) => ({ filter: 'all' as const, q: '', locationId: null, items, more: false, problem: null })
const doneSubmitted = { lines: lines(DONE_LINES), diffs: { items: DONE_DIFFS, more: false, problem: null } }

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-132-record',
  title: 'A count (lines, differences, approval; the year-end sign-off)',
  view: RecordDesign,
  cases: [
    {
      id: 'lines-counting',
      label: 'Warehouse: counting — typed counts saving, saved and refused; ⌘Z ready',
      model: recordCase('warehouse', COUNTING, {
        cells: { [LINES[1]!.id]: { state: 'saved' }, [LINES[3]!.id]: { state: 'saving' }, [LINES[7]!.id]: { state: 'failed', words: { key: 'line.problem.number' } } },
        undo: { lineId: LINES[1]!.id, seq: 20 },
      }),
      note: 'Enter saves and goes down; 0 is not found; Esc puts the cell back; ⌘Z takes the count of line 20 back.',
    },
    { id: 'lines-owner', label: 'Owner: counting, a line moved since the snapshot', model: recordCase('owner', COUNTING) },
    { id: 'lines-filter', label: 'Lines filtered: not counted yet', model: recordCase('warehouse', COUNTING, { lines: { ...lines(LINES.filter((line) => line.status === 'UNCOUNTED')), filter: 'uncounted' } }) },
    { id: 'lines-submitted', label: 'Submitted: the lines are read only', model: recordCase('warehouse', SUBMITTED, doneSubmitted) },
    { id: 'draft-cycle', label: 'Draft cycle count: Start counting', model: recordCase('warehouse', CYCLE_DRAFT, { lines: lines([]) }) },
    { id: 'draft-year-end', label: 'Draft year-end inventory: Start held until 31 Dec 2026', model: recordCase('owner', YEAR_END_DRAFT, { lines: lines([]) }) },
    { id: 'diffs-counting', label: 'Differences while counting: two lines selected (Ask recount / Give a reason)', model: recordCase('owner', COUNTING, { tab: 'differences', selected: [DIFFS[0]!.id, DIFFS[2]!.id] }) },
    { id: 'diffs-warehouse', label: 'Differences, warehouse: no values (no cost access)', model: recordCase('warehouse', COUNTING, { tab: 'differences' }) },
    { id: 'diffs-none', label: 'Differences: No differences ✓', model: recordCase('warehouse', COUNTING, { tab: 'differences', diffs: { items: [], more: false, problem: null } }) },
    { id: 'approval-waiting', label: 'Approval: waiting — the owner may approve', model: recordCase('owner', SUBMITTED, { tab: 'approval', ...doneSubmitted }) },
    { id: 'approval-own', label: 'Approval: the counter may not approve their own variance (held, in words)', model: recordCase('warehouse', OWN_VARIANCE, { tab: 'approval', ...doneSubmitted }) },
    {
      id: 'approval-under-limit',
      label: 'Approval: under the limit — Apply approves it',
      model: recordCase(
        'warehouse',
        { ...SUBMITTED, approvalRequired: false, approval: { ...SUBMITTED.approval, required: false, held: null }, actions: { ...SUBMITTED.actions, approve: { allowed: false, reason: 'x' }, apply: { allowed: true, reason: null } } },
        { tab: 'approval', ...doneSubmitted },
      ),
    },
    { id: 'year-end-applied', label: 'Finance: year-end inventory applied — Sign off', model: recordCase('finance', YEAR_END_APPLIED, { tab: 'approval', ...doneSubmitted }) },
    { id: 'year-end-signed', label: 'Finance: signed off — the frozen valued list (PDF, XLSX)', model: recordCase('finance', YEAR_END_SIGNED, { tab: 'approval', ...doneSubmitted }) },
    { id: 'dialog-apply', label: 'Dialog: Apply 5 differences (the COUNT moves with their value)', model: recordCase('owner', { ...SUBMITTED, status: 'APPROVED', approvedAt: SUBMITTED.submittedAt, actions: { ...SUBMITTED.actions, apply: { allowed: true, reason: null } } }, { tab: 'approval', ...doneSubmitted, dialog: { kind: 'apply' } }) },
    { id: 'dialog-approve', label: 'Dialog: Approve (value against the limit)', model: recordCase('owner', SUBMITTED, { tab: 'approval', ...doneSubmitted, dialog: { kind: 'approve', note: '' } }) },
    { id: 'dialog-send-back', label: 'Dialog: Send back for a recount', model: recordCase('owner', SUBMITTED, { tab: 'approval', ...doneSubmitted, dialog: { kind: 'sendBack', reason: 'Le pelli HD-DEMO-0007 vanno ricontate.', recount: true } }) },
    { id: 'dialog-sign-off', label: 'Dialog: Year-end sign-off, the number half typed', model: recordCase('finance', YEAR_END_APPLIED, { tab: 'approval', ...doneSubmitted, dialog: { kind: 'signOff', phrase: 'CNT-D-00', language: 'it' } }) },
    { id: 'dialog-sign-off-match', label: 'Dialog: Year-end sign-off, the number typed', model: recordCase('finance', YEAR_END_APPLIED, { tab: 'approval', ...doneSubmitted, dialog: { kind: 'signOff', phrase: 'CNT-D-0009', language: 'it' } }) },
    {
      id: 'dialog-found',
      label: 'Dialog: Found stock (a line for what was not expected)',
      model: recordCase('warehouse', COUNTING, {
        dialog: {
          kind: 'found',
          found: { draft: { locationId: PLACES[2]!.id, item: MATERIALS[0]!, colourId: null, lotId: null, hideId: null, counted: '12', reasonCode: 'MISPLACED', reasonNote: '' }, places: PLACES, found: MATERIALS, searching: false, colours: [], lots: null, hides: null },
        },
      }),
    },
    { id: 'dialog-reason', label: 'Dialog: Give a reason to 2 lines (it asks for a note)', model: recordCase('owner', COUNTING, { tab: 'differences', dialog: { kind: 'reason', lineIds: [DIFFS[0]!.id, DIFFS[2]!.id], reasonCode: 'NOT_RECORDED', reasonNote: '' } }) },
    { id: 'dialog-cancel', label: 'Dialog: Cancel the count (reason first)', model: recordCase('warehouse', COUNTING, { dialog: { kind: 'cancel', reason: '' } }) },
    { id: 'dialog-edit', label: 'Dialog: Edit team and note', model: recordCase('warehouse', COUNTING, { dialog: { kind: 'edit', team: 'Squadra A', note: '' } }) },
    { id: 'refused', label: 'Submit refused, in words', model: recordCase('warehouse', COUNTING, { notice: { tone: 'danger', words: { key: 'problem.RECOUNT_DUE' } } }) },
    { id: 'cancelled', label: 'Cancelled count', model: recordCase('warehouse', CANCELLED, { tab: 'approval' }) },
    {
      id: 'read-only',
      label: 'Read-only: sees the count, changes nothing (held in words)',
      model: recordCase('readOnly', { ...COUNTING, actions: Object.fromEntries(Object.keys(COUNTING.actions).map((key) => [key, { allowed: false, reason: 'Needs inventory.counts.manage.' }])) as CountRecord['actions'] }),
    },
    { id: 'offline', label: 'Offline: live paused, a typed count not saved', model: recordCase('warehouse', COUNTING, { live: 'offline', cells: { [LINES[2]!.id]: { state: 'failed', words: { key: 'stock:problem.offline' } } } }) },
    { id: 'loading', label: 'Loading', model: recordCase('warehouse', null) },
    { id: 'error', label: "The count couldn't be read", model: recordCase('warehouse', COUNTING, { record: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'not-found', label: 'Not found (or another company)', model: recordCase('warehouse', COUNTING, { record: { status: 'not_found' } }) },
    { id: 'sales', label: 'Sales: no inventory.counts.view (the page says so)', model: recordCase('sales', COUNTING, { record: { status: 'forbidden' } }) },
  ],
})
