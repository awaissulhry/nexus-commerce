import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { TodayItem } from '../model'
import { TodayPrintView, type TodayPrintViewModel } from '../view/TodayPrintView'

/**
 * SCR-029 › Print my list (Today's overflow menu, opened in a new tab) — made-up rows only. The page as paper: the date,
 * the person and the filter at the top, every row with why it is theirs and what waits on it.
 */

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const id = (n: number) => `0190f0e2-8888-7000-8000-${String(n).padStart(12, '0')}`
const item = (n: number, extra: Partial<TodayItem> & Pick<TodayItem, 'kind' | 'severity' | 'group' | 'sentence' | 'why'>): TodayItem => ({
  key: `${extra.kind}:${id(n)}`,
  state: 'X',
  category: 'ALERT',
  severityWord: '',
  record: { type: 'Thing', id: id(n), label: `DEMO-${n}` },
  companyId: null,
  siteId: null,
  partyId: null,
  blocks: null,
  due: null,
  since: at(27),
  ageDays: 2,
  decide: 'OPEN',
  figures: null,
  ...extra,
})

const ITEMS: TodayItem[] = [
  item(1, { kind: 'ORDER_PROMISE', severity: 'HIGH', group: 'NOW', sentence: 'Order SO-2026-0042 for Pista Demo S.r.l. is 2 days late: it was promised for 2026-10-27.', why: "You manage this customer's orders and their promise dates.", blocks: 'Pista Demo S.r.l. waits for 12 pieces.', due: { date: '2026-10-27', days: -2, word: 'OVERDUE' } }),
  item(2, { kind: 'QUOTE_APPROVAL', severity: 'MEDIUM', group: 'TODAY', sentence: 'Quote Q-2026-0142 for Moto Demo Club waits for an approval: margin under the floor (margin 18.2 %).', why: "You approve this customer's quotes, and someone else asked." }),
  item(3, { kind: 'PO_NOT_CONFIRMED', severity: 'MEDIUM', group: 'THIS_WEEK', sentence: 'Purchase order PO-2026-0031 to Conceria Demo is not confirmed 3 days after it was sent.', why: 'You send purchase orders to this supplier.', due: { date: '2026-11-05', days: 7, word: 'SOON' } }),
]

const base: TodayPrintViewModel = { person: 'Alex Demo', filter: null, list: { status: 'ready', data: { asOf: at(29, 8), items: ITEMS, total: ITEMS.length } } }

export const designScreen = defineDesignScreen<TodayPrintViewModel>({
  screen: 'SCR-029-print',
  title: 'Today › Print my list',
  view: TodayPrintView,
  cases: [
    { id: 'list', label: 'My list', model: base },
    { id: 'filtered', label: 'Filtered by a tile', model: { ...base, filter: 'Quote approvals', list: { status: 'ready', data: { asOf: at(29, 8), items: ITEMS.slice(1, 2), total: 1 } } } },
    { id: 'cut', label: 'More rows than printed', model: { ...base, list: { status: 'ready', data: { asOf: at(29, 8), items: ITEMS, total: 240 } } } },
    { id: 'empty', label: 'Nothing to print', model: { ...base, list: { status: 'ready', data: { asOf: at(29, 8), items: [], total: 0 } } } },
    { id: 'error', label: 'Could not be read', model: { ...base, list: { status: 'error', problem: 'today.problem.read' } } },
  ],
})
