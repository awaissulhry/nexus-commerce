import { defineDesignScreen } from '../../lib/design/design-screen'
import { permissionCheck } from '../../lib/session/session'
import { DEMO_COMPANIES, DEMO_LABELS, DEMO_SITES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS, SALES_PERMISSIONS } from '../design-data'
import { officeNavFor } from '../nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from './view/OfficeShellView'

const switcher = { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES, site: null, path: '/admin/users' }
const owner: OfficeShellViewModel = {
  nav: officeNavFor(permissionCheck(OWNER_PERMISSIONS)),
  path: '/admin/users',
  switcher,
  user: DEMO_USER,
  tenantTag: DEMO_TAG,
  banners: [],
}

export const designScreen = defineDesignScreen<OfficeShellViewModel>({
  screen: 'SCR-003',
  title: 'Office shell',
  view: OfficeShellView,
  holdsPage: true,
  cases: [
    {
      id: 'owner',
      label: 'Owner on Admin › Users (area pages closed)',
      model: owner,
      note: 'The Admin pages are a button at the start of the band (no column). Rail: hover or Tab. Search: ⌘K. Phone: bottom bar.',
    },
    {
      id: 'area-open',
      label: 'Area pages open',
      model: { ...owner, areaNavOpen: true },
      note: "The button opened Admin's pages over the page, under the top bar and beside the rail; Users is the current page. Esc closes it and the focus goes back to the button.",
    },
    {
      id: 'record',
      label: 'A record under a page',
      model: { ...owner, path: '/admin/users/0190f0e2-3333-7000-8000-000000000002', switcher: { ...switcher, path: '/admin/users/0190f0e2-3333-7000-8000-000000000002' } },
      note: 'A deep link to a record (PLT-161): Users stays the current page; the record page draws its own header below.',
    },
    {
      id: 'test-mode',
      label: 'TEST MODE banner',
      model: { ...owner, banners: [{ id: 'test-mode', kind: 'test-mode', connections: ['Email (fake)', 'Files (fake)', 'Printing (fake)'] }] },
      note: 'Shown while any connection is fake or in a sandbox.',
    },
    {
      id: 'sales',
      label: 'Sales person (few areas)',
      model: {
        ...owner,
        nav: officeNavFor(permissionCheck(SALES_PERMISSIONS)),
        path: '/home/mail-to-sort',
        switcher: { ...switcher, path: '/home/mail-to-sort' },
      },
      note: 'Only what the role may open: Home › Mail to sort. No Admin.',
    },
    {
      id: 'no-areas',
      label: 'No area yet',
      model: { ...owner, nav: officeNavFor(permissionCheck([])), path: '/me', switcher: { ...switcher, companies: DEMO_COMPANIES.slice(0, 1), sites: [], path: '/me' } },
      note: 'A person with no role: no rail rows, no bottom bar; the profile page still opens.',
    },
    {
      id: 'palette',
      label: 'Search open with a scanned label',
      model: { ...owner, paletteOpen: true, paletteQuery: DEMO_LABELS.hide },
    },
  ],
})
