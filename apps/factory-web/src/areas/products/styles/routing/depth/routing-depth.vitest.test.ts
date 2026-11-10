import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { routingTimesView } from '@nexus/factory-domain/product/minutes/contracts'
import { checkpointView, routingDepthView, settingView, stepDepthView } from '@nexus/factory-domain/product/routing-depth/contracts'
import { CHECKPOINT_STAGES as DOMAIN_CHECKPOINT_STAGES, SETTING_LIMITS as DOMAIN_SETTING_LIMITS } from '@nexus/factory-domain/product/routing-depth/rules'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { settingSchema } from '../../../operations/depth/api'
import { SETTING_LIMITS } from '../../../operations/depth/model'
import { designScreen as routingScreen } from '../fixtures'
import { checkpointSchema, routingDepthSchema, stepDepthSchema } from './api'
import { DEMO_OPTIONS, DEMO_PLANS, demoDepth, demoTimes, STEP_ID } from './demo/fixtures'
import { CHECKPOINT_STAGES, checkpointChoices, copyLibraryHeld, depthHeld, optionChoicesOf, rowsOf, runWords, sameVariants, sizeCellBody, timesBodyOf, timesDraftOf, timesProblems, timesSaveHeld, variantsBodyOf, type StepTimes } from './model'

/**
 * B-W2b-235 — the Routing tab in depth: the shapes written here equal factory-domain's (its file reaches `node:crypto`), a size
 * cell's write, the Times dialog sends only what changed, variants in the style's order, the checkpoint plans a step may take,
 * every key in both languages, every W2b case drawn with no key left.
 */

describe('the shapes and lists written here equal factory-domain\'s', () => {
  it('limits and stages', () => {
    expect(SETTING_LIMITS).toEqual(DOMAIN_SETTING_LIMITS)
    expect([...CHECKPOINT_STAGES]).toEqual([...DOMAIN_CHECKPOINT_STAGES])
  })
  it('the same fields, and the made-up answers parse with both', () => {
    expect(Object.keys(settingSchema.shape).sort()).toEqual(Object.keys(settingView.shape).sort())
    expect(Object.keys(checkpointSchema.shape).sort()).toEqual(Object.keys(checkpointView.shape).sort())
    expect(Object.keys(stepDepthSchema.shape).sort()).toEqual(Object.keys(stepDepthView.shape).sort())
    expect(Object.keys(routingDepthSchema.shape).sort()).toEqual(Object.keys(routingDepthView.shape).sort())
    for (const released of [false, true]) {
      const depth = demoDepth({ released, options: true })
      expect(routingDepthSchema.parse(depth)).toEqual(routingDepthView.parse(depth))
      expect(() => routingTimesView.parse(demoTimes({ released }))).not.toThrow()
    }
  })
})

const times = demoTimes()
const step = (code: string): StepTimes => times.steps.find((entry) => entry.stepId === STEP_ID[code])!
const SIZES = times.sizes.map((size) => size.code)

describe('rows, held, words', () => {
  it('one row per step in routing order, its depth beside its times', () => {
    const rows = rowsOf(demoDepth(), times)
    expect(rows.map((row) => row.seq)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90])
    expect(rows.every((row) => row.depth !== null && row.times !== null)).toBe(true)
  })
  it('a released revision, an archived style or a role without the right is read only', () => {
    expect(depthHeld(demoDepth(), true)).toBeNull()
    expect(depthHeld(demoDepth({ released: true }), true)).toBe('depth.held.frozen')
    expect(depthHeld(demoDepth(), false)).toBe('depth.held.noManage')
    expect(depthHeld({ ...demoDepth(), style: { ...demoDepth().style, status: 'ARCHIVED' } }, true)).toBe('depth.held.archived')
    expect(runWords(step('TAG-PEL'))).toEqual({ key: 'run.version', params: { number: 2 } })
    expect(runWords(step('CUC-FOD')).key).toBe('run.allowances')
  })
})

describe('a size cell saves the step\'s whole list with that size changed', () => {
  it('adds, changes, clears (empty or 0) and refuses what would leave no time', () => {
    expect(sizeCellBody(step('CUC-MAN'), '54', '1,5')).toEqual({ body: { sizeTimes: [{ size: '56', extraMinutes: '1' }, { size: '58', extraMinutes: '2' }, { size: '54', extraMinutes: '1.5' }] } })
    expect(sizeCellBody(step('CUC-MAN'), '58', null)).toEqual({ body: { sizeTimes: [{ size: '56', extraMinutes: '1' }] } })
    expect(sizeCellBody(step('CUC-MAN'), '56', '0')).toEqual({ body: { sizeTimes: [{ size: '58', extraMinutes: '2' }] } })
    expect(sizeCellBody(step('CQ-FIN'), '46', '-6')).toEqual({ problem: 'times.problem.belowZero' })
    expect(sizeCellBody(step('CQ-FIN'), '46', 'abc')).toEqual({ problem: 'times.problem.extra' })
  })
})

describe('the Times dialog sends only what changed', () => {
  it('nothing changed: held; a typed run, a side minute cleared, a size added', () => {
    const sleeve = step('CUC-MAN')
    const draft = timesDraftOf(sleeve, SIZES, 'it')
    expect(draft).toMatchObject({ run: 'TYPED', typed: '18,5', setup: '10', wait: '15', move: '' })
    expect(timesBodyOf(draft, sleeve, SIZES)).toBeNull()
    expect(timesSaveHeld(draft, sleeve, SIZES, false)).toBe('times.held.same')
    expect(timesBodyOf({ ...draft, typed: '18', wait: '', extras: { ...draft.extras, '54': '0,5' } }, sleeve, SIZES)).toEqual({
      run: { from: 'TYPED', standardMinutes: '18' },
      waitMinutes: null,
      sizeTimes: [
        { size: '54', extraMinutes: '0.5' },
        { size: '56', extraMinutes: '1' },
        { size: '58', extraMinutes: '2' },
      ],
    })
  })
  it('the library\'s approved version: copied when the step does not follow the one in force; refused when there is none', () => {
    const sleeve = step('CUC-MAN')
    expect(timesBodyOf({ ...timesDraftOf(sleeve, SIZES, 'en'), run: 'VERSION' }, sleeve, SIZES)).toEqual({ run: { from: 'VERSION' } })
    const cut = step('TAG-PEL')
    expect(timesBodyOf(timesDraftOf(cut, SIZES, 'en'), cut, SIZES)).toBeNull()
    const zip = step('CUC-ZIP')
    expect(timesProblems({ ...timesDraftOf(zip, SIZES, 'en'), run: 'VERSION' }, zip).run).toBe('times.problem.noVersion')
    // Governed, but no approved version in force today (the first one starts later): a step copied from it keeps it, nothing
    // is re-copied; a typed step may not choose it yet.
    const later = { ...cut, library: { ...cut.library, inForceVersionId: null, inForceNumber: null } }
    expect(timesBodyOf({ ...timesDraftOf(later, SIZES, 'en'), setup: '25' }, later, SIZES)).toEqual({ setupMinutes: '25' })
    expect(timesProblems(timesDraftOf(later, SIZES, 'en'), later)).toEqual({})
    const typedLater = { ...sleeve, library: { ...sleeve.library, inForceVersionId: null, inForceNumber: null } }
    expect(timesProblems({ ...timesDraftOf(typedLater, SIZES, 'en'), run: 'VERSION' }, typedLater).run).toBe('times.problem.notInForce')
  })
  it('own allowances: the domain\'s rule; a bad percentage or a negative side minute is refused', () => {
    const sleeve = step('CUC-MAN')
    const draft = { ...timesDraftOf(sleeve, SIZES, 'en'), run: 'ALLOWANCES' as const, basic: '16', personal: '5', fatigue: '4', delay: '2.5625' }
    expect(timesBodyOf(draft, sleeve, SIZES)).toEqual({ run: { from: 'ALLOWANCES', basicMinutes: '16', personalPct: '5', fatiguePct: '4', delayPct: '2.5625' } })
    expect(timesProblems({ ...draft, personal: '120' }, sleeve).personal).toBe('times.problem.allowance')
    expect(timesProblems({ ...draft, setup: '-1' }, sleeve).setup).toBe('times.problem.side')
  })
})

describe('variants, checkpoints, the selection', () => {
  it('variants go in the style\'s order; options as the style offers them', () => {
    const depth = demoDepth({ options: true })
    const options = optionChoicesOf(DEMO_OPTIONS, 'en')
    expect(options.map((option) => option.label)).toEqual(['Hood: fixed', 'Hood: detachable'])
    const colourways = depth.colourways.map((colourway) => colourway.id)
    expect(variantsBodyOf({ sizes: ['58', '46'], colourwayIds: [colourways[2]!, colourways[0]!], optionValueIds: [options[1]!.id] }, depth, options)).toEqual({ sizes: ['46', '58'], colourwayIds: [colourways[0]!, colourways[2]!], optionValueIds: [options[1]!.id] })
    expect(sameVariants({ sizes: ['54', '56'], colourwayIds: [], optionValueIds: [] }, { sizes: ['56', '54'], colourwayIds: [], optionValueIds: [] })).toBe(true)
  })
  it('a checkpoint is a cutting, in-line or end-of-line plan of the style\'s company, not retired', () => {
    expect(checkpointChoices(DEMO_PLANS, demoDepth().style.companyId).map((plan) => plan.code)).toEqual(['DEMO-INL-TAG', 'DEMO-EOL-MAN', 'DEMO-INL-CUC'])
    expect(checkpointChoices(DEMO_PLANS, 'another-company')).toEqual([])
    expect(checkpointChoices([{ ...DEMO_PLANS[0]!, status: 'RETIRED' }], null)).toEqual([])
  })
  it('Copy library settings is held when no picked step has library settings', () => {
    const rows = rowsOf(demoDepth(), times)
    expect(copyLibraryHeld(rows.filter((row) => row.code === 'CUC-ZIP'), null, false)).toBe('bulk.held.noLibrary')
    expect(copyLibraryHeld(rows.filter((row) => row.code === 'CUC-SPA'), null, false)).toBeNull()
    expect(copyLibraryHeld(rows, 'depth.held.frozen', false)).toBe('depth.held.frozen')
  })
})

// ---- every key in both languages; every W2b case drawn with no key left ----------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
const PREFIXES = ['depth', 'col', 'sideCol', 'sizes', 'variants', 'checkpoint', 'settingsCol', 'stepSettings', 'copy', 'bulk', 'menu', 'depthKeys', 'times', 'run', 'runSource', 'stage', 'held', 'propose', 'settings']
const KEY = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
const has = (locale: (typeof LOCALES)[number], key: string) => {
  const dictionary = CATALOGUE[locale]['products-operations-depth'] ?? {}
  return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
}

describe('every key the routing in depth names exists in it and en', () => {
  const literal = sources(HERE).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(KEY)].map((match) => match[1]!))
  const tab = [...readFileSync(join(HERE, '../view/RoutingTab.tsx'), 'utf8').matchAll(/\btd\(\s*'([\w.]+)'/g)].map((match) => match[1]!)
  const built = [...['VERSION', 'ALLOWANCES', 'TYPED'].map((run) => `runSource.${run}`), ...['CUTTING', 'IN_LINE', 'END_OF_LINE'].map((stage) => `stage.${stage}`), 'run.version', 'run.versionOld', 'run.allowances', 'run.typed']
  const keys = [...new Set([...literal, ...tab, ...built])]
  for (const locale of LOCALES) {
    it(`products-operations-depth (${locale})`, () => {
      expect(keys.length).toBeGreaterThan(80)
      expect(keys.filter((key) => !has(locale, key))).toEqual([])
    })
  }
})

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

describe('every W2b case of SCR-043 draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    const cases = routingScreen.cases.filter((item) => item.id.startsWith('w2b-235'))
    it(`${locale}: ${cases.length} cases`, () => {
      expect(cases.length).toBeGreaterThan(10)
      for (const item of cases) {
        const View = (routingScreen as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model }))).replace(/https?:\/\/[^"\s<]+/g, '').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }
  it('the run beside the SMV says where it comes from', () => {
    const item = routingScreen.cases.find((entry) => entry.id === 'w2b-235-depth')!
    const View = (routingScreen as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
    const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(View, { model: item.model })))
    expect(html).toContain('From SMV version 2')
    expect(html).toContain('Built from its own allowances')
    expect(html).toContain('Times, sizes and checkpoints')
  })
})
