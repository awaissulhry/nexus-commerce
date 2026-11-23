import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import type { BrandRequest } from '../../../home/approvals/requests/api'
import type { RequestReviewModel } from '../../../home/approvals/requests/model'
import { requestsDoorOf, reviewNamed, workEntry } from '../../customers/record/use-customer-work'
import { WAITING_SET, WORK_MIN, WORK_PAD, WORK_PLAIN_HEADS, WORK_SETS, workEmptyOf, workPreset } from '../../customers/record/view/WorkTab'
import type { OrderRow, OrderStatus } from '../api'
import { SORT_CHOICES } from '../model'
import { manyHeld, noYesAsked, rowStepsOf } from './commands/model'
import { replyManyLabel } from './reply-many'
import { BAR_PROMOTED, BAR_PX, barOf, barPartPx, barPx, promotedFit, type BarCan, type BarPart, type BarRow } from './sheet/bar'
import { tailWhole } from './sheet/parts'
import { shipFirstOf, shipHeld, shipRowHeld, shipRowOffered, type ShipRow } from './sheet/ship'
import { urgencyHeld } from './sheet/urgency'
import { customerRefused } from './use-orders-sheet'
import { builtInActive, builtInViewsOf, DEPOSIT_FULL_FROM, depositExtraOf, depositRoomy, MTM_VIEW, oneStop, rowWidthOf, SEARCH_SHORT_BELOW, waitingColumnsOf, withPreset } from './view/OrdersListView'

/**
 * cw fx5 — the WALK FIX WAVE of the customer page's Work tab (design/customer-work-2026-11-22/30-walk.md, gaps W-1 … W-33; the
 * lead's decision per gap in build/briefs/cw-walkfix.md). One test per fix that can have one: the pure rules here, the drawn cells
 * in cells.vitest, the windows' own rules beside them. Made-up orders and customers only.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const words = (locale: (typeof LOCALES)[number], ns: string) => createTranslator(locale, messagesFor(locale, [ns])[ns]!)
const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'

// ============================================================ A. things that do not do what they say ============================================================

describe('walk W-1: "Requests to answer N" opens what it counts', () => {
  const request = (id: string, askedAt: string, over: Record<string, unknown> = {}): BrandRequest =>
    ({ id, askedAt, waitingOn: 'US', may: { accept: false, refuse: false, counter: false }, batchId: null, kind: 'CHANGE', party: { id: ALPHA }, ...over }) as unknown as BrandRequest

  it('the door lists EVERY request that waits on us, oldest first — also those this reader may not decide (S24: readable without the right)', () => {
    const list = requestsDoorOf([request('r2', '2026-11-21T10:00:00Z'), request('r1', '2026-11-20T10:00:00Z'), request('r3', '2026-11-22T10:00:00Z', { may: { accept: true, refuse: true, counter: true } })])
    expect(list.ids).toEqual(['r1', 'r2', 'r3'])
    expect(list.batches).toEqual([])
  })
  it('a request that waits on the customer (a counter-offer) is not the chip\'s and not the door\'s; a batch of two is ONE entry', () => {
    const list = requestsDoorOf([request('r1', '2026-11-20T10:00:00Z', { batchId: 'b1' }), request('r2', '2026-11-20T11:00:00Z', { batchId: 'b1' }), request('r3', '2026-11-19T10:00:00Z', { waitingOn: 'CUSTOMER' })])
    expect(list.ids).toEqual(['b1'])
    expect(list.batches).toEqual(['b1'])
    expect(requestsDoorOf([])).toEqual({ ids: [], batches: [] })
  })
  it('the tab hands that list to the review window (it walks "Request 1 of 2 · Next ›") and the chip is a door whenever the list has an entry', () => {
    const tab = read('../../customers/record/view/WorkTab.tsx')
    expect(tab).toContain('const list = useMemo(() => requestsDoorOf(requests?.items ?? []), [requests])')
    expect(tab).toContain('useRequestReviewDoor({ ids: list.ids, batches: list.batches, onChanged: work.reload })')
    expect(tab).toContain('requestsHref: firstRequest ? door.hrefOf(firstRequest) : null,')
  })
})

describe('walk W-21, W-10: an act or a door without its right is not drawn', () => {
  it('the row\'s "Confirm or refuse…" needs the right to decide a yes', () => {
    const row = { status: 'PENDING_APPROVAL' as OrderStatus, deposit: { state: 'NOT_NEEDED', dueDate: null } } as Pick<OrderRow, 'status' | 'deposit'>
    const can = { manage: false, close: false, makeWorkOrders: false }
    expect(rowStepsOf(row, can, false)).toEqual([])
    expect(rowStepsOf(row, can, true)).toEqual([{ command: 'confirm', held: null }])
    expect(rowStepsOf(row, can)).toEqual([{ command: 'confirm', held: null }]) // a caller that says nothing keeps the step (the order page's own menu)
  })
  it('"Replies waiting on us ›" is a door only for a reader who may open the page it leads to; the count stays', () => {
    const tab = read('../../customers/record/view/WorkTab.tsx')
    expect(tab).toMatch(/repliesHref: mayIncoming \? `\$\{prefix\}\/sales\/incoming\?tile=CUSTOMER_REPLIES&party=\$\{encodeURIComponent\(party\.id\)\}` : null,/)
    expect(tab).toContain('mayIncoming = false')
    expect(read('../../customers/record/CustomerRecord.tsx')).toMatch(/mayIncoming=\{session\.permissions\.includes\('sales\.inquiries\.view'\)/)
    // The page behind the door asks for exactly that right.
    expect(read('../../nav.ts')).toContain('sales.inquiries.view')
  })
})

describe('cl-walk W-14: a failed read never reads like a wall', () => {
  const error = (kind: ApiError['kind'], status: number) => new ApiError(kind, status, kind, 'x', 'r')
  it('only a refused customer (not found, out of reach) is "not available"; 429, 5xx and the network are faults', () => {
    expect(customerRefused(error('not_found', 404))).toBe(true)
    expect(customerRefused(error('forbidden', 403))).toBe(true)
    for (const [kind, status] of [['rate_limited', 429], ['unavailable', 503], ['internal', 500], ['contract', 200]] as const) expect(customerRefused(error(kind, status)), kind).toBe(false)
    expect(customerRefused(new Error('offline'))).toBe(false)
    expect(customerRefused(null)).toBe(false)
  })
  it('the sheet says the wall only for a refusal, and on a customer\'s own page asks nothing for the name the page already holds', () => {
    const hook = read('./use-orders-sheet.ts')
    expect(hook).toContain("setLooked(customerRefused(error) ? { id: party, name: null } : null)")
    expect(hook).toContain('const hostNames = !!host.locked?.party && !!host.customerName')
    expect(hook).toMatch(/if \(!party \|\| hostNames \|\| nameInRows/)
    // The requests on entry: no switcher list on a page locked to one customer; the host's own board is not read a second time.
    expect(hook).toContain('const switcherShown = !host.locked?.party')
    expect(hook).toMatch(/const boardFromHost = host\.board !== undefined && !!host\.locked\?\.party && q === ''/)
    expect(hook).toContain('if (boardFromHost) return')
    const tab = read('../../customers/record/view/WorkTab.tsx')
    expect(tab).toContain('customerName: party.name')
    expect(tab).toMatch(/work\.reads\.board\.status === 'off' \? \{\} : \{ board:/)
    // The other two hosts give neither: they keep their own reads.
    for (const page of ['./OrdersPage.tsx', '../../mtm/MtmPage.tsx']) expect(read(page), page).not.toMatch(/customerName:|board: /)
  })
})

describe('walk W-11, W-17, W-29: a view is named by its own name and an empty door says its own sentence', () => {
  const t = (key: string) => key
  const s = (key: string) => key
  const model = { customer: { id: ALPHA, name: 'Seed Racing' }, locked: { party: true }, views: ['all', 'IN_PRODUCTION', 'late'], hostViews: null, viewCounts: null } as unknown as Parameters<typeof builtInViewsOf>[0]

  it('the view the address shows is always one of the items: `rows=open` and `rows=deposit` are named, never "Columns"', () => {
    expect(builtInViewsOf(model, t, s).map((view) => view.id)).toEqual(['all', 'IN_PRODUCTION', 'late'])
    expect(builtInViewsOf(model, t, s, String, 'open').map((view) => [view.id, view.label])).toEqual([['all', 'rows.all'], ['IN_PRODUCTION', 'rows.IN_PRODUCTION'], ['late', 'rows.late'], ['open', 'rows.open']])
    expect(builtInViewsOf(model, t, s, String, 'deposit').at(-1)).toEqual({ id: 'deposit', label: 'rows.deposit' })
    // A view the host already offers is not listed twice; no view shown: nothing added.
    expect(builtInViewsOf(model, t, s, String, 'late').map((view) => view.id)).toEqual(['all', 'IN_PRODUCTION', 'late'])
    expect(builtInViewsOf(model, t, s, String, null).map((view) => view.id)).toEqual(['all', 'IN_PRODUCTION', 'late'])
    expect(builtInActive({ rows: 'open', kind: null, waiting: null, hostViews: null } as unknown as Parameters<typeof builtInActive>[0])).toBe('open')
    expect(read('./view/OrdersListView.tsx')).toContain('builtInActive(model) /* cw fx5: the view shown is always named */), active: builtInActive(model),')
  })
  it('walk W-27: the made-to-measure view has its word in both languages (the menu showed the raw key "view.mtm")', () => {
    for (const locale of LOCALES) {
      const sheet = words(locale, 'orders-sheet')
      const all = builtInViewsOf({ ...model, views: null, locked: null } as unknown as Parameters<typeof builtInViewsOf>[0], words(locale, 'orders'), sheet)
      const mtm = all.find((view) => view.id === MTM_VIEW)
      expect(mtm?.label, locale).toBe(locale === 'en' ? 'Made to measure' : 'Su misura')
      for (const view of all) expect(view.label, `${locale} ${view.id}`).not.toMatch(/^(view|views|rows)\./)
    }
    expect(read('./view/OrdersListView.tsx')).not.toContain("s('view.mtm')")
  })
  it('"Showing:" names the view really shown — Waiting on us, not "Open"', () => {
    expect(read('./view/OrdersListView.tsx')).toContain("view: model.waiting === 'us' && model.rows === 'open' ? s('views.waitingUs')")
  })
  it('a priority door and the Waiting for deposit view with nothing behind them say their own sentence + Show all orders', () => {
    for (const locale of LOCALES) {
      const p = words(locale, 'parties')
      const level = words(locale, 'sales-orders-depth')('priority.level.URGENT')
      const open = workEmptyOf('open', null, 'Seed Racing', p, '/all', { priority: level })
      expect(open, locale).toMatchObject({ link: { href: '/all' }, always: true })
      expect(open?.title, locale).toBe(locale === 'en' ? 'No open order of Seed Racing has priority Top now.' : 'Nessun ordine aperto di Seed Racing ha priorità Massima ora.')
      expect(workEmptyOf('all', null, 'Seed Racing', p, '/all', { priority: level })?.title, locale).toBe(locale === 'en' ? 'No order of Seed Racing has priority Top.' : 'Nessun ordine di Seed Racing ha priorità Massima.')
      expect(workEmptyOf('deposit', null, 'Seed Racing', p, '/all')?.title, locale).toBe(locale === 'en' ? 'No order of Seed Racing waits for a deposit now.' : 'Nessun ordine di Seed Racing aspetta un acconto ora.')
      expect(workEmptyOf('deposit', null, 'Seed Racing', p, '/all')?.link, locale).toEqual({ href: '/all', label: p('customers.work.showAll') })
    }
    const p = words('en', 'parties')
    // Something else narrows the sheet too (a search, a brand): the sheet's own "No orders match" stands.
    expect(workEmptyOf('open', null, 'Seed Racing', p, '/all', { priority: 'Top', plain: false })).toBeNull()
    expect(workEmptyOf('deposit', null, 'Seed Racing', p, '/all', { plain: false })).toBeNull()
    // The doors that had their sentence keep it.
    expect(workEmptyOf('all', null, 'Seed Racing', p, '/all', { phase: 'READY' })?.title).toBe('No order of Seed Racing is ready to ship now.')
    expect(workEmptyOf('open', 'us', 'Seed Racing', p, '/all')?.title).toBe('No order of Seed Racing waits on us now.')
  })
})

describe('walk W-25: a wrong `phase` is dropped by the entry\'s one write', () => {
  const BASE = '/sales/customers/p1'
  it('`phase=FOO` leaves the address in the same write that names the tab\'s default view; a real phase stays', () => {
    const wrong = workEntry(BASE, 'p1', new URLSearchParams('tab=work&phase=FOO'))
    expect(wrong).not.toBeNull()
    expect(wrong).not.toContain('phase=')
    expect(wrong).toContain('rows=all')
    const right = workEntry(BASE, 'p1', new URLSearchParams('tab=work&phase=IN_PRODUCTION'))
    expect(right ?? `${BASE}?tab=work&phase=IN_PRODUCTION`).toContain('phase=IN_PRODUCTION')
  })
})

describe('walk W-28: "Create shipment…" on a row by the fact, not the status', () => {
  const part = (readyNow: number | undefined, stage: string | null = null) => ({ stage, stageSince: null, health: null, waitingOn: null, since: null, held: false, supervisorMark: 'NOT_SET', openRequests: 0, openIssues: 0, withheld: [], ...(readyNow === undefined ? {} : { readyNow }) }) as NonNullable<ShipRow['production']>
  const row = (n: number, status: OrderStatus, readyNow?: number, stage: string | null = null): ShipRow => ({ id: `o${n}`, number: `SEED-SO-000${n}`, customerRef: null, partyId: ALPHA, partyName: 'Seed Racing', status, units: 4, shippedUnits: 0, production: part(readyNow, stage) })

  it('a confirmed order with a released garment offers the step, free; nothing ready outside the shipping states: not drawn', () => {
    const confirmed = row(3, 'CONFIRMED', 1)
    expect(shipRowOffered(confirmed)).toBe(true)
    expect(shipRowHeld(confirmed)).toBe(false)
    expect(shipRowOffered(row(1, 'CONFIRMED', 0))).toBe(false)
    expect(shipRowOffered(row(1, 'PENDING_APPROVAL'))).toBe(false)
    // An order that stands at a stage of the floor and has not ended: drawn, held with the existing words while nothing is ready.
    const staged = row(4, 'CONFIRMED', 0, 'SEWING')
    expect([shipRowOffered(staged), shipRowHeld(staged)]).toEqual([true, true])
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(shipRowOffered(row(5, status, 0, 'SEWING')), status).toBe(false)
  })
  it('"Ship N together…" runs by the same fact: a confirmed order that knows it has garments ready is not "nothing ready", and leads the window', () => {
    expect(shipHeld([row(3, 'CONFIRMED', 1)], null)).toBeNull()
    expect(shipHeld([row(1, 'CONFIRMED', 0), row(2, 'CONFIRMED')], null)).toEqual({ key: 'ship.nothing', params: { count: 2 } })
    expect(shipFirstOf([row(1, 'IN_PRODUCTION', 0), row(3, 'CONFIRMED', 1)])).toBe('o3')
  })
})

// ============================================================ B. the ship window and the links ============================================================

describe('walk W-2, W-24: the New shipment window carries its own styles; the doors are the app\'s quiet link', () => {
  it('Warehouse\'s window imports the stylesheet its classes live in (one additive line; Warehouse and the order page load the same file)', () => {
    const dialog = read('../../../warehouse/shipments/list/view/NewShipmentDialog.tsx')
    expect(dialog).toContain("import '../../shipments.css'")
    const css = read('../../../warehouse/shipments/shipments.css')
    for (const name of ['.fw-sh-fields', '.fw-sh-h3', '.fw-sh-fieldset', '.fw-sh-dialog']) expect(css, name).toContain(name)
    for (const name of ['fw-sh-fields', 'fw-sh-dialog']) expect(dialog, name).toContain(name)
  })
  it('"Portal settings ›" and the existing-draft door: link colour, no underline until hover, a focus ring (tokens only)', () => {
    for (const [file, selector] of [['../../customers/record/view/work-foot.css', '.fw-cw-foot a'], ['./view/ship-together.css', '.fw-sst-hint a']] as const) {
      const css = read(file)
      expect(css, file).toMatch(new RegExp(`${selector.replace('.', '\\.')}[^{]*\\{[^}]*color: var\\(--nds-text-link\\);[^}]*text-decoration: none;`))
      expect(css, file).toMatch(/a:hover[^{]*\{\s*text-decoration: underline;/)
      expect(css, file).toMatch(/a:focus-visible[^{]*\{\s*outline: 2px solid var\(--nds-primary\);/)
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
    }
  })
})

// ============================================================ C. the row and its columns ============================================================

describe('walk W-5, W-6, W-7, W-16: the row keeps its words in the four rooms (863 / 1183 / 1312 / 1792 px of sheet)', () => {
  const TICK = 43 // the grid engine's own select column (the design drew 40)
  const MORE = 48
  const fixed = (ids: readonly string[]) => TICK + MORE + ids.filter((id) => id !== 'whereItIs').reduce((sum, id) => sum + WORK_MIN[id]!, 0)

  it('the narrow fixed columns stand at the design\'s widths and Where it is gets 275 px beside the thread (it had 232)', () => {
    expect(WORK_MIN).toMatchObject({ picture: 58, promised: 98, newMessages: 44 })
    expect(863 - fixed(WORK_SETS.base)).toBe(275)
    // Each wider room leaves Where it is more than the three chips of the walked seed need with the closer chips (about 263 px + the cell's 14).
    expect(1183 - fixed(WORK_SETS.wide)).toBeGreaterThanOrEqual(281)
    expect(1312 - fixed(WORK_SETS.wider)).toBeGreaterThanOrEqual(281)
    expect(1792 - fixed(WORK_SETS.widest)).toBeGreaterThanOrEqual(281)
    // The Waiting on us / Late set beside the thread fits too.
    expect(863 - fixed(WAITING_SET)).toBeGreaterThanOrEqual(WORK_MIN.whereItIs!)
  })
  it('the ⋯ column: 48 px for its 44 px button, no padding, its header word not drawn (it stays the column\'s name) — on every host', () => {
    const view = read('./view/OrdersListView.tsx')
    expect(view).toMatch(/colId: 'more', headerName: t\('col\.more'\), minWidth: 48, maxWidth: 48, pinned: 'right',[^}]*cellClass: 'fw-sheet-more', headerClass: 'fw-sheet-more'/)
    const css = read('./sheet/chips.css')
    expect(css).toMatch(/\.fw-so \.ag-cell\.fw-sheet-more,\s*\.fw-so \.ag-header-cell\.fw-sheet-more \{\s*padding-left: 0;\s*padding-right: 0;/)
    expect(css).toMatch(/\.fw-so \.ag-header-cell\.fw-sheet-more \.ag-header-cell-text \{[^}]*clip-path: inset\(50%\);/)
    // Sales › Orders keeps its own ten columns: the 16 px the column gave back are not counted as room for one more.
    expect(rowWidthOf([{ colId: 'number', minWidth: 144 }, { colId: 'more', minWidth: 48 }])).toBe(43 + 144 + 64)
  })
  it('the host\'s own cell padding, plain headers and two-line headers reach the columns (the sheet\'s own css, never the grid\'s)', () => {
    const preset = workPreset('all', null, false, 'base')
    expect(preset).toMatchObject({ pad: WORK_PAD, plainHeads: WORK_PLAIN_HEADS, wrapHeads: true, dense: true })
    expect(WORK_PAD).toEqual({ picture: 'tight', whereItIs: 'snug', promised: 'snug', deposit: 'snug', orderDate: 'snug' })
    expect(withPreset({ colId: 'whereItIs', headerName: 'Where it is', minWidth: 150 }, preset, false)).toMatchObject({ cellClass: 'fw-sheet-snug', headerClass: 'fw-sheet-snug fw-sheet-hwrap', wrapHeaderText: true })
    expect(withPreset({ colId: 'promised', headerName: 'Promised', minWidth: 108 }, preset, false)).toMatchObject({ minWidth: 98, maxWidth: 98, cellClass: 'fw-sheet-snug', suppressHeaderMenuButton: true })
    expect(withPreset({ colId: 'picture', headerName: 'Picture', minWidth: 76, maxWidth: 76 }, preset, false)).toMatchObject({ minWidth: 58, maxWidth: 58, cellClass: 'fw-sheet-tight', headerClass: 'fw-sheet-tight fw-sheet-hwrap' })
    // A column with a class of its own keeps it; a column the host gives no padding gets only the header's wrap.
    expect(withPreset({ colId: 'newMessages', headerName: 'New messages', cellClass: 'fw-sheet-tight', headerClass: 'fw-sheet-tight' }, preset, false)).toMatchObject({ cellClass: 'fw-sheet-tight', headerClass: 'fw-sheet-tight fw-sheet-hwrap', suppressHeaderMenuButton: true })
    const urgency = withPreset({ colId: 'customerUrgency', headerName: 'Customer urgency', minWidth: 120 }, preset, false)
    expect(urgency).toMatchObject({ headerClass: 'fw-sheet-hwrap', wrapHeaderText: true })
    expect(urgency.cellClass).toBeUndefined()
    expect(urgency.suppressHeaderMenuButton).toBeUndefined() // its menu stays: the header wraps to two lines instead
    // No preset (Sales › Orders, Made to measure): the column as the sheet built it.
    const own = { colId: 'promised', headerName: 'Promised', minWidth: 108 }
    expect(withPreset(own, null, false)).toBe(own)
    const css = read('./sheet/chips.css')
    // Under the sheet's own root: stronger than the grid's own cell padding rule whatever the order the styles load in.
    expect(css).toMatch(/\.fw-so \.ag-cell\.fw-sheet-snug,\s*\.fw-so \.ag-header-cell\.fw-sheet-snug \{\s*padding-left: var\(--nds-space-6\);\s*padding-right: var\(--nds-space-6\);/)
    expect(css).toMatch(/\.fw-so \.ag-cell\.fw-sheet-tight,\s*\.fw-so \.ag-header-cell\.fw-sheet-tight \{\s*padding-left: var\(--nds-space-4\);/)
    expect(css).toMatch(/\.fw-so \.ag-header-cell\.fw-sheet-hwrap \.ag-header-cell-comp-wrapper,\s*\.fw-so \.ag-header-cell\.fw-sheet-hwrap \.ag-header-cell-text \{\s*white-space: normal;/)
  })
  it('words wrap inside their cell on a word\'s edge instead of being cut; a time at the end stays whole', () => {
    expect(tailWhole('Waiting on customer · 16 d', '16 d')).toBe('Waiting on customer · 16 d')
    expect(tailWhole('Tocca al cliente · 3 g', '3 g')).toBe('Tocca al cliente · 3 g')
    expect(tailWhole('Waiting on customer', null)).toBe('Waiting on customer')
    expect(tailWhole('Asked production · now', '16 d')).toBe('Asked production · now') // not its tail: untouched
    const css = read('./sheet/chips.css')
    expect(css).toMatch(/\.fw-sheet-wraps,[^{]*\{\s*white-space: normal;/)
    expect(css).toMatch(/\.fw-sheet-sub\.fw-sheet-wraps \{[^}]*-webkit-line-clamp: 2;/)
    const view = read('./view/OrdersListView.tsx')
    // "No promise" / "Nessuna data promessa", the PO line ("Senza ordine del cliente") and "nothing requested".
    expect(view).toContain(`<span className="fw-sheet-wraps is-quiet">{door(linesDoor(prefix, data, true), t('list.noPromise'))}</span>`)
    expect(view.match(/<span className="fw-sheet-sub fw-sheet-wraps">\{data\.customerRef \? t\('list\.customerRef'/g)?.length).toBe(2)
    expect(view).toMatch(/<span className="fw-sheet-sub fw-sheet-wraps">\{data\.requestedDate \?/)
    expect(read('./sheet/parts.tsx').match(/<span className="fw-sheet-wraps">/g)?.length).toBe(3) // the three Waiting on forms that end with a time
  })
})

describe('walk W-12: the Deposit pill says the truth', () => {
  it('an extra deposit still open on an order whose own deposit is not open: its day, and whether it passed', () => {
    expect(depositExtraOf({ state: 'NOT_NEEDED', extraOpenDue: '2026-11-25' }, '2026-11-23')).toEqual({ due: '2026-11-25', overdue: false })
    expect(depositExtraOf({ state: 'PAID', extraOpenDue: '2026-11-20' }, '2026-11-23')).toEqual({ due: '2026-11-20', overdue: true })
    // An OPEN deposit shows its own pill and day; none: nothing.
    expect(depositExtraOf({ state: 'OPEN', extraOpenDue: '2026-11-25' }, '2026-11-23')).toBeNull()
    expect(depositExtraOf({ state: 'NOT_NEEDED', extraOpenDue: null }, '2026-11-23')).toBeNull()
    expect(depositExtraOf({ state: 'NOT_NEEDED' }, '2026-11-23')).toBeNull()
  })
  it('the pill reads "Extra deposit open" over the open deposit\'s own "due …" line — never "Not needed" over a second line', () => {
    const view = read('./view/OrdersListView.tsx')
    expect(view).toContain(`<Pill tone={extra.overdue ? 'danger' : 'warning'} className="fw-sheet-dep-extra" title={s('stop.depositExtra')}>`)
    expect(view).toContain("{t(extra.overdue ? 'list.depositOverdue' : 'list.depositDue', { date: day(extra.due) })}")
    expect(view).not.toContain("s('deposit.extra'")
    for (const locale of LOCALES) {
      expect(words(locale, 'orders-sheet')('stop.depositExtra'), locale).toBe(locale === 'en' ? 'Extra deposit open' : 'Acconto aggiuntivo aperto')
      expect(words(locale, 'orders')('list.depositDue', { date: '25/11/2026' }), locale).toContain('25/11/2026')
    }
    expect(read('./sheet/chips.css')).toMatch(/\.fw-sheet-wraps \.nds-pill\.fw-sheet-dep-extra \{\s*white-space: normal;/)
  })
})

// ============================================================ D. the names and the bar ============================================================

describe('walk W-8: one customer, one name', () => {
  it('a sentence that ends with a name ending in a full stop adds no second one', () => {
    expect(oneStop('None of the 2 is urgent for Seed Customer One S.r.l..')).toBe('None of the 2 is urgent for Seed Customer One S.r.l.')
    expect(oneStop('None of the 2 is urgent for Seed Racing.')).toBe('None of the 2 is urgent for Seed Racing.')
    expect(oneStop('Reply to Seed Racing on 3…')).toBe('Reply to Seed Racing on 3…')
    expect(oneStop('Wait...')).toBe('Wait...')
    expect(oneStop('')).toBe('')
  })
  it('the bar\'s words name the customer the rows are handed with: on a customer\'s own page the page\'s name', () => {
    const picked = [{ partyId: ALPHA, partyName: 'Seed Customer One S.r.l.' }, { partyId: ALPHA, partyName: 'Seed Customer One S.r.l.' }]
    const named = picked.map((row) => ({ ...row, partyName: 'Seed Racing' }))
    expect(replyManyLabel(picked)).toEqual({ key: 'bulk.reply', params: { customer: 'Seed Customer One S.r.l.', count: 2 } })
    expect(replyManyLabel(named)).toEqual({ key: 'bulk.reply', params: { customer: 'Seed Racing', count: 2 } })
    const urgent = [{ id: 'o1', number: 'SEED-SO-0001', customerRef: null, partyId: ALPHA, partyName: 'Seed Racing', customerUrgencyState: null }] as unknown as Parameters<typeof urgencyHeld>[1]
    expect(urgencyHeld('regular', urgent, { locked: ALPHA, urgencyOff: true })).toEqual({ key: 'urgency.held.off', params: { customer: 'Seed Racing' } })
  })
  it('the sheet hands every word the host\'s own name on a page of one customer; the other hosts keep each row\'s name', () => {
    const view = read('./view/OrdersListView.tsx')
    expect(view).toContain('const lockedName = model.locked?.party ? (model.customer?.name ?? null) : null')
    expect(view).toContain('const picked = (items ?? []).filter((row) => selected.includes(row.id)).map(named)')
    expect(view).toContain('rows={(items ?? []).map(named)')
    expect(view).toContain("oneStop(s('urgency.held.off', { customer: lockedNameNow() ?? data.partyName }))")
    expect(view).toContain('<WaitingOnCell row={lockedNameNow() ? { ...data, partyName: lockedNameNow()! } : data')
    const hook = read('./use-orders-sheet.ts')
    expect(hook).toContain('(hostNames ? host.customerName : null) ?? nameInSwitcher ?? nameInRows')
  })
})

describe('walk W-9, W-4, W-14: the bar keeps WORDS on every button, on one line (30-walk §6.4, §6.5)', () => {
  const part = (label: string, menu = false): BarPart => (menu ? { label, menu } : { label })
  const REST = [part('Export 3'), part('More', true), part('Clear selection')]
  const MANAGER = [part('Ask', true), part('Reply to Seed Racing on 3…'), part('Assign supervisor…')]
  const WAREHOUSE = [part('Ship 3 together…'), part('Ask', true), part('Reply to Seed Racing on 3…')]

  it('the measure: a button is its icon and padding + its characters; the whole bar a little generous (971 px measured, 992 here)', () => {
    expect(barPartPx(part('Ask', true))).toBe(Math.round(BAR_PX.button + 3 * BAR_PX.char + BAR_PX.chevron))
    const legal = [part('Ask', true), part('Reply to Seed Customer One S.r.l. on 3…'), part('Assign supervisor…')]
    const whole = barPx('3 selected', legal, REST)
    expect(whole).toBeGreaterThanOrEqual(971)
    expect(whole).toBeLessThanOrEqual(1010)
  })
  it('beside the thread (863 px) the last promoted act moves into More ▾ before any button loses its words; with room all three stay', () => {
    expect(promotedFit(863, '3 selected', MANAGER, REST)).toBe(2)
    expect(promotedFit(863, '3 selected', WAREHOUSE, REST)).toBe(2)
    for (const room of [1183, 1312, 1792]) expect(promotedFit(room, '3 selected', MANAGER, REST), String(room)).toBe(3)
    // Italian, the same rule (walk §6.5).
    const italian = [part('Chiedi', true), part('Rispondi a Seed Racing su 3…'), part('Assegna supervisore…')]
    const rest = [part('Esporta 3'), part('Altro', true), part('Deseleziona tutto')]
    expect(promotedFit(863, '3 selezionati', italian, rest)).toBe(2)
    expect(promotedFit(1183, '3 selezionati', italian, rest)).toBe(3)
    // Never fewer than one; not measured yet (the server's draw): every act.
    expect(promotedFit(300, '3 selected', MANAGER, REST)).toBe(1)
    expect(promotedFit(null, '3 selected', MANAGER, REST)).toBe(3)
    expect(promotedFit(863, '1 selected', [part('Ask', true)], REST)).toBe(1)
  })
  it('the phone: at most two promoted acts on ONE line of the bar (then Export N and More ▾ on the next); a long name leaves one', () => {
    expect(promotedFit(343, '3 selected', MANAGER, REST, true)).toBe(2)
    expect(promotedFit(343, '3 selected', [part('Ask', true), part('Reply to Seed Customer One S.r.l. on 3…'), part('Assign supervisor…')], REST, true)).toBe(1)
    expect(promotedFit(null, '3 selected', MANAGER, REST, true)).toBe(2)
  })
  it('the act that does not fit is the FIRST of More ▾, in the one order of the acts; the default is three', () => {
    const can: BarCan = { ship: false, urgency: true, manage: false, close: false, decide: true, post: true, supervisor: true, task: true, todo: false, invoices: false }
    const rows = [1, 2, 3].map((n) => ({ id: `o${n}`, number: `SEED-SO-000${n}`, customerRef: null, partyId: ALPHA, partyName: 'Seed Racing', companyId: 'c1', status: 'IN_PRODUCTION', units: 4, shippedUnits: 0, production: null, customerUrgencyState: null })) as unknown as BarRow[]
    const three = barOf(can, rows, { locked: ALPHA })
    const two = barOf(can, rows, { locked: ALPHA }, 2)
    expect(three.promoted.map((act) => act.id)).toEqual(['ask', 'reply', 'assign'])
    expect(two.promoted.map((act) => act.id)).toEqual(['ask', 'reply'])
    expect(two.more.map((act) => act.id)).toEqual(['assign', ...three.more.map((act) => act.id)])
    expect(barOf(can, rows, { locked: ALPHA }, 9).promoted).toHaveLength(BAR_PROMOTED)
    expect(barOf(can, rows, { locked: ALPHA }, 0).promoted).toHaveLength(1)
    const view = read('./view/OrdersListView.tsx')
    expect(view).toContain('const bar = barOf(...barArgs, barFit)')
    expect(view).toMatch(/const barFit = promotedFit\(barRoom, lists\('selected', \{ count: picked\.length \}\)/)
  })
})

describe('walk W-3, W-20, W-22, W-23: the menus and the windows of the bar', () => {
  it('W-3: on the phone More ▾ hangs from its left edge (it opened off the screen); the desktop keeps the right', () => {
    expect(read('./view/OrdersListView.tsx')).toContain("align={phone ? 'left' : 'right'}")
  })
  it('W-20: the Sort button shows ▾ and each pair of the Sort list stands together', () => {
    expect(read('./view/OrdersListView.tsx')).toMatch(/<span className="fw-lt-trigger">\{sortWords\}<\/span> <ChevronDown size=\{13\} aria-hidden \/>/)
    const order = SORT_CHOICES.map((choice) => choice.word)
    for (const [first, second] of [['customer', 'customerBack'], ['brand', 'brandBack'], ['promise', 'promiseBack'], ['daysLate', 'daysLateBack'], ['ordered', 'orderedBack']]) expect(order.indexOf(second!) - order.indexOf(first!), first).toBe(1)
    expect(order.slice(0, 2)).toEqual(['urgent', 'newest'])
    expect(new Set(order).size).toBe(order.length)
  })
  it('W-22: "Confirm N…" is held with its reason when nobody was asked for the yes of any ticked order; the window never opens on "Runs on 0"', () => {
    const can = { manage: false, close: false }
    const waits = (list: OrderRow['waits'], status: OrderStatus = 'PENDING_APPROVAL') => ({ status, waits: list })
    expect(manyHeld('confirm', [waits(['NO_REQUEST', 'CREDIT_HOLD'])], can)).toMatchObject({ key: 'commands.noneAsked', params: { count: 1 } })
    expect(manyHeld('confirm', [waits(['NO_REQUEST']), waits(['NO_REQUEST']), waits(null, 'CONFIRMED')], can)).toMatchObject({ key: 'commands.noneAsked', params: { count: 3 } })
    // One of them has a yes asked: the window opens and says which it runs on.
    expect(manyHeld('confirm', [waits(['NO_REQUEST']), waits(['REQUEST_PENDING'])], can)).toBeNull()
    // A row that does not say why it waits never holds (the window says it then).
    expect(manyHeld('confirm', [waits(null)], can)).toBeNull()
    expect(manyHeld('confirm', [{ status: 'PENDING_APPROVAL' }], can)).toBeNull()
    expect(manyHeld('confirm', [waits([])], can)).toBeNull()
    // None waits for a yes at all: the state's own words, as before.
    expect(manyHeld('confirm', [waits(null, 'CONFIRMED')], can)).toMatchObject({ key: 'bulk.noneInState' })
    expect([noYesAsked({ waits: ['NO_REQUEST'] }), noYesAsked({ waits: ['REQUEST_PENDING', 'NO_REQUEST'] }), noYesAsked({})]).toEqual([true, false, false])
    for (const locale of LOCALES) for (const count of [1, 3]) expect(words(locale, 'orders-sheet')('commands.noneAsked', { count }), `${locale} ${count}`).not.toMatch(/commands\.noneAsked|\{count\}/)
    expect(words('en', 'orders-sheet')('commands.noneAsked', { count: 3 })).toContain('3')
  })
  it('W-22: the preview prints "Not on N: why is beside it" once (its heading says it); the receipt keeps the list\'s own heading', () => {
    const dialog = read('./commands/view/OrderCommandManyDialog.tsx')
    expect(dialog).toContain("{heading && <p className=\"fw-cmd-heading\">{s('commands.notOn', { count: preview.notOn.length })}</p>}")
    expect(dialog).toContain('{notOnOf(false)}')
    expect(dialog).toContain('{notOnOf(true)}')
    expect(dialog.match(/notOnOf\((true|false)\)/g)).toEqual(['notOnOf(true)', 'notOnOf(false)'])
  })
  it('W-23: in a room below 480 px the search field says its short words; its name stays whole', () => {
    expect(SEARCH_SHORT_BELOW).toBe(480)
    expect([words('en', 'orders-sheet')('searchShort'), words('it', 'orders-sheet')('searchShort')]).toEqual(['Search orders', 'Cerca ordini'])
    const view = read('./view/OrdersListView.tsx')
    expect(view).toContain("aria-label={model.searchLabel ?? t('list.search')")
  })
})

// ============================================================ E. the phone, the foot, the windows ============================================================

describe('walk W-15, W-26, W-32: the foot, the "Waiting for <customer>" window, the phone\'s door to the work orders', () => {
  it('W-15: the foot line is the quiet foot look (small, muted, set in like the card\'s own foot strip)', () => {
    const css = read('../../customers/record/view/work-foot.css')
    expect(css).toMatch(/\.fw-cw-foot \{[^}]*padding: 0 var\(--nds-space-12\);[^}]*font-size: var\(--nds-font-size-xs\);[^}]*color: var\(--nds-text-muted\);/)
  })
  it('W-26: the window is the wide one — the portal\'s requests card fits with "Asked by" on screen and the date whole', () => {
    expect(read('../../customers/record/view/WaitingForCustomerDialog.tsx')).toContain(`<Modal open onClose={onClose} size="xl" title={t('customers.work.window.customerTitle', { customer: party.name })}>`)
  })
  it('W-32: "Work orders of <customer> ›" is the last line of the groups\' window (on the phone the notes line is folded away)', () => {
    const band = read('../../customers/record/view/WorkBand.tsx')
    const win = band.slice(band.indexOf('<div className="fw-cwb-win">'))
    expect(win.indexOf("t('customers.work.band.beforeNote')")).toBeGreaterThan(0)
    expect(win.indexOf('href={model.workOrdersHref}')).toBeGreaterThan(win.indexOf("t('customers.work.band.beforeNote')"))
    expect(win).toContain("{t('customers.band.workOrders', { customer })}")
    for (const locale of LOCALES) expect(words(locale, 'parties')('customers.band.workOrders', { customer: 'Seed Racing' }), locale).toContain('Seed Racing')
  })
})

describe('walk W-31: Customise says which ticked columns wait for a wider sheet', () => {
  it('the dialog\'s own counter counts every ticked column; the host\'s set adds how many of them are not on screen in this room', () => {
    expect(waitingColumnsOf(workPreset('all', null, false, 'base'))).toBe(7) // Waiting on · Deposit · Shipped · Priority · Pieces · Ordered · Supervisor
    expect(waitingColumnsOf(workPreset('all', null, false, 'wide'))).toBe(5)
    expect(waitingColumnsOf(workPreset('all', null, false, 'widest'))).toBe(0)
    expect(waitingColumnsOf(null)).toBe(0)
    for (const locale of LOCALES) {
      for (const count of [1, 7]) {
        const line = words(locale, 'orders-sheet')('customise.waits', { count })
        expect(line, `${locale} ${count}`).toMatch(new RegExp(`^${count} `))
        expect(line, `${locale} ${count}`).not.toMatch(/customise\.waits|\{count\}/)
      }
    }
    // Through the frame's own option (no change in the frame); nothing for a host without such columns.
    expect(read('./view/OrdersListView.tsx')).toContain("customiseAbout={waitingColumnsOf(model.preset ?? null) > 0 ? <p>{s('customise.waits', { count: waitingColumnsOf(model.preset ?? null) })}</p> : undefined}")
  })
})

describe('the sheet has three hosts: what this wave gives the customer\'s page alone stays there', () => {
  it('Sales › Orders and Made to measure give no preset padding, no host name, no host board', () => {
    for (const page of ['./OrdersPage.tsx', '../../mtm/MtmPage.tsx']) expect(read(page), page).not.toMatch(/WORK_PAD|plainHeads|wrapHeads|customerName/)
  })
  it('a row of another customer still holds the acts that take one customer (the name rule changes no wall)', () => {
    const rows = [{ partyId: ALPHA, partyName: 'Seed Racing' }, { partyId: BETA, partyName: 'Brand Beta' }]
    expect(replyManyLabel(rows)).toEqual({ key: 'bulk.replyAny', params: { count: 2 } })
  })
})

// ============================================================ cw fx6 — the last round, from the re-walk (31-rewalk.md) ============================================================

describe('re-walk W-8: one name in every window opened from the customer\'s own page', () => {
  it('the rows a window is opened with carry the host\'s name of the customer (Reply to N, Ask production / Note, Assign supervisor, the urgency and shipment windows)', () => {
    const hook = read('./use-orders-sheet.ts')
    expect(hook).toContain('const name = hostNames ? host.customerName : null')
    expect(hook).toContain('return name ? rows.map((row) => ({ ...row, partyName: name })) : rows')
    // Every window takes its rows from that one function.
    for (const open of ['replyMany.open(pickedRows(ids)', 'ship.open(pickedRows(ids))', 'assign.open(supervisorTargetsOf(pickedRows(ids)))', 'note.open(noteTargetsOf(pickedRows(ids))', 'urgencyDialogOf(act, pickedRows(ids))', 'commandMany.open(command, pickedRows(ids))']) expect(hook, open).toContain(open)
    expect(read('./use-reply-many.ts')).toContain('const customer = { id: targets[0]!.partyId, name: targets[0]!.partyName }') // the Reply window's title, lines and button
  })
  it('the peek card and Warehouse\'s own lines of the shipment window say it too; Warehouse and the order page give no name (as before)', () => {
    const view = read('./view/OrdersListView.tsx')
    expect(view).toContain("[s('peek.who'), (lockedNameNow() ?? data.partyName) || '—'")
    expect(view).toContain('customerName={lockedName')
    expect(read('./view/ShipTogether.tsx')).toContain('customer={customerName} />')
    const dialog = read('../../../warehouse/shipments/list/view/NewShipmentDialog.tsx')
    expect(dialog.match(/customer: customer \?\? order\.party\.legalName/g)?.length).toBe(4)
    expect(dialog).toContain('<TogetherStep order={order} model={model} actions={actions} customer={customer} />')
    expect(read('../../../warehouse/shipments/list/view/ShipmentsListView.tsx')).toContain('{model.create && <NewShipmentDialog model={model.create} can={model.can} actions={actions} />}')
  })
  it('the review window names the customer as the page does — one request, a batch; nothing read yet or no name: the model as it is', () => {
    const request = (id: string) => ({ id, party: { id: ALPHA, code: 'SEED', name: 'Seed Customer One S.r.l.' } })
    const one = { as: 'request', id: 'r1', record: { status: 'ready', value: { asOf: 'x', request: request('r1'), counterApproval: null, batch: [] } }, impact: { status: 'loading' } } as unknown as RequestReviewModel
    const named = reviewNamed(one, 'Seed Racing')
    expect(named?.as === 'request' && named.record.status === 'ready' ? named.record.value.request.party : null).toEqual({ id: ALPHA, code: 'SEED', name: 'Seed Racing' })
    expect(one.as === 'request' && one.record.status === 'ready' ? one.record.value.request.party.name : null).toBe('Seed Customer One S.r.l.') // the read itself is untouched
    const batch = { as: 'batch', id: 'b1', batch: { status: 'ready', value: [request('r1'), request('r2')] } } as unknown as RequestReviewModel
    const both = reviewNamed(batch, 'Seed Racing')
    expect(both?.as === 'batch' && both.batch.status === 'ready' ? both.batch.value.map((entry) => entry.party.name) : null).toEqual(['Seed Racing', 'Seed Racing'])
    const reading = { as: 'request', id: 'r1', record: { status: 'loading' }, impact: { status: 'loading' } } as unknown as RequestReviewModel
    expect(reviewNamed(reading, 'Seed Racing')).toBe(reading)
    expect(reviewNamed(one, null)).toBe(one)
    expect(reviewNamed(null, 'Seed Racing')).toBeNull()
    expect(reviewNamed(undefined, 'Seed Racing')).toBeUndefined()
    expect(read('../../customers/record/view/WorkTab.tsx')).toContain('review: reviewNamed(door.window.review, party.name)')
  })
})

describe('re-walk W-22: "Confirm N…" is held for every reason the bulk Confirm cannot decide', () => {
  const can = { manage: false, close: false }
  const row = (waits: OrderRow['waits'], status: OrderStatus = 'PENDING_APPROVAL') => ({ status, waits })
  it('an order that only says why it waits (credit, measurements) has no asked yes either: held, the window never opens on "Runs on 0"', () => {
    expect(manyHeld('confirm', [row(['CREDIT_HOLD'])], can)).toMatchObject({ key: 'commands.noneAsked', params: { count: 1 } }) // SEED-SO-W39-01
    expect(manyHeld('confirm', [row(['MEASUREMENTS']), row(['NO_REQUEST'])], can)).toMatchObject({ key: 'commands.noneAsked', params: { count: 2 } })
    expect([noYesAsked({ waits: ['CREDIT_HOLD'] }), noYesAsked({ waits: ['MEASUREMENTS'] }), noYesAsked({ waits: ['NO_REQUEST'] })]).toEqual([true, true, true])
  })
  it('an asked yes opens the window (whatever else the order waits for); a row that gives no reason never holds', () => {
    expect(manyHeld('confirm', [row(['REQUEST_PENDING', 'CREDIT_HOLD'])], can)).toBeNull()
    expect(manyHeld('confirm', [row(['CREDIT_HOLD']), row(['REQUEST_PENDING'])], can)).toBeNull()
    expect(manyHeld('confirm', [row([])], can)).toBeNull()
    expect(manyHeld('confirm', [row(null)], can)).toBeNull()
    expect(manyHeld('confirm', [{ status: 'PENDING_APPROVAL' }], can)).toBeNull()
    expect([noYesAsked({ waits: ['REQUEST_PENDING', 'CREDIT_HOLD'] }), noYesAsked({ waits: [] }), noYesAsked({ waits: null }), noYesAsked({})]).toEqual([false, false, false, false])
  })
})

describe('re-walk R-2, R-5: no cell taller than its row, no pill on three lines', () => {
  it('R-2: a Deposit column without the room says the open deposit\'s short word; the whole words stay its tooltip and what a screen reader hears', () => {
    expect(DEPOSIT_FULL_FROM).toBe(130)
    expect(depositRoomy(workPreset('all', null, false, 'wide'))).toBe(true) // the Work tab gives Deposit 136
    expect(depositRoomy(null)).toBe(false) // Sales › Orders, Made to measure (112 px)
    expect(depositRoomy({ shown: [], min: { deposit: 112 } })).toBe(false)
    const view = read('./view/OrdersListView.tsx')
    expect(view).toContain("{depositRoomy(model.preset ?? null) ? (")
    expect(view).toContain(`<span aria-hidden="true">{t('deposit.OPEN')}</span>`)
    expect(view).toContain(`<span className="nds-vh">{s('stop.depositExtra')}</span>`)
    for (const locale of LOCALES) expect(words(locale, 'orders')('deposit.OPEN'), locale).toBe(locale === 'en' ? 'Open' : 'Aperto')
    // Sales › Orders keeps its own widths (no column pushed off at 1312): the fix is in the words, not in the room.
    expect(view).toMatch(/LIST_MIN: Readonly<Record<string, number>> = \{[^}]*deposit: 112,/)
  })
  it('R-5: Ordered holds its second line on ONE line (144 px with the closer padding); the set still fits where each room starts', () => {
    expect(WORK_MIN.orderDate).toBe(144)
    expect(WORK_PAD.orderDate).toBe('snug')
    const need = (ids: readonly string[]) => 43 + 48 + ids.reduce((sum, id) => sum + WORK_MIN[id]!, 0)
    expect(need(WORK_SETS.widest)).toBeLessThanOrEqual(1700) // the widest room starts there
    expect(need(WORK_SETS.wider)).toBeLessThanOrEqual(1300)
    expect(need(WORK_SETS.wide)).toBeLessThanOrEqual(1150)
    expect(need(WORK_SETS.base)).toBeLessThanOrEqual(863)
    // At 1792 (1920, the thread closed) Where it is keeps more than the three chips of the walked seed need (263 px + the cell's 14).
    expect(1792 - (need(WORK_SETS.widest) - WORK_MIN.whereItIs!)).toBeGreaterThanOrEqual(281)
    // Beside the thread nothing moved: Where it is is still 275 px.
    expect(863 - (need(WORK_SETS.base) - WORK_MIN.whereItIs!)).toBe(275)
  })
})

describe('re-walk R-3, R-4, item 7, follow-up 8', () => {
  it('R-3: the phone card is ONE block under the number — the picture at the left, the chips in one flow, Thread on the last line', () => {
    const view = read('./view/OrdersListView.tsx')
    expect(view).toContain("picture: { role: 'hidden' as const },")
    expect(view).toContain("promised: { role: 'hidden' as const },")
    expect(view).toContain("...(cardDoorLabel ? { newMessages: { role: 'hidden' as const } } : {}),")
    const block = view.slice(view.indexOf('<span className="fw-sheet-card">'), view.indexOf("// The door is drawn on the block's last line"))
    const order = ['fw-sheet-card-pic', 'fw-sheet-card-lines', "t('list.customerRef'", 'fw-sheet-card-chips', "where(row, 'chips')", 'urgency(row)', 'fw-sheet-card-promise', "t('col.promised')", "where(row, 'pieces')", 'fw-sheet-card-door'].map((part) => block.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order) // nothing left out, in the picture's order
    const css = read('./sheet/chips.css')
    expect(css).toMatch(/\.fw-sheet-card-chips > \.fw-sheet-wi\.is-card,\s*\.fw-sheet-card-chips > \.fw-sheet-urg \{\s*display: contents;/)
    expect(css).toMatch(/\.fw-sheet-card-door \{[^}]*margin-left: auto;/)
    expect(css).toMatch(/\.fw-sheet-card \{[^}]*align-items: flex-start;/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })
  it('R-4: a failed read of the groups says so once in the notes line, with the retry the chips use', () => {
    const band = read('../../customers/record/view/WorkBand.tsx')
    const notes = band.slice(band.indexOf('<div className="fw-cwb-notes">'))
    expect(notes.indexOf('{model.failed && (')).toBeGreaterThan(0)
    expect(notes.indexOf('{model.failed && (')).toBeLessThan(notes.indexOf("t('customers.work.band.allCount'"))
    expect(notes).toContain("onClick={() => actions.onRetry?.('late')}")
    expect(band.match(/model\.failed/g)?.length).toBe(1) // once
    expect(read('../../customers/record/view/WorkTab.tsx')).toContain("failed: work.reads.board.status === 'failed',")
    // 'late' is fed by the board read: its retry reads the board again.
    expect(read('../../customers/record/use-customer-work.ts')).toMatch(/\} else readers\.board\(\)/)
    expect([words('en', 'parties')('customers.work.tile.failed'), words('it', 'parties')('customers.work.tile.failed')]).toEqual(["Couldn't be read · Try again", 'Lettura non riuscita · Riprova'])
  })
  it('item 7: the Reply window on ORDERS of a customer with no portal shows the reason only — no box, no to-do tick', () => {
    const dialog = read('./view/ReplyManyDialog.tsx')
    expect(dialog).toMatch(/const box = model\.portal !== 'off'\n/)
    expect(dialog).toContain('const todo = box ? (model.todo ?? null) : null')
    expect(dialog).toContain("{model.portal === 'off' && <Banner tone=\"warning\" title={s(replyKey(model.recordType, 'portalOff'), { customer })} />}")
    for (const locale of LOCALES) expect(words(locale, 'orders-sheet')('reply.portalOff', { customer: 'Seed Racing' }), locale).toContain('Seed Racing')
  })
  it('follow-up 8: the picture leads — Customise names Number as the row\'s name', () => {
    expect(read('./view/OrdersListView.tsx')).toMatch(/colId: 'picture',[^}]*cellRenderer: PictureColumn, context: \{ leading: true \} \}/)
    expect(read('../../../../list-frame/tools/model.ts')).toContain('contextOf(column).leading !== true')
  })
})
