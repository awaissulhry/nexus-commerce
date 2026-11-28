import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { DEPT_ROWS } from '../route/fixtures'
import { deptLooksOf } from '../route/model'
import type { RouteSource, RouteTemplate } from './api'
import {
  addStep,
  builderProblems,
  copyOptionsOf,
  copySteps,
  copyStepsOf,
  endIndexFor,
  kindOfLooks,
  lineBody,
  LINE_STEPS_MAX,
  minutesInputOf,
  minutesOut,
  moveStep,
  paletteOf,
  productBody,
  refusalOf,
  removeStep,
  reorderSteps,
  routeBody,
  routeProblems,
  saveHeldOf,
  setForWhom,
  setMinutes,
  setName,
  setReason,
  startBuilder,
  stepRowsOf,
  templateHeldOf,
  type BuilderState,
} from './model'
import { RouteBuilderBody, type BuilderViewModel } from './view/RouteBuilder'

/**
 * owb-pd6 step 6.2 (S4; design plan § 5w; prototype prod.js rbAdd, rbDrop, rbMove, rbUp, rbDown, rbDel, rbCopy, rbErrors, rbSave) — the
 * route builder's model: add (with + before a last Packing; a drop at its place), move, take out, copy, the rule codes (the server's:
 * TOO_FEW, LAST_NOT_PACKING, DEPARTMENT_CLOSED; NO_QUALITY a note), the save bodies (the product route keeps each kept step's
 * `stepId`), and a line's exception needs its reason. Written, not run (Owner rule). Made-up data only.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const looks = deptLooksOf(DEPT_ROWS, 'en')
const kindOf = kindOfLooks(looks)
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['products-route'] ?? {}
const has = (locale: (typeof LOCALES)[number], key: string) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale))

/** The product route of today: Pattern → Cutting → Patch & print → Stitching → Quality → Packing, its steps kept. */
const leather = (): BuilderState =>
  startBuilder('product', [
    { stepId: 'step-0', departmentId: 'dept-1', minutes: '30.000' },
    { stepId: 'step-1', departmentId: 'dept-2', minutes: '40' },
    { stepId: 'step-2', departmentId: 'dept-3', minutes: '40.5' },
    { stepId: 'step-3', departmentId: 'dept-4', minutes: '60' },
    { stepId: 'step-4', departmentId: 'dept-5', minutes: '15' },
    { stepId: 'step-5', departmentId: 'dept-6', minutes: null },
  ])
const ids = (state: BuilderState) => state.steps.map((step) => step.departmentId)
const codes = (state: BuilderState) => builderProblems(state, looks).errors.map((issue) => issue.code)

describe('the start', () => {
  it('the product route keeps its steps\' ids and shows their minutes plainly; other modes keep no step id', () => {
    const state = leather()
    expect(state.steps.map((step) => step.stepId)).toEqual(['step-0', 'step-1', 'step-2', 'step-3', 'step-4', 'step-5'])
    expect(state.steps.map((step) => step.minutes)).toEqual(['30', '40', '40.5', '60', '15', ''])
    expect(state.steps.every((step) => !step.fresh)).toBe(true)
    expect(startBuilder('route', [{ stepId: 'x', departmentId: 'dept-1', minutes: '1' }]).steps[0]!.stepId).toBeUndefined()
    expect(startBuilder('new', [{ departmentId: 'dept-1', minutes: null }], { fresh: true }).steps[0]!.fresh).toBe(true)
  })

  it('minutes: the server\'s decimal as the field shows it, and what is sent', () => {
    expect([minutesInputOf('12.500'), minutesInputOf('8'), minutesInputOf(null), minutesInputOf('x')]).toEqual(['12.5', '8', '', ''])
    expect([minutesOut(''), minutesOut(' 12 '), minutesOut('12,5'), minutesOut('-1'), minutesOut('1e3')]).toEqual([undefined, '12', '12.5', null, null])
  })
})

describe('add, move, take out', () => {
  it('+ puts a department at the end, but before a last Packing (Packing itself goes last)', () => {
    expect(endIndexFor(leather(), 'dept-5', kindOf)).toBe(5)
    const twice = addStep(leather(), 'dept-5', kindOf)
    expect(ids(twice)).toEqual(['dept-1', 'dept-2', 'dept-3', 'dept-4', 'dept-5', 'dept-5', 'dept-6'])
    expect(twice.steps[5]).toMatchObject({ fresh: true, minutes: '' })
    expect(twice.steps[5]!.stepId).toBeUndefined()
    expect(ids(addStep(leather(), 'dept-6', kindOf)).slice(-2)).toEqual(['dept-6', 'dept-6'])
    // A department may be there twice: the keys stay one per row.
    expect(new Set(twice.steps.map((step) => step.key)).size).toBe(twice.steps.length)
  })

  it('a drop at a row\'s place puts it there', () => {
    expect(ids(addStep(leather(), 'dept-8', kindOf, 0))[0]).toBe('dept-8')
    expect(ids(addStep(leather(), 'dept-8', kindOf, 99)).at(-1)).toBe('dept-8')
  })

  it('a step moves anywhere (free order: ↑ ↓, Alt+↑ / Alt+↓, a drag); out of range changes nothing', () => {
    const moved = moveStep(leather(), 4, 1)
    expect(ids(moved)).toEqual(['dept-1', 'dept-5', 'dept-2', 'dept-3', 'dept-4', 'dept-6'])
    expect(moved.steps[1]!.stepId).toBe('step-4')
    expect(moveStep(leather(), 0, -1)).toEqual(leather())
    expect(moveStep(leather(), 5, 6)).toEqual(leather())
  })

  it('the sortable list\'s order is taken only when it holds exactly the route\'s keys', () => {
    const state = leather()
    const keys = state.steps.map((step) => step.key)
    expect(ids(reorderSteps(state, [...keys].reverse()))[0]).toBe('dept-6')
    expect(reorderSteps(state, keys.slice(1))).toBe(state)
    expect(reorderSteps(state, [keys[0]!, keys[0]!, ...keys.slice(2)])).toBe(state)
  })

  it('take a step out; minutes per step', () => {
    expect(ids(removeStep(leather(), 2))).toEqual(['dept-1', 'dept-2', 'dept-4', 'dept-5', 'dept-6'])
    expect(removeStep(leather(), 9)).toEqual(leather())
    expect(setMinutes(leather(), 0, '33').steps[0]!.minutes).toBe('33')
  })

  it('"Start from a copy" replaces the steps with new rows (no step is kept)', () => {
    const copied = copySteps(leather(), [
      { departmentId: 'dept-7', minutes: '4' },
      { departmentId: 'dept-8', minutes: null },
      { departmentId: 'dept-5', minutes: '5' },
      { departmentId: 'dept-6', minutes: '2' },
    ])
    expect(ids(copied)).toEqual(['dept-7', 'dept-8', 'dept-5', 'dept-6'])
    expect(copied.steps.every((step) => step.fresh && step.stepId === undefined)).toBe(true)
    expect(productBody(copied, 7).steps.every((step) => !('stepId' in step))).toBe(true)
  })

  it('the departments to add: the open ones in the factory\'s order, with how often each is in the route', () => {
    const palette = paletteOf(addStep(leather(), 'dept-5', kindOf), looks, new Set(['dept-9']))
    expect(palette.map((row) => row.dept.shortName)).toEqual(['Design', 'Pattern', 'Cutting', 'Molding', 'Patch & print', 'Stitching', 'Assembly', 'Quality', 'Packing'])
    expect(palette.find((row) => row.id === 'dept-5')!.count).toBe(2)
    expect(palette.find((row) => row.id === 'dept-9')!.fresh).toBe(true)
    const closed = deptLooksOf(DEPT_ROWS.map((row) => (row.id === 'dept-8' ? { ...row, status: 'CLOSED' as const } : row)), 'en')
    expect(paletteOf(leather(), closed, new Set()).some((row) => row.id === 'dept-8')).toBe(false)
  })
})

describe('the rules (the server\'s codes)', () => {
  it('two steps or more; the last step is Packing; no quality check is a note, not a stop', () => {
    expect(routeProblems([], looks).errors).toEqual(['TOO_FEW', 'LAST_NOT_PACKING'])
    expect(routeProblems([{ departmentId: 'dept-6', fresh: true }], looks).errors).toEqual(['TOO_FEW'])
    expect(routeProblems(leather().steps, looks)).toEqual({ errors: [], warnings: [] })
    const molded = copySteps(leather(), [{ departmentId: 'dept-7' }, { departmentId: 'dept-8' }, { departmentId: 'dept-6' }])
    expect(routeProblems(molded.steps, looks)).toEqual({ errors: [], warnings: ['NO_QUALITY'] })
    expect(codes(moveStep(leather(), 5, 0))).toEqual(['LAST_NOT_PACKING'])
  })

  it('a closed department may not come in new; one the route already had stays', () => {
    const closed = deptLooksOf(DEPT_ROWS.map((row) => (row.id === 'dept-3' ? { ...row, status: 'CLOSED' as const } : row)), 'en')
    expect(routeProblems(leather().steps, closed).errors).toEqual([])
    expect(routeProblems(addStep(leather(), 'dept-3', kindOfLooks(closed)).steps, closed).errors).toEqual(['DEPARTMENT_CLOSED'])
  })

  it('the window\'s own: minutes that are not a number, a step with no department, a new route\'s name and customer', () => {
    expect(codes(setMinutes(leather(), 1, 'ten'))).toEqual(['MINUTES_BAD'])
    expect(codes(startBuilder('product', [{ departmentId: null, minutes: null }, { departmentId: 'dept-6', minutes: null }]))).toEqual(['NO_DEPARTMENT'])
    const fresh = startBuilder('new', leather().steps, { fresh: true })
    expect(codes(fresh)).toEqual(['NAME_NEEDED'])
    expect(codes(setForWhom(setName(fresh, 'With sliders'), 'CUSTOMER', null))).toEqual(['CUSTOMER_NEEDED'])
    expect(codes(setForWhom(setName(fresh, 'With sliders'), 'CUSTOMER', 'party-alpha'))).toEqual([])
  })

  it('the notes: no quality check, a department two times in a row', () => {
    const notes = builderProblems(copySteps(leather(), [{ departmentId: 'dept-2' }, { departmentId: 'dept-2' }, { departmentId: 'dept-6' }]), looks).notes
    expect(notes.map((issue) => issue.code)).toEqual(['NO_QUALITY', 'TWICE_IN_A_ROW'])
    expect(notes[1]!.words).toEqual({ key: 'builder.note.twice', params: { name: 'Cutting' } })
  })

  it('Save is held by the first error, in words; a save running holds it too', () => {
    expect(saveHeldOf(leather(), looks, false)).toBeNull()
    expect(saveHeldOf(removeStep(leather(), 5), looks, false)).toEqual({ key: 'rule.LAST_NOT_PACKING' })
    expect(saveHeldOf(leather(), looks, true)).toEqual({ key: 'held.busy' })
  })
})

describe('one order line needs its reason', () => {
  const line = () => startBuilder('line', [{ departmentId: 'dept-7', minutes: '4' }, { departmentId: 'dept-8', minutes: '6' }, { departmentId: 'dept-5', minutes: '5' }, { departmentId: 'dept-6', minutes: '2' }])
  it('without a reason Save is held with words; with one it saves', () => {
    expect(codes(line())).toEqual(['REASON_NEEDED'])
    expect(saveHeldOf(line(), looks, false)).toEqual({ key: 'builder.error.REASON_NEEDED' })
    expect(saveHeldOf(setReason(line(), '   '), looks, false)).toEqual({ key: 'builder.error.REASON_NEEDED' })
    expect(saveHeldOf(setReason(line(), 'The customer sends the finished shells'), looks, false)).toBeNull()
  })
  it('the line\'s body: the steps, the reason, the line\'s version when it has one', () => {
    const state = setReason(line(), ' The customer sends the finished shells ')
    expect(lineBody(state, 3)).toEqual({ version: 3, steps: [{ departmentId: 'dept-7', minutes: '4' }, { departmentId: 'dept-8', minutes: '6' }, { departmentId: 'dept-5', minutes: '5' }, { departmentId: 'dept-6', minutes: '2' }], reason: 'The customer sends the finished shells' })
    expect('version' in lineBody(state, null)).toBe(false)
  })
})

describe('what is sent', () => {
  it('the product route keeps each kept step\'s stepId (its depth survives); a new step has none; empty minutes are left out', () => {
    const state = setMinutes(addStep(removeStep(leather(), 2), 'dept-5', kindOf), 0, '31')
    const body = productBody(state, 7)
    expect(body.version).toBe(7)
    expect(body.steps).toEqual([
      { stepId: 'step-0', departmentId: 'dept-1', minutes: '31' },
      { stepId: 'step-1', departmentId: 'dept-2', minutes: '40' },
      { stepId: 'step-3', departmentId: 'dept-4', minutes: '60' },
      { stepId: 'step-4', departmentId: 'dept-5', minutes: '15' },
      { departmentId: 'dept-5' },
      { stepId: 'step-5', departmentId: 'dept-6' },
    ])
  })

  it('a model route is for any customer (no party); a customer route names its customer', () => {
    const fresh = setName(startBuilder('new', leather().steps, { fresh: true }), '  With sliders  ')
    expect(routeBody(fresh)).toMatchObject({ name: 'With sliders', kind: 'MODEL', partyId: null })
    expect(routeBody(setForWhom(fresh, 'CUSTOMER', 'party-alpha'))).toMatchObject({ kind: 'CUSTOMER', partyId: 'party-alpha' })
    expect(routeBody(setForWhom(setForWhom(fresh, 'CUSTOMER', 'party-alpha'), 'MODEL', 'party-alpha')).partyId).toBeNull()
  })
})

describe('ready-made routes and "Start from a copy"', () => {
  const templates: RouteTemplate[] = [
    { id: 'tpl-1', name: 'Leather garment', steps: [{ departmentId: 'dept-1', number: 1, minutes: null }, { departmentId: 'dept-6', number: 6, minutes: null }], status: 'OPEN', version: 1 },
    { id: 'tpl-2', name: 'Molded part', steps: [{ departmentId: 'dept-7', number: 7, minutes: null }, { departmentId: 'dept-8', number: 8, minutes: null }, { departmentId: 'dept-5', number: 5, minutes: null }, { departmentId: 'dept-6', number: 6, minutes: null }], status: 'OPEN', version: 1 },
    { id: 'tpl-3', name: 'Old way', steps: [], status: 'CLOSED', version: 2 },
  ]
  const sources: RouteSource[] = [
    { styleId: 'style-2', code: 'DEMO-KNS-01', name: 'Knee slider, molded', revision: 1, product: templates[1]!.steps, routes: [{ id: 'route-x', name: 'Checked twice', kind: 'MODEL', steps: templates[0]!.steps }] },
  ]

  it('the choices: the OPEN ready-made routes, then each product\'s route and its other routes', () => {
    const options = copyOptionsOf(templates, sources)
    expect(options.templates.map((option) => option.value)).toEqual(['tpl:tpl-1', 'tpl:tpl-2'])
    expect(options.products).toEqual([
      { value: 'prod:style-2', name: 'DEMO-KNS-01 Knee slider, molded', steps: 4 },
      { value: 'var:style-2:route-x', name: 'DEMO-KNS-01 Knee slider, molded · Checked twice', steps: 2 },
    ])
    expect(copyStepsOf('tpl:tpl-2', templates, sources)).toHaveLength(4)
    expect(copyStepsOf('var:style-2:route-x', templates, sources)).toHaveLength(2)
    expect(copyStepsOf('prod:gone', templates, sources)).toBeNull()
  })

  it('"Save as ready-made" needs a route that keeps the rules and a name no other ready-made route has (open or closed)', () => {
    expect(templateHeldOf(leather(), 'Leather, checked twice', templates, looks, false)).toBeNull()
    expect(templateHeldOf(leather(), '  ', templates, looks, false)).toEqual({ key: 'builder.template.nameNeeded' })
    expect(templateHeldOf(leather(), 'molded PART', templates, looks, false)).toEqual({ key: 'builder.template.nameTaken' })
    expect(templateHeldOf(leather(), 'Old way', templates, looks, false)).toEqual({ key: 'builder.template.nameClosed' })
    expect(templateHeldOf(removeStep(leather(), 5), 'New', templates, looks, false)).toEqual({ key: 'rule.LAST_NOT_PACKING' })
  })
})

describe('a refusal in words', () => {
  it('a known code (its own, an issue\'s, the end of an issue\'s path) first, then a rule, then the kind of answer', () => {
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'name/NAME_TAKEN' }] })).toEqual({ key: 'refusal.NAME_TAKEN' })
    expect(refusalOf({ kind: 'invalid', code: 'validation_failed', issues: [{ code: 'NAME_EMPTY' }] })).toEqual({ key: 'refusal.NAME_EMPTY' })
    expect(refusalOf({ kind: 'conflict', code: 'FLOOR_FIXED' })).toEqual({ key: 'refusal.FLOOR_FIXED' })
    expect(refusalOf({ kind: 'invalid', code: 'validation_failed', issues: [{ path: ['steps', 'LAST_NOT_PACKING'] }] })).toEqual({ key: 'rule.LAST_NOT_PACKING' })
    expect(refusalOf({ kind: 'conflict', code: 'conflict' })).toEqual({ key: 'problem.conflict' })
    expect(refusalOf({ kind: 'forbidden', code: 'forbidden' })).toEqual({ key: 'problem.forbidden' })
  })
  // owb-pd8 (pd2 landed): the server's real answers — rules 400 at `refusal/<code>`, NAME_TAKEN 409 by what was saved, the line's codes.
  it('pd2: a rule refused with 400 at refusal/<code> says the rule\'s words', () => {
    for (const code of ['TOO_FEW', 'LAST_NOT_PACKING', 'DEPARTMENT_CLOSED']) expect(refusalOf({ kind: 'invalid', code: 'validation_failed', issues: [{ path: `refusal/${code}`, message: 'x' }] }, 'route')).toEqual({ key: `rule.${code}` })
  })
  it('pd2: NAME_TAKEN 409 says whose name it is — a department, a route of the revision, an open ready-made route', () => {
    const taken = { kind: 'conflict', code: 'conflict', issues: [{ path: 'refusal/NAME_TAKEN', message: 'x' }] }
    expect(refusalOf(taken)).toEqual({ key: 'refusal.NAME_TAKEN' })
    expect(refusalOf(taken, 'route')).toEqual({ key: 'refusal.NAME_TAKEN_ROUTE' })
    expect(refusalOf(taken, 'template')).toEqual({ key: 'refusal.NAME_TAKEN_TEMPLATE' })
  })
  it('pd2: a line\'s refusals — FROZEN 409, ONLY_PRODUCTION_MANAGER 403, NOT_A_MODEL 400 — in words, in both languages', () => {
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'refusal/FROZEN' }] }, 'line')).toEqual({ key: 'refusal.FROZEN' })
    expect(refusalOf({ kind: 'forbidden', code: 'forbidden', issues: [{ path: 'refusal/ONLY_PRODUCTION_MANAGER' }] }, 'line')).toEqual({ key: 'refusal.ONLY_PRODUCTION_MANAGER' })
    expect(refusalOf({ kind: 'invalid', code: 'validation_failed', issues: [{ path: 'refusal/NOT_A_MODEL' }] }, 'line')).toEqual({ key: 'refusal.NOT_A_MODEL' })
    for (const locale of LOCALES)
      for (const key of ['refusal.NAME_TAKEN_ROUTE', 'refusal.NAME_TAKEN_TEMPLATE', 'refusal.ONLY_PRODUCTION_MANAGER', 'refusal.NOT_A_MODEL', 'builder.error.TOO_MANY'])
        expect(CATALOGUE[locale]['products-route']?.[key], `${locale} ${key}`).toBeTruthy()
  })
})

describe('owb-pd8 (pd2 LINE_EXCEPTION_STEPS_MAX): one line\'s route has at most 50 steps', () => {
  it('51 steps hold Save with words; 50 save', () => {
    const steps = (count: number) => Array.from({ length: count }, (_, index) => ({ departmentId: index === count - 1 ? 'dept-6' : 'dept-5', minutes: '1' }))
    const at = (count: number) => setReason(startBuilder('line', steps(count)), 'Made by hand')
    expect(saveHeldOf(at(51), looks, false)).toEqual({ key: 'builder.error.TOO_MANY', params: { max: LINE_STEPS_MAX } })
    expect(builderProblems(at(50), looks).errors.map((issue) => issue.code)).not.toContain('TOO_MANY')
  })
})

describe('the window draws its model', () => {
  const view = (state: BuilderState, over: Partial<BuilderViewModel> = {}): BuilderViewModel => ({
    mode: state.mode,
    subtitle: 'DEMO-JKT-01 · Demo jacket · the product\'s route',
    palette: paletteOf(state, looks, new Set()),
    steps: stepRowsOf(state, looks),
    total: '193.5',
    errors: builderProblems(state, looks).errors.map((issue) => issue.words),
    notes: builderProblems(state, looks).notes.map((issue) => issue.words),
    copy: { state: 'ready', templates: [], products: [], query: '' },
    route: null,
    line: state.mode === 'line' ? { reason: state.reason } : null,
    template: null,
    save: { held: saveHeldOf(state, looks, false), busy: false, problem: null },
    ...over,
  })
  const actions = {
    onAdd: () => undefined, onDrop: () => undefined, onReorder: () => undefined, onMove: () => undefined, onRemove: () => undefined, onMinutes: () => undefined,
    onCopy: () => undefined, onQuery: () => undefined, onName: () => undefined, onForWhom: () => undefined, onParty: () => undefined, onReason: () => undefined,
    onTemplateName: () => undefined, onSaveTemplate: () => undefined, onTemplateOpen: () => undefined, onSave: () => undefined, onClose: () => undefined,
  }

  it('departments with +, the route with minutes and its buttons, the key hints in ONE ⓘ; in both languages with no key left', () => {
    for (const locale of LOCALES) {
      const html = render(createElement(RouteBuilderBody, { model: view(leather()), actions }), locale)
      expect(textOf(html)).not.toMatch(/\b(builder|rule|routes|held)\.[a-zA-Z]/)
      expect(html.match(/data-rb-key=/g)?.length).toBe(6)
    }
    const en = textOf(render(createElement(RouteBuilderBody, { model: view(leather()), actions })))
    for (const part of ['Departments', 'The route', 'Start from a copy, then change it', '193.5 minutes for one piece.']) expect(en, part).toContain(part)
    // The window's name and its foot (Save the route) are the shell's: the DS dialog draws only in a browser.
    expect(readFileSync(join(HERE, 'view/RouteBuilder.tsx'), 'utf8')).toContain("act={{ words: t(`builder.save.${model.mode}`), onAct: actions.onSave, held: model.save.held ? say(model.save.held) : null, busy: model.save.busy }}")
  })

  it('a line with no reason: the reason field, and the reason\'s words among what holds Save', () => {
    const state = startBuilder('line', leather().steps)
    const text = textOf(render(createElement(RouteBuilderBody, { model: view(state), actions })))
    expect(text).toContain('Why is this order different?')
    expect(text).toContain('Say why this order is different.')
    // One order line: no "Save as ready-made".
    expect(text).not.toContain('Save as ready-made')
  })
})

describe('words and looks', () => {
  it('every key the builder names exists in both languages', () => {
    const sources = ['model.ts', 'RouteBuilderWindow.tsx', 'view/RouteBuilder.tsx'].map((file) => readFileSync(join(HERE, file), 'utf8')).join('\n')
    const keys = [...sources.matchAll(/['"`]((?:builder|rule|routes|refusal|held|problem)\.[A-Za-z_.]+[A-Za-z_])['"`]/g)].map((match) => match[1]!)
    const built = [
      ...['product', 'route', 'new', 'line'].flatMap((mode) => [`builder.title.${mode}`, `builder.save.${mode}`, `builder.subtitle.${mode}`]),
      ...['NO_DEPARTMENT', 'MINUTES_BAD', 'NAME_NEEDED', 'CUSTOMER_NEEDED', 'REASON_NEEDED'].map((code) => `builder.error.${code}`),
      ...['NAME_EMPTY', 'NAME_TAKEN', 'FLOOR_FIXED', 'CLOSED', 'CODE_TAKEN', 'FROZEN', 'PRINTED', 'NOT_DRAFT'].map((code) => `refusal.${code}`),
    ]
    const named = [...new Set([...keys, ...built])]
    expect(named.length).toBeGreaterThan(40)
    for (const locale of LOCALES) expect(named.filter((key) => !has(locale, key)), locale).toEqual([])
  })

  it('layout only, DS tokens only; the window\'s room decides (route first in a narrow room)', () => {
    const css = readFileSync(join(HERE, 'builder.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).toContain('@container fwroom (min-width: 720px)')
    expect(css).not.toContain('@media')
    expect(css.indexOf("'route'")).toBeLessThan(css.indexOf("'depts'"))
  })
})
