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
import { DEPT_ROWS, MODEL_ROUTE } from '../route/fixtures'
import { deptLooksOf } from '../route/model'
import { lineRoutesAnswer, type LineRoutes } from './api'
import { answerOfLines, exceptionStartOf, lineMayOf, lineRowsOf, pickValueOf, readProblemKeyOf, showsRouteName, sourceOf } from './model'
import { LineRoutesView, type LineRoutesViewModel } from './view/LineRoutesView'

/**
 * owb-pd6 step 6.4 (S4; design plan § 5v, § 5z) — "Route of each line" on the office order's Production tab: where each line's route
 * comes from in words (From the product · Model · For this customer · Order structure · Only this order), once the basket cards are
 * printed every route is read only, sales picks a model only with `may.pick`, the production manager's exception and its way back.
 * Written, not run (Owner rule). Made-up data only.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const en = departmentWordsFor('en')
const fixed = fixedDepartments(en)
const looks = deptLooksOf(DEPT_ROWS, 'en')
const unknown = (no: number) => en('unknown', { no })
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['products-route'] ?? {}
const has = (locale: (typeof LOCALES)[number], key: string) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale))
const say = (key: string) => words('en')[key]

const jacket = { id: 'style-demo-1', code: 'DEMO-JKT-01', name: 'Demo jacket' }
const leather = [1, 2, 3, 4, 5, 6].map((number) => ({ departmentId: `dept-${number}`, number, minutes: null }))
const molded = [7, 8, 5, 6].map((number) => ({ departmentId: `dept-${number}`, number, minutes: '5' }))

const answer = (over: Partial<LineRoutes> = {}): LineRoutes =>
  lineRoutesAnswer.parse({
    frozen: false,
    may: { pick: true, exception: true },
    lines: [
      { lineId: 'line-1', seq: 1, product: jacket, source: 'REVISION', routeName: null, steps: leather, choices: [{ routeId: MODEL_ROUTE.id, name: MODEL_ROUTE.name }], pickedRouteId: null, exception: null, version: 1 },
      { lineId: 'line-2', seq: 2, product: jacket, source: 'MODEL', routeName: MODEL_ROUTE.name, steps: MODEL_ROUTE.steps, choices: [{ routeId: MODEL_ROUTE.id, name: MODEL_ROUTE.name }], pickedRouteId: MODEL_ROUTE.id, exception: null, version: 2 },
      { lineId: 'line-3', seq: 3, product: { id: 'style-2', code: 'DEMO-KNS-01', name: 'Knee slider, molded' }, source: 'EXCEPTION', routeName: null, steps: molded, choices: [], pickedRouteId: null, exception: { reason: 'The customer sends the finished shells', by: 'Otto Demo', at: '2026-11-20T09:00:00.000Z' }, version: 3 },
      { lineId: 'line-4', seq: 4, product: null, source: 'REVISION', routeName: null, steps: [], choices: [], pickedRouteId: null, exception: null, version: null },
    ],
    ...over,
  })

describe('where a line\'s route comes from, in words', () => {
  it('From the product · Model · For this customer · Order structure (STRUCTURE and RULE) · Only this order; a new source: "Its route"', () => {
    expect(['REVISION', 'MODEL', 'CUSTOMER', 'STRUCTURE', 'RULE', 'EXCEPTION', 'LATER'].map((source) => say(sourceOf(source).key))).toEqual(['From the product', 'Model', 'For this customer', 'Order structure', 'Order structure', 'Only this order', 'Its route'])
    expect(sourceOf('EXCEPTION').tone).toBe('warning')
    // `toString` is no source: an own key only.
    expect(sourceOf('toString').key).toBe('line.source.other')
  })

  it('the route\'s own name beside a model, a customer\'s route and an order structure, never beside the product\'s', () => {
    expect(showsRouteName({ source: 'MODEL', routeName: 'With molded sliders' })).toBe(true)
    expect(showsRouteName({ source: 'STRUCTURE', routeName: 'Brand Alpha standard' })).toBe(true)
    expect(showsRouteName({ source: 'REVISION', routeName: 'Leather garment' })).toBe(false)
    expect(showsRouteName({ source: 'MODEL', routeName: null })).toBe(false)
  })

  it('the answer keeps working on a source the server adds later (read as text)', () => {
    expect(answer({ lines: [{ ...answer().lines[0]!, source: 'SOMETHING_NEW' }] }).lines[0]!.source).toBe('SOMETHING_NEW')
  })
})

describe('who may do what on a line', () => {
  it('before the print: sales picks a model where there is one; the production manager makes an exception, or takes one back', () => {
    const [first, second, third, fourth] = answer().lines
    expect(lineMayOf(answer(), first!)).toEqual({ pick: true, exception: true, back: false })
    expect(lineMayOf(answer(), second!)).toEqual({ pick: true, exception: true, back: false })
    expect(lineMayOf(answer(), third!)).toEqual({ pick: false, exception: false, back: true })
    expect(lineMayOf(answer(), fourth!)).toEqual({ pick: false, exception: false, back: false })
  })

  it('the pick is hidden without may.pick (the production manager alone), and without a model route to pick', () => {
    const managerOnly = answer({ may: { pick: false, exception: true } })
    expect(managerOnly.lines.map((line) => lineMayOf(managerOnly, line).pick)).toEqual([false, false, false, false])
    expect(lineMayOf(answer(), { ...answer().lines[0]!, choices: [] }).pick).toBe(false)
    const salesOnly = answer({ may: { pick: true, exception: false } })
    expect(salesOnly.lines.map((line) => lineMayOf(salesOnly, line))).toEqual([
      { pick: true, exception: false, back: false },
      { pick: true, exception: false, back: false },
      { pick: false, exception: false, back: false },
      { pick: false, exception: false, back: false },
    ])
  })

  it('frozen (the basket cards are printed): every line read only, "Fixed at the print of the basket cards"', () => {
    const frozen = answer({ frozen: true })
    for (const line of frozen.lines) expect(lineMayOf(frozen, line)).toEqual({ pick: false, exception: false, back: false })
    expect(say(answerOfLines(frozen).key)).toContain('Fixed at the print of the basket cards')
    expect(answerOfLines(answer()).key).toBe('line.answer.open')
  })

  it('the pick shows the picked model, or the normal route; an exception starts from the route the line has now', () => {
    expect(answer().lines.map(pickValueOf)).toEqual(['', MODEL_ROUTE.id, '', ''])
    expect(pickValueOf({ pickedRouteId: 'gone', choices: [] })).toBe('')
    expect(exceptionStartOf(answer().lines[2]!)).toEqual(molded.map((step) => ({ departmentId: step.departmentId, minutes: '5' })))
  })
})

describe('the rows', () => {
  it('each line: its title, its steps as departments, where it comes from, the exception with its reason', () => {
    const rows = lineRowsOf(answer(), looks, fixed, unknown)
    expect(rows.map((row) => row.route.map((dept) => dept.shortName).join(' → '))).toEqual([
      'Pattern → Cutting → Patch & print → Stitching → Quality → Packing',
      'Pattern → Cutting → Molding → Stitching → Packing',
      'Design → Molding → Quality → Packing',
      '',
    ])
    expect(rows[1]).toMatchObject({ routeName: 'With molded sliders', source: { key: 'line.source.MODEL' } })
    expect(rows[2]!.exception).toEqual({ reason: 'The customer sends the finished shells', by: 'Otto Demo', at: '2026-11-20T09:00:00.000Z' })
    expect(rows[3]!.title).toEqual({ key: 'line.titleNoProduct', params: { seq: 4 } })
  })

  it('a department no list names is "Department n", never a crash', () => {
    const odd = answer({ lines: [{ ...answer().lines[0]!, steps: [{ departmentId: 'gone', number: 40, minutes: null }] }] })
    expect(lineRowsOf(odd, looks, fixed, unknown)[0]!.route[0]!.shortName).toBe('Department 40')
  })

  it('a failed read in the section kit\'s words (orders problem.read.*)', () => {
    expect(readProblemKeyOf({ kind: 'forbidden' })).toBe('problem.read.forbidden')
    expect(readProblemKeyOf({ kind: 'step_up' })).toBe('problem.read.forbidden')
    expect(readProblemKeyOf({ kind: 'conflict' })).toBe('problem.read.internal')
    for (const locale of LOCALES) for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'internal']) expect(CATALOGUE[locale]['orders']?.[`problem.read.${kind}`], `${locale} ${kind}`).toBeTruthy()
  })
})

describe('the section draws its model', () => {
  const model = (from: LineRoutes, over: Partial<LineRoutesViewModel> = {}): LineRoutesViewModel => ({
    state: 'ready',
    problem: null,
    answer: answerOfLines(from),
    rows: lineRowsOf(from, looks, fixed, unknown),
    busyLine: null,
    exceptionHeld: null,
    actProblem: null,
    ...over,
  })
  const actions = { onPick: () => undefined, onException: () => undefined, onBack: () => undefined, onRetry: () => undefined }

  it('before the print: the source words, the department bars, the pick, "Another route for this order…", "Back to the normal route"', () => {
    const html = render(createElement(LineRoutesView, { model: model(answer()), actions }))
    const text = textOf(html)
    for (const part of ['Route of each line', 'From the product', 'Model', 'Only this order', 'Why: The customer sends the finished shells', 'Another route for this order…', 'Back to the normal route', 'Normal (the product\'s route)']) expect(text, part).toContain(part)
    expect(html.match(/<ol class="fw-dept-bar"/g)?.length).toBe(4)
    expect(html.match(/<select/g)?.length).toBe(2)
  })

  it('without may.pick no select is drawn', () => {
    const html = render(createElement(LineRoutesView, { model: model(answer({ may: { pick: false, exception: true } })), actions }))
    expect(html).not.toContain('<select')
    expect(textOf(html)).toContain('Another route for this order…')
  })

  it('frozen: read only — no select, no button, the words say why', () => {
    const html = render(createElement(LineRoutesView, { model: model(answer({ frozen: true })), actions }))
    expect(html).not.toContain('<select')
    expect(textOf(html)).not.toContain('Another route for this order…')
    expect(textOf(html)).not.toContain('Back to the normal route')
    expect(textOf(html)).toContain('Fixed at the print of the basket cards')
  })

  it('in both languages with no key left on screen', () => {
    for (const locale of LOCALES) expect(textOf(render(createElement(LineRoutesView, { model: model(answer()), actions }), locale))).not.toMatch(/\b(line|held|builder)\.[a-zA-Z]/)
  })
})

describe('the slot', () => {
  const part = readFileSync(join(HERE, '../../../_shared/parts/RouteOfEachLinePart.tsx'), 'utf8')

  it('keeps the base\'s export name, props and header (the order\'s Production tab mounts it)', () => {
    expect(part).toContain('SLOT — owner: S4 (owb-pd6)')
    expect(part).toContain('export function RouteOfEachLinePart(')
    expect(part).toContain('export interface RouteOfEachLinePartProps {')
    expect(part).toContain('readonly companyId: string')
    expect(part).toContain('readonly orderId: string')
  })

  it('draws nothing outside the office (the design index, a test\'s render of the tab), as before it was filled', () => {
    expect(part).toContain('if (!api) return null')
  })

  it('office only: no portal file reads it', () => {
    expect(part).not.toMatch(/portal\//)
  })
})

describe('words and looks', () => {
  it('every key the section names exists in both languages', () => {
    const sources = ['model.ts', 'view/LineRoutesView.tsx', '../../../_shared/parts/RouteOfEachLinePart.tsx'].map((file) => readFileSync(join(HERE, file), 'utf8')).join('\n')
    const keys = [...sources.matchAll(/['"`]((?:line|held|builder)\.[A-Za-z_.]+[A-Za-z_])['"`]/g)].map((match) => match[1]!)
    const named = [...new Set([...keys, ...['REVISION', 'MODEL', 'CUSTOMER', 'STRUCTURE', 'EXCEPTION', 'other'].map((source) => `line.source.${source}`)])]
    expect(named.length).toBeGreaterThan(15)
    for (const locale of LOCALES) expect(named.filter((key) => !has(locale, key)), locale).toEqual([])
  })

  it('layout only, DS tokens only, nothing scrolls sideways', () => {
    const css = readFileSync(join(HERE, 'line.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).not.toContain('@media')
  })
})
