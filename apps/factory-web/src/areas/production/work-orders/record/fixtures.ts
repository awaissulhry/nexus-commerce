import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { WorkOrderStatus } from '../../_shared/api'
import { at, bundlesOf, canOf, cutLogOf, FINAL, inShell, PICK, PREFIX, PRINTERS, releaseCheck, ROLES, wipOf, workOrder as baseWorkOrder, type Role } from '../../_shared/fixtures'
import { PART_LOADING, type WorkOrderRecordModel } from './record-model'
import { AVAILABILITY, DAILY_ROLE_OF, dailyFor, heldWorkOrder, HOLD, HOLD_RECORD, NOTHING_TO_FINISH, releaseCheckW2a } from '../daily/demo/fixtures'
import { WorkOrderRecordView } from './view/WorkOrderRecordView'
// B-W2b-320: Materials › Substitute… (made-up).
import { BOM_LINES, dialogModel as subDialog, SUB_CAN } from '../../../warehouse/picking/substitute/demo/fixtures'
import { LABOUR, labourAs, NO_OFF_STANDARD } from '../labour/fixtures'
import type { SplitModel } from '../every-shift/use-split'
// B-W2b-130: Materials › Leather (the one shade lot rule), made-up.
import { LEATHER_GARMENT, LEATHER_MIXED, LEATHER_NONE, LEATHER_ONE, LEATHER_OUT_OF_SHADE } from './leather/fixtures'
// ---- B-TH-265: the work order on RecordFrame — its docked thread (its own notes, or an order's picked beside it), "Order files (n)" ----
import { designDockedThread } from '../../../_shared/record-frame/fixtures'
import { filesReady, leftOut, orderFilesOf, orderGroup, twoGroupsOf, twoOrdersOf } from './order-files/fixtures'
// F-PR-21
import { targetsOfRecord } from '../../../_shared/production-supervisor/model'
import { threadChoices, type ThreadPick } from './order-files/model'
import { WorkOrderThreads } from './view/WorkOrderThreads'
// ---- end B-TH-265
// ---- F-PR-05a: the band facts (customer, orders and POs, % done, health, waiting on), Report finished first, the Overview's gates,
// ONE progress table and Health with Raise to At risk (made-up customer, orders, gates and a raise) ----
import type { Milestones } from '../../../planning/milestones/api'
import type { BrandHealthView } from './health/api'
import type { HealthModel } from './health/model'
// ---- end F-PR-05a

/**
 * SCR-070 — the work order studio (design production.workorders "Record: Work order") with made-up data only: a draft
 * with its release check (blocked in words, only material short, ready), the release dialog (with the planner's reason),
 * a released, in-progress, completed, closed and cancelled one, the facts and the sizes in edit, Materials, Quality,
 * the docked thread beside every tab (B-TH-265: the work order's own notes, or an order's thread picked beside it; Activity went,
 * its tools in the thread's "⋯"), Order files (agreement T9), a change while editing, and the states (loading, error, not found, no
 * permission). Roles: Owner, Production manager, Team leader (floor supervisor in the Office), Sales (read-only).
 * Cutting & bundles is SCR-071, Operations & WIP SCR-072 (F-PR-06: Cutting and Bundles are one tab). B-W2b-130: Materials › Leather — each leather's shade lots with the hides
 * held, reserved and cut, and the one shade lot rule in words (one lot, none yet, mixed against the rule, mixed where the rule is
 * per garment, out of shade), with its states.
 */

export interface RecordCase {
  role: Role
  record: WorkOrderRecordModel
  /** B-TH-265: the thread the dock shows (default: the work order's own notes). */
  pick?: ThreadPick
  /** B-TH-265: no thread here (without threads.read): no dock, no Thread button. */
  noThread?: boolean
}

const ready = <T,>(value: T) => ({ value, problem: null })

// ---- F-PR-05a: every made-up work order has its one customer (B-PR-03's record); its order's health and gates ----
const CUSTOMER = { id: '0190f0e2-6666-7000-8000-000000000001', code: 'ALPHA', name: 'Moto Demo S.r.l.' }
type WorkOrderOf = typeof baseWorkOrder
const workOrder: WorkOrderOf = (status, extra = {}) => baseWorkOrder(status, { partyId: CUSTOMER.id, customer: CUSTOMER, mixedCustomers: false, ...extra })
const ORDER = baseWorkOrder('IN_PROGRESS').orders[0]!
export const healthView = (over: Partial<BrandHealthView> = {}): BrandHealthView => ({
  orderId: ORDER.id,
  number: ORDER.number,
  partyId: CUSTOMER.id,
  kept: true,
  computed: 'ON_TRACK',
  health: 'ON_TRACK',
  reasonCode: null,
  raise: null,
  waitingOn: 'US',
  waitingSince: at(28, 9),
  version: 4,
  ...over,
})
const RAISE: NonNullable<BrandHealthView['raise']> = { reasonCode: 'MATERIAL_LATE', note: 'Pelle rossa in ritardo dalla conceria; rientro sabato', setAt: at(27, 15, 20), setBy: { id: 'user-bea', name: 'Bea Esempio' }, until: '2026-11-03', stands: true }
export const healthModel = (role: Role, over: Partial<HealthModel> = {}, view: BrandHealthView | null = healthView()): HealthModel => ({
  orders: [{ orderId: ORDER.id, number: ORDER.number, read: { value: view, problem: null } }],
  // Design: the owner and the production manager steer the customer's production (production.brand.manage, B-PR-13).
  can: role === 'owner' || role === 'manager',
  dialog: null,
  busy: false,
  problem: null,
  ...over,
})
const ACTION = { allowed: true, refusal: null, needs: null }
const gate = (n: number, kind: 'PP_SAMPLE' | 'LEATHER_APPROVED' | 'TRIMS_IN' | 'LAB_PASSED', state: 'WAITING' | 'PASSED', targetDate: string, passedOn: string | null) => ({
  id: `0190f0e2-4545-7000-8000-00000000000${n}`,
  salesOrderId: ORDER.id,
  kind,
  label: null,
  targetDate,
  sampleRound: null,
  owner: { id: 'user-bea', name: 'Bea Esempio' },
  ownerId: 'user-bea',
  makerId: null,
  state,
  passedOn,
  passedAt: passedOn ? `${passedOn}T10:00:00.000Z` : null,
  passedBy: null,
  via: null,
  startedBefore: null,
  leather: null,
  holds: 0,
  version: 1,
  actions: { pass: ACTION, startBefore: ACTION, edit: ACTION, remove: ACTION },
})
const GATES = [gate(1, 'PP_SAMPLE', 'PASSED', '2026-10-20', '2026-10-22'), gate(2, 'LEATHER_APPROVED', 'PASSED', '2026-10-21', '2026-10-21'), gate(3, 'LAB_PASSED', 'WAITING', '2026-10-25', null)]
export const MILESTONES: Milestones = {
  today: '2026-10-29',
  timeZone: 'Europe/Rome',
  tiles: { SAMPLE: 0, LEATHER_NOT_RECEIVED: 0, LEATHER_NOT_PASSED: 0, TRIMS: 0, OTHER: 1 },
  orders: [
    {
      id: ORDER.id,
      number: ORDER.number,
      companyId: baseWorkOrder('IN_PROGRESS').companyId,
      customer: CUSTOMER,
      status: 'IN_PRODUCTION',
      promiseDate: '2026-11-06',
      customerRef: ORDER.customerRef,
      workOrders: { count: 1, notStarted: 0, byKind: [] },
      gates: GATES,
      milestones: GATES.map((entry, index) => ({ id: `ms-${index}`, kind: 'GATE' as const, gateId: entry.id, gateKind: entry.kind, label: null, salesOrderId: ORDER.id, target: entry.targetDate, actual: entry.passedOn, state: entry.state === 'PASSED' ? ('DONE' as const) : ('WAITING' as const), late: index === 0 ? 2 : index === 2 ? 4 : 0, owner: entry.owner })),
      waiting: ['OTHER'],
      late: 1,
      next: null,
      mayAddGate: ACTION,
    },
  ],
  truncated: false,
}
// ---- end F-PR-05a

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
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      reprint: null,
      waitingAt: null,
      bundleOpen: null,
      cutOpen: null,
      // B-TH-265: the order files of the work order's order (made-up) and the order whose thread may be read.
      personId: null,
      orderFiles: filesReady(orderFilesOf(workOrder(status))),
      threadChoices: threadChoices(workOrder(status).orders, { state: 'ready', read: orderFilesOf(workOrder(status)) }),
      // B-W2a-46: the W2a parts (holds, finished to stock, yield, scrap and rework, readiness) as the role reads them.
      daily: dailyFor(DAILY_ROLE_OF[role], status),
      // B-W2b-130.
      leather: ready(LEATHER_ONE),
      // F-PR-05a: the order's health (planning's gates only in the cases that show them: planning.view).
      health: healthModel(role),
      gates: null,
      preview: { can: role === 'owner' || role === 'manager', busy: false },
      partiesView: (ROLES[role] as readonly string[]).includes('parties.view'),
      // F-PR-21: the supervisor fact (drawn when the work order carries one); Change… only with production.brand.manage.
      supervisor: { can: role === 'owner' || role === 'manager', assign: null },
      ...over,
    },
  }
}

export function RecordDesign({ model }: { model: RecordCase }) {
  const wo = model.record.workOrder.status === 'ready' ? model.record.workOrder.value : null
  // B-TH-265: the docked thread beside every tab — the work order's own notes (no party: Office notes only, the 'For the floor' tick),
  // or the order's thread picked beside it (its customer's thread); none without threads.read.
  const choices = model.record.threadChoices ?? []
  const picked = choices.find((choice) => choice.orderId === model.pick) ?? null
  const thread =
    wo && !model.noThread
      ? createElement(WorkOrderThreads, {
          choices,
          pick: picked ? picked.orderId : 'workOrder',
          children: picked ? designDockedThread({ recordType: 'SalesOrder', record: picked.number, party: { name: picked.party.name, role: 'customer' } }) : designDockedThread({ recordType: 'WorkOrder', record: wo.number, party: null }),
        })
      : null
  return inShell(`/production/work-orders/${wo?.id ?? 'x'}`, createElement(WorkOrderRecordView, { model: model.record, thread }), model.role)
}

const draft = (role: Role, kind: 'blocked' | 'material' | 'ready' | 'noRevision', over: Partial<WorkOrderRecordModel> = {}) => recordCase(role, 'DRAFT', { check: ready(releaseCheck(kind)), ...over })

// B-W2b-59: Split work order (made-up pieces and materials).
const DRAFT_CELL = workOrder('DRAFT').cells[0]!
const SPLIT: SplitModel = {
  draft: { moves: { [DRAFT_CELL.id]: 2 }, dueDate: '2026-11-20', priority: '0', rush: false, note: '' },
  preview: {
    refusal: null,
    problems: [],
    numberPreview: 'WO-00013',
    parent: { pieces: 22, cells: [], materials: [{ itemId: 'm1', itemCode: 'PEL-NERA', itemName: 'Pelle nera', itemColourId: null, colourCode: 'BLK', baseUom: 'FT2', planned: '554.4000' }] },
    child: { pieces: 2, cells: [], materials: [{ itemId: 'm1', itemCode: 'PEL-NERA', itemName: 'Pelle nera', itemColourId: null, colourCode: 'BLK', baseUom: 'FT2', planned: '50.4000' }] },
  },
  reading: false,
  busy: false,
  problem: null,
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-070',
  title: 'Work order studio (Overview & release, Materials, Quality, the docked thread, Order files)',
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
    { id: 'in-progress', label: 'In progress: released garments wait — Report finished is the band’s primary (Complete in ⋯); ONE progress table', model: recordCase('manager', 'IN_PROGRESS') },
    { id: 'in-progress-nothing-released', label: 'In progress, nothing released yet: Complete held until every garment is finished', model: recordCase('manager', 'IN_PROGRESS', { daily: dailyFor('manager', 'IN_PROGRESS', { finished: { value: NOTHING_TO_FINISH, problem: null } }) }) },
    { id: 'ready-to-complete', label: 'Every garment finished, none released to stock yet: Complete (⌘↵)', model: recordCase('manager', 'IN_PROGRESS', { wip: ready(wipOf(true)), daily: dailyFor('manager', 'IN_PROGRESS', { finished: { value: NOTHING_TO_FINISH, problem: null } }) }) },
    { id: 'complete-dialog', label: 'Complete: what it does', model: recordCase('manager', 'IN_PROGRESS', { wip: ready(wipOf(true)), dialog: { kind: 'move', move: 'complete' }, daily: dailyFor('manager', 'IN_PROGRESS', { finished: { value: NOTHING_TO_FINISH, problem: null } }) }) },
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
    // ---- B-TH-265: the docked thread (the rule of picture 38) and the order files (agreement T9) ----
    {
      id: 'thread-docked',
      label: 'B-TH-265 · The work order’s notes docked beside Overview (40 %; one third on Cutting & bundles under 1600 px)',
      model: recordCase('manager', 'IN_PROGRESS'),
      note: 'The band sits in the shell’s band row with ONE status pill; the thread is docked, sticky, ⌘J hides it. The work order’s own thread has no party: Office notes only (never shared with a customer), a note may go to the tablets with its “For the floor” tick. Its “⋯” holds Activity’s tools (Add task, Ask a partner to approve, Share with a partner, Followers, Follow, Mute, Remind me). An old ?tab=activity opens Overview with the thread; ?tab=documents opens Overview (the traveller and the style revision are in the band’s ⋯).',
    },
    { id: 'thread-cutting', label: 'B-TH-265 · The thread beside Cutting (a wide grid: one third under 1600 px)', model: recordCase('manager', 'IN_PROGRESS', { tab: 'cutting' }) },
    {
      id: 'thread-order',
      label: 'B-TH-265 · The order’s thread picked beside the work order’s notes (shared with its customer)',
      model: { ...recordCase('manager', 'IN_PROGRESS'), pick: workOrder('IN_PROGRESS').orders[0]!.id },
      note: 'One thread at a time: the pick at the dock’s top says whose the order’s thread is, so nobody writes to the customer thinking it stays in the office.',
    },
    { id: 'thread-no-order-thread', label: 'B-TH-265 · The order’s thread not readable for this person: no pick, the work order’s notes only', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: filesReady(orderFilesOf(workOrder('IN_PROGRESS'), [orderGroup(workOrder('IN_PROGRESS'), { thread: null })])), threadChoices: [] }) },
    { id: 'thread-no-right', label: 'B-TH-265 · Without threads.read: no thread beside the tabs (no Thread button)', model: { ...recordCase('teamLeader', 'IN_PROGRESS'), noThread: true } },
    { id: 'order-files', label: 'B-TH-265 · Order files (4): the order’s confirmation, the lines’ artwork, the worksheet — each opened through the work order’s own route', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: filesReady(orderFilesOf(workOrder('IN_PROGRESS')), { open: true }) }) },
    { id: 'order-files-left-out', label: 'B-TH-265 · Order files: what is left out said as counts, never named', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: filesReady(leftOut(workOrder('IN_PROGRESS')), { open: true }) }) },
    { id: 'order-files-refused', label: 'B-TH-265 · Order files: a file that could not be opened, in words', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: filesReady(orderFilesOf(workOrder('IN_PROGRESS')), { open: true, problem: 'orderFiles.gone' }) }) },
    { id: 'order-files-failed', label: 'B-TH-265 · Order files could not be read: Try again', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: { files: { state: 'error', problem: 'error.offline' }, open: true, opening: null, problem: null } }) },
    { id: 'order-files-none', label: 'B-TH-265 · A work order of no order (stock): no Order files in the band', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: filesReady(orderFilesOf(workOrder('IN_PROGRESS'), [])), threadChoices: [] }) },
    // ---- F-PR-25: Order files and Order thread on the work order band ----
    { id: 'order-files-showing', label: 'F-PR-25 · Order files: a PDF being read beside the list (the viewer takes it next)', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: filesReady(orderFilesOf(workOrder('IN_PROGRESS')), { open: true, shown: { id: 'file-demo-3', name: 'Grafica schiena v3.pdf', look: 'pdf', state: 'loading' } }) }) },
    { id: 'order-files-show-failed', label: 'F-PR-25 · Order files: a file that could not be shown, in words (Try again)', model: recordCase('manager', 'IN_PROGRESS', { orderFiles: filesReady(orderFilesOf(workOrder('IN_PROGRESS')), { open: true, shown: { id: 'file-demo-1', name: 'Conferma ordine SO-DEMO-0042.pdf', look: 'pdf', state: 'error', problem: 'orderFiles.gone' } }) }) },
    { id: 'order-files-locked', label: 'F-PR-25 · Order files without the measurements right: "Measurement sheet: opens with the measurements right (1)"', model: recordCase('sales', 'IN_PROGRESS', { orderFiles: filesReady(orderFilesOf(workOrder('IN_PROGRESS'), [orderGroup(workOrder('IN_PROGRESS'), { worksheets: [], measurementsLeftOut: 1 })]), { open: true }) }) },
    {
      id: 'order-files-two-orders',
      label: 'F-PR-25 · One customer’s two orders: two groups, their PO first; the band’s "Order thread" is a menu',
      model: (() => {
        const two = twoOrdersOf(workOrder('IN_PROGRESS'))
        const read = twoGroupsOf(two)
        return recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: two }, orderFiles: filesReady(read, { open: true }), threadChoices: threadChoices(two.orders, { state: 'ready', read }) })
      })(),
    },
    // ---- end F-PR-25
    // ---- F-PR-21: the supervisor fact in the band (by name inside this one record) and its Change… ----
    { id: 'supervisor-order', label: 'F-PR-21 · "Supervisor Bea Esempio · this order" with Change…', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { supervisor: { id: 'user-demo-bea', name: 'Bea Esempio', active: true, from: 'ORDER', me: false }, youMuted: null }) } }) },
    { id: 'supervisor-default', label: 'F-PR-21 · "· customer default" (no supervisor of its own); held Change… without the right', model: recordCase('sales', 'IN_PROGRESS', { workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { supervisor: { id: 'user-demo-bea', name: 'Bea Esempio', active: true, from: 'BRAND', me: false }, youMuted: null }) } }) },
    { id: 'supervisor-muted', label: 'F-PR-21 · To the supervisor himself, who muted the order: "You muted this order"', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { supervisor: { id: 'user-demo-me', name: 'Alex Demo', active: true, from: 'ORDER', me: true }, youMuted: true }) } }) },
    { id: 'supervisor-inactive', label: 'F-PR-21 · A supervisor no longer active, said in words', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { supervisor: { id: 'user-demo-old', name: 'Dora Campione', active: false, from: 'BRAND', me: false }, youMuted: null }) } }) },
    { id: 'supervisor-not-set', label: 'F-PR-21 · "Supervisor: not set" with Change…', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { supervisor: null, youMuted: null }) } }) },
    {
      id: 'supervisor-change',
      label: 'F-PR-21 · Change… opens THE assign dialog over the work order’s order',
      model: recordCase('manager', 'IN_PROGRESS', {
        workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { supervisor: { id: 'user-demo-bea', name: 'Bea Esempio', active: true, from: 'BRAND', me: false }, youMuted: null }) },
        supervisor: { can: true, assign: { targets: targetsOfRecord(workOrder('IN_PROGRESS')), leftOut: 0, current: { name: 'Bea Esempio', from: 'BRAND' }, people: { status: 'ready', people: [{ id: 'user-demo-me', name: 'Alex Demo', me: true }, { id: 'user-demo-bea', name: 'Bea Esempio', me: false }], complete: true }, busy: false, problem: null, result: null } },
      }),
    },
    // ---- end F-PR-21
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
    // ---- B-W2a-46: the work order every day (MES-004 release blockers; holds; readiness; reserve; pick list; scrap) ----
    { id: 'w2a-draft-expected', label: 'W2a · A draft: a material short today that a sent purchase order brings in time passes (readiness Expected)', model: draft('manager', 'ready', { check: ready(releaseCheckW2a('expected')) }), note: 'The release check’s readiness line under the checks: the word and the material that needs attention.' },
    { id: 'w2a-draft-requested', label: 'W2a · A draft: the shortage only in a draft purchase order (Requested) holds the release; the planner’s reason passes it', model: draft('manager', 'material', { check: ready(releaseCheckW2a('requested')) }) },
    { id: 'w2a-held-draft', label: 'W2a · A draft on hold: the Holds check blocks the release, in words (never overridden)', model: recordCase('manager', 'DRAFT', { workOrder: { status: 'ready', value: heldWorkOrder('DRAFT') }, check: ready(releaseCheckW2a('held')), daily: dailyFor('manager', 'DRAFT', { holds: { value: [HOLD], problem: null } }) }) },
    { id: 'w2a-held', label: 'W2a · In progress, put on hold: the banner says why and where it goes back; Release the hold in the band', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: heldWorkOrder() }, daily: dailyFor('manager', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null } }) }) },
    { id: 'w2a-hold-dialog', label: 'W2a · Put on hold: the reason and its note; the floor refuses the work', model: recordCase('manager', 'IN_PROGRESS', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'hold', workOrderIds: [HOLD.subjects[0]!.id], numbers: ['WO-00009'] }, draft: { reasonCode: 'QUALITY_CHECK', note: 'Campione cuciture fuori tolleranza' } }) }) },
    { id: 'w2a-hold-held', label: 'W2a · Put on hold: held until a reason is chosen (Other asks for a note)', model: recordCase('manager', 'IN_PROGRESS', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'hold', workOrderIds: [HOLD.subjects[0]!.id], numbers: ['WO-00009'] }, draft: { reasonCode: 'OTHER', note: '' } }) }) },
    { id: 'w2a-hold-refused', label: 'W2a · Put on hold refused (changed meanwhile): said inside the dialog, the note kept', model: recordCase('manager', 'IN_PROGRESS', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'hold', workOrderIds: [HOLD.subjects[0]!.id], numbers: ['WO-00009'] }, draft: { reasonCode: 'CUSTOMER_REQUEST', note: 'Il cliente cambia il colore' }, problem: { key: 'problem.conflict' } }) }) },
    { id: 'w2a-release-hold', label: 'W2a · Release the hold (quality): the conditions in words; the statement asked where the floor names stations', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: heldWorkOrder() }, daily: dailyFor('quality', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null }, dialog: { kind: 'releaseHold', holdId: HOLD.id }, holdRecord: { value: HOLD_RECORD, problem: null } }) }) },
    { id: 'w2a-release-hold-signed', label: 'W2a · Release the hold: statement signed — Release (asks a fresh code)', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: heldWorkOrder() }, daily: dailyFor('quality', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null }, dialog: { kind: 'releaseHold', holdId: HOLD.id }, holdRecord: { value: HOLD_RECORD, problem: null }, draft: { statement: true, note: 'Nuovo campione conforme' } }) }) },
    { id: 'w2a-release-hold-placer', label: 'W2a · Release the hold held: you placed it (someone else releases it)', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: heldWorkOrder() }, daily: dailyFor('quality', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null }, dialog: { kind: 'releaseHold', holdId: HOLD.id }, holdRecord: { value: { ...HOLD_RECORD, release: { ...HOLD_RECORD.release, mayRelease: false, checks: HOLD_RECORD.release.checks.map((check) => (check.key === 'NOT_PLACER' ? { ...check, ok: false } : check)) } }, problem: null } }) }) },
    { id: 'w2a-step-up', label: 'W2a · Release the hold: the fresh code asked (step-up)', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: heldWorkOrder() }, daily: dailyFor('quality', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null }, holdRecord: { value: HOLD_RECORD, problem: null }, busy: true, stepUp: { open: true, busy: false, sentence: 'releaseHold.stepUpSentence', problem: null } }) }) },
    { id: 'w2a-held-notice', label: 'W2a · After Put on hold: the notice', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: heldWorkOrder() }, notice: { tone: 'success', words: { key: 'production-work-orders:notice.held' } }, daily: dailyFor('manager', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null } }) }) },
    { id: 'w2a-holds-no-right', label: 'W2a · Sales: holds not shown (quality.holds.view), Put on hold held with its reason', model: recordCase('sales', 'IN_PROGRESS') },
    { id: 'w2a-holds-failed', label: 'W2a · The holds could not be read: in words, with Try again', model: recordCase('manager', 'IN_PROGRESS', { daily: dailyFor('manager', 'IN_PROGRESS', { holds: { value: null, problem: 'problem.offline' } }) }) },
    { id: 'w2a-materials', label: 'W2a · Materials: the readiness word per material, Reserve leather…, Print pick list', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials' }) },
    { id: 'w2a-reserve', label: 'W2a · Reserve leather (the Find hides dialog): a hide not released or held for another order cannot be ticked, with why', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'reserve', itemId: AVAILABILITY.item.id, itemColourId: AVAILABILITY.colour!.id }, availability: { value: AVAILABILITY, problem: null } }) }) },
    { id: 'w2a-reserve-picked', label: 'W2a · Reserve leather: two hides ticked — Reserve 2 hides', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'reserve', itemId: AVAILABILITY.item.id, itemColourId: AVAILABILITY.colour!.id }, availability: { value: AVAILABILITY, problem: null }, draft: { picked: [AVAILABILITY.hides[0]!.hide.id, AVAILABILITY.hides[1]!.hide.id] } }) }) },
    { id: 'w2a-reserve-empty', label: 'W2a · Reserve leather: no hide of it at the site', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'reserve', itemId: AVAILABILITY.item.id, itemColourId: AVAILABILITY.colour!.id }, availability: { value: { ...AVAILABILITY, hides: [] }, problem: null } }) }) },
    { id: 'w2a-reserve-failed', label: 'W2a · Reserve leather: the hides could not be read', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'reserve', itemId: AVAILABILITY.item.id, itemColourId: AVAILABILITY.colour!.id }, availability: { value: null, problem: 'problem.offline' } }) }) },
    { id: 'w2a-print-pick', label: 'W2a · Print pick list: what is left to issue and where its usable stock lies', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'print', what: 'pick' } }) }) },
    { id: 'w2a-quality-scrap', label: 'W2a · Quality: scrap, rework and holds per operation and reason, with counts', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality' }) },
    { id: 'w2a-scrap-none', label: 'W2a · Quality: no scrap and no rework yet', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality', daily: dailyFor('manager', 'IN_PROGRESS', { scrap: { value: [], problem: null } }) }) },
    { id: 'w2a-scrap-loading', label: 'W2a · Quality: scrap and rework loading', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality', daily: dailyFor('manager', 'IN_PROGRESS', { scrap: { value: null, problem: null } }) }) },
    { id: 'w2a-scrap-error', label: 'W2a · Quality: scrap and rework could not be read (Try again)', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality', daily: dailyFor('manager', 'IN_PROGRESS', { scrap: { value: null, problem: 'problem.read' } }) }) },
    // ---- F-PR-06: Quality is the one scrap home; Share with the customer held on a mixed work order ----
    { id: 'quality-share', label: 'F-PR-06 · Quality: a final inspection’s report — Share with the customer… (its window, a new tab); the scrap home with its door to Scrap & rework', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality', shareReports: true }) },
    { id: 'quality-share-mixed', label: 'F-PR-06 · A work order of several customers (made before the rule): Share held — “Mixed work order: not for a customer”', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality', shareReports: true, workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { partyId: null, customer: null, mixedCustomers: true }) } }) },
    { id: 'quality-share-no-right', label: 'F-PR-06 · Without quality.documents.share: Share held, said in words', model: recordCase('manager', 'IN_PROGRESS', { tab: 'quality' }) },
    // ---- end F-PR-06
    // ---- B-W2a-72: Labour & cost (the work order's cost from the ledger; the cost grain only; never per person) ----
    { id: 'w2a-labour', label: 'W2a · Labour & cost: planned · actual · variance · per garment, the bridge, materials per lot, labour per operation', model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', LABOUR) }), note: 'Standard 4,600.00, actual so far 5,028.00 (+428.00): material +508.00 (price +196.00, usage +312.00), labour −80.00 (3,680 of 4,000 standard minutes earned).' },
    { id: 'w2a-labour-no-cost', label: 'W2a · Labour & cost · Production manager (no cost grain): the whole section needs money.cost, said in words', model: recordCase('manager', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('manager', null) }) },
    { id: 'w2a-labour-no-view', label: 'W2a · Labour & cost · without costing.view: which permission', model: recordCase('teamLeader', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('none', null) }) },
    { id: 'w2a-labour-draft', label: 'W2a · Labour & cost of a draft: nothing costed before the release', model: draft('manager', 'ready', { tab: 'labour', labour: labourAs('finance', null) }) },
    { id: 'w2a-labour-loading', label: 'W2a · Labour & cost reading', model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', { value: null, problem: null }) }) },
    { id: 'w2a-labour-error', label: "W2a · Labour & cost couldn't load: Try again (the rest of the record stays usable)", model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', { value: null, problem: 'problem.unavailable' }) }) },
    // ---- B-W2b-59: rush, split, the traveller, minutes ----
    { id: 'w2b-rush', label: 'W2b · A rush work order: the flag in the band, on Overview, edited beside the priority', model: recordCase('manager', 'IN_PROGRESS', { workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { rush: true, priority: 6 }) } }) },
    { id: 'w2b-split-from', label: 'W2b · The genealogy: split from WO-00001, and what was split from it', model: recordCase('manager', 'DRAFT', { workOrder: { status: 'ready', value: workOrder('DRAFT', { splitFrom: { id: 'wo-parent', number: 'WO-00001', status: 'DRAFT' }, splits: [{ id: 'wo-child', number: 'WO-00003', status: 'DRAFT', pieces: 4 }] }) } }) },
    { id: 'w2b-split', label: 'W2b · Split work order (a draft): the pieces to move, the preview of each side, its own due date', model: draft('manager', 'ready', { split: SPLIT }) },
    { id: 'w2b-split-empty', label: 'W2b · Split work order: held until a piece moves', model: draft('manager', 'ready', { split: { ...SPLIT, draft: { ...SPLIT.draft, moves: {} }, preview: null } }) },
    { id: 'w2b-split-over', label: 'W2b · Split work order: a size moves more than it has', model: draft('manager', 'ready', { split: { ...SPLIT, draft: { ...SPLIT.draft, moves: { [DRAFT_CELL.id]: DRAFT_CELL.quantity + 1 } }, preview: null } }) },
    { id: 'w2b-split-refused', label: 'W2b · Split work order refused (changed meanwhile): said inside the dialog', model: draft('manager', 'ready', { split: { ...SPLIT, problem: { key: 'production-every-shift:split.changed' } } }) },
    { id: 'w2b-split-held', label: 'W2b · In progress: Split held in ⋯ with the reason (the release froze the sizes)', model: recordCase('manager', 'IN_PROGRESS') },
    // B-TH-265: the Documents tab went (R-7) — Print traveller and the style revision are lines of the band's ⋯ (open it on the case).
    { id: 'w2b-traveller', label: 'W2b · The band’s ⋯: Print traveller (made on request, stored nowhere) and the style revision', model: recordCase('manager', 'IN_PROGRESS') },
    { id: 'w2b-traveller-draft', label: 'W2b · A draft’s ⋯: its traveller says the sizes are not frozen', model: draft('manager', 'ready') },
    { id: 'w2b-minutes', label: 'W2b · Labour & cost › Minutes: planned and earned per operation, work order totals only; the cost below for those who may', model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', LABOUR) }) },
    { id: 'w2b-offstandard-none', label: 'W2b · Off-standard minutes: nothing names this work order yet', model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', LABOUR, { value: NO_OFF_STANDARD, problem: null }) }) },
    { id: 'w2b-offstandard-loading', label: 'W2b · Off-standard minutes: being read', model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', LABOUR, { value: null, problem: null }) }) },
    { id: 'w2b-offstandard-failed', label: 'W2b · Off-standard minutes: the read failed, Try again', model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', LABOUR, { value: null, problem: 'problem.internal' }) }) },
    { id: 'w2b-offstandard-held', label: 'W2b · Off-standard minutes held: no production.offstandard.view, says why', model: recordCase('owner', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('finance', LABOUR, { value: null, problem: null, held: true }) }) },
    // ---- B-W2b-130: Materials › Leather (wo-leather W2b: one shade lot per order, SCM-206) ----
    { id: 'w2b-leather', label: 'W2b · Materials › Leather: one shade lot — the hides held, reserved and cut, the rule in words', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials' }), note: 'A lot opens its record. Nothing here moves stock.' },
    { id: 'w2b-leather-none', label: 'W2b · Leather: no hide yet — the first hide sets the shade lot', model: recordCase('manager', 'RELEASED', { tab: 'materials', leather: ready(LEATHER_NONE) }) },
    { id: 'w2b-leather-mixed', label: 'W2b · Leather: two shade lots against the one shade lot rule, said in words', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', leather: ready(LEATHER_MIXED) }) },
    { id: 'w2b-leather-garment', label: 'W2b · Leather: two shade lots where the rule is one per garment (allowed)', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', leather: ready(LEATHER_GARMENT) }) },
    { id: 'w2b-leather-out-of-shade', label: 'W2b · Leather: a hide of the out-of-shade group reserved', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', leather: ready(LEATHER_OUT_OF_SHADE) }) },
    { id: 'w2b-leather-loading', label: 'W2b · Leather: still being read', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', leather: PART_LOADING }) },
    { id: 'w2b-leather-error', label: 'W2b · Leather: the read failed, with Try again', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', leather: { value: null, problem: 'error.offline' } }) },
    { id: 'w2b-leather-sales', label: 'W2b · Sales (read-only): the leather’s shade lots, no pick list', model: recordCase('sales', 'IN_PROGRESS', { tab: 'materials' }) },
    { id: 'w2b-minutes-no-cost', label: 'W2b · Minutes without the cost grain: the minutes stay, the cost says why not', model: recordCase('manager', 'IN_PROGRESS', { tab: 'labour', labour: labourAs('manager', LABOUR) }) },
    // B-W2b-320: Materials › Substitute… opens the warehouse's Use a substitute (made-up).
    { id: 'w2b-320-substitute', label: 'B-W2b-320 · Materials › Substitute… (the warehouse’s Use a substitute)', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', substitute: { can: SUB_CAN, status: 'IN_PROGRESS', dialog: null } }) },
    { id: 'w2b-320-substitute-open', label: 'B-W2b-320 · Substitute…: pick the BOM line first, then its choices', model: recordCase('manager', 'IN_PROGRESS', { tab: 'materials', substitute: { can: SUB_CAN, status: 'IN_PROGRESS', dialog: subDialog({ lines: { value: BOM_LINES, problem: null }, bomLineId: BOM_LINES[0]!.bomLineId }) } }) },
    { id: 'w2b-320-substitute-held', label: 'B-W2b-320 · Substitute… held: a draft work order', model: draft('manager', 'blocked', { tab: 'materials', substitute: { can: SUB_CAN, status: 'DRAFT', dialog: null } }) },
    // ---- F-PR-05a: band facts, Report finished first, the Overview body (gates, ONE progress table, health with Raise to At risk) ----
    { id: 'band-facts', label: 'F-PR-05a · The band: customer (a link), SO and PO, % done, due, health, waiting on; Report finished as the main step', model: recordCase('owner', 'IN_PROGRESS'), note: 'Complete moved to the ⋯ while released garments wait; ⌘↵ reports them. ⋯ Preview as Moto Demo S.r.l. opens its portal (read-only, an hour).' },
    { id: 'band-code', label: 'F-PR-05a · Without parties.view: the customer by its code, no link', model: recordCase('manager', 'IN_PROGRESS') },
    { id: 'overview-gates', label: 'F-PR-05a · Overview: Gates & readiness (planning.view) — each gate a door to Time & action, the readiness line, Materials', model: recordCase('owner', 'IN_PROGRESS', { gates: { value: [MILESTONES], problem: null } }) },
    { id: 'overview-gates-loading', label: 'F-PR-05a · Gates & readiness: being read', model: recordCase('owner', 'IN_PROGRESS', { gates: { value: null, problem: null } }) },
    { id: 'overview-gates-failed', label: 'F-PR-05a · Gates & readiness: the read failed, Try again', model: recordCase('owner', 'IN_PROGRESS', { gates: { value: null, problem: 'error.offline' } }) },
    { id: 'overview-progress', label: 'F-PR-05a · ONE progress table: Ordered · Cut · In bundles · Sewn · Finished · Still to finish per colourway × size (the switch went)', model: recordCase('manager', 'IN_PROGRESS') },
    { id: 'health-raised', label: 'F-PR-05a · Health: raised to At risk by a person — the reason the customer reads, the note Office only, until when', model: recordCase('manager', 'IN_PROGRESS', { health: healthModel('manager', {}, healthView({ health: 'AT_RISK', reasonCode: 'MATERIAL_LATE', raise: RAISE, waitingOn: 'SUPPLIER', waitingSince: at(24, 9) })) }) },
    { id: 'health-raise-dialog', label: 'F-PR-05a · Raise to At risk: a curated reason (the customer reads it) and an office-only note', model: recordCase('manager', 'IN_PROGRESS', { health: healthModel('manager', { dialog: { orderId: ORDER.id }, draft: { reasonCode: 'CAPACITY', note: 'Linea 2 ferma per manutenzione fino a giovedì' } }) }) },
    { id: 'health-raise-refused', label: 'F-PR-05a · Raise refused (the health changed meanwhile): said in the dialog, read again', model: recordCase('manager', 'IN_PROGRESS', { health: healthModel('manager', { dialog: { orderId: ORDER.id }, problem: { key: 'raise.refused' }, draft: { reasonCode: 'CAPACITY', note: '' } }) }) },
    { id: 'health-late', label: 'F-PR-05a · Health: already late — Raise held with the reason (raising would change nothing)', model: recordCase('manager', 'IN_PROGRESS', { health: healthModel('manager', {}, healthView({ computed: 'LATE', health: 'LATE', waitingOn: 'BRAND', waitingSince: at(26, 15) })) }) },
    { id: 'health-not-kept', label: 'F-PR-05a · Health: the order is not followed yet (confirmed orders only)', model: recordCase('manager', 'RELEASED', { health: healthModel('manager', {}, healthView({ kept: false, computed: null, health: null, waitingOn: null, waitingSince: null, version: null })) }) },
    { id: 'health-failed', label: 'F-PR-05a · Health: the read failed, Try again (never drawn as on track)', model: recordCase('manager', 'IN_PROGRESS', { health: { ...healthModel('manager'), orders: [{ orderId: ORDER.id, number: ORDER.number, read: { value: null, problem: 'error.offline' } }] } }) },
    { id: 'health-no-right', label: 'F-PR-05a · Team leader: health read-only — Raise held (production.brand.manage)', model: recordCase('teamLeader', 'IN_PROGRESS') },
    { id: 'mixed', label: 'F-PR-05a · A work order made before the one-customer rule: Mixed customers in the band and one banner; Preview held', model: recordCase('owner', 'IN_PROGRESS', { workOrder: { status: 'ready', value: workOrder('IN_PROGRESS', { partyId: null, customer: null, mixedCustomers: true }) } }) },
  ],
})
