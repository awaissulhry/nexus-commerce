import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { fixedDepartments } from '../../../../../lib/department/model'
import { departmentWordsFor } from '../../../../../lib/department/words'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { RouteView, type RouteViewModel } from '../view/RouteView'
import { routeRouting } from './api'
import { CUSTOMER_ROUTE, DEPT_ROWS, demoRouteRouting, MODEL_ROUTE } from './fixtures'
import {
  answerOf,
  chosenRouteOf,
  deptLooksOf,
  forWhomOf,
  mayOpenBuilder,
  problemKeyOf,
  routeChipsOf,
  routeEditHeld,
  routeRowsOf,
  ruleNotesOf,
  rulesOfChosen,
  stepDepartment,
  totalMinutesOf,
  type RouteEditFacts,
} from './model'

/**
 * owb-pd6 step 6.1 (S4; design plan § 5u, § 5v) — the Route tab's model: the chips come from the revision's routes, the steps table of
 * the chosen route (department chip by id, else by number), the minutes of one piece, the rules as notes, and the builder's doors:
 * held on a RELEASED revision with words ("Start revision n to change the route"), never open without product.routing.manage.
 * Written, not run (Owner rule: checks at the end). Made-up data only.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const fixed = fixedDepartments(departmentWordsFor('en'))
const looks = deptLooksOf(DEPT_ROWS, 'en')
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['products-route'] ?? {}
const has = (locale: (typeof LOCALES)[number], key: string) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale))

const facts = (over: Partial<RouteEditFacts> = {}): RouteEditFacts => ({
  manage: true,
  styleStatus: 'ACTIVE',
  revision: { revision: 3, status: 'DRAFT' },
  draft: null,
  highest: 3,
  busy: false,
  departments: 'ready',
  ...over,
})

describe('the chips come from the routes', () => {
  it('"Product route" first, then one chip per model or customer route, the chosen one pressed', () => {
    const routing = demoRouteRouting()
    expect(routeChipsOf(routing, null).map((chip) => [chip.kind, chip.name, chip.pressed])).toEqual([
      ['PRODUCT', '', true],
      ['MODEL', 'With molded sliders', false],
      ['CUSTOMER', 'Brand Alpha checks twice', false],
    ])
    expect(routeChipsOf(routing, CUSTOMER_ROUTE.id).map((chip) => chip.pressed)).toEqual([false, false, true])
    expect(routeChipsOf(routing, CUSTOMER_ROUTE.id)[2]!.party).toEqual({ id: 'party-alpha', code: 'ALPHA', name: 'Brand Alpha' })
  })

  it('before the server\'s routes wave (no `routes`) only the product\'s route; a chosen route that is gone falls back to it', () => {
    const before = demoRouteRouting({ routes: undefined })
    expect(routeChipsOf(before, null).map((chip) => chip.kind)).toEqual(['PRODUCT'])
    expect(chosenRouteOf(before, MODEL_ROUTE.id)).toBeNull()
    expect(routeChipsOf(before, MODEL_ROUTE.id)[0]!.pressed).toBe(true)
  })

  it('the read keeps working on today\'s answer: no rules, no routes, no department on a step', () => {
    const today = { routing: { revision: { id: 'r', revision: 2, status: 'RELEASED', version: 4 }, editable: false, steps: [{ id: 's', seq: 10, code: 'CUC-MAN', name: 'Sleeves', workCentreKind: 'SEWING', standardMinutes: '17', extra: 'unknown field' }] } }
    const parsed = routeRouting.parse(today.routing)
    expect(parsed.routes).toBeUndefined()
    expect(routeRowsOf(parsed, null, looks, fixed)).toEqual([{ no: 1, dept: null, name: 'Sleeves', minutes: '17' }])
  })

  it('who the chosen route is for, and the answer line', () => {
    expect(forWhomOf(null)).toEqual({ key: 'routes.forProduct' })
    expect(forWhomOf(MODEL_ROUTE)).toEqual({ key: 'routes.forModel' })
    expect(forWhomOf(CUSTOMER_ROUTE)).toEqual({ key: 'routes.forCustomer', params: { customer: 'ALPHA · Brand Alpha' } })
    expect(forWhomOf({ ...MODEL_ROUTE, party: { id: 'p', code: 'BETA', name: 'Brand Beta' } })).toEqual({ key: 'routes.forModelOnly', params: { customer: 'BETA · Brand Beta' } })
    expect(answerOf(demoRouteRouting())).toEqual([
      { key: 'routes.answerSteps', params: { count: 6 } },
      { key: 'routes.answerOthers', params: { count: 2 } },
    ])
    expect(answerOf(demoRouteRouting({ routes: [] }))).toHaveLength(1)
  })
})

describe('the steps table', () => {
  it('the product\'s route: its steps in order, each with its department chip and minutes; the minutes of one piece', () => {
    const rows = routeRowsOf(demoRouteRouting(), null, looks, fixed)
    expect(rows.map((row) => [row.no, row.dept?.shortName, row.minutes])).toEqual([
      [1, 'Pattern', '30'],
      [2, 'Cutting', '40'],
      [3, 'Patch & print', '40.5'],
      [4, 'Stitching', '60'],
      [5, 'Quality', '15'],
      [6, 'Packing', '8'],
    ])
    expect(totalMinutesOf(rows)).toBe('193.5')
  })

  it('a model or customer route: its own steps; a department may be there twice; a step without minutes is left out of the sum', () => {
    const rows = routeRowsOf(demoRouteRouting(), CUSTOMER_ROUTE, looks, fixed)
    expect(rows.map((row) => row.dept?.no)).toEqual([2, 4, 5, 5, 6])
    expect(totalMinutesOf(rows)).toBe('125')
    expect(totalMinutesOf([{ minutes: null }, { minutes: '' }])).toBeNull()
    expect(totalMinutesOf([{ minutes: '0.1' }, { minutes: '0.2' }])).toBe('0.3')
  })

  it('a department by its id, else by its number (the rows, then the fixed table of the nine), else none', () => {
    expect(stepDepartment(looks, 'dept-8', 8, fixed)?.shortName).toBe('Molding')
    expect(stepDepartment([], 'dept-8', 8, fixed)?.shortName).toBe('Molding')
    expect(stepDepartment(looks, 'gone', 40, fixed)).toBeNull()
    expect(stepDepartment(looks, null, null, fixed)).toBeNull()
  })

  it('the departments in the factory\'s ONE order, with what the builder asks (kind, on the floor, closed, version)', () => {
    expect(looks.map((look) => look.dept.shortName)).toEqual(['Design', 'Pattern', 'Cutting', 'Molding', 'Patch & print', 'Stitching', 'Assembly', 'Quality', 'Packing'])
    expect(looks.find((look) => look.id === 'dept-6')).toMatchObject({ kind: 'PACKING', floorReady: true, closed: false, version: 1 })
    expect(deptLooksOf([{ ...DEPT_ROWS[0]!, status: 'CLOSED' }], 'en')[0]!.closed).toBe(true)
  })
})

describe('the rules as notes', () => {
  it('errors and warnings of the chosen route become words; a code this web does not know says so plainly', () => {
    const routing = demoRouteRouting({ rules: { errors: ['LAST_NOT_PACKING', 'SOMETHING_NEW'], warnings: ['NO_QUALITY', 'LATER'] } })
    expect(ruleNotesOf(rulesOfChosen(routing, null))).toEqual({ errors: ['rule.LAST_NOT_PACKING', 'rule.other'], warnings: ['rule.NO_QUALITY', 'rule.otherWarning'] })
    expect(ruleNotesOf(rulesOfChosen(routing, MODEL_ROUTE))).toEqual({ errors: [], warnings: ['rule.NO_QUALITY'] })
    expect(ruleNotesOf(undefined)).toEqual({ errors: [], warnings: [] })
  })
})

describe('the builder\'s doors: who, and why not', () => {
  it('a draft revision with the right: nothing holds the builder', () => {
    expect(routeEditHeld(facts())).toBeNull()
    expect(mayOpenBuilder(facts())).toBe(true)
  })

  it('no builder without product.routing.manage (the designer and sales never open it): held with words', () => {
    expect(routeEditHeld(facts({ manage: false }))).toEqual({ key: 'held.noRight' })
    expect(mayOpenBuilder(facts({ manage: false }))).toBe(false)
    // The right wins over every other reason: the person learns first that it is not theirs.
    expect(routeEditHeld(facts({ manage: false, revision: { revision: 2, status: 'RELEASED' } }))).toEqual({ key: 'held.noRight' })
  })

  it('a RELEASED revision is read only: "Start revision n to change the route", or the draft that is open', () => {
    expect(routeEditHeld(facts({ revision: { revision: 2, status: 'RELEASED' }, highest: 2 }))).toEqual({ key: 'held.released', params: { revision: 2, next: 3 } })
    expect(routeEditHeld(facts({ revision: { revision: 2, status: 'RELEASED' }, draft: { revision: 3 } }))).toEqual({ key: 'held.draftOpen', params: { revision: 2, draft: 3 } })
    expect(mayOpenBuilder(facts({ revision: { revision: 2, status: 'RELEASED' } }))).toBe(false)
    for (const locale of LOCALES) expect(words(locale)['held.released'], locale).toContain('{next}')
  })

  it('an archived product, a write running, the departments not read: each holds with its words', () => {
    expect(routeEditHeld(facts({ styleStatus: 'ARCHIVED' }))).toEqual({ key: 'held.archived' })
    expect(routeEditHeld(facts({ busy: true }))).toEqual({ key: 'held.busy' })
    expect(routeEditHeld(facts({ departments: 'reading' }))).toEqual({ key: 'held.departmentsReading' })
    expect(routeEditHeld(facts({ departments: 'failed' }))).toEqual({ key: 'held.departmentsFailed' })
    expect(routeEditHeld(facts({ revision: null }))).toEqual({ key: 'held.noRevision' })
  })

  it('a failed call is a problem key, never the API\'s English', () => {
    expect(problemKeyOf({ kind: 'forbidden' })).toBe('problem.forbidden')
    expect(problemKeyOf({ kind: 'conflict' })).toBe('problem.conflict')
    expect(problemKeyOf({ kind: 'unavailable' })).toBe('problem.offline')
    expect(problemKeyOf(new Error('boom'))).toBe('problem.unavailable')
  })
})

describe('the face draws its model', () => {
  const ready = (over: Partial<RouteViewModel> = {}): RouteViewModel => {
    const routing = demoRouteRouting()
    const rows = routeRowsOf(routing, null, looks, fixed)
    return { state: 'ready', problem: null, chips: routeChipsOf(routing, null), chosen: null, rows, total: totalMinutesOf(rows), notes: ruleNotesOf(routing.rules), answer: answerOf(routing), forWhom: forWhomOf(null), held: null, start: null, busy: false, actProblem: null, ...over }
  }
  const actions = { onChoose: () => undefined, onEdit: () => undefined, onNew: () => undefined, onTakeOut: () => undefined, onRetry: () => undefined }

  it('chips, the steps with their department chips, the minutes of one piece, the doors, who decides the route', () => {
    const html = render(createElement(RouteView, { model: ready(), actions }))
    const text = textOf(html)
    for (const part of ['Product route', 'With molded sliders', 'Brand Alpha checks twice', 'Edit this route…', 'New route…', '193.5 minutes for one piece.', 'Who decides the route', '1 · The product', '3 · One order line']) expect(text, part).toContain(part)
    expect(html.match(/class="fw-dept-chip /g)?.length).toBe(6)
    expect(html).toContain('aria-pressed="true"')
    // "Take out" only for a chosen model or customer route.
    expect(text).not.toContain('Take out')
    expect(textOf(render(createElement(RouteView, { model: ready({ chosen: MODEL_ROUTE }), actions })))).toContain('Take out')
  })

  it('a released revision: the doors stay and say why; "Start revision n…" when offered', () => {
    const held = { key: 'held.released', params: { revision: 2, next: 3 } }
    const html = render(createElement(RouteView, { model: ready({ held, start: { next: 3 } }), actions: { ...actions, onStartRevision: () => undefined } }))
    expect(html).toContain('aria-disabled="true"')
    expect(textOf(html)).toContain('Revision 2 is released. Start revision 3 to change the route.')
    expect(textOf(html)).toContain('Start revision 3…')
  })

  it('no office around (the design index): one quiet line, no doors; in Italian too, with no key left on screen', () => {
    for (const locale of LOCALES) {
      const html = render(createElement(RouteView, { model: { ...ready(), state: 'outside' }, actions }), locale)
      expect(textOf(html)).not.toMatch(/\b(routes|held|action|who|col|rule)\.[a-zA-Z]/)
      expect(html).not.toContain('Edit this route')
    }
  })
})

describe('words and looks', () => {
  it('products-route has the same keys in it and en', () => {
    expect(Object.keys(words('it')).sort()).toEqual(Object.keys(words('en')).sort())
  })

  it('every key the Route tab names exists in both languages', () => {
    const sources = ['model.ts', 'RouteContainer.tsx', '../view/RouteView.tsx'].map((file) => readFileSync(join(HERE, file), 'utf8')).join('\n')
    const keys = [...sources.matchAll(/['"`]((?:routes|col|rule|action|held|who|more|common|problem)\.[A-Za-z_.]+[A-Za-z_])['"`]/g)].map((match) => match[1]!)
    // The tab itself reads the products catalogue with `t` and this one with `tr`.
    const tab = [...readFileSync(join(HERE, '../view/RoutingTab.tsx'), 'utf8').matchAll(/\btr\(\s*'([\w.]+)'/g)].map((match) => match[1]!)
    const named = [...new Set([...keys, ...tab, 'rule.TOO_FEW', 'rule.LAST_NOT_PACKING', 'rule.DEPARTMENT_CLOSED', 'rule.NO_QUALITY'])]
    expect(named.length).toBeGreaterThan(30)
    for (const locale of LOCALES) expect(named.filter((key) => !has(locale, key)), locale).toEqual([])
  })

  it('layout only, DS tokens only, the room decides (container queries, no media query)', () => {
    const css = readFileSync(join(HERE, 'route.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).toContain('@container fw-rt (min-width: 960px)')
    expect(css).not.toContain('@media')
  })
})
