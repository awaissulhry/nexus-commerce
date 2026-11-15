import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell } from '../../../home/reports/digest/fixtures'
import type { WipAgeing } from './api'
import { WipAgeingPanel, type WipAgeingModel } from './view/WipAgeingPanel'

/**
 * SCR-643 — Production › Reports › WIP ageing (B-W2b-435; design production.reports `prr-wip`, ANA-015), with made-up data only:
 * two lines and work on no line, stages stacked by how long they waited; one line only; nothing waiting; loading; failed.
 */

const NOW = Date.parse('2026-11-14T09:20:00.000Z')
const L1 = { id: '0190f0e2-6666-7000-8000-000000000001', code: 'L1', name: 'Linea Demo 1' }
const L2 = { id: '0190f0e2-6666-7000-8000-000000000002', code: 'L2', name: 'Linea Demo 2' }
const wo = (n: number) => ({ type: 'WorkOrder', id: `0190f0e2-7777-7000-8000-00000000000${n}`, label: `DEMO-WO-00${90 + n}` })

const FULL: WipAgeing = {
  asOf: '2026-11-14T09:15:00.000Z',
  overall: { workOrders: 6, pieces: 180, waiting: 96 },
  stages: [
    { line: L1, operation: { code: 'CUT', name: 'Taglio' }, workOrders: 2, waiting: 24, ageing: { D0_2: 20, D3_5: 4, D6_10: 0, D11_PLUS: 0 } },
    { line: L1, operation: { code: 'SEW', name: 'Cucitura' }, workOrders: 3, waiting: 38, ageing: { D0_2: 10, D3_5: 16, D6_10: 8, D11_PLUS: 4 } },
    { line: L1, operation: { code: 'FIN', name: 'Rifinitura' }, workOrders: 1, waiting: 6, ageing: { D0_2: 6, D3_5: 0, D6_10: 0, D11_PLUS: 0 } },
    { line: L2, operation: { code: 'SEW', name: 'Cucitura' }, workOrders: 1, waiting: 18, ageing: { D0_2: 0, D3_5: 0, D6_10: 6, D11_PLUS: 12 } },
    { line: null, operation: { code: 'QC', name: 'Controllo' }, workOrders: 1, waiting: 10, ageing: { D0_2: 10, D3_5: 0, D6_10: 0, D11_PLUS: 0 } },
  ],
  rows: [
    { record: wo(1), line: L2, waitedDays: 14, band: 'D11_PLUS', pieces: 30, stages: [{ code: 'SEW', name: 'Cucitura', waiting: 18 }] },
    { record: wo(2), line: L1, waitedDays: 7, band: 'D6_10', pieces: 40, stages: [{ code: 'SEW', name: 'Cucitura', waiting: 12 }] },
    { record: wo(3), line: L1, waitedDays: 4, band: 'D3_5', pieces: 30, stages: [{ code: 'CUT', name: 'Taglio', waiting: 4 }, { code: 'SEW', name: 'Cucitura', waiting: 16 }] },
    { record: wo(4), line: null, waitedDays: 1, band: 'D0_2', pieces: 20, stages: [{ code: 'QC', name: 'Controllo', waiting: 10 }] },
  ],
  more: 0,
}

const ONE_LINE: WipAgeing = { ...FULL, overall: { workOrders: 3, pieces: 90, waiting: 68 }, stages: FULL.stages.filter((stage) => stage.line?.id === L1.id), rows: FULL.rows.filter((row) => row.line?.id === L1.id) }

const base: WipAgeingModel = { read: { status: 'ready', data: FULL }, site: 'NORD', hrefs: Object.fromEntries(FULL.rows.map((row) => [row.record.id, `/w/DEMO/production/work-orders/${row.record.id}`])), now: NOW }

function WipDesign({ model }: { model: WipAgeingModel }) {
  return inShell('/production/reports', createElement(WipAgeingPanel, { model }), 'owner')
}

export const designScreen = defineDesignScreen<WipAgeingModel>({
  screen: 'SCR-643',
  title: 'WIP ageing by line (Production › Reports)',
  view: WipDesign,
  cases: [
    { id: 'lines', label: 'Two lines and work on no line', model: base, note: 'Each stage a bar of garments waiting, split by days since the last report; the longest waiting work orders below.' },
    { id: 'one-line', label: 'One line', model: { ...base, read: { status: 'ready', data: ONE_LINE } } },
    { id: 'empty', label: 'Nothing waiting', model: { ...base, read: { status: 'ready', data: { ...FULL, overall: { workOrders: 0, pieces: 0, waiting: 0 }, stages: [], rows: [] } } } },
    { id: 'loading', label: 'Loading', model: { ...base, read: { status: 'loading' } } },
    { id: 'error', label: 'Failed', model: { ...base, read: { status: 'error', problem: 'wip.error.read' } } },
  ],
})
