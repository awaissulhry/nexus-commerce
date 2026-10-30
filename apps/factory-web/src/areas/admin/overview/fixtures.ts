import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_USER } from '../../../shell/design-data'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { COMPANIES, DEVICES, inShell, NOW, PREFIX, PRINTERS, ROLES, USERS } from '../shared/fixtures'
import type { Attention } from '../security/api'
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
  accounts: ok([{ provider: 'SDI', companyId: COMPANIES[0]!.id, mode: 'FAKE', status: 'ACTIVE' }]),
  imports: ok([{ importerKey: 'inventory.opening', status: 'PLANNED' }]),
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
  accounts: ok([{ provider: 'SDI', companyId: COMPANIES[0]!.id, mode: 'LIVE', status: 'ACTIVE' }]),
  imports: ok([{ importerKey: 'inventory.opening', status: 'APPLIED' }]),
})

// B-W2a-36: Needs attention, made-up facts (a connection, a domain, a tablet, the drill, two people without two-factor).
const ATTENTION: Attention = {
  asOf: NOW,
  items: [
    { kind: 'integrationFailing', subject: 'SDI Officina Demo', state: null, since: '2026-10-29T08:12:00.000Z', count: null, days: null, href: '/admin/connections/0190f0e2-6060-7000-8000-000000000001', severity: 'critical' },
    { kind: 'mailDomain', subject: 'officina-demo.example.com', state: 'PENDING', since: null, count: null, days: null, href: '/admin/connections#mail', severity: 'warning' },
    { kind: 'tabletUnseen', subject: 'Taglio 2', state: null, since: '2026-10-26T15:40:00.000Z', count: null, days: 3, href: '/admin/devices/0190f0e2-6161-7000-8000-000000000002', severity: 'warning' },
    { kind: 'drill', subject: null, state: 'due_soon', since: '2026-08-09', count: null, days: 8, href: '/admin/security#backups', severity: 'warning' },
    { kind: 'twoFactorMissing', subject: null, state: null, since: null, count: 2, days: null, href: '/admin/security#sign-in', severity: 'warning' },
  ],
  unread: [],
}
const ok2 = <T,>(value: T) => ({ state: 'ok' as const, value })

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
      note: 'Each state is read from the API: Esempio cannot invoice yet and has no SDI connection, the mail domain waits for DNS, one tablet waits to be enrolled, an opening-stock import waits to be applied.',
    },
    { id: 'checking', label: 'Checking', model: model({ companies: checking, identities: checking, series: checking, users: checking, roles: checking, devices: checking, printers: checking, privacy: checking, accounts: checking, imports: checking }, { checkedAt: null }) },
    {
      id: 'first-day',
      label: 'First day: nothing set up',
      model: model({ companies: ok([]), identities: ok([]), series: ok([]), users: ok([USERS[0]!]), devices: ok([]), printers: ok([]), privacy: ok([]), accounts: ok([]), imports: ok([]) }),
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
    { id: 'all-done', label: 'Every step done', model: allReady, note: 'Folded away; "Show set-up" brings it back.' },
    { id: 'attention', label: 'Needs attention: what went wrong since', model: { ...allReady, attention: ok2(ATTENTION) }, note: 'W2a (B-W2a-36): each row opens the page that fixes it; Enter on a row too.' },
    { id: 'attention-empty', label: 'Needs attention: nothing', model: { ...allReady, attention: ok2({ ...ATTENTION, items: [] }) } },
    { id: 'attention-partial', label: 'Needs attention: some facts not yours to read', model: { ...allReady, attention: ok2({ ...ATTENTION, items: ATTENTION.items.slice(3), unread: ['integrationFailing', 'mailDomain', 'tabletUnseen'] }) } },
    { id: 'attention-loading', label: 'Needs attention: loading', model: { ...allReady, attention: { state: 'loading' } } },
    { id: 'attention-error', label: 'Needs attention: could not be read', model: { ...allReady, attention: { state: 'failed', problem: 'problem.unavailable' } }, note: 'The checklist keeps working.' },
  ],
})
