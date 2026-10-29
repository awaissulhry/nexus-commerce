import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { WorkOrderStatus } from '../../_shared/api'
import { bundlesOf, canOf, cutLogOf, FINAL, inShell, panels, panelsModel, PICK, PREFIX, PRINTERS, releaseCheck, wipOf, workOrder, type Role } from '../../_shared/fixtures'
import { PART_LOADING, type WorkOrderRecordModel } from './record-model'
import { WorkOrderRecordView } from './view/WorkOrderRecordView'

/**
 * SCR-070 — the work order studio (design production.workorders "Record: Work order") with made-up data only: a draft
 * with its release check (blocked in words, only material short, ready), the release dialog (with the planner's reason),
 * a released, in-progress, completed, closed and cancelled one, the facts and the sizes in edit, Materials, Quality,
 * Activity and the thread beside a tab, a change while editing, and the states (loading, error, not found, no
 * permission). Roles: Owner, Production manager, Team leader (floor supervisor in the Office), Sales (read-only).
 * Cutting is SCR-071, Bundles and Operations SCR-072.
 */

export interface RecordCase {
  role: Role
  record: WorkOrderRecordModel
}

const ready = <T,>(value: T) => ({ value, problem: null })

export function recordCase(role: Role, status: WorkOrderStatus, over: Partial<WorkOrderRecordModel> = {}): RecordCase {
  const can = canOf(role)
  const released = status !== 'DRAFT'
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      tab: 'overview',
      workOrder: { status: 'ready', value: workOrder(status) },
      check: released ? PART_LOADING : ready(releaseCheck('blocked')),
      wip: released ? ready(wipOf()) : PART_LOADING,
      cutLog: released ? ready(cutLogOf()) : PART_LOADING,
      bundles: released ? ready(bundlesOf()) : PART_LOADING,
      pick: can.pick ? (released ? ready(PICK) : PART_LOADING) : null,
      quality: can.quality ? (released ? ready(FINAL) : PART_LOADING) : null,
      printers: can.bundles ? ready(PRINTERS) : null,
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      reprint: null,
      sizeLayer: 'finished',
      waitingAt: null,
      bundleOpen: null,
      cutOpen: null,
      panelsPreview: panelsModel(),
      ...over,
    },
  }
}

export function RecordDesign({ model }: { model: RecordCase }) {
  const wo = model.record.workOrder.status === 'ready' ? model.record.workOrder.value : null
  return inShell(`/production/work-orders/${wo?.id ?? 'x'}`, createElement(WorkOrderRecordView, { model: model.record, panels: model.record.tab === 'activity' || model.record.dockOpen ? panels() : null }), model.role)
}

const draft = (role: Role, kind: 'blocked' | 'material' | 'ready' | 'noRevision', over: Partial<WorkOrderRecordModel> = {}) => recordCase(role, 'DRAFT', { check: ready(releaseCheck(kind)), ...over })

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-070',
  title: 'Work order studio (Overview & release, Materials, Quality, Activity)',
  view: RecordDesign,
  cases: [
    { id: 'draft-blocked', label: 'A draft: the release check holds it — each check in words, what holds it under it', model: draft('manager', 'blocked'), note: 'Release is held: "Release · 3 checks open". The dot on Overview says checks are open.' },
    { id: 'draft-material', label: 'A draft: only material is short — the planner may release with a reason', model: draft('manager', 'material') },
    { id: 'draft-ready', label: 'A draft: every check passes — Release (⌘↵)', model: draft('manager', 'ready') },
    {
      id: 'draft-no-revision',
      label: 'A draft whose style has no released revision: what follows from it, in words',
      model: draft('manager', 'noRevision', { workOrder: { status: 'ready', value: workOrder('DRAFT', { revision: null, labelTemplate: null }) } }),
    },
    { id: 'release-dialog', label: 'Release: what it freezes and that it never changes', model: draft('manager', 'ready', { dialog: { kind: 'release' } }) },
    { id: 'release-override', label: 'Release with material short: the override and its reason', model: draft('manager', 'material', { dialog: { kind: 'release' }, draft: { override: true, reason: 'The red leather arrives Monday; cutting starts with black' } }) },
    { id: 'release-refused', label: 'The release check changed since the page read it: a notice, the check read again', model: draft('manager', 'blocked', { notice: { tone: 'danger', words: { key: 'release.refused', params: { count: 2 } } } }) },
    { id: 'draft-sizes-edit', label: 'A draft: its sizes in edit (saved together)', model: draft('manager', 'ready', { draft: { grid: { BLK: { '48': 4, '50': 6, '52': 4, '54': 4 }, RED: { '50': 3, '52': 3 } } } }) },
    { id: 'released', label: 'Released, not started: the frozen spec, Start', model: recordCase('manager', 'RELEASED') },
    { id: 'in-progress', label: 'In progress: the size run counts finished per cell (switch the layer), Complete held until every garment is finished', model: recordCase('manager', 'IN_PROGRESS') },
    { id: 'in-progress-cut', label: 'In progress: the size run showing Cut', model: recordCase('manager', 'IN_PROGRESS', { sizeLayer: 'cut' }) },
    { id: 'ready-to-complete', label: 'Every garment finished: Complete (⌘↵)', model: recordCase('manager', 'IN_PROGRESS', { wip: ready(wipOf(true)) }) },
    { id: 'complete-dialog', label: 'Complete: what it does', model: recordCase('manager', 'IN_PROGRESS', { wip: ready(wipOf(true)), dialog: { kind: 'move', move: 'complete' } }) },
    { id: 'start-dialog', label: 'Start by hand: when work began without a scan', model: recordCase('manager', 'RELEASED', { dialog: { kind: 'move', move: 'start' } }) },
    { id: 'facts-edit', label: 'Due date and priority in edit (⌘S saves)', model: recordCase('manager', 'IN_PROGRESS', { draft: { editing: true, dueDate: '2026-11-13', priority: '9' } }) },
    { id: 'cancel-dialog', label: 'Cancel: the reason, and what happens to what was issued and cut', model: recordCase('manager', 'IN_PROGRESS', { dialog: { kind: 'cancel' } }) },
    { id: 'cancel-failed', label: 'Cancel refused (changed meanwhile): said inside the dialog, the reason kept', model: recordCase('manager', 'IN_PROGRESS', { dialog: { kind: 'cancel' }, draft: { reason: 'Customer moved the season' }, dialogProblem: { key: 'error.changed' } }) },
    { id: 'completed', label: 'Completed: Close', model: recordCase('manager', 'COMPLETED') },
    { id: 'closed', label: 'Closed: final', model: recordCase('owner', 'CLOSED') },
    { id: 'cancelled', label: 'Cancelled, with its reason', model: recordCase('manager', 'CANCELLED') },
    { id: 'materials', label: 'Materials: planned, issued and still to issue; the pick list with held stock in words', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials' }) },
    { id: 'materials-draft', label: 'Materials of a draft: what the release would freeze', model: draft('manager', 'blocked', { tab: 'materials' }) },
    { id: 'quality', label: 'Quality (read-only): inspections and released per size', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality' }) },
    { id: 'activity', label: 'Activity: the thread, files and history', model: recordCase('manager', 'IN_PROGRESS', { tab: 'activity' }) },
    { id: 'dock', label: 'The thread beside a tab (⌘J, 1280 px and wider)', model: recordCase('manager', 'IN_PROGRESS', { dockOpen: true }) },
    { id: 'changed', label: 'Someone changed it while the page holds an edit: Reload', model: recordCase('manager', 'IN_PROGRESS', { changed: { at: '2026-10-29T09:42:00.000Z' }, draft: { editing: true } }) },
    { id: 'notice', label: 'After a write: a notice', model: recordCase('manager', 'RELEASED', { notice: { tone: 'success', words: { key: 'notice.released', params: { batch: 'BA-00049' } } } }) },
    { id: 'owner', label: 'Owner: everything', model: recordCase('owner', 'IN_PROGRESS') },
    { id: 'team-leader', label: 'Team leader (floor supervisor in the Office): reads, changes nothing here', model: recordCase('teamLeader', 'IN_PROGRESS') },
    { id: 'sales', label: 'Sales (read-only): the order’s work order, no Quality tab content, no pick list', model: recordCase('sales', 'IN_PROGRESS', { tab: 'quality' }) },
    { id: 'sales-draft', label: 'Sales on a draft: Release held with its reason', model: draft('sales', 'ready') },
    { id: 'part-failed', label: 'A part failed (the pick list): in words, with Try again', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', pick: { value: null, problem: 'error.offline' } }) },
    { id: 'loading', label: 'Loading', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'loading' } }) },
    { id: 'error', label: 'The read failed', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'error', problem: 'error.offline' } }) },
    { id: 'not-found', label: 'Not found (or another company)', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'not_found' } }) },
    { id: 'no-permission', label: 'No permission (workorders.view)', model: recordCase('sales', 'IN_PROGRESS', { workOrder: { status: 'forbidden' } }) },
  ],
})
