import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BUNDLE_SCANS, bundlesOf, NO_PRINTERS, wipOf } from '../../_shared/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../record/fixtures'
import { dailyFor, FINISHED, HOLD, heldWorkOrder, NOTHING_TO_FINISH } from '../daily/demo/fixtures'

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
