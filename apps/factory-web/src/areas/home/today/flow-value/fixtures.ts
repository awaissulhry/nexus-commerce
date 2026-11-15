import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell } from '../../reports/digest/fixtures'
import type { FlowValue } from './api'
import { FlowValueView, type FlowValueModel } from './view/FlowValueView'

/**
 * SCR-644 — Today's work-order flow with its value per stage at cost (B-W2b-435; design home.today `flow`, W2b), with made-up
 * data only: the four stages valued, work orders of companies in two currencies (no amount), a partial read, loading, failed.
 */

const VALUED: FlowValue = {
  asOf: '2026-11-14T09:15:00.000Z',
  lens: 'WORK_ORDERS',
  valued: true,
  currency: 'EUR',
  mixedCurrencies: false,
  complete: true,
  stages: [
    { key: 'DRAFT', workOrders: 2, value: 0 },
    { key: 'RELEASED', workOrders: 4, value: 312000 },
    { key: 'IN_PROGRESS', workOrders: 6, value: 1846000 },
    { key: 'COMPLETED', workOrders: 1, value: 41000 },
  ],
}

const base: FlowValueModel = { read: { status: 'ready', data: VALUED } }

function FlowValueDesign({ model }: { model: FlowValueModel }) {
  return inShell('/home/today', createElement(FlowValueView, { model }), 'owner')
}

export const designScreen = defineDesignScreen<FlowValueModel>({
  screen: 'SCR-644',
  title: 'Today › Where the work is — value per stage at cost',
  view: FlowValueDesign,
  cases: [
    { id: 'valued', label: 'Value per stage (cost grain)', model: base, note: 'Drawn only under the work-order flow, only for a person with the cost grain and costing.view.' },
    { id: 'mixed', label: 'Companies in two currencies', model: { read: { status: 'ready', data: { ...VALUED, currency: null, mixedCurrencies: true, stages: VALUED.stages.map((stage) => ({ ...stage, value: null })) } } } },
    { id: 'partial', label: 'Partly read', model: { read: { status: 'ready', data: { ...VALUED, complete: false } } } },
    { id: 'loading', label: 'Loading', model: { read: { status: 'loading' } } },
    { id: 'error', label: 'Failed', model: { read: { status: 'error', problem: 'flowValue.error' } } },
  ],
})
