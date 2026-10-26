/**
 * Meta ads step 42 — the business-admin guides (D1 = A: the Owner makes these admin acts in Meta's screens; Nexus sends
 * nothing). Pure: made-up portfolios, people, invitations and system users; made-up ids only.
 */
import { describe, expect, it } from 'vitest'
import {
  baseRoleOf, D1_LINE, financeRoleOf, invitationStateOf, META_ADMIN_HELP, peopleGuide, ROLE_SHORT, settingsGuide, systemUserGuide, timeOf,
  type AdminGuide, type PeopleLive, type SettingsLive, type SystemUserLive,
} from './business-admin.js'
import type { PortfolioInvitation, PortfolioPerson } from './live-business.js'

const PORTFOLIO = '9876543210'
const PAGE = '120000000000010'
const PAGE_2 = '120000000000011'
const ADMIN = '100000000000002'
const EMPLOYEE = '100000000000003'
const INVITE = '200000000000001'
const NEXUS_SU = '100000000000001'
const OTHER_SU = '100000000000009'
const READ_AT = '2026-10-26T10:00:00.000Z'

const g = (out: AdminGuide | { refusal: string }): AdminGuide => { if ('refusal' in out) throw new Error(out.refusal); return out }
const r = (out: AdminGuide | { refusal: string }): string => { if (!('refusal' in out)) throw new Error('expected a refusal'); return out.refusal }
const words = (out: AdminGuide) => [...out.ownerSteps, ...out.warnings, out.putBack.sentence, ...out.putBack.steps, ...out.items.map((i) => i.sentence ?? '')].join(' ')

const person = (over: Partial<PortfolioPerson>): PortfolioPerson => ({ personId: ADMIN, name: 'Person A', role: 'ADMIN', financeRole: null, adsRightsRole: null, twoFactor: 'enabled', tasks: null, markedForRemoval: null, ...over })
const invitation = (over: Partial<PortfolioInvitation>): PortfolioInvitation => ({
  invitationId: INVITE, role: 'EMPLOYEE', status: 'PENDING', financeRole: null, adsRightsRole: null, tasks: null, sdkRead: true, invitedUserType: ['FB'],
  createdTime: '2026-10-26T09:00:00+0000', expires: '2026-11-25T09:00:00+0000', updatedTime: null, createdBy: null, updatedBy: null, ...over,
})

function settingsLive(over: Partial<SettingsLive> = {}): SettingsLive {
  return {
    settings: { portfolioId: PORTFOLIO, name: ' Shop A ', timezoneId: 21, primaryPageId: PAGE, vertical: 'RETAIL', twoFactorType: 'none' },
    currentPageTaken: false, people: null, primaryPage: null, readAt: READ_AT, ...over,
  }
}
function peopleLive(over: { people?: PortfolioPerson[]; peopleMore?: boolean; invitations?: PortfolioInvitation[]; invitationsMore?: boolean; refused?: string } = {}): PeopleLive {
  const people = over.people ?? [person({}), person({ personId: EMPLOYEE, name: 'Person B', role: 'EMPLOYEE', financeRole: 'ANALYST', twoFactor: 'disabled' })]
  const invitations = over.invitations ?? [invitation({})]
  return {
    portfolioId: PORTFOLIO, portfolioName: 'Shop A', readAt: READ_AT,
    people: { people, totalCount: people.length, more: over.peopleMore ?? false, missing: [] },
    peopleCount: people.length,
    invitations: over.refused ? { refused: over.refused } : { invitations, totalCount: invitations.length, more: over.invitationsMore ?? false, missing: [] },
  }
}
function systemLive(over: Partial<SystemUserLive> = {}, users?: SystemUserLive['read']): SystemUserLive {
  return {
    portfolioId: PORTFOLIO, portfolioName: 'Shop A', tier: 'development_access', appsOwned: 1, readAt: READ_AT, nexusSystemUserKnown: true,
    read: users ?? { systemUsers: [{ systemUserId: NEXUS_SU, name: 'Nexus system user', role: 'EMPLOYEE', createdTime: '2026-01-01T00:00:00+0000', nexusSystemUser: true }], totalCount: 1, more: false, missing: [] },
    ...over,
  }
}
const otherSu = (over: Partial<SystemUserLive> = {}, name = 'Old server') => systemLive(over, { systemUsers: [{ systemUserId: OTHER_SU, name, role: 'EMPLOYEE', createdTime: null, nexusSystemUser: false }], totalCount: 1, more: false, missing: [] })

describe('every guide: Nexus sends nothing (D1)', () => {
  it('each answer says so, names the portfolio and the place in Meta, and keeps no step once it is done', () => {
    const all = [
      g(settingsGuide({ name: 'Shop A EU' }, settingsLive())),
      g(peopleGuide({ action: 'invite', role: 'employee' }, peopleLive())),
      g(systemUserGuide({ action: 'create', name: 'Reports', role: 'employee' }, systemLive())),
    ]
    for (const out of all) {
      expect(out.nexusSends).toBe('nothing')
      expect(out.rule).toBe(D1_LINE)
      expect(out.rule).toMatch(/Nexus changes nothing here and sends nothing to Meta/)
      expect(out.ownerSteps[0]).toMatch(new RegExp(`business\\.facebook\\.com/settings.*${PORTFOLIO}`))
      expect(out.readAt).toBe(READ_AT)
      expect(out.help.every((u) => u.startsWith('https://www.facebook.com/business/help/'))).toBe(true)
    }
    const done = g(settingsGuide({ name: ' Shop A ' }, settingsLive()))
    expect(done.state).toBe('done')
    expect(done.ownerSteps).toEqual([])
  })
  it('S2 — the help links are Meta\'s articles for each act (no "create a portfolio" link)', () => {
    expect(Object.values(META_ADMIN_HELP)).not.toContain('https://www.facebook.com/business/help/1710077379203657')
    expect(g(settingsGuide({ name: 'X' }, settingsLive())).help).toEqual([META_ADMIN_HELP.settings])
  })
})

describe('Meta\'s words', () => {
  it('base and finance roles, invitation states, times, the current screen words', () => {
    expect([baseRoleOf('ADMIN'), baseRoleOf('employee'), baseRoleOf('DEVELOPER'), baseRoleOf(null)]).toEqual(['admin', 'employee', null, null])
    expect([financeRoleOf('EDITOR'), financeRoleOf('FINANCE_EDITOR'), financeRoleOf('FINANCE_EDIT'), financeRoleOf('ANALYST'), financeRoleOf('FINANCE_VIEW'), financeRoleOf(null), financeRoleOf('NONE'), financeRoleOf('OWNER')])
      .toEqual(['editor', 'editor', 'editor', 'analyst', 'analyst', 'none', 'none', null])
    expect([invitationStateOf(null), invitationStateOf('PENDING'), invitationStateOf('accepted'), invitationStateOf('DECLINED'), invitationStateOf('expired'), invitationStateOf('held')])
      .toEqual(['pending', 'pending', 'accepted', 'declined', 'expired', 'unknown'])
    expect(timeOf('2026-10-26T09:00:00+0000')).toBe(Date.parse('2026-10-26T09:00:00Z'))
    expect(timeOf('2026-10-26T11:00:00+02:00')).toBe(Date.parse('2026-10-26T09:00:00Z'))
    expect(timeOf('soon')).toBeNull()
    // N1 — Meta's current labels (help 442345745885606).
    expect(ROLE_SHORT).toEqual({ admin: 'Full access (formerly full control: the Admin role)', employee: 'Basic access (formerly the Employee role)' })
  })
})

describe('set-meta-business-settings (BM-030, BM-031)', () => {
  it('refuses an empty ask', () => {
    expect(r(settingsGuide({}, settingsLive()))).toMatch(/Name what to change/)
  })
  it('name: from → to, worded "if Meta offers" (no edit step in Meta\'s help), the old name back exactly as Meta keeps it', () => {
    const out = g(settingsGuide({ name: 'Shop A EU' }, settingsLive()))
    expect(out.state).toBe('to-do')
    expect(out.items).toEqual([{ what: 'name', now: ' Shop A ', asked: 'Shop A EU', done: false }])
    expect(out.ownerSteps.join(' ')).toMatch(/Business info \(Meta also calls it Business portfolio info\): if Meta offers to edit the business portfolio name there, change it from " Shop A " to "Shop A EU"/)
    expect(out.ownerSteps.join(' ')).toMatch(/cannot contain special characters/)
    expect(out.putBack).toEqual({ possible: 'yes', sentence: expect.any(String), steps: [expect.stringContaining('back to " Shop A "')] })
  })
  it('primary Page: only an owned Page another business in Nexus does not use; the current one taken is its id and the flag', () => {
    expect(r(settingsGuide({ primaryPageId: PAGE_2 }, settingsLive({ primaryPage: { kind: 'not-owned', pageId: PAGE_2 } })))).toMatch(/not a Page this business portfolio owns.*#3918/)
    expect(r(settingsGuide({ primaryPageId: PAGE_2 }, settingsLive({ primaryPage: null })))).toMatch(/not a Page this business portfolio owns/)
    expect(r(settingsGuide({ primaryPageId: PAGE_2 }, settingsLive({ primaryPage: { kind: 'unknown', pageId: PAGE_2, why: 'not among the first 500' } })))).toBe('not among the first 500')
    expect(r(settingsGuide({ primaryPageId: PAGE_2 }, settingsLive({ primaryPage: { kind: 'owned', pageId: PAGE_2, name: 'Shop A outlet', taken: true } })))).toMatch(/Another business in Nexus uses Page/)
    const out = g(settingsGuide({ primaryPageId: PAGE_2 }, settingsLive({ currentPageTaken: true, primaryPage: { kind: 'owned', pageId: PAGE_2, name: 'Shop A outlet', taken: false } })))
    expect(out.items[0]).toEqual({ what: 'primaryPage', now: { pageId: PAGE, takenByAnotherBusiness: true }, asked: { pageId: PAGE_2, name: 'Shop A outlet' }, done: false })
    expect(out.ownerSteps.join(' ')).toMatch(/if Meta offers a primary Page there, set it to "Shop A outlet" \(Page id 120000000000011.*Nexus found no step for it in Meta's help/)
    expect(out.putBack.steps.join(' ')).not.toContain(PAGE)
    const free = g(settingsGuide({ primaryPageId: PAGE_2 }, settingsLive({ primaryPage: { kind: 'owned', pageId: PAGE_2, name: null, taken: false } })))
    expect(free.putBack.steps.join(' ')).toContain(`Page id ${PAGE}`)
    expect(g(settingsGuide({ primaryPageId: PAGE }, settingsLive())).state).toBe('done')
  })
  it('time zone and industry: the steps say Meta\'s help names no place for them; an industry Meta reads in another form is "cannot tell"', () => {
    const out = g(settingsGuide({ timezoneId: 90, vertical: 'ECOMMERCE' }, settingsLive()))
    expect(out.state).toBe('to-do')
    expect(out.ownerSteps.filter((s) => /Nexus found no place in Meta's help/.test(s))).toHaveLength(2)
    expect(out.ownerSteps.find((s) => s.startsWith('Industry'))).not.toMatch(/ad account's time zone/)
    const odd = g(settingsGuide({ vertical: 'RETAIL' }, settingsLive({ settings: { ...settingsLive().settings, vertical: 'Shopping and retail' } })))
    expect(odd.state).toBe('cannot-tell')
    expect(odd.items[0]).toMatchObject({ done: null, sentence: expect.stringMatching(/not one of the values it takes/) })
    expect(g(settingsGuide({ vertical: 'RETAIL' }, settingsLive({ settings: { ...settingsLive().settings, vertical: 'retail' } }))).state).toBe('done')
  })
  it('two-factor stricter: Meta\'s dropdown, who it holds at once (admins only, or everyone), 415, and its way back only partly', () => {
    const people = { people: [person({ twoFactor: 'disabled' }), person({ personId: EMPLOYEE, name: 'Person B', role: 'EMPLOYEE', twoFactor: null }), person({ personId: '100000000000004', name: 'Person C', twoFactor: 'enabled' })], more: false, missing: [] }
    const admins = g(settingsGuide({ twoFactorType: 'admin_required' }, settingsLive({ people })))
    const text = admins.warnings.join(' ')
    expect(text).toMatch(/holds every admin to it at once .*Meta does not read two-factor as enabled for Person A \(100000000000002: Meta reads "disabled"\)/)
    expect(text).not.toMatch(/Person B|Person C/)
    expect(text).toMatch(/415/)
    expect(admins.ownerSteps.join(' ')).toMatch(/Business portfolio info › Business options › the dropdown next to Two-factor authentication: choose "Admins only" \(Meta's admin_required\) and confirm/)
    expect(admins.putBack.possible).toBe('partly')
    expect(admins.putBack.steps.join(' ')).toMatch(/"No one" again/)
    const everyone = g(settingsGuide({ twoFactorType: 'all_required' }, settingsLive({ people: { ...people, more: true } })))
    expect(everyone.warnings.join(' ')).toMatch(/holds everyone to it at once .*Person A.*Person B \(100000000000003: Meta reads none\)/)
    expect(everyone.warnings.join(' ')).toMatch(/more people than Nexus reads/)
    expect(g(settingsGuide({ twoFactorType: 'all_required' }, settingsLive({ people: null }))).warnings.join(' ')).toMatch(/could not read the portfolio's people/)
  })
  it('two-factor loosened: Meta may not offer "No one"; its help only suggests it (N2); putting it back is stricter again', () => {
    const out = g(settingsGuide({ twoFactorType: 'none' }, settingsLive({ settings: { ...settingsLive().settings, twoFactorType: 'all_required' } })))
    expect(out.warnings.join(' ')).toMatch(/over 90 days old and then does not let it be turned off \("No one" is not offered\), and its help suggests keeping it \("Consider enabling two-factor authentication"\)/)
    expect(out.warnings.join(' ')).not.toMatch(/asks for two-factor authentication for everyone/)
    expect(out.ownerSteps.join(' ')).toMatch(/Meta does not offer "No one" when it requires/)
    expect(out.putBack.possible).toBe('yes')
    expect(out.putBack.steps.join(' ')).toMatch(/"Everyone" again/)
    const unknown = g(settingsGuide({ twoFactorType: 'admin_required' }, settingsLive({ settings: { ...settingsLive().settings, twoFactorType: 'strict' } })))
    expect(unknown.warnings.join(' ')).toMatch(/a word Nexus does not know/)
  })
  it('several settings, one done: partly done, steps only for the rest', () => {
    const out = g(settingsGuide({ name: ' Shop A ', twoFactorType: 'admin_required' }, settingsLive({ people: { people: [], more: false, missing: [] } })))
    expect(out.state).toBe('partly-done')
    expect(out.ownerSteps.join(' ')).not.toMatch(/portfolio name there/)
  })
})

describe('set-meta-business-people (BM-032…BM-035)', () => {
  it('invite: Meta\'s clicks; a role is needed, no person or e-mail; first answer to-do; asked again it finds the invitation by access, time and status', () => {
    expect(r(peopleGuide({ action: 'invite' }, peopleLive()))).toMatch(/Name the role/)
    expect(r(peopleGuide({ action: 'invite', role: 'employee', personId: ADMIN }, peopleLive()))).toMatch(/names no person/)
    expect(r(peopleGuide({ action: 'invite', role: 'employee', since: 'yesterday' }, peopleLive()))).toMatch(/since must be a time/)
    const first = g(peopleGuide({ action: 'invite', role: 'employee', financeRole: 'analyst' }, peopleLive()))
    expect(first.state).toBe('to-do')
    const steps = first.ownerSteps.join(' ')
    expect(steps).toMatch(/Users › People › Invite people \(top right\): .*e-mail address .*managed Meta account .*Next\./)
    expect(steps).toMatch(/Business portfolio permissions: Basic access \(formerly the Employee role\); under the advanced options, finance access to view \(Finance analyst\)\. Next\./)
    expect(steps).toMatch(/Invite\..*Settings › Requests/)
    expect(steps).toContain(`since "${READ_AT}"`)
    expect(first.warnings.join(' ')).toMatch(/Nexus never takes or reads anyone's e-mail address/)
    expect(first.putBack).toMatchObject({ possible: 'partly', steps: [expect.stringMatching(/Requests \(Meta: "Manage invitations you've sent"\): if Meta offers to cancel it there/)] })
    const later = peopleLive({ invitations: [invitation({ createdTime: '2026-10-26T08:00:00+0000' }), invitation({ invitationId: '200000000000002', createdTime: '2026-10-26T10:05:00+0000', financeRole: 'FINANCE_ANALYST' })] })
    const again = g(peopleGuide({ action: 'invite', role: 'employee', financeRole: 'analyst', since: READ_AT }, later))
    expect(again.state).toBe('done')
    expect(again.items[0].now).toEqual([expect.objectContaining({ invitationId: '200000000000002' })])
    expect(g(peopleGuide({ action: 'invite', role: 'admin', since: READ_AT }, later)).state).toBe('to-do')
    expect(g(peopleGuide({ action: 'invite', role: 'admin', since: READ_AT }, peopleLive({ invitationsMore: true }))).state).toBe('cannot-tell')
    expect(g(peopleGuide({ action: 'invite', role: 'admin' }, peopleLive())).warnings.join(' ')).toMatch(/Full access lets the person manage everything.*could take Nexus's access away/)
  })
  it('N6 — invite asked again: a declined or expired invitation is not a sent one; a status Nexus does not know cannot tell', () => {
    const made = (status: string) => peopleLive({ invitations: [invitation({ createdTime: '2026-10-26T10:05:00+0000', status })] })
    expect(g(peopleGuide({ action: 'invite', role: 'employee', since: READ_AT }, made('ACCEPTED'))).state).toBe('done')
    const declined = g(peopleGuide({ action: 'invite', role: 'employee', since: READ_AT }, made('DECLINED')))
    expect(declined).toMatchObject({ state: 'to-do', items: [expect.objectContaining({ sentence: expect.stringMatching(/as DECLINED: it is not a live invitation/) })] })
    expect(g(peopleGuide({ action: 'invite', role: 'employee', since: READ_AT }, made('HELD'))).state).toBe('cannot-tell')
  })
  it('S6 — invite when the invitations cannot be read: the steps still come, the result "cannot tell"', () => {
    const out = g(peopleGuide({ action: 'invite', role: 'employee', since: READ_AT }, peopleLive({ refused: 'Meta refused the read.' })))
    expect(out.state).toBe('cannot-tell')
    expect(out.items[0].sentence).toMatch(/cannot read the pending invitations \(Meta refused the read\.\)/)
    expect(out.ownerSteps.length).toBeGreaterThan(3)
    expect(r(peopleGuide({ action: 'cancel-invitation', invitationId: INVITE }, peopleLive({ refused: 'Meta refused the read.' })))).toMatch(/could not read the portfolio's pending invitations/)
    expect(r(peopleGuide({ action: 'remove', personId: EMPLOYEE }, { ...peopleLive(), people: null }))).toMatch(/could not read the portfolio's people/)
  })
  it('change-role: Meta\'s clicks (the name › Business portfolio access › Manage › Save); the person must be found; old values to put back', () => {
    expect(r(peopleGuide({ action: 'change-role', role: 'admin' }, peopleLive()))).toMatch(/Name the person/)
    expect(r(peopleGuide({ action: 'change-role', personId: '100000000000099', role: 'admin' }, peopleLive()))).toMatch(/is not a person of this business portfolio/)
    expect(r(peopleGuide({ action: 'change-role', personId: '100000000000099', role: 'admin' }, peopleLive({ peopleMore: true })))).toMatch(/not among the first 500/)
    expect(r(peopleGuide({ action: 'change-role', personId: EMPLOYEE }, peopleLive()))).toMatch(/Name what to change/)
    const two = peopleLive({ people: [person({}), person({ personId: '100000000000004', name: 'Person C' })] })
    const demote = g(peopleGuide({ action: 'change-role', personId: ADMIN, role: 'employee' }, two))
    expect(demote.ownerSteps.join(' ')).toMatch(/Users › People: click "Person A" \(Nexus's id 100000000000002\)\. In Business portfolio access click Manage, set Basic access \(formerly the Employee role\).*then Save\./)
    expect(demote.putBack.steps.join(' ')).toMatch(/Business portfolio access › Manage: Full access \(formerly full control: the Admin role\) again\. Save\./)
    expect(demote.help).toEqual([META_ADMIN_HELP.changeAccess, META_ADMIN_HELP.permissions, META_ADMIN_HELP.myInfo])
    // N3 — a person's own name and e-mail: Business portfolio info › My info › Edit.
    expect(demote.warnings.join(' ')).toMatch(/Business portfolio info › My info › Edit/)
    const finance = g(peopleGuide({ action: 'change-role', personId: EMPLOYEE, financeRole: 'none' }, peopleLive()))
    expect(finance.items).toEqual([{ what: 'financeRole', now: 'ANALYST', asked: 'none', done: false }])
    expect(finance.putBack.steps.join(' ')).toMatch(/finance access to view \(Finance analyst\) again/)
    expect(g(peopleGuide({ action: 'change-role', personId: EMPLOYEE, role: 'employee', financeRole: 'analyst' }, peopleLive())).state).toBe('done')
    const odd = g(peopleGuide({ action: 'change-role', personId: EMPLOYEE, role: 'admin' }, peopleLive({ people: [person({}), person({ personId: EMPLOYEE, role: 'DEVELOPER' })] })))
    expect(odd.items[0].done).toBeNull()
  })
  it('S4 — the only-admin floor: refused for the only admin, and fails closed on a role Meta reads in words Nexus does not know', () => {
    expect(r(peopleGuide({ action: 'change-role', personId: ADMIN, role: 'employee' }, peopleLive()))).toMatch(/only admin.*3914/)
    expect(r(peopleGuide({ action: 'remove', personId: ADMIN }, peopleLive()))).toMatch(/only admin.*3914/)
    const unknown = peopleLive({ people: [person({ role: 'MANAGE' }), person({ personId: EMPLOYEE, name: 'Person B', role: 'EMPLOYEE' })] })
    expect(r(peopleGuide({ action: 'remove', personId: ADMIN }, unknown))).toMatch(/reads the role of "Person A".* as "MANAGE", a word Nexus does not know, and no other person reads as Admin: Nexus cannot tell whether they are the portfolio's only admin/)
    expect(r(peopleGuide({ action: 'change-role', personId: ADMIN, role: 'employee' }, unknown))).toMatch(/cannot tell whether they are the portfolio's only admin/)
    // Another person reads as Admin: the unknown-role person may go.
    const withAdmin = peopleLive({ people: [person({ role: 'MANAGE' }), person({ personId: '100000000000004', name: 'Person C', role: 'ADMIN' })] })
    expect(g(peopleGuide({ action: 'remove', personId: ADMIN }, withAdmin)).state).toBe('to-do')
    // An Employee is never held by the floor.
    expect(g(peopleGuide({ action: 'remove', personId: EMPLOYEE }, unknown)).state).toBe('to-do')
    // With more people than Nexus reads, it cannot count every admin: a warning, Meta decides.
    expect(g(peopleGuide({ action: 'change-role', personId: ADMIN, role: 'employee' }, peopleLive({ peopleMore: true }))).warnings.join(' ')).toMatch(/cannot count every admin/)
    expect(g(peopleGuide({ action: 'remove', personId: ADMIN }, peopleLive({ peopleMore: true }))).warnings.join(' ')).toMatch(/cannot count every admin/)
  })
  it('remove: Meta\'s clicks (the name › Remove › confirm, an approval in Requests); S1: a person Nexus cannot find is refused on a first ask; asked again with since, absence is the result', () => {
    const out = g(peopleGuide({ action: 'remove', personId: EMPLOYEE }, peopleLive()))
    expect(out.ownerSteps.join(' ')).toMatch(/click "Person B" \(Nexus's id 100000000000003\), then Remove, and confirm\. If another person with full access to the portfolio must approve it, they do it in Settings › Requests/)
    expect(out.ownerSteps.join(' ')).toContain(`since "${READ_AT}"`)
    expect(out.help).toEqual([META_ADMIN_HELP.removePeople, META_ADMIN_HELP.addPeople])
    expect(out.putBack).toMatchObject({ possible: 'partly', sentence: expect.stringMatching(/new invitation.*meta-account-access view by-person/) })
    expect(out.putBack.steps.join(' ')).toMatch(/Basic access \(formerly the Employee role\), finance access to view \(Finance analyst\)/)
    expect(r(peopleGuide({ action: 'remove', personId: '100000000000099' }, peopleLive()))).toMatch(/is not a person of this business portfolio/)
    expect(r(peopleGuide({ action: 'remove', personId: '100000000000099' }, peopleLive({ peopleMore: true })))).toMatch(/not among the first 500/)
    const gone = g(peopleGuide({ action: 'remove', personId: '100000000000099', since: READ_AT }, peopleLive()))
    expect(gone).toMatchObject({ state: 'done', ownerSteps: [] })
    expect(g(peopleGuide({ action: 'remove', personId: '100000000000099', since: READ_AT }, peopleLive({ peopleMore: true }))).state).toBe('cannot-tell')
  })
  it('cancel-invitation and change-invitation: by its id, worded "if Meta offers"; S1 on a first ask; N6 by status', () => {
    expect(r(peopleGuide({ action: 'cancel-invitation' }, peopleLive()))).toMatch(/Name the invitation/)
    expect(r(peopleGuide({ action: 'change-invitation', invitationId: INVITE }, peopleLive()))).toMatch(/Name the access/)
    const cancel = g(peopleGuide({ action: 'cancel-invitation', invitationId: INVITE }, peopleLive()))
    expect(cancel.ownerSteps.join(' ')).toMatch(/Requests \(Meta: "Manage invitations you've sent"\): find the invitation made 2026-10-26T09:00:00\+0000 with role EMPLOYEE.*If Meta offers to cancel it there.*Nexus found no cancel step in Meta's help/)
    expect(cancel.putBack.possible).toBe('partly')
    expect(r(peopleGuide({ action: 'cancel-invitation', invitationId: '200000000000099' }, peopleLive()))).toMatch(/is not a pending invitation of this business portfolio/)
    expect(r(peopleGuide({ action: 'cancel-invitation', invitationId: '200000000000099' }, peopleLive({ invitationsMore: true })))).toMatch(/not among the first 500/)
    expect(g(peopleGuide({ action: 'cancel-invitation', invitationId: '200000000000099', since: READ_AT }, peopleLive())).state).toBe('done')
    expect(g(peopleGuide({ action: 'cancel-invitation', invitationId: '200000000000099', since: READ_AT }, peopleLive({ invitationsMore: true }))).state).toBe('cannot-tell')
    const change = g(peopleGuide({ action: 'change-invitation', invitationId: INVITE, role: 'admin' }, peopleLive()))
    expect(change.ownerSteps.join(' ')).toMatch(/If Meta offers to change its access there.*Nexus found no such step in Meta's help: if it is not offered, cancel the invitation and invite the person again/)
    expect(change.putBack.steps.join(' ')).toMatch(/Basic access \(formerly the Employee role\)/)
    expect(g(peopleGuide({ action: 'change-invitation', invitationId: INVITE, role: 'employee' }, peopleLive())).state).toBe('done')
    expect(r(peopleGuide({ action: 'change-invitation', invitationId: '200000000000099', role: 'admin' }, peopleLive()))).toMatch(/is not a pending invitation/)
    expect(g(peopleGuide({ action: 'change-invitation', invitationId: '200000000000099', role: 'admin', since: READ_AT }, peopleLive())).state).toBe('cannot-tell')
    // N6 — an invitation Meta reads as accepted, declined or expired is not cancelled or changed.
    const expired = peopleLive({ invitations: [invitation({ status: 'EXPIRED' })] })
    expect(g(peopleGuide({ action: 'cancel-invitation', invitationId: INVITE }, expired))).toMatchObject({ state: 'done', ownerSteps: [] })
    expect(g(peopleGuide({ action: 'cancel-invitation', invitationId: INVITE }, peopleLive({ invitations: [invitation({ status: 'ACCEPTED' })] }))).items[0].sentence).toMatch(/action remove/)
    expect(r(peopleGuide({ action: 'change-invitation', invitationId: INVITE, role: 'admin' }, expired))).toMatch(/as EXPIRED: only a pending invitation can be changed/)
    expect(g(peopleGuide({ action: 'cancel-invitation', invitationId: INVITE }, peopleLive({ invitations: [invitation({ status: 'HELD' })] }))).warnings.join(' ')).toMatch(/a word Nexus does not know/)
  })
})

describe('create-meta-system-user (BM-037, BM-061)', () => {
  it('create: Meta\'s clicks, Meta\'s limits from the list and the tier (may refuse), the app the portfolio must own, no way back by API', () => {
    expect(r(systemUserGuide({ action: 'create' }, systemLive()))).toMatch(/Name the new system user/)
    expect(r(systemUserGuide({ action: 'create', name: 'Reports', systemUserId: OTHER_SU }, systemLive()))).toMatch(/has no id yet/)
    const out = g(systemUserGuide({ action: 'create', name: 'Reports' }, systemLive()))
    expect(out.ownerSteps.join(' ')).toMatch(/Users › System users › Add new system user: name it "Reports"; if Meta asks for a role, choose Employee .*Then Create system user\./)
    expect(out.warnings.join(' ')).toMatch(/at the Limited access tier Meta allows 1 \(3949\), so Meta may refuse another/)
    expect(out.warnings.join(' ')).toMatch(/never paste it into a chat/)
    expect(out.putBack).toMatchObject({ possible: 'no', sentence: expect.stringMatching(/You cannot delete a system user/) })
    expect(g(systemUserGuide({ action: 'create', name: 'Reports' }, systemLive({ tier: 'standard_access' }))).warnings.join(' ')).not.toMatch(/3949/)
    expect(g(systemUserGuide({ action: 'create', name: 'Reports' }, systemLive({ tier: null }))).warnings.join(' ')).toMatch(/did not name the app's tier/)
    const noApp = g(systemUserGuide({ action: 'create', name: 'Reports' }, systemLive({ appsOwned: 0 })))
    expect(noApp.warnings.join(' ')).toMatch(/104001.*Settings › Accounts › Apps › Add \(Meta's help\)/)
    expect(noApp.help).toContain(META_ADMIN_HELP.addApp)
    expect(g(systemUserGuide({ action: 'create', name: 'Reports' }, systemLive({ appsOwned: null }))).warnings.join(' ')).not.toMatch(/104001/)
    const withAdmin = systemLive({}, { systemUsers: [{ systemUserId: OTHER_SU, name: 'Admin SU', role: 'ADMIN', createdTime: null, nexusSystemUser: false }], totalCount: 1, more: false, missing: [] })
    const admin = g(systemUserGuide({ action: 'create', name: 'Second admin', role: 'admin' }, withAdmin))
    expect(admin.warnings.join(' ')).toMatch(/Meta allows one .*3965/)
    expect(admin.warnings.join(' ')).toMatch(/only for administrative actions/)
  })
  it('create asked again: done when Meta lists that name and role (made since the first answer, when since is given); a refused list cannot tell', () => {
    const made = systemLive({}, { systemUsers: [{ systemUserId: OTHER_SU, name: 'Reports', role: 'EMPLOYEE', createdTime: '2026-10-26T10:03:00+0000', nexusSystemUser: false }], totalCount: 1, more: false, missing: [] })
    expect(g(systemUserGuide({ action: 'create', name: 'Reports', since: READ_AT }, made)).state).toBe('done')
    expect(g(systemUserGuide({ action: 'create', name: 'Reports', since: '2026-10-26T11:00:00Z' }, made)).state).toBe('to-do')
    expect(g(systemUserGuide({ action: 'create', name: 'Reports', role: 'admin', since: READ_AT }, made)).state).toBe('to-do')
    expect(r(systemUserGuide({ action: 'create', name: 'Reports', since: 'later' }, made))).toMatch(/since must be a time/)
    const refused = g(systemUserGuide({ action: 'create', name: 'Reports' }, systemLive({}, { refused: 'Meta refused: an admin token is needed.' })))
    expect(refused).toMatchObject({ state: 'cannot-tell', items: [expect.objectContaining({ sentence: expect.stringMatching(/cannot read the portfolio's system users: Meta refused/) })] })
    expect(refused.ownerSteps.length).toBeGreaterThan(1)
  })
  it('rename: by its id among the listed ones, worded "if Meta offers", put back to the exact old name; S5 another business may connect with it', () => {
    const list = otherSu({}, ' Old name')
    expect(r(systemUserGuide({ action: 'rename', name: 'New' }, list))).toMatch(/Name the system user/)
    expect(r(systemUserGuide({ action: 'rename', systemUserId: OTHER_SU }, list))).toMatch(/Name the new name/)
    expect(r(systemUserGuide({ action: 'rename', systemUserId: '100000000000077', name: 'New' }, list))).toMatch(/is not a system user of this business portfolio/)
    expect(r(systemUserGuide({ action: 'rename', systemUserId: OTHER_SU, name: 'New' }, systemLive({}, { refused: 'Meta refused.' })))).toMatch(/cannot name the one to rename/)
    const out = g(systemUserGuide({ action: 'rename', systemUserId: OTHER_SU, name: 'New' }, list))
    expect(out.ownerSteps.join(' ')).toMatch(/click " Old name"\. If Meta offers to edit its name there, change it to "New".*Nexus found no rename step in Meta's help/)
    expect(out.putBack.steps).toEqual([expect.stringContaining('"New" › its name back to " Old name"')])
    expect(out.warnings.join(' ')).toMatch(/canonical id/)
    expect(out.warnings.join(' ')).toMatch(/if another business in Nexus connects to Meta with this one/)
    expect(g(systemUserGuide({ action: 'rename', systemUserId: NEXUS_SU, name: 'New' }, systemLive())).warnings.join(' ')).toMatch(/system user Nexus works as/)
    expect(g(systemUserGuide({ action: 'rename', systemUserId: OTHER_SU, name: ' Old name' }, list)).state).toBe('done')
  })
  it('remove: never Nexus\'s own; S5 refused when Nexus does not know its own, and warns another business may use it; S1 absence only with since', () => {
    expect(r(systemUserGuide({ action: 'remove', systemUserId: NEXUS_SU }, systemLive()))).toMatch(/cuts Nexus off from Meta/)
    expect(r(systemUserGuide({ action: 'remove', systemUserId: OTHER_SU }, otherSu({ nexusSystemUserKnown: false })))).toMatch(/does not know which system user it works as/)
    const out = g(systemUserGuide({ action: 'remove', systemUserId: OTHER_SU }, otherSu()))
    expect(out.ownerSteps.join(' ')).toMatch(/If Meta offers Remove there.*revoke its tokens where Meta offers it.*Nexus found no remove step in Meta's help/)
    expect(out.ownerSteps.join(' ')).toContain(`since "${READ_AT}"`)
    expect(out.warnings.join(' ')).toMatch(/Check first that no business in Nexus connects to Meta with this system user/)
    expect(out.putBack.possible).toBe('no')
    expect(r(systemUserGuide({ action: 'remove', systemUserId: '100000000000077' }, otherSu()))).toMatch(/is not a system user of this business portfolio/)
    expect(g(systemUserGuide({ action: 'remove', systemUserId: '100000000000077', since: READ_AT }, otherSu())).state).toBe('done')
    const cut = otherSu()
    expect(g(systemUserGuide({ action: 'remove', systemUserId: '100000000000077', since: READ_AT }, { ...cut, read: { ...(cut.read as { systemUsers: [] }), more: true, totalCount: 600, missing: [] } })).state).toBe('cannot-tell')
  })
})

describe('words', () => {
  it('no guide asks for, or carries, an e-mail address or a token', () => {
    const outs = [
      g(peopleGuide({ action: 'invite', role: 'employee' }, peopleLive())),
      g(peopleGuide({ action: 'cancel-invitation', invitationId: INVITE }, peopleLive())),
      g(systemUserGuide({ action: 'create', name: 'Reports' }, systemLive())),
    ]
    for (const out of outs) expect(words(out)).not.toMatch(/@[a-z]+\.|access_token|EAA[A-Za-z0-9]{10}/)
  })
})
