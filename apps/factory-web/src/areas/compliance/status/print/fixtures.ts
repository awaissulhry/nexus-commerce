import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inShell } from '../../../quality/_shared/fixtures'
import { BOARD, EXPIRIES, FEED, MORE_LINES } from '../fixtures'
import { EMPTY_ADDRESS } from '../model'
import { StatusPrintView, type StatusPrintModel } from './view/StatusPrintView'

/**
 * SCR-314 (new id, B-W2b-266) — the status board on paper or as a PDF (design compliance.status tab:cs-print "for a management
 * review; filters written at the top"), made-up data only: the whole board, with filters, loading (Print held), a failed read,
 * no right.
 */

const model = (over: Partial<StatusPrintModel> = {}): StatusPrintModel => ({
  person: DEMO_USER.displayName,
  at: '2026-11-10T09:42:00.000Z',
  company: 'Officina Demo',
  can: true,
  address: EMPTY_ADDRESS,
  today: '2026-11-10',
  back: '/w/DEMO/compliance/status',
  board: BOARD,
  actions: { lines: MORE_LINES, count: MORE_LINES.length, asOf: '2026-11-10T09:42:00.000Z' },
  feed: FEED,
  expiries: EXPIRIES,
  problem: null,
  brandName: null,
  ...over,
})

function PrintDesign({ model: value }: { model: StatusPrintModel }) {
  return inShell('/compliance/status/print', createElement(StatusPrintView, { model: value }))
}

export const designScreen = defineDesignScreen<StatusPrintModel>({
  screen: 'SCR-314',
  title: 'Status board (print) (Compliance)',
  view: PrintDesign,
  cases: [
    { id: 'board', label: 'The whole board', model: model() },
    { id: 'filters', label: 'With filters written at the top', model: model({ address: { ...EMPTY_ADDRESS, markets: ['DE', 'FR'], status: 'blocked', gap: 'docLanguage' }, brandName: 'DEMO-B1 · Marchio Demo Uno' }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ board: null, actions: null, feed: null, expiries: null }) },
    { id: 'error', label: 'A part failed', model: model({ board: null, actions: null, feed: null, expiries: null, problem: 'problem.unavailable' }) },
    { id: 'no-permission', label: 'No right', model: model({ can: false, board: null, actions: null, feed: null, expiries: null }) },
  ],
})
