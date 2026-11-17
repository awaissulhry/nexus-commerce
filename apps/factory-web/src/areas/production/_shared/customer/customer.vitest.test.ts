import { describe, expect, it } from 'vitest'
import { EVERY_PARTY_WORDS } from '@nexus/factory-domain/core/permissions'
import { ApiError } from '../../../../lib/api/errors'
import { addressOf as cutAddressOf, addressText as cutAddressText } from '../../cutting/model'
import { addressOf as bundlesAddressOf, addressText as bundlesAddressText, viewQuery } from '../../bundles/model'
import { addressOf as scrapAddressOf, addressText as scrapAddressText, downgradeRow } from '../../scrap/model'
import { addressOf as callsAddressOf, addressText as callsAddressText } from '../../calls/model'
import { isFiltered, listAddressOf, listQueryText } from '../../instructions/model'
import { addressOf as reportsAddressOf, addressText as reportsAddressText, EVERY_CUSTOMER_PROBLEM, readProblem as reportsProblem } from '../../reports/model'
import { addressOf as dispatchAddressOf, addressText as dispatchAddressText, readProblemOf as dispatchProblem } from '../../dispatch/model'
import { DOWNGRADES } from '../../scrap/demo/fixtures'
import { readProblem as labourProblem } from '../../labour/model'
import { carryParty, customersText, customerText, filterChoices, isEveryCustomerRefusal, partyOf, pickedLabel, takesParty, withParty, type CustomerFilterState } from './model'

/**
 * F-PR-02 — the Production pages' one customer filter (production plan §5, 06-tree A.0, L27 "Customer filter"; the brand wall,
 * PW-02 / PW-06 on the screens): the address key `?party=` (the work orders file reads the same, B-PR-03), carried from page to
 * page, kept by every page's own address, options only the customers the API gave, neutral words for one that is not among
 * them, a Customer cell by name or code, and the honest words for a view that adds up every customer. Made-up ids only.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const params = (query: string) => new URLSearchParams(query)
const ALPHA = { id: A, code: 'C-ALPHA', name: 'Brand Alpha' }
const BETA = { id: B, code: 'C-BETA', name: 'Brand Beta' }

describe('the address key ?party=', () => {
  it('reads an id only (anything else is every customer) and writes it back with every other term kept', () => {
    expect(partyOf(params(`party=${A}`))).toBe(A)
    expect(partyOf(params(`party=${A.toUpperCase()}`))).toBe(A)
    expect(partyOf(params('party=Brand%20Alpha'))).toBeNull()
    expect(partyOf(params(''))).toBeNull()
    expect(withParty('/w/F1/production/bundles?stuck=true', A)).toBe(`/w/F1/production/bundles?stuck=true&party=${A}`)
    expect(withParty(`/w/F1/production/bundles?stuck=true&party=${A}#list`, null)).toBe('/w/F1/production/bundles?stuck=true#list')
    expect(withParty(`/w/F1/production/scrap?party=${A}`, B)).toBe(`/w/F1/production/scrap?party=${B}`)
  })

  it('is carried from one Production page to another, never to a record, another area or a page that does not read it yet', () => {
    const here = params(`view=cut&party=${A}`)
    expect(takesParty('/w/F1/production/cutting')).toBe(true)
    expect(takesParty('/production/bundles/')).toBe(true)
    expect(takesParty('/w/F1/production/bundles/0000')).toBe(false)
    expect(carryParty('/w/F1/production/bundles', '/production/cutting', here)).toBe(`/w/F1/production/bundles?party=${A}`)
    expect(carryParty('/w/F1/production/scrap?view=today', '/production/cutting', here)).toBe(`/w/F1/production/scrap?view=today&party=${A}`)
    // A link that names its own customer keeps it; a record and another area get none. F-PR-03: Work orders takes it now (and
    // gives it back), never a work order's record.
    expect(carryParty(`/w/F1/production/scrap?party=${B}`, '/production/cutting', here)).toBe(`/w/F1/production/scrap?party=${B}`)
    expect(carryParty('/w/F1/production/cutting/orders/0000', '/production/cutting', here)).toBe('/w/F1/production/cutting/orders/0000')
    expect(carryParty('/w/F1/sales/orders', '/production/cutting', here)).toBe('/w/F1/sales/orders')
    expect(carryParty('/w/F1/production/work-orders', '/production/cutting', here)).toBe(`/w/F1/production/work-orders?party=${A}`)
    expect(carryParty('/w/F1/production/cutting', '/production/work-orders', here)).toBe(`/w/F1/production/cutting?party=${A}`)
    expect(carryParty('/w/F1/production/work-orders/0000', '/production/work-orders', here)).toBe('/w/F1/production/work-orders/0000')
    // From a page that is not a Production list, or with no customer picked: as it was.
    expect(carryParty('/w/F1/production/bundles', '/sales/orders', here)).toBe('/w/F1/production/bundles')
    expect(carryParty('/w/F1/production/bundles', '/production/cutting', params('view=cut'))).toBe('/w/F1/production/bundles')
  })

  it('stays in every page’s own address when its other terms move', () => {
    const query = params(`view=cut&q=JKT&party=${A}`)
    expect(cutAddressText({ ...cutAddressOf(query), view: 'all' })).toBe(`?view=all&q=JKT&party=${A}`)
    expect(bundlesAddressText({ ...bundlesAddressOf(params(`stuck=true&party=${A}`)), q: 'BDL' })).toBe(`?stuck=true&q=BDL&party=${A}`)
    expect(viewQuery('all', '', null, null, A).partyId).toBe(A)
    expect(viewQuery('all', '', null).partyId).toBeUndefined()
    expect(scrapAddressText({ ...scrapAddressOf(params(`party=${A}`)), period: '7' })).toBe(`?period=7&party=${A}`)
    expect(callsAddressText({ ...callsAddressOf(params(`party=${A}`)), view: 'closed' })).toBe(`?view=closed&party=${A}`)
    const instructions = listAddressOf(params(`party=${A}`))
    expect(listQueryText({ ...instructions, q: 'cuff' })).toBe(`?q=cuff&party=${A}`)
    expect(isFiltered(instructions)).toBe(true)
    expect(isFiltered(listAddressOf(params('')))).toBe(false)
    expect(reportsAddressText({ ...reportsAddressOf(params(`party=${A}`)), date: '2026-11-16' })).toBe(`?date=2026-11-16&party=${A}`)
    // Dispatch needs every customer and has no filter of its own: the address keeps it for the next page.
    expect(dispatchAddressText({ ...dispatchAddressOf(params(`party=${A}`)), line: 'L1' })).toBe(`?line=L1&party=${A}`)
  })
})

describe('the filter’s choices', () => {
  const base: CustomerFilterState = { options: [ALPHA, BETA], party: null, everyCustomer: true, names: true }

  it('offers All customers, then the customers the API gave (by name with parties.view, else by code)', () => {
    expect(filterChoices(base)).toEqual([
      { value: '', label: null, key: 'all' },
      { value: A, label: 'Brand Alpha', key: null },
      { value: B, label: 'Brand Beta', key: null },
    ])
    expect(filterChoices({ ...base, names: false }).map((choice) => choice.label)).toEqual([null, 'C-ALPHA', 'C-BETA'])
    expect(pickedLabel({ ...base, party: B })).toBe('Brand Beta')
    expect(pickedLabel(base)).toBeNull()
  })

  it('a person limited to some customers reads "All my customers" and never a customer outside their reach', () => {
    const limited: CustomerFilterState = { ...base, options: [BETA], everyCustomer: false }
    expect(filterChoices(limited)).toEqual([
      { value: '', label: null, key: 'allMine' },
      { value: B, label: 'Brand Beta', key: null },
    ])
    // A's id typed in the address (or an old link) is "Not in your customers": the same words as an unknown id, no name.
    const typed = filterChoices({ ...limited, party: A })
    expect(typed[1]).toEqual({ value: A, label: null, key: 'unknown' })
    expect(JSON.stringify(typed)).not.toContain('Alpha')
    expect(filterChoices({ ...limited, party: '33333333-3333-4333-8333-333333333333' })[1]?.key).toBe('unknown')
    expect(pickedLabel({ ...limited, party: A })).toBeNull()
    // Not read yet: no "unknown" guess.
    expect(filterChoices({ ...limited, options: null, party: A }).map((choice) => choice.key)).toEqual(['allMine'])
  })
})

describe('a Customer cell', () => {
  it('names the customer (or its code), a work order made before the rule, or none', () => {
    expect(customerText({ customer: ALPHA, mixedCustomers: false }, true)).toEqual({ text: 'Brand Alpha', mixed: false })
    expect(customerText({ customer: ALPHA }, false)).toEqual({ text: 'C-ALPHA', mixed: false })
    expect(customerText({ customer: null, mixedCustomers: true }, true)).toEqual({ text: '', mixed: true })
    expect(customerText({ customer: null, mixedCustomers: false }, true)).toBeNull()
    expect(customerText({}, true)).toBeNull()
    expect(customersText([ALPHA, BETA], true)).toBe('Brand Alpha, Brand Beta')
    expect(customersText([ALPHA, BETA], false)).toBe('C-ALPHA, C-BETA')
    expect(customersText([], true)).toBeNull()
    expect(customersText(undefined, true)).toBeNull()
  })

  it('a second-quality row carries the customer of the work order it came from', () => {
    const row = downgradeRow({ ...DOWNGRADES[0]!, customer: BETA, mixedCustomers: false })
    expect(row.customer).toEqual(BETA)
    expect(downgradeRow(DOWNGRADES[0]!).customer).toBeUndefined()
  })
})

describe('a view that adds up every customer', () => {
  const everyParty = (message: string) => new ApiError('forbidden', 403, 'forbidden', message)

  it('is told apart from any other refusal, in both languages of the API', () => {
    expect(isEveryCustomerRefusal(everyParty(EVERY_PARTY_WORDS.en))).toBe(true)
    expect(isEveryCustomerRefusal(everyParty(EVERY_PARTY_WORDS.it))).toBe(true)
    expect(isEveryCustomerRefusal(everyParty('You may not do this.'))).toBe(false)
    expect(isEveryCustomerRefusal(new ApiError('not_found', 404, 'not_found', EVERY_PARTY_WORDS.en))).toBe(false)
    expect(isEveryCustomerRefusal(new Error(EVERY_PARTY_WORDS.en))).toBe(false)
  })

  it('Production reports, Dispatch and Labour say it in words, never as a generic refusal or an empty board', () => {
    expect(labourProblem(everyParty(EVERY_PARTY_WORDS.it))).toBe('problem.everyCustomer')
    expect(labourProblem(everyParty('You may not do this.'))).toBe('problem.forbidden')
    expect(reportsProblem(everyParty(EVERY_PARTY_WORDS.en))).toBe(EVERY_CUSTOMER_PROBLEM)
    expect(reportsProblem(everyParty('You may not do this.'))).toBe('error.forbidden')
    expect(dispatchProblem(everyParty(EVERY_PARTY_WORDS.en))).toBe('error.everyCustomer')
    expect(dispatchProblem(everyParty('You may not do this.'))).toBe('error.forbidden')
  })
})
