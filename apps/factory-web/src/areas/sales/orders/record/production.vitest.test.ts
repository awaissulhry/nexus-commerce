import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { productionWordsFor } from '../../../../lib/production/words'
import { COUNTED_STEPS, madeForOf, ownProgress, productionProgress } from './production'
// F-SA-234b
import { forecastPart } from './production'
import { FAILED_STATE, LOADING_STATE, ready, WORK_READ } from './overview/fixtures'
import { LINE_BLK, LINE_RED } from '../_demo/fixtures'
// F-SA-235b
import { designScreen as workOrderScreen } from '../../../production/work-orders/record/fixtures'

/**
 * Lead fix (production-page lane): the order's Production tab wrote `sewn ?? 0` — "0 sewn" where the site does not scan sewing.
 * Now ONE figure (lib/production progressFigure: the bar shows what its words name) and, for a step the site does not count, "—"
 * with the reason in words.
 */
describe('the Production tab’s progress, honest where a step is not scanned', () => {
  const row = (progress: { cut: number | null; bundled: number | null; sewn: number | null; finished: number | null } | null, status = 'IN_PROGRESS') => ({ progress, pieces: 100, status }) as Parameters<typeof productionProgress>[0]

  it('a site that does not scan sewing: no "0 sewn", the step says it is not counted', () => {
    const { figure, notCounted } = productionProgress(row({ cut: 100, bundled: null, sewn: null, finished: 40 }))
    expect(notCounted).toEqual(['sewn'])
    expect(figure.step).toBe('finished')
    expect(figure.percent).toBe(40)
    for (const locale of LOCALES) {
      const words = productionWordsFor(locale)(figure.words.key, figure.words.params)
      expect(words).toMatch(/40/)
      expect(words).not.toMatch(/\b0\b/)
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('production.notCounted.sewn')).not.toMatch(/production\.|\{/)
      for (const step of COUNTED_STEPS) expect(t(`production.step.${step}`)).not.toMatch(/production\./)
    }
  })

  it('the bar shows the figure its words name: sewn 80 of 100 is 80 %, never finished 0 %', () => {
    const { figure, notCounted } = productionProgress(row({ cut: 100, bundled: 90, sewn: 80, finished: 0 }))
    expect(figure).toMatchObject({ step: 'sewn', done: 80, percent: 80 })
    expect(notCounted).toEqual([])
  })

  it('every step counted: none is marked; a draft has no figure and no steps', () => {
    expect(productionProgress(row({ cut: 0, bundled: 0, sewn: 0, finished: 0 })).notCounted).toEqual([])
    const draft = productionProgress(row(null, 'DRAFT'))
    expect(draft.figure.percent).toBeNull()
    expect(draft.notCounted).toEqual([])
  })
})

// ---- F-SA-234: the order's OWN pieces on a work order, and what else it makes (no other customer named or counted) ------------
describe('F-SA-234: Production › Work orders — the order’s own pieces', () => {
  it('ONE figure of the own cells (checked = released by quality); a step not counted is listed, never 0; a draft has none', () => {
    const own = { cells: 4, pieces: 40, cut: 40, sewn: 30, checked: null }
    const { figure, notCounted } = ownProgress(own, 'IN_PROGRESS')
    expect(figure).toMatchObject({ step: 'sewn', done: 30, total: 40, percent: 75 })
    expect(notCounted).toEqual(['finished'])
    expect(ownProgress({ ...own, sewn: null }, 'IN_PROGRESS').notCounted).toEqual(['sewn', 'finished'])
    expect(ownProgress(own, 'DRAFT').figure.percent).toBeNull()
    expect(ownProgress(own, 'DRAFT').notCounted).toEqual([])
  })

  it('"Made for this order 40 of 100 · also makes SO-…": only this customer’s orders by number; another customer’s work in words only', () => {
    const own = { cells: 4, pieces: 40, cut: 40, sewn: 30, checked: 10 }
    expect(madeForOf(own, 100, { orders: [{ number: 'SO-2026-0151' }], more: 2 }, false, false)).toEqual([
      { key: 'production.own.of', params: { own: 40, total: 100 } },
      { key: 'production.own.alsoMakes', params: { number: 'SO-2026-0151' } },
      { key: 'production.own.alsoMore', params: { count: 2 } },
    ])
    const mixed = madeForOf(own, null, { orders: [], more: 0 }, true, true)
    expect(mixed.map((entry) => entry.key)).toEqual(['production.own.all', 'production.own.alsoOther', 'production.own.cutTogether'])
    expect(JSON.stringify(mixed)).not.toMatch(/SO-|Brand|Beta/)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const entry of [...madeForOf(own, 100, { orders: [{ number: 'SO-1' }], more: 2 }, true, true)]) expect(t(entry.key, entry.params), `${locale}: ${entry.key}`).not.toMatch(/production\.|\{/)
      for (const key of ['production.held', 'production.rush', 'production.progressHeld', 'production.col.own', 'production.col.materials', 'gate.money', 'dates.customerSees', 'dates.cutStart', 'dates.sewStart', 'dates.finish']) expect(t(key, { date: 'x' }), `${locale}: ${key}`).not.toBe(key)
      expect(t('production.mtmRow', { style: 'S', colour: 'C', units: 12, workOrders: 12 })).toMatch(/12/)
    }
  })
})
// ---- end F-SA-234

const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === id)!.model, locale)

// ---- F-SA-235: Holds, quality & problems; Materials; Specs in force (the HealthCard moved to lib, one card) -------------------------
describe('F-SA-235: Production’s holds, quality & problems — each block held in words without its right', () => {
  it('a quality hold in plain words, the office note marked office only, a problem that needs an answer, the NCR, the final inspection', () => {
    const text = textOf(draw('production-quality'))
    for (const words of ['Holds, quality & problems', 'On hold since', 'Shade difference on the leather', 'Goes back to In progress when quality releases it.', 'WO-00022', 'Lotto pelle in verifica col fornitore.', 'Office only', 'Needs an answer: 1', 'Escalated 1×', 'NCR-2026-0041', 'FI-2026-0088', 'Specs in force']) expect(text, words).toContain(words)
    expect(text).not.toContain('No holds, problems or quality findings')
  })

  it('without the rights: each block says what it needs (never "none"); everything read and empty: one sentence', () => {
    const held = textOf(draw('production-no-right'))
    for (const words of ['Problems need the work orders right', 'Nonconformities need the quality right', 'Final inspections need the inspections right', 'Progress needs the work orders right']) expect(held, words).toContain(words)
    expect(held).not.toContain('No holds, problems or quality findings')
    expect(textOf(draw('production-progress'))).toContain('No holds, problems or quality findings')
  })

  it('the work order record’s HealthCard is the one card (moved to lib/production/health); Materials and the tech pack moved to Production', () => {
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("import { HealthCard } from '../../../../../lib/production/health/view/HealthCard'")
    expect(tab).toContain('<MaterialsCard order={order} model={model.depth}')
    expect(tab).toContain('<TechPackCard model={model.depth} actions={actions?.depth} />')
    const workOrder = readFileSync(new URL('../../../production/work-orders/record/view/OverviewTab.tsx', import.meta.url), 'utf8')
    expect(workOrder).toContain("from '../../../../../lib/production/health/view/HealthCard'")
    expect(readFileSync(new URL('./view/LinesTab.tsx', import.meta.url), 'utf8')).not.toContain('<MaterialsCard')
  })
})
// ---- end F-SA-235

// ---- F-SA-234b (sa-7's follow-up): the by-line finish forecast reads the order's own production read (`dates.forecast`) ----------
describe('F-SA-234b — the by-line finish forecast from the order’s own production read, not every site’s promise lines', () => {
  it('ready: per line its finish, what sets it, the days to spare or short; an unknown risk word is no risk', () => {
    const part = forecastPart(ready(WORK_READ))
    expect(part?.problem).toBeNull()
    expect(part?.value?.get(LINE_BLK)).toEqual({ finish: '2026-12-08', source: 'BOARD', slackDays: 7, risk: 'ON_TIME' })
    expect(part?.value?.get(LINE_RED)).toEqual({ finish: '2026-12-29', source: 'WORK_ORDER_DUE', slackDays: -7, risk: 'AT_RISK' })
    const odd = forecastPart(ready({ ...WORK_READ, dates: { ...WORK_READ.dates!, forecast: [{ ...WORK_READ.dates!.forecast![0]!, risk: 'SOMETHING_NEW' }] } }))
    expect(odd?.value?.get(LINE_BLK)?.risk).toBeNull()
  })

  it('withheld (no planning.promise.view) or not read: null — "—" per line, never "not planned"; reading and failed as the read is', () => {
    expect(forecastPart(ready({ ...WORK_READ, withheld: ['dates.forecast'], dates: { ...WORK_READ.dates!, forecast: null } }))).toBeNull()
    expect(forecastPart(null)).toBeNull()
    expect(forecastPart(undefined)).toBeNull()
    expect(forecastPart(LOADING_STATE)).toEqual({ value: null, problem: null })
    expect(forecastPart(FAILED_STATE)).toEqual({ value: null, problem: 'problem.read.unavailable' })
  })

  it('Production draws it by line: 7 days to spare (the planning board), 7 days short (a work order’s due day); withheld: no figure', () => {
    const text = textOf(draw('w2b-323-dates'))
    expect(text).toContain('7 days to spare')
    expect(text).toContain('7 days short')
    expect(text).toContain('The planning board')
    expect(text).toContain('A work order’s due day')
    const held = textOf(draw('w2b-323-dates-withheld'))
    expect(held).not.toContain('days to spare')
    expect(held).not.toContain('Not planned')
  })

  it('the order page makes no read of every site’s promise lines any more (the wide per-site read is gone)', () => {
    const depth = readFileSync(new URL('../depth/use-order-depth.ts', import.meta.url), 'utf8')
    expect(depth).not.toContain('listPromiseLines')
    expect(depth).not.toContain('forecasts')
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('const forecast = forecastPart(model.production)')
    expect(tab).toContain('<ForecastCell key="f" part={forecast} lineId={line.id} />')
    expect(tab).not.toContain('ForecastNote')
  })
})
// ---- end F-SA-234b

// ---- F-SA-235b (sa-7's follow-up): the moved HealthCard draws the same on the sales order as on the work order — its look moved with
// it into lib/production/health (its own classes, the same declarations), so the production area's stylesheet is not needed ---------
describe('F-SA-235b — the Health card’s look lives with the card (lib/production/health), the same on both pages', () => {
  /** The final declarations of each single-class rule of a stylesheet (grouped selectors spread; a later rule wins). */
  const rulesOf = (css: string): Map<string, Map<string, string>> => {
    const out = new Map<string, Map<string, string>>()
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1]!.split(',').map((part) => part.trim())
      const declarations = match[2]!.split(';').map((part) => part.trim()).filter(Boolean).map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()] as const)
      for (const selector of selectors) {
        if (!/^\.[a-z0-9-]+$/.test(selector)) continue
        const known = out.get(selector) ?? new Map<string, string>()
        for (const [name, value] of declarations) known.set(name, value)
        out.set(selector, known)
      }
    }
    return out
  }
  const card = readFileSync(new URL('../../../../lib/production/health/view/HealthCard.tsx', import.meta.url), 'utf8')
  const own = rulesOf(readFileSync(new URL('../../../../lib/production/health/view/health-card.css', import.meta.url), 'utf8'))
  const area = rulesOf(readFileSync(new URL('../../../production/_shared/production.css', import.meta.url), 'utf8'))

  it('the card imports its own stylesheet and uses no class of the production area’s stylesheet', () => {
    expect(card).toContain("import './health-card.css'")
    expect(card).not.toMatch(/className="fw-pr-/)
  })

  it('each of its classes has exactly the declarations the production area’s rule had (the work order page looks as before)', () => {
    const pairs: [string, string][] = [
      ['.fw-phc-card', '.fw-pr-card'],
      ['.fw-phc-head', '.fw-pr-card-head'],
      ['.fw-phc-h2', '.fw-pr-h2'],
      ['.fw-phc-stack', '.fw-pr-stack'],
      ['.fw-phc-dialog', '.fw-pr-dialog'],
      ['.fw-phc-hint', '.fw-pr-hint'],
      ['.fw-phc-inline', '.fw-pr-inline'],
      ['.fw-phc-actions', '.fw-pr-actions'],
    ]
    for (const [mine, theirs] of pairs) {
      expect(own.get(mine), mine).toBeDefined()
      expect(Object.fromEntries(own.get(mine)!), mine).toEqual(Object.fromEntries(area.get(theirs)!))
    }
    // Semantic tokens only: no raw colour of its own.
    const css = readFileSync(new URL('../../../../lib/production/health/view/health-card.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
  })

  it('the work order’s Health card draws with its own classes (and the office note keeps the shared parts’ look)', () => {
    const html = renderView(workOrderScreen.view as ComponentType<{ model: unknown }>, workOrderScreen.cases.find((item) => item.id === 'health-raised')!.model, 'en')
    expect(html).toContain('fw-phc-card')
    expect(html).toContain('class="fw-phc-head"')
    expect(html).toContain('class="fw-prp-office-note"')
  })
})
// ---- end F-SA-235b
