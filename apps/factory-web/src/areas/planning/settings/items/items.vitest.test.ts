import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOT_SIZINGS, PLAN_LEVELS } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen } from '../params/fixtures'
import { RULE_ENTRIES, RULE_ROWS } from './demo'
import { clearedRuleWords, ITEM_RULES_NAMESPACE, lotPatch, lotWords, parseRule, planLevelHeld, rulesOf, rulesPlan, ruleWords, sizeRunOf, sizeRunPlan } from './model'

/**
 * B-W2b-335 — Planning settings › Item parameters, the planning rules per item and the site's size run (SCR-127): what a
 * typed or chosen rule sends (factory-domain's rules first, refused in our words), why a plan-level cell is held, what the
 * rules do in our words, the size groups as typed, and the W2b design cases in both languages with no key on screen.
 */

const cowhide = RULE_ROWS[0]!
const slider = RULE_ROWS.find((row) => row.item.kind === 'COMPONENT')!
const jacket = RULE_ROWS.find((row) => row.item.kind === 'FINISHED')!

describe('a rule as typed or chosen', () => {
  it('reads the defaults of a row without rules', () => {
    expect(rulesOf(null)).toBeNull()
    expect(rulesOf({ ...cowhide.row!, lotSizing: undefined, fixedLotQty: undefined })).toMatchObject({ lotSizing: 'LOT_FOR_LOT', fixedLotQty: null })
  })

  it('sends only a change, refuses in words what the domain refuses, and says what a switch clears', () => {
    expect(rulesPlan(cowhide.row, 'LEATHER', { lotSizing: 'FIXED', fixedLotQty: '105' })).toEqual({ kind: 'none' })
    expect(rulesPlan(cowhide.row, 'LEATHER', { lotSizing: 'PERIOD' })).toMatchObject({ kind: 'refused', field: 'lotPeriodDays', words: { key: 'items.problem.periodNeeded' } })
    expect(rulesPlan(cowhide.row, 'LEATHER', { planLevel: 'SKU' })).toMatchObject({ kind: 'refused', words: { key: 'items.held.material' } })
    const write = rulesPlan(cowhide.row, 'LEATHER', { lotSizing: 'LOT_FOR_LOT' })
    expect(write).toMatchObject({ kind: 'write', patch: { lotSizing: 'LOT_FOR_LOT' }, cleared: ['fixedLotQty'] })
    expect(clearedRuleWords(['fixedLotQty'])).toEqual({ key: 'items.cleared', params: { fields: 'items.field.fixedLotQty' } })
    expect(rulesPlan(jacket.row, 'FINISHED', { planLevel: 'SKU' })).toMatchObject({ kind: 'write', patch: { planLevel: 'SKU' } })
    expect(rulesPlan(null, 'LINING', { scrapPct: null })).toEqual({ kind: 'none' })
  })

  it('reads a typed cell and the lot dialog', () => {
    expect(parseRule('scrapPct', '2,5')).toEqual({ value: '2.5' })
    expect(parseRule('yieldPct', 'abc')).toEqual({ problem: { key: 'items.problem.yield' } })
    expect(parseRule('delayDays', ' 3 ')).toEqual({ value: 3 })
    expect(parseRule('delayDays', '')).toEqual({ value: null })
    expect(lotPatch('FIXED', '105,5', '')).toEqual({ patch: { lotSizing: 'FIXED', fixedLotQty: '105.5' } })
    expect(lotPatch('FIXED', '', '')).toMatchObject({ field: 'fixedLotQty', words: { key: 'items.problem.fixedNeeded' } })
    expect(lotPatch('PERIOD', '', '400')).toMatchObject({ field: 'lotPeriodDays' })
    expect(lotPatch('MIN_MAX', '', '')).toEqual({ patch: { lotSizing: 'MIN_MAX' } })
  })

  it('holds a plan level for a material and without planning.strategy.manage', () => {
    expect(planLevelHeld('LEATHER', { manageItems: true, strategy: true })).toBe('items.held.material')
    expect(planLevelHeld('FINISHED', { manageItems: true, strategy: false })).toBe('items.held.strategy')
    expect(planLevelHeld('COMPONENT', { manageItems: false, strategy: true })).toBe('items.held.items')
    expect(planLevelHeld('FINISHED', { manageItems: true, strategy: true })).toBeNull()
  })

  it('says what the rules do in our words', () => {
    expect(lotWords(rulesOf(cowhide.row), 'm²')).toEqual({ key: 'items.lotCell.FIXED', params: { quantity: '105', unit: 'm²' } })
    const words = ruleWords(rulesOf(slider.row), { method: 'ORDERS', itemKind: 'COMPONENT', unit: 'pcs', minOrderQty: null, orderMultiple: null, maxOrderQty: null })
    expect(words).toEqual([{ key: 'items.words.scrapYield', params: { factor: '1.0408' } }])
    expect(ruleWords(rulesOf(jacket.row), { method: 'ORDERS', itemKind: 'FINISHED', unit: 'pcs', minOrderQty: null, orderMultiple: null, maxOrderQty: null }).map((entry) => entry.key)).toEqual(['items.words.level.STYLE_COLOUR', 'items.words.scrapYieldFinished'])
  })
})

describe('the site’s size run', () => {
  it('reads one grid by default and checks the groups as typed', () => {
    expect(sizeRunOf(null)).toEqual({ sizeRunRule: 'ONE_GRID', sizeGroups: [] })
    const current = { sizeRunRule: 'ONE_GRID' as const, sizeGroups: [] }
    expect(sizeRunPlan(current, 'ONE_GRID', '')).toEqual({ kind: 'none' })
    expect(sizeRunPlan(current, 'SIZE_GROUPS', '44, 46\n46, 48')).toEqual({ kind: 'refused', words: { key: 'items.sizeRun.problem.twice', params: { size: '46' } } })
    expect(sizeRunPlan(current, 'SIZE_GROUPS', '44, 46, 48')).toMatchObject({ kind: 'refused', words: { key: 'items.sizeRun.problem.groups' } })
    expect(sizeRunPlan(current, 'SIZE_GROUPS', '44, 46, 48\n50 52 54')).toEqual({ kind: 'write', body: { sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['44', '46', '48'], ['50', '52', '54']] } })
  })
})

const LEFT_KEY = /\b(?:items|pp|ps)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:planning\.(?:items\.manage|strategy\.manage|settings\.manage|view)|purchasing\.view|calendars\.(?:view|manage))\b/g

describe('the W2b design cases of SCR-127 draw in both languages with no key on screen', () => {
  it('B-W2b-335 cases × it, en', () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const cases = screen.cases.filter((item) => item.id.startsWith('w2b-335-'))
    expect(cases.length).toBeGreaterThanOrEqual(10)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const View = screen.view as ComponentType<{ model: unknown }>
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model: item.model }))).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('every lot sizing and plan level has its words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [ITEM_RULES_NAMESPACE])[ITEM_RULES_NAMESPACE]!)
      for (const lot of LOT_SIZINGS) for (const key of [`items.lot.${lot}`, `items.lotHint.${lot}`, `lot.${lot}`]) expect(t(key), `${locale} ${key}`).not.toBe(key)
      for (const level of ['SITE', ...PLAN_LEVELS]) for (const key of [`items.level.${level}`, `items.levelHint.${level}`]) expect(t(key), `${locale} ${key}`).not.toBe(key)
      for (const level of PLAN_LEVELS) expect(t(`items.words.level.${level}`)).not.toBe(`items.words.level.${level}`)
    }
    expect(RULE_ENTRIES.length).toBeGreaterThan(6)
  })
})
