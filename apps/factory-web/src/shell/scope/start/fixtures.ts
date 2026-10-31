import { defineDesignScreen } from '../../../lib/design/design-screen'
import { StartPageView, type StartPageViewModel } from './view/StartPageView'

/**
 * SCR-007-start — My profile's "Where I work" card (B-W2b-05; design shell.scope sec:defaults "Start page: Today
 * (default) / a saved view I pick"). Made-up lists and views.
 */

const PAGES = [
  { href: '/sales/orders', label: 'Orders', area: 'Sales' },
  { href: '/warehouse/stock', label: 'Stock', area: 'Warehouse' },
  { href: '/production/work-orders', label: 'Work orders', area: 'Production' },
]
const VIEWS = [
  { id: '0190f0e2-cdcd-7000-8000-000000000001', name: 'Late orders · North' },
  { id: '0190f0e2-cdcd-7000-8000-000000000002', name: 'Waiting for deposit' },
]
const base: StartPageViewModel = { choice: 'today', pages: PAGES, page: null, views: { status: 'idle' }, viewId: null, changed: false }

export const designScreen = defineDesignScreen<StartPageViewModel>({
  screen: 'SCR-007-start',
  title: 'Where I work: start page',
  view: StartPageView,
  part: true,
  cases: [
    { id: 'today', label: 'Today (the default)', model: base, note: 'Save is held: nothing changed.' },
    { id: 'pick-list', label: 'A saved view: choose a list', model: { ...base, choice: 'view', changed: true }, note: 'Save is held until a view is chosen.' },
    { id: 'loading', label: 'Reading the list\'s views', model: { ...base, choice: 'view', page: '/sales/orders', views: { status: 'loading' }, changed: true } },
    { id: 'pick-view', label: 'A saved view chosen', model: { ...base, choice: 'view', page: '/sales/orders', views: { status: 'ready', items: VIEWS }, viewId: VIEWS[0]!.id, changed: true } },
    { id: 'no-views', label: 'The list has no saved view', model: { ...base, choice: 'view', page: '/warehouse/stock', views: { status: 'ready', items: [] }, changed: true }, note: 'Says where to save one (the list\'s Columns menu).' },
    { id: 'error', label: 'The views could not be read', model: { ...base, choice: 'view', page: '/sales/orders', views: { status: 'error' }, changed: true } },
    { id: 'saved', label: 'Saved', model: { ...base, choice: 'view', page: '/sales/orders', views: { status: 'ready', items: VIEWS }, viewId: VIEWS[1]!.id, saved: true }, note: 'Opens at the next sign-in, while the person may open that list.' },
  ],
})
