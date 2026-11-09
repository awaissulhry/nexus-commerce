import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { ALL_RIGHTS, CUSTOMER_PEOPLE, customerAccess, DEMO_NOW, READ_ONLY, SUPPLIER_PEOPLE, supplierAccess } from '../../../sales/customers/portal/demo'
import { COMPANIES, inShell, NOW, PREFIX, ROLES, SITES, USERS, WORKERS } from '../../shared/fixtures'
import type { User } from '../../shared/api'
import { failed, loaded, loading, STEP_UP_CLOSED } from '../../shared/model'
import type { UsersViewModel } from '../model'
import { UsersView } from '../view/UsersView'
import type { Organisations, PartnerPerson, PortalAccess } from './api'
import type { PartnersAudienceModel } from './view/PartnersPeople'

/**
 * SCR-010-partners — Admin › Users, audience Partners (B-W2b-180; design admin.users sec:audience "Partners (W2b)", sec:tiles
 * "Access ends soon (W2b)", pop:invite "until (optional, W2b)"). Made-up partner people (example.com / .example) of two
 * made-up organisations; the office invite with its new "until".
 */

const CAN = { viewUsers: true, invite: true, assign: true, viewWorkers: true, manageWorkers: true, workerRoles: true, suspend: true, reactivate: true, deactivate: true }
const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const sites = SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId }))

/** A partner person as GET /auth/users lists them (audience PARTNER, their organisation, their end of access). */
function asUser(person: PartnerPerson, access: PortalAccess): User {
  return {
    id: person.id,
    email: person.email,
    displayName: person.displayName,
    locale: person.displayName.startsWith('Sara') ? 'en' : 'it',
    status: person.status,
    roles: person.roleKey
      ? [{ assignmentId: `${person.id.slice(0, -2)}99`, roleId: `${person.id.slice(0, -2)}98`, roleKey: person.roleKey, roleName: person.roleName ?? '', allCompanies: true, companyIds: [], siteIds: [], partyIds: [access.party.id], validTo: null }]
      : [],
    mfaEnabled: false,
    lastSignInAt: person.lastSignInAt,
    invitationExpiresAt: person.invitation?.expiresAt ?? null,
    version: person.version,
    audience: 'PARTNER',
    partyId: access.party.id,
    partnerKind: person.kind,
    accessUntil: person.accessUntil,
  }
}

export const PARTNER_USERS: User[] = [...CUSTOMER_PEOPLE.map((person) => asUser(person, customerAccess())), ...SUPPLIER_PEOPLE.map((person) => asUser(person, supplierAccess()))]

const organisation = (access: PortalAccess, ending: number) => ({
  party: access.party,
  kinds: access.kinds,
  portalOn: access.settings.portalOn,
  progressShared: access.settings.progressShared,
  maxUsers: access.settings.maxUsers,
  people: {
    active: access.people.filter((person) => person.status === 'ACTIVE').length,
    invited: access.people.filter((person) => person.status === 'INVITED').length,
    suspended: access.people.filter((person) => person.status === 'SUSPENDED').length,
  },
  accessEndingSoon: ending,
})
const ORGS = [organisation(customerAccess(), 1), organisation(supplierAccess(), 0)]
export const ORGANISATIONS: Organisations = {
  organisations: ORGS,
  counts: { organisations: ORGS.length, people: ORGS.reduce((sum, entry) => sum + entry.people.active + entry.people.invited + entry.people.suspended, 0), accessEndingSoon: 1 },
}

const partners = (over: Partial<PartnersAudienceModel> = {}): PartnersAudienceModel => ({
  prefix: PREFIX,
  users: loaded(PARTNER_USERS),
  organisations: { value: ORGANISATIONS, problem: null },
  tile: null,
  query: '',
  pages: 1,
  now: DEMO_NOW,
  can: ALL_RIGHTS,
  ...over,
})

const page = (over: Partial<UsersViewModel> = {}, partnersOver: Partial<PartnersAudienceModel> = {}): UsersViewModel => ({
  prefix: PREFIX,
  audience: 'partners',
  users: loaded(USERS),
  workers: loaded(WORKERS),
  roles: ROLES,
  companies,
  sites,
  tile: null,
  query: '',
  pages: 1,
  asOf: NOW,
  me: DEMO_USER.id,
  can: CAN,
  stepUp: STEP_UP_CLOSED,
  partners: partners(partnersOver),
  ...over,
})

function UsersDesign({ model }: { model: UsersViewModel }) {
  return inShell('/admin/users', createElement(UsersView, { model }))
}

const marco = PARTNER_USERS[1]!
const elena = PARTNER_USERS[4]!

export const designScreen = defineDesignScreen<UsersViewModel>({
  screen: 'SCR-010-partners',
  title: 'Users: partners and the invite’s until',
  view: UsersDesign,
  cases: [
    { id: 'partners', label: 'Partners (8): the people of two partner organisations', model: page(), note: 'The audience line counts Partners from GET /partners; the organisation opens its Portal access tab.' },
    { id: 'tile-ends-soon', label: 'Tile: Access ends soon (1)', model: page({}, { tile: 'endsSoon' }) },
    { id: 'tile-invited', label: 'Tile: Invited, not joined', model: page({}, { tile: 'invited' }) },
    { id: 'selected', label: 'Two ticked: Suspend 1 · Reactivate 1 · Deactivate 2', model: page({}, { selected: [marco.id, elena.id] }) },
    { id: 'bulk-deactivate', label: 'Deactivate 2 partner people (with a reason)', model: page({}, { selected: [marco.id, elena.id], bulk: 'deactivate' }) },
    { id: 'bulk-done', label: 'Receipt: 1 suspended', model: page({}, { notice: { key: 'done.suspend', tone: 'success', params: { count: 1 } } }) },
    { id: 'read-only', label: 'partners.view only: the bulk actions held with the right they need', model: page({}, { can: READ_ONLY, selected: [marco.id] }) },
    { id: 'empty', label: 'No partner uses a portal yet', model: page({}, { users: loaded([]), organisations: { value: { organisations: [], counts: { organisations: 0, people: 0, accessEndingSoon: 0 } }, problem: null } }) },
    { id: 'loading', label: 'Loading: tiles "—"', model: page({}, { users: loading(), organisations: { value: null, problem: null } }) },
    { id: 'error', label: "Couldn't load the partner people: Try again", model: page({}, { users: failed('problem.unavailable') }) },
    { id: 'office', label: 'Office (the partner people are no longer counted there)', model: page({ audience: 'office' }) },
    { id: 'invite-until', label: 'Invite people with "until": the roles end that day', model: page({ audience: 'office', dialog: 'invite' }), note: 'Pick a role first: until applies to the roles of the invite.' },
  ],
})
