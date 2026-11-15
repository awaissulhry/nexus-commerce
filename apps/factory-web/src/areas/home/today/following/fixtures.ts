import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { FollowingModel, FollowingRow } from './model'
import { FollowingView } from './view/FollowingView'

/**
 * SCR-541 — Today › Changed since you looked (B-W2b-388; design home.today `following`). Made-up data only.
 */

const NOW = Date.UTC(2026, 10, 13, 9, 30)
const AS_OF = new Date(NOW - 60_000).toISOString()
const id = (n: number) => `0190f0e2-8888-7000-8000-${String(n).padStart(12, '0')}`
const MARCO = { id: id(901), name: 'Marco Esempio' }
const LUCIA = { id: id(902), name: 'Lucia Demo' }

function row(n: number, extra: Pick<FollowingRow, 'record' | 'messageKey'> & Partial<FollowingRow>): FollowingRow {
  return {
    key: `${extra.record.type}:${extra.record.id}`,
    companyId: id(900),
    anchor: null,
    view: false,
    listKey: null,
    params: {},
    sentence: 'English sentence of the API (not shown).',
    actor: null,
    people: {},
    at: new Date(NOW - n * 47 * 60_000).toISOString(),
    count: 1,
    ids: [id(100 + n)],
    href: `/w/DEMO/records/${extra.record.type}/${extra.record.id}`,
    ...extra,
  }
}

const ROWS: FollowingRow[] = [
  row(1, { record: { type: 'SalesOrder', id: id(1), label: 'SO-2026-0042' }, messageKey: 'notifications.following.changed', actor: MARCO, people: { [MARCO.id]: MARCO.name }, count: 3, ids: [id(101), id(102), id(103)] }),
  row(2, { record: { type: 'SavedView', id: id(2), label: 'Late lines' }, messageKey: 'notifications.following.view', view: true, listKey: 'production.work-orders', params: { count: 6, entered: 2, left: 1 }, href: '/w/DEMO/production/work-orders?savedView=demo' }),
  row(3, { record: { type: 'PurchaseOrder', id: id(3), label: 'PO-2026-0031' }, messageKey: 'notifications.following.mail_in' }),
  row(4, { record: { type: 'Quote', id: id(4), label: 'Q-2026-0139' }, messageKey: 'notifications.following.note', actor: LUCIA, people: { [LUCIA.id]: LUCIA.name } }),
  row(5, { record: { type: 'SavedView', id: id(5), label: 'Lots on hold' }, messageKey: 'notifications.following.viewCount', view: true, listKey: 'quality.holds', params: { count: 2 }, href: null }),
]

const ready = (items: readonly FollowingRow[], complete = true): FollowingModel['rows'] => ({ status: 'ready', data: { items, complete, asOf: AS_OF } })
const base: FollowingModel = { rows: ready(ROWS), now: NOW, held: null, notice: null }

export const designScreen = defineDesignScreen<FollowingModel>({
  screen: 'SCR-541',
  title: 'Today › Changed since you looked (B-W2b-388)',
  view: FollowingView,
  cases: [
    {
      id: 'normal',
      label: 'Records and views I follow that changed',
      model: base,
      note: 'One line per record or saved view: its newest news in my words ("and 2 more"), when, the record or the view’s list as a link; Seen (e on the line) and Unfollow / Unpin. A view whose list has no page yet is said, not linked.',
    },
    { id: 'seen', label: 'After Mark seen', model: { ...base, rows: ready(ROWS.slice(1)), notice: { key: 'following.notice.seen', tone: 'success', params: { record: 'SO-2026-0042' } } }, note: 'The line leaves at once; it comes back with the record’s next news.' },
    { id: 'partial', label: 'More than one page', model: { ...base, rows: ready(ROWS, false) }, note: 'The footer says more changed than one page shows.' },
    { id: 'offline', label: 'Offline', model: { ...base, held: 'held.offline' }, note: 'Lines stay readable; Seen and Unfollow are held with the reason.' },
    { id: 'empty', label: 'Nothing changed', model: { ...base, rows: ready([]) }, note: '"Nothing you follow has changed since you last looked."' },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { status: 'error', problem: 'following.problem.read' } } },
  ],
})
