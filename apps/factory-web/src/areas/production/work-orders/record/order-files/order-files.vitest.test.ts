import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { workOrder } from '../../../_shared/fixtures'
import { filesReady, orderFilesOf, orderGroup, twoGroupsOf, twoOrdersOf } from './fixtures'
import { lookOf, orderNameOf, orderThreadDoor, sectionsOf, threadChoices, type OrderFilesModel, type OrderThreadChoice } from './model'
import { OrderFilesBody, OrderThreadButton } from './view/OrderFiles'

/**
 * F-PR-25 — Order files and Order thread on the work order band (L16: the order's PDFs and its thread are the source; nobody re-types
 * a measurement). One window: each order a group (their PO first), Order · Lines · Measurements newest first, the measurement lock
 * line counted and never dropped, a PDF or picture beside the list with Download; "Order thread" one button or a menu (PO first).
 * PW-16 (web side): every file opens through the work order's own walled route, a worksheet through the made-to-measure route only.
 */

const WO = workOrder('IN_PROGRESS')
const body = (model: OrderFilesModel, choices: readonly OrderThreadChoice[], locale: 'it' | 'en' = 'en') => textOf(render(createElement(OrderFilesBody, { model, choices }), locale))

describe('F-PR-25 — the window: groups, parts, newest first', () => {
  it('splits one order into Order · Lines · Measurements, each newest first; an empty part is not drawn', () => {
    const group = orderGroup(WO)
    const sections = sectionsOf(group)
    expect(sections.map((section) => section.key)).toEqual(['order', 'lines', 'measurements'])
    expect(sections[0]!.entries.map((entry) => (entry.kind === 'file' ? entry.file.id : entry.sheet.documentId))).toEqual(['file-demo-1'])
    // Line 1's artwork (4 Oct) before line 2's quote artwork (1 Oct): newest first.
    expect(sections[1]!.entries.map((entry) => (entry.kind === 'file' ? entry.file.id : ''))).toEqual(['file-demo-2', 'file-demo-3'])
    expect(sections[2]!.entries.map((entry) => entry.kind)).toEqual(['worksheet'])
    expect(sectionsOf({ files: [], worksheets: [], measurementsLeftOut: 0 })).toEqual([])
  })

  it('a body-data file goes under Measurements with the worksheets, newest first, never under Order or Lines', () => {
    const sheetFile = { id: 'file-body', from: 'LINE' as const, line: { id: 'line-demo-3', seq: 3 }, name: 'Misure cliente.pdf', contentType: 'application/pdf', kind: 'DOCUMENT', category: 'MEASUREMENTS', sizeBytes: 1000, versionNo: 1, at: '2026-10-20T08:00:00.000Z', bodyData: true }
    const sections = sectionsOf(orderGroup(WO, { files: [...orderGroup(WO).files, sheetFile] }))
    const measurements = sections.find((section) => section.key === 'measurements')!
    expect(measurements.entries.map((entry) => (entry.kind === 'file' ? entry.file.id : entry.sheet.documentId))).toEqual(['file-body', 'sheet-demo-1'])
    for (const section of sections.filter((one) => one.key !== 'measurements')) expect(section.entries.some((entry) => entry.kind === 'file' && entry.file.bodyData)).toBe(false)
  })

  it('the measurement lock: "Measurement sheet: opens with the measurements right (n)", counted, never dropped (it + en)', () => {
    const locked = orderGroup(WO, { worksheets: [], measurementsLeftOut: 2 })
    expect(sectionsOf(locked).find((section) => section.key === 'measurements')).toEqual({ key: 'measurements', entries: [], locked: 2 })
    const model = filesReady(orderFilesOf(WO, [locked]))
    expect(body(model, [])).toContain('Measurement sheets: open with the measurements right (2)')
    expect(body(filesReady(orderFilesOf(WO, [orderGroup(WO, { worksheets: [], measurementsLeftOut: 1 })])), [])).toContain('Measurement sheet: opens with the measurements right (1)')
    expect(body(model, [], 'it')).toContain('Schede misure: si aprono con il permesso misure (2)')
    // Without the right nothing of the sheet is drawn: no worksheet row, no name of the sheet.
    expect(body(model, [])).not.toContain('Measurement worksheet')
  })

  it('several orders of the one customer: one group each, their PO first', () => {
    const two = twoOrdersOf(WO)
    const text = body(filesReady(twoGroupsOf(two)), threadChoices(two.orders, { state: 'ready', read: twoGroupsOf(two) }))
    expect(text).toContain(`PO PO-ESEMPIO-7 · ${two.orders[0]!.number}`)
    expect(text).toContain(`PO PO-ESEMPIO-9 · ${two.orders[1]!.number}`)
    expect(text.indexOf(two.orders[0]!.number)).toBeLessThan(text.indexOf(two.orders[1]!.number))
    expect(orderNameOf({ number: 'SO-1', customerRef: '  ' })).toEqual({ po: null, number: 'SO-1' })
  })

  it('empty, loading and could not load are said in words', () => {
    expect(body(filesReady(orderFilesOf(WO, [orderGroup(WO, { files: [], worksheets: [] })])), [])).toContain('This order has no files yet.')
    expect(body({ files: { state: 'loading' }, open: true, opening: null, problem: null }, [])).toContain('Reading the order files')
    const failed = body({ files: { state: 'error', problem: 'error.offline' }, open: true, opening: null, problem: null }, [])
    expect(failed).toContain("Couldn't read the order files")
    expect(failed).toContain('Try again')
  })
})

describe('F-PR-25 — beside the list', () => {
  it('a PDF opens in the viewer, a picture as it is, anything else Download only', () => {
    expect(lookOf('application/pdf')).toBe('pdf')
    expect(lookOf('image/png')).toBe('picture')
    expect(lookOf('image/jpeg; charset=binary')).toBe('picture')
    expect(lookOf('image/svg+xml')).toBe('other')
    expect(lookOf('application/zip')).toBe('other')
  })

  it('nothing picked: the place says what opens there; being read and refused are said in words', () => {
    const read = orderFilesOf(WO)
    expect(body(filesReady(read), [])).toContain('Pick a file: a PDF or a picture opens here')
    expect(body(filesReady(read, { shown: { id: 'file-demo-3', name: 'Grafica schiena v3.pdf', look: 'pdf', state: 'loading' } }), [])).toContain('Grafica schiena v3.pdf')
    const refused = body(filesReady(read, { shown: { id: 'file-demo-1', name: 'Conferma.pdf', look: 'pdf', state: 'error', problem: 'orderFiles.gone' } }), [])
    expect(refused).toContain("Couldn't show Conferma.pdf")
    expect(refused).toContain('This file is no longer there')
    expect(body(filesReady(read, { shown: { id: 'file-demo-1', name: 'Tabella.xlsx', look: 'other', state: 'ready', src: null } }), [])).toContain('No preview for this kind of file')
  })

  it('PW-16 (web side): a file opens and downloads ONLY through the work order’s own route; a worksheet through the made-to-measure route', () => {
    const hook = readFileSync(new URL('./use-order-files.ts', import.meta.url), 'utf8')
    expect(hook).toContain("openOrderFile(api, workOrderId, file.id, 'preview')")
    expect(hook).toContain("openOrderFile(api, workOrderId, file.id, 'download')")
    expect(hook).toContain('openWorksheet(api, sheet.profileId, sheet.documentId)')
    for (const source of [hook, readFileSync(new URL('./view/OrderFiles.tsx', import.meta.url), 'utf8')]) {
      expect(source).not.toMatch(/['`]\/files\//)
      expect(source).not.toContain('downloadLink(')
      // No window.open: nothing opens in another tab (the file is shown beside the list, Download saves it).
      expect(source).not.toContain('window.open(')
    }
  })
})

describe('F-PR-25 — "Order thread" in the band', () => {
  const two = twoOrdersOf(WO)
  const choices = threadChoices(two.orders, { state: 'ready', read: twoGroupsOf(two) })

  it('none without an order thread the reader may read; one button for one order; a menu for several', () => {
    expect(orderThreadDoor([])).toEqual({ kind: 'none' })
    expect(orderThreadDoor(choices.slice(0, 1)).kind).toBe('one')
    expect(orderThreadDoor(choices)).toEqual({ kind: 'menu', choices })
    expect(textOf(render(createElement(OrderThreadButton, { choices: [] }), 'en'))).not.toContain('Order thread')
    expect(textOf(render(createElement(OrderThreadButton, { choices: choices.slice(0, 1) }), 'en'))).toContain('Order thread')
    expect(textOf(render(createElement(OrderThreadButton, { choices }), 'en'))).toContain('Order threads (2)')
    expect(textOf(render(createElement(OrderThreadButton, { choices }), 'it'))).toContain('Conversazioni degli ordini (2)')
  })

  it('each choice carries the order’s own company (the docked thread’s scope) and its PO; an order the route gives no thread is not offered', () => {
    expect(choices.map((choice) => [choice.number, choice.customerRef, choice.companyId])).toEqual([
      [two.orders[0]!.number, 'PO-ESEMPIO-7', two.companyId],
      [two.orders[1]!.number, 'PO-ESEMPIO-9', two.companyId],
    ])
    const read = twoGroupsOf(two)
    const noSecond = { ...read, groups: [read.groups[0]!, { ...read.groups[1]!, thread: null }] }
    expect(threadChoices(two.orders, { state: 'ready', read: noSecond }).map((choice) => choice.orderId)).toEqual([two.orders[0]!.id])
  })

  it('the container docks the picked order’s thread on the order’s own company, never the work order’s', () => {
    const container = readFileSync(new URL('../WorkOrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/type: 'SalesOrder', id: pickedOrder\.orderId, companyId: pickedOrder\.companyId/)
    const view = readFileSync(new URL('../view/WorkOrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<OrderThreadButton choices={model.threadChoices ?? []} actions={actions?.orderFiles} />')
  })
})
