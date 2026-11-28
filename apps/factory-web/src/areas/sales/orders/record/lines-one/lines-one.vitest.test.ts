import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { OrderLinesTable } from '../../../../../lib/order-lines'
import { order } from '../../_demo/fixtures'
import { oneTableModeOf, orderLineRowsOf } from './adapter'

/**
 * owb-of6 step 0 (of5 step 3's text) — Lines on S1's ONE lines table: the sales face has no price cell (the host passes no prices: no
 * column, no key); after shipping the table reads only ("It left the factory. A change now is a return."); a reader who may not change
 * lines reads it; who may change a confirmed order keeps today's editor (save bar, Review and save). Written, not run (Owner rule).
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = (node: ReactElement): string => renderToString(createElement(I18nProvider, { locale: 'en', messages: {} }, node))
const tableOf = (status: Parameters<typeof order>[0], mode: 'shipped' | 'confirmed') =>
  html(createElement(OrderLinesTable, { model: { rows: orderLineRowsOf(order(status)), mode, columns: [], styles: [], kinds: [], prices: null, pending: false, removed: [], writeHeld: null, saving: [], columnsDoor: false, door: 'office', room: 'wide' } }))

describe('owb-of6 step 0: the sales face has no price cell', () => {
  it('the rows carry no price at all, and the table draws no price column without the host\'s prices', () => {
    const rows = orderLineRowsOf(order('CONFIRMED'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'material', 'model', 'own', 'ownVersions', 'pieces', 'seq', 'sizes'])
    expect(JSON.stringify(rows)).not.toMatch(/price|amount|cost/i)
    const drawn = tableOf('SHIPPED', 'shipped')
    expect(drawn).not.toContain('Price')
    expect(read('../view/LinesTab.tsx')).toContain("prices: null, pending: false")
  })
  it('each line: its style as a fixed model, its colourway, its sizes in words, its pieces', () => {
    const [first] = orderLineRowsOf(order('CONFIRMED'))
    expect(first!.model.fixed).toBe(true)
    expect(first!.sizes.mode).toBe('SIZES')
    expect(first!.sizes.run).toMatch(/×/)
    expect(first!.pieces.count).toBeGreaterThan(0)
  })
})

describe('owb-of6 step 0: shipped → read only', () => {
  it('a shipped, delivered, closed or cancelled order reads the ONE table only; a confirmed one keeps the editor for who may change it', () => {
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(oneTableModeOf(order(status), true), status).toBe('shipped')
    expect(oneTableModeOf(order('CONFIRMED'), true)).toBeNull()
    expect(oneTableModeOf(order('PARTLY_SHIPPED'), true)).toBeNull()
    expect(oneTableModeOf(order('IN_PRODUCTION'), false)).toBe('confirmed')
    expect(tableOf('SHIPPED', 'shipped')).toContain('It left the factory')
  })
  it('the tab draws it before today\'s editor and keeps the charges', () => {
    const tab = read('../view/LinesTab.tsx')
    expect(tab).toContain('const oneMode = oneTableModeOf(order, reader.writes)')
    expect(tab.indexOf('<OrderLinesTable')).toBeLessThan(tab.indexOf('<SaveBar'))
  })
})
