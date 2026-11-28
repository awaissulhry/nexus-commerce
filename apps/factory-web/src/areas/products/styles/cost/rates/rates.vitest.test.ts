import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { render } from '../../../../../lib/record-thread/parts/testing'
import { DEPT_ROWS } from '../../routing/route/fixtures'
import { deptLooksOf } from '../../routing/route/model'
import { costingSettings, type CostingSettings, type RateRow } from './api'
import { deptRatesOf, draftOf, draftProblems, mayChangeRates, previewOf, RATES_RIGHT, ratesHeldOf, settingsInForce, writesOf } from './model'
import { RatesWindow, type RatesWindowModel } from './view/RatesWindow'

/**
 * owb-pd5b step 5.4 (S4; design plan § 5zh "The factory's rates") — the rates window: a department's own rate wins over its kind's in the
 * window's preview (the kind's is the fallback), the fields and the switch "One person may keep a cost" only for the person who may
 * change the costing settings, what Save sends (only what changed), the refused fields in words. Written, not run (Owner rule).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const looks = deptLooksOf(DEPT_ROWS, 'en')
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['products-cost'] ?? {}
const has = (locale: (typeof LOCALES)[number], key: string) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale))

const rate = (over: Partial<RateRow>): RateRow => ({ id: 'rate', companyId: 'company-1', workCentreKind: 'SEWING', departmentId: null, costPerMinute: '0.55', currency: 'EUR', plannedEfficiencyPct: '80', validFrom: '2026-01-01', status: 'ACTIVE', inForce: true, version: 1, ...over })
const RATES: RateRow[] = [
  rate({ id: 'kind-sewing', workCentreKind: 'SEWING', costPerMinute: '0.55', plannedEfficiencyPct: '80' }),
  rate({ id: 'kind-cutting', workCentreKind: 'CUTTING', costPerMinute: '0.62', plannedEfficiencyPct: '100' }),
  rate({ id: 'dept-stitching', workCentreKind: 'SEWING', departmentId: 'dept-4', costPerMinute: '0.70', plannedEfficiencyPct: '75', version: 3 }),
  rate({ id: 'tenant-cutting', companyId: null, workCentreKind: 'CUTTING', costPerMinute: '0.40' }),
  rate({ id: 'old-pattern', workCentreKind: 'CUTTING', departmentId: 'dept-1', costPerMinute: '9.99', inForce: false }),
]
const SETTINGS: CostingSettings = costingSettings.parse({
  settings: { tenant: { id: 'set-t', companyId: null, overheadPct: '10', version: 2 }, company: { id: 'set-c', companyId: 'company-1', overheadPct: '12.0000', oneKeeperAllowed: false, version: 4 }, inForce: 'set-c' },
})
const rows = deptRatesOf(looks, RATES)
const row = (id: string) => rows.find((entry) => entry.departmentId === id)!

describe('a department\'s own rate wins over its kind\'s', () => {
  it('Stitching has its own rate; Cutting follows its kind (the company\'s, not the tenant-wide one); Molding\'s kind has none here', () => {
    expect(row('dept-4')).toMatchObject({ from: 'DEPARTMENT', own: { id: 'dept-stitching' }, kindRate: { id: 'kind-sewing' } })
    expect(row('dept-2')).toMatchObject({ from: 'KIND', own: null, kindRate: { id: 'kind-cutting' } })
    // An own rate not in force is no rate: Pattern follows its kind.
    expect(row('dept-1')).toMatchObject({ from: 'KIND', own: null })
    expect(row('dept-6').from).toBe('NONE')
  })

  it('the window\'s preview: what is typed, else the department\'s own, else its kind\'s', () => {
    expect(previewOf(row('dept-4'), undefined)).toEqual({ cpm: '0.70', eff: '75', from: 'DEPARTMENT' })
    expect(previewOf(row('dept-2'), undefined)).toEqual({ cpm: '0.62', eff: '100', from: 'KIND' })
    expect(previewOf(row('dept-2'), { cpm: '0,66', eff: '' })).toEqual({ cpm: '0.66', eff: '100', from: 'TYPED' })
    expect(previewOf(row('dept-6'), undefined)).toEqual({ cpm: null, eff: null, from: 'NONE' })
  })

  it('a closed department has no row', () => {
    const closed = deptLooksOf(DEPT_ROWS.map((entry) => (entry.id === 'dept-8' ? { ...entry, status: 'CLOSED' as const } : entry)), 'en')
    expect(deptRatesOf(closed, RATES).some((entry) => entry.departmentId === 'dept-8')).toBe(false)
  })
})

describe('what Save sends: only what changed', () => {
  const draft = draftOf(SETTINGS)
  it('the window opens with nothing typed, the overhead and the switch as they are', () => {
    expect(draft).toEqual({ depts: {}, overhead: '12', oneKeeper: false, reason: '' })
    expect(writesOf(rows, draft, SETTINGS, 'company-1', '2026-11-28')).toEqual([])
    expect(ratesHeldOf({}, [], false)).toEqual({ key: 'rates.held.same' })
  })

  it('an own rate is corrected under its version; a department that follows its kind gets its own rate from today', () => {
    const typed = { ...draft, depts: { 'dept-4': { cpm: '0.72', eff: '' }, 'dept-2': { cpm: '0.66', eff: '90' } } }
    expect(writesOf(rows, typed, SETTINGS, 'company-1', '2026-11-28')).toEqual([
      { kind: 'create', body: { companyId: 'company-1', workCentreKind: 'CUTTING', departmentId: 'dept-2', costPerMinute: '0.66', plannedEfficiencyPct: '90', validFrom: '2026-11-28' } },
      { kind: 'update', rate: row('dept-4').own, body: { costPerMinute: '0.72', plannedEfficiencyPct: '75' } },
    ])
  })

  it('the overhead and the switch: one settings write on the row in force, the switch with its reason', () => {
    const typed = { ...draft, overhead: '15', oneKeeper: true, reason: 'The owner keeps the costs alone' }
    expect(writesOf(rows, typed, SETTINGS, 'company-1', '2026-11-28')).toEqual([{ kind: 'settings', body: { companyId: 'company-1', overheadPct: '15', version: 4, oneKeeperAllowed: true, reason: 'The owner keeps the costs alone' } }])
    expect(writesOf(rows, { ...draft, overhead: '12.0' }, SETTINGS, 'company-1', '2026-11-28')).toEqual([])
  })

  it('refused fields say why; Save waits on the first', () => {
    const typed = { ...draft, depts: { 'dept-2': { cpm: '7', eff: '10' } }, overhead: '400', oneKeeper: true, reason: '' }
    const problems = draftProblems(rows, typed, SETTINGS)
    expect(problems).toEqual({
      'cpm.dept-2': { key: 'rates.bad.cpm', params: { max: 5 } },
      'eff.dept-2': { key: 'rates.bad.eff', params: { min: 20, max: 100 } },
      overhead: { key: 'rates.bad.overhead', params: { max: 300 } },
      reason: { key: 'rates.bad.reason' },
    })
    expect(ratesHeldOf(problems, [], false)).toEqual({ key: 'rates.bad.cpm', params: { max: 5 } })
    expect(draftProblems(rows, { ...draft, depts: { 'dept-6': { cpm: '', eff: '90' } } }, SETTINGS)).toEqual({ 'cpm.dept-6': { key: 'rates.bad.cpmFirst' } })
  })

  it('the company\'s switch is read from the answer (the row of the company, else the tenant\'s)', () => {
    expect(settingsInForce(SETTINGS)).toEqual({ row: SETTINGS.settings.company, oneKeeper: false })
    expect(settingsInForce(costingSettings.parse({ settings: { tenant: null, company: null, inForce: null }, oneKeeperAllowed: true }))).toEqual({ row: null, oneKeeper: true })
  })
})

describe('who changes the rates', () => {
  it('only costing.rates.manage (the person who may change the costing settings today)', () => {
    expect(mayChangeRates((permission) => permission === RATES_RIGHT)).toBe(true)
    expect(mayChangeRates((permission) => permission === 'costing.view')).toBe(false)
  })

  const model = (change: boolean): RatesWindowModel => ({
    state: 'ready',
    problem: null,
    change,
    rows: rows.map((entry) => ({ departmentId: entry.departmentId, dept: entry.dept, preview: previewOf(entry, undefined), kind: entry.kindRate ? { cpm: entry.kindRate.costPerMinute ?? null, eff: entry.kindRate.plannedEfficiencyPct } : null, draft: { cpm: '', eff: '' } })),
    overhead: '12',
    oneKeeper: false,
    oneKeeperSaved: false,
    reason: '',
    leathers: [{ id: 'lb-1', item: { code: 'PEL-DEMO', name: 'Demo cowhide' }, expectedYieldPct: '82', inForce: true, status: 'ACTIVE' }],
    problems: {},
    held: { key: 'rates.held.same' },
    busy: false,
    saveProblem: null,
    money: (amount) => (amount ? `€${amount}` : '—'),
  })

  it('the WindowShell draws only in a browser: the window is read through its source — the act and the switch only with the right', () => {
    const view = readFileSync(join(HERE, 'view/RatesWindow.tsx'), 'utf8')
    expect(view).toContain("act={model.change && model.state === 'ready' ? { words: t('rates.save')")
    expect(view).toMatch(/\{model\.change && \(\s*<section aria-labelledby="fw-ct-rates-keeper"/)
    // The dialog renders nothing on the server: the rendered window is empty, never a crash.
    expect(render(createElement(RatesWindow, { model: model(false), actions: { onCpm: () => undefined, onEff: () => undefined, onOverhead: () => undefined, onOneKeeper: () => undefined, onReason: () => undefined, onSave: () => undefined, onClose: () => undefined, onRetry: () => undefined } }))).not.toContain('One person may keep a cost')
  })

  it('the settings card opens the same window for the cost grain only; the Cost tab\'s card opens it too', () => {
    expect(readFileSync(join(HERE, '../../../settings/view/CostingCard.tsx'), 'utf8')).toContain('model.can.costing && model.can.cost ? <RatesDoor companyId={model.companyId} /> : null')
    expect(readFileSync(join(HERE, '../page/CostPage.tsx'), 'utf8')).toContain('<RatesDoor')
  })
})

describe('words', () => {
  it('every key the rates window names exists in both languages', () => {
    const sources = ['model.ts', 'RatesDoor.tsx', 'view/RatesWindow.tsx'].map((file) => readFileSync(join(HERE, file), 'utf8')).join('\n')
    const keys = [...sources.matchAll(/['"`]((?:rates|common|problem)\.[A-Za-z_.]+[A-Za-z_])['"`]/g)].map((match) => match[1]!)
    expect(keys.length).toBeGreaterThan(30)
    for (const locale of LOCALES) expect([...new Set(keys)].filter((key) => !has(locale, key)), locale).toEqual([])
  })
})
