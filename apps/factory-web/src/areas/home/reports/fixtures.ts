import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { OWNER_LIBRARY, PLANNER_LIBRARY, PREFIX, inShell, type Role } from './demo/fixtures'
import { reportsCanOf } from './model'
import { LibraryView, type LibraryModel } from './view/LibraryView'

/**
 * SCR-104 — Home › Insights › Reports, the library (design home.reports `library`; ANA-029, ANA-034), with made-up data
 * only: the standard pack for the owner (every report ready, the daily production report e-mailed to them), for a planner
 * (price, cost and margin reports held with their grain, reports of lists outside the role hidden until asked), a
 * search, an area chip, nothing matching, loading, a failed read and no permission. A report opens on SCR-104-report.
 */

interface Case {
  readonly role: Role
  readonly model: LibraryModel
}

const library = (role: Role, change: Partial<LibraryModel> = {}): Case => ({
  role,
  model: {
    can: reportsCanOf(role === 'none' ? ['home.view'] : ['home.reports.view']),
    prefix: PREFIX,
    address: { q: '', area: null, outside: false },
    library: { value: role === 'planner' ? PLANNER_LIBRARY : OWNER_LIBRARY, problem: null },
    ...change,
  },
})

function LibraryDesign({ model }: { model: Case }) {
  return inShell('/home/reports', createElement(LibraryView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-104',
  title: 'Reports: the library (Home › Insights)',
  view: LibraryDesign,
  cases: [
    { id: 'owner', label: 'Owner — the standard pack', model: library('owner'), note: 'Fourteen reports said as questions, grouped by area (column and chips); last run by me (the server’s run log: two reports run, the rest "Not yet"); the daily production report e-mailed to me; CSV · PDF. A row opens the report.' },
    {
      id: 'planner',
      label: 'Planner — reports held by rights',
      model: library('planner'),
      note: 'Stock value says "Needs cost rights" and stays listed; three reports read lists outside the role and are hidden until "Outside my role (3)" is pressed. The planner ran none yet: "Not yet" on every row.',
    },
    { id: 'planner-outside', label: 'Planner — reports outside the role shown', model: library('planner', { address: { q: '', area: null, outside: true } }), note: 'Listed with "Reads a list outside your role": never run.' },
    { id: 'search', label: 'Search "late"', model: library('owner', { address: { q: 'late', area: null, outside: false } }), note: 'The search reads the words the person sees (title and question, Italian or English).' },
    { id: 'area', label: 'Area chip: Production', model: library('owner', { address: { q: '', area: 'production', outside: false } }) },
    { id: 'no-match', label: 'Nothing matches', model: library('owner', { address: { q: 'zzz', area: null, outside: false } }), note: 'Never an empty library: the pack ships with the product; only a search can match nothing.' },
    { id: 'loading', label: 'Loading', model: library('owner', { library: { value: null, problem: null } }) },
    { id: 'error', label: 'The library could not be read', model: library('owner', { library: { value: null, problem: 'error.offline' } }) },
    { id: 'no-permission', label: 'No permission', model: library('none'), note: 'Without home.reports.view the page says so and asks the API nothing; the navigation row is absent.' },
  ],
})
