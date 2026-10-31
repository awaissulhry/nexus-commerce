import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { DETAIL, DETAIL_IN_FORCE_ONLY, LIST_ROWS, V1, V2, V2_ENTRIES } from './_demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import {
  abilitiesOf,
  activateCheck,
  activeFilterCount,
  archiveHeld,
  archiveReach,
  customersHeld,
  defaultActivationDay,
  EVERY_COMPANY,
  emptyNewList,
  filtersOf,
  filtersOfTile,
  listsCsv,
  newListBody,
  newListProblems,
  NO_FILTERS,
  nextVersionHeld,
  parseListPrice,
  parseRaisePct,
  priceColumnIds,
  pricesHeld,
  raisePlan,
  rowsShown,
  searchOf,
  stateOfRows,
  tabOf,
  tileOf,
  tileValue,
  versionToShow,
} from './model'
import { createProblem, customersProblem, writeProblem } from './problems'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * B-W2a-49 — Sales › Price lists & contracts (SCR-106): the list's one filter model in the address, the record's held
 * reasons in words, the activation's plan (factory-domain's own rule), Raise by % to the minor unit, the API's refusals
 * in this screen's words, and every design case drawn in both languages with no key left on screen.
 */

const params = (search: string) => new URLSearchParams(search)

describe('the list: saved rows and tiles are one filter model, kept in the address', () => {
  it('reads and writes the address the same way', () => {
    const filters = filtersOf(params('rows=drafts&kind=GROUP&q=demo'))
    expect(filters).toEqual({ rows: 'drafts', soon: null, kind: 'GROUP', q: 'demo' })
    expect(searchOf(filters)).toBe('?rows=drafts&kind=GROUP&q=demo')
    expect(filtersOf(params('rows=nonsense&kind=X&soon=never'))).toEqual(NO_FILTERS)
    expect(searchOf(NO_FILTERS)).toBe('')
  })
  it('a saved row asks the API by state; All is every list not archived', () => {
    expect(stateOfRows('active')).toBe('IN_FORCE')
    expect(stateOfRows('drafts')).toBe('DRAFT')
    expect(stateOfRows('expired')).toBe('EXPIRED')
    expect(stateOfRows('archived')).toBe('ARCHIVED')
    expect(stateOfRows('all')).toBeNull()
  })
  it('a tile puts its chip in the toolbar; pressing it again takes it away', () => {
    const active = filtersOfTile('active', NO_FILTERS)
    expect(active.rows).toBe('active')
    expect(tileOf(active)).toBe('active')
    expect(filtersOfTile('active', active).rows).toBe('all')
    const ending = filtersOfTile('ending', active)
    expect(ending).toMatchObject({ rows: 'all', soon: 'ending' })
    expect(filtersOfTile('ending', ending).soon).toBeNull()
    expect(activeFilterCount({ rows: 'drafts', soon: null, kind: 'BASE', q: ' x ' })).toBe(3)
  })
  it('the date tiles keep the rows their flags name; an unknown count is —, never 0', () => {
    expect(rowsShown(LIST_ROWS, { ...NO_FILTERS, soon: 'starting' })!.map((row) => row.code)).toEqual(['FIERA-2027'])
    expect(rowsShown(LIST_ROWS, { ...NO_FILTERS, soon: 'ending' })!.map((row) => row.code)).toEqual(['MODA-DEMO'])
    expect(rowsShown(null, NO_FILTERS)).toBeNull()
    expect(tileValue(null, 'active')).toBe('—')
    expect(tileValue({ inForce: 0, startingIn30Days: 2, endingIn30Days: 1 }, 'active')).toBe('0')
  })
  it('Archive N reaches only active lists that price nobody (the others are said before the click)', () => {
    const { reach, skipped } = archiveReach(LIST_ROWS)
    expect(reach.map((row) => row.code)).toEqual(['BASE-EUR', 'PROVA-CH', 'ESEMPIO-2025'])
    expect(skipped).toHaveLength(3)
  })
  it('the CSV has no price and says kinds and states in words', () => {
    const csv = listsCsv(LIST_ROWS.slice(1, 2), { header: (key) => key.toUpperCase(), kind: (kind) => `k:${kind}`, state: (state) => `s:${state}` })
    expect(csv.split('\n')[1]).toBe('MODA-DEMO;Moda Demo S.r.l. — 2026;k:CUSTOMER;EUR;1;2026-01-15;2026-11-20;9;1;s:IN_FORCE')
  })
})

describe('New price list', () => {
  const today = '2026-10-30'
  it('checks the fields as the API will, before the click', () => {
    expect(newListProblems(emptyNewList('c1'), today)).toMatchObject({ code: 'new.problem.codeMissing', name: 'new.problem.nameMissing' })
    const draft = { ...emptyNewList('c1'), code: 'ok-1', name: 'A list', validFrom: '2026-10-01', validTo: '2026-09-01' }
    expect(newListProblems(draft, today)).toEqual({ validFrom: 'new.problem.fromPast', validTo: 'new.problem.toBefore' })
    expect(newListProblems({ ...draft, validFrom: '', validTo: '', code: 'bad code!' }, today)).toEqual({ code: 'new.problem.code' })
    expect(newListProblems({ ...draft, validFrom: '', validTo: '', kind: 'BASE', baseListId: 'x' }, today)).toEqual({ baseListId: 'new.problem.baseOfBase' })
  })
  it('sends every company as null, the code upper-case, and no base list for a base list', () => {
    const body = newListBody({ ...emptyNewList(EVERY_COMPANY), code: ' moda-2 ', name: ' Moda ', kind: 'CUSTOMER', baseListId: 'b1', note: ' ' })
    expect(body).toMatchObject({ companyId: null, code: 'MODA-2', name: 'Moda', baseListId: 'b1', note: null, validFrom: null })
    expect(newListBody({ ...emptyNewList('c1'), code: 'B', name: 'B', kind: 'BASE', baseListId: 'b1' }).baseListId).toBeNull()
  })
  it("a refusal is said in the screen's words: a code in use, or (for a base list) a second base list", () => {
    const conflict = new ApiError('conflict', 409, 'conflict', 'The price list code X is taken.')
    expect(createProblem(conflict, 'CUSTOMER')).toEqual({ key: 'new.refused.codeTaken' })
    expect(createProblem(conflict, 'BASE')).toEqual({ key: 'new.refused.codeOrBase' })
    expect(createProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/baseListId', message: 'x' }]))).toEqual({ key: 'new.refused.base' })
  })
})

describe('the record: which version, and why its prices are held', () => {
  const can = abilitiesOf(['pricelists.view', 'pricelists.manage', 'parties.manage', 'money.price'])
  it('shows the version asked, else the draft, else the one in force', () => {
    expect(versionToShow(DETAIL, null)!.id).toBe(V2.id)
    expect(versionToShow(DETAIL, V1.id)!.id).toBe(V1.id)
    expect(versionToShow(DETAIL_IN_FORCE_ONLY, 'gone')!.id).toBe(V1.id)
    expect(tabOf('versions')).toBe('versions')
    expect(tabOf('breaks')).toBe('prices')
  })
  it('prices change on a draft only, with the right and the price grain; each reason in words', () => {
    expect(pricesHeld(DETAIL, V2, can)).toBeNull()
    expect(pricesHeld(DETAIL, V1, can)).toBe('held.activeHasDraft')
    expect(pricesHeld(DETAIL_IN_FORCE_ONLY, V1, can)).toBe('held.activeVersion')
    expect(pricesHeld({ ...DETAIL, status: 'ARCHIVED' }, V2, can)).toBe('held.archived')
    expect(pricesHeld(DETAIL, V2, { ...can, manage: false })).toBe('held.noManage')
    expect(pricesHeld(DETAIL, V2, { ...can, price: false })).toBe('held.noPrice')
  })
  it('one draft at a time; customers need parties.manage too; archive is held while customers or a list use it', () => {
    expect(nextVersionHeld(DETAIL, can)).toBe('held.oneDraft')
    expect(nextVersionHeld(DETAIL_IN_FORCE_ONLY, can)).toBeNull()
    expect(customersHeld(DETAIL, { ...can, partiesManage: false })).toBe('held.noPartiesManage')
    expect(archiveHeld(DETAIL, can)).toEqual({ key: 'held.archiveCustomers', params: { count: 1 } })
    expect(archiveHeld({ ...DETAIL, customers: [], fallbackOf: [{ id: 'x', code: 'OTHER', name: 'Other', kind: 'CUSTOMER', status: 'ACTIVE' }] }, can)).toEqual({ key: 'held.archiveFallback', params: { lists: 'OTHER' } })
    expect(archiveHeld({ ...DETAIL, customers: [] }, can)).toBeNull()
  })
})

describe('Activate version: the plan from factory-domain, held before the click', () => {
  const today = '2026-10-30'
  it('ends the version in force the day before the new start', () => {
    expect(activateCheck(DETAIL.versions, V2.id, '2026-11-21', '', today)).toEqual({ held: null, ends: { revision: 1, validTo: '2026-11-20' } })
    expect(activateCheck([V2, { ...V1, validTo: '2026-11-10' }], V2.id, '2026-11-21', '', today)).toEqual({ held: null, ends: null })
    expect(defaultActivationDay(V2, today)).toBe('2026-11-21')
    expect(defaultActivationDay({ validFrom: '2026-01-01' }, today)).toBe(today)
  })
  it('never back in time, never after its own end, never cutting a later version away', () => {
    expect(activateCheck(DETAIL.versions, V2.id, '2026-10-01', '', today).held).toEqual({ key: 'activate.held.past', params: { today } })
    expect(activateCheck(DETAIL.versions, V2.id, '2026-11-21', '2026-11-01', today).held).toEqual({ key: 'activate.held.order' })
    const later = [V2, { ...V1, validFrom: '2026-12-01', validTo: null }]
    expect(activateCheck(later, V2.id, '2026-11-21', '', today).held).toEqual({ key: 'activate.held.later', params: { revision: 1, date: '2026-12-01' } })
    expect(activateCheck(DETAIL.versions, V2.id, '', '', today).held).toEqual({ key: 'activate.held.from' })
  })
})

describe('Raise by %: factory-domain raiseByPct, to the minor unit', () => {
  it('reads either way of typing a percent; 0 and -100 or below are not one', () => {
    expect(parseRaisePct('4')).toBe('4')
    expect(parseRaisePct('+2,5 %')).toBe('2.5')
    expect(parseRaisePct('-3')).toBe('-3')
    expect(parseRaisePct('0')).toBeNull()
    expect(parseRaisePct('-100')).toBeNull()
    expect(parseRaisePct('abc')).toBeNull()
  })
  it('each picked price × (1 + pct ÷ 100), rounded to the cent, with the margin at the new price when the cost is known', () => {
    const plan = raisePlan(V2_ENTRIES, [V2_ENTRIES[3]!.id, V2_ENTRIES[4]!.id], '4', 'EUR')
    expect(plan.map((row) => [row.now, row.next])).toEqual([
      ['260', '270.4'],
      ['69.50', '72.28'],
    ])
    expect(plan[0]!.marginNext).toBe('36.7604')
    expect(raisePlan(V2_ENTRIES.map(({ unitPrice: _price, ...rest }) => rest), [V2_ENTRIES[0]!.id], '4', 'EUR')).toEqual([])
  })
  it('a typed list price is a number above 0, in either language', () => {
    expect(parseListPrice('1.250,50')).toBe('1250.50')
    expect(parseListPrice('0')).toBeNull()
    expect(parseListPrice('abc')).toBeNull()
  })
  it('a moved version is read again and never overwritten; a refusal of this kind of write is its own words', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'version_conflict', 'x'), 'prices.refused')).toEqual({ words: { key: 'problem.write.moved' }, reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'invalid_state', 'x'), 'prices.refused')).toEqual({ words: { key: 'prices.refused' }, reload: true })
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'x'), 'prices.refused')).toEqual({ words: { key: 'prices.refused' }, reload: false })
  })
})

const LEFT_KEY = /\b(?:list|record|prices|raise|remove|add|customers|versions|activate|compare|archive|new|held|tile|rows|kind|state|validity|live|noAccess|problem|common|keys|csv)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const render = (view: ComponentType<{ model: unknown }>, model: unknown, locale: (typeof LOCALES)[number]) =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(view, { model })))

describe('every SCR-106 design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen.view as ComponentType<{ model: unknown }>, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '')
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
  it('money by grain: Sales sees margin %, never a cost (Owner S2); a role without the price grain sees no price', () => {
    expect(priceColumnIds(abilitiesOf(['money.price', 'money.cost', 'money.margin']))).toEqual(['style', 'colour', 'price', 'cost', 'margin'])
    expect(priceColumnIds(abilitiesOf(['money.price', 'money.margin']))).toEqual(['style', 'colour', 'price', 'margin'])
    expect(priceColumnIds(abilitiesOf([]))).toEqual(['style', 'colour'])
    // The design data is what the API answers each role: no cost field for Sales, no money field without grains.
    const sales = recordScreen.cases.find((item) => item.id === 'prices-sales')!.model as { record: { prices: { answer: { entries: object[] } } } }
    const readOnly = recordScreen.cases.find((item) => item.id === 'prices-no-money')!.model as { record: { prices: { answer: { entries: object[] } } } }
    expect(sales.record.prices.answer.entries.every((entry) => !('standardCost' in entry) && 'marginPct' in entry)).toBe(true)
    expect(readOnly.record.prices.answer.entries.every((entry) => !('unitPrice' in entry) && !('marginPct' in entry))).toBe(true)
  })
})

describe('B-W2b-16: a customer\'s list with its "From" day', () => {
  it('says a second change of a customer\'s list on one day in its own words, the rest as before', () => {
    expect(customersProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/validFrom', message: 'x' }]))).toEqual({ words: { key: 'customers.refusedDay' }, reload: true })
    expect(customersProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/partyIds/0', message: 'x' }])).words.key).toBe('customers.refused')
  })
})
