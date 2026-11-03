import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BUNDLE_SCANS, bundlesOf, NO_PRINTERS, wipOf, wipWithUnplanned } from '../../_shared/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../record/fixtures'
import { dailyFor, FINISHED, HOLD, heldWorkOrder, NOTHING_TO_FINISH } from '../daily/demo/fixtures'
import type { ExtraRecord } from '../extra/api'
import type { ExtraDialogModel, ExtraModel } from '../extra/use-extra'

/**
 * SCR-072 — the work order's Bundles and Operations tabs (design wo-bundles, wo-flow, wo-corrections; MES-065, MES-068,
 * MES-079, MES-167) with made-up data only: cut / bundled / to bundle per cell, every bundle with where it waits, its
 * last scan and its ticket (a void one cannot be ticked), Reprint N tickets (the reason, the label printer, the results),
 * a bundle's scans per operation, the bundles waiting at one operation (from Floor now), the operation bulletin with WIP
 * per operation or per size, output per line, the corrections waiting, and the states. Roles: Production manager
 * (reprints), Team leader and Sales (read).
 */

const B = (n: number) => `0190f0e2-7171-7000-8000-${String(n).padStart(12, '0')}`
const bundles = (role: Parameters<typeof recordCase>[0], over: Parameters<typeof recordCase>[2] = {}): RecordCase => recordCase(role, 'IN_PROGRESS', { tab: 'bundles', ...over })
const ops = (role: Parameters<typeof recordCase>[0], over: Parameters<typeof recordCase>[2] = {}): RecordCase => recordCase(role, 'IN_PROGRESS', { tab: 'operations', ...over })

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
const extraDialog = (over: Partial<ExtraDialogModel> = {}): ExtraModel => extraList({ dialog: { choices: CHOICES, draft: { operationId: null, reasonCode: null, note: '' }, busy: false, problem: null, ...over } })

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-072',
  title: 'Work order › Bundles & Operations (WIP)',
  view: RecordDesign,
  cases: [
    { id: 'bundles', label: 'Production manager: the bundles, where each waits, last scan, ticket', model: bundles('manager'), note: 'Tick bundles: Reprint N tickets. The void bundle’s box is off and says why.' },
    { id: 'reprint', label: 'Reprint 2 tickets: the reason, the label printer', model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3), B(5)] } }) },
    { id: 'reprint-other', label: 'Reprint with another reason, typed', model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3)] }, draft: { reason: 'Ticket wet at the washing station' } }) },
    {
      id: 'reprint-results',
      label: 'Reprint: one new code, one refused in words',
      model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3), B(5)] }, reprint: { running: false, done: true, results: { [B(3)]: { state: 'done', code: 'BN-DEMO-2003-R' }, [B(5)]: { state: 'failed', words: { key: 'refusal.bundle.WORK_ORDER_NOT_OPEN' } } } } }),
    },
    { id: 'reprint-no-printer', label: 'Reprint at a site with no label printer: held with the reason', model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3)] }, printers: { value: NO_PRINTERS, problem: null } }) },
    { id: 'bundle', label: 'A bundle: scans per operation (undo and its report), hides and lot, earlier tickets', model: bundles('manager', { bundleOpen: { bundleId: B(3), scans: { value: BUNDLE_SCANS, problem: null } } }) },
    { id: 'bundle-reprinted', label: 'A reprinted bundle: the reprint with its reason', model: bundles('manager', { bundleOpen: { bundleId: B(2), scans: { value: [], problem: null } } }) },
    { id: 'waiting-at', label: 'The bundles waiting at 20 ASM-CORPO (from Floor now)', model: bundles('manager', { waitingAt: 20 }) },
    { id: 'empty', label: 'No bundles yet', model: bundles('manager', { bundles: { value: bundlesOf('empty'), problem: null } }) },
    { id: 'loading', label: 'Loading the bundles', model: bundles('manager', { bundles: { value: null, problem: null } }) },
    { id: 'error', label: 'The bundles failed: in words, with Try again', model: bundles('manager', { bundles: { value: null, problem: 'error.read' } }) },
    { id: 'team-leader', label: 'Team leader: reads the bundles (no reprint: production.bundles)', model: bundles('teamLeader') },
    { id: 'sales', label: 'Sales (read-only)', model: bundles('sales') },
    { id: 'operations', label: 'Operations: WIP per operation, bundles done / waiting / not yet, per line, corrections waiting', model: ops('manager') },
    { id: 'operations-sizes', label: 'Operations: good per size at each scanned operation', model: ops('manager', { draft: { opsBySize: true } }) },
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
    { id: 'unplanned-dialog-ready', label: 'Add: ready', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'QUALITY_FIX', note: '' } }) }) },
    { id: 'unplanned-dialog-words', label: 'Add: Other asks a few words', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'OTHER', note: '' } }) }) },
    { id: 'unplanned-dialog-no-rate', label: 'Add: no piece rate, said before Add', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(95), reasonCode: 'QUALITY_FIX', note: '' } }) }), note: 'A word, never a figure. Piece pay off at the site: nothing to say.' },
    { id: 'unplanned-dialog-loading', label: 'Add: reading the operations', model: ops('manager', { extra: extraDialog({ choices: null }) }) },
    { id: 'unplanned-dialog-empty', label: 'Add: nothing left to add', model: ops('manager', { extra: extraDialog({ choices: { ...CHOICES, operations: [] } }) }) },
    { id: 'unplanned-dialog-refused', label: 'Add refused: inside the pop-up, in words', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'QUALITY_FIX', note: '' }, problem: { key: 'extra.refused', params: { words: 'BARTACK was added to this work order already: scan the bundles at it.' } } }) }) },
    { id: 'unplanned-dialog-failed', label: 'Add failed: Try again, what was chosen stays', model: ops('manager', { extra: extraDialog({ draft: { operationId: B(94), reasonCode: 'QUALITY_FIX', note: '' }, problem: { key: 'extra.failed' } }) }) },
    // ---- B-W2a-46: report finished to stock, split a bundle, bundles on hold, the operation flow ----
    { id: 'w2a-finished', label: 'W2a · Bundles: finished to stock — released, in stock, can go now; Report N finished', model: bundles('manager') },
    { id: 'w2a-finish-dialog', label: 'W2a · Report finished to stock: per size what can go now, the finished-goods place', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'finish' } }) }) },
    { id: 'w2a-finish-over', label: 'W2a · Report finished: a size asks for more than can go (held, in words)', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'finish' }, draft: { asked: { [FINISHED.cells[0]!.cellId]: 99 } } }) }) },
    { id: 'w2a-finish-refused', label: 'W2a · Report finished refused (changed meanwhile): inside the dialog', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'finish' }, problem: { key: 'problem.conflict' } }) }) },
    { id: 'w2a-finish-nothing', label: 'W2a · Nothing released by quality yet: Report held with its reason', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { finished: { value: NOTHING_TO_FINISH, problem: null } }) }) },
    { id: 'w2a-finish-held-on-hold', label: 'W2a · A work order on hold: Report and Split held with the reason', model: bundles('manager', { workOrder: { status: 'ready', value: heldWorkOrder() }, daily: dailyFor('manager', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null } }) }) },
    { id: 'w2a-finish-no-right', label: 'W2a · Team leader: Report held (production.finish)', model: bundles('teamLeader') },
    { id: 'w2a-split', label: 'W2a · Split bundle (from the bundle’s ⋯): garments into a child bundle with its own ticket', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'split', bundleId: B(3) }, draft: { quantity: 2, splitReason: 'REWORK', note: 'Cucitura da rifare' } }) }) },
    { id: 'w2a-split-held', label: 'W2a · Split held until a reason is chosen and the garments are 1 … n − 1', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'split', bundleId: B(3) }, draft: { quantity: 99 } }) }) },
    { id: 'w2a-bundle-on-hold', label: 'W2a · A bundle under a hold of its own: the On hold column', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { bundleHolds: [{ ...HOLD, id: B(90), subjectType: 'Bundle', subjects: [{ id: B(3), label: null, state: null }] }] }) }) },
    { id: 'w2a-flow', label: 'W2a · Operations: the operation flow — the pile waiting before each operation, the biggest marked', model: ops('manager') },
  ],
})
