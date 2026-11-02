import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell } from '../../reports/demo/fixtures'
import type { DispatchPaper } from '../api'
import { DispatchPrintView, type DispatchPrintModel } from './view/DispatchPrintView'

/**
 * SCR-138-print — the dispatch list on paper (design production.dispatch tab:dp-tab-list; MES-032, paper for the line at shift
 * start), with made-up data only: a line with two stations, one station, a line with nothing queued, loading and a failed
 * read. Opened in a new tab from the board; the browser's print hides the frame.
 */

const PAPER: DispatchPaper = {
  language: 'en',
  title: 'Dispatch list',
  heading: 'Line L1 · Linea 1 · Giacche',
  facts: [
    { label: 'Day', value: '2026-11-16' },
    { label: 'Shift', value: 'Morning' },
    { label: 'Plan', value: 'v12' },
    { label: 'Printed', value: '2026-11-16 05:58' },
  ],
  columns: ['No.', 'Work order', 'Style', 'Operation', 'Bundles', 'Pieces', 'Min', 'Due', 'Material', 'Done'],
  sections: [
    {
      title: 'SEW-01 · Cucitura 1',
      operators: 'Operators: Giulia',
      rows: [
        { rush: true, cells: ['1', 'WO-0142 RUSH', 'MOD-101 Giacca Aero', 'Op 20 Cucitura maniche', 'BN-004210, BN-004211, BN-004212', '80', '520.0', '2026-11-18', 'Ready', ''] },
        { rush: false, cells: ['2', 'WO-0144', 'MOD-103 Gilet Pista', 'Op 20 Cucitura fianchi', '—', '40', '260.0', '2026-11-13', 'Missing', ''] },
      ],
      footer: 'Total: 120 · 780.0 min',
    },
    { title: 'SEW-02 · Cucitura 2', operators: null, rows: [{ rush: false, cells: ['1', 'WO-0143', 'MOD-102 Pantalone Strada', 'Op 30 Assemblaggio', 'BN-004220', '60', '390.0', '2026-11-20', 'On the way', ''] }], footer: 'Total: 60 · 390.0 min' },
  ],
  empty: null,
  foot: 'Paper list: the order may change. Work counts only when the bundle is scanned.',
}

const EMPTY: DispatchPaper = { ...PAPER, heading: 'Line L2 · Linea 2 · Pantaloni', sections: [], empty: 'Nothing queued for this shift.' }

function PrintDesign({ model }: { model: DispatchPrintModel }) {
  return inShell('/production/dispatch/print', createElement(DispatchPrintView, { model }), 'manager')
}

export const designScreen = defineDesignScreen<DispatchPrintModel>({
  screen: 'SCR-138-print',
  title: 'Dispatch list: print window (Production)',
  view: PrintDesign,
  cases: [
    { id: 'line', label: 'A line for the shift start', model: { papers: [PAPER], problem: null }, note: 'One table per station, an empty column to tick by hand; the frame is hidden on paper.' },
    { id: 'lines', label: 'Every line: one paper each', model: { papers: [PAPER, EMPTY], problem: null } },
    { id: 'station', label: 'One station', model: { papers: [{ ...PAPER, heading: 'Station SEW-01 · Cucitura 1', sections: PAPER.sections.slice(0, 1) }], problem: null } },
    { id: 'empty', label: 'Nothing queued', model: { papers: [EMPTY], problem: null } },
    { id: 'loading', label: 'Loading (Print held)', model: { papers: null, problem: null } },
    { id: 'error', label: 'The read failed', model: { papers: null, problem: 'error.read' } },
  ],
})
