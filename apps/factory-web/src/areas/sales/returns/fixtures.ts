import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { BLANK_REPAIR, BLANK_RETURN, mergedRows, type ListAddress } from './model'
import { canFor, CLOSED_RETURN, CUSTOMER, CUSTOMERS, inShell, ME, NOW, PEOPLE, PREFIX, REASONS, REPAIR_COUNTS, REPAIR_ROWS, RETURN_COUNTS, RETURN_ROWS, RETURNABLE, TODAY, type RoleCase } from './demo/fixtures'
import type { CloseModel, NewRepairModel, NewReturnModel, Notice, ReturnsListModel } from './view-model'
import { ReturnsView } from './view/ReturnsView'

/**
 * Design cases of Sales › Returns & repairs (SCR-111): the list with its notices and tiles, New return, New repair and
 * Close return, each state the design names (loading, empty, filtered, error, no permission, offline, held with its
 * reason) and the role cases. Made-up data only (demo/fixtures.ts).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly list: ReturnsListModel
}

const address = (patch: Partial<ListAddress> = {}): ListAddress => ({ view: 'open', q: '', ...patch })
const ALL_ROWS = mergedRows(RETURN_ROWS, REPAIR_ROWS)
const NOTICES: Notice[] = [
  { id: 'late:1', tone: 'warning', words: { key: 'notice.late', params: { count: 1 } }, href: `${PREFIX}/sales/returns?view=late`, linkWords: { key: 'notice.lateLink' } },
  { id: 'check:1', tone: 'warning', words: { key: 'notice.toCheck', params: { count: 1 } } },
  { id: 'decide:1', tone: 'info', words: { key: 'notice.toDecide', params: { count: 1 } } },
]

function listModel(role: RoleCase, over: Partial<ReturnsListModel> = {}): ReturnsListModel {
  const can = canFor(role)
  const view = over.address?.view ?? 'open'
  const repairs = can.repairsView ? REPAIR_ROWS : []
  const items =
    view === 'all' || view === 'closed'
      ? mergedRows(view === 'closed' ? [CLOSED_RETURN] : [...RETURN_ROWS, CLOSED_RETURN], view === 'closed' ? [] : repairs)
      : view === 'openReturns'
        ? mergedRows(RETURN_ROWS, [])
        : view === 'openRepairs'
          ? mergedRows([], repairs)
          : view === 'waiting'
            ? mergedRows(RETURN_ROWS.filter((row) => row.status === 'AUTHORISED'), repairs.filter((row) => row.stage === 'AWAITING_GOODS'))
            : view === 'inRepair'
              ? mergedRows([], repairs.filter((row) => row.stage === 'IN_REPAIR'))
              : mergedRows(RETURN_ROWS, repairs)
  const priced = can.price ? items : items.map((row) => ({ ...row, credit: row.kind === 'RETURN' ? undefined : row.credit }))
  return {
    prefix: PREFIX,
    can,
    me: ME,
    address: address({ view }),
    rows: { items: priced, problem: null, truncated: false },
    counts: { returns: RETURN_COUNTS, repairs: can.repairsView ? REPAIR_COUNTS : null, failed: false },
    people: PEOPLE,
    asOf: NOW,
    live: 'live',
    offline: false,
    updates: 0,
    today: TODAY,
    notices: can.repairsView ? NOTICES : [{ id: 'noRepairs', tone: 'info', words: { key: 'notice.noRepairs' } }],
    receipt: null,
    newReturn: null,
    newRepair: null,
    close: null,
    ...over,
  }
}

export function newReturnModel(over: Partial<NewReturnModel> = {}): NewReturnModel {
  return {
    draft: BLANK_RETURN,
    customers: { items: CUSTOMERS, problem: null },
    returnable: { value: null, loading: false, problem: null },
    reasons: REASONS,
    preview: null,
    previewing: false,
    showProblems: false,
    busy: false,
    problem: null,
    today: TODAY,
    price: true,
    ...over,
  }
}

const POLICY = { windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE' as const, restockingFeePct: '10', conditions: null }
const picked = newReturnModel({
  draft: { ...BLANK_RETURN, partyId: CUSTOMER.id, lines: { [RETURNABLE[0]!.invoiceLineId!]: { quantity: '1', reasonCode: 'DEFECT', note: 'Zip broke (made-up)' }, [RETURNABLE[1]!.invoiceLineId!]: { quantity: '2', reasonCode: 'WRONG_SIZE', note: '' } } },
  returnable: { value: { lines: RETURNABLE, policy: POLICY }, loading: false, problem: null },
  preview: { ok: true, problems: [], warnings: [], goodsDueBy: '2026-11-15', siteId: null, salesOrderId: null, lines: [] },
})

export function newRepairModel(over: Partial<NewRepairModel> = {}): NewRepairModel {
  return { draft: BLANK_REPAIR, fromLine: null, customers: { items: CUSTOMERS, problem: null }, preview: null, previewing: false, showProblems: false, busy: false, problem: null, today: TODAY, ...over }
}

const closeModel = (over: Partial<CloseModel> = {}): CloseModel => ({ number: 'RMA-DEMO-0003', reason: '', note: '', busy: false, problem: null, warnings: null, ...over })

/** The list with its own address and dialog drafts (tiles, menus and the dialogs' fields work in review). */
function ReturnsDesign({ model }: { model: DesignModel }) {
  const [list, setList] = useState<ReturnsListModel>(model.list)
  useEffect(() => setList(model.list), [model.list])
  return inShell(
    '/sales/returns',
    createElement(ReturnsView, {
      model: list,
      actions: {
        onAddress: (patch) => setList((current) => ({ ...current, address: { ...current.address, ...patch } })),
        onClearFilters: () => setList((current) => ({ ...current, address: address() })),
        onNewReturn: () => setList((current) => ({ ...current, newReturn: newReturnModel() })),
        onNewReturnDraft: (patch) => setList((current) => (current.newReturn ? { ...current, newReturn: { ...current.newReturn, draft: { ...current.newReturn.draft, ...patch }, returnable: patch.partyId ? { value: { lines: RETURNABLE, policy: POLICY }, loading: false, problem: null } : current.newReturn.returnable } } : current)),
        onNewReturnLine: (key, patch) =>
          setList((current) => {
            if (!current.newReturn) return current
            const before = current.newReturn.draft.lines[key] ?? { quantity: '', reasonCode: '', note: '' }
            return { ...current, newReturn: { ...current.newReturn, draft: { ...current.newReturn.draft, lines: { ...current.newReturn.draft.lines, [key]: { ...before, ...patch } } } } }
          }),
        onNewReturnSubmit: () => setList((current) => (current.newReturn ? { ...current, newReturn: { ...current.newReturn, showProblems: true } } : current)),
        onNewReturnClose: () => setList((current) => ({ ...current, newReturn: null })),
        onNewRepair: () => setList((current) => ({ ...current, newRepair: newRepairModel() })),
        onNewRepairDraft: (patch) => setList((current) => (current.newRepair ? { ...current, newRepair: { ...current.newRepair, draft: { ...current.newRepair.draft, ...patch } } } : current)),
        onNewRepairSubmit: () => setList((current) => (current.newRepair ? { ...current, newRepair: { ...current.newRepair, showProblems: true } } : current)),
        onNewRepairClose: () => setList((current) => ({ ...current, newRepair: null })),
        onClose: (row) => setList((current) => ({ ...current, close: closeModel({ number: row.number }) })),
        onCloseDraft: (patch) => setList((current) => (current.close ? { ...current, close: { ...current.close, ...patch } } : current)),
        onCloseDismiss: () => setList((current) => ({ ...current, close: null })),
        onDismissNotice: (id) => setList((current) => ({ ...current, notices: current.notices.filter((notice) => notice.id !== id) })),
      },
    }),
    model.role,
  )
}

const empty = { items: [], problem: null, truncated: false }

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-111',
  title: 'Returns & repairs (list, tiles, notices, New return, New repair, Close)',
  view: ReturnsDesign,
  cases: [
    { id: 'owner', label: 'Owner: open returns and repairs, the notices, the tiles', model: { role: 'owner', list: listModel('owner') }, note: 'One notice at a time (the most serious), the rest behind "2 more notices". Tiles are named saved filters.' },
    { id: 'sales', label: 'Sales: opens returns and repairs, sees credit values', model: { role: 'sales', list: listModel('sales') } },
    { id: 'warehouse', label: 'Warehouse: receives; New return held with its reason; no prices', model: { role: 'warehouse', list: listModel('warehouse') } },
    { id: 'inspector', label: 'Quality inspector: sees, grades; no prices', model: { role: 'inspector', list: listModel('inspector') } },
    { id: 'finance', label: 'Finance: reads both; credit values', model: { role: 'finance', list: listModel('finance') } },
    { id: 'read-only', label: 'Read-only: sees, changes nothing (each step held with the permission)', model: { role: 'readOnly', list: listModel('readOnly') } },
    { id: 'no-permission', label: 'No permission: which one and who grants it', model: { role: 'none', list: listModel('none') } },
    { id: 'tile-waiting', label: 'Tile pressed: waiting for goods', model: { role: 'owner', list: listModel('owner', { address: address({ view: 'waiting' }) }) } },
    { id: 'tile-in-repair', label: 'Tile pressed: repairs in progress', model: { role: 'owner', list: listModel('owner', { address: address({ view: 'inRepair' }) }) } },
    { id: 'rows-all', label: 'Rows: all (closed too)', model: { role: 'owner', list: listModel('owner', { address: address({ view: 'all' }) }) } },
    { id: 'filtered', label: 'Filtered: no row matches (Clear filters)', model: { role: 'owner', list: listModel('owner', { address: address({ q: 'zzz' }), rows: empty }) } },
    { id: 'empty', label: 'First day: no returns and repairs', model: { role: 'owner', list: listModel('owner', { rows: empty, notices: [], counts: { returns: { waiting: 0, late: 0, toInspect: 0, toDecide: 0, replacement: 0, open: 0 }, repairs: { awaiting: 0, received: 0, inRepair: 0, toCheck: 0, toShip: 0, open: 0 }, failed: false } }) } },
    { id: 'loading', label: 'Loading', model: { role: 'owner', list: listModel('owner', { rows: { items: null, problem: null, truncated: false }, counts: { returns: null, repairs: null, failed: false }, notices: [], asOf: null, live: 'connecting' }) } },
    { id: 'error', label: "The API didn't answer (never drawn as an empty list); tiles say '—'", model: { role: 'owner', list: listModel('owner', { rows: { items: null, problem: 'quality:problem.unavailable', truncated: false }, counts: { returns: null, repairs: null, failed: true }, notices: [], asOf: null, live: 'offline' }) } },
    { id: 'offline', label: 'Offline: the last copy with its time, writes held', model: { role: 'owner', list: listModel('owner', { live: 'offline', offline: true }) } },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: { role: 'owner', list: listModel('owner', { updates: 3 }) } },
    { id: 'selection', label: 'Selection: Copy numbers, Export (CSV)', model: { role: 'owner', list: listModel('owner', { selected: ALL_ROWS.slice(0, 3).map((row) => row.key) }) } },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects; keys in the footer icon', model: { role: 'owner', list: listModel('owner', { focusRow: 1 }) } },
    { id: 'shortcuts', label: 'All shortcuts (?)', model: { role: 'owner', list: listModel('owner', { helpOpen: true }) } },
    { id: 'new-return', label: 'New return (blank: pick the customer)', model: { role: 'owner', list: listModel('owner', { newReturn: newReturnModel() }) } },
    { id: 'new-return-lines', label: 'New return: what may come back, two lines picked, deadline from the policy', model: { role: 'owner', list: listModel('owner', { newReturn: picked }) }, note: 'Each line says sold and left; a line with nothing left is drawn but cannot take pieces; delivered outside the window is a warning.' },
    {
      id: 'new-return-above-sold',
      label: 'New return: more than was sold, refused at the field with the numbers',
      model: { role: 'owner', list: listModel('owner', { newReturn: { ...picked, draft: { ...picked.draft, lines: { [RETURNABLE[0]!.invoiceLineId!]: { quantity: '3', reasonCode: 'DEFECT', note: '' } } }, showProblems: true } }) },
    },
    { id: 'new-return-reading', label: 'New return: reading the invoiced lines', model: { role: 'owner', list: listModel('owner', { newReturn: newReturnModel({ draft: { ...BLANK_RETURN, partyId: CUSTOMER.id }, returnable: { value: null, loading: true, problem: null } }) }) } },
    { id: 'new-return-refused', label: 'New return refused: no RMA number series (the preview by place)', model: { role: 'owner', list: listModel('owner', { newReturn: { ...picked, showProblems: true, preview: { ...picked.preview!, ok: false, problems: [{ path: 'company/numbering', message: 'No RETURN series.' }] } } }) } },
    { id: 'new-repair', label: 'New repair (blank)', model: { role: 'owner', list: listModel('owner', { newRepair: newRepairModel() }) } },
    {
      id: 'new-repair-found',
      label: 'New repair: a scanned serial found our garment and its other repair',
      model: {
        role: 'owner',
        list: listModel('owner', {
          newRepair: newRepairModel({
            draft: { ...BLANK_REPAIR, serial: 'S-DEMO-000431', partyId: CUSTOMER.id, problem: 'Elbow seam open (made-up).', received: true, inboundDdtNumber: 'C-DDT-DEMO-12' },
            preview: { ok: true, problems: [], warnings: [], draft: { partyId: CUSTOMER.id, kind: 'REPAIR', stage: 'RECEIVED', serial: 'S-DEMO-000431', styleId: null, size: '52', problem: 'Elbow seam open (made-up).', safetyCheckRequired: true }, garment: { madeOn: '2026-09-02', workOrderNumber: 'WO-DEMO-0142', batchNumber: 'B-DEMO-0142', forThisCustomer: true }, history: [{ id: REPAIR_ROWS[0]!.id, number: 'REP-DEMO-0009', stage: 'SHIPPED', createdAt: NOW }] },
          }),
        }),
      },
    },
    { id: 'new-repair-problems', label: 'New repair: pressed with the customer and the problem missing', model: { role: 'owner', list: listModel('owner', { newRepair: newRepairModel({ showProblems: true }) }) } },
    { id: 'close', label: 'Close return: the finish reason', model: { role: 'owner', list: listModel('owner', { close: closeModel() }) } },
    { id: 'close-done', label: 'Close return: closed, with a thing to look at', model: { role: 'owner', list: listModel('owner', { close: closeModel({ reason: 'REPLACED', warnings: 1 }) }) } },
  ],
})
