import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { checkItems } from '../../_shared/model'
import { releaseCheck, workOrder } from '../../_shared/fixtures'
import { demoSpec, designScreen } from './fixtures'
import { comparePair, compareHeld, decisionPhrase, EMPTY_DRAFT, newerPhrase, raiseHeld, requestBody, requestHeld, specCan } from './model'

describe("the work order's spec against the master", () => {
  it('who may compare, read and raise', () => {
    expect(specCan(['workorders.view'])).toEqual({ compare: false, changes: false, request: false })
    expect(specCan(['product.bom.view', 'product.changes.view', 'product.changes.request'])).toEqual({ compare: true, changes: true, request: true })
    expect(requestHeld(specCan([]))).toBe('wo.held.noRequest')
  })
  it('a newer spec in words, with what the office decided', () => {
    expect(newerPhrase(demoSpec('current'))).toBeNull()
    expect(newerPhrase(demoSpec())).toEqual({ key: 'wo.newer.NEWER_RELEASED', params: { revision: 3, newer: 4, day: '2026-11-04' } })
    expect(decisionPhrase(demoSpec())).toEqual({ key: 'wo.decision.none', params: { revision: 3 } })
    expect(decisionPhrase(demoSpec('rework'))).toMatchObject({ key: 'wo.decision.REWORK', params: { order: 'ECO-DEMO-0004', newer: 4 } })
    expect(newerPhrase(demoSpec('withdrawn'))).toEqual({ key: 'wo.newer.WITHDRAWN', params: { revision: 3 } })
  })
  it("Compare with the current master: the work order's revision against the released one, held with why", () => {
    const spec = demoSpec()
    expect(comparePair(spec)).toEqual({ styleId: spec.workOrder.styleId, from: spec.revision!.id, to: spec.released!.id })
    expect(compareHeld({ status: 'loading' })).toBe('wo.held.reading')
    expect(compareHeld({ status: 'ready', value: demoSpec('withdrawn') })).toBe('wo.held.noReleased')
    expect(compareHeld({ status: 'ready', value: spec })).toBeNull()
  })
  it('Ask for approval waits for what and why; the request names the work order and its frozen revision', () => {
    const can = specCan(['product.changes.request'])
    expect(raiseHeld(EMPTY_DRAFT, can, false)).toBe('wo.held.title')
    expect(raiseHeld({ ...EMPTY_DRAFT, title: 'Ginocchiera' }, can, false)).toBe('wo.held.reason')
    expect(raiseHeld({ ...EMPTY_DRAFT, title: 'x'.repeat(201), reason: 'y' }, can, false)).toBe('wo.held.long')
    expect(raiseHeld({ title: 'Ginocchiera', reason: 'Urta', priority: 'HIGH' }, can, true)).toBe('wo.held.busy')
    const wo = workOrder('IN_PROGRESS')
    expect(requestBody({ title: ' Ginocchiera ', reason: 'Urta ', priority: 'HIGH' }, wo)).toEqual({ styleId: wo.style.id, source: 'OFFICE', workOrderId: wo.id, revisionId: wo.revision!.id, title: 'Ginocchiera', reason: 'Urta', priority: 'HIGH' })
  })
  it('B-W2b-231 gap: a cell that waits for a later release of the revision is said as such on the release check', () => {
    const wo = workOrder('DRAFT')
    const check = releaseCheck('blocked')
    const cells = { ...check, checks: check.checks.map((entry) => (entry.code === 'CELLS' ? { ...entry, state: 'BLOCKED' as const, problems: [{ path: `cells/${wo.cells[0]!.id}/scope`, message: 'x' }] } : entry)) }
    const item = checkItems(cells, wo).find((entry) => entry.code === 'CELLS')!
    expect(item.words.key).toBe('check.CELLS.scope')
    expect(item.problems).toEqual([{ key: 'problem.scope', params: { cell: `${wo.cells[0]!.colourwayCode} ${wo.cells[0]!.size}` } }])
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production']).production!)
      expect(t('check.CELLS.scope')).not.toBe('check.CELLS.scope')
      expect(t('problem.scope', { cell: 'BLK 50' })).toContain('BLK 50')
    }
  })
})

const LEFT_KEY = /\b(?:base|wo|refusal|problem|redline|impact|section|request|priority|row|cmp|list|tile|view|col|held|new|record|tab|step|action|part|overview|check|size|release|status|common|notice)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const PERMISSIONS = /\b(?:workorders\.(?:view|manage|release)|quality\.inspections\.view|production\.cut\.correct|production\.bundles|inventory\.issue|print\.labels|orders\.view)\b/g

describe('every design case of SCR-349 draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-349 in ${locale}: ${designScreen.cases.length} cases`, () => {
      const View = (designScreen as unknown as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
          .replace(PERMISSIONS, '')
          .replace(/href="[^"]*"/g, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-349/${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
