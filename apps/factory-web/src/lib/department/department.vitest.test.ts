import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { CATALOGUE } from '../i18n/messages'
import { everyCase, render, textOf } from '../record-thread/parts/testing'
import { designScreen } from './fixtures'
import { DEPARTMENT_ICONS, departmentIconOf } from './icons'
import { DEPARTMENT_TONES, departmentByNo, departmentOfAnswer, departmentToneClass, departmentToneOf, FIXED_DEPARTMENTS, fixedDepartments, routeStepsOf, stripColumnsOf, unknownDepartment, type Department } from './model'
import { readDepartments, resetDepartments, wantDepartments } from './use-departments'
import { DeptBar } from './view/DeptBar'
import { DeptChip } from './view/DeptChip'
import { DeptStrip } from './view/DeptStrip'
import { departmentWordsFor } from './words'

/**
 * owb-b4 w4.2 (design § 5x, § 5zl, § 9; PL-schema § 2; the seed of owb-b1 a.6) — the department parts: the fixed table of the nine is
 * the seed's, every seeded icon id maps to a lucide icon and an unknown one draws a plain dot (never a crash), a tone the parts do not
 * know is slate, the server's answer becomes a department in the page's language, the route's step states, the strip's columns, and
 * the words in both languages. Made-up data only.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const en = departmentWordsFor('en')
const nine = fixedDepartments(en)

afterEach(() => resetDepartments())

describe('the model', () => {
  it('the fixed table is the seed: 1 Pattern ruler blue … 9 Assembly puzzle emerald, in order', () => {
    expect(FIXED_DEPARTMENTS.map(({ no, icon, tone }) => `${no} ${icon} ${tone}`)).toEqual(['1 ruler blue', '2 scissors orange', '3 layers pink', '4 shirt cyan', '5 shield-check purple', '6 package yellow', '7 pen-tool violet', '8 cylinder slate', '9 puzzle emerald'])
    expect(nine.map((dept) => dept.shortName)).toEqual(['Pattern', 'Cutting', 'Patch & print', 'Stitching', 'Quality', 'Packing', 'Design', 'Molding', 'Assembly'])
    expect(nine[2]).toMatchObject({ no: 3, name: 'Patchwork & printing', shortName: 'Patch & print', id: null })
    expect(fixedDepartments(departmentWordsFor('it'))[1]!.shortName).toBe('Taglio')
  })

  it('every seeded icon id is a lucide icon; an unknown id (or an object key) is none — the part draws a plain dot', () => {
    for (const { icon } of FIXED_DEPARTMENTS) expect(departmentIconOf(icon), icon).toBe(DEPARTMENT_ICONS[icon])
    for (const id of ['hand-stitch', '', null, undefined, 'toString', '__proto__']) expect(departmentIconOf(id), String(id)).toBeNull()
  })

  it('a tone is one of the ten DS group tones; any other is slate (never a raw colour)', () => {
    for (const tone of DEPARTMENT_TONES) expect(departmentToneOf(tone)).toBe(tone)
    for (const tone of ['indigo', '#ff0000', '', null, undefined]) expect(departmentToneOf(tone), String(tone)).toBe('slate')
    expect(departmentToneClass('cyan')).toBe('fw-dept-tone-cyan')
  })

  it('the server\'s row in a language: the long name of the language, ONE short name, the Urdu name, closed; never a kind', () => {
    const row = { id: 'd-3', number: 3, name: 'Patchwork & printing', shortName: 'Patch & print', nameI18n: { en: 'Patchwork & printing', it: 'Patchwork e stampa', ur: 'پیچ ورک' }, tone: 'pink', icon: 'layers', status: 'ACTIVE' as const }
    expect(departmentOfAnswer(row, 'en')).toEqual({ no: 3, tone: 'pink', icon: 'layers', name: 'Patchwork & printing', shortName: 'Patch & print', nameUr: 'پیچ ورک', id: 'd-3' })
    expect(departmentOfAnswer(row, 'it')).toMatchObject({ name: 'Patchwork e stampa', shortName: 'Patchwork e stampa' })
    expect(departmentOfAnswer({ ...row, nameI18n: null, shortName: null, tone: 'brown', status: 'CLOSED' }, 'it')).toEqual({ no: 3, tone: 'slate', icon: 'layers', name: 'Patchwork & printing', shortName: 'Patchwork & printing', id: 'd-3', closed: true })
    expect(Object.keys(departmentOfAnswer(row, 'en'))).not.toContain('workCentreKind')
  })

  it('a department by its number, and one no list names', () => {
    expect(departmentByNo(nine, 5)?.shortName).toBe('Quality')
    expect(departmentByNo(nine, 40)).toBeNull()
    expect(departmentByNo(nine, null)).toBeNull()
    expect(unknownDepartment(40, en('unknown', { no: 40 }))).toEqual({ no: 40, tone: 'slate', icon: '', name: 'Department 40', shortName: 'Department 40', id: null })
  })

  it('the route\'s steps: not started, at a step, every step done', () => {
    const route = nine.slice(0, 4)
    expect(routeStepsOf(route, null).map((step) => step.state)).toEqual(['next', 'next', 'next', 'next'])
    expect(routeStepsOf(route, 2).map((step) => step.state)).toEqual(['done', 'done', 'now', 'next'])
    expect(routeStepsOf(route, 4).map((step) => step.state)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('the strip\'s middle-room columns: rows of two, three (3 + 3), four, a third', () => {
    expect([1, 4, 5, 6, 7, 8, 9, 12].map(stripColumnsOf)).toEqual([2, 2, 3, 3, 4, 4, 3, 4])
  })
})

describe('the parts', () => {
  it('the chip: number dot, icon, ONE short name; the long name is the hint and is read after the short one', () => {
    const html = render(createElement(DeptChip, { dept: nine[2]! }))
    for (const part of ['fw-dept-chip fw-dept-tone-pink', 'title="Patchwork &amp; printing"', 'data-dept="3"', 'lucide-layers', '<span class="fw-dept-name">Patch &amp; print</span>']) expect(html, part).toContain(part)
    expect(textOf(html)).toBe('3 Department 3: Patch & print (Patchwork & printing)')
    // Short and long the same: no hint, nothing read twice.
    const cutting = render(createElement(DeptChip, { dept: nine[1]! }))
    expect(cutting).not.toContain('title=')
    expect(textOf(cutting)).toBe('2 Department 2: Cutting')
  })

  it('an unknown icon id draws a plain dot, never a crash', () => {
    const odd: Department = { no: 12, tone: 'red', icon: 'hand-stitch', name: 'Hand embroidery', shortName: 'Embroidery', id: null }
    const html = render(createElement(DeptChip, { dept: odd }))
    expect(html).toContain('fw-dept-plain')
    expect(html).not.toContain('<svg')
    expect(textOf(html)).toContain('Embroidery')
  })

  it('the bar: an ordered list; done has a check, the current step is aria-current, every step says its state', () => {
    const html = render(createElement(DeptBar, { route: nine.slice(0, 4), current: 2 }))
    expect(html).toContain('<ol class="fw-dept-bar" aria-label="The route: 4 steps"')
    expect(html.match(/lucide-check/g)?.length).toBe(2)
    expect(html.match(/aria-current="step"/g)?.length).toBe(1)
    expect(html).toMatch(/data-state="now" aria-current="step"><span class="fw-dept-chip fw-dept-tone-pink"/)
    expect(textOf(html)).toContain('Patch & print (Patchwork & printing) here now')
    expect(textOf(html)).toContain('Stitching to come')
  })

  it('the strip: a tile per department, its count in the kind\'s words, an empty one says so; the columns ride as CSS variables', () => {
    const tiles = [
      { dept: nine[0]!, count: 1 },
      { dept: nine[1]!, count: 3 },
      { dept: nine[2]!, count: 0 },
    ]
    const baskets = render(createElement(DeptStrip, { tiles, kind: 'baskets' }))
    expect(baskets).toContain('--fw-dept-n:3;--fw-dept-cols:2')
    expect(textOf(baskets)).toContain('1 basket')
    expect(textOf(baskets)).toContain('3 baskets')
    expect(textOf(baskets)).toContain('None here')
    expect(baskets.match(/data-has="true"/g)?.length).toBe(2)
    expect(textOf(render(createElement(DeptStrip, { tiles, kind: 'pieces' })))).toContain('3 pieces')
    expect(textOf(render(createElement(DeptStrip, { tiles, kind: 'pieces' }), 'it'))).toContain('3 pezzi')
  })

  it('every design case draws in both languages with no key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) {
      expect(html.length, `${locale} ${id}`).toBeGreaterThan(0)
      for (const key of ['fixed.', 'chip.number', 'chip.long', 'bar.label', 'bar.done', 'bar.now', 'bar.next', 'strip.label', 'strip.baskets', 'strip.pieces', 'strip.none']) expect(html, `${locale} ${id} ${key}`).not.toContain(key)
    }
  })
})

describe('the read', () => {
  const answer = { departments: [{ id: 'd-2', number: 2, name: 'Cutting', tone: 'orange', icon: 'scissors', seq: 2, extra: 'a field this web does not know' }, { id: 'd-1', number: 1, name: 'Pattern', shortName: 'Pattern', nameI18n: { it: 'Cartamodello' }, tone: 'blue', icon: 'ruler', seq: 1, workCentreKind: 'CUTTING', floorReady: true, status: 'ACTIVE' }] }

  it('GET /production/departments with this web\'s own zod: the four drawn fields required, the rest optional; in the server\'s order', async () => {
    const asked: string[] = []
    const api = { get: async (path: string, init: { schema: { parse: (value: unknown) => unknown } }) => (asked.push(path), init.schema.parse(answer)) } as unknown as Parameters<typeof readDepartments>[0]
    const rows = await readDepartments(api)
    expect(asked).toEqual(['/production/departments'])
    expect(rows.map((row) => row.number)).toEqual([1, 2])
    await expect(readDepartments({ get: async (_: string, init: { schema: { parse: (value: unknown) => unknown } }) => init.schema.parse({ departments: [{ id: 'x', number: 1, name: 'No tone' }] }) } as unknown as Parameters<typeof readDepartments>[0])).rejects.toThrow()
  })

  it('one read for every mount of the tab; a failed read is not kept', async () => {
    let calls = 0
    const api = { get: async (_: string, init: { schema: { parse: (value: unknown) => unknown } }) => (calls++, init.schema.parse(answer)) } as unknown as Parameters<typeof readDepartments>[0]
    const [one, two] = await Promise.all([wantDepartments(api), wantDepartments(api)])
    expect(calls).toBe(1)
    expect(one).toBe(two)
    resetDepartments()
    const failing = { get: async () => { throw new Error('offline') } } as unknown as Parameters<typeof readDepartments>[0]
    await expect(wantDepartments(failing)).rejects.toThrow('offline')
    await wantDepartments(api)
    expect(calls).toBe(2)
  })
})

describe('words and looks', () => {
  it('department.json has the same keys in it and en, and the nine names in both', () => {
    const keys = (locale: (typeof LOCALES)[number]) => Object.keys(CATALOGUE[locale]['department'] ?? {}).sort()
    expect(keys('it')).toEqual(keys('en'))
    for (const locale of LOCALES) for (let no = 1; no <= 9; no += 1) for (const leaf of ['name', 'short']) expect(CATALOGUE[locale]['department']?.[`fixed.${no}.${leaf}`], `${locale} ${no} ${leaf}`).toBeTruthy()
  })

  it('layout only, DS tokens only: every tone class, no raw colour, the room decides (container queries, no media query)', () => {
    const css = readFileSync(join(HERE, 'department.css'), 'utf8')
    for (const tone of DEPARTMENT_TONES) expect(css, tone).toContain(`.fw-dept-tone-${tone} {\n  --fw-dept-bg: var(--nds-grid-tone-${tone}-bg);`)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).toContain('@container fw-dept-strip (min-width: 480px)')
    expect(css).not.toContain('@media')
  })
})
