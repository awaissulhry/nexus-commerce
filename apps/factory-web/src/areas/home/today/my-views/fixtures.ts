import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { MyViewsModel, ViewChip } from './model'
import { MyViewsView } from './view/MyViewsView'

/**
 * SCR-542 — Today › My saved views (B-W2b-388; design home.today `my-views`, PLT-163). Made-up data only.
 */

const NOW = Date.UTC(2026, 10, 13, 9, 30)
const id = (n: number) => `0190f0e2-9999-7000-8000-${String(n).padStart(12, '0')}`
const counted = new Date(NOW - 9 * 60_000).toISOString()

const CHIPS: ViewChip[] = [
  { viewId: id(1), name: 'Late lines', count: { key: 'views.count', count: 6 }, countedAt: counted, href: '/w/DEMO/production/work-orders?savedView=demo-1' },
  { viewId: id(2), name: 'My customers', count: { key: 'views.count', count: 41 }, countedAt: counted, href: '/w/DEMO/sales/customers?savedView=demo-2' },
  { viewId: id(3), name: 'Lots on hold', count: { key: 'views.count', count: 2 }, countedAt: counted, href: '/w/DEMO/quality/lots?savedView=demo-3' },
  { viewId: id(4), name: 'Open orders, all companies', count: { key: 'views.capped', count: 1000 }, countedAt: counted, href: '/w/DEMO/sales/orders?savedView=demo-4' },
  { viewId: id(5), name: 'Shipping this week', count: null, countedAt: null, href: '/w/DEMO/warehouse/shipments?savedView=demo-5' },
  { viewId: id(6), name: 'Old samples', count: { key: 'views.count', count: 0 }, countedAt: counted, href: null },
]

const base: MyViewsModel = { views: { status: 'ready', data: CHIPS }, now: NOW, held: null, notice: null }

export const designScreen = defineDesignScreen<MyViewsModel>({
  screen: 'SCR-542',
  title: 'Today › My saved views (B-W2b-388)',
  view: MyViewsView,
  cases: [
    {
      id: 'normal',
      label: 'Pinned views with their counts',
      model: base,
      note: 'Chips "name · count" (counted for me last, AsOf beside the title): "1000+" when the view holds more than are counted, "—" until it is counted; a view whose list has no page yet says so. The pin on a chip unpins it.',
    },
    { id: 'unpinned', label: 'After Unpin', model: { ...base, views: { status: 'ready', data: CHIPS.slice(1) }, notice: { key: 'views.unpinned', tone: 'success', params: { name: 'Late lines' } } } },
    { id: 'offline', label: 'Offline', model: { ...base, held: 'held.offline' }, note: 'Chips open their lists; Unpin is held with the reason.' },
    { id: 'empty', label: 'Nothing pinned', model: { ...base, views: { status: 'ready', data: [] } }, note: '"Pin a view from any list with Columns ▾ › Pin to Today."' },
    { id: 'loading', label: 'Loading', model: { ...base, views: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, views: { status: 'error', problem: 'views.problem.read' } } },
  ],
})
