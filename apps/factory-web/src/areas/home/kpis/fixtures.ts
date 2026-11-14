import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { libraryFor, NOW, PREFIX, inShell, type Role } from './demo/fixtures'
import { kpisCanOf } from './model'
import { LibraryView, type LibraryModel } from './view/LibraryView'

/**
 * SCR-249 — Home › Insights › KPI library (design home.kpis `catalogue`; ANA-012), with made-up data only: the standard KPIs
 * with their standard words for the owner (values in every unit, OTIF with a draft waiting, a version naming other facts,
 * two KPIs not installed, a withdrawn one without a calculation), for a planner (money values held by their rights, lists
 * outside the role said, the install left to the owner), a search, an area chip, nothing matching, rows selected, the
 * install asked, done and refused, a stale list, loading, a failed read and no permission. A KPI opens on SCR-470.
 */

interface Case {
  readonly role: Role
  readonly model: LibraryModel
}

const library = (role: Role, change: Partial<LibraryModel> = {}): Case => ({
  role,
  model: {
    can: kpisCanOf(role === 'owner' ? ['home.kpis.view', 'home.kpis.manage', 'roles.view'] : role === 'planner' ? ['home.kpis.view'] : ['home.view']),
    prefix: PREFIX,
    address: { q: '', area: null },
    library: { value: libraryFor(role === 'none' ? 'owner' : role), problem: null },
    selected: [],
    now: NOW,
    ...change,
  },
})

function LibraryDesign({ model }: { model: Case }) {
  return inShell('/home/kpis', createElement(LibraryView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-249',
  title: 'KPI library (Home › Insights)',
  view: LibraryDesign,
  cases: [
    {
      id: 'owner',
      label: 'Owner — every KPI',
      model: library('owner'),
      note: 'Twenty KPIs with name and plain definition (the version in force, in the reader’s language), area, unit, owner role, value now (its own period, as of the last rebuild), version and uses. OTIF has a draft waiting; Order margin names other facts than its calculation; Leather yield and Quote to order are not installed (Install 2 standard KPIs); Quotes sent was withdrawn and has no calculation. A row opens the KPI.',
    },
    {
      id: 'planner',
      label: 'Planner — values held by their rights',
      model: library('planner'),
      note: 'Margin, cost and price values say "Needs … rights" or "Reads lists outside your role" — the KPIs stay listed (design: margin KPIs list for everyone). No install button: one line says the owner installs them.',
    },
    { id: 'search', label: 'Search "margin"', model: library('owner', { address: { q: 'margin', area: null } }), note: 'The search reads the words the person sees: name, definition and formula, Italian or English.' },
    { id: 'area', label: 'Area chip: Production', model: library('owner', { address: { q: '', area: 'production' } }) },
    { id: 'no-match', label: 'Nothing matches', model: library('owner', { address: { q: 'zzz', area: null } }), note: 'Never an empty library: the standard KPIs come with the product; only a search can match nothing.' },
    { id: 'selected', label: 'Two rows selected', model: library('owner', { selected: ['delivery.otif', 'production.scrap_rate'] }), note: 'The toolbar swaps to "Export 2 definitions" (a CSV in the person’s language, written in the browser).' },
    {
      id: 'install-ask',
      label: 'Owner — install the standard KPIs',
      model: library('owner', { install: { asking: true, busy: false, installed: null, problem: null } }),
      note: 'The confirmation names the two KPIs that will be written as version 1 in force.',
    },
    {
      id: 'installed',
      label: 'Installed',
      model: library('owner', { install: { asking: false, busy: false, installed: ['production.leather_yield', 'sales.quote_to_order_days'], problem: null } }),
    },
    { id: 'install-refused', label: 'Install refused', model: library('owner', { install: { asking: false, busy: false, installed: null, problem: 'refusal.forbidden' } }) },
    { id: 'stale', label: 'Read again failed (list kept)', model: library('owner', { library: { value: libraryFor('owner'), problem: 'error.offline' } }), note: 'The last list stays; a banner says it may be out of date.' },
    { id: 'loading', label: 'Loading', model: library('owner', { library: { value: null, problem: null } }) },
    { id: 'error', label: 'The library could not be read', model: library('owner', { library: { value: null, problem: 'error.offline' } }) },
    { id: 'no-permission', label: 'No permission', model: library('none'), note: 'Without home.kpis.view the page says so and asks the API nothing; the navigation row is absent.' },
  ],
})
