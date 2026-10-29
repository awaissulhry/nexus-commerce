import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { OWNER_PERMISSIONS } from '../../../shell/design-data'
import { at, COMPANIES, DEVICES, inShell, NOW, PREFIX, ROLES, SITES, USERS } from '../shared/fixtures'
import { failed, loaded, loading, type Loaded } from '../shared/model'
import type { AuditEntry } from './api'
import { NO_FILTERS, type AuditFilters, type AuditViewModel } from './model'
import { AuditView } from './view/AuditView'

/**
 * SCR-018 Audit log with made-up entries (Demo companies and sites, example.com people, invented codes): the Story and
 * the Table, saved views, filters, a floor entry (a worker on a tablet, never named), money hidden from an
 * administrator, an entry open with the rows of its request, and every state of the page.
 */

const uid = (n: number) => `0190f0e2-5555-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = COMPANIES[0]!
const OTHER = COMPANIES[1]!
const SITE = SITES[0]!

let next = 0
function entry(minutesAgo: number, action: string, over: Partial<AuditEntry> = {}): AuditEntry {
  next += 1
  const time = new Date(new Date(NOW).getTime() - minutesAgo * 60_000).toISOString()
  return {
    id: uid(next),
    at: time,
    audience: 'OFFICE',
    actorId: USERS[0]!.id,
    deviceId: null,
    deviceTime: null,
    companyId: COMPANY.id,
    siteId: null,
    partyId: null,
    action,
    recordType: 'Company',
    recordId: COMPANY.id,
    before: null,
    after: null,
    reason: null,
    requestId: `req-${String(next).padStart(4, '0')}`,
    idempotencyKey: null,
    actorName: USERS[0]!.displayName,
    deviceName: null,
    ...over,
  }
}

const SERIES_ID = '0190f0e2-6666-7000-8000-000000000001'
const ENTRIES: AuditEntry[] = [
  entry(2, 'numbering.closeSeries', {
    recordType: 'NumberSeries',
    recordId: SERIES_ID,
    before: { kind: 'DDT', code: 'MAIN', scopeKey: '2026', pattern: 'DDT-{YYYY}-{N:5}', startValue: 1, nextValue: 42, status: 'ACTIVE' },
    after: { kind: 'DDT', code: 'MAIN', scopeKey: '2026', pattern: 'DDT-{YYYY}-{N:5}', startValue: 1, nextValue: 42, status: 'CLOSED' },
    reason: 'Moved to the new series B for the second site',
    requestId: 'req-close-01',
    idempotencyKey: 'demo-key-0001',
  }),
  entry(3, 'numbering.createSeries', {
    recordType: 'NumberSeries',
    recordId: '0190f0e2-6666-7000-8000-000000000002',
    after: { kind: 'DDT', code: 'B', scopeKey: '2026', pattern: 'DDT-B-{YYYY}-{N:5}', startValue: 1, nextValue: 1 },
    requestId: 'req-close-01',
  }),
  entry(14, 'production.reportScan', {
    audience: 'FLOOR',
    actorId: '0190f0e2-3636-7000-8000-000000000099',
    actorName: null,
    deviceId: DEVICES[0]!.id,
    deviceName: DEVICES[0]!.name,
    deviceTime: new Date(new Date(NOW).getTime() - 16 * 60_000 - 2_000).toISOString(),
    siteId: SITE.id,
    recordType: 'Bundle',
    recordId: '0190f0e2-7777-7000-8000-000000000001',
    after: { number: 'BN-2026-00318', operation: 'Cucitura tasca', quantity: 12 },
  }),
  entry(31, 'roles.assign', {
    recordType: 'User',
    recordId: USERS[2]!.id,
    companyId: null,
    after: { roleKey: 'planner', allCompanies: false, companyIds: [COMPANY.id], validTo: null, email: USERS[2]!.email },
    reason: 'Covers planning while Bea is away',
  }),
  entry(47, 'auth.signIn', { recordType: 'User', recordId: USERS[1]!.id, companyId: null, actorId: USERS[1]!.id, actorName: USERS[1]!.displayName, after: { email: USERS[1]!.email } }),
  entry(65, 'org.editCompany', {
    companyId: OTHER.id,
    recordId: OTHER.id,
    before: { legalName: OTHER.legalName, pec: null, sdiReceiverCode: null },
    after: { legalName: OTHER.legalName, pec: 'esempio@pec.example.com', sdiReceiverCode: 'XYZ9876' },
  }),
  entry(80, 'integration.pauseAccount', {
    recordType: 'IntegrationAccount',
    recordId: '0190f0e2-8888-7000-8000-000000000001',
    before: { status: 'ACTIVE', mode: 'FAKE' },
    after: { status: 'PAUSED', mode: 'FAKE' },
    reason: 'Provider maintenance tonight',
  }),
  entry(130, 'quotes.update', {
    recordType: 'Quote',
    recordId: '0190f0e2-9999-7000-8000-000000000001',
    actorId: USERS[2]!.id,
    actorName: USERS[2]!.displayName,
    before: { number: 'Q-2026-0142', validUntil: '2026-11-15' },
    after: { number: 'Q-2026-0142', validUntil: '2026-11-30' },
  }),
  entry(60 * 20, 'devices.revoke', { recordType: 'Device', recordId: DEVICES[2]!.id, siteId: SITE.id, before: { name: DEVICES[2]!.name, status: 'ACTIVE' }, after: { name: DEVICES[2]!.name, status: 'REVOKED' }, reason: 'Tablet lost on the floor' }),
  entry(60 * 21, 'imports.apply', { audience: 'SYSTEM', actorName: null, recordType: 'ImportJob', recordId: '0190f0e2-aaaa-7000-8000-000000000001', after: { status: 'APPLIED', applied: 134, skipped: 2, fileName: 'materiali-demo.xlsx' } }),
  entry(60 * 26, 'roles.edit', {
    recordType: 'Role',
    recordId: ROLES[5]!.id,
    companyId: null,
    before: { name: ROLES[5]!.name, permissions: ['quotes.view', 'orders.view'] },
    after: { name: ROLES[5]!.name, permissions: ['quotes.view', 'orders.view', 'numbering.view'] },
    reason: 'Quotes need the series',
  }),
]

/** The same entries as an administrator without money sight would read them: the cost left out by the API. */
const MONEY_ENTRY = entry(5, 'product.materials.setStandardCost', {
  recordType: 'Material',
  recordId: '0190f0e2-bbbb-7000-8000-000000000001',
  before: { code: 'PEL-NAP-01', unit: 'M2' },
  after: { code: 'PEL-NAP-01', unit: 'M2' },
  reason: 'New price list from the tannery',
})

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const people = USERS.map((user) => ({ id: user.id, name: user.displayName }))

const model = (over: Partial<AuditViewModel> = {}, filters: Partial<AuditFilters> = {}): AuditViewModel => ({
  prefix: PREFIX,
  mode: 'story',
  filters: { ...NO_FILTERS, ...filters },
  entries: loaded(ENTRIES),
  nextBefore: ENTRIES[ENTRIES.length - 1]!.id,
  older: { loading: false, problem: null },
  counts: { roles: 4, access: 37, deletes: 3, settings: 12 },
  asOf: NOW,
  people,
  companies,
  canRead: true,
  hiddenGrains: [],
  find: '',
  open: null,
  ...over,
})

const open = (index: number, siblings: Loaded<AuditEntry> = loaded(ENTRIES.filter((item) => item.requestId === ENTRIES[index]!.requestId))): Pick<AuditViewModel, 'open'> => ({
  open: { id: ENTRIES[index]!.id, entry: ENTRIES[index]!, siblings },
})

const ADMIN_PERMISSIONS = OWNER_PERMISSIONS.filter((permission) => permission !== 'audit.read')

interface Case {
  model: AuditViewModel
  /** The navigation of a person without the log (the no-access case). */
  permissions?: readonly string[]
}

function AuditDesign({ model: item }: { model: Case }) {
  return inShell('/admin/audit', createElement(AuditView, { model: item.model }), item.permissions)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-018',
  title: 'Audit log',
  view: AuditDesign,
  cases: [
    { id: 'story', label: 'Story: the log as sentences', model: { model: model() }, note: 'Newest first, grouped by day; a floor entry says "a worker on <tablet>" with the tablet\'s own time; reasons after the time.' },
    { id: 'table', label: 'Table: one row per write', model: { model: model({ mode: 'table' }) }, note: 'An action this page has no words for says "changed" with its code.' },
    { id: 'tile-settings', label: 'Saved view: settings changes', model: { model: model({ entries: loaded(ENTRIES.filter((item) => /^(numbering|org|integration|devices)\./.test(item.action))) }, { view: 'settings' }) } },
    {
      id: 'filtered',
      label: 'Filtered: one company, last 7 days, table',
      model: { model: model({ mode: 'table', entries: loaded(ENTRIES.filter((item) => item.companyId === COMPANY.id).slice(0, 4)), nextBefore: null }, { companyId: COMPANY.id, period: '7d', area: 'numbering' }) },
    },
    { id: 'floor', label: 'Floor entries only', model: { model: model({ entries: loaded(ENTRIES.filter((item) => item.audience === 'FLOOR')), nextBefore: null }, { audience: 'FLOOR' }) } },
    {
      id: 'record-history',
      label: "A record's history",
      model: { model: model({ entries: loaded(ENTRIES.filter((item) => item.recordType === 'NumberSeries')), nextBefore: null, recordWords: 'MAIN' }, { recordType: 'NumberSeries', recordId: SERIES_ID }) },
    },
    {
      id: 'money-hidden',
      label: 'An administrator without money sight',
      model: { model: model({ entries: loaded([MONEY_ENTRY, ...ENTRIES.slice(0, 4)]), hiddenGrains: ['price', 'cost', 'margin', 'wages'], open: { id: MONEY_ENTRY.id, entry: MONEY_ENTRY, siblings: loaded([MONEY_ENTRY]) } }) },
      note: 'The API leaves out the money the reader may not see; the page says which grains are left out.',
    },
    { id: 'entry', label: 'An entry: before → after, context, same request', model: { model: model(open(0)) }, note: 'J / K walk the rows shown; "Open record" goes to the series; "Record\'s history" filters the log.' },
    { id: 'entry-floor', label: 'An entry from a floor tablet', model: { model: model(open(2)) }, note: 'Server time and the tablet\'s time; no worker name.' },
    { id: 'entry-no-page', label: 'An entry whose record has no page yet', model: { model: model({ mode: 'table', ...open(7, loaded([ENTRIES[7]!])) }) }, note: '"Open record" is held with its reason.' },
    { id: 'entry-reading', label: 'An entry while its request is read', model: { model: model(open(3, loading())) } },
    { id: 'entry-not-shown', label: 'An address naming an entry not read', model: { model: model({ open: { id: uid(999), entry: null, siblings: loading() } }) } },
    { id: 'older-loading', label: 'Reading older entries', model: { model: model({ older: { loading: true, problem: null } }) } },
    { id: 'older-failed', label: 'Older entries could not be read', model: { model: model({ older: { loading: false, problem: 'problem.unavailable' } }) } },
    { id: 'end', label: 'The first entry reached', model: { model: model({ nextBefore: null }) } },
    { id: 'no-people', label: 'Without the right to see people (no Who filter)', model: { model: model({ people: null, companies: [] }) } },
    { id: 'find-none', label: 'Find on the page: no match', model: { model: model({ find: 'fattura 2025' }) } },
    { id: 'empty-filtered', label: 'No change matches the filters', model: { model: model({ entries: loaded([]), nextBefore: null }, { audience: 'LINK', period: '24h' }) } },
    { id: 'empty', label: 'Nothing written yet', model: { model: model({ entries: loaded([]), nextBefore: null, counts: { roles: 0, access: 0, deletes: 0, settings: 0 } }) } },
    { id: 'loading', label: 'Loading', model: { model: model({ entries: loading(), counts: null, asOf: null, nextBefore: null }) } },
    { id: 'error', label: 'The API did not answer', model: { model: model({ entries: failed('problem.unavailable'), counts: null, asOf: null, nextBefore: null }) } },
    { id: 'no-access', label: 'Without the right to read the log', model: { model: model({ canRead: false, entries: loading(), counts: null }), permissions: ADMIN_PERMISSIONS } },
    { id: 'when-earlier', label: 'Earlier days in the Story', model: { model: model({ entries: loaded(ENTRIES.slice(6)), nextBefore: null }) } },
  ],
})

/** Made-up entries for the tests. */
export const AUDIT_ENTRIES = ENTRIES
export const AUDIT_NOW = NOW
export const AUDIT_AT = at
