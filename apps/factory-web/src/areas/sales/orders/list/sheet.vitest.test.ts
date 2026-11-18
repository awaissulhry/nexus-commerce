import { readFileSync } from 'node:fs' // F-SA-221
import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { exportMenuItems } from '../../../../list-frame/tools/ListToolsBar'
import { exportColumnsOf } from '../../../../list-frame/tools/model'
import { selectedExportRequest } from '../../../../list-frame/w2b/bulk'
import { forRole, LIST_ROWS, canOf } from '../_demo/fixtures'
import type { OrderRow } from '../api'
import { brandFromAddress, companyFromAddress, extraFromAddress /* F-SA-216 */, listAddress, rowsQuery, viewCount } from '../model'
import { BOARD } from '../_demo/fixtures'
import { brandCell, customerDoor, depositDoor, exportAbout, invoicedCell, invoicedDoor, linesDoor, NAMESPACE, orderDoor, quoteDoor, shippedDoor } from './sheet/model'
// F-SA-221: made-to-measure in the sheet.
import { abilitiesOf, boardNarrowOf, boardRereadOf, doorAddress, kindFromAddress, laneQuery, listTouches } from '../model'
import { builtInActive, MTM_VIEW, mtmText, ridersText } from './view/OrdersListView'

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
      // Margin % on screen is not written to the file: the menu says so.
      expect(exportAbout(t, { customer: null, view: 'Open', count: 3, price: true, formats: ['CSV'], margin: true }).note).toBe(`${t('export.note')} ${t('export.noteMargin')}`)
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

// ---- F-SA-216 (sales page plan P15, P25): one meaning per word -------------------------------------------------------------------
describe('one meaning per word: the list rule is "Close to promise", the office\'s top priority "Top"', () => {
  const depth = (locale: (typeof LOCALES)[number]) => createTranslator(locale, messagesFor(locale, ['sales-orders-depth'])['sales-orders-depth']!)
  it('the ORDER_LATE_RISK rule reads "Close to promise" in its column, chip, filter, cell and total ("At risk / Late" is order health)', () => {
    const en = tFor('en')
    const it = tFor('it')
    expect(en('col.atRisk')).toBe('Close to promise')
    expect(en('chips.atRisk')).toBe('Close to promise')
    expect(en('atRisk.filter')).toBe('Show only the orders close to their promise')
    expect(en('atRisk.days', { count: 2 })).toBe('Close to promise · 2 days left')
    expect(en('totals.atRisk', { n: 4 })).toBe('Close to promise 4')
    expect(it('col.atRisk')).toBe('Vicino alla data promessa')
    expect(it('atRisk.days', { count: 1 })).toBe('Vicino alla data promessa · manca 1 giorno')
    for (const locale of LOCALES) {
      const t = tFor(locale)
      for (const key of ['col.atRisk', 'chips.atRisk', 'atRisk.filter', 'totals.atRisk']) expect(t(key, { n: 1 }), `${locale} ${key}`).not.toMatch(/At risk|A rischio/i)
    }
  })
  it('the office\'s top priority level reads "Top" / "Massima"; its value stays URGENT (old links and saved views keep working)', () => {
    expect(depth('en')('priority.level.URGENT')).toBe('Top')
    expect(depth('it')('priority.level.URGENT')).toBe('Massima')
    for (const locale of LOCALES) for (const key of ['priority.level.URGENT', 'priority.titleOne', 'priority.reason', 'priority.problem.reason']) expect(depth(locale)(key), `${locale} ${key}`).not.toMatch(/urgen/i)
    // The address term of the rule is unchanged: an old link with atRisk=true still narrows the sheet.
    expect(extraFromAddress(new URLSearchParams('atRisk=true'), 'open')).toEqual({ atRisk: true })
  })
})
// ---- end F-SA-216

// ---- F-SA-221 (sales page plan N7, pick P12; 12-lists-board §4.1–§4.3): made-to-measure in the Orders sheet ---------------------------
describe('made-to-measure in the sheet: the term in the address and every read, the chip, the mark that narrows, the riders by right (F-SA-221)', () => {
  const mtm = { units: 3, waitingReview: 1, riders: { names: ['Rider A', 'Rider B'], count: 4 } }

  it('kind=mtm is read from the address, written back, and sent with the list, each lane, the board\'s counts and a total\'s door', () => {
    expect(kindFromAddress(new URLSearchParams('kind=mtm'))).toBe('mtm')
    expect(kindFromAddress(new URLSearchParams('kind=MTM'))).toBeNull()
    expect(kindFromAddress(new URLSearchParams(''))).toBeNull()
    expect(listAddress('/p', { rows: 'open', q: '', layout: 'list', kind: 'mtm' })).toBe('/p?kind=mtm')
    expect(listAddress('/p', { rows: 'late', q: '', layout: 'board', kind: 'mtm' })).toBe('/p?view=board&late=true&kind=mtm')
    expect(rowsQuery('open', '', null, null, { kind: 'mtm' })).toMatchObject({ open: true, kind: 'mtm' })
    expect(laneQuery('PENDING_APPROVAL', 'open', '', null, { kind: 'mtm' })).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'mtm' })
    expect(boardNarrowOf({ kind: 'mtm' })).toMatchObject({ kind: 'mtm' })
    expect(rowsQuery('open', '')).not.toHaveProperty('kind')
    expect(doorAddress('/p', { open: 'true', kind: 'mtm' })).toBe('/p?kind=mtm')
  })

  it('the mark says the units and the factory review, never a rider; Riders names them only as the API gave them', () => {
    const en = tFor('en')
    expect(mtmText({ madeToMeasure: mtm }, en)).toBe('Made to measure · 3 units · 1 waiting for review')
    expect(mtmText({ madeToMeasure: { ...mtm, waitingReview: 0, units: 1 } }, en)).toBe('Made to measure · 1 unit')
    expect(mtmText({ madeToMeasure: null }, en)).toBe('')
    expect(mtmText({ madeToMeasure: mtm }, en)).not.toContain('Rider')
    expect(ridersText({ madeToMeasure: mtm })).toBe('Rider A, Rider B +2')
    expect(ridersText({ madeToMeasure: { ...mtm, riders: null } })).toBe('')
    for (const locale of LOCALES) {
      const t = tFor(locale)
      for (const key of ['mtm.mark', 'mtm.filter', 'col.riders', 'views.mtm', 'empty.mtmNoRight']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('mtm.units', { count: 2 }), locale).toContain('2')
      expect(t('mtm.waitingReview', { count: 2 }), locale).toContain('2')
    }
    // R9: the Italian review is the catalogue's "controllo" ("revisione" is a measurement's revision there).
    expect(tFor('it')('mtm.waitingReview', { count: 2 })).toBe('· 2 da controllare')
  })

  it('the chip "Made to measure" with ✕ on Sales › Orders, fixed where the page holds it; Clear all keeps a fixed chip', () => {
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("label: s('mtm.mark'), onClear: model.locked?.kind ? null : () => actions?.onKind?.(null)")
    const parts = readFileSync(new URL('./sheet/parts.tsx', import.meta.url), 'utf8')
    expect(parts).toContain('const removable = chips.filter((chip) => chip.onClear)')
    expect(parts).toContain('removable.length > 1')
  })

  it('the mark under the number is a funnel door to the made-to-measure orders; the Riders column is only for a reader of measurements', () => {
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("<MtmMark row={data} s={s} onNarrow={latest.current.model.kind ? undefined : () => act()?.onKind?.('mtm')} />")
    expect(view).toContain("...(can.measurements ? [{ ...later({ colId: 'riders'")
    expect(view).toContain("colId: 'madeToMeasure'")
    // The built-in view "Made-to-measure" = kind=mtm with the open orders; it is the active one then.
    expect(builtInActive({ rows: 'open', kind: 'mtm' })).toBe(MTM_VIEW)
    expect(builtInActive({ rows: 'late', kind: 'mtm' })).toBe('late')
    expect(builtInActive({ rows: 'open', kind: null })).toBe('open')
    expect(MTM_VIEW).toBe('kind:mtm')
  })

  it('live: a rider profile\'s event counts as an update of the list and re-reads the waiting lane only', () => {
    expect(listTouches({ type: 'measurement_profile.reviewed' })).toBe(true)
    expect(listTouches({ type: 'measurement_profile.recorded' })).toBe(true)
    const lanes = [{ status: 'PENDING_APPROVAL' as const, items: [] }, { status: 'CONFIRMED' as const, items: [] }]
    expect(boardRereadOf({ type: 'measurement_profile.reviewed', fields: { profileId: 'p1' } }, lanes)).toEqual(['PENDING_APPROVAL'])
  })

  it('the abilities say who reads riders (sales.measurements.view)', () => {
    expect(abilitiesOf(['orders.view']).measurements).toBe(false)
    expect(abilitiesOf(['orders.view', 'sales.measurements.view']).measurements).toBe(true)
  })
})
// ---- end F-SA-221

// ---- F-SA-280 (sales page plan N5, picks P10, P18; 11-customer-page §3.8): bulk on the sheet's own bar — Set priority for N,
// Assign supervisor…, Note to N… / Ask the supervisor, Export N — one customer only, checked before any window (the server again).
describe('F-SA-280: bulk on the Orders sheet\'s own bar', () => {
  it('the one-customer check: one customer passes; two are held with how many; on a locked page another customer\'s row is held', async () => {
    const { oneCustomerHeld } = await import('./sheet/model')
    const alpha = LIST_ROWS[0]!
    const beta = { ...LIST_ROWS[1]!, partyId: 'b0000000-0000-4000-8000-0000000000b2' }
    expect(oneCustomerHeld([alpha, { ...alpha, id: 'x' }], null)).toBeNull()
    expect(oneCustomerHeld([alpha, beta], null)).toEqual({ key: 'bulk.oneCustomer', params: { count: 2 } })
    expect(oneCustomerHeld([alpha], alpha.partyId)).toBeNull()
    expect(oneCustomerHeld([beta], alpha.partyId)).toEqual({ key: 'bulk.notThisCustomer' })
    expect(oneCustomerHeld([], null)).toBeNull()
  })
  it('the dialogs get the ticked orders as production\'s own targets (each order\'s own thread; no work order asked about)', async () => {
    const { noteTargetsOf, supervisorTargetsOf } = await import('./sheet/model')
    const alpha = LIST_ROWS[0]!
    expect(supervisorTargetsOf([alpha])).toEqual([{ orderId: alpha.id, number: alpha.number, customerRef: alpha.customerRef, partyId: alpha.partyId, partyName: alpha.partyName, companyId: alpha.companyId }])
    expect(noteTargetsOf([alpha])).toEqual({ workOrders: [], salesOrders: [{ type: 'SalesOrder', id: alpha.id, label: alpha.number, partyId: alpha.partyId, partyName: alpha.partyName, companyId: alpha.companyId }], withoutOrder: 0 })
    // The note dialog opens on the orders' own threads when no work order is among the records, and asks nothing about them.
    const hook = readFileSync(new URL('../../../production/_shared/notes/use-note-dialog.ts', import.meta.url), 'utf8')
    expect(hook).toContain("const wanted: WriteOn = targets.workOrders.length === 0 ? 'salesOrders' : on")
    const dialog = readFileSync(new URL('../../../production/_shared/notes/view/NoteDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain('model.targets.workOrders.length > 0 && (model.targets.salesOrders.length > 0')
  })
  it('the limits are the dialogs\' own (assign 100, note 100, priority 200) and every hold is said in words before the click', async () => {
    const { ASSIGN_MAX, assignHeld } = await import('../../../_shared/production-supervisor/model')
    const { NOTE_RECORDS_MAX, openHeld } = await import('../../../production/_shared/notes/model')
    expect(ASSIGN_MAX).toBe(100)
    expect(NOTE_RECORDS_MAX).toBe(100)
    expect(assignHeld({ manage: false }, { targets: [], leftOut: 0 })).toEqual({ key: 'held.noRight' })
    expect(openHeld(true, 101)).toMatchObject({ key: 'held.tooMany' })
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('heldReason={assignWords}')
    expect(view).toContain('heldReason={noteWords}')
    expect(view).toContain('held={oneCustomerWords /* F-SA-280 */}')
    expect(view).toContain('<AssignSupervisorDialog model={model.assign} actions={actions?.supervisor} />')
    expect(view).toContain('<NoteDialog model={model.note} actions={actions?.note} />')
    // Export N stays the export job with the picked ids (never held by the customer check: a file of the list).
    expect(view).toContain('exportSelected: true')
  })
  it('the words in both languages (no key left)', () => {
    for (const locale of LOCALES) {
      const t = tFor(locale)
      for (const key of ['bulk.assign', 'bulk.notThisCustomer']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('bulk.note', { count: 2 }), locale).toContain('2')
      expect(t('bulk.oneCustomer', { count: 2 }), locale).toContain('2')
    }
    expect(tFor('it')('bulk.assign')).toBe('Assegna supervisore…')
  })
})
// ---- end F-SA-280

// ---- F-SA-281 (sales page plan N5, pick P10; 11-customer-page §3.9; the API's B-SA-071): Add task to N — the one New task window in
// an N-records mode (Assign to each order's supervisor by default, or one person), one batch, its receipt; + the row's ⋯ Add task….
describe('F-SA-281: Add task to N', () => {
  it('the due day starts on the next working day (a Friday goes to Monday)', async () => {
    const { nextWorkingDay } = await import('../../../../record-panels/tasks/model')
    expect(nextWorkingDay('2026-11-18')).toBe('2026-11-19')
    expect(nextWorkingDay('2026-11-20')).toBe('2026-11-23')
    expect(nextWorkingDay('2026-11-21')).toBe('2026-11-23')
  })
  it('the check line names the orders without a supervisor (only when "Each order\'s supervisor" is the choice); unknown is never guessed', async () => {
    const { withoutSupervisor } = await import('../../../../record-panels/tasks/model')
    const records = [
      { type: 'SalesOrder', id: 'a', label: 'SO-1', supervisor: true },
      { type: 'SalesOrder', id: 'b', label: 'SO-2', supervisor: false },
      { type: 'SalesOrder', id: 'c', label: 'SO-3', supervisor: null },
    ]
    expect(withoutSupervisor(records).map((record) => record.label)).toEqual(['SO-2'])
  })
  it('held before Send: no record, more than BATCH_MAX, no title; the body names SUPERVISOR or one person', async () => {
    const { BATCH_MAX, batchBody, batchHeld } = await import('../../../../record-panels/tasks/model')
    const one = [{ type: 'SalesOrder', id: 'a', label: 'SO-1', supervisor: true }]
    expect(BATCH_MAX).toBe(100)
    expect(batchHeld({ title: 'Call', description: '' }, { kind: 'SUPERVISOR' }, [])).toEqual({ key: 'batch.held.none' })
    expect(batchHeld({ title: 'Call', description: '' }, { kind: 'SUPERVISOR' }, Array.from({ length: 101 }, (_, index) => ({ ...one[0]!, id: String(index) })))).toMatchObject({ key: 'batch.held.tooMany' })
    expect(batchHeld({ title: '  ', description: '' }, { kind: 'SUPERVISOR' }, one)).toEqual({ key: 'tasks.new.held.title' })
    expect(batchHeld({ title: 'Call', description: '' }, { kind: 'SUPERVISOR' }, one)).toBeNull()
    expect(batchBody({ title: ' Call  the tannery ', description: '', dueDate: '2026-11-19' }, { kind: 'SUPERVISOR' }, one)).toEqual({ title: 'Call the tannery', records: [{ type: 'SalesOrder', id: 'a' }], assignee: 'SUPERVISOR', description: null, dueDate: '2026-11-19' })
    expect(batchBody({ title: 'Call', description: 'Note', dueDate: '' }, { kind: 'PERSON', userId: 'u1' }, one)).toMatchObject({ assignee: { userId: 'u1' }, description: 'Note', dueDate: null })
  })
  it('the receipt: made, left out, each left out with its label (when the maker reads it) and the API\'s words in the page\'s language', async () => {
    const { batchReceipt } = await import('../../../../record-panels/tasks/model')
    const answer = { batchId: 'b', made: [{}, {}, {}, {}] as never, skipped: [{ record: { type: 'SalesOrder', id: 'x' }, label: 'SO-0150', code: 'CANNOT_OPEN' as const, words: { it: 'Persona A non può aprirlo.', en: 'Person A cannot open it.' } }] }
    expect(batchReceipt(answer, 'en')).toEqual({ made: 4, left: 1, lines: ['SO-0150: Person A cannot open it.'] })
    const words = createTranslator('en', messagesFor('en', ['home-tasks'])['home-tasks']!)
    expect(words('batch.receipt', { made: 4, left: 1 })).toBe('4 tasks made · 1 left out')
  })
  it('the sheet offers it on the bar (one customer, the tasks\' right) and on a row\'s ⋯ (one order: POST /tasks); one batch: POST /tasks/batch', () => {
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("actions.onAddTask?.(picked.map((row) => row.id), 'selection')")
    expect(view).toContain("act()?.onAddTask?.([data.id], 'row')")
    expect(view).toContain('heldReason={taskWords}')
    const hook = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(hook).toContain("readTaskPeople(many ? { type: 'Party', id: rows[0]!.partyId } : { type: 'SalesOrder', id: rows[0]!.id })")
    const api = readFileSync(new URL('../../../../record-panels/tasks/api.ts', import.meta.url), 'utf8')
    expect(api).toContain("api.post('/tasks/batch'")
  })
  it('every word in both languages (no key left)', () => {
    for (const locale of LOCALES) {
      const h = createTranslator(locale, messagesFor(locale, ['home-tasks'])['home-tasks']!)
      for (const key of ['batch.assignee', 'batch.assigneeHint', 'batch.supervisor', 'batch.dueHint', 'batch.note', 'batch.where', 'batch.close', 'batch.held.none', 'batch.held.assignee']) expect(h(key), `${locale} ${key}`).not.toBe(key)
      for (const key of ['batch.title', 'batch.noSupervisor', 'batch.send', 'batch.made', 'batch.more']) expect(h(key, { count: 2 }), `${locale} ${key}`).toContain('2')
      expect(tFor(locale)('bulk.addTask', { count: 3 }), locale).toContain('3')
    }
    expect(createTranslator('it', messagesFor('it', ['home-tasks'])['home-tasks']!)('batch.supervisor')).toBe('Il supervisore di ogni ordine')
  })
})
// ---- end F-SA-281
