import { describe, expect, it } from 'vitest'
import { OFFICE_PAGES } from '../../shell/nav/office-nav'
import { companyDraft, companyPatch, companyProblems, newCompanyProblems, newSiteProblems, readiness, siteAddress, suggestCode, treeRows } from './companies/model'
import { deviceRows, deviceTileMatch, enrolProblems, printerBody, printerDraft, printerProblems } from './devices/model'
import { setupSteps, type OverviewFacts } from './overview/model'
import { heldAreas, holdersOf, roleRows, templateGap } from './roles/model'
import { grainsOf, problemKey, problemNotice, scopeWords, selectedAmong, shownOf, usesOf } from './shared/model'
import { ApiError } from '../../lib/api/errors'
import { ASSIGNMENTS, CATALOGUE, CENTRES, COMPANIES, DEVICES, LINES, NOW, PREFIX, PRINTERS, ROLES, SITES, STATIONS, USERS, WORKERS } from './shared/fixtures'
import { archiveUses, floorBody, floorDraft, floorProblems, partProblems, sameFloor, structureGroups, takenCodes } from './sites/model'
import { floorRows, inviteProblems, nameFromEmail, officeRows, peopleFromPaste, tileCounts, userGrains, whereWords, workerProblems } from './users/model'
import { giveRoleProblems, isLastAdmin, lifecycleHeld, ownWorker, raises } from './users/record/model'
import { DEMO_USER } from '../../shell/design-data'

/** The Admin pages' rules, pure (B-W0-27): rows, readiness, form checks, held reasons, the set-up checklist. */

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))

describe('shared rules', () => {
  it('50 rows at first, "Show N more" adds 50 at a time until every row is shown (Owner L3)', () => {
    const rows = Array.from({ length: 120 }, (_, index) => index)
    expect(shownOf(rows, 1)).toMatchObject({ more: 50 })
    expect(shownOf(rows, 1).rows).toHaveLength(50)
    expect(shownOf(rows, 2)).toMatchObject({ more: 20 })
    expect(shownOf(rows, 3).rows).toHaveLength(120)
    expect(shownOf(rows, 3).more).toBe(0)
    expect(shownOf(rows, 9).rows).toHaveLength(120)
    expect(shownOf([], 1)).toEqual({ rows: [], more: 0 })
  })

  it('the selection keeps only the rows shown (a search or a filter that hides a row drops it)', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(selectedAmong(rows, ['c', 'z', 'a']).map((row) => row.id)).toEqual(['a', 'c'])
    expect(selectedAmong(rows, [])).toEqual([])
  })

  it('money grains in their fixed order, whatever roles give them', () => {
    expect(grainsOf([{ grains: ['wages', 'price'] }, { grains: ['price', 'cost'] }])).toEqual(['price', 'cost', 'wages'])
    expect(grainsOf([])).toEqual([])
  })

  it('an API refusal becomes the page\'s words; an "in use" one names what uses the row', () => {
    const inUse = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'uses/stations', message: '3' }])
    expect(usesOf(inUse)).toEqual({ stations: 3 })
    expect(problemKey(inUse)).toBe('problem.inUse')
    expect(problemNotice(inUse)).toEqual({ key: 'problem.inUseBy.stations', tone: 'warning', params: { count: 3 } })
    expect(problemKey(new ApiError('conflict', 409, 'conflict', 'stale'))).toBe('problem.conflict')
    expect(problemKey(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('problem.forbidden')
    expect(problemKey(new ApiError('unavailable', 0, 'network', 'x'))).toBe('problem.unavailable')
    expect(problemKey(new Error('boom'))).toBe('problem.internal')
  })

  it('where a role applies, in words', () => {
    expect(scopeWords({ allCompanies: true, companyIds: [], siteIds: [] }, companies, 'All companies')).toBe('All companies')
    expect(scopeWords({ allCompanies: false, companyIds: [COMPANIES[0]!.id], siteIds: [SITES[0]!.id] }, companies, 'All')).toBe('Officina Demo S.r.l. › Stabilimento Demo Nord')
    expect(scopeWords({ allCompanies: false, companyIds: [COMPANIES[1]!.id], siteIds: [] }, companies, 'All')).toBe('Pelletteria Esempio S.p.A.')
  })
})

describe('SCR-008 Companies & sites', () => {
  it('the tree: a company and its active sites; a folded company hides them; a search keeps the company of a matching site', () => {
    expect(treeRows(COMPANIES, '', [], false).map((row) => row.kind)).toEqual(['company', 'site', 'site', 'company', 'site'])
    expect(treeRows(COMPANIES, '', [COMPANIES[0]!.id], false).map((row) => row.kind)).toEqual(['company', 'company', 'site'])
    const found = treeRows(COMPANIES, 'magazzino', [], false)
    expect(found.map((row) => (row.kind === 'site' ? row.site.code : row.company.code))).toEqual(['DEMO', 'DS1'])
    expect(treeRows(COMPANIES, 'zzz', [], false)).toEqual([])
  })

  it('the one most serious gap: a company that cannot invoice, else a plant without stations', () => {
    expect(readiness(COMPANIES)).toMatchObject({ kind: 'invoicing', company: { code: 'ESEMPIO' } })
    const ready = COMPANIES.map((company) => ({ ...company, invoicing: { ready: true, issues: [] } }))
    expect(readiness(ready)).toMatchObject({ kind: 'no-station', site: { code: 'EP1' } })
  })

  it('a new company: a code from its name (legal suffix dropped, never one taken), and its checks', () => {
    expect(suggestCode('Officina Demo S.r.l.', [])).toBe('OFFICINA')
    expect(suggestCode('Pellétteria Esempio S.p.A.', ['PELLETTE'])).toBe('PELLETT2')
    expect(newCompanyProblems({ legalName: '', code: 'a b', vatNumber: '123', country: 'ITA' }, [])).toEqual({ legalName: 'form.required', code: 'form.code', vatNumber: 'form.vat', country: 'form.country' })
    expect(newCompanyProblems({ legalName: 'X', code: 'DEMO', vatNumber: '', country: 'IT' }, ['DEMO'])).toEqual({ code: 'form.codeTaken' })
    expect(newCompanyProblems({ legalName: 'X', code: 'NEW-1', vatNumber: 'IT00000000000', country: 'IT' }, ['DEMO'])).toEqual({})
  })

  it('a new site: an address is all or nothing', () => {
    const draft = { companyId: COMPANIES[0]!.id, name: 'Nuovo', kind: 'PLANT' as const, code: 'NN1', timezone: 'Europe/Rome', line1: 'Via 1', postalCode: '', city: '', province: '' }
    expect(newSiteProblems(draft, [])).toEqual({ postalCode: 'form.required', city: 'form.required' })
    expect(newSiteProblems({ ...draft, line1: '' }, ['NN1'])).toEqual({ code: 'form.codeTaken' })
    expect(siteAddress({ line1: '', postalCode: '', city: '', province: '' })).toBeNull()
    expect(siteAddress({ line1: ' Via 1 ', postalCode: '20100', city: 'Milano', province: '' })).toEqual({ line1: 'Via 1', postalCode: '20100', city: 'Milano', province: null, country: 'IT' })
  })

  it('the Legal & tax form sends only what changed, a cleared field as null and the address whole, with the version read', () => {
    const before = companyDraft(COMPANIES[0]!)
    const after = { ...before, tradeName: '', sdiReceiverCode: 'xyz9876', city: 'Altrove' }
    expect(companyPatch(before, after, ['tradeName', 'sdiReceiverCode', 'line1', 'line2', 'postalCode', 'city', 'province', 'addressCountry', 'pec'], 7)).toEqual({
      version: 7,
      tradeName: null,
      sdiReceiverCode: 'xyz9876',
      address: { line1: 'Via Esempio 1', line2: null, postalCode: '00000', city: 'Altrove', province: 'MI', country: 'IT' },
    })
    expect(companyProblems({ ...before, sdiReceiverCode: 'AB12', shareCapital: '10,000', pec: 'not-an-address' })).toEqual({ sdiReceiverCode: 'form.sdi', shareCapital: 'form.amount', pec: 'form.email' })
    expect(companyPatch(before, { ...before, fiscalYearStartMonth: '4' }, ['fiscalYearStartMonth'], 7)).toEqual({ version: 7, fiscalYearStartMonth: 4 })
  })
})

describe('SCR-009 a site', () => {
  const structure = { site: SITES[0]!, company: { id: COMPANIES[0]!.id, code: 'DEMO', legalName: 'Officina Demo S.r.l.' }, lines: LINES, workCentres: CENTRES, stations: STATIONS }
  it('lines with their stations, then the ones standing alone', () => {
    const groups = structureGroups(structure, false)
    expect(groups.map((group) => [group.line?.code ?? null, group.stations.map((station) => station.code)])).toEqual([
      ['L1', ['SEW-01', 'SEW-02']],
      ['L2', ['SEW-03']],
      [null, ['CUT-01', 'CUT-02', 'QC-01', 'PACK-01']],
    ])
  })

  it('an archive waits for what still uses the row', () => {
    expect(archiveUses(structure, 'line', LINES[0]!.id)).toEqual({ stations: 2 })
    expect(archiveUses(structure, 'station', STATIONS[0]!.id)).toEqual({ devices: 1 })
    expect(archiveUses(structure, 'station', STATIONS[2]!.id)).toEqual({})
    expect(archiveUses(structure, 'centre', CENTRES[3]!.id)).toEqual({ stations: 1 })
    expect(archiveUses(structure, 'site', SITES[0]!.id)).toMatchObject({ lines: 2, stations: 7 })
  })

  it('a station needs a work centre; codes are unique on the site', () => {
    const draft = { code: 'sew-01', name: 'Doppia', kind: 'SEWING' as const, workCentreId: '', lineId: '' }
    expect(partProblems('station', { ...draft, code: 'SEW-01' }, takenCodes(structure, 'station'))).toEqual({ code: 'form.codeTaken', workCentreId: 'site.station.needsCentre' })
    expect(partProblems('line', { ...draft, code: 'L9' }, takenCodes(structure, 'line'))).toEqual({})
  })

  it("the floor times follow the floor rules (factory-domain timingProblems)", () => {
    expect(floorProblems({ idleMinutes: 10, shiftEnds: ['14:00', '22:00'], badgeOnlySignIn: false })).toEqual({})
    expect(floorProblems({ idleMinutes: 0, shiftEnds: ['6:00'], badgeOnlySignIn: false })).toEqual({ idleMinutes: 'site.floor.idleRange', 'shiftEnds/0': 'site.floor.timeFormat' })
    expect(floorProblems({ idleMinutes: 10, shiftEnds: ['14:00', '14:00'], badgeOnlySignIn: false })).toEqual({ shiftEnds: 'site.floor.twice' })
    expect(sameFloor({ idleMinutes: 10, shiftEnds: ['22:00', '14:00'], badgeOnlySignIn: false }, { idleMinutes: 10, shiftEnds: ['14:00', '22:00'], badgeOnlySignIn: false })).toBe(true)
  })

  it('F1: the badge-alone switch is part of the floor settings, a change of it alone is unsaved, and it goes in the PUT', () => {
    const read = floorDraft({ siteId: SITES[0]!.id, idleMinutes: 10, shiftEnds: ['22:00', '14:00'], badgeOnlySignIn: false, timeZone: 'Europe/Rome', version: 3 })
    expect(read.badgeOnlySignIn).toBe(false)
    const switched = { ...read, badgeOnlySignIn: true }
    expect(sameFloor(read, switched)).toBe(false)
    expect(floorBody(switched, 3)).toEqual({ idleMinutes: 10, shiftEnds: ['14:00', '22:00'], badgeOnlySignIn: true, version: 3 })
    // A site still on the defaults has no row (version null): the PUT makes it without a version.
    expect(floorBody(read, null)).toEqual({ idleMinutes: 10, shiftEnds: ['14:00', '22:00'], badgeOnlySignIn: false })
  })
})

describe('SCR-010 / SCR-011 people', () => {
  it('the office list hides the deactivated unless their tile is pressed; tiles count each filter', () => {
    expect(officeRows(USERS, null, '').map((user) => user.displayName)).not.toContain('Gino Bozza')
    expect(officeRows(USERS, 'deactivated', '').map((user) => user.displayName)).toEqual(['Gino Bozza'])
    expect(officeRows(USERS, 'noTwoFactor', '').map((user) => user.displayName)).toEqual(['Carlo Prova'])
    expect(tileCounts({ users: { items: USERS }, workers: { items: WORKERS } })).toMatchObject({ invited: 1, noTwoFactor: 1, suspended: 1, deactivated: 1, locked: 1, noPin: 1, noBadge: 1, inactive: 1 })
    expect(tileCounts({ users: { items: null }, workers: { items: null } }).invited).toBeNull()
    expect(floorRows(WORKERS, null, 'stabilimento', SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId })))).toHaveLength(5)
  })

  it('what money a person sees comes from their roles (unknown until the roles are read); where, in words', () => {
    expect(userGrains(USERS[3]!, ROLES)).toEqual(['price', 'cost', 'margin', 'wages'])
    expect(userGrains(USERS[2]!, ROLES)).toEqual(['price'])
    expect(userGrains(USERS[2]!, null)).toBeNull()
    expect(whereWords(USERS[2]!.roles, companies, 'All')).toBe('Officina Demo S.r.l.')
    expect(whereWords(USERS[3]!.roles, companies, 'All')).toBe('All')
    expect(whereWords([], companies, 'All')).toBeNull()
  })

  it('invite: addresses pasted become people; a taken, repeated or wrong address is refused before the call', () => {
    expect(peopleFromPaste('marco.rossi@example.com, <anna-bianchi@example.com>; nonsense')).toEqual([
      { email: 'marco.rossi@example.com', name: 'Marco Rossi' },
      { email: 'anna-bianchi@example.com', name: 'Anna Bianchi' },
    ])
    expect(nameFromEmail('lucia_verdi@example.com')).toBe('Lucia Verdi')
    const scope = { allCompanies: false, companyIds: [], siteIds: [] }
    expect(
      inviteProblems(
        {
          people: [
            { name: 'A', email: 'carlo.prova@example.com' },
            { name: '', email: 'x@example.com' },
            { name: 'B', email: 'x@example.com' },
            { name: 'C', email: 'nope' },
          ],
          roleIds: [ROLES[2]!.id],
          scope,
          locale: 'it',
        },
        USERS.map((user) => user.email),
      ),
    ).toEqual({ 'people.0.email': 'users.invite.exists', 'people.1.name': 'form.required', 'people.2.email': 'users.invite.twice', 'people.3.email': 'form.email', scope: 'users.invite.scopeNeeded' })
    expect(inviteProblems({ people: [{ name: '', email: '' }], roleIds: [], scope, locale: 'it' }, [])).toEqual({ people: 'users.invite.nobody' })
  })

  it('a floor worker needs a name and a site, nothing more (GDPR art. 5(1)(c))', () => {
    expect(workerProblems({ displayName: ' ', locale: 'it', employeeCode: '', siteId: '', roleIds: [] })).toEqual({ displayName: 'form.required', siteId: 'form.required' })
    expect(workerProblems({ displayName: 'Anna', locale: 'it', employeeCode: '', siteId: SITES[0]!.id, roleIds: [] })).toEqual({})
  })

  it('the last administrator and one\'s own account are held before the click', () => {
    expect(isLastAdmin(USERS[1]!.id, USERS, ROLES)).toBe(false)
    const onlyBea = USERS.map((user) => (user.id === USERS[0]!.id ? { ...user, status: 'SUSPENDED' as const } : user))
    expect(isLastAdmin(USERS[1]!.id, onlyBea, ROLES)).toBe(true)
    const can = { suspend: true, reactivate: true, deactivate: true, resetPassword: true, assign: true }
    expect(lifecycleHeld({ user: USERS[1]!, me: DEMO_USER.id, lastAdmin: true, can })).toMatchObject({ suspend: 'user.held.lastAdmin', deactivate: 'user.held.lastAdmin', reactivate: 'user.held.notSuspended', password: null, assign: null })
    expect(lifecycleHeld({ user: USERS[0]!, me: DEMO_USER.id, lastAdmin: false, can })).toMatchObject({ suspend: 'user.held.self', assign: 'user.held.selfRoles' })
    expect(lifecycleHeld({ user: USERS[5]!, me: DEMO_USER.id, lastAdmin: false, can: { ...can, reactivate: false } }).reactivate).toBe('right.users_reactivate')
  })

  it('giving a role: the scope is needed, the end after the start; it raises when it gives more than the person holds', () => {
    expect(giveRoleProblems({ roleId: '', scope: { allCompanies: false, companyIds: [], siteIds: [] }, validFrom: '2026-11-02', validTo: '2026-11-01' })).toEqual({ roleId: 'form.required', scope: 'users.invite.scopeNeeded', validTo: 'user.give.endAfterStart' })
    // Sales adds quotes.manage, which neither live role (Planner, Finance) holds; the ended Sales role counts for nothing.
    expect(raises(ROLES[2]!.id, ASSIGNMENTS, ROLES)).toBe(true)
    expect(raises(ROLES[3]!.id, ASSIGNMENTS, ROLES)).toBe(false)
    expect(raises(ROLES[0]!.id, ASSIGNMENTS, ROLES)).toBe(true)
  })

  it('nobody manages their own worker', () => {
    expect(ownWorker({ ...WORKERS[0]!, userId: DEMO_USER.id }, DEMO_USER.id)).toBe(true)
    expect(ownWorker(WORKERS[0]!, DEMO_USER.id)).toBe(false)
  })
})

describe('SCR-012 roles', () => {
  it('office roles first, ready-made before custom; what a copy lacks of its template', () => {
    expect(roleRows(ROLES, '', 'all').map((role) => role.key).slice(0, 6)).toEqual(['admin', 'finance', 'owner', 'planner', 'sales', 'custom.sales_lead'])
    expect(roleRows(ROLES, '', 'floor')).toHaveLength(4)
    expect(templateGap(ROLES[5]!)).toEqual({ kind: 'adds', count: 1 })
    expect(templateGap(ROLES[4]!)).toEqual({ kind: 'outdated' })
    expect(templateGap(ROLES[3]!)).toBeNull()
  })

  it('a role in sentences: the areas it acts in; its holders with where', () => {
    expect(heldAreas(ROLES[3]!, CATALOGUE)).toEqual([
      { area: 'orders', count: 1, total: 1 },
      { area: 'workorders', count: 3, total: 3 },
    ])
    expect(holdersOf(ROLES[2]!, USERS).map((holder) => holder.user.displayName)).toEqual(['Carlo Prova', 'Elio Saggio'])
  })
})

describe('SCR-013 devices and printers', () => {
  const now = new Date(NOW).getTime()
  const sites = SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId, stations: [] }))
  it('tiles: seen in the last hour, not seen for a day, waiting, revoked; revoked ones only under their tile', () => {
    expect(DEVICES.filter((device) => deviceTileMatch('seenHour', device, now)).map((device) => device.name)).toEqual(['Tablet taglio 1', 'Tablet cucito 2'])
    expect(DEVICES.filter((device) => deviceTileMatch('notSeen', device, now)).map((device) => device.name)).toEqual(['Tablet taglio 2'])
    expect(deviceRows(DEVICES, null, '', sites, now).map((device) => device.name)).not.toContain('Tablet vecchio')
    expect(deviceRows(DEVICES, 'revoked', '', sites, now).map((device) => device.name)).toEqual(['Tablet vecchio'])
  })

  it('enrol and printer forms', () => {
    expect(enrolProblems({ siteId: '', stationId: '', name: ' ', kind: 'TABLET' })).toEqual({ siteId: 'form.required', name: 'form.required' })
    const draft = printerDraft(null, SITES[0]!.id)
    expect(printerProblems({ ...draft, code: 'LBL-CUT', name: 'X', relayTarget: 'host:9100' }, PRINTERS.map((printer) => printer.code), true)).toEqual({ code: 'form.codeTaken' })
    expect(printerProblems({ ...draft, code: 'NEW', name: 'X', relayTarget: 'host:9100', labelWidthMm: '50', dpi: '150' }, [], true)).toEqual({ labelWidthMm: 'printers.form.width', dpi: 'printers.form.dpi' })
    expect(printerBody({ ...printerDraft(PRINTERS[1]!, SITES[0]!.id) })).toEqual({ name: 'Stampante ufficio', relayTarget: 'office-printer', dpi: null, labelWidthMm: null, labelHeightMm: null })
  })
})

describe('SCR-165 the set-up checklist reads facts, never ticks', () => {
  const ok = <T,>(value: T) => ({ state: 'ok' as const, value })
  const facts: OverviewFacts = {
    me: DEMO_USER.id,
    companies: ok(COMPANIES),
    identities: ok([]),
    series: ok([]),
    users: ok([USERS[0]!]),
    roles: ok(ROLES),
    devices: ok([]),
    printers: ok([]),
    privacy: { state: 'no-right', need: 'privacy.view' },
  }
  it('every step in order, with its state and a link only to a page that exists', () => {
    const steps = setupSteps(facts, PREFIX, OFFICE_PAGES)
    expect(steps.map((step) => [step.id, step.state])).toEqual([
      ['legal', 'needs'],
      ['sites', 'needs'],
      ['mail', 'needs'],
      ['numbering', 'needs'],
      ['people', 'needs'],
      ['roles', 'needs'],
      ['tablets', 'needs'],
      ['printers', 'needs'],
      ['sdi', 'unknown'],
      ['privacy', 'unknown'],
      ['stock', 'unknown'],
    ])
    const byId = Object.fromEntries(steps.map((step) => [step.id, step]))
    expect(byId.legal!.href).toBe(`${PREFIX}/admin/companies/${COMPANIES[1]!.id}?tab=legal`)
    expect(byId.tablets!.href).toBe(`${PREFIX}/admin/devices?enrol=1`)
    // Mail, numbering and privacy pages come with B-W0-28: no "Do it" link to a page that does not exist.
    expect(byId.mail!.href).toBeUndefined()
    expect(byId.mail!.detail.key).toBe('overview.detail.mail.noneLater')
    expect(byId.privacy!.detail).toEqual({ key: 'overview.detail.noRight', need: 'right.privacy_view' })
  })

  it('done, waiting and failed are facts too', () => {
    const steps = setupSteps(
      {
        ...facts,
        identities: ok([{ domain: 'demo.example.com', ready: false, status: 'ACTIVE' }]),
        users: ok(USERS),
        devices: ok([{ status: 'PENDING' }]),
        printers: { state: 'failed', problem: 'problem.unavailable' },
        roles: ok([]),
      },
      PREFIX,
      OFFICE_PAGES,
    )
    const state = Object.fromEntries(steps.map((step) => [step.id, step.state]))
    expect(state).toMatchObject({ mail: 'waiting', people: 'done', tablets: 'waiting', printers: 'failed', roles: 'done' })
    expect(steps.find((step) => step.id === 'printers')!.detail).toEqual({ key: 'overview.detail.failed', need: 'problem.unavailable' })
    expect(setupSteps({ ...facts, companies: { state: 'checking' } }, PREFIX, OFFICE_PAGES).slice(0, 2).map((step) => step.state)).toEqual(['checking', 'checking'])
  })
})
