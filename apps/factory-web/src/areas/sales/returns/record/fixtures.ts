import { createElement, useEffect, useState } from 'react'
import { STEP_UP_CLOSED } from '../../../quality/_shared/hooks'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BLANK_CHECKLIST, BLANK_DDT, BLANK_REPAIR, receiptDraftOf, type DecisionDraft } from '../model'
import { canFor, CREDIT_NOTES, inShell, ME, NOW, PEOPLE, PREFIX, REASONS, REPAIR_PASSED, REPAIR_RECEIVED, REPAIR_REPAIRED, REPAIR_ROWS, REPAIR_SHIPPED, RMA_AUTHORISED, RMA_INSPECTED, RMA_RECEIVED, TODAY, type RoleCase } from '../demo/fixtures'
import type { RepairModel, RmaModel } from '../view-model'
import { RepairRecordView } from '../repair/view/RepairRecordView'
import { RmaRecordView } from './view/RmaRecordView'

/**
 * Design cases of SCR-112, a return or repair record: the RMA (Lines autosaved per cell, Inspection & decision, Replacement
 * & credit, Shipments; the MilestoneTracker) and the repair order (Intake & photos, Work, Safety check with the
 * GateChecklist and the sign-off, Return), with their dialogs, read-only and held states and the role cases. Made-up
 * data only (demo/fixtures.ts).
 */

type DesignModel = { readonly kind: 'rma'; readonly role: RoleCase; readonly model: RmaModel } | { readonly kind: 'repair'; readonly role: RoleCase; readonly model: RepairModel }

function rmaModel(role: RoleCase, over: Partial<RmaModel> = {}): RmaModel {
  return {
    prefix: PREFIX,
    can: canFor(role),
    me: ME,
    tab: 'lines',
    rma: RMA_AUTHORISED,
    people: PEOPLE,
    reasons: REASONS,
    asOf: NOW,
    live: 'live',
    offline: false,
    today: TODAY,
    receipt: null,
    changedAt: null,
    marks: {},
    decisions: {},
    decisionPreview: null,
    decisionPreviewing: false,
    credit: { value: CREDIT_NOTES, problem: null },
    repairs: { items: [REPAIR_ROWS[1]!], problem: null },
    dialog: null,
    dialogBusy: false,
    dialogProblem: null,
    close: null,
    newRepair: null,
    dockOpen: false,
    ...over,
  }
}

function repairModel(role: RoleCase, over: Partial<RepairModel> = {}): RepairModel {
  return {
    prefix: PREFIX,
    can: canFor(role),
    me: ME,
    tab: 'intake',
    repair: REPAIR_RECEIVED,
    asOf: NOW,
    live: 'live',
    offline: false,
    today: TODAY,
    receipt: null,
    changedAt: null,
    edit: null,
    photos: [{ id: 'demo-photo-1', name: 'elbow.jpg', src: null }],
    uploading: false,
    checklist: BLANK_CHECKLIST,
    checkProblem: null,
    checkBusy: false,
    showCheckProblems: false,
    stepUp: STEP_UP_CLOSED,
    dialog: null,
    dialogBusy: false,
    dialogProblem: null,
    dockOpen: false,
    ...over,
  }
}

/** The record with its own drafts (tabs, cells, dialogs and the checklist work in review; nothing is sent). */
function RecordDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState<DesignModel>(model)
  useEffect(() => setState(model), [model])
  if (state.kind === 'rma') {
    const set = (patch: Partial<RmaModel>) => setState((current) => (current.kind === 'rma' ? { ...current, model: { ...current.model, ...patch } } : current))
    return inShell(
      '/sales/returns',
      createElement(RmaRecordView, {
        model: state.model,
        actions: {
          onDialog: (dialog) => set({ dialog }),
          onDecision: (lineId, patch) => set({ decisions: { ...state.model.decisions, [lineId]: { ...(state.model.decisions[lineId] ?? { disposition: '', outcome: '', credit: '' }), ...patch } } }),
          onCloseOpen: () => set({ close: { number: state.model.rma.number, reason: '', note: '', busy: false, problem: null, warnings: null } }),
          onCloseDraft: (patch) => set({ close: state.model.close ? { ...state.model.close, ...patch } : null }),
          onCloseDismiss: () => set({ close: null }),
          onMakeRepair: (lineId) => set({ newRepair: { draft: { ...BLANK_REPAIR, returnLineId: lineId }, fromLine: { returnNumber: state.model.rma.number, seq: 10, garment: 'JK-DEMO-100 · Red · 52' }, customers: { items: [], problem: null }, preview: null, previewing: false, showProblems: false, busy: false, problem: null, today: TODAY } }),
          onNewRepairDraft: (patch) => set({ newRepair: state.model.newRepair ? { ...state.model.newRepair, draft: { ...state.model.newRepair.draft, ...patch } } : null }),
          onNewRepairClose: () => set({ newRepair: null }),
          onDismissReceipt: () => set({ receipt: null }),
        },
      }),
      state.role,
    )
  }
  const set = (patch: Partial<RepairModel>) => setState((current) => (current.kind === 'repair' ? { ...current, model: { ...current.model, ...patch } } : current))
  return inShell(
    '/sales/returns',
    createElement(RepairRecordView, {
      model: state.model,
      actions: {
        onDialog: (dialog) => set({ dialog }),
        onChecklist: (patch) => set({ checklist: { ...state.model.checklist, ...patch } }),
        onSign: () => set({ showCheckProblems: true }),
        onEdit: () => set({ edit: { draft: { kind: state.model.repair.kind, problem: state.model.repair.problem, inboundDdtNumber: state.model.repair.inboundDdt?.number ?? '', inboundDdtDate: state.model.repair.inboundDdt?.date ?? '', internalNote: '' }, busy: false, problem: null } }),
        onEditDraft: (patch) => set({ edit: state.model.edit ? { ...state.model.edit, draft: { ...state.model.edit.draft, ...patch } } : null }),
        onEditCancel: () => set({ edit: null }),
        onStepUpCancel: () => set({ stepUp: STEP_UP_CLOSED }),
        onDismissReceipt: () => set({ receipt: null }),
      },
    }),
    state.role,
  )
}

const decided: Record<string, DecisionDraft> = { [RMA_RECEIVED.lines[1]!.id]: { disposition: 'CREDIT_ONLY', outcome: 'RESTOCK', credit: '' } }
const filledChecklist = { seams: 'PASS' as const, abrasionZones: 'PASS' as const, closures: 'NOT_APPLICABLE' as const, protectors: 'PASS' as const, replaced: true, lot: 'PRT-DEMO-07', level: '2' as const, certificateCovers: true, note: '' }

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-112',
  title: 'Return or repair record (RMA: lines, inspection, credit, shipments; repair: intake, work, safety check, return)',
  view: RecordDesign,
  cases: [
    { id: 'rma-lines', label: 'RMA authorised: Lines autosaved per cell, the MilestoneTracker', model: { kind: 'rma', role: 'owner', model: rmaModel('owner') }, note: 'Enter edits the pieces; the reason is a menu in the cell; ⋯ removes a line (never the last).' },
    { id: 'rma-saving', label: 'RMA Lines: a cell saving and a cell refused with the numbers', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { marks: { [`${RMA_AUTHORISED.lines[0]!.id}:quantity`]: { state: 'refused', words: { key: 'refusal.aboveSoldMax', params: { max: 1, sold: 2 } } }, [`${RMA_AUTHORISED.lines[1]!.id}:reasonCode`]: { state: 'saving' } } }) } },
    { id: 'rma-lines-read-only', label: 'RMA Lines read-only: the goods arrived (info banner says why)', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_RECEIVED }) } },
    { id: 'rma-receive', label: 'Receive goods (r): parcels, state, customer DDT, pieces per line', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { dialog: { kind: 'receive', draft: receiptDraftOf(RMA_AUTHORISED) } }) } },
    { id: 'rma-receive-held', label: 'Sales: Receive goods held with its reason (the warehouse receives)', model: { kind: 'rma', role: 'sales', model: rmaModel('sales') } },
    { id: 'rma-inspection', label: 'Inspection & decision: a safety line, a line to grade', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_RECEIVED, tab: 'inspection' }) } },
    {
      id: 'rma-deciding',
      label: 'Deciding: a disposition picked, its effect in words, Decide 1 line',
      model: {
        kind: 'rma',
        role: 'owner',
        model: rmaModel('owner', {
          rma: { ...RMA_RECEIVED, lines: [RMA_RECEIVED.lines[0]!, { ...RMA_RECEIVED.lines[1]!, grade: 'LIKE_NEW', cause: 'NO_FAULT', suggestedOutcome: 'RESTOCK' }] },
          tab: 'inspection',
          decisions: decided,
          decisionPreview: { ok: true, problems: [], lines: [{ lineId: RMA_RECEIVED.lines[1]!.id, seq: 20, disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditAmount: 32400, receivedValue: 32400, currency: 'EUR', place: { id: 'demo-place', code: 'A1-FG' }, followUp: 'CREDIT_NOTE', options: [{ disposition: 'CREDIT_ONLY', outcomes: [{ outcome: 'RESTOCK', held: null }, { outcome: 'SECOND_QUALITY', held: null }, { outcome: 'QUARANTINE', held: null }, { outcome: 'REPAIR', held: null }, { outcome: 'SCRAP', held: null }], defaultCredit: 32400 }], problems: [] }] },
        }),
      },
    },
    { id: 'rma-grade', label: 'Grade 1 line (office inspection)', model: { kind: 'rma', role: 'inspector', model: rmaModel('inspector', { rma: RMA_RECEIVED, tab: 'inspection', dialog: { kind: 'grade', lineIds: [RMA_RECEIVED.lines[1]!.id], grade: '', cause: '', note: '' } }) } },
    { id: 'rma-decided', label: 'Inspected: decided lines with their stock moves; Make replacement order', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_INSPECTED, tab: 'inspection' }) } },
    { id: 'rma-credit', label: 'Replacement & credit: the credit note draft and its SDI state, the repairs', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_INSPECTED, tab: 'credit' }) } },
    { id: 'rma-credit-no-grain', label: 'Replacement & credit for the warehouse: no amounts, credit notes held', model: { kind: 'rma', role: 'warehouse', model: rmaModel('warehouse', { rma: RMA_INSPECTED, tab: 'credit', credit: { value: null, problem: null } }) } },
    { id: 'rma-replacement', label: 'Make replacement order (at no charge)', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_INSPECTED, tab: 'credit', dialog: { kind: 'replacement', note: '' } }) } },
    { id: 'rma-shipments', label: 'Shipments: goods in with the customer’s DDT', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_INSPECTED, tab: 'shipments' }) } },
    { id: 'rma-shipments-empty', label: 'Shipments: nothing booked', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { tab: 'shipments' }) } },
    { id: 'rma-ddt', label: 'Issue return DDT (preview)', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_INSPECTED, tab: 'shipments', dialog: { kind: 'ddt', draft: { ...BLANK_DDT, carrier: 'Demo courier', weight: '1.4' }, preview: { draft: { lines: [{ seq: 1, description: 'Demo touring jacket, Red, size 52', quantity: '1', uom: 'PCS' }] }, problems: [], expectedNumber: '147/2026', reasons: ['RETURN'] }, previewing: false } }) } },
    { id: 'rma-close', label: 'Close return: finish reason', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_INSPECTED, close: { number: RMA_INSPECTED.number, reason: '', note: '', busy: false, problem: null, warnings: null } }) } },
    { id: 'rma-make-repair', label: 'Make repair order from a line decided Repair', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { rma: RMA_INSPECTED, tab: 'inspection', newRepair: { draft: { ...BLANK_REPAIR, returnLineId: RMA_INSPECTED.lines[0]!.id }, fromLine: { returnNumber: RMA_INSPECTED.number, seq: 10, garment: 'JK-DEMO-100 · Red · 52' }, customers: { items: [], problem: null }, preview: null, previewing: false, showProblems: false, busy: false, problem: null, today: TODAY } }) } },
    { id: 'rma-changed', label: 'Changed by someone else · Reload; a receipt', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { changedAt: NOW, receipt: { tone: 'success', words: { key: 'done.created', params: { number: 'RMA-DEMO-0001' } } } }) } },
    { id: 'rma-offline', label: 'RMA offline: writes held', model: { kind: 'rma', role: 'owner', model: rmaModel('owner', { offline: true, live: 'offline' }) } },
    { id: 'rma-read-only', label: 'RMA for a read-only person: every step held with the permission', model: { kind: 'rma', role: 'readOnly', model: rmaModel('readOnly', { rma: RMA_RECEIVED, tab: 'inspection' }) } },
    { id: 'repair-intake', label: 'Repair received: Intake & photos, the serial’s other repair', model: { kind: 'repair', role: 'owner', model: repairModel('owner') } },
    { id: 'repair-intake-edit', label: 'Intake edited with the edit bar (⌘S)', model: { kind: 'repair', role: 'owner', model: repairModel('owner', { edit: { draft: { kind: 'REPAIR', problem: REPAIR_RECEIVED.problem, inboundDdtNumber: 'C-DDT-DEMO-12', inboundDdtDate: '2026-10-28', internalNote: '' }, busy: false, problem: null } }) } },
    { id: 'repair-work', label: 'Work: the stepper, the moves held with their reason', model: { kind: 'repair', role: 'owner', model: repairModel('owner', { tab: 'work' }) } },
    { id: 'repair-estimate', label: 'Estimated…: the note it needs', model: { kind: 'repair', role: 'owner', model: repairModel('owner', { tab: 'work', dialog: { kind: 'move', action: 'estimate', note: '' } }) } },
    {
      id: 'repair-work-order',
      label: 'Make repair work order: the routing steps',
      model: { kind: 'repair', role: 'owner', model: repairModel('owner', { tab: 'work', dialog: { kind: 'workOrder', seqs: [20], problem: null, options: { workOrder: null, garment: { orderNumber: 'SO-DEMO-003', lineSeq: 10, size: '52', problems: [] }, revision: { id: 'demo-rev', revision: 2, status: 'RELEASED' }, steps: [{ seq: 10, code: 'CUT', name: 'Cutting', standardMinutes: '4', available: true }, { seq: 20, code: 'SEW', name: 'Sewing', standardMinutes: '12', available: true }, { seq: 30, code: 'PRS', name: 'Pressing', standardMinutes: '2', available: false }], blockers: [] } } }) },
    },
    { id: 'repair-repaired', label: 'Repaired: the work history; Send back held until the check', model: { kind: 'repair', role: 'owner', model: repairModel('owner', { repair: REPAIR_REPAIRED, tab: 'work' }) } },
    { id: 'repair-safety', label: 'Safety check: the GateChecklist, blank', model: { kind: 'repair', role: 'inspector', model: repairModel('inspector', { repair: REPAIR_REPAIRED, tab: 'safety' }) } },
    { id: 'repair-safety-filled', label: 'Safety check filled: protector replaced (lot, level); will pass', model: { kind: 'repair', role: 'inspector', model: repairModel('inspector', { repair: REPAIR_REPAIRED, tab: 'safety', checklist: filledChecklist }) } },
    { id: 'repair-safety-problems', label: 'Sign pressed with points missing', model: { kind: 'repair', role: 'inspector', model: repairModel('inspector', { repair: REPAIR_REPAIRED, tab: 'safety', showCheckProblems: true }) } },
    { id: 'repair-step-up', label: 'Sign off: the fresh code (step-up)', model: { kind: 'repair', role: 'inspector', model: repairModel('inspector', { repair: REPAIR_REPAIRED, tab: 'safety', checklist: filledChecklist, checkBusy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.sign', problem: null } }) } },
    { id: 'repair-safety-held', label: 'Safety check for sales: held (only the inspector signs)', model: { kind: 'repair', role: 'sales', model: repairModel('sales', { repair: REPAIR_REPAIRED, tab: 'safety' }) } },
    { id: 'repair-safety-passed', label: 'Safety check passed, signed', model: { kind: 'repair', role: 'owner', model: repairModel('owner', { repair: REPAIR_PASSED, tab: 'safety', checklist: filledChecklist }) } },
    { id: 'repair-send', label: 'Send back: the DDT (reason repair) with its preview', model: { kind: 'repair', role: 'warehouse', model: repairModel('warehouse', { repair: REPAIR_PASSED, tab: 'return', dialog: { kind: 'ship', draft: { ...BLANK_DDT, carrier: 'Demo courier', weight: '1.4' }, note: '', preview: { draft: { lines: [{ seq: 1, description: 'Demo touring jacket, Red, size 52 (repaired)', quantity: '1', uom: 'PCS' }] }, problems: [], expectedNumber: '146/2026', reasons: ['REPAIR'] }, previewing: false, useLive: false } }) } },
    { id: 'repair-shipped', label: 'Shipped back: the DDT and date; nothing changes any more', model: { kind: 'repair', role: 'owner', model: repairModel('owner', { repair: REPAIR_SHIPPED, tab: 'return' }) } },
    { id: 'repair-offline', label: 'Repair offline: writes held', model: { kind: 'repair', role: 'owner', model: repairModel('owner', { offline: true, live: 'offline' }) } },
  ],
})
