import { createElement, type ComponentType } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import type { CuttingRules, LeatherTolerance } from './api'
import { designScreen } from './fixtures'
import { areaOf, cuttingChange, cuttingDraftOf, cuttingHeld, cuttingProblem, percentOf, toleranceChange, toleranceDraftOf, toleranceHeld } from './model'

const SITE = { id: 's1', companyId: 'c1', code: 'STAB-N', name: 'Nord' }
const RULES: CuttingRules = { site: SITE, rules: { shadeRule: 'ORDER', hidePhotoRequired: false, minimumRemnant: { area: '10.0000', uom: 'DM2' } }, isDefault: false, version: 3, updatedAt: null, canManage: true }
const TOL: LeatherTolerance = { companyId: 'c1', percent: '2.00', from: 'DEFAULT', company: null, tenant: null, mayChange: true }

describe('the Cutting card: what Apply sends and why it is held', () => {
  it('the draft is the rules as they stand; nothing changed sends nothing', () => {
    const draft = cuttingDraftOf(RULES)
    expect(draft).toEqual({ shadeRule: 'ORDER', hidePhotoRequired: false, minimumArea: '10', minimumUom: 'DM2', reason: '' })
    expect(cuttingChange(RULES, draft)).toEqual({ body: {}, count: 0 })
    expect(cuttingHeld(draft, false)).toBeNull()
  })

  it('sends only what changed, with the reason and the version; the same minimum in other words is no change', () => {
    const draft = { ...cuttingDraftOf(RULES), shadeRule: 'GARMENT' as const, hidePhotoRequired: true, reason: ' collezione ' }
    expect(cuttingChange(RULES, draft)).toEqual({ body: { shadeRule: 'GARMENT', hidePhotoRequired: true, reason: 'collezione', version: 3 }, count: 2 })
    expect(cuttingChange(RULES, { ...cuttingDraftOf(RULES), minimumArea: '10,0' }).count).toBe(0)
    expect(cuttingChange(RULES, { ...cuttingDraftOf(RULES), minimumArea: '0,25', minimumUom: 'M2' }, 7)).toEqual({ body: { minimumRemnantArea: '0.25', minimumRemnantUom: 'M2', version: 7 }, count: 1 })
  })

  it('holds an empty, zero or too large minimum, a long reason, and while saving', () => {
    const draft = cuttingDraftOf(RULES)
    expect(cuttingHeld({ ...draft, minimumArea: '' }, false)).toBe('cr.held.area')
    expect(cuttingHeld({ ...draft, minimumArea: '0' }, false)).toBe('cr.held.area')
    expect(cuttingHeld({ ...draft, minimumArea: '11', minimumUom: 'M2' }, false)).toBe('cr.held.tooLarge')
    expect(cuttingHeld({ ...draft, minimumArea: '107', minimumUom: 'FT2' }, false)).toBeNull()
    expect(cuttingHeld({ ...draft, reason: 'x'.repeat(501) }, false)).toBe('cr.held.reasonLong')
    expect(cuttingHeld(draft, true)).toBe('cr.busy')
    expect(areaOf(' 0,5 ')).toBe('0.5')
    expect(areaOf('1.23456')).toBeNull()
  })

  it('the leather area tolerance: own value, follow, held', () => {
    expect(toleranceDraftOf(TOL)).toEqual({ own: false, percent: '2' })
    expect(toleranceChange(TOL, { own: false, percent: '2' })).toBeNull()
    expect(toleranceChange(TOL, { own: true, percent: '3,5' })).toEqual({ companyId: 'c1', percent: '3.5' })
    const own = { ...TOL, percent: '3.50', from: 'COMPANY' as const, company: { id: 'c1', percent: '3.50', version: 4, updatedAt: '2026-11-04T09:00:00.000Z' } }
    expect(toleranceChange(own, { own: true, percent: '3.5' })).toBeNull()
    expect(toleranceChange(own, { own: false, percent: '3.5' })).toEqual({ companyId: 'c1', percent: null, version: 4 })
    expect(toleranceHeld({ own: true, percent: '120' }, false)).toBe('cr.tolerance.held')
    expect(toleranceHeld({ own: false, percent: '120' }, false)).toBeNull()
    expect(percentOf('100')).toBe('100')
    expect(percentOf('2.555')).toBeNull()
  })

  it('answers the API in the card\'s words', () => {
    expect(cuttingProblem(new ApiError('conflict', 409, 'conflict', 'changed', null, [{ path: 'body/version', message: 'x' }]))).toEqual({ key: 'cr.problem.changed', conflict: true })
    expect(cuttingProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/minimumRemnantArea', message: 'x' }])).key).toBe('cr.held.tooLarge')
    expect(cuttingProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('cr.problem.forbidden')
    expect(cuttingProblem(new Error('x')).key).toBe('cr.problem.write')
  })
})

const KEY = /(?:^|[\s>"])(?:cr|fr)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*/
const PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:production\.[a-z.]+|people\.[a-z.]+|reasons\.[a-z.]+|purchasing\.[a-z.]+|money\.cost)\b/g

function draw(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = (designScreen as unknown as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'floor-rules', 'lists', 'reasons', 'ds-words']) }, createElement(View, { model })))
}

describe('SCR-275 draws in both languages with no key left on screen', () => {
  it(`${designScreen.cases.length} cases × it, en`, () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = draw(item.model, locale).replace(SAID, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
        if (locale === 'it') expect(/>(Discard|Apply|Save|Cancel)</.test(html), item.id).toBe(false)
      }
    }
  })

  it('a viewer reads the rules as text; the warehouse sees no card', () => {
    const viewer = draw(designScreen.cases.find((item) => item.id === 'supervisor')!.model, 'en')
    expect(viewer).toContain('Shade rule: One shade lot per garment.')
    expect(viewer).not.toContain('Leather area tolerance')
    const none = draw(designScreen.cases.find((item) => item.id === 'no-permission')!.model, 'en')
    expect(none).not.toContain('Shade rule')
  })

  it('every literal key of the card exists in both catalogues', () => {
    const keys = new Set<string>()
    for (const file of ['model.ts', 'CuttingRules.tsx', 'CuttingRulesView.tsx', 'fixtures.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      for (const match of source.matchAll(/'(cr\.[A-Za-z_.]+[A-Za-z_])'/g)) keys.add(match[1]!)
    }
    for (const rule of ['ORDER', 'GARMENT', 'OFF']) keys.add(`cr.shade.${rule}.title`).add(`cr.shade.${rule}.body`)
    for (const from of ['COMPANY', 'TENANT', 'DEFAULT']) keys.add(`cr.tolerance.now.${from}`)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production-cutting-rules'])['production-cutting-rules'] ?? {})
      for (const key of keys) expect(t(key), `${key} (${locale})`).not.toBe(key)
    }
  })
})
