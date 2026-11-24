import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { applyLayout, layoutOfPreferences, preferenceColumnsOf, preferencesOf, toolColumnsOf } from '../../../../list-frame/tools/model'
import { memoryStore, memoryTransport, type MemoryToolsModel } from '../../../_shared/list-tools/memory'
import type { OrderRow } from '../../orders/api'
import { ORDERS_LIST_KEY } from '../../orders/list/use-orders-sheet'
import { orderedByPreset, withPreset } from '../../orders/list/view/OrdersListView'
import { MONEY_PRESET, WAITING_SET, WORK_SETS, workLaterOf, workPreset, workRoomOf, type WorkRoom } from './view/WorkTab'
import { WORK_LAYOUT_KEY, workLayoutTransport } from './work-layout'

/**
 * F-CW-103 (customer Work tab; lead settles S11, S12; 13-backend §8; review A1 (b), A1-B1, A1-B2) — wide by the ROOM, Customise
 * tells the truth, the tab keeps its own browser layout. The Work tab measures its own root and hands the sheet the set for that
 * room (no record-frame change); the preset says each column's truth to the list frame's Customise (no list-frame change); the
 * sheet's working layout lives under the Work tab's own key, so a layout made on Sales › Orders never moves it.
 */

const en = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
const label = (column: string, room: 'wider') => en(`customise.${room}`, { column })

/** The sheet's columns as it builds them before a host's preset: the built-in ones shown, the later ones opt-in. */
const later = (colId: string, headerName: string): ColDef<OrderRow> => ({ colId, headerName, hide: true, context: { optIn: true } })
const SHEET: ColDef<OrderRow>[] = [
  { colId: 'picture', headerName: 'Picture' },
  { colId: 'number', headerName: 'Number', context: { exportWith: [{ key: 'customerRef', label: 'Customer PO' }] } },
  { colId: 'brand', headerName: 'Brand' },
  { colId: 'status', headerName: 'Status' },
  later('whereItIs', 'Where it is'),
  { colId: 'newMessages', headerName: 'New messages' },
  { colId: 'deposit', headerName: 'Deposit' },
  { colId: 'units', headerName: 'Pieces' },
  { colId: 'orderDate', headerName: 'Ordered', hide: true },
  { colId: 'promised', headerName: 'Promised' },
  later('waitingOn', 'Waiting on'),
  { colId: 'shipped', headerName: 'Shipped' },
  { colId: 'priority', headerName: 'Priority', hide: true },
  later('supervisor', 'Supervisor'),
  later('customerUrgency', 'Customer urgency'),
  { colId: 'more', headerName: 'More', pinned: 'right' },
]
const sheetFor = (room: WorkRoom, waiting: 'us' | null = null): ColDef<OrderRow>[] => {
  const preset = workPreset(waiting ? 'open' : 'all', waiting, false, room)
  return orderedByPreset(SHEET.map((column) => withPreset(column, preset, room === 'widest', label)), preset)
}
const onScreen = (columns: readonly ColDef<OrderRow>[]) => columns.filter((column) => !column.hide).map((column) => column.colId)
const ticked = (columns: readonly ColDef<OrderRow>[]) => preferencesOf(toolColumnsOf(columns as readonly ColDef<unknown>[]), undefined).visibleColumns
const labels = (columns: readonly ColDef<OrderRow>[]) => Object.fromEntries(preferenceColumnsOf(toolColumnsOf(columns as readonly ColDef<unknown>[])).map((column) => [column.key, column.label]))

describe('F-CW-103: wide by the room the tab really has (S11)', () => {
  it('closing the thread adds columns: 6 beside the thread at 1440, 8 at 1920, 9 with it closed at 1440, 13 at 1920', () => {
    expect([865, 1185, 1314, 1794].map((width) => onScreen(sheetFor(workRoomOf(width))).filter((id) => id !== 'more').length)).toEqual([6, 8, 9, 13])
    expect(onScreen(sheetFor('base'))).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'newMessages', 'more'])
    expect(onScreen(sheetFor('wide'))).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'waitingOn', 'deposit', 'newMessages', 'more'])
    expect(onScreen(sheetFor('wider'))).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'waitingOn', 'deposit', 'shipped', 'newMessages', 'more'])
    expect(onScreen(sheetFor('widest'))).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'priority', 'waitingOn', 'deposit', 'units', 'shipped', 'orderDate', 'supervisor', 'newMessages', 'more'])
    // Waiting on us / Late beside the thread: Waiting on in the place of Customer urgency and New messages.
    expect(onScreen(sheetFor('base', 'us'))).toEqual(['picture', 'number', 'whereItIs', 'promised', 'waitingOn', 'more'])
  })

  it('the tab measures its OWN root and hands the sheet its room — never the window, no change in the record frame', () => {
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('const measure = () => setJoined(workJoinedOf(node.getBoundingClientRect().width))') // cw fx8: how many columns the room holds
    expect(tab).toContain('const observer = new ResizeObserver(measure)')
    expect(tab).toContain('<div className="fw-cw" ref={workRoom.ref')
    expect(tab).toContain("workRoom.room === 'widest',")
    expect(tab).toContain('workRoom.joined /* F-CW-103; cw fx8: the columns join one at a time */),')
    // The tab's hook asks no window (no media query, no viewport width); the frame's own width state is not read or written.
    const hook = tab.slice(tab.indexOf('export function useWorkRoom'), tab.indexOf('// ---- end F-CW-103'))
    expect(hook).not.toMatch(/matchMedia|innerWidth|min-width/)
    expect(tab).not.toMatch(/sizes\.|setWidth\(|defaultWidth/)
    // The dock's default width on Work stays the record's own line (never touched here).
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("defaultWidth={tab === 'work' || tab === 'quotes' || tab === 'overview' || tab === 'money' || tab === 'people' || tab === 'terms' ? 'third' : undefined}") // F-CQ-301: Quotes & incoming a third too; F-CO-103 (S13): the Overview a third too; F-CM-104 (D2): Money a third too; F-CA-119 (D2): People a third too; F-CT-406 (D3): Terms a third too — Portal stays 40 %
  })
})

describe('F-CW-103: Customise tells the truth for the Work tab\'s set (S12; A1-B1)', () => {
  it('what is on screen is ticked; the tab\'s wider columns are ticked and named so; every other column is offered unticked', () => {
    const base = sheetFor('base')
    expect(ticked(base)).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'priority', 'waitingOn', 'deposit', 'units', 'shipped', 'orderDate', 'supervisor', 'newMessages', 'more'])
    // Before: Where it is and Waiting on were unticked while on screen, Brand and Status ticked while never shown.
    expect(ticked(base)).not.toContain('brand')
    expect(ticked(base)).not.toContain('status')
    expect(labels(base)).toMatchObject({
      whereItIs: 'Where it is',
      waitingOn: 'Waiting on · from a wider sheet',
      deposit: 'Deposit · from a wider sheet',
      shipped: 'Shipped · from a wider sheet',
      // cw fx8: one wording — every column that waits says "from a wider sheet" (they join one at a time).
      priority: 'Priority · from a wider sheet',
      units: 'Pieces · from a wider sheet',
      orderDate: 'Ordered · from a wider sheet',
      supervisor: 'Supervisor · from a wider sheet',
      status: 'Status',
    })
    // In a wider room a column that is on screen loses the note; the widest room has none left.
    expect(labels(sheetFor('wide'))).toMatchObject({ waitingOn: 'Waiting on', deposit: 'Deposit', shipped: 'Shipped · from a wider sheet', supervisor: 'Supervisor · from a wider sheet' })
    expect(Object.values(labels(sheetFor('widest'))).filter((text) => String(text).includes('·'))).toEqual([])
    expect(ticked(sheetFor('widest'))).toEqual(ticked(base)) // the same set at every room: the room only decides what fits now
  })

  it('the preset says each column\'s truth to the list frame: on screen or waiting → not opt-in; anything else → opt-in (no list-frame change)', () => {
    const preset = workPreset('all', null)
    const facts = (colId: string, column: Partial<ColDef<OrderRow>> = {}) => {
      const out = withPreset({ colId, headerName: colId, ...column }, preset, false, label)
      return { hide: out.hide, optIn: (out.context as { optIn?: boolean }).optIn, toolLabel: (out.context as { toolLabel?: string }).toolLabel }
    }
    expect(facts('whereItIs', { hide: true, context: { optIn: true } })).toEqual({ hide: false, optIn: false, toolLabel: undefined })
    expect(facts('waitingOn', { hide: true, context: { optIn: true } })).toEqual({ hide: true, optIn: false, toolLabel: 'waitingOn · from a wider sheet' })
    expect(facts('supervisor')).toEqual({ hide: true, optIn: false, toolLabel: 'supervisor · from a wider sheet' })
    expect(facts('brand')).toEqual({ hide: true, optIn: true, toolLabel: undefined })
    expect(facts('status')).toEqual({ hide: true, optIn: true, toolLabel: undefined })
    // What the column carried stays (the export's second fact, a Customise heading).
    const kept = withPreset({ colId: 'number', headerName: 'Number', context: { exportWith: [{ key: 'customerRef', label: 'Customer PO' }] } }, preset, false)
    expect(kept.context).toMatchObject({ optIn: false, exportWith: [{ key: 'customerRef', label: 'Customer PO' }] })
    // ⋯ is never governed; without a preset (Sales › Orders, Made to measure) a column is returned as it is.
    expect(withPreset({ colId: 'more', context: { x: 1 } }, preset, false).context).toEqual({ x: 1 })
    const own = { colId: 'whereItIs', hide: true, context: { optIn: true } }
    expect(withPreset(own, null, false)).toBe(own)
    // The rooms each waiting column names (the tab's own table).
    // cw fx8: one wording — every column that waits says "from a wider sheet" (they join one at a time).
    expect(workLaterOf(WORK_SETS.base)).toEqual({ waitingOn: 'wider', deposit: 'wider', shipped: 'wider', priority: 'wider', units: 'wider', orderDate: 'wider', supervisor: 'wider' })
    expect(workLaterOf(WORK_SETS.wider)).toEqual({ priority: 'wider', units: 'wider', orderDate: 'wider', supervisor: 'wider' })
    expect(workLaterOf(WORK_SETS.widest)).toEqual({})
    expect(workLaterOf(WAITING_SET)).toMatchObject({ customerUrgency: 'wider', newMessages: 'wider' })
    expect(MONEY_PRESET.later).toEqual({ picture: 'wider', promised: 'wider', paid: 'wider' }) // F-CW-104: they return from the `wide` room
    const frame = readFileSync(new URL('../../../../list-frame/tools/model.ts', import.meta.url), 'utf8')
    expect(frame).toContain("export const isOptIn = (column: ColDef<unknown>): boolean => contextOf(column).optIn === true")
  })

  it('a person\'s Customise wins: untick a column and it goes; tick Status and it shows; a column that waits is never cut to fit', () => {
    const base = sheetFor('base')
    const tools = toolColumnsOf(base as readonly ColDef<unknown>[])
    const now = preferencesOf(tools, undefined)
    // Untick Promised.
    const without = layoutOfPreferences(tools, { ...now, visibleColumns: now.visibleColumns.filter((id) => id !== 'promised') })
    expect(onScreen(applyLayout(base, without))).toEqual(['picture', 'number', 'whereItIs', 'customerUrgency', 'newMessages', 'more'])
    // Tick Status (offered unticked): it shows; the columns that wait for a wider sheet stay off this narrow one.
    const withStatus = layoutOfPreferences(tools, { ...now, visibleColumns: [...now.visibleColumns, 'status'] })
    const shown = onScreen(applyLayout(base, withStatus))
    expect(shown).toContain('status')
    for (const id of ['waitingOn', 'deposit', 'shipped', 'priority', 'units', 'orderDate', 'supervisor']) expect(shown, id).not.toContain(id)
    // The same layout in the widest room: its columns are all there, Status with them.
    const wide = onScreen(applyLayout(sheetFor('widest'), withStatus))
    for (const id of [...WORK_SETS.widest, 'status']) expect(wide, id).toContain(id)
  })

  it('the words of the note in both languages', () => {
    for (const locale of LOCALES) {
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      expect(s('customise.wider', { column: 'X' }), locale).toMatch(/^X · /)
      expect(s('customise.widest', { column: 'X' }), locale).toBe('customise.widest') // cw fx8: the second wording is gone with the sets
    }
    const it_ = createTranslator('it', messagesFor('it', ['orders-sheet'])['orders-sheet']!)
    expect([en('customise.wider', { column: 'Deposit' }), en('customise.wider', { column: 'Pieces' })]).toEqual(['Deposit · from a wider sheet', 'Pieces · from a wider sheet'])
    expect([it_('customise.wider', { column: 'Acconto' }), it_('customise.wider', { column: 'Capi' })]).toEqual(['Acconto · da un foglio più largo', 'Capi · da un foglio più largo'])
  })
})

describe('F-CW-103: the Work tab keeps its own browser layout (S12; A1-B2)', () => {
  const MODEL: MemoryToolsModel = { pageKey: ORDERS_LIST_KEY, locale: 'en', answer: { views: [], roleDefaultId: null, personalDefaultId: null, roles: [], allRoles: [], can: { save: true, manage: false, export: true }, exports: { formats: ['XLSX', 'CSV'] } }, jobs: [] }
  const ORDERS_LAYOUT = { columns: { order: ['picture', 'number', 'customer', 'brand', 'status', 'deposit'], hidden: [], pinned: [] } }

  it('a layout made on Sales › Orders does not touch the Work tab, and the other way round', () => {
    const store = memoryStore(MODEL)
    const page = memoryTransport(MODEL, store, 'party=p1&rows=all', () => undefined)
    const work = workLayoutTransport(page, ORDERS_LIST_KEY)
    page.writeLayout(ORDERS_LIST_KEY, ORDERS_LAYOUT)
    // The Work tab reads its own (none yet): the Orders page's columns are not switched on here.
    expect(work.readLayout(ORDERS_LIST_KEY)).toBeNull()
    expect(page.readLayout(ORDERS_LIST_KEY)).toEqual(ORDERS_LAYOUT)
    // The Work tab's own layout: kept under its own key, the Orders page's untouched.
    const own = { columns: { order: [], hidden: ['promised'], pinned: [] } }
    work.writeLayout(ORDERS_LIST_KEY, own)
    expect(work.readLayout(ORDERS_LIST_KEY)).toEqual(own)
    expect(store.layouts.get(WORK_LAYOUT_KEY)).toEqual(own)
    expect(page.readLayout(ORDERS_LIST_KEY)).toEqual(ORDERS_LAYOUT)
    expect(WORK_LAYOUT_KEY).toBe('sales.orders:customer-work')
    // Columns as built again: only the Work tab's layout goes.
    work.writeLayout(ORDERS_LIST_KEY, null)
    expect(work.readLayout(ORDERS_LIST_KEY)).toBeNull()
    expect(page.readLayout(ORDERS_LIST_KEY)).toEqual(ORDERS_LAYOUT)
  })

  it('only the layout key is mapped: saved views, exports, Pin to Today, the custom fields and the address pass through (one list key, one file source)', () => {
    const store = memoryStore(MODEL)
    const page = memoryTransport(MODEL, store, 'party=p1&rows=all', () => undefined)
    const work = workLayoutTransport(page, ORDERS_LIST_KEY)
    for (const name of ['pageKey', 'query', 'linked', 'goTo', 'clearLinked', 'viewLink', 'locale', 'listViews', 'createView', 'updateView', 'removeView', 'setPersonalDefault', 'startExport', 'readExport', 'listExports', 'download', 'copy', 'newKey', 'bulkPreview', 'bulkApply', 'pins', 'fields'] as const) expect(work[name], name).toBe(page[name])
    expect(work.pageKey).toBe('sales.orders')
    // Another list's layout on the page is not the tab's to move.
    work.writeLayout('sales.quotes', ORDERS_LAYOUT)
    expect(page.readLayout('sales.quotes')).toEqual(ORDERS_LAYOUT)
    expect(store.layouts.has(WORK_LAYOUT_KEY)).toBe(false)
  })

  it('the tab wraps ONLY its sheet in it (no change in the list frame); Sales › Orders and Made to measure keep the page\'s own', () => {
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('<WorkLayoutTools listKey={ORDERS_LIST_KEY}>')
    const wrapper = readFileSync(new URL('./work-layout.tsx', import.meta.url), 'utf8')
    expect(wrapper).toContain("from '../../../../list-frame/tools/transport'")
    expect(wrapper).toContain('<ListToolsContext.Provider value={transport}>{children}</ListToolsContext.Provider>')
    for (const page of ['../../orders/list/OrdersPage.tsx', '../../mtm/MtmPage.tsx']) expect(readFileSync(new URL(page, import.meta.url), 'utf8'), page).not.toContain('WorkLayoutTools')
  })
})
