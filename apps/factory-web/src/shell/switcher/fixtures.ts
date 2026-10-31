import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES, MANY_COMPANIES } from '../design-data'
import { CompanySwitcherView, type CompanySwitcherViewModel } from './view/CompanySwitcherView'

export const designScreen = defineDesignScreen<CompanySwitcherViewModel>({
  screen: 'SCR-002',
  title: 'Company & site switcher',
  view: CompanySwitcherView,
  part: true,
  cases: [
    {
      id: 'one-company',
      label: 'One company, no sites',
      model: { companies: DEMO_COMPANIES.slice(0, 1), company: 'DEMO', sites: [], site: null, path: '/admin/users' },
      note: 'W0 today: the API lists the current company only.',
    },
    {
      id: 'normal',
      label: 'Two companies, two sites',
      model: { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES, site: DEMO_SITES[0].id, path: '/admin/users' },
      note: 'Open it: companies are links (same page, other company), sites are on/off.',
    },
    {
      id: 'open',
      label: 'Opened',
      model: { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES, site: DEMO_SITES[0].id, path: '/admin/users', open: true },
      note: 'The current company is marked; the current site is ticked. ↑ ↓ move, Enter chooses, Esc closes.',
    },
    {
      id: 'all-sites',
      label: 'All sites',
      model: { companies: DEMO_COMPANIES, company: 'ESEMPIO', sites: DEMO_SITES, site: null, path: '/home/mail-to-sort' },
    },
    {
      id: 'many',
      label: 'Many companies',
      model: { companies: MANY_COMPANIES, company: 'GAMMA', sites: DEMO_SITES, site: null, path: '/admin', open: true },
      note: 'B-W2b-05: more than 7 companies — the current one and "Find a company…", which opens the search.',
    },
    {
      id: 'many-search',
      label: 'Many companies: Find a company',
      model: { companies: MANY_COMPANIES, company: 'GAMMA', sites: DEMO_SITES, site: null, path: '/sales/orders', finderQuery: '' },
      note: 'Type a name or a code; ↓ to the companies, Enter opens the same page there, ⌘Enter in a new tab, Esc closes.',
    },
    {
      id: 'many-search-typed',
      label: 'Many companies: searched',
      model: { companies: MANY_COMPANIES, company: 'GAMMA', sites: DEMO_SITES, site: null, path: '/sales/orders', finderQuery: 'del' },
    },
    {
      id: 'many-search-none',
      label: 'Many companies: nothing matches',
      model: { companies: MANY_COMPANIES, company: 'GAMMA', sites: DEMO_SITES, site: null, path: '/sales/orders', finderQuery: 'zzz' },
    },
    {
      id: 'limited-sites',
      label: 'A role limited to some sites',
      model: { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES, site: null, path: '/warehouse/stock', limited: true, open: true },
      note: 'B-W2b-05: only the sites the person\'s roles reach, and "All my sites".',
    },
    {
      id: 'one-site',
      label: 'One site only',
      model: { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES.slice(0, 1), site: null, path: '/warehouse/stock', limited: true, open: true },
      note: 'B-W2b-05: the site is named, there is nothing to choose.',
    },
  ],
})
