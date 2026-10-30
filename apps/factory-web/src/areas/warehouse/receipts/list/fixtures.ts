import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canOf, inShell, PREFIX, TIME_ZONE, uid, type Role } from '../../../_shared/buying/fixtures'
import { COUNTS, EXPECTED, receipt, ROWS } from '../demo/fixtures'
import type { ReceiptRecordModel, ReceiptsListModel } from '../model'
import { ReceiptDesign, receiptCase } from '../record/fixtures'
import { ReceiptsListView } from './view/ReceiptsListView'

/**
 * SCR-063 — Receipts (design warehouse.receipts) with made-up data only: the tiles, the expected order lines (Receive,
 * a selection of one order's lines), the receipts (posted, posted today, with a lot in quarantine, reversed), a search,
 * Export, and the receipt record: its lines against the order (short, exact, within the tolerance), the notes after
 * posting, Reverse (what it does; held with what used the stock, in words), reversed, and the states. Roles:
 * Warehouse, Buyer (values, no receiving), Planner, Read-only, Sales (none).
 */

type Case = { kind: 'list'; role: Role; list: ReceiptsListModel } | { kind: 'record'; role: Role; record: ReceiptRecordModel }

function listCase(role: Role, over: Partial<ReceiptsListModel> = {}): Case {
  const can = canOf(role)
  const rows = can.cost ? ROWS : ROWS.map(({ value: _value, ...row }) => row)
  return {
    kind: 'list',
    role,
    list: { prefix: PREFIX, can, view: can.receive ? 'expected' : 'all', q: '', rows: { items: rows, more: false, problem: null }, expected: { items: can.receive ? EXPECTED : null, problem: null }, counts: COUNTS, asOf: '2026-10-29T10:00:00.000Z', live: 'live', updates: 0, notice: null, timeZone: TIME_ZONE, ...over },
  }
}

const recordCase = (role: Role, ...args: Parameters<typeof receiptCase> extends [Role, ...infer R] ? R : never): Case => ({ kind: 'record', ...receiptCase(role, ...args) })

function ReceiptsDesign({ model }: { model: Case }) {
  if (model.kind === 'record') return createElement(ReceiptDesign, { model: { role: model.role, record: model.record } })
  return inShell('/warehouse/receipts', createElement(ReceiptsListView, { model: model.list }), model.role)
}

const issued = receipt({ reversal: { possible: false, location: 'N-RCV', blockers: [{ code: 'ISSUED', where: 'WO-00041', items: [{ kind: 'HIDE', code: 'HD-DEMO-001041-1' }, { kind: 'HIDE', code: 'HD-DEMO-001042-2' }] }, { code: 'MOVED', where: 'N-STORE', items: [{ kind: 'HIDE', code: 'HD-DEMO-001047-7' }] }] } })

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-063',
  title: 'Receipts (the list, expected order lines, a receipt, reverse)',
  view: ReceiptsDesign,
  cases: [
    { id: 'expected', label: 'Expected order lines: open quantity, tolerance, ≈ hides, Cr VI, Receive (warehouse)', model: listCase('warehouse'), note: 'Receive opens the receiving page with that order (SCR-061).' },
    { id: 'expected-selection', label: 'Two lines of one order selected: Receive 2 lines', model: listCase('warehouse', { selected: [EXPECTED[0]!.purchaseOrderLineId, EXPECTED[1]!.purchaseOrderLineId] }) },
    { id: 'expected-two-orders', label: 'Lines of two orders selected: held (one receipt is against one order)', model: listCase('warehouse', { selected: [EXPECTED[0]!.purchaseOrderLineId, EXPECTED[2]!.purchaseOrderLineId] }) },
    { id: 'posted', label: 'Rows ▾ Posted: lots released of all, hides and quantities, a missing DDT', model: listCase('warehouse', { view: 'posted', rows: { items: ROWS.filter((row) => row.status === 'POSTED').map(({ value: _v, ...row }) => row), more: false, problem: null } }) },
    { id: 'today', label: 'Tile: posted today', model: listCase('warehouse', { view: 'today', rows: { items: ROWS.slice(0, 1).map(({ value: _v, ...row }) => row), more: false, problem: null } }) },
    { id: 'waiting', label: 'Tile: with a lot in quarantine', model: listCase('warehouse', { view: 'waiting', rows: { items: ROWS.slice(0, 1).map(({ value: _v, ...row }) => row), more: false, problem: null } }) },
    { id: 'all-buyer', label: 'All receipts with their values (buyer: cost grain, no receiving)', model: listCase('buyer') },
    { id: 'selection', label: 'Receipts selected: Export N (CSV)', model: listCase('buyer', { selected: ROWS.slice(0, 2).map((row) => row.id) }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: listCase('buyer', { q: 'zzz', rows: { items: [], more: false, problem: null } }) },
    { id: 'empty', label: 'First day: no receipt yet', model: listCase('warehouse', { view: 'all', rows: { items: [], more: false, problem: null }, counts: { posted: 0, reversed: 0, waiting: 0, postedSince: 0 } }) },
    { id: 'nothing-expected', label: 'Nothing is expected', model: listCase('warehouse', { expected: { items: [], problem: null } }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { view: 'all', rows: { items: null, more: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The receipts couldn't be read", model: listCase('warehouse', { view: 'all', rows: { items: null, more: false, problem: 'problem.offline' }, counts: null, asOf: null, live: 'offline' }) },
    { id: 'planner', label: 'Planner: reads the receipts, no values', model: listCase('planner') },
    { id: 'read-only', label: 'Read-only', model: listCase('readOnly') },
    { id: 'sales', label: 'Sales: no inventory.stock.view — the page says so', model: listCase('sales') },
    { id: 'record', label: 'A receipt: its lines against the order (short with the tolerance, exact), the summary', model: recordCase('warehouse') },
    { id: 'record-buyer', label: 'A receipt with its values (buyer)', model: recordCase('buyer') },
    { id: 'record-notes', label: 'Just posted: what differs from the order', model: recordCase('warehouse', receipt(), { notes: [{ code: 'SHORT', seq: 10 }, { code: 'QUARANTINE', seq: 10 }, { code: 'ONE_DYE_BATCH', seq: 10 }] }) },
    { id: 'reverse', label: 'Reverse: what it does (moves, lots rejected, the order), the reason', model: recordCase('warehouse', receipt(), { dialog: { kind: 'reverse', reason: 'Booked against the wrong order' } }) },
    { id: 'reverse-held', label: 'Reverse held: hides issued to a work order and moved, in words', model: recordCase('warehouse', issued, { dialog: { kind: 'reverse', reason: '' } }) },
    { id: 'reverse-refused', label: 'Reverse refused meanwhile (read again)', model: recordCase('warehouse', receipt(), { dialog: { kind: 'reverse', reason: 'Wrong supplier' }, dialogProblem: { key: 'rc.reverse.changed' } }) },
    { id: 'reversed', label: 'Reversed, with its reason', model: recordCase('warehouse', receipt({ status: 'REVERSED', reversedAt: '2026-10-29T10:05:00.000Z', reversalReason: 'Booked against the wrong order', reversal: null }), { notice: { tone: 'success', words: { key: 'rc.notice.reversed', params: { number: 'GR-2026-0022' } } } }) },
    { id: 'record-activity', label: 'Activity: the thread, files and history', model: recordCase('warehouse', receipt(), { tab: 'activity' }) },
    { id: 'record-dock', label: 'The thread beside a tab (⌘J)', model: recordCase('warehouse', receipt(), { dockOpen: true }) },
    { id: 'record-read-only', label: 'Read-only: Reverse held with its reason', model: recordCase('readOnly') },
    { id: 'record-loading', label: 'A receipt loading', model: recordCase('warehouse', receipt(), { receipt: { status: 'loading' } }) },
    { id: 'record-not-found', label: 'Not found (or another company)', model: recordCase('warehouse', receipt(), { receipt: { status: 'not_found' } }) },
    { id: 'record-no-permission', label: 'Sales: no inventory.stock.view', model: recordCase('sales', receipt({ id: uid('6301', 99) }), { receipt: { status: 'forbidden' } }) },
  ],
})
