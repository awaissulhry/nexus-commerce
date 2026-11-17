import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { render, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { workOrder } from '../../_shared/fixtures'
import { isWideTab, MERGED_TABS, RECORD_TABS, tabOf } from '../../_shared/model'
import { designScreen } from './fixtures'
import { filesReady, leftOut, orderFilesOf, orderGroup } from './order-files/fixtures'
import { hasOrderFiles, leftOutOf, orderFilesCount, pickOf, threadChoices, type OrderFilesModel } from './order-files/model'
import { OrderFilesBody } from './order-files/view/OrderFiles'

/**
 * B-TH-265 — the work order on RecordFrame (O-PRO-WO; the rule of picture 38, 08-tabs O-PRO-WO; agreement T9 with the production
 * lane): the band in the shell's row with ONE status pill, ONE thread docked beside every tab (the work order's own notes, never
 * shareable with a customer; an order's thread picked beside it), Activity's tools in the thread's "⋯" (R-ACT), one notice, tabs
 * 9 → 7 with every old address kept (R-8), Documents' doors in the band's ⋯ (R-7), "Order files (n)" through the work order's own
 * route only. Wall W16, W27: the work order's thread has no customer audience; nothing of another customer is named.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const dockOf = (html: string) => html.slice(html.indexOf('class="fw-rcf-dock"'))
const WO = workOrder('IN_PROGRESS')
/** The dialog's content (the DS Modal draws nothing on the server before hydration). */
const body = (model: OrderFilesModel, locale: 'it' | 'en' = 'en') => textOf(render(createElement(OrderFilesBody, { model, choices: threadChoices(WO.orders, model.files) }), locale))

describe('B-TH-265 — the work order on RecordFrame', () => {
  it('tabs 9 → 7: Overview · Materials · Cutting · Bundles · Operations · Quality · Labour & cost; no Documents, no Activity', () => {
    expect(RECORD_TABS).toEqual(['overview', 'materials', 'cutting', 'bundles', 'operations', 'quality', 'labour'])
    const text = textOf(draw('thread-docked'))
    for (const tab of ['Overview & release', 'Materials', 'Cutting', 'Bundles', 'Operations & WIP', 'Quality', 'Labour & cost']) expect(text).toContain(tab)
    expect(text).not.toMatch(/\bActivity\b/)
    expect(text).not.toMatch(/\bDocuments\b/)
    for (const tab of ['Riepilogo e rilascio', 'Materiali', 'Taglio', 'Fasci']) expect(textOf(draw('thread-docked', 'it'))).toContain(tab)
  })

  it('every old ?tab= keeps working (R-8): Documents → Overview (its doors in the band’s ⋯), Activity → Overview with the thread opened', () => {
    expect(MERGED_TABS).toEqual({ documents: 'overview', activity: 'overview' })
    expect(tabOf('documents')).toBe('overview')
    expect(tabOf('activity')).toBe('overview')
    for (const tab of RECORD_TABS) expect(tabOf(tab)).toBe(tab)
    expect(tabOf(null)).toBe('overview')
    expect(tabOf('nope')).toBe('overview')
    expect(tabOf('constructor')).toBe('overview')
  })

  it('a wide grid tab (Cutting, Bundles) gives the thread one third under 1600 px; the others 40 %', () => {
    expect(isWideTab('cutting')).toBe(true)
    expect(isWideTab('bundles')).toBe(true)
    expect(isWideTab('overview')).toBe(false)
    expect(isWideTab('labour')).toBe(false)
  })

  it('ONE thread on the page: the docked thread, no record panels, no old narrow dock', () => {
    const html = draw('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
    expect(html).not.toContain('fw-pr-dock')
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const id of ['thread-docked', 'thread-cutting', 'materials', 'quality', 'w2a-labour', 'draft-blocked']) expect(draw(id), id).toContain('aria-label="Thread tools"')
  })

  it('the work order’s own thread has no party: Office notes only — no "Reply to", no customer e-mail in it (W27)', () => {
    // The thread column itself (the pick above it names the order's customer: that is the other thread's door).
    const dock = dockOf(draw('thread-docked'))
    const column = textOf(dock.slice(dock.indexOf('fw-rt-column')))
    expect(column).not.toMatch(/Reply to (?!the customer)/)
    expect(column).not.toMatch(/@[a-z0-9-]+\.example/)
    expect(column).not.toContain(WO.orders[0]!.partyName)
  })

  it('the band: ONE status pill in the shell’s row; the next step and the hold beside it; no ⌘J handler of its own', () => {
    const html = draw('thread-docked')
    const band = html.slice(html.indexOf('fw-rcf-hdr'), html.indexOf('class="fw-rcf-body"'))
    expect(band.length).toBeGreaterThan(0)
    expect((band.match(/class="nds-pill /g) ?? []).length).toBe(1)
    const source = readFileSync(new URL('./view/WorkOrderRecordView.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain("event.key.toLowerCase() === 'j'")
    expect(source).toContain("from '../../../../_shared/record-frame/RecordFrame'")
  })

  it('one notice in the body column, never above the thread', () => {
    const html = draw('w2a-held-notice')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    expect(html.indexOf('class="fw-rcf-notices"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="fw-rcf-notices"')).toBeLessThan(dockAt)
    expect(dockOf(html)).not.toContain('fw-rcf-notices')
  })

  it('without threads.read there is no thread here: no dock, no Thread button', () => {
    const html = draw('thread-no-right')
    expect(html).not.toContain('class="fw-rcf-dock"')
    expect(html).not.toContain('aria-label="Thread tools"')
  })

  it('the order’s thread is picked beside the work order’s notes, says whose it is, and is that customer’s alone', () => {
    const html = draw('thread-order')
    const dock = textOf(dockOf(html))
    expect(dock).toContain('Work order notes')
    expect(dock).toContain(`${WO.orders[0]!.number} · ${WO.orders[0]!.partyName}`)
    expect(dock).toContain(`is shared with ${WO.orders[0]!.partyName}`)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    // Not offered when the route says the order's thread may not be read; nothing to pick without an order.
    expect(textOf(dockOf(draw('thread-no-order-thread')))).not.toContain('Work order notes')
    expect(textOf(dockOf(draw('order-files-none')))).not.toContain('Which thread')
  })

  it('the container mounts the work order’s own thread with no party, an order’s with its customer, keyed apart; the old dock hook is gone', () => {
    const container = readFileSync(new URL('./WorkOrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread key="work-order" docked record=\{own\}[^>]*party=\{null\}/)
    expect(container).toMatch(/record=\{\{ type: 'SalesOrder', id: pickedOrder\.orderId/)
    expect(container).toContain('party={pickedOrder.party}')
    expect(container).toContain("session.permissions.includes('threads.read')")
    expect(container).not.toContain('useThreadDock')
    expect(container).not.toMatch(/tab === 'activity'/)
    const hooks = readFileSync(new URL('../../_shared/hooks.ts', import.meta.url), 'utf8')
    expect(hooks).not.toContain('export function useThreadDock')
    const viewSource = readFileSync(new URL('./view/WorkOrderRecordView.tsx', import.meta.url), 'utf8')
    expect(viewSource).not.toContain('RecordPanelsView')
  })
})

describe('B-TH-265 — Order files (agreement T9: their route only)', () => {
  it('counts what the reader may open; draws no button for a work order of no order; says left-out parts as counts', () => {
    const read = orderFilesOf(WO)
    expect(orderFilesCount({ state: 'ready', read })).toBe(4)
    expect(orderFilesCount({ state: 'loading' })).toBeNull()
    expect(hasOrderFiles({ state: 'ready', read })).toBe(true)
    expect(hasOrderFiles({ state: 'ready', read: orderFilesOf(WO, []) })).toBe(false)
    expect(hasOrderFiles({ state: 'ready', read: orderFilesOf(WO, [], 1) })).toBe(true)
    expect(hasOrderFiles({ state: 'error', problem: 'error.offline' })).toBe(true)
    expect(leftOutOf({ filesLeftOut: 2, measurementsLeftOut: 1 })).toEqual([
      { key: 'orderFiles.filesLeftOut', count: 2 },
      { key: 'orderFiles.measurementsLeftOut', count: 1 },
    ])
    expect(leftOutOf({ filesLeftOut: 0, measurementsLeftOut: 0 })).toEqual([])
  })

  it('offers an order’s thread only where the route says it may be read, with the order’s own customer; a gone pick falls back', () => {
    const ready = { state: 'ready' as const, read: orderFilesOf(WO) }
    // F-PR-25: each choice also carries the customer's PO (the band's menu names it first) and the order's own company (the thread's scope).
    expect(threadChoices(WO.orders, ready)).toEqual([{ orderId: WO.orders[0]!.id, number: WO.orders[0]!.number, party: { id: WO.orders[0]!.partyId, name: WO.orders[0]!.partyName }, customerRef: WO.orders[0]!.customerRef, companyId: WO.companyId }])
    expect(threadChoices(WO.orders, { state: 'ready', read: orderFilesOf(WO, [orderGroup(WO, { thread: null })]) })).toEqual([])
    expect(threadChoices([], ready)).toEqual([])
    expect(threadChoices(WO.orders, { state: 'loading' })).toEqual([])
    expect(pickOf(WO.orders[0]!.id, threadChoices(WO.orders, ready))).toBe(WO.orders[0]!.id)
    expect(pickOf('another-order', threadChoices(WO.orders, ready))).toBe('workOrder')
  })

  it('the band says "Order files (4)"; the dialog lists the order’s files, the worksheet and the thread door', () => {
    expect(textOf(draw('thread-docked'))).toContain('Order files (4)')
    expect(textOf(draw('thread-docked', 'it'))).toContain("File dell'ordine (4)")
    expect(textOf(draw('order-files-none'))).not.toContain('Order files')
    const text = body(filesReady(orderFilesOf(WO), { open: true }))
    expect(text).toContain(WO.orders[0]!.number)
    expect(text).toContain(`Conferma ordine ${WO.orders[0]!.number}.pdf`)
    expect(text).toContain('Line 2 · from the quote')
    expect(text).toContain('Measurement worksheet · line 3')
    expect(text).toContain("Open the order's thread")
    // No thread door where the order's thread may not be read.
    expect(body(filesReady(orderFilesOf(WO, [orderGroup(WO, { thread: null })])))).not.toContain("Open the order's thread")
  })

  it('what is left out is said in words as counts, never named', () => {
    expect(leftOut(WO).ordersLeftOut).toBe(1)
    const text = body(filesReady(leftOut(WO)))
    expect(text).toContain('2 files you cannot open')
    // F-PR-25: the lock line in the row's words, counted, never dropped.
    expect(text).toContain('Measurement sheet: opens with the measurements right (1)')
    expect(text).toContain('1 more order whose files you cannot see')
    expect(body(filesReady(leftOut(WO)), 'it')).toContain('2 file che non puoi aprire')
  })

  it('a refused opening and a failed read are said in words (Try again)', () => {
    expect(body(filesReady(orderFilesOf(WO), { problem: 'orderFiles.gone' }))).toContain('This file is no longer there')
    const failed = body({ files: { state: 'error', problem: 'error.offline' }, open: true, opening: null, problem: null })
    expect(failed).toContain("Couldn't read the order files")
    expect(failed).toContain('Try again')
  })

  it('files open ONLY through the work order’s own route (POST …/order-files/:fileId/open), never the generic /files preview', () => {
    const api = readFileSync(new URL('./order-files/api.ts', import.meta.url), 'utf8')
    expect(api).toContain('/production/work-orders/${encodeURIComponent(workOrderId)}/order-files')
    expect(api).toMatch(/\$\{path\(workOrderId\)\}\/\$\{encodeURIComponent\(fileId\)\}\/open/)
    const hook = readFileSync(new URL('./order-files/use-order-files.ts', import.meta.url), 'utf8')
    const dialog = readFileSync(new URL('./order-files/view/OrderFiles.tsx', import.meta.url), 'utf8')
    for (const source of [api, hook, dialog]) {
      expect(source).not.toMatch(/['`]\/files\//)
      expect(source).not.toContain('previewFile')
    }
    // A worksheet opens through the made-to-measure route (its opening recorded on the profile).
    expect(hook).toContain('openWorksheet(api, sheet.profileId, sheet.documentId)')
  })

  it('"Open the order\u2019s thread" picks that order in the dock and shows the thread through the frame (docked: shown; narrower: full width)', () => {
    const dialog = readFileSync(new URL('./order-files/view/OrderFiles.tsx', import.meta.url), 'utf8')
    expect(dialog).toMatch(/actions\?\.onThread\?\.\(orderId\)\s*frame\?\.showThread\?\.\(\)/)
    const frame = readFileSync(new URL('../../../_shared/record-frame/RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('readonly showThread?: () => void')
    expect(frame).toMatch(/if \(mode === 'docked'\) sizes\.show\(\)\s*else if \(!viewOpen\) openView\(\)/)
  })
})
