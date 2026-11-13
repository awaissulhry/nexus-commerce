import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { newTemplateBody as domainNewTemplateBody, templatePointsBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { libraryOf, libraryOfKey, LIBRARIES } from '../depth/model'
import { canOf, SUIT, SUIT_RULES, TEMPLATE_ROWS } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import { designScreen as recordScreen } from './record/fixtures'
import {
  archiveHeld,
  archivedBySave,
  changeCount,
  copyPointsOf,
  draftsOf,
  editHeld,
  emptyNewDraft,
  newPointDraft,
  newTemplateBody,
  newTemplateHeld,
  NS,
  pointProblems,
  pointsBody,
  recordHref,
  refusedPoints,
  restoredDraft,
  ridersHref,
  rowFactsOf,
  ruleBounds,
  rulesFacts,
  ruleWords,
  saveHeld,
  switchHeld,
  tabOf,
  templateCan,
  writeProblem,
} from './model'

/** B-W2b-362 — Products › Sizes & measurements › Measurement templates (B-W1-17): the rules the screens hold, their words, their cases. */

describe('the view switch and the addresses', () => {
  it('the templates are the second view (design order), key 2', () => {
    expect(LIBRARIES).toEqual(['scales', 'templates', 'poms', 'rules'])
    expect(libraryOf('templates')).toBe('templates')
    expect(libraryOfKey('2')).toBe('templates')
  })
  it('a template opens on its own page; its riders on Sales › Made-to-measure', () => {
    expect(recordHref('/w/DEMO', 'abc')).toBe('/w/DEMO/products/sizes/templates/abc')
    expect(recordHref('/w/DEMO', 'abc', 'mtm')).toBe('/w/DEMO/products/sizes/templates/abc?tab=mtm')
    expect(ridersHref('/w/DEMO', 'RACE_SUIT')).toBe('/w/DEMO/sales/made-to-measure?garment=RACE_SUIT')
    expect(tabOf('whereused')).toBe('whereused')
    expect(tabOf('nope')).toBe('points')
  })
})

describe('who may do what', () => {
  it('reads with product.styles.view, keeps with product.styles.manage, starts made-to-measure only with product.mtm.switch', () => {
    expect(templateCan(['product.styles.view'])).toEqual({ view: true, manage: false, switch: false })
    expect(canOf('owner').switch).toBe(true)
    expect(canOf('developer')).toMatchObject({ manage: true, switch: false })
    expect(canOf('sales')).toMatchObject({ view: true, manage: false })
  })
})

describe('New template', () => {
  const can = canOf('owner')
  const taken = TEMPLATE_ROWS.map((row) => row.code)
  it('is held with its reason before the click', () => {
    const draft = emptyNewDraft(null)
    expect(newTemplateHeld(draft, { can: canOf('sales'), busy: false, taken, copy: [] })?.key).toBe('held.noManage')
    expect(newTemplateHeld({ ...draft, code: 'race suit' }, { can, busy: false, taken, copy: [] })?.key).toBe('new.held.code')
    expect(newTemplateHeld({ ...draft, code: 'JACKET' }, { can, busy: false, taken, copy: [] })).toEqual({ key: 'new.held.taken', params: { code: 'JACKET' } })
    expect(newTemplateHeld({ ...draft, code: 'RAIN', name: 'Rain' }, { can, busy: false, taken, copy: [] })?.key).toBe('new.held.type')
    expect(newTemplateHeld({ ...draft, code: 'RAIN', name: 'Rain', productType: 'JACKET' }, { can, busy: false, taken, copy: [] })?.key).toBe('new.held.firstCode')
    expect(newTemplateHeld({ ...draft, code: 'RAIN', name: 'Rain', productType: 'JACKET', start: 'copy' }, { can, busy: false, taken, copy: null })?.key).toBe('new.held.copyFrom')
    expect(newTemplateHeld({ ...draft, code: 'RAIN', name: 'Rain', productType: 'JACKET', start: 'copy', copyFromId: SUIT.id }, { can, busy: false, taken, copy: null })?.key).toBe('new.held.copyReading')
    expect(newTemplateHeld({ ...draft, code: 'RAIN', name: 'Rain', productType: 'JACKET', firstCode: 'chest', firstName: 'Chest' }, { can, busy: false, taken, copy: [] })).toBeNull()
  })
  it('sends a body the API accepts: blank with one point, or a copy of the active points', () => {
    const blank = newTemplateBody({ ...emptyNewDraft(null), code: 'RAIN', name: 'Rain', productType: 'JACKET', firstCode: 'chest', firstName: 'Chest' }, null)
    expect(domainNewTemplateBody.safeParse(blank).success).toBe(true)
    expect(blank.points).toHaveLength(1)
    const copy = copyPointsOf(SUIT)
    expect(copy.map((point) => point.code)).not.toContain('neck')
    expect(copy[9]?.uom).toBe('MM')
    expect(domainNewTemplateBody.safeParse(newTemplateBody({ ...emptyNewDraft(null), code: 'KART', name: 'Kart', productType: 'SUIT', start: 'copy', copyFromId: SUIT.id }, copy)).success).toBe(true)
  })
})

describe('the points saved whole', () => {
  it('the editor holds the active points in order; the PUT body passes the domain contract', () => {
    const drafts = draftsOf(SUIT)
    expect(drafts.map((draft) => draft.code)).toEqual(['height', 'chest', 'waist', 'hips', 'sleeve', 'back_length', 'inseam', 'outseam', 'knee', 'wrist'])
    expect(templatePointsBody.safeParse({ version: SUIT.version, points: pointsBody(drafts) }).success).toBe(true)
    expect(changeCount(SUIT, drafts)).toBe(0)
    expect(saveHeld(SUIT, drafts, false)?.key).toBe('edit.held.unchanged')
  })
  it('counts a move, an addition and what Save archives', () => {
    const drafts = draftsOf(SUIT)
    const moved = [drafts[1]!, drafts[0]!, ...drafts.slice(2, 9)]
    expect(archivedBySave(SUIT, moved)).toEqual(['wrist'])
    expect(changeCount(SUIT, moved)).toBe(3)
    const added = [...drafts, { ...newPointDraft(), code: 'shoulder', name: 'Shoulder' }]
    expect(changeCount(SUIT, added)).toBe(1)
    expect(saveHeld(SUIT, added, false)).toBeNull()
    expect(saveHeld(SUIT, [], false)?.key).toBe('edit.held.none')
  })
  it('refuses before it goes: a code twice, no name, min above max, not a number', () => {
    const drafts = draftsOf(SUIT)
    const bad = [{ ...drafts[0]!, min: '210', max: '140' }, { ...drafts[1]!, name: '' }, { ...newPointDraft(), code: 'chest', name: 'Again', min: 'x' }]
    const problems = pointProblems(bad)
    expect(problems[bad[0]!.key]?.max?.key).toBe('point.problem.order')
    expect(problems[bad[1]!.key]?.name?.key).toBe('point.problem.name')
    expect(problems[bad[2]!.key]?.code?.key).toBe('point.problem.twice')
    expect(problems[bad[2]!.key]?.min?.key).toBe('point.problem.number')
    expect(saveHeld(SUIT, bad, false)).toEqual({ key: 'edit.held.problems', params: { count: 3 } })
  })
  it('an archived point put back keeps its code (the API makes it active again)', () => {
    const neck = SUIT.points.find((point) => point.code === 'neck')!
    expect(restoredDraft(neck)).toMatchObject({ code: 'neck', isNew: false })
  })
  it('a refused save names its points by their place in the list sent', () => {
    const drafts = draftsOf(SUIT)
    expect(refusedPoints(['points/2/maxValue', 'version'], drafts)).toEqual({ [drafts[2]!.key]: { max: { key: 'point.problem.refused' } } })
  })
})

describe('held writes and refusals in our words', () => {
  it('edit, archive and the switch say why', () => {
    expect(editHeld(SUIT, canOf('sales'))?.key).toBe('held.noManage')
    expect(editHeld({ ...SUIT, status: 'ARCHIVED' }, canOf('owner'))?.key).toBe('held.archived')
    expect(archiveHeld(SUIT, canOf('owner'))).toEqual({ key: 'held.stylesUse', params: { count: 3 } })
    expect(archiveHeld({ ...SUIT, rulesOn: true }, canOf('owner'))?.key).toBe('held.rulesOn')
    expect(archiveHeld({ ...SUIT, styles: { measured: 0, madeToMeasure: 0 } }, canOf('owner'))).toBeNull()
    expect(switchHeld(SUIT_RULES, true, canOf('developer'), false)?.key).toBe('held.noSwitch')
    expect(switchHeld({ ...SUIT_RULES, template: { ...SUIT_RULES.template, status: 'ARCHIVED' } }, true, canOf('owner'), false)?.key).toBe('held.archivedOn')
    expect(switchHeld(SUIT_RULES, true, canOf('owner'), false)).toBeNull()
  })
  it('a moved version reads again; the rules that still need a point; never the API\'s English', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'version_conflict', 'Changed meanwhile.'))).toMatchObject({ key: 'problem.moved', reload: true })
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'The made-to-measure rules of X still need…', null, [{ path: 'template/rules/0/pointCode', message: 'x' }])).key).toBe('problem.rulesNeedPoints')
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'no', null, [{ path: 'body/points/1/code', message: 'x' }]))).toMatchObject({ key: 'problem.fields', paths: ['points/1/code'] })
  })
})

describe('the made-to-measure rules read', () => {
  it('counts in force and blocking, the base size rule, limits and tolerances', () => {
    expect(rulesFacts(SUIT_RULES)).toEqual({ active: 3, blocking: 2, baseSizePoints: ['chest', 'height'], tie: 'LARGER', limits: 3, tolerances: 2 })
  })
  it('a rule in its own words for the reader, its bounds as figures', () => {
    const [order, ratio, range] = SUIT_RULES.rules
    expect(ruleWords(order!, 'it')).toContain('cavallo')
    expect(ruleWords({ code: 'X', messageI18n: { en: 'English only' } }, 'it')).toBe('English only')
    expect(ruleBounds(ratio!)).toBe('0.60–1.20')
    expect(ruleBounds(range!)).toBe('78–140')
    expect(ruleBounds(order!)).toBeNull()
  })
  it('a row\'s facts from its page', () => {
    expect(rowFactsOf(SUIT)).toEqual({ required: 8, styles: { measured: 3, madeToMeasure: 2 }, profiles: 14 })
  })
})

// ---- words -------------------------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') ? [join(dir, entry.name)] : []))
const PREFIXES = ['common', 'col', 'csv', 'type', 'status', 'view', 'unit', 'tab', 'kind', 'severity', 'mtm', 'switch', 'held', 'list', 'new', 'point', 'points', 'edit', 'preview', 'record', 'rename', 'move', 'used', 'problem']

function literalKeys(): string[] {
  const keys = new Set<string>()
  for (const file of files(HERE)) {
    if (file.endsWith('fixtures.ts')) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]!)
    for (const match of text.matchAll(/(?:key: |phrase\()'([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]!)
  }
  return [...keys]
}

const built = [
  ...['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'].map((type) => `type.${type}`),
  ...['ACTIVE', 'ARCHIVED'].map((status) => `status.${status}`),
  ...['open', 'archived', 'all'].map((view) => `view.${view}`),
  ...['points', 'mtm', 'whereused'].map((tab) => `tab.${tab}`),
  ...['ORDER', 'RATIO', 'RANGE'].map((kind) => `kind.${kind}`),
  ...['BLOCK', 'WARN'].map((severity) => `severity.${severity}`),
  ...['code', 'name', 'type', 'points', 'mtm', 'status'].map((column) => `csv.${column}`),
  'mtm.on', 'mtm.off', 'mtm.start', 'mtm.stop', 'mtm.onBody', 'mtm.offBody', 'mtm.offOwner', 'mtm.offOthers', 'mtm.archivedRule', 'mtm.baseSizeFrom', 'mtm.baseSizeFromSmaller', 'mtm.done.on', 'mtm.done.off',
  'list.mtmOnHint', 'list.mtmOffHint', 'list.count', 'list.countMore', 'list.empty.body', 'list.empty.bodyView',
  'switch.titleOn', 'switch.titleOff', ...['on1', 'on2', 'on3', 'off1', 'off2', 'off3'].map((key) => `switch.${key}`),
  'move.archiveTitle', 'move.restoreTitle', 'move.archive1', 'move.archive2', 'move.restore1', 'move.archived', 'move.restored',
  'unit.CM', 'unit.MM',
  ...['unavailable', 'forbidden', 'forbiddenWrite', 'notFound', 'rateLimited', 'contract', 'internal', 'invalid', 'fields', 'moved', 'codeTaken', 'state', 'rulesNeedPoints'].map((key) => `problem.${key}`),
]

describe('every key the screens name exists in it and en, with the same placeholders', () => {
  for (const locale of LOCALES) {
    it(`${NS} (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.[NS] ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      const keys = [...literalKeys(), ...built].filter((key) => PREFIXES.includes(key.split('.')[0]!))
      expect(keys.length).toBeGreaterThan(200)
      expect(keys.filter((key) => !has(key))).toEqual([])
    })
  }
  it('the two languages hold the same keys', () => {
    expect(Object.keys(CATALOGUE.it?.[NS] ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en?.[NS] ?? {}).sort())
  })
  it('the view switch names the templates in both languages', () => {
    for (const locale of LOCALES) expect(CATALOGUE[locale]?.['products-sizes-depth']?.['switch.templates']).toBeTruthy()
  })
})

// The preview draws the MeasurementForm (sales-mtm words: form.*, zone.*).
const LEFT_KEY = new RegExp(`\\b(?:${[...PREFIXES.filter((prefix) => !['type', 'status', 'view', 'unit', 'kind', 'common'].includes(prefix)), 'form', 'zone'].join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/href="[^"]*"/g, '')
            .replace(/\b(?:product|sales|quotes|money|files)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the Italian page says no English of this step', () => {
    const html = render(recordScreen as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'mtm-off-owner')!.model, 'it')
    for (const english of ['Made-to-measure', 'Start made-to-measure', 'What it checks', 'Blocks']) expect(html).not.toContain(english)
  })
})
