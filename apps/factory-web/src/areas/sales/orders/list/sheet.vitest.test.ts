import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { exportMenuItems } from '../../../../list-frame/tools/ListToolsBar'
import { exportColumnsOf } from '../../../../list-frame/tools/model'
import { selectedExportRequest } from '../../../../list-frame/w2b/bulk'
import { forRole, LIST_ROWS, canOf } from '../_demo/fixtures'
import type { OrderRow } from '../api'
import { brandFromAddress, companyFromAddress, listAddress, rowsQuery, viewCount } from '../model'
import { BOARD } from '../_demo/fixtures'
import { brandCell, customerDoor, depositDoor, exportAbout, invoicedCell, invoicedDoor, linesDoor, NAMESPACE, orderDoor, quoteDoor, shippedDoor } from './sheet/model'

/**
 * B-TH-225 (threads plan TH-1a, picture 23; Owner rule 2026-11-16 "every cell is a door"; features grid-F01…F30, ORD-G02): the
 * Orders sheet's rules — Invoiced's word for everyone and its amount only with the price grain, each cell's door (or the reason
 * it is plain words), Brand as the label on the garment, Brand and Company in the address, the honest count, what Export ▾ says
 * the file holds, and "Export N" through the export job with the picked ids and the screen's columns.
 */

const P = '/w/DEMO'
const row = (n: number) => LIST_ROWS[n]!
const sales = canOf('sales')
const manager = canOf('manager')
const tFor = (locale: (typeof LOCALES)[number]) => createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)

describe('Invoiced: the word for every reader, the amount only with the price grain', () => {
  const shipped = row(7) // SHIPPED: invoiced in part
  it('sales (price grain): the word and the amount', () => {
    expect(invoicedCell(shipped, sales)).toEqual({ word: 'invoiced.PART', amount: 267400 })
  })
  it('the production manager: the word, no amount (the API leaves it out; the cell never shows 0)', () => {
    const seen = forRole(shipped, 'manager')
    expect(seen.invoiced?.amount).toBeUndefined()
    expect(invoicedCell(seen, manager)).toEqual({ word: 'invoiced.PART', amount: null })
    expect(invoicedCell({ ...shipped, invoiced: { ...shipped.invoiced!, amount: 267400 } }, manager).amount).toBeNull()
  })
  it('none invoiced: the word only, no door; every word in it and en', () => {
    expect(invoicedCell(row(0), sales)).toEqual({ word: 'invoiced.NONE', amount: null })
    expect(invoicedDoor(P, row(0), sales)).toBeNull()
    for (const locale of LOCALES) for (const state of ['NONE', 'PART', 'ALL']) expect(tFor(locale)(`invoiced.${state}`)).not.toMatch(/invoiced\./)
  })
})

describe('every cell is a door (a real address: ⌘-click opens a new tab)', () => {
  it('Number → the order, Customer → the customer, Pieces / Promised → the Lines tab, From quote → the quote', () => {
    expect(orderDoor(P, row(0))).toMatchObject({ href: `${P}/sales/orders/${row(0).id}` })
    expect(customerDoor(P, row(0))).toMatchObject({ href: `${P}/sales/customers/${row(0).partyId}` })
    expect(linesDoor(P, row(0))).toMatchObject({ href: `${P}/sales/orders/${row(0).id}?tab=lines` })
    expect(linesDoor(P, row(0), true)).toMatchObject({ tip: { key: 'door.promise' } })
    expect(quoteDoor(P, row(0))).toMatchObject({ href: `${P}/sales/quotes/${row(0).doors.quote!.id}` })
    expect(quoteDoor(P, { ...row(0), doors: { ...row(0).doors, quote: null } })).toEqual({ held: { key: 'held.quotes' } })
    expect(quoteDoor(P, { ...row(0), quote: null })).toBeNull()
  })
  it('Invoiced: one invoice opens it; several open the order’s Invoices & payments; the manager reads the reason', () => {
    expect(invoicedDoor(P, row(7), sales)).toMatchObject({ href: `${P}/finance/invoices/${row(7).doors.invoices!.only!.id}` })
    expect(invoicedDoor(P, row(8), sales)).toMatchObject({ href: `${P}/sales/orders/${row(8).id}?tab=money` })
    expect(invoicedDoor(P, { ...row(7), doors: { ...row(7).doors, invoices: null } }, manager)).toEqual({ held: { key: 'held.invoices' } })
  })
  it('Shipped: one DDT → its shipment’s documents; DDTs of several shipments → the order’s Shipments tab; 0 opens nothing', () => {
    expect(shippedDoor(P, row(7))).toMatchObject({ href: `${P}/warehouse/shipments/${row(7).doors.deliveryNotes!.shipmentId}?tab=documents` })
    expect(shippedDoor(P, row(6))).toMatchObject({ href: `${P}/sales/orders/${row(6).id}?tab=shipments` })
    expect(shippedDoor(P, row(0))).toBeNull()
    expect(shippedDoor(P, { ...row(7), doors: { ...row(7).doors, deliveryNotes: null } })).toEqual({ held: { key: 'held.shipping' } })
  })
  it('Deposit: its invoice; "Not needed" opens nothing; without invoices.view the reason', () => {
    const withInvoice = LIST_ROWS.find((entry) => entry.doors.depositInvoice && entry.deposit.state !== 'NOT_NEEDED')!
    expect(depositDoor(P, withInvoice, sales)).toMatchObject({ href: `${P}/finance/invoices/${withInvoice.doors.depositInvoice!.id}` })
    expect(depositDoor(P, row(2), sales)).toBeNull()
    expect(depositDoor(P, { ...withInvoice, doors: { ...withInvoice.doors, depositInvoice: null } }, manager)).toEqual({ held: { key: 'held.invoices' } })
  })
  it('every door and reason has its words in it and en', () => {
    for (const locale of LOCALES) {
      const t = tFor(locale)
      for (const key of ['door.order', 'door.customer', 'door.lines', 'door.promise', 'door.deposit', 'door.shipOne', 'door.ship', 'door.invoiceOne', 'door.invoices', 'door.quote', 'held.invoices', 'held.shipping', 'held.quotes']) expect(t(key, { number: 'SO-1', name: 'X', ddt: 'D-1' }), `${locale} ${key}`).not.toMatch(/^(door|held)\.|\{/)
    }
  })
})

describe('Brand: the label on the garment, a funnel that narrows the sheet', () => {
  it('own collection, one label, a label the reader may not see, two labels', () => {
    expect(brandCell({ brands: [{ partyId: null, name: null, own: true }] })).toEqual({ kind: 'one', value: 'own', name: null, own: true })
    expect(brandCell({ brands: [{ partyId: 'p1', name: 'Brand Alpha', own: false }] })).toEqual({ kind: 'one', value: 'p1', name: 'Brand Alpha', own: false })
    expect(brandCell({ brands: [{ partyId: null, name: null, own: false }] })).toEqual({ kind: 'hidden' })
    expect(brandCell({ brands: [] })).toEqual({ kind: 'none' })
    const two = brandCell({ brands: [{ partyId: 'p1', name: 'Brand Alpha', own: false }, { partyId: null, name: null, own: true }] })
    expect(two.kind).toBe('several')
  })
  it('?brand= (an id or own) and ?company= (an id) stay in the address and reach the list query', () => {
    const party = '0190a1b2-0000-7000-8000-00000000000a'
    const params = (query: string) => new URLSearchParams(query)
    expect(brandFromAddress(params('brand=own'))).toBe('own')
    expect(brandFromAddress(params(`brand=${party}`))).toBe(party)
    expect(brandFromAddress(params('brand=ALPHA'))).toBeNull()
    expect(companyFromAddress(params(`company=${party}`))).toBe(party)
    expect(listAddress('/p', { rows: 'open', q: '', layout: 'list', brand: 'own', company: party })).toBe(`/p?brand=own&company=${party}`)
    expect(rowsQuery('open', '', null, null, { brand: 'own', companyId: party })).toMatchObject({ open: true, brand: 'own', companyId: party })
    expect(rowsQuery('open', '')).not.toHaveProperty('brand')
  })
})

describe('the honest count and what Export ▾ says the file holds (screen = file)', () => {
  it('the view’s count comes from the board’s counts (the same filters), null while unread', () => {
    expect(viewCount(BOARD, 'open')).toBe(7)
    expect(viewCount(BOARD, 'late')).toBe(2)
    expect(viewCount(BOARD, 'IN_PRODUCTION')).toBe(2)
    expect(viewCount(BOARD, 'all')).toBe(21)
    expect(viewCount(null, 'open')).toBeNull()
  })
  it('the menu names the customer and the view, each format the orders it writes, and the money note without the price right', () => {
    for (const locale of LOCALES) {
      const t = tFor(locale)
      const about = exportAbout(t, { customer: 'Brand Alpha', view: 'Open', count: 42, price: false, formats: ['XLSX', 'CSV'] })
      expect(about.heading).toContain('Brand Alpha')
      expect(about.formats.XLSX).toContain('42')
      expect(about.formats.CSV).toContain('42')
      expect(about.note).toBe(`${t('export.note')} ${t('export.noteNoPrice')}`)
      const everyone = exportAbout(t, { customer: null, view: 'Open', count: null, price: true, formats: ['XLSX'] })
      expect(everyone.heading).toContain(t('switcher.all'))
      expect(everyone.formats.XLSX).toBe(t('export.xlsxEvery'))
      expect(everyone.note).toBe(t('export.note'))
      const items = exportMenuItems((key) => key, ['XLSX', 'CSV'], [], (iso) => iso, { start: () => undefined, open: () => undefined }, String, about)
      expect(items[0]).toMatchObject({ id: 'h-about', heading: true, label: about.heading })
      expect(items.map((item) => item.label)).toEqual([about.heading, about.formats.XLSX, about.formats.CSV])
      expect(items[2]!.description).toBe(about.note)
    }
    // A list without the words keeps the frame's own.
    expect(exportMenuItems((key) => key, ['CSV'], [], (iso) => iso, { start: () => undefined, open: () => undefined })[0]!.label).toBe('tools.exportAs.CSV')
  })
  it('Export N goes through the export job with the picked ids and the screen’s columns (a cell’s second fact beside it)', () => {
    const columns: ColDef<OrderRow>[] = [
      { colId: 'picture', headerName: 'Picture' },
      { colId: 'number', headerName: 'Number', context: { exportWith: [{ key: 'customerRef', label: 'Customer PO' }] } },
      { colId: 'orderDate', headerName: 'Ordered', hide: true, context: { exportWith: [{ key: 'requested', label: 'Requested' }] } },
      { colId: 'invoiced', headerName: 'Invoiced', context: { exportWith: [{ key: 'invoicedAmount', label: 'Invoiced amount' }] } },
      { colId: 'more', headerName: '⋯', pinned: 'right' },
    ]
    const ids = LIST_ROWS.slice(0, 3).map((entry) => entry.id)
    const body = selectedExportRequest({ listKey: 'sales.orders', format: 'XLSX', query: 'party=p1&brand=own', columns, title: 'Orders - Brand Alpha', ids })
    expect(body).toMatchObject({ listKey: 'sales.orders', format: 'XLSX', query: 'party=p1&brand=own', title: 'Orders - Brand Alpha', ids })
    expect(body.columns.map((column) => column.key)).toEqual(['picture', 'number', 'customerRef', 'invoiced', 'invoicedAmount'])
    expect(exportColumnsOf(columns as never).map((column) => column.key)).not.toContain('requested')
  })
})
