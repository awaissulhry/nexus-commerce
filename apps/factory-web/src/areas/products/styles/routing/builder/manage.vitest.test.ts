import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { departmentIconOf } from '../../../../../lib/department/icons'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { DEPT_ROWS } from '../route/fixtures'
import { deptLooksOf } from '../route/model'
import { MANAGE_RIGHT, manageRowsOf, mayManage, nameProblemOf, renameOf, withDepartment } from './manage'
import { refusalOf } from './model'
import { ManageDepartments, ManageSwitch, type ManageViewModel } from './view/ManageDepartments'

/**
 * owb-pd6 step 6.3 (S4; design plan § 5x) — Manage inside the route builder: the switch only for production.departments.manage, a floor
 * department (`floorReady`) has no rename and no lock ("on the floor"), a closed one opens again, the name rules (a name is needed,
 * the same name twice is refused, case not counted), and the server's refusals said in words. Written, not run (Owner rule).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const looks = deptLooksOf(DEPT_ROWS, 'en')
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['products-route'] ?? {}
const has = (locale: (typeof LOCALES)[number], key: string) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale))
const read = (file: string) => readFileSync(join(HERE, file), 'utf8')

const view = (over: Partial<ManageViewModel> = {}): ManageViewModel => ({ rows: manageRowsOf(looks, new Set()), drafts: {}, newName: '', addHeld: { key: 'manage.nameFirst' }, busy: false, problem: null, done: null, ...over })
const actions = { onDraft: () => undefined, onRename: () => undefined, onLock: () => undefined, onNewName: () => undefined, onAddDepartment: () => undefined, onAddToRoute: () => undefined }

describe('who sees Manage', () => {
  it('only production.departments.manage: the designer and sales have no switch', () => {
    expect(mayManage((permission) => permission === MANAGE_RIGHT)).toBe(true)
    expect(mayManage((permission) => permission === 'product.routing.manage')).toBe(false)
    expect(mayManage(() => false)).toBe(false)
  })

  it('the window draws the switch only with the right and a host that keeps the departments; the tab passes the right', () => {
    const window = read('RouteBuilderWindow.tsx')
    expect(window).toContain('const manageable = mayManage && onDepartments !== undefined')
    expect(window).toContain('manageSwitch={manageable ? <ManageSwitch on={manage} onChange={setManage} /> : undefined}')
    expect(window).toContain('manageable && manage ? (')
    expect(read('../route/RouteContainer.tsx')).toContain('mayManage={mayManage(can)}')
  })

  it('the switch is a real switch with its word', () => {
    const html = render(createElement(ManageSwitch, { on: false, onChange: () => undefined }))
    expect(html).toContain('role="switch"')
    expect(textOf(html)).toContain('Manage')
  })
})

describe('what each row allows', () => {
  const rows = manageRowsOf(looks, new Set(['dept-9']))

  it('a floor department keeps its name and has no lock; the others are renamed and close; a closed one opens again, is not renamed', () => {
    const cutting = rows.find((row) => row.id === 'dept-2')!
    expect(cutting).toMatchObject({ floorReady: true, rename: false, lock: false, add: true })
    expect(rows.find((row) => row.id === 'dept-7')).toMatchObject({ floorReady: false, rename: true, lock: true, add: true })
    expect(rows.find((row) => row.id === 'dept-9')!.fresh).toBe(true)
    const closed = manageRowsOf(deptLooksOf(DEPT_ROWS.map((row) => (row.id === 'dept-8' ? { ...row, status: 'CLOSED' as const } : row)), 'en'), new Set())
    expect(closed.find((row) => row.id === 'dept-8')).toMatchObject({ closed: true, rename: false, lock: true, add: false })
  })

  it('drawn: "on the floor" on the six, no name field and no lock on them; a lock and a name field on the three others', () => {
    const html = render(createElement(ManageDepartments, { model: view(), actions }))
    // The tag on each floor department (the hint above the list says the words once more).
    expect(html.match(/>on the floor</g)?.length).toBe(6)
    expect(html.match(/aria-label="Close the department /g)?.length).toBe(3)
    expect(html.match(/aria-label="The name of the department /g)?.length).toBe(3)
    expect(html).not.toContain('aria-label="Close the department Cutting"')
    expect(html).not.toContain('aria-label="The name of the department Cutting"')
    // Every open department may go into the route at once, a new one too.
    expect(html.match(/aria-label="Add [^"]+ to the route"/g)?.length).toBe(9)
  })

  it('Add is held with words until a name is typed', () => {
    const html = render(createElement(ManageDepartments, { model: view(), actions }))
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('Type the name of the new department first.')
  })
})

describe('the name rules and the refusals in words', () => {
  it('a name is needed; the same name twice is refused (long or short name, case not counted); a department may keep its own', () => {
    expect(nameProblemOf('   ', looks, null)).toEqual({ key: 'refusal.NAME_EMPTY' })
    expect(nameProblemOf('cutting', looks, null)).toEqual({ key: 'refusal.NAME_TAKEN' })
    expect(nameProblemOf('PRODUCT DESIGN', looks, null)).toEqual({ key: 'refusal.NAME_TAKEN' })
    expect(nameProblemOf('Design', looks, 'dept-7')).toBeNull()
    expect(nameProblemOf('Embroidery', looks, null)).toBeNull()
  })

  it('the server\'s refusals (NAME_EMPTY, NAME_TAKEN, FLOOR_FIXED, a stale version) are said in this web\'s words, in both languages', () => {
    expect(refusalOf({ kind: 'invalid', code: 'validation_failed', issues: [{ code: 'NAME_EMPTY' }] })).toEqual({ key: 'refusal.NAME_EMPTY' })
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'name/NAME_TAKEN' }] })).toEqual({ key: 'refusal.NAME_TAKEN' })
    expect(refusalOf({ kind: 'conflict', code: 'FLOOR_FIXED' })).toEqual({ key: 'refusal.FLOOR_FIXED' })
    expect(refusalOf({ kind: 'conflict', code: 'conflict' })).toEqual({ key: 'problem.conflict' })
    // pd1 (PR #2054) puts the code at `refusal/<code>`; a closed department is opened before a rename; the DEPT-n code may be taken.
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'refusal/CLOSED' }] })).toEqual({ key: 'refusal.CLOSED' })
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'refusal/CODE_TAKEN' }] })).toEqual({ key: 'refusal.CODE_TAKEN' })
    for (const locale of LOCALES) for (const key of ['refusal.NAME_EMPTY', 'refusal.NAME_TAKEN', 'refusal.FLOOR_FIXED', 'refusal.CLOSED', 'refusal.CODE_TAKEN', 'problem.conflict']) expect(has(locale, key), `${locale} ${key}`).toBe(true)
  })

  it('a refusal is shown under the list in words', () => {
    const html = render(createElement(ManageDepartments, { model: view({ problem: { key: 'refusal.NAME_TAKEN' } }), actions }))
    expect(textOf(html)).toContain('This name is used by another department.')
    const italian = render(createElement(ManageDepartments, { model: view({ problem: { key: 'refusal.FLOOR_FIXED' } }), actions }), 'it')
    expect(textOf(italian)).toContain('il nome resta e non si può chiudere')
  })
})

describe('what is sent and kept', () => {
  it('a rename: in English the base name and its short name; in Italian the Italian name, the others kept', () => {
    const row = { ...DEPT_ROWS[0]!, nameI18n: { ur: 'ڈیزائن' } }
    expect(renameOf(row, '  Product development  ', 'en')).toEqual({ name: 'Product development', shortName: 'Product development' })
    expect(renameOf(row, 'Sviluppo prodotto', 'it')).toEqual({ nameI18n: { ur: 'ڈیزائن', it: 'Sviluppo prodotto' } })
  })

  it('the server\'s answer replaces the department where it was, or adds a new one, in the factory\'s order', () => {
    const renamed = withDepartment(DEPT_ROWS, { ...DEPT_ROWS[0]!, name: 'Product development', shortName: 'Development', version: 2 })
    expect(renamed).toHaveLength(9)
    expect(renamed[0]).toMatchObject({ id: 'dept-7', shortName: 'Development', version: 2 })
    const added = withDepartment(DEPT_ROWS, { id: 'dept-10', number: 10, name: 'Embroidery', shortName: 'Embroidery', tone: 'red', icon: 'circle-dot', status: 'ACTIVE', workCentreKind: 'ASSEMBLY', floorReady: false, seq: 10, version: 1 })
    expect(added.at(-1)!.id).toBe('dept-10')
  })

  it('a department made here gets the server\'s icon circle-dot: the chip draws it (S4 settle 7)', () => {
    expect(departmentIconOf('circle-dot')).not.toBeNull()
  })
})

describe('words', () => {
  it('every key Manage names exists in both languages', () => {
    const sources = ['manage.ts', 'view/ManageDepartments.tsx', 'RouteBuilderWindow.tsx'].map(read).join('\n')
    const keys = [...sources.matchAll(/['"`]((?:manage|refusal|builder|held)\.[A-Za-z_.]+[A-Za-z_])['"`]/g)].map((match) => match[1]!)
    const named = [...new Set([...keys, 'manage.done.added', 'manage.done.renamed', 'manage.done.closed', 'manage.done.opened'])]
    expect(named.length).toBeGreaterThan(15)
    for (const locale of LOCALES) expect(named.filter((key) => !has(locale, key)), locale).toEqual([])
  })
})
