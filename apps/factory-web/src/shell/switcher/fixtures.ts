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
    },
  ],
})
