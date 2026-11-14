import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as calculatorScreen } from '../../settings/costing/calculator/fixtures'
import { applyProblems, calcBody, calcDraftOf, calcProblems, costPerMinute, cpmAbilitiesOf, cpmProblem, lastMonth, monthLast, monthOptions, monthsBetween, overheadTwice, rowHeld } from '../../settings/costing/calculator/model'
import { designScreen as massScreen } from './fixtures'
import { applyHeld, changesOf, massAbilitiesOf, massProblem, percent, previewHeld, rowProblem, type PriceRow } from './model'

const refusal = (code: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: `refusal/${code}`, message: 'x' }])

describe('mass cost update: who may look and apply, the prices typed, the refusals (B-W2b-430)', () => {
  const owner = massAbilitiesOf(['costing.view', 'costing.massUpdate.apply', 'money.cost', 'money.margin'])
  const row: PriceRow = { itemId: 'i', code: 'DEMO-LEA-01', name: 'x', baseUom: 'FT2', currency: 'EUR', priceNow: '3.200000', newPrice: '3,45' }
  it('needs the cost grain to look and its own right to apply', () => {
    expect(massAbilitiesOf(['costing.view']).preview).toBe(false)
    expect(owner).toMatchObject({ preview: true, apply: true, margin: true, price: false })
    expect(previewHeld(massAbilitiesOf(['costing.view']), [row], false)?.key).toBe('mass.held.noGrain')
    expect(previewHeld(owner, [], false)?.key).toBe('mass.held.noRows')
    expect(previewHeld(owner, [row], false)).toBeNull()
    expect(previewHeld(owner, [{ ...row, newPrice: '3.2' }], false)).toEqual({ key: 'mass.held.row', params: { code: 'DEMO-LEA-01' } })
  })
  it('checks each new price and sends it as the API takes it', () => {
    expect(rowProblem({ ...row, newPrice: '' })).toBe('mass.problem.empty')
    expect(rowProblem({ ...row, newPrice: '-1' })).toBe('mass.problem.price')
    expect(rowProblem({ ...row, newPrice: '3.20' })).toBe('mass.problem.same')
    expect(changesOf([row])).toEqual([{ itemId: 'i', newPrice: '3.45' }])
  })
  it('holds the apply while inputs are missing, and words each refusal', () => {
    const preview = { counts: { series: 2, recomputed: 1, incomplete: 1, seasonClosed: 0, listEntries: 0, orderLines: 0 }, withoutSheet: [] } as unknown as Parameters<typeof applyHeld>[1]
    expect(applyHeld(owner, preview, false, false)).toEqual({ key: 'mass.held.incomplete', params: { count: 1 } })
    expect(applyHeld(owner, preview, true, false)).toBeNull()
    expect(applyHeld(massAbilitiesOf(['costing.view', 'money.cost']), preview, true, false)?.key).toBe('mass.held.noApply')
    expect(massProblem(refusal('STALE'))).toBe('massRefusal.STALE')
    expect(massProblem(new ApiError('step_up', 403, 'forbidden', 'x'))).toBe('mass.problem.stepUp')
    expect(percent('-1.04', 'en', true)).toBe('−1.04 %')
  })
})

describe('cost-per-minute calculator: months, figures, the rate, no single person', () => {
  const can = cpmAbilitiesOf(['costing.view', 'costing.rates.manage', 'money.cost'])
  it('works with whole months, at most 12', () => {
    expect(lastMonth('2026-01-14')).toBe('2025-12')
    expect(monthLast('2028-02')).toBe('2028-02-29')
    expect(monthsBetween('2026-01', '2026-12')).toBe(12)
    expect(monthsBetween('2026-05', '2026-04')).toBeNull()
    expect(monthOptions('2026-11-14').slice(0, 2)).toEqual(['2026-11', '2026-10'])
    expect(calcProblems(calcDraftOf('2026-11-14', { fromMonth: '2025-01', toMonth: '2026-01', directLabourCost: '1', availableMinutes: '1' })).period).toBe('cpm.problem.periodLong')
  })
  it('makes the rate as the API does: labour ÷ minutes + indirect + overhead, 6 places', () => {
    const draft = calcDraftOf('2026-11-14', { directLabourCost: '96000', availableMinutes: '182400', overheadPerMinute: '0,05' })
    expect(calcProblems(draft)).toEqual({})
    expect(costPerMinute(draft)).toBe('0.576316')
    expect(overheadTwice(draft, { overheadPerMinuteFromRules: '0.050000' } as never)).toBe(true)
    expect(calcBody(draft, 'c', null)).toEqual({ companyId: 'c', workCentreKind: 'SEWING', periodStart: '2026-10-01', periodEnd: '2026-10-31', directLabourCost: '96000', availableMinutes: '182400', overheadPerMinute: '0.05' })
  })
  it('holds a past day, an applied calculation and a reader, and words ONE_SEAT', () => {
    expect(applyProblems({ validFrom: '2026-11-13', efficiency: '' }, '2026-11-14').validFrom).toBe('cpmRefusal.PAST_DAY')
    expect(applyProblems({ validFrom: '2026-11-14', efficiency: '85' }, '2026-11-14')).toEqual({})
    expect(rowHeld({ labourRateId: 'r' }, can, false)).toBe('cpm.held.applied')
    expect(rowHeld({ labourRateId: null }, cpmAbilitiesOf(['costing.view']), false)).toBe('cpm.held.noManage')
    expect(cpmProblem(refusal('ONE_SEAT'))).toBe('cpmRefusal.ONE_SEAT')
  })
})

const LEFT_KEY = /\b(?:csCommon|mass|massRefusal|massSeries|cpm|cpmRefusal|dept|ohr|ohrBasis|ohrPer|verStepUp)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case of SCR-505 and SCR-506 draws in both languages with no key left on screen', () => {
  for (const screen of [massScreen, calculatorScreen] as unknown as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/href="[^"]*"/g, '')
          expect(html.length, item.id).toBeGreaterThan(40)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
