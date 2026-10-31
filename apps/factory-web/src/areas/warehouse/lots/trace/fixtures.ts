import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, PREFIX, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { HOLD_REASONS } from '../demo/daily/fixtures'
import { FIND_SEVERAL, HIDE_TRACE } from '../demo/trace/fixtures'
import { blankFind } from './model'
import { TracePageView, type TracePageModel } from './view/TracePageView'

/**
 * SCR-201-trace — the trace of a record that is not a lot (B-W2a-64; design warehouse.lots lt-trace: the kind is
 * recognised and the trace opens on that node), with made-up data only: a hide traced both ways (back to its lot,
 * receipt and tannery; on to its work order, a bundle cut from it, the shipment and the customers who may hold it), one
 * way only, only affected customers, Trace another code…, and the states (reading, not found, failed, nothing in the
 * address, no permission). Roles: Warehouse, Quality, Sales (no inventory.stock.view).
 */

interface TraceCase {
  role: RoleCase
  page: TracePageModel
}

const START = { kind: 'HIDE' as const, id: HIDE_TRACE.start.id, direction: 'BOTH' as const }

function traceCase(role: RoleCase, over: Partial<TracePageModel> = {}): TraceCase {
  return { role, page: { prefix: PREFIX, can: canFor(role), start: START, trace: { status: 'ready', value: HIDE_TRACE }, holdReasons: HOLD_REASONS, asOf: HIDE_TRACE.asOf, timeZone: TIME_ZONE, find: null, ...over } }
}

function TraceDesign({ model }: { model: TraceCase }) {
  return inShell('/warehouse/lots/trace', createElement(TracePageView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<TraceCase>({
  screen: 'SCR-201-trace',
  title: 'Trace (a hide, a bundle, a work order, a garment or a shipment, both ways)',
  view: TraceDesign,
  cases: [
    { id: 'hide', label: 'A hide traced both ways: its lot and tannery, its work order, a bundle, the customers who may hold it', model: traceCase('warehouse'), note: 'Arrow keys walk the tree; Enter opens a node; ⌘-click opens it in a new tab.' },
    { id: 'forward', label: 'Forward only (where it went)', model: traceCase('quality', { start: { ...START, direction: 'FORWARD' }, trace: { status: 'ready', value: { ...HIDE_TRACE, direction: 'FORWARD' } } }) },
    { id: 'affected', label: 'Only affected customers', model: traceCase('quality', { affectedOnly: true }) },
    { id: 'another', label: 'Trace another code…', model: traceCase('warehouse', { find: blankFind() }) },
    { id: 'another-several', label: 'Trace another code: two records match', model: traceCase('warehouse', { find: { code: FIND_SEVERAL.code, state: 'several', matches: FIND_SEVERAL.matches, problem: null } }) },
    { id: 'loading', label: 'Reading the trace', model: traceCase('warehouse', { trace: { status: 'loading' }, asOf: null }) },
    { id: 'not-found', label: 'Not found (or another company’s)', model: traceCase('warehouse', { trace: { status: 'not_found' }, asOf: null }) },
    { id: 'error', label: "The trace couldn't be read", model: traceCase('warehouse', { trace: { status: 'error', problem: 'problem.offline' }, asOf: null }) },
    { id: 'nothing', label: 'Nothing traceable in the address', model: traceCase('warehouse', { start: null, trace: { status: 'loading' }, asOf: null }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view (the page says so)', model: traceCase('sales') },
  ],
})
