import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { base, BLOCK_LONG, BLOCK_NORMAL, BLOCK_NORMAL_2, BLOCK_RECORD, BLOCKS, blockOff, keyOf, LabourDesign, ready, type LabourCase } from '../fixtures'

/**
 * SCR-143 — Off-standard time: one inbox with SCR-139 (design production.labour, sec:lb-queue, MES-157). The same page with the
 * tile "Off-standard blocks to approve" pressed: blocks approved one by one (A), rejected with a reason (R), or the normal
 * ones together; large or unusual blocks are excluded and say why. Made-up data only.
 */

const onlyBlocks = { rows: { items: BLOCKS, more: false, limitReached: false, problem: null } }
const kind = { kind: 'OFF_STANDARD' as const }
const open = (entry: typeof BLOCK_NORMAL) => ({ ...kind, open: keyOf(entry) })
const LONG_RECORD = { kind: 'OFF_STANDARD' as const, block: { ...BLOCK_RECORD, id: BLOCK_LONG.id, unusual: ['LONG', 'TYPED_AFTERWARDS'], minutes: 95, source: 'LEAD', note: 'Inserito dal capo: corso sicurezza.' }, item: BLOCK_LONG }
const NORMAL_RECORD = { kind: 'OFF_STANDARD' as const, block: BLOCK_RECORD, item: BLOCK_NORMAL }
const GATE_OFF = { ...NORMAL_RECORD, block: { ...BLOCK_RECORD, worker: null, workerHidden: true, canDecide: false } }

export const designScreen = defineDesignScreen<LabourCase>({
  screen: 'SCR-143',
  title: 'Off-standard time (one inbox with SCR-139)',
  view: LabourDesign,
  cases: [
    { id: 'blocks', label: 'The blocks to approve: oldest first; the band’s “Approve 2 normal blocks”', model: base('production', onlyBlocks, kind) },
    { id: 'selected', label: 'Selected: Approve 1 normal block; the long block cannot be ticked and says why', model: base('production', { ...onlyBlocks, selected: [keyOf(BLOCK_NORMAL_2)] }, kind) },
    { id: 'normal', label: 'A normal block: A approve, R reject, the worker named (gate on)', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, NORMAL_RECORD) }, open(BLOCK_NORMAL)) },
    { id: 'hidden', label: 'The same with the gate off: someone is on it, never who', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, blockOff) }, open(BLOCK_NORMAL)) },
    { id: 'decided-named', label: 'Approved: who decided, an office user or the gate on', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, { ...NORMAL_RECORD, block: { ...BLOCK_RECORD, status: 'APPROVED', canDecide: false, approvedAt: '2026-11-17T10:00:00.000Z', approvedBy: { id: 'made-up-lead', name: 'Bea Esempio' } } }) }, open(BLOCK_NORMAL)) },
    { id: 'decided-hidden', label: 'Approved on the tablet with the gate off: "A person", never who, never nothing', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, { ...GATE_OFF, block: { ...GATE_OFF.block, status: 'APPROVED', approvedAt: '2026-11-17T10:00:00.000Z', approvedBy: null, approvedByHidden: true } }) }, open(BLOCK_NORMAL)) },
    { id: 'rejected-hidden', label: 'Rejected on the tablet with the gate off', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, { ...GATE_OFF, block: { ...GATE_OFF.block, status: 'REJECTED', rejectedAt: '2026-11-17T10:00:00.000Z', rejectedBy: null, rejectedByHidden: true, rejectReason: 'Motivo di prova.' } }) }, open(BLOCK_NORMAL)) },
    { id: 'unusual', label: 'An unusual block: why it is decided on its own', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_LONG, LONG_RECORD) }, open(BLOCK_LONG)) },
    { id: 'own', label: 'One’s own time: held, another person decides', model: base('supervisor', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, { ...NORMAL_RECORD, block: { ...BLOCK_RECORD, own: true, canDecide: false } }) }, open(BLOCK_NORMAL)) },
    { id: 'no-record', label: 'A role that may not read the block: the item only, said so', model: base('hr', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, { kind: 'OFF_STANDARD', block: null, item: BLOCK_NORMAL }) }, open(BLOCK_NORMAL)) },
    { id: 'reject', label: 'Reject: the reason is required, and reaches the person', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, NORMAL_RECORD), dialog: { kind: 'reject', target: { kind: 'OFF_STANDARD', id: BLOCK_NORMAL.id, version: 1, open: keyOf(BLOCK_NORMAL) }, reason: '', problem: null } }, open(BLOCK_NORMAL)) },
    { id: 'reject-closed-day', label: 'Refused: the day is closed (in words)', model: base('production', { ...onlyBlocks, detail: ready(BLOCK_NORMAL, NORMAL_RECORD), dialog: { kind: 'reject', target: { kind: 'OFF_STANDARD', id: BLOCK_NORMAL.id, version: 1, open: keyOf(BLOCK_NORMAL) }, reason: 'Attesa non confermata.', problem: { key: 'refusal.DAY_CLOSED' } } }, open(BLOCK_NORMAL)) },
    { id: 'approved', label: '“Approve 2 normal blocks” done: what was left out, and why', model: base('production', { ...onlyBlocks, notice: { tone: 'success', words: { key: 'notice.approvedN', params: { count: 2 } }, detail: [{ key: 'notice.skipped', params: { code: 'TRAINING', why: 'Più di un\'ora, Inserito dopo' } }, { key: 'notice.leftOut', params: { count: 1 } }] } }, kind) },
    { id: 'none-normal', label: 'Only unusual blocks wait: Approve held, with why', model: base('production', { rows: { items: [BLOCK_LONG], more: false, limitReached: false, problem: null }, blocks: { pending: 1, normal: 0, unusual: 1, running: 0 } }, kind) },
    { id: 'empty', label: 'No block to approve', model: base('production', { rows: { items: [], more: false, limitReached: false, problem: null }, blocks: { pending: 0, normal: 0, unusual: 0, running: 0 } }, kind) },
    { id: 'read-only', label: 'Read-only: looks, decides nothing', model: base('readOnly', onlyBlocks, kind) },
    { id: 'loading', label: 'Loading', model: base('production', { rows: { items: null, more: false, limitReached: false, problem: null } }, kind) },
    { id: 'error', label: 'The read failed: in words, Try again', model: base('production', { rows: { items: null, more: false, limitReached: false, problem: 'problem.offline' } }, kind) },
    { id: 'no-permission', label: 'Sales: no permission (production.labour.view)', model: base('sales') },
  ],
})
