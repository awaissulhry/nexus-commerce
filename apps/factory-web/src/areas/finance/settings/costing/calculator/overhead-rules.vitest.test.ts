import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OVERHEAD_BASES, OVERHEAD_REFUSALS } from '@nexus/factory-domain/costing/overhead-rules/rules'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { ApiError } from '../../../../../lib/api/errors'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import type { OverheadRuleView } from './api'
import { designScreen } from './fixtures'
import { cpmAbilitiesOf, OHR_BASES, OHR_KINDS, OHR_REFUSALS, ohrProblem, ruleBody, ruleDraftOf, ruleEditBody, ruleEditOf, ruleEditProblems, ruleNewHeld, ruleProblems, ruleRowHeld } from './model'

/**
 * B-W2b-GB02 (G054; B-W2b-430 gap 3): the overhead rules kept on screen — the New rule dialog's figures and body, a
 * correction that sends only what changed, the held reasons and the refusals in words; every SCR-506 case drawn in both
 * languages with no key left. Made-up figures only.
 */

const owner = cpmAbilitiesOf(['costing.view', 'costing.rates.manage', 'money.cost'])
const reader = cpmAbilitiesOf(['costing.view', 'money.cost'])
const noGrain = cpmAbilitiesOf(['costing.view', 'costing.rates.manage'])
const rule = (over: Partial<OverheadRuleView> = {}): OverheadRuleView =>
  ({ id: 'r1', companyId: 'c1', key: 'x', basis: 'PER_MINUTE', workCentreKind: 'SEWING', value: '0.050000', currency: 'EUR', periodStart: '2026-07-01', periodEnd: null, status: 'ACTIVE', note: null, inForce: true, version: 3, createdAt: 'x', updatedAt: 'x', ...over }) as OverheadRuleView

describe('overhead rules kept on screen (G054)', () => {
  it('offers the API’s bases and kinds of work centre, and words its refusals', () => {
    expect([...OHR_BASES]).toEqual([...OVERHEAD_BASES])
    expect([...OHR_KINDS]).toEqual([...WORK_CENTRE_KINDS])
    expect(OHR_REFUSALS.filter((code) => !(OVERHEAD_REFUSALS as readonly string[]).includes(code))).toEqual([])
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/OVERLAPS', message: 'x' }])
    expect(ohrProblem(refused)).toBe('ohrRefusal.OVERLAPS')
    expect(ohrProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('cpm.problem.forbidden')
  })

  it('makes a new rule from whole months, an amount with its currency, a percent without', () => {
    const machine = ruleDraftOf('2026-11-14', 'EUR', { basis: 'PER_MACHINE_HOUR', workCentreKind: 'SEWING', value: '6,5', fromMonth: '2026-12', toMonth: '2027-02' })
    expect(ruleProblems(machine)).toEqual({})
    expect(ruleBody(machine, 'c1')).toEqual({ companyId: 'c1', basis: 'PER_MACHINE_HOUR', workCentreKind: 'SEWING', value: '6.5', currency: 'EUR', periodStart: '2026-12-01', periodEnd: '2027-02-28', endPrevious: true })
    const percent = ruleDraftOf('2026-11-14', 'EUR', { scope: 'every', value: '25', endPrevious: false, note: ' Made up ' })
    expect(ruleBody(percent, 'c1')).toEqual({ companyId: null, basis: 'PERCENT_OF_LABOUR', workCentreKind: null, value: '25', currency: null, periodStart: '2026-11-01', periodEnd: null, note: 'Made up' })
    expect(ruleProblems({ ...percent, value: '1200', toMonth: '2026-10' })).toEqual({ value: 'ohrEdit.problem.percent', period: 'ohrEdit.problem.period' })
    expect(ruleProblems({ ...machine, value: '', currency: 'E1' })).toEqual({ value: 'ohrEdit.problem.valueEmpty', currency: 'ohrEdit.problem.currency' })
  })

  it('corrects an active rule with only what changed and its version; nothing changed sends nothing', () => {
    const sewing = rule()
    const edit = ruleEditOf(sewing)
    expect(edit).toEqual({ value: '0.05', currency: 'EUR', toMonth: '', note: '' })
    expect(ruleEditBody(edit, sewing)).toBeNull()
    expect(ruleEditBody({ ...edit, value: '0,06', toMonth: '2026-12' }, sewing)).toEqual({ version: 3, value: '0.06', periodEnd: '2026-12-31' })
    expect(ruleEditBody({ ...edit, note: 'Accountant 11-16' }, sewing)).toEqual({ version: 3, note: 'Accountant 11-16' })
    expect(ruleEditProblems({ ...edit, toMonth: '2026-05' }, sewing)).toEqual({ period: 'ohrEdit.problem.period' })
  })

  it('holds a new rule, a correction and an archive with why', () => {
    expect(ruleNewHeld(owner, false)).toBeNull()
    expect(ruleNewHeld(reader, false)).toBe('cpm.held.noManage')
    expect(ruleNewHeld(noGrain, false)).toBe('cpm.held.noGrain')
    expect(ruleRowHeld(rule(), owner, false)).toBeNull()
    expect(ruleRowHeld(rule({ status: 'ARCHIVED' }), owner, false)).toBe('ohrEdit.held.archived')
    expect(ruleRowHeld(rule(), owner, true)).toBe('cpm.held.busy')
  })
})

const LEFT_KEY = /\b(?:ohrEdit|ohrRefusal|ohr|ohrBasis|ohrPer|cpm|cpmRefusal|dept|csCommon)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('every SCR-506 design case draws in both languages with no key left on screen (G054 cases among them)', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  for (const locale of LOCALES) {
    it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
      expect(screen.cases.filter((item) => item.id.startsWith('gb02-')).length).toBeGreaterThanOrEqual(5)
      const View = screen.view as ComponentType<{ model: unknown }>
      for (const item of screen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
