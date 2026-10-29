import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { ApiError } from '../../lib/api/errors'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES, type Locale } from '../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { DEMO_USER } from '../../shell/design-data'
import { companySiteColumns, orgColumns } from './companies/view/columns'
import { treeRows } from './companies/model'
import { printerReach, revokeReach } from './devices/model'
import { designScreen as devicesScreen } from './devices/fixtures'
import { deviceColumns, printerColumns } from './devices/view/columns'
import { compareHeld, holdersOf } from './roles/model'
import { designScreen as rolesScreen } from './roles/fixtures'
import { holderColumns, roleColumns } from './roles/view/columns'
import { runBulk } from './shared/bulk'
import { bulkNotice, namesLine, reachOf } from './shared/reach'
import { ASSIGNMENTS, CENTRES, COMPANIES, DEVICES, LINES, NOW, PREFIX, PRINTERS, ROLES, SITES, STATIONS, USERS, WORKERS } from './shared/fixtures'
import type { Notice } from './shared/model'
import { StepUpCancelled } from './shared/step-up'
import { useRoleWords } from './shared/view/parts'
import { structureRows } from './sites/model'
import { centreColumns, sitePrinterColumns, structureColumns, tabletColumns } from './sites/view/columns'
import { designScreen as usersScreen } from './users/fixtures'
import { floorReach, officeReach, type UsersAbilities } from './users/model'
import { endReach } from './users/record/model'
import { designScreen as recordScreen } from './users/record/fixtures'
import { assignmentColumns } from './users/record/view/columns'
import { floorColumns, officeColumns } from './users/view/columns'

/**
 * The Admin lists on the shared list frame (Owner rule 2026-10-29). AG Grid draws cells only in a browser, so each
 * list's cells are drawn here alone from its exported column builder, in both languages, with no key left on screen;
 * then the bulk actions: which ticked rows each action reaches, why it is held, the run (one call per row, in order,
 * a refusal kept, a closed code dialog stops it) and its one notice.
 */

const LEFT_KEY = /\b(?:common|problem|stepUp|list|lists|record|noAccess|grains|scope|reveal|matrix|form|held|right|nav|overview|org|company|site|users|user|worker|roles|role|devices|device|printers|keys)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const translator = (locale: Locale) => createTranslator(locale, CATALOGUE[locale].admin ?? {})
const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const siteOptions = SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId }))
const siteChoices = SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId, stations: site.id === SITES[0]!.id ? STATIONS.map((station) => ({ id: station.id, code: station.code, name: station.name })) : [] }))
const structure = { site: SITES[0]!, company: { id: COMPANIES[0]!.id, code: 'DEMO', legalName: COMPANIES[0]!.legalName }, lines: LINES, workCentres: CENTRES, stations: STATIONS }
type Words = ReturnType<typeof useRoleWords>

/** One cell as the grid would draw it: its renderer with the row, or the text its value getter gives. */
function cellNode<T>(column: ColDef<T>, row: T): ReactNode {
  const renderer = column.cellRenderer
  if (renderer && typeof renderer !== 'string') {
    const extra = typeof column.cellRendererParams === 'function' ? column.cellRendererParams({ data: row } as never) : (column.cellRendererParams ?? {})
    return createElement(renderer as ComponentType<Record<string, unknown>>, { ...extra, data: row, value: undefined })
  }
  const value = typeof column.valueGetter === 'function' ? column.valueGetter({ data: row } as never) : undefined
  return value === null || value === undefined ? '' : String(value)
}

function Cells<T>({ build, rows }: { build: (words: Words) => ColDef<T>[]; rows: readonly T[] }) {
  const columns = build(useRoleWords())
  return createElement(
    'table',
    null,
    createElement('thead', null, createElement('tr', null, ...columns.map((column, index) => createElement('th', { key: index }, column.headerName ?? '')))),
    createElement('tbody', null, ...rows.map((row, r) => createElement('tr', { key: r }, ...columns.map((column, c) => createElement('td', { key: c, 'data-col': column.colId }, cellNode(column, row)))))),
  )
}

function draw<T>(locale: Locale, build: (words: Words) => ColDef<T>[], rows: readonly T[]): string {
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['admin', 'records', 'lists', 'shell']) }, createElement(Cells<T>, { build, rows })))
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const LISTS = (locale: Locale) => {
  const t = translator(locale)
  return {
    office: draw(locale, (words) => officeColumns({ t, locale, prefix: PREFIX, roleName: words.name, roles: ROLES, companies, sites: siteOptions }), USERS),
    floor: draw(locale, (words) => floorColumns({ t, locale, prefix: PREFIX, roleName: words.name, roles: ROLES, companies, sites: siteOptions }), WORKERS),
    org: draw(locale, () => orgColumns({ t, prefix: PREFIX, viewSites: true }), treeRows(COMPANIES, '', [], true)),
    companySites: draw(locale, () => companySiteColumns({ t, prefix: PREFIX, companyId: COMPANIES[0]!.id }), SITES),
    structure: draw(locale, () => structureColumns({ t, structure, manage: true, open: () => undefined }), structureRows(structure, true)),
    centres: draw(locale, () => centreColumns({ t, structure, manage: true, open: () => undefined }), CENTRES),
    tablets: draw(locale, () => tabletColumns({ t, locale, prefix: PREFIX, structure }), DEVICES),
    sitePrinters: draw(locale, () => sitePrinterColumns({ t }), PRINTERS),
    roles: draw(locale, (words) => roleColumns({ t, prefix: PREFIX, words, roles: ROLES }), ROLES),
    holders: draw(locale, () => holderColumns({ t, locale, prefix: PREFIX, companies }), holdersOf(ROLES[2]!, USERS)),
    assignments: draw(locale, (words) => assignmentColumns({ t, locale, prefix: PREFIX, companies, roleName: words.name }), ASSIGNMENTS),
    devices: draw(locale, () => deviceColumns({ t, locale, prefix: PREFIX, sites: siteChoices, now: new Date(NOW).getTime() }), DEVICES),
    printers: draw(locale, () => printerColumns({ t, sites: siteChoices, onEdit: () => undefined }), PRINTERS),
  }
}

describe('every list cell draws alone, in both languages, with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`${locale}: 13 lists, every row, every column`, () => {
      for (const [list, html] of Object.entries(LISTS(locale))) {
        expect(html.length, list).toBeGreaterThan(300)
        expect(text(html).match(LEFT_KEY)?.[0] ?? null, `${list} (${locale})`).toBeNull()
      }
    })
  }

  const en = LISTS('en')
  it('the main cell is a real link to the record (⌘-click opens a tab); a tree keeps its levels', () => {
    expect(en.office).toContain(`href="${PREFIX}/admin/users/${USERS[2]!.id}"`)
    expect(en.floor).toContain(`href="${PREFIX}/admin/users/floor/${WORKERS[0]!.id}"`)
    expect(en.roles).toContain(`href="${PREFIX}/admin/roles/${ROLES[3]!.id}"`)
    expect(en.devices).toContain(`href="${PREFIX}/admin/devices/${DEVICES[0]!.id}"`)
    expect(en.org).toContain(`href="${PREFIX}/admin/companies/${COMPANIES[0]!.id}/sites/${SITES[0]!.id}"`)
    expect(en.org).toContain(`aria-label="Hide the sites of ${COMPANIES[0]!.legalName}"`)
    expect(text(en.org)).toContain('No stations')
    expect(text(en.structure)).toMatch(/Linea cucito 1 2 stations/)
    expect(en.structure).toContain('fw-adm-tree-child')
    expect(en.structure).toContain('aria-label="More for Linea cucito 1"')
    expect(en.holders).toContain(`href="${PREFIX}/admin/users/${USERS[2]!.id}?tab=roles"`)
  })

  it('money sight is said in words, not colour alone (GrainChips in a cell)', () => {
    expect(text(en.office)).toContain('does not see')
    expect(text(en.office)).toContain('margin')
    expect(text(en.roles)).toContain('Ready-made')
    expect(text(en.roles)).toContain('1 permission not in your copy')
  })

  it('a device says "In use", never who; a worker shows only the last 4 of a badge', () => {
    for (const html of [en.devices, en.tablets]) {
      expect(text(html)).toContain('In use')
      expect(text(html)).not.toMatch(/Anna Demo|Bruno Esempio/)
    }
    expect(text(en.floor)).toContain(`•••• ${WORKERS[0]!.badge!.hint}`)
    expect(text(en.floor)).toContain('No. M-101')
    expect(text(en.devices)).toContain('Not seen for 24 h')
  })

  it('roles, printers: their state in words', () => {
    expect(text(en.assignments)).toMatch(/Live.*Ended/)
    expect(text(en.printers)).toContain('100 × 50 mm')
    expect(text(en.printers)).toContain('Paused')
  })
})

describe('runBulk: one call per row, in order; a refusal is kept; a closed code dialog stops the run', () => {
  it('runs each item after the one before, and sorts done from refused (in the page words)', async () => {
    const calls: string[] = []
    const result = await runBulk(['a', 'b', 'c'], async (item) => {
      calls.push(`start ${item}`)
      await new Promise((resolve) => setTimeout(resolve, item === 'a' ? 5 : 0))
      calls.push(`end ${item}`)
      if (item === 'b') throw new ApiError('conflict', 409, 'conflict', 'stale version')
    })
    expect(calls).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(result).toEqual({ done: ['a', 'c'], refused: [{ item: 'b', problem: 'problem.conflict' }] })
    expect((await runBulk([1], () => Promise.reject(new Error('boom')))).refused).toEqual([{ item: 1, problem: 'problem.internal' }])
    expect(await runBulk([], () => Promise.resolve())).toEqual({ done: [], refused: [] })
  })

  it('a StepUpCancelled is thrown at once: no later row is called', async () => {
    const calls: number[] = []
    await expect(
      runBulk([1, 2, 3], async (item) => {
        calls.push(item)
        if (item === 2) throw new StepUpCancelled()
      }),
    ).rejects.toBeInstanceOf(StepUpCancelled)
    expect(calls).toEqual([1, 2])
  })

  it('one notice: all done (success), some refused (warning, each by name), none done (danger)', () => {
    const name = (item: { name: string }) => item.name
    expect(bulkNotice({ done: [{ name: 'A' }, { name: 'B' }], refused: [] }, 'users.bulk.done.suspend', name)).toEqual({ key: 'users.bulk.done.suspend', tone: 'success', params: { count: 2 } })
    expect(bulkNotice({ done: [{ name: 'A' }], refused: [{ item: { name: 'B' }, problem: 'problem.conflict' }] }, 'users.bulk.done.suspend', name)).toEqual({
      key: 'users.bulk.done.suspend',
      tone: 'warning',
      params: { count: 1 },
      refused: [{ name: 'B', problem: 'problem.conflict' }],
    })
    expect(bulkNotice({ done: [], refused: [{ item: { name: 'B' }, problem: 'problem.forbidden' }] }, 'users.bulk.done.suspend', name).tone).toBe('danger')
  })

  it('the reach: the rows an action applies to; held by a rule whatever the rows, or because none applies', () => {
    expect(reachOf([1, 2, 3], (n) => n > 1, { none: 'x.none' })).toEqual({ items: [2, 3], held: null, skipped: 1 })
    expect(reachOf([1], (n) => n > 1, { none: 'x.none' })).toEqual({ items: [], held: 'x.none', skipped: 1 })
    expect(reachOf([2], (n) => n > 1, { held: 'right.users_suspend', none: 'x.none' })).toEqual({ items: [], held: 'right.users_suspend', skipped: 1 })
    expect(namesLine(['A', 'B'], (count) => `and ${count} more`)).toBe('A, B')
    expect(namesLine(['A', 'B', 'C', 'D', 'E', 'F', 'G'], (count) => `and ${count} more`)).toBe('A, B, C, D, E and 2 more')
  })
})

describe('each list: which ticked rows a bulk action reaches, and why it is held', () => {
  const CAN: UsersAbilities = { viewUsers: true, invite: true, assign: true, viewWorkers: true, manageWorkers: true, workerRoles: true, suspend: true, reactivate: true, deactivate: true }
  const office = { me: DEMO_USER.id, can: CAN, users: USERS, roles: ROLES }
  const names = (rows: ReadonlyArray<{ displayName: string }>) => rows.map((row) => row.displayName)

  it('office people: Suspend 2, Reactivate 1, Deactivate 3 for two active and one suspended', () => {
    const picked = [USERS[2]!, USERS[3]!, USERS[5]!]
    expect(names(officeReach('suspend', picked, office).items)).toEqual(['Carlo Prova', 'Dora Campione'])
    expect(officeReach('suspend', picked, office).skipped).toBe(1)
    expect(names(officeReach('reactivate', picked, office).items)).toEqual(['Fabia Modello'])
    expect(names(officeReach('deactivate', picked, office).items)).toEqual(['Carlo Prova', 'Dora Campione', 'Fabia Modello'])
  })

  it('never oneself or the last administrator; an invited person is deactivated, not suspended; held reasons', () => {
    const meAndInvited = [USERS[0]!, USERS[4]!]
    expect(officeReach('suspend', meAndInvited, office)).toMatchObject({ items: [], held: 'users.bulk.held.suspend' })
    expect(officeReach('reactivate', meAndInvited, office)).toMatchObject({ items: [], held: 'users.bulk.held.reactivate' })
    expect(names(officeReach('deactivate', meAndInvited, office).items)).toEqual(['Elio Saggio'])
    const onlyBea = USERS.map((user) => (user.id === USERS[0]!.id ? { ...user, status: 'SUSPENDED' as const } : user))
    expect(officeReach('suspend', [USERS[1]!], { ...office, users: onlyBea })).toMatchObject({ items: [], held: 'users.bulk.held.suspend' })
    expect(officeReach('deactivate', [USERS[6]!], office)).toMatchObject({ items: [], held: 'users.bulk.held.deactivate' })
    expect(officeReach('suspend', [USERS[2]!], { ...office, can: { ...CAN, suspend: false } }).held).toBe('right.users_suspend')
    expect(officeReach('reactivate', [USERS[5]!], { ...office, can: { ...CAN, reactivate: false } }).held).toBe('right.users_reactivate')
    expect(officeReach('deactivate', [USERS[2]!], { ...office, can: { ...CAN, deactivate: false } }).held).toBe('right.users_deactivate')
  })

  it('floor workers: deactivate the active ones, reactivate the inactive ones; workers.manage needed', () => {
    const picked = [WORKERS[0]!, WORKERS[1]!, WORKERS[5]!]
    expect(names(floorReach('deactivate', picked, CAN).items)).toEqual(['Anna Demo', 'Bruno Esempio'])
    expect(names(floorReach('reactivate', picked, CAN).items)).toEqual(['Flavia Modello'])
    expect(floorReach('reactivate', [WORKERS[0]!], CAN).held).toBe('users.bulk.held.workerReactivate')
    expect(floorReach('deactivate', [WORKERS[5]!], CAN).held).toBe('users.bulk.held.workerDeactivate')
    expect(floorReach('deactivate', picked, { ...CAN, manageWorkers: false }).held).toBe('right.workers_manage')
  })

  it('roles: Compare takes two or three ticked roles', () => {
    expect([0, 1, 2, 3, 4].map(compareHeld)).toEqual(['roles.bulk.held.compareOne', 'roles.bulk.held.compareOne', null, null, 'roles.bulk.held.compareMany'])
  })

  it("a person's roles: End reaches the live ones; never one's own; roles.assign needed", () => {
    const can = { suspend: true, reactivate: true, deactivate: true, resetPassword: true, assign: true }
    const record = { user: USERS[3]!, me: DEMO_USER.id, lastAdmin: false, can }
    expect(endReach(ASSIGNMENTS, record)).toMatchObject({ items: [ASSIGNMENTS[0], ASSIGNMENTS[1]], held: null, skipped: 1 })
    expect(endReach([ASSIGNMENTS[2]!], record).held).toBe('user.bulk.held.end')
    expect(endReach([ASSIGNMENTS[0]!], { ...record, user: USERS[0]! }).held).toBe('user.held.selfRoles')
    expect(endReach([ASSIGNMENTS[0]!], { ...record, can: { ...can, assign: false } }).held).toBe('right.roles_assign')
  })

  it('devices: Revoke reaches every device not revoked yet; printers: Pause the active, Resume the paused', () => {
    const can = { manage: true, revoke: true, viewPrinters: true, managePrinters: true }
    expect(revokeReach(DEVICES, can).items.map((device) => device.name)).toEqual(['Tablet taglio 1', 'Tablet taglio 2', 'Tablet cucito 2', 'Lettore magazzino'])
    expect(revokeReach([DEVICES[4]!], can).held).toBe('devices.bulk.held.revoke')
    expect(revokeReach(DEVICES, { ...can, revoke: false }).held).toBe('right.devices_revoke')
    expect(printerReach('pause', PRINTERS, can).items.map((printer) => printer.code)).toEqual(['LBL-CUT', 'LBL-MAG'])
    expect(printerReach('resume', PRINTERS, can).items.map((printer) => printer.code)).toEqual(['A4-UFF'])
    expect(printerReach('resume', [PRINTERS[0]!], can).held).toBe('printers.bulk.held.resume')
    expect(printerReach('pause', PRINTERS, { ...can, managePrinters: false }).held).toBe('right.print_manage')
  })
})

describe('the design cases show the selection bar with each reach, and the one result notice', () => {
  const html = (screen: DesignScreen<unknown>, id: string, locale: Locale = 'en') => {
    const View = screen.view as ComponentType<{ model: unknown }>
    const model = screen.cases.find((item) => item.id === id)!.model
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  const render = (screen: DesignScreen<unknown>, id: string, locale: Locale = 'en') => text(html(screen, id, locale))
  it('users: three ticked → Suspend 2 · Reactivate 1 · Deactivate 3; held with the reason', () => {
    const picked = render(usersScreen as DesignScreen<unknown>, 'office-selected')
    expect(picked).toContain('3 selected')
    expect(picked).toMatch(/Suspend 2.*Reactivate 1.*Deactivate 3/)
    expect(picked).not.toContain('Search people')
    const held = html(usersScreen as DesignScreen<unknown>, 'office-selected-held')
    expect(text(held)).toContain('Deactivate 1')
    // A held action stays focusable and says why (DS Button heldReason: aria-description and its tooltip).
    expect(held).toContain('aria-description="None of the selected is suspended."')
    expect(render(usersScreen as DesignScreen<unknown>, 'floor-selected')).toContain('Deactivate 2')
    expect(render(usersScreen as DesignScreen<unknown>, 'office-selected', 'it')).toMatch(/Sospendi 2.*Riattiva 1.*Disattiva 3/)
  })

  it('the run says how many were done and names each refused row with its problem', () => {
    const result = render(usersScreen as DesignScreen<unknown>, 'office-bulk-result')
    expect(result).toContain('1 person suspended · 1 refused')
    expect(result).toContain('Dora Campione —')
    const notice: Notice = (usersScreen.cases.find((item) => item.id === 'office-bulk-result')!.model as { notice: Notice }).notice
    expect(notice.refused).toHaveLength(1)
  })

  it('roles: Compare 2; one ticked holds it; the record: End 2; devices: Revoke 3; printers: Pause 2 · Resume 1', () => {
    expect(render(rolesScreen as DesignScreen<unknown>, 'compare-selected')).toContain('Compare 2')
    expect(html(rolesScreen as DesignScreen<unknown>, 'compare-one')).toContain('aria-description="Tick a second role to compare (two or three)."')
    expect(render(recordScreen as DesignScreen<unknown>, 'roles-selected')).toContain('End 2 roles')
    expect(render(recordScreen as DesignScreen<unknown>, 'roles-selected-ended')).toContain('End 1 role')
    expect(render(devicesScreen as DesignScreen<unknown>, 'devices-selected')).toContain('Revoke 3')
    expect(render(devicesScreen as DesignScreen<unknown>, 'printers-selected')).toMatch(/Pause 2.*Resume 1/)
  })
})
