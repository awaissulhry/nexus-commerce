import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_USER } from '../../../shell/design-data'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { COMPANIES, DEVICES, inShell, NOW, PREFIX, PRINTERS, ROLES, USERS } from '../shared/fixtures'
import { setupSteps, type OverviewFacts, type OverviewViewModel, type Read } from './model'
import { AdminOverviewView } from './view/AdminOverviewView'

/** SCR-165 (W0 part: the set-up checklist) with made-up facts: each case is one set of reads the checklist met. */

const ok = <T,>(value: T): Read<T> => ({ state: 'ok', value })
const facts: OverviewFacts = {
  me: DEMO_USER.id,
  companies: ok(COMPANIES),
  identities: ok([{ domain: 'officina-demo.example.com', ready: false, status: 'ACTIVE' }]),
  series: ok([{ companyId: COMPANIES[0]!.id, kind: 'INVOICE', status: 'ACTIVE' }]),
  users: ok(USERS),
  roles: ok(ROLES),
  devices: ok(DEVICES),
  printers: ok(PRINTERS),
  privacy: ok([{ company: { id: COMPANIES[0]!.id }, duties: [{ done: true }, { done: false }, { done: false }] }]),
}
const model = (over: Partial<OverviewFacts>, extra: Partial<OverviewViewModel> = {}): OverviewViewModel => ({
  prefix: PREFIX,
  steps: setupSteps({ ...facts, ...over }, PREFIX, OFFICE_PAGES),
  checkedAt: NOW,
  showAll: false,
  ...extra,
})
const checking: Read<never> = { state: 'checking' }
const allReady = model({
  companies: ok([COMPANIES[0]!].map((company) => ({ ...company, sites: company.sites }))),
  identities: ok([{ domain: 'officina-demo.example.com', ready: true, status: 'ACTIVE' }]),
  roles: ok(ROLES.map((role) => ({ ...role, outdated: false, templateAdds: { permissionsAdded: [], grainsAdded: [] } }))),
  privacy: ok([{ company: { id: COMPANIES[0]!.id }, duties: [{ done: true }] }]),
})

function OverviewDesign({ model: viewModel }: { model: OverviewViewModel }) {
  return inShell('/admin', createElement(AdminOverviewView, { model: viewModel }))
}

export const designScreen = defineDesignScreen<OverviewViewModel>({
  screen: 'SCR-165',
  title: 'All settings: get the factory ready (W0 checklist)',
  view: OverviewDesign,
  cases: [
    {
      id: 'normal',
      label: 'Set-up under way',
      model: model({}),
      note: 'Each state is read from the API: Esempio cannot invoice yet, the mail domain waits for DNS, one tablet waits to be enrolled. SDI and opening stock are not checked yet (their pages come later).',
    },
    { id: 'checking', label: 'Checking', model: model({ companies: checking, identities: checking, series: checking, users: checking, roles: checking, devices: checking, printers: checking, privacy: checking }, { checkedAt: null }) },
    {
      id: 'first-day',
      label: 'First day: nothing set up',
      model: model({ companies: ok([]), identities: ok([]), series: ok([]), users: ok([USERS[0]!]), devices: ok([]), printers: ok([]), privacy: ok([]) }),
    },
    {
      id: 'some-failed',
      label: 'Two checks failed',
      model: model({ devices: { state: 'failed', problem: 'problem.unavailable' }, users: { state: 'failed', problem: 'problem.internal' } }),
      note: 'A failed check says so with Try again; the other steps keep their state.',
    },
    {
      id: 'no-rights',
      label: 'An administrator without mail or privacy rights',
      model: model({ identities: { state: 'no-right', need: 'email.send' }, privacy: { state: 'no-right', need: 'privacy.view' } }),
      note: 'A read the person may not make is "Not checked" with the right it needs, never a guess.',
    },
    { id: 'all-done', label: 'Every step done (as it will look once SDI and stock are checked)', model: { ...allReady, steps: allReady.steps.map((step) => (step.state === 'unknown' ? { ...step, state: 'done' as const } : step)) }, note: 'Folded away; "Show set-up" brings it back.' },
  ],
})
