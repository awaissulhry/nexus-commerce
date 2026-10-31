import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES } from '../design-data'
import { scopeOf } from './scope-model'
import { ScopeSiteChip } from './view/ScopeSiteChip'
import type { OfficeScope } from './scope-model'

/**
 * SCR-002-scope — the top bar's site on a page (B-W2b-05, PLT-008: "'All sites' adds a Site column and chip on lists";
 * "Every W2b page says 'Site from the top bar'"): the chip a list draws in its filter row. Made-up company and sites.
 */

const company = DEMO_COMPANIES[0]
const THREE_SITES = [...DEMO_SITES, { id: '0190f0e2-2222-7000-8000-000000000003', name: 'Laboratorio Demo Est' }]

export const designScreen = defineDesignScreen<OfficeScope>({
  screen: 'SCR-002-scope',
  title: 'Company & site: the site on a page',
  view: ScopeSiteChip,
  part: true,
  cases: [
    { id: 'one-site-chosen', label: 'One site chosen in the top bar', model: scopeOf({ company, sites: DEMO_SITES, everySite: true, chosen: DEMO_SITES[0].id }), note: 'The list reads that site only; no Site column.' },
    { id: 'all-sites', label: 'All sites', model: scopeOf({ company, sites: THREE_SITES, everySite: true, chosen: null }), note: 'The list reads every site and adds a Site column.' },
    { id: 'all-my-sites', label: 'All my sites (a role limited to some sites)', model: scopeOf({ company, sites: DEMO_SITES, everySite: false, chosen: null }), note: 'The person reaches 2 of the company\'s sites: "All" means all of theirs (the API checks every read).' },
    { id: 'one-site-only', label: 'A company with one site', model: scopeOf({ company, sites: DEMO_SITES.slice(0, 1), everySite: true, chosen: null }), note: 'Nothing to say: the page works in that site (no chip, no Site column).' },
  ],
})
