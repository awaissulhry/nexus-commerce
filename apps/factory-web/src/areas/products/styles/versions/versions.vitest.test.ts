import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GATE_ITEMS, GATE_STATES } from '@nexus/factory-domain/product/release/gate'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { demoBom, demoRouting, demoStyle, REV, STYLE_ID } from '../demo/fixtures'
import { STYLE_TABS, tabsFor } from '../model'
import {
  effectsOf,
  findingWords,
  fixHref,
  itemViews,
  meterTone,
  OWN_FINDING_CODES,
  pctText,
  pickOf,
  releaseGateHeld,
  samePick,
  scopeChoices,
  scopeSay,
  scopeToSend,
  togglePick,
  WHOLE,
  writeFault,
  type ReleaseState,
} from '../release/model'
import { changeLines, costLines, costState, defaultPair, mayWiden, moneyOf, pairHeld, pairIn, releasedText, versionsCan } from './model'
import { demoCompare, demoGate, designScreen as versionsScreen, RELEASED_PART, STYLE_ORDERS, STYLE_REQUESTS, VERSIONS } from './fixtures'

const CW = { BLK: '0190f0e2-7777-7000-8000-000000000011', ANT: '0190f0e2-7777-7000-8000-000000000012', RED: '0190f0e2-7777-7000-8000-000000000013' }
const ready = (over: Partial<ReleaseState> = {}, gate = demoGate()): ReleaseState => ({ mode: 'release', gate: { status: 'ready', value: gate }, pick: WHOLE, none: { colourways: false, sizes: false }, partial: false, previewing: false, busy: false, problem: null, ...over })

describe('Versions & changes: who reads what, the revisions and the pair compared', () => {
  it('the tab reads with the BOM right; its sections ask theirs; the cost needs the grain', () => {
    expect(STYLE_TABS.indexOf('versions')).toBe(STYLE_TABS.indexOf('activity') - 1)
    const all = tabsFor({ view: true, bomView: true } as never)
    expect(all).toContain('versions')
    expect(tabsFor({ view: true, bomView: false } as never)).not.toContain('versions')
    expect(versionsCan(['product.bom.view'])).toEqual({ read: true, changes: false, request: false, release: false, cost: false })
    expect(versionsCan(['product.bom.view', 'product.changes.view', 'product.changes.request', 'product.bom.release', 'money.cost'])).toEqual({ read: true, changes: true, request: true, release: true, cost: true })
  })
  it('compares the released revision with the draft by default, else what the last release changed', () => {
    const rows = VERSIONS.revisions
    expect(defaultPair(rows)).toEqual({ from: REV.r2, to: REV.r3 })
    expect(defaultPair(rows.filter((row) => row.status !== 'DRAFT'))).toEqual({ from: REV.r1, to: REV.r2 })
    expect(defaultPair([rows[0]!])).toBeNull()
    expect(pairIn(rows, { from: REV.r3, to: REV.r3 })).toEqual({ from: REV.r2, to: REV.r3 })
    expect(pairIn(rows, { from: REV.r1, to: REV.r3 })).toEqual({ from: REV.r1, to: REV.r3 })
    expect(pairHeld([rows[0]!], null)).toBe('pair.onlyOne')
    expect(pairHeld(rows, { from: REV.r2, to: REV.r2 })).toBe('pair.same')
    expect(pairHeld(rows, { from: REV.r2, to: REV.r3 })).toBeNull()
  })
  it('the cost difference only with its grain, in money', () => {
    expect(costState(demoCompare({ cost: 'absent' }))).toBe('absent')
    expect(costState(demoCompare({ cost: 'held' }))).toBe('held')
    expect(costState(demoCompare())).toBe('shown')
    const money = moneyOf('EUR', 'it')
    const lines = costLines(demoCompare().cost!, money)
    expect(lines[0]!.after!.fields.material).toBe(money('196.80'))
    expect(lines[0]!.after!.sizes!['52']).toBe('295.70')
    expect(moneyOf('EUR', 'en')('7.30')).toBe('€7.30')
  })
  it("the style's requests and orders as one table, newest first, a person as You or A colleague", () => {
    const lines = changeLines({ requests: STYLE_REQUESTS, orders: STYLE_ORDERS, complete: true }, '/w/DEMO', 'nobody')
    expect(lines).toHaveLength(STYLE_REQUESTS.length + STYLE_ORDERS.length)
    expect([...lines].map((line) => line.at)).toEqual([...lines].map((line) => line.at).sort().reverse())
    expect(lines.every((line) => line.href.startsWith('/w/DEMO/products/changes/'))).toBe(true)
    expect(lines.filter((line) => line.kind === 'order').every((line) => line.raisedBy.key === 'person.other')).toBe(true)
  })
  it('Release more only for a revision released for some cells, and only with the release right', () => {
    expect(mayWiden(RELEASED_PART, { release: true })).toBe(true)
    expect(mayWiden(RELEASED_PART, { release: false })).toBe(false)
    expect(mayWiden({ ...RELEASED_PART, scope: { ...RELEASED_PART.scope!, whole: true } }, { release: true })).toBe(false)
    expect(releasedText(RELEASED_PART)).toEqual({ colourways: 'NERO, ANTR', sizes: '46, 48, 50, 52, 54, 56', cells: 12 })
  })
})

describe('the Release modal on the gate', () => {
  it('every item in the design order; W1 findings in the studio words, the rest in ours; Fix to the right place', () => {
    const gate = demoGate()
    const views = itemViews(gate, { bom: demoBom(), routing: demoRouting() }, (item) => fixHref('/w/DEMO', STYLE_ID, REV.r3, item))
    expect(views.map((view) => view.code)).toEqual(GATE_ITEMS)
    const materials = views.find((view) => view.code === 'MATERIALS')!
    expect(materials.findings[0]).toEqual({ ns: 'versions', key: 'finding.MATERIAL_BLOCKED', params: expect.objectContaining({ line: '60 · ZIP-DIV-8' }) })
    expect(materials.fix).toBe(`/w/DEMO/products/styles/${STYLE_ID}?tab=compliance&rev=${REV.r3}`)
    expect(views.find((view) => view.code === 'BOM')!.fix).toBeNull()
    expect(fixHref('/w/DEMO', STYLE_ID, null, { code: 'PRICES', fix: 'materials' })).toBe(`/w/DEMO/products/styles/${STYLE_ID}?tab=bom`)
    expect(fixHref('/w/DEMO', STYLE_ID, null, { code: 'CHANGE_ORDERS', fix: 'changes' })).toBe(`/w/DEMO/products/changes?style=${STYLE_ID}`)
    expect(fixHref('/w/DEMO', STYLE_ID, null, { code: 'SCOPE', fix: 'release' })).toBeNull()
    expect(findingWords({ code: 'SIZE_QUANTITY_MISSING', cell: { lineId: null, column: null, size: '58', colourwayId: null, alternateId: null, stepId: null, recordId: null, field: null } }, { bom: null, routing: null, gate })).toEqual({ ns: 'products', key: 'issue.SIZE_QUANTITY_MISSING', params: expect.objectContaining({ size: '58' }) })
    expect(findingWords({ code: 'CELL_NOT_COVERED', cell: { lineId: null, column: null, size: '58', colourwayId: CW.RED, alternateId: null, stepId: null, recordId: null, field: null } }, { bom: null, routing: null, gate }).params).toMatchObject({ colourway: 'ROSSO', size: '58' })
  })
  it('the completeness score and its tone from what is open, never from the %', () => {
    expect(pctText('87.5', 'it')).toBe('87,5 %')
    expect(pctText(null, 'en')).toBeNull()
    expect(meterTone(demoGate())).toBe('missing')
    expect(meterTone(demoGate({ blocked: false }))).toBe('partial')
  })
  it('the scope: every one listed collapses to every one; the last one unticked is "none", never sent', () => {
    const every = [CW.BLK, CW.ANT, CW.RED]
    const one = togglePick(WHOLE, 'colourway', CW.RED, every)
    expect(one).toEqual({ colourwayIds: [CW.BLK, CW.ANT], sizes: [] })
    expect(togglePick(one, 'colourway', CW.RED, every)).toEqual(WHOLE)
    expect(samePick({ colourwayIds: [CW.ANT, CW.BLK], sizes: [] }, one)).toBe(true)
    expect(pickOf(demoGate())).toEqual(WHOLE)
    const partial = demoGate({ asked: one })
    expect(pickOf(partial)).toEqual(one)
    expect(scopeSay(one, partial)).toEqual({ ns: 'versions', key: 'scope.colourwaysOnlyWaiting', params: { colourways: 'NERO, ANTR', sizes: '', waiting: 'ROSSO' } })
    expect(scopeSay({ colourwayIds: [], sizes: ['46', '48', '50'] }, partial).params).toMatchObject({ sizes: '46–50', waiting: '52–58' })
    expect(scopeSay(WHOLE, partial)).toEqual({ ns: 'versions', key: 'scope.whole' })
    expect(scopeToSend({ pick: one }, demoGate())).toEqual(one)
    expect(scopeToSend({ pick: WHOLE }, demoGate())).toBeNull()
  })
  it('a later release keeps what is released ticked and fixed, and only goes when it adds', () => {
    const gate = demoGate({ mode: 'widen' })
    const choices = scopeChoices(gate, pickOf(gate, 'planned'), { colourways: false, sizes: false })
    expect(choices.colourways.map((choice) => [choice.label, choice.on, choice.fixed])).toEqual([
      ['NERO', true, true],
      ['ANTR', true, true],
      ['ROSSO', false, false],
    ])
    const style = demoStyle()
    expect(releaseGateHeld(ready({ mode: 'widen', pick: pickOf(gate, 'planned') }, gate), style, { release: true })).toEqual({ ns: 'versions', key: 'hold.notWider' })
    expect(releaseGateHeld(ready({ mode: 'widen', pick: { colourwayIds: [], sizes: pickOf(gate, 'planned').sizes } }, gate), style, { release: true })).toBeNull()
  })
  it('"Release revision N" is held with the first reason, in order', () => {
    const style = demoStyle()
    expect(releaseGateHeld(ready(), style, { release: false })).toEqual({ ns: 'products', key: 'held.noRelease' })
    expect(releaseGateHeld(ready({ gate: { status: 'loading' } }), style, { release: true })).toEqual({ ns: 'versions', key: 'hold.reading' })
    expect(releaseGateHeld(ready(), style, { release: true })).toEqual({ ns: 'versions', key: 'hold.blocked', params: { item: 'gateItem.MATERIALS' } })
    const passes = demoGate({ blocked: false })
    expect(releaseGateHeld(ready({ none: { colourways: true, sizes: false } }, passes), style, { release: true })).toEqual({ ns: 'versions', key: 'hold.scopeEmpty' })
    expect(releaseGateHeld(ready({ previewing: true }, passes), style, { release: true })).toEqual({ ns: 'versions', key: 'hold.reading' })
    expect(releaseGateHeld(ready({ busy: true }, passes), style, { release: true })).toEqual({ ns: 'products', key: 'held.busy' })
    expect(releaseGateHeld(ready({}, passes), style, { release: true })).toBeNull()
    expect(releaseGateHeld(ready({}, passes), demoStyle({ status: 'ARCHIVED' }), { release: true })).toEqual({ ns: 'products', key: 'held.archived' })
  })
  it('what happens: the studio words, the scope, the open quotes and orders kept on the old revision', () => {
    const effects = effectsOf(demoGate({ blocked: false }), demoStyle(), WHOLE).map((effect) => `${effect.ns}:${effect.key}`)
    expect(effects).toEqual(['products:release.becomes', 'products:release.obsoletes', 'versions:scope.whole', 'versions:effect.drift', 'products:release.frozen'])
  })
  it('a refusal in words: a rule by its code (Changes & versions), else by kind', () => {
    const refusal = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/DRAFT_UNDER_CHANGE_ORDER', message: 'x' }])
    expect(writeFault(refusal)).toEqual({ ns: 'changes', key: 'refusal.DRAFT_UNDER_CHANGE_ORDER' })
    expect(writeFault(new ApiError('conflict', 409, 'version_conflict', 'x'))).toEqual({ ns: 'versions', key: 'fault.moved' })
    expect(writeFault(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/sizes/1', message: 'x' }]))).toEqual({ ns: 'versions', key: 'fault.scope' })
  })
})

// ---- every word in it and en; every design case draws with no key left -------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../../..', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
const ROOTS = ['base', 'ver', 'cmp', 'pair', 'costCmp', 'failed', 'col', 'released', 'chg', 'drift', 'gateCheck', 'gateItem', 'gateWhat', 'gateState', 'finding', 'scope', 'hold', 'effect', 'widen', 'fault', 'wo']
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale]['products-versions'] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('products-versions: every key the screens name exists in it and en', () => {
  it('literal keys of the owned folders, and the built ones', () => {
    const pattern = new RegExp(`['"\`]((?:${ROOTS.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
    const keys = new Set<string>()
    for (const dir of ['areas/products/styles/versions', 'areas/products/styles/release', 'areas/production/work-orders/spec']) for (const file of sources(join(SRC, dir))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    const built = [
      ...GATE_ITEMS.flatMap((code) => [`gateItem.${code}`, `gateWhat.${code}`]),
      ...GATE_STATES.map((state) => `gateState.${state}`),
      ...OWN_FINDING_CODES.map((code) => `finding.${code}`),
      ...['both', 'colourwaysOnly', 'sizesOnly'].flatMap((key) => [`scope.${key}`, `scope.${key}Waiting`]),
      ...['versions', 'changes', 'drift', 'released'].map((part) => `failed.${part}`),
      ...['NEWER_RELEASED', 'WITHDRAWN'].map((state) => `wo.newer.${state}`),
      ...['none', 'FINISH_OLD', 'REWORK', 'SCRAP', 'HOLD'].map((kind) => `wo.decision.${kind}`),
      ...['material', 'labour', 'overhead'].map((field) => `costCmp.field.${field}`),
    ]
    expect(keys.size).toBeGreaterThan(80)
    expect([...keys, ...built].filter((key) => !has(key))).toEqual([])
  })
})

const LEFT_KEY = new RegExp(`\\b(?:${ROOTS.join('|')}|refusal|problem|issue|release|held|notice|tab|record|check|size|overview|status)\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case of SCR-348 draws in both languages with no key left on screen', () => {
  for (const screen of [versionsScreen] as unknown as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/href="[^"]*"/g, '').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
