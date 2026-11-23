import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ORDER_PHASES, PHASE_STATUSES, phaseCountsOf } from '@nexus/factory-domain/production-brand/stages'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { boardSchema, ORDER_STATUSES, type OrderBoard } from '../../orders/api'
import { boardNarrowOf, extraFromAddress, listAddress, noExtra, rowsFromAddress, rowsQuery, withoutExtra } from '../../orders/model'
import { lockedEntry } from '../../orders/list/use-orders-sheet'
import { phasePhrase } from '../../orders/list/sheet/model'
import { PHASE_ICON } from '../../orders/list/sheet/phase-icon'
import { extraChips } from '../../orders/list/view/OrdersListView'
import { BEFORE_GROUPS, beforeLineOf, beforeOrderTouched, NO_BEFORE_ORDER, openQuotesOf, quotesGroupDoor, readBeforeOrder, toAnswerOf } from './before-order'
import { IN_PRODUCTION_VIEW, phaseCountOf, phaseDoor, sourcesTouched, workEntry, type Read, type WorkReads } from './use-customer-work'
import { bandOf, chipsOf, groupShown, valueOf, whysOf } from './work-band'

/**
 * F-CW-101 (customer Work tab plan §1; 10-design §2; lead settles S2, S3, S16, S17, S24, S26, S27) — the Work tab's band: every order
 * of ONE customer in exactly one of seven groups (the board's `byPhase`: the API's one rule), each a count and a door
 * (`?tab=work&phase=<PHASE>`, completed by the entry with `party` and `rows=all`, once); the two whys of "Not sent to the factory";
 * today's six facts as chips (the same reads); the "Before an order" line (never added into the order numbers); an older answer
 * without `byPhase` (six groups by state, no guess). Pure parts only: nothing here needs a DOM, an API or a database.
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BASE = `/w/acme/sales/customers/${ALPHA}`
const params = (query: string) => new URLSearchParams(query)
const search = (address: string) => address.slice(address.indexOf('?') + 1)

/** A made-up board: the states' counts, the started orders, the two whys. */
const BY_STATUS = { PENDING_APPROVAL: 1, CONFIRMED: 1, IN_PRODUCTION: 5, READY: 1, PARTLY_SHIPPED: 1, SHIPPED: 1, DELIVERED: 1, CLOSED: 2, CANCELLED: 1 } as const
const boardOf = (over: Partial<OrderBoard> = {}, phased = true): Read<OrderBoard> => {
  const counts = phaseCountsOf(BY_STATUS, 4)
  return {
    status: 'ready',
    value: {
      byStatus: ORDER_STATUSES.map((status) => ({ status, count: BY_STATUS[status] })),
      ...(phased ? { byPhase: ORDER_PHASES.map((phase) => ({ phase, count: counts[phase] })), notSent: { waitsForYes: 1, waitsForDeposit: 1 } } : {}),
      lanes: [],
      tiles: [{ key: 'late', count: 1, filter: { late: 'true' } }, { key: 'waitingForDeposit', count: 0, filter: { deposit: 'OPEN' } }, { key: 'waitingForCustomer', count: 0, filter: { reaccept: 'true' } }],
      asOf: '2026-11-23T09:00:00.000Z',
      ...over,
    },
  }
}
/** The board inside a ready read. */
const valueOfBoard = (read: Read<OrderBoard>): OrderBoard => {
  if (read.status !== 'ready') throw new Error('the made-up board is ready')
  return read.value
}
const reads = (over: Partial<WorkReads> = {}): WorkReads => ({ board: { status: 'reading' }, requests: { status: 'reading' }, replies: { status: 'reading' }, asks: { status: 'reading' }, tasks: { status: 'reading' }, ...over })

describe('F-CW-101: the bigger picture — seven groups, each order in exactly one', () => {
  it('the groups come from the board\'s byPhase, in the domain\'s order; 0 is 0; they add up to All orders', () => {
    const band = bandOf(boardOf())
    expect(band.state).toBe('ready')
    expect(band.groups.map((group) => group.phase)).toEqual([...ORDER_PHASES])
    expect(band.groups.map((group) => group.count)).toEqual([2, 1, 4, 1, 2, 3, 1])
    expect(band.total).toBe(14)
    expect(band.groups.reduce((sum, group) => sum + (group.count ?? 0), 0)).toBe(band.total)
    // Every group is a door of its phase (S16): the phase term, never a state.
    for (const group of band.groups) expect(group.door, group.phase).toEqual({ kind: 'phase', phase: group.phase })
    // A phase the answer leaves out counts 0 (the pipeline keeps its shape: seven places).
    const short = bandOf(boardOf({ byPhase: [{ phase: 'DONE', count: 14 }] }))
    expect(short.groups.map((group) => group.count)).toEqual([0, 0, 0, 0, 0, 14, 0])
  })

  it('no order at all: seven zeros (the pipeline keeps its shape)', () => {
    const empty: Read<OrderBoard> = { status: 'ready', value: { byStatus: [], byPhase: ORDER_PHASES.map((phase) => ({ phase, count: 0 })), notSent: { waitsForYes: 0, waitsForDeposit: 0 }, lanes: [], tiles: [], asOf: '2026-11-23T09:00:00.000Z' } }
    const none = bandOf(empty)
    expect(none.groups.map((group) => group.count)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(none.total).toBe(0)
    expect(whysOf(empty)).toEqual([])
  })

  it('while the board reads, or when it could not be read: "—" in every place (never 0), the seven places kept', () => {
    for (const read of [{ status: 'reading' }, { status: 'off' }, { status: 'failed' }] as const) {
      const band = bandOf(read)
      expect(band.groups.map((group) => group.phase), read.status).toEqual([...ORDER_PHASES])
      expect(band.groups.every((group) => group.count === null), read.status).toBe(true)
      expect(band.total, read.status).toBeNull()
    }
    expect(bandOf({ status: 'failed' }).state).toBe('failed')
    expect(bandOf({ status: 'reading' }).state).toBe('reading')
  })

  it('an older answer without byPhase: six groups by state — In production whole, no "Production not started", no guess', () => {
    const band = bandOf(boardOf({}, false))
    expect(band.groups.map((group) => group.phase)).toEqual(['NOT_SENT', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE', 'CANCELLED'])
    expect(band.groups.map((group) => group.count)).toEqual([2, 5, 1, 2, 3, 1])
    expect(band.groups.reduce((sum, group) => sum + (group.count ?? 0), 0)).toBe(band.total)
    // A group of one state opens that state; a group of two states is a count with no door (never a held door).
    expect(band.groups.map((group) => group.door)).toEqual([null, { kind: 'status', status: 'IN_PRODUCTION' }, { kind: 'status', status: 'READY' }, null, null, { kind: 'status', status: 'CANCELLED' }])
    expect(whysOf(boardOf({}, false))).toEqual([])
    expect(phaseCountOf(valueOfBoard(boardOf({}, false)), 'IN_PRODUCTION')).toBeNull()
    expect(phaseCountOf(valueOfBoard(boardOf()), 'IN_PRODUCTION')).toBe(4)
    // The web's fallback reads the domain's own table of states (one rule): each state in exactly one of the six.
    const seen = ORDER_PHASES.filter((phase) => phase !== 'NOT_STARTED').flatMap((phase) => PHASE_STATUSES[phase])
    expect([...seen].sort()).toEqual([...ORDER_STATUSES].sort())
  })

  it('the API answer parses with and without the two new parts (the web never waits)', () => {
    const now = valueOfBoard(boardOf())
    const older = valueOfBoard(boardOf({}, false))
    expect(boardSchema.parse(now).byPhase).toHaveLength(7)
    expect(boardSchema.parse(now).notSent).toEqual({ waitsForYes: 1, waitsForDeposit: 1 })
    expect(boardSchema.parse(older).byPhase).toBeUndefined()
    expect(boardSchema.safeParse({ ...now, byPhase: [{ phase: 'IN_DESIGN', count: 1 }] }).success).toBe(false) // S2: no "in design" group
  })

  it('the two whys of "Not sent to the factory": each only when > 0; none: no line', () => {
    expect(whysOf(boardOf())).toEqual([{ why: 'yes', count: 1 }, { why: 'deposit', count: 1 }])
    expect(whysOf(boardOf({ notSent: { waitsForYes: 0, waitsForDeposit: 2 } }))).toEqual([{ why: 'deposit', count: 2 }])
    expect(whysOf(boardOf({ notSent: { waitsForYes: 0, waitsForDeposit: 0 } }))).toEqual([])
    expect(whysOf({ status: 'reading' })).toEqual([])
  })

  it('the group shown: its phase alone beside All orders; another view, the waiting term or the Drafts view show none', () => {
    const [notSent, , started] = bandOf(boardOf()).groups
    const view = { rows: 'all' as const, waiting: null, extra: { phase: 'NOT_SENT' as const }, drafts: false }
    expect(groupShown(notSent!, view)).toBe(true)
    expect(groupShown(started!, view)).toBe(false)
    expect(groupShown(notSent!, { ...view, extra: {} })).toBe(false)
    expect(groupShown(notSent!, { ...view, drafts: true })).toBe(false)
    expect(groupShown(notSent!, { ...view, waiting: 'us' })).toBe(false)
    expect(groupShown(notSent!, { ...view, rows: 'open' })).toBe(false)
    // An older answer's group of one state: that state's own view.
    const ready = bandOf(boardOf({}, false)).groups.find((group) => group.phase === 'READY')!
    expect(groupShown(ready, { rows: 'READY', waiting: null, extra: {}, drafts: false })).toBe(true)
    expect(groupShown(ready, { rows: 'all', waiting: null, extra: {}, drafts: false })).toBe(false)
  })
})

describe('F-CW-101: a phase is a door — ?tab=work&phase=<PHASE> (S16, S26)', () => {
  it('the door from anywhere; the entry completes it in ONE write: party and rows=all, phase kept, no sort; applied again → null', () => {
    expect(phaseDoor(BASE, 'NOT_SENT')).toBe(`${BASE}?tab=work&phase=NOT_SENT`)
    const once = workEntry(BASE, ALPHA, params(search(phaseDoor(BASE, 'NOT_SENT'))))!
    const written = new URL(`https://x${once}`).searchParams
    expect([written.get('tab'), written.get('party'), written.get('rows'), written.get('phase')]).toEqual(['work', ALPHA, 'all', 'NOT_SENT'])
    expect(written.has('sort')).toBe(false)
    expect(written.has('status')).toBe(false)
    expect(workEntry(BASE, ALPHA, params(search(once)))).toBeNull()
    expect(lockedEntry(BASE, { locked: { party: ALPHA } }, params(search(once)))).toBeNull()
    // Every phase, and a door that already names rows=all: stable (fx-12).
    for (const phase of ORDER_PHASES) {
      const first = workEntry(BASE, ALPHA, params(`tab=work&phase=${phase}`))!
      expect(new URL(`https://x${first}`).searchParams.get('rows'), phase).toBe('all')
      expect(workEntry(BASE, ALPHA, params(search(first))), phase).toBeNull()
    }
    expect(workEntry(BASE, ALPHA, params(`tab=work&party=${ALPHA}&rows=all&phase=DONE`))).toBeNull()
    // No view term at all: All orders by default, as before (no phase written).
    expect(new URL(`https://x${workEntry(BASE, ALPHA, params(''))!}`).searchParams.has('phase')).toBe(false)
  })

  it('the term: read from the address (a known phase only), written back beside rows=all, sent to the list and its totals — never to the board', () => {
    for (const phase of ORDER_PHASES) expect(extraFromAddress(params(`rows=all&phase=${phase}`), 'all').phase, phase).toBe(phase)
    expect(extraFromAddress(params('rows=all&phase=IN_DESIGN'), 'all').phase).toBeUndefined()
    expect(extraFromAddress(params('rows=all&phase=not_sent'), 'all').phase).toBeUndefined()
    expect(rowsFromAddress(params('rows=all&phase=READY'))).toBe('all')
    expect(listAddress(BASE, { rows: 'all', q: '', layout: 'list', extra: { phase: 'NOT_STARTED' } })).toBe(`${BASE}?rows=all&phase=NOT_STARTED`)
    expect(rowsQuery('all', '', null, ALPHA, { extra: { phase: 'NOT_STARTED' } })).toMatchObject({ partyId: ALPHA, phase: 'NOT_STARTED' })
    expect(boardNarrowOf({ extra: { phase: 'NOT_STARTED' } })).not.toHaveProperty('phase')
    expect(noExtra({ phase: 'DONE' })).toBe(false)
    expect(withoutExtra({ phase: 'DONE', atRisk: true }, 'phase')).toEqual({ atRisk: true })
    const api = readFileSync(new URL('../../orders/api.ts', import.meta.url), 'utf8')
    expect(api.match(/phase: query\.phase \?\? undefined/g)?.length, 'the list and its totals').toBe(2)
    // The phases are the domain's (imported, never re-written in the web).
    expect(api).toContain("export { ORDER_PHASES, type OrderPhase } from '@nexus/factory-domain/production-brand/stages'")
  })

  it('the sheet writes the door in one write: the phase alone beside rows=all, the search and the waiting term dropped', () => {
    const hook = readFileSync(new URL('../../orders/list/use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(hook).toContain("extra: phase ? { phase } : withoutExtra(extra, 'phase'),")
    expect(hook).toContain("...(phase ? { rows: 'all' as const, waiting: null, q: '' } : view ? { rows: view.rows, waiting: view.waiting ?? null } : {}),")
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("if (group.door.kind === 'phase') sheet.actions.onPhase?.(group.door.phase)")
    // Pressed while shown: all orders again; every other pick leaves the door in the same write (each view stands alone).
    expect(tab).toContain('if (shownGroup?.phase === group.phase) return showAll()')
    expect(tab).toContain('const viewRows = offPhase ? (next: RowView) => offPhase(null, { rows: next }) : onRows')
    expect(tab.match(/router\.replace\(/g)?.length, 'still one writer of the entry address').toBe(1)
  })

  it('the chip of the door: the group\'s own words (one word for one thing), "Production not started" says what it holds', () => {
    const orders = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const sheet = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    expect(extraChips({ phase: 'NOT_SENT' }, orders, sheet)).toEqual([{ key: 'phase', label: 'Not sent to the factory' }])
    expect(extraChips({ phase: 'NOT_STARTED' }, orders, sheet)).toEqual([{ key: 'phase', label: 'Production not started', note: 'in production, stage Preparing: released, nothing cut yet' }])
    expect(extraChips({ phase: 'IN_PRODUCTION' }, orders, sheet)[0]!.label).toBe(orders('rows.IN_PRODUCTION'))
    // The approved rows words where they exist; this catalogue's own for the three new groups.
    expect(ORDER_PHASES.map((phase) => phasePhrase(phase))).toEqual([{ key: 'phase.NOT_SENT' }, { key: 'phase.NOT_STARTED' }, { key: 'rows.IN_PRODUCTION', orders: true }, { key: 'rows.READY', orders: true }, { key: 'rows.SHIPPED', orders: true }, { key: 'phase.DONE' }, { key: 'rows.CANCELLED', orders: true }])
    // Every phase has its mark (told apart by word, mark and place — never by colour alone).
    for (const phase of ORDER_PHASES) expect(PHASE_ICON[phase], phase).toBeTruthy()
    const view = readFileSync(new URL('../../orders/list/view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("...(chip.key === 'phase' ? { note: model.phaseNote ?? chip.note ?? null } : {})")
  })

  it('live: a stage reached on the floor reads the board again (an order moves from "Production not started" to "In production")', () => {
    expect(sourcesTouched('brand_production.stage_reached')).toEqual(['board', 'requests'])
    expect(sourcesTouched('brand_production.health_changed')).toEqual(['requests'])
    expect(sourcesTouched('sales_order.status_changed')).toEqual(['board'])
  })
})

describe('F-CW-101: what waits — today\'s six facts as chips (the same reads, S24)', () => {
  const all = { orders: true, workorders: true, threads: true, partners: true }
  const ready = reads({
    board: boardOf(),
    requests: { status: 'ready', value: { items: [], open: 2, countered: 0 } },
    replies: { status: 'ready', value: { rows: [], count: 0, complete: true } },
    asks: { status: 'ready', value: { items: [], complete: true } },
    tasks: { status: 'ready', value: { items: [], total: 1, complete: true } },
  })

  it('six chips in today\'s order and groups; the first of each group is marked (a thin rule parts them)', () => {
    const chips = chipsOf(all, ready)
    expect(chips.map((chip) => chip.tile)).toEqual(['requests', 'replies', 'late', 'deposit', 'customer', 'tasks'])
    expect(chips.map((chip) => chip.group)).toEqual(['us', 'us', 'us', 'them', 'them', 'tasks'])
    expect(chips.map((chip) => chip.first)).toEqual([true, false, false, true, false, true])
    expect(chips.map((chip) => chip.value)).toEqual(['2', '0', '1', '0', '0', '1'])
  })

  it('Late > 0 is danger, another count > 0 a warning; 0, reading and a failed read are quiet (the number says it)', () => {
    expect(chipsOf(all, ready).map((chip) => chip.tone)).toEqual(['warning', 'quiet', 'danger', 'quiet', 'quiet', 'warning'])
    expect(chipsOf(all, reads()).every((chip) => chip.tone === 'quiet' && chip.value === '—')).toBe(true)
    const failed = chipsOf(all, { ...ready, requests: { status: 'failed' } })
    expect(failed.find((chip) => chip.tile === 'requests')).toMatchObject({ value: '!', tone: 'quiet', read: { status: 'failed' } })
    // Only that chip: the others keep their numbers ("Waiting for <customer>" adds the requests' part, so it says so too).
    expect(failed.find((chip) => chip.tile === 'late')!.value).toBe('1')
    expect(valueOf({ status: 'ready', count: 100, more: true })).toBe('100+')
  })

  it('a chip without its right is left out (no empty "0" chip); its group\'s first chip moves on', () => {
    const chips = chipsOf({ orders: false, workorders: false, threads: true, partners: false }, ready)
    expect(chips.map((chip) => [chip.tile, chip.first])).toEqual([['replies', true], ['tasks', true]])
    expect(chipsOf({ orders: false, workorders: false, threads: false, partners: false }, ready)).toEqual([])
  })

  it('"Requests to answer" opens the review window on exactly those requests (S24), never the orders view Waiting on us', () => {
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('requestsHref: firstRequest ? door.hrefOf(firstRequest) : null')
    expect(tab).toContain('const firstRequest = list.ids[0] ?? null')
    expect(tab).not.toContain("onWaiting?.('us', 'open')")
    const band = readFileSync(new URL('./view/WorkBand.tsx', import.meta.url), 'utf8')
    expect(band).toContain("if (chip.tile === 'requests' && model.requestsHref)")
    // The band draws its model and fetches nothing (a view): no API client, no session hook.
    expect(band).not.toMatch(/lib\/api\/|lib\/session\/context|fetch\(/)
  })
})

describe('F-CW-101: "Before an order" — ONE file for the rule, the reads and the doors (S27)', () => {
  const RIGHTS = { orders: true, inquiries: true, quotes: true }
  const quote = (status: string) => ({ status }) as never
  const quotes = (statuses: readonly string[], more = false) => ({ items: statuses.map(quote), problem: null, more })

  it('open quotes: the record\'s quotes in DRAFT / PENDING_APPROVAL / APPROVED / SENT; not counted while read or when more exist', () => {
    expect(openQuotesOf(quotes(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED']))).toBe(4)
    expect(openQuotesOf(quotes([]))).toBe(0)
    expect(openQuotesOf(quotes(['SENT'], true))).toBeNull()
    expect(openQuotesOf({ items: null, problem: null })).toBeNull()
  })

  it('to answer: requests NEW or ASSIGNED, plus portal orders SENT for a reader of orders — never a change request, never the tile "Waiting on us"', () => {
    const rows = [
      { kind: 'REQUEST', state: 'NEW' },
      { kind: 'REQUEST', state: 'ASSIGNED' },
      { kind: 'REQUEST', state: 'NEED_INFO' }, // waits on the customer
      { kind: 'CATALOGUE_ORDER', state: 'SENT' },
      { kind: 'CHANGE_REQUEST', state: 'OPEN' }, // the strip's "Requests to answer": a request on an ORDER
    ]
    expect(toAnswerOf(rows, { orders: true })).toBe(3)
    expect(toAnswerOf(rows, { orders: false })).toBe(2)
    expect(toAnswerOf([], { orders: true })).toBe(0)
  })

  /** A made-up API: the two interim reads, counted. */
  const apiOf = (answers: { drafts?: number | Error; incoming?: { rows: Array<{ kind: string; state: string }>; next: string | null } | Error }) => {
    const calls: string[] = []
    const api = {
      get: async (path: string, options: { query?: Record<string, unknown> }) => {
        calls.push(`${path}?${new URLSearchParams(Object.entries(options.query ?? {}).filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)])).toString()}`)
        if (path === '/sales/order-requests') {
          if (answers.drafts instanceof Error) throw answers.drafts
          return { requests: Array.from({ length: answers.drafts ?? 0 }, () => ({})) }
        }
        if (answers.incoming instanceof Error) throw answers.incoming
        return { rows: answers.incoming?.rows ?? [], counts: {}, kinds: { REQUEST: null, CATALOGUE_ORDER: null, CHANGE_REQUEST: null }, next: answers.incoming?.next ?? null, complete: true }
      },
    }
    return { api: api as never, calls }
  }

  it('each part reads its OWN right: a part without it is left out (null), and its read is never made', async () => {
    const { api, calls } = apiOf({ drafts: 2, incoming: { rows: [{ kind: 'REQUEST', state: 'NEW' }, { kind: 'CATALOGUE_ORDER', state: 'SENT' }], next: null } })
    expect(await readBeforeOrder(api, ALPHA, RIGHTS, quotes(['SENT', 'DRAFT', 'ACCEPTED']))).toEqual({ drafts: 2, toAnswer: 2, openQuotes: 2, orderWaits: null })
    expect(calls).toEqual([`/sales/order-requests?status=DRAFT&partyId=${ALPHA}`, `/sales/incoming?tile=OPEN&partyId=${ALPHA}&limit=200`])
    // The final source is NOT called before it is on main (a 404 would be noise).
    expect(calls.some((call) => call.includes('before-order'))).toBe(false)
    // No sales.inquiries.view: "to answer" is left out whole (the Incoming list is the only place that shows those rows).
    const noInquiries = apiOf({ drafts: 2, incoming: { rows: [{ kind: 'CATALOGUE_ORDER', state: 'SENT' }], next: null } })
    expect(await readBeforeOrder(noInquiries.api, ALPHA, { ...RIGHTS, inquiries: false }, quotes(['SENT']))).toEqual({ drafts: 2, toAnswer: null, openQuotes: 1, orderWaits: null })
    expect(noInquiries.calls).toEqual([`/sales/order-requests?status=DRAFT&partyId=${ALPHA}`])
    // No orders.view: no drafts, and the portal orders sent are not counted beside the requests.
    const noOrders = apiOf({ drafts: 2, incoming: { rows: [{ kind: 'REQUEST', state: 'NEW' }, { kind: 'CATALOGUE_ORDER', state: 'SENT' }], next: null } })
    expect(await readBeforeOrder(noOrders.api, ALPHA, { ...RIGHTS, orders: false }, quotes(['SENT']))).toEqual({ drafts: null, toAnswer: 1, openQuotes: 1, orderWaits: null })
    // No quotes.view: no open quotes.
    expect((await readBeforeOrder(apiOf({}).api, ALPHA, { ...RIGHTS, quotes: false }, quotes(['SENT']))).openQuotes).toBeNull()
  })

  it('never a wrong number: a failed read or more than one page of open rows leaves that part out; the others stand', async () => {
    const failed = apiOf({ drafts: new Error('down'), incoming: { rows: [{ kind: 'REQUEST', state: 'NEW' }], next: null } })
    expect(await readBeforeOrder(failed.api, ALPHA, RIGHTS, quotes(['SENT']))).toEqual({ drafts: null, toAnswer: 1, openQuotes: 1, orderWaits: null })
    const capped = apiOf({ drafts: 1, incoming: { rows: [{ kind: 'REQUEST', state: 'NEW' }], next: 'cursor' } })
    expect((await readBeforeOrder(capped.api, ALPHA, RIGHTS, quotes([]))).toAnswer).toBeNull()
  })

  it('the line: a part left out and a part that is 0 are not there; all out → no line; the doors (final addresses)', () => {
    expect(beforeLineOf(NO_BEFORE_ORDER, BASE)).toEqual([])
    expect(beforeLineOf({ drafts: 0, toAnswer: 0, openQuotes: 0, orderWaits: 0 }, BASE)).toEqual([])
    expect(beforeLineOf({ drafts: 2, toAnswer: 1, openQuotes: 3, orderWaits: null }, BASE)).toEqual([
      { part: 'drafts', count: 2, href: null }, // the Work tab's own Drafts view
      { part: 'toAnswer', count: 1, href: `${BASE}?tab=quotes&group=TO_ANSWER` },
      { part: 'openQuotes', count: 3, href: `${BASE}?tab=quotes&group=OPEN_QUOTES` },
    ])
    expect(beforeLineOf({ drafts: null, toAnswer: 0, openQuotes: 1, orderWaits: 1 }, BASE).map((part) => [part.part, part.href])).toEqual([['openQuotes', `${BASE}?tab=quotes&group=OPEN_QUOTES`], ['orderWaits', `${BASE}?tab=quotes&group=ORDER_WAITS`]])
    expect(BEFORE_GROUPS).toEqual({ toAnswer: 'TO_ANSWER', openQuotes: 'OPEN_QUOTES', orderWaits: 'ORDER_WAITS' })
    expect(quotesGroupDoor(BASE, 'OPEN_QUOTES')).toBe(`${BASE}?tab=quotes&group=OPEN_QUOTES`)
  })

  it('counted only on the Work tab, again on a draft\'s, a request\'s or a portal order\'s change; never added into the order numbers', () => {
    expect(beforeOrderTouched('inquiry.created')).toBe(true)
    expect(beforeOrderTouched('portal_order_request.sent')).toBe(true)
    expect(beforeOrderTouched('sales_order.confirmed')).toBe(false)
    const page = readFileSync(new URL('./CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain("const before = useBeforeOrder(partyId, tab === 'work' && can.orders, { orders: can.orders, inquiries: session.permissions.includes('sales.inquiries.view'), quotes: can.quotes }, record.model.quotes)")
    // The band's order numbers come from the board alone: the line's counts never enter them.
    const band = readFileSync(new URL('./work-band.ts', import.meta.url), 'utf8')
    expect(band).not.toContain('before-order')
  })
})

describe('F-CW-101: the band\'s words in both languages', () => {
  it('every key of the band, the whys in pairs, the "Before an order" parts, the phases and what each means (no key left)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      const o = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['all', 'allCount', 'pipeline', 'groupTip', 'groupOnTip', 'before.label', 'info', 'sum', 'beforeNote']) expect(t(`customers.work.band.${key}`, { customer: 'Brand Alpha', group: 'x' }), `${locale} ${key}`).not.toBe(`customers.work.band.${key}`)
      for (const why of ['yes', 'deposit']) for (const count of [1, 2]) expect(t(`customers.work.band.why.${why}`, { count }), `${locale} ${why} ${count}`).toMatch(new RegExp(`^${count} `))
      for (const part of ['drafts', 'toAnswer', 'openQuotes', 'orderWaits']) for (const count of [1, 3]) expect(t(`customers.work.band.before.${part}`, { count }), `${locale} ${part} ${count}`).toMatch(new RegExp(`^${count} `))
      for (const phase of ORDER_PHASES) {
        const words = phasePhrase(phase)
        expect(words.orders ? o(words.key) : s(words.key), `${locale} ${phase}`).not.toBe(words.key)
        expect(s(`phase.note.${phase}`), `${locale} note ${phase}`).not.toBe(`phase.note.${phase}`)
      }
    }
    const en = createTranslator('en', messagesFor('en', ['parties']).parties!)
    const it_ = createTranslator('it', messagesFor('it', ['parties']).parties!)
    // The settled words (S2, S27; 10-design §2).
    expect([en('customers.work.band.why.yes', { count: 1 }), en('customers.work.band.why.yes', { count: 2 }), en('customers.work.band.why.deposit', { count: 1 })]).toEqual(['1 waits for a yes', '2 wait for a yes', '1 waits for the deposit'])
    expect([it_('customers.work.band.why.yes', { count: 1 }), it_('customers.work.band.why.yes', { count: 2 }), it_('customers.work.band.why.deposit', { count: 1 })]).toEqual(['1 aspetta un sì', '2 aspettano un sì', "1 aspetta l'acconto"])
    expect([en('customers.work.band.before.label'), en('customers.work.band.before.drafts', { count: 2 }), en('customers.work.band.before.toAnswer', { count: 1 }), en('customers.work.band.before.openQuotes', { count: 3 }), en('customers.work.band.before.orderWaits', { count: 1 })]).toEqual(['Before an order:', '2 drafts', '1 to answer', '3 open quotes', '1 accepted, order waits'])
    expect([it_('customers.work.band.before.label'), it_('customers.work.band.before.drafts', { count: 2 }), it_('customers.work.band.before.toAnswer', { count: 1 }), it_('customers.work.band.before.openQuotes', { count: 3 }), it_('customers.work.band.before.orderWaits', { count: 2 })]).toEqual(["Prima dell'ordine:", '2 bozze', '1 da rispondere', '3 preventivi aperti', "2 accettati, l'ordine aspetta"])
    const sheetEn = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    const sheetIt = createTranslator('it', messagesFor('it', ['orders-sheet'])['orders-sheet']!)
    expect(['NOT_SENT', 'NOT_STARTED', 'DONE'].map((phase) => sheetEn(`phase.${phase}`))).toEqual(['Not sent to the factory', 'Production not started', 'Done'])
    expect(['NOT_SENT', 'NOT_STARTED', 'DONE'].map((phase) => sheetIt(`phase.${phase}`))).toEqual(['Non inviati in fabbrica', 'Produzione non iniziata', 'Conclusi'])
    // No "in design" anywhere (S2): neither a group nor a word of the band.
    expect(JSON.stringify(messagesFor('en', ['parties']).parties)).not.toMatch(/in design/i)
    expect(IN_PRODUCTION_VIEW).toBe('phase:IN_PRODUCTION')
  })
})
