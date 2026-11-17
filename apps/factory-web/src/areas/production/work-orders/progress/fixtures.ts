import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { WorkOrderWip } from '../../_shared/api'
import { wipOf, wipWithUnplanned } from '../../_shared/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../record/fixtures'
import type { ExtraRecord } from '../extra/api'
import type { ExtraDialogModel, ExtraModel } from '../extra/use-extra'

/**
 * SCR-072 — the work order's Operations & WIP tab (design wo-flow, wo-corrections; MES-079, MES-167; F-PR-06: ONE operation table,
 * the By operation / By size switch went — each operation opens to its sizes; the operation flow's piles are a column of it) with
 * made-up data only: WIP per operation, the bundles done / waiting / not reached, the biggest pile marked, an operation at a
 * workshop, output per line, the corrections waiting (a door to Labour), unplanned operations and their Add pop-up, and the
 * states. Roles: Production manager, Team leader (read). Bundles moved to SCR-071 (Cutting & bundles).
 */

const B = (n: number) => `0190f0e2-7171-7000-8000-${String(n).padStart(12, '0')}`
const ops = (role: Parameters<typeof recordCase>[0], over: Parameters<typeof recordCase>[2] = {}): RecordCase => recordCase(role, 'IN_PROGRESS', { tab: 'operations', ...over })

// F-PR-06: Impuntura (30) given to an outside workshop: a subcontract work centre, counted by the scans of what came back.
const withWorkshop = (): WorkOrderWip => {
  const wip = wipOf()
  return { ...wip, operations: wip.operations.map((op) => (op.seq === 30 ? { ...op, workCentreKind: 'SUBCONTRACT', name: 'Impuntura (laboratorio esterno)' } : op)) }
}

// ---- B-W2b-82: unplanned operations ----------------------------------------------------------------------------------------

const ADDED: ExtraRecord[] = [
  { id: B(90), workOrderOperationId: B(90), seq: 60, at: '2026-10-29T09:12:00.000Z', operation: { id: B(91), code: 'REINF', name: 'Rinforzo colletto', workCentreKind: 'SEWING', standardMinutes: '1.500' }, reasonCode: 'QUALITY_FIX', reason: 'To fix a defect', addedOn: 'FLOOR' },
  { id: B(92), workOrderOperationId: B(92), seq: 70, at: '2026-10-29T10:40:00.000Z', operation: { id: B(93), code: 'PRESS', name: 'Stiratura extra', workCentreKind: 'FINISHING', standardMinutes: '0.800' }, reasonCode: 'OTHER', reason: 'Other (say why): Pieghe dalla pressa', addedOn: 'OFFICE' },
]
const extraList = (over: Partial<ExtraModel> = {}): ExtraModel => ({ canAdd: true, added: { value: ADDED, problem: null }, dialog: null, ...over })
const CHOICES: NonNullable<ExtraDialogModel['choices']> = {
  operations: [
    { id: B(94), code: 'BARTACK', name: 'Travette aggiuntive', workCentreKind: 'SEWING', standardMinutes: '0.600', pays: 'PIECE_RATE' },
    { id: B(95), code: 'STEAM', name: 'Vaporizzatura', workCentreKind: 'FINISHING', standardMinutes: '0.400', pays: 'OFF_STANDARD' },
  ],
  reasons: [
    { code: 'QUALITY_FIX', label: { it: 'Per correggere un difetto', en: 'To fix a defect' }, needsNote: false },
    { code: 'CUSTOMER_CHANGE', label: { it: 'Richiesta del cliente', en: 'The customer asked' }, needsNote: false },
    { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true },
  ],
}
const extraDialog = (over: Partial<ExtraDialogModel> = {}): ExtraModel => extraList({ dialog: { choices: CHOICES, draft: { operationId: null, reasonCode: null, note: '', planned: '' }, busy: false, problem: null, ...over } })

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-072',
  title: 'Work order › Operations & WIP (one operation table)',
  view: RecordDesign,
  cases: [
    { id: 'operations', label: 'Operations: WIP per operation, bundles done / waiting / not yet, per line, corrections waiting', model: ops('manager') },
    { id: 'operations-sizes', label: 'F-PR-06 · ONE operation table: each operation opens to its sizes (good, waiting, scrap, rework per colourway × size); the switch went', model: ops('manager'), note: 'Open “Per size” under 20 ASM-CORPO. Not-scanned operations say they count nothing per size.' },
    { id: 'operations-ready', label: 'Every garment finished: complete the work order', model: ops('manager', { wip: { value: wipOf(true), problem: null } }) },
    { id: 'operations-draft', label: 'A draft: the operations the release would freeze', model: recordCase('manager', 'DRAFT', { tab: 'operations' }) },
    { id: 'operations-error', label: 'The WIP failed: in words, with Try again', model: ops('manager', { wip: { value: null, problem: 'error.offline' } }) },
    // ---- B-W2b-82: unplanned operations ----
    { id: 'unplanned', label: 'Unplanned operations: on the WIP with their tag, and why each was added', model: ops('manager', { wip: { value: wipWithUnplanned(), problem: null }, extra: extraList() }), note: 'Nothing waits for an unplanned operation: only what was reported there arrived there. Add: production.extraops.add, on a released or in-progress work order.' },
    { id: 'unplanned-none', label: 'Unplanned operations: none yet', model: ops('manager', { extra: extraList({ added: { value: [], problem: null } }) }) },
    { id: 'unplanned-loading', label: 'Unplanned operations: loading', model: ops('manager', { extra: extraList({ added: { value: null, problem: null } }) }) },
    { id: 'unplanned-error', label: 'Unplanned operations: the list failed, with Try again', model: ops('manager', { extra: extraList({ added: { value: null, problem: 'unavailable' } }) }) },
    { id: 'unplanned-read-only', label: 'Team leader in the office: reads them (no Add: production.extraops.add)', model: ops('teamLeader', { wip: { value: wipWithUnplanned(), problem: null }, extra: extraList({ canAdd: false }) }) },
    { id: 'unplanned-dialog', label: 'Add an unplanned operation: Add held until both are chosen', model: ops('manager', { extra: extraDialog() }) },
    { id: 'unplanned-dialog-ready', label: 'Add: ready', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'QUALITY_FIX', note: '', planned: '12' } }) }) }, // B-W2b-GB29 (G215): + the planned garments
    { id: 'unplanned-dialog-words', label: 'Add: Other asks a few words', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'OTHER', note: '', planned: '' } }) }) },
    { id: 'unplanned-dialog-no-rate', label: 'Add: no piece rate, said before Add', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(95), reasonCode: 'QUALITY_FIX', note: '', planned: '' } }) }), note: 'A word, never a figure. Piece pay off at the site: nothing to say.' },
    { id: 'unplanned-dialog-loading', label: 'Add: reading the operations', model: ops('manager', { extra: extraDialog({ choices: null }) }) },
    { id: 'unplanned-dialog-empty', label: 'Add: nothing left to add', model: ops('manager', { extra: extraDialog({ choices: { ...CHOICES, operations: [] } }) }) },
    { id: 'unplanned-dialog-refused', label: 'Add refused: inside the pop-up, in words', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'QUALITY_FIX', note: '', planned: '' }, problem: { key: 'extra.refused', params: { words: 'BARTACK was added to this work order already: scan the bundles at it.' } } }) }) },
    { id: 'unplanned-dialog-failed', label: 'Add failed: Try again, what was chosen stays', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'QUALITY_FIX', note: '', planned: '' }, problem: { key: 'extra.failed' } }) }) },
    { id: 'w2a-flow', label: 'W2a · Operations: the pile waiting before each operation, the biggest marked — in the one table (the flow strip went, F-PR-06)', model: ops('manager') },
    // ---- F-PR-06: an operation at a workshop ----
    { id: 'operations-workshop', label: 'F-PR-06 · An operation at a workshop: marked, counted by the scans of what came back', model: ops('manager', { wip: { value: withWorkshop(), problem: null } }), note: 'The workshop’s own reported progress is not read on this page yet.' },
  ],
})
