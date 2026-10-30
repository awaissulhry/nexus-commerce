import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { amendmentsFor, AMENDMENTS, inShell, NO_AMENDMENTS, order, STYLE, STYLE_ID, type Role } from '../../_demo/fixtures'
import { amended, base } from '../fixtures'
import type { OrderRecordModel } from '../record-model'
import { OrderRecordView } from '../view/OrderRecordView'

/**
 * SCR-107 — Order changes (design sales.orders "Record: Sales order › Changes", SAL-217; B-W2a-50 on B-W2a-30's
 * amendments) with made-up data only: the amendments since confirmation (revision, who and when, the reason, how the
 * lines moved, the money change by grain, the customer's re-acceptance), the before → after dialog, the empty, loading
 * and failed reads, and the roles: Sales (prices), the Owner, the Production manager (no money: sizes only).
 */

interface ChangesCase {
  role: Role
  record: OrderRecordModel
}

const production = amended(order('IN_PRODUCTION'))
const view = (role: Role, over: Partial<OrderRecordModel> = {}): ChangesCase => base(role, production, { tab: 'changes', amendments: { value: amendmentsFor(role), problem: null }, changeStyles: { [STYLE_ID]: STYLE }, ...over })

function ChangesDesign({ model }: { model: ChangesCase }) {
  return inShell(`/sales/orders/${production.id}`, createElement(OrderRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<ChangesCase>({
  screen: 'SCR-107',
  title: 'Order changes: the amendments since confirmation, before → after',
  view: ChangesDesign,
  cases: [
    { id: 'list', label: 'Sales · Two amendments: one changed the lines and the net (the customer accepts again), one the customer PO', model: view('sales'), note: '“Before → after” opens the frozen snapshot of that revision.' },
    { id: 'owner', label: 'Owner · The same amendments', model: view('owner') },
    { id: 'manager', label: 'Production manager · No money: lines and pieces only', model: view('manager') },
    { id: 'compare', label: 'Sales · Before → after of revision 1 (VersionCompare): sizes, unit price and net per line', model: view('sales', { dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[0]!.id } }) },
    { id: 'compare-header', label: 'Sales · Before → after of revision 2: only the customer PO changed', model: view('sales', { dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[1]!.id } }) },
    { id: 'compare-manager', label: 'Production manager · Before → after without prices (sizes only)', model: view('manager', { dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[0]!.id } }) },
    { id: 'empty', label: 'Sales · No changes since confirmation', model: base('sales', order('CONFIRMED'), { tab: 'changes', amendments: { value: NO_AMENDMENTS, problem: null } }) },
    { id: 'empty-cancelled', label: 'Sales · A cancelled order that never changed', model: base('sales', order('CANCELLED', { actions: [] }), { tab: 'changes', amendments: { value: NO_AMENDMENTS, problem: null } }) },
    { id: 'loading', label: 'Reading the amendments', model: view('sales', { amendments: { value: null, problem: null } }) },
    { id: 'error', label: 'The amendments could not be read (in words, Try again)', model: view('sales', { amendments: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'no-permission', label: 'No permission: the API refused the order (orders.view)', model: view('sales', { order: { status: 'forbidden' } }) },
  ],
})
