import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { orderPromiseWords, phrase, poNotConfirmedWords, quoteApprovalWords, whyKey, type Phrase, type RowWords } from '@nexus/factory-domain/insights/words'
import type { TodayItem } from '../model'
import { TodayPrintView, type TodayPrintViewModel } from '../view/TodayPrintView'

/**
 * SCR-029 › Print my list (Today's overflow menu, opened in a new tab) — made-up rows only. The page as paper: the date,
 * the person and the filter at the top, every row with why it is theirs and what waits on it.
 */

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const id = (n: number) => `0190f0e2-8888-7000-8000-${String(n).padStart(12, '0')}`
const ref = (value: Phrase) => ({ key: value.key, params: value.params as Record<string, string | number | string[]> })
const item = (n: number, extra: Omit<Partial<TodayItem>, 'sentence' | 'why' | 'blocks' | 'words'> & Pick<TodayItem, 'kind' | 'severity' | 'group'> & { said: RowWords; act: string }): TodayItem => {
  const { said, act, ...rest } = extra
  const why = phrase(whyKey(extra.kind, act))
  return {
    key: `${extra.kind}:${id(n)}`,
    state: 'X',
    category: 'ALERT',
    severityWord: '',
    record: { type: 'Thing', id: id(n), label: `DEMO-${n}` },
    companyId: null,
    siteId: null,
    partyId: null,
    sentence: said.sentence.text,
    why: why.text,
    blocks: said.blocks?.text ?? null,
    words: { sentence: ref(said.sentence), why: ref(why), blocks: said.blocks ? ref(said.blocks) : null },
    sentenceFigure: null,
    due: null,
    since: at(27),
    ageDays: 2,
    decide: 'OPEN',
    figures: null,
    ...rest,
  }
}

const ITEMS: TodayItem[] = [
  item(1, {
    kind: 'ORDER_PROMISE',
    severity: 'HIGH',
    group: 'NOW',
    said: orderPromiseWords({ number: 'SO-2026-0042', customer: 'Pista Demo S.r.l.', state: 'LATE', days: 2, promiseDate: '2026-10-27', toShip: 12 }),
    act: 'orders.manage',
    due: { date: '2026-10-27', days: -2, word: 'OVERDUE' },
  }),
  item(2, { kind: 'QUOTE_APPROVAL', category: 'APPROVAL', decide: 'REVIEW', severity: 'MEDIUM', group: 'TODAY', said: quoteApprovalWords({ number: 'Q-2026-0142', customer: 'Moto Demo Club', reasons: ['MARGIN_FLOOR'] }), act: 'quotes.approve' }),
  item(3, {
    kind: 'PO_NOT_CONFIRMED',
    severity: 'MEDIUM',
    group: 'THIS_WEEK',
    said: poNotConfirmedWords({ number: 'PO-2026-0031', supplier: 'Conceria Demo', hours: 74, requestedDate: '2026-11-05' }),
    act: 'purchasing.send',
    due: { date: '2026-11-05', days: 7, word: 'SOON' },
  }),
]

const base: TodayPrintViewModel = { person: 'Alex Demo', filter: null, list: { status: 'ready', data: { asOf: at(29, 8), items: ITEMS, total: ITEMS.length } } }

export const designScreen = defineDesignScreen<TodayPrintViewModel>({
  screen: 'SCR-029-print',
  title: 'Today › Print my list',
  view: TodayPrintView,
  cases: [
    { id: 'list', label: 'My list', model: base },
    { id: 'filtered', label: 'Filtered by a tile', model: { ...base, filter: 'Approvals', list: { status: 'ready', data: { asOf: at(29, 8), items: ITEMS.slice(1, 2), total: 1 } } } },
    { id: 'cut', label: 'More rows than printed', model: { ...base, list: { status: 'ready', data: { asOf: at(29, 8), items: ITEMS, total: 240 } } } },
    { id: 'empty', label: 'Nothing to print', model: { ...base, list: { status: 'ready', data: { asOf: at(29, 8), items: [], total: 0 } } } },
    { id: 'error', label: 'Could not be read', model: { ...base, list: { status: 'error', problem: 'today.problem.read' } } },
  ],
})
