import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LOCATIONS, ROLE_PERMISSIONS } from '../../_shared/stock/fixtures'
import { NORTH, NORTH_ALL, overviewOf, STOCK_ROWS } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import { LocationsView } from './list/view/LocationsView'
import {
  archiveHeldOf,
  chosenSite,
  listAddressOf,
  listQuery,
  locationsCan,
  locationWriteProblem,
  moveTargets,
  newPlaceProblems,
  placeRows,
  recordStockRows,
  recordTabOf,
  searchRows,
  stockByPlace,
  suggestCode,
  withPlacesInside,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { LocationRecordView } from './record/view/LocationRecordView'

const NAMESPACES = ['shell', 'stock', 'lists', 'warehouse-locations']
// A key left on screen: a path under one of the page catalogues' top-level names ("lc.new.title", "uom.M2").
const TOPS = [...new Set(['warehouse-locations', 'stock'].flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {}).map((key) => key.split('.')[0]!)))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${TOPS.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)
const draw = (view: unknown, model: unknown, locale: 'it' | 'en' = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(view as never, { model } as never)))

describe('Locations (SCR-065): the tree, what lies where, archive and move', () => {
  it('sums the stock per place, per unit, with the hides counted once', () => {
    const byPlace = stockByPlace(STOCK_ROWS)
    expect(byPlace.get(LOCATIONS.binA1.id)).toEqual({ lines: 3, hides: 3, quantities: [{ uom: 'FT2', quantity: '147.9000' }] })
    expect(byPlace.get(LOCATIONS.binA2.id)?.quantities).toEqual([
      { uom: 'M', quantity: '120.0000' },
      { uom: 'PCS', quantity: '40.0000' },
    ])
    expect(byPlace.has(LOCATIONS.rackA.id)).toBe(false)
  })

  it('holds Archive while a place holds stock or active places, and for a person who may not manage', () => {
    const can = locationsCan(ROLE_PERMISSIONS.warehouse)
    const rows = placeRows(NORTH, overviewOf(false), can)
    const row = (id: string) => rows.find((entry) => entry.location.id === id)!
    expect(row(LOCATIONS.binA1.id)).toMatchObject({ archiveHeld: 'lc.held.hides', archiveParams: { count: 3 } })
    expect(row(LOCATIONS.binA2.id)).toMatchObject({ archiveHeld: 'lc.held.stock', archiveParams: { count: 2 } })
    expect(row(LOCATIONS.rackA.id)).toMatchObject({ archiveHeld: 'lc.held.inside', archiveParams: { count: 2 }, inside: 2, below: 2 })
    expect(row(LOCATIONS.store.id).below).toBe(3)
    expect(row(LOCATIONS.binA1.id).above.map((entry) => entry.code)).toEqual(['N-MAG', 'N-MAG-A'])
    expect(archiveHeldOf({ status: 'ACTIVE' }, 0, { lines: 0, hides: 0, quantities: [] }, { manage: true })).toBeNull()
    expect(archiveHeldOf({ status: 'ARCHIVED' }, 0, null, { manage: true })?.key).toBe('lc.held.archived')
    expect(archiveHeldOf({ status: 'ACTIVE' }, 0, null, { manage: false })?.key).toBe('lc.held.noManage')
    // Without the stock grain (inventory.stock.view) the stock is unknown: Archive is left to the API's check.
    const noStock = placeRows(NORTH, null, { manage: true, stock: false })
    expect(noStock.find((entry) => entry.location.id === LOCATIONS.binA1.id)).toMatchObject({ stock: null, archiveHeld: null })
  })

  it('moves a place only under another that is not itself or below it', () => {
    const targets = moveTargets(LOCATIONS.rackA, NORTH_ALL.locations).map((entry) => entry.code)
    expect(targets).not.toContain('N-MAG-A')
    expect(targets).not.toContain('N-MAG-A-01')
    expect(targets).not.toContain('N-MAG') // already its parent
    expect(targets).not.toContain('N-MAG-Z') // archived
    expect(targets).toContain('N-RCV')
    expect([...withPlacesInside(LOCATIONS.store.id, NORTH.locations)].sort()).toEqual([LOCATIONS.store.id, LOCATIONS.rackA.id, LOCATIONS.binA1.id, LOCATIONS.binA2.id].sort())
  })

  it('checks a new place: the code upper-cased, its shape, unique on the site; a name', () => {
    expect(suggestCode(LOCATIONS.rackA, NORTH.locations)).toBe('N-MAG-A-03')
    expect(suggestCode(null, [])).toBe('LOC-01')
    expect(newPlaceProblems({ parentId: null, code: 'n-mag-a-01', name: 'X', kind: 'BIN' }, NORTH.locations)).toEqual({ code: 'lc.new.codeTaken' })
    expect(newPlaceProblems({ parentId: null, code: 'BAD CODE', name: '', kind: 'BIN' }, NORTH.locations)).toEqual({ code: 'lc.new.codeShape', name: 'lc.new.nameMissing' })
    expect(newPlaceProblems({ parentId: null, code: 'n-new', name: 'Nuovo', kind: 'WAREHOUSE' }, NORTH.locations)).toEqual({})
  })

  it('says a refusal in its own words: the code taken, archive refused, a newer version, the parent', () => {
    expect(locationWriteProblem(new ApiError('conflict', 409, 'conflict', 'Site STAB-N already has a location N-X.'))).toEqual({ key: 'lc.new.codeTaken', field: 'code' })
    expect(locationWriteProblem(new ApiError('conflict', 409, 'invalid_state', 'The location still holds stock.'))).toEqual({ key: 'lc.problem.notNow' })
    expect(locationWriteProblem(new ApiError('conflict', 409, 'conflict', 'Version 3 expected.'))).toEqual({ key: 'lc.problem.changed' })
    expect(locationWriteProblem(new ApiError('invalid', 400, 'validation_failed', 'The parent is not valid.', null, [{ path: 'body/parentId', message: 'x' }]))).toEqual({ key: 'lc.problem.parent', field: 'parent' })
    expect(locationWriteProblem(new Error('x'))).toEqual({ key: 'lc.problem.write' })
  })

  it('reads the record’s stock with or without the places inside; the address round-trips', () => {
    const overview = overviewOf(true)
    expect(recordStockRows(overview, LOCATIONS.rackA.id, NORTH.locations, false)).toHaveLength(0)
    expect(recordStockRows(overview, LOCATIONS.rackA.id, NORTH.locations, true)).toHaveLength(5)
    const params = new URLSearchParams('site=s1&archived=1&q=A-0')
    expect(listAddressOf(params)).toEqual({ siteId: 's1', archived: true, q: 'A-0' })
    expect(listQuery({ siteId: 's1', archived: true, q: 'A-0' })).toBe('?site=s1&archived=1&q=A-0')
    expect(listQuery({ siteId: null, archived: false, q: ' ' })).toBe('')
    expect(recordTabOf('stock')).toBe('stock')
    expect(recordTabOf('labels')).toBe('overview')
    expect(chosenSite([], null)).toBeNull()
    expect(searchRows(placeRows(NORTH, null, { manage: true, stock: false }), 'a-0').map((row) => row.location.code)).toEqual(['N-MAG-A-01', 'N-MAG-A-02'])
  })

  it('never draws a money figure for a role without the cost grain, and no block or label controls (W2b)', () => {
    const warehouse = recordScreen.cases.find((item) => item.id === 'stock-inside')!
    const html = draw(LocationRecordView, warehouse.model.model)
    expect(html).not.toMatch(/€|EUR/)
    expect(locationsCan(ROLE_PERMISSIONS.warehouse).cost).toBe(false)
    expect(locationsCan(ROLE_PERMISSIONS.owner).cost).toBe(true)
    // The grid's cells draw in the browser; the overview a role without the grain receives holds no value at all.
    expect(overviewOf(false).rows.some((row) => 'value' in row || 'unitCost' in row)).toBe(false)
    for (const item of listScreen.cases) expect(/\bBlock\b|Print label/i.test(draw(LocationsView, item.model.model)), item.id).toBe(false)
    for (const item of recordScreen.cases) expect(/\bBlock\b|Print label/i.test(draw(LocationRecordView, item.model.model)), item.id).toBe(false)
  })
})

describe('SCR-065 draws every design case in both languages with no key left', () => {
  for (const locale of LOCALES) {
    it(`the list's ${listScreen.cases.length} cases and the record's ${recordScreen.cases.length} cases in ${locale}`, () => {
      for (const item of listScreen.cases) {
        const html = draw(LocationsView, item.model.model, locale)
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(/\{[a-zA-Z]+\}/.test(html), `${item.id} (${locale}) placeholder`).toBe(false)
      }
      for (const item of recordScreen.cases) {
        const html = draw(LocationRecordView, item.model.model, locale)
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(/\{[a-zA-Z]+\}/.test(html), `${item.id} (${locale}) placeholder`).toBe(false)
        if (locale === 'it') expect(/>(Discard|Save|Cancel|Apply changes)</.test(html), item.id).toBe(false)
      }
    })
  }

  it('the person without the right is told which permission is missing; read-only gets no inputs', () => {
    expect(draw(LocationsView, listScreen.cases.find((item) => item.id === 'sales-no-permission')!.model.model)).toContain('inventory.locations.view')
    expect(draw(LocationRecordView, recordScreen.cases.find((item) => item.id === 'read-only')!.model.model)).not.toContain('<input')
    expect(draw(LocationRecordView, recordScreen.cases.find((item) => item.id === 'archived')!.model.model)).not.toContain('<input')
    expect(draw(LocationsView, listScreen.cases.find((item) => item.id === 'read-only')!.model.model)).not.toContain('New location')
  })
})
