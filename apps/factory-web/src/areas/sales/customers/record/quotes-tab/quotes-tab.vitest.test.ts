import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import { BEFORE_ORDER_GROUPS } from '@nexus/factory-domain/sales/before-order/groups'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { ListToolsTransport } from '../../../../../list-frame/tools/transport'
import { scopedTransport } from '../../../_shared/scoped-list-tools/ScopedListTools'
import { byRoom, datesFold, hostTier, reaches, roomTier } from '../../../_shared/list-room'
import {
  bandOf,
  closedDoorsOf,
  countsMoved,
  doorAddress,
  doorCount,
  doorOf,
  DOORS,
  groupShown,
  incomingCountsOf,
  INQUIRIES_LAYOUT_KEY,
  kindDoorCount,
  NO_DOOR,
  quoteCountsOf,
  QUOTES_LAYOUT_KEY,
  sectionCountOf,
  sectionStateOf,
  TAB_KINDS,
  tabRightsOf,
  termsOfDoor,
  toggledDoor,
  WAITS_ON_US,
} from './band'

/**
 * F-CQ-101 … 104 (customer page › Quotes & incoming, 10-design §2–§5; 13-backend ★(1), §11; settles C8, C15, C20, C25, C26, C34, C35):
 * the band from the ONE count read (life order, a group left out when the reader holds no right of it, a 0 kept), every door → exactly
 * the lists' terms (the server's own map), ✕ → the address without the door (ONE replace), the sections' heads and states (never a
 * line that lies), the live re-read of this customer only, the tab's room → the lists' tiers (never the window), each list's own
 * layout on this tab, the words in both languages. Pure helpers and sources: no DOM, nothing runs against an API.
 */

const PARTY = '0190f0e2-0000-7000-8000-00000000c1c1'
const groups = (patch: Partial<BeforeOrderCountsAnswer['groups']> = {}): BeforeOrderCountsAnswer['groups'] => ({ WRITING: 2, TO_ANSWER: 1, PREPARING: 2, APPROVAL: 1, WAITING_CUSTOMER: 1, ORDER_WAITS: 1, WON: 3, MOVED: 1, LOST: 4, ...patch })
const answer = (patch: Partial<BeforeOrderCountsAnswer> = {}): BeforeOrderCountsAnswer => ({
  partyId: PARTY,
  groups: groups(),
  openQuotes: 4,
  waitsOnUs: 2,
  byKind: {
    quotes: { PREPARING: 2, APPROVAL: 1, WAITING_CUSTOMER: 1, ORDER_WAITS: 1, WON: 1, LOST: 2 },
    requests: { TO_ANSWER: 1, WAITING_CUSTOMER: 0, WON: 1, MOVED: 1, LOST: 1 },
    portalOrders: { TO_ANSWER: 0, WON: 1, MOVED: 0, LOST: 1 },
    drafts: 2,
  },
  sampleRounds: 2,
  asOf: '2026-11-23T10:00:00.000Z',
  ...patch,
})
const OWNER = tabRightsOf(['quotes.view', 'quotes.manage', 'sales.inquiries.view', 'sales.inquiries.manage', 'orders.view', 'sales.samples.view'])
const FINANCE = tabRightsOf(['quotes.view', 'quotes.approve', 'orders.view'])
const PRODUCTION = tabRightsOf(['sales.inquiries.view', 'orders.view'])

describe('F-CQ-101: the band — the six live groups in life order, the closed three apart, every number a door', () => {
  it('groups → doors: life order, a 0 kept (the shape stays), a null left out (never "0"), the two that wait on us marked', () => {
    const band = bandOf(answer({ groups: groups({ APPROVAL: 0 }) }), OWNER, null)!
    expect(band.live.map((door) => door.group)).toEqual(['WRITING', 'TO_ANSWER', 'PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS'])
    expect(band.closed.map((door) => door.group)).toEqual(['WON', 'MOVED', 'LOST'])
    expect(band.live.find((door) => door.group === 'APPROVAL')!.count).toBe(0)
    expect(band.live.filter((door) => door.ours).map((door) => door.group)).toEqual(['TO_ANSWER', 'ORDER_WAITS'])
    expect(WAITS_ON_US).toEqual(['TO_ANSWER', 'ORDER_WAITS'])
    expect(band.samples).toBe(2)
    expect(band.total).toBe(2 + 1 + 2 + 0 + 1 + 1 + 3 + 1 + 4)
    expect(bandOf(null, OWNER, null)).toBeNull()
    // The door the lists show is marked; no samples line without its right or without a round.
    expect(bandOf(answer(), OWNER, 'TO_ANSWER')!.live.find((door) => door.active)!.group).toBe('TO_ANSWER')
    expect(bandOf(answer(), { ...OWNER, samples: false }, null)!.samples).toBeNull()
    expect(bandOf(answer({ sampleRounds: 0 }), OWNER, null)!.samples).toBeNull()
  })

  it('nothing of a kind the role does not read: Finance has no To answer / Moved (C35), the production manager no quote group', () => {
    const finance = bandOf(answer({ groups: groups({ TO_ANSWER: null, MOVED: null }) }), FINANCE, null)!
    expect(finance.live.map((door) => door.group)).toEqual(['WRITING', 'PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS'])
    expect(finance.closed.map((door) => door.group)).toEqual(['WON', 'LOST'])
    const production = bandOf(answer({ groups: groups({ PREPARING: null, APPROVAL: null, ORDER_WAITS: null }) }), PRODUCTION, null)!
    expect(production.live.map((door) => door.group)).toEqual(['WRITING', 'TO_ANSWER', 'WAITING_CUSTOMER'])
    // Even when a count comes back, a group no section of this reader shows is left out (a door must open what it counts).
    expect(groupShown('TO_ANSWER', FINANCE)).toBe(false)
    expect(groupShown('PREPARING', PRODUCTION)).toBe(false)
    expect(groupShown('WRITING', { quotes: true, requests: true, drafts: false })).toBe(false)
    expect(bandOf(answer(), { ...FINANCE, drafts: false }, null)!.live.map((door) => door.group)).not.toContain('WRITING')
  })

  it('every door → exactly the lists\' terms (the server\'s own map): a section with none of its kind folds; no door = the live rows', () => {
    expect(termsOfDoor(null)).toEqual(NO_DOOR)
    expect(NO_DOOR).toEqual({ quotes: 'LIVE', incoming: 'OPEN', drafts: true }) // F-CQ-205: the drafts section shows with no door
    expect(termsOfDoor('WRITING')).toEqual({ quotes: null, incoming: null, drafts: true })
    expect(termsOfDoor('TO_ANSWER')).toEqual({ quotes: null, incoming: 'TO_ANSWER', drafts: false })
    expect(termsOfDoor('PREPARING')).toEqual({ quotes: 'PREPARING', incoming: null, drafts: false })
    expect(termsOfDoor('APPROVAL')).toEqual({ quotes: 'APPROVAL', incoming: null, drafts: false })
    expect(termsOfDoor('WAITING_CUSTOMER')).toEqual({ quotes: 'WAITING_CUSTOMER', incoming: 'WAITING_CUSTOMER', drafts: false })
    expect(termsOfDoor('ORDER_WAITS')).toEqual({ quotes: 'ORDER_WAITS', incoming: null, drafts: false })
    expect(termsOfDoor('WON')).toEqual({ quotes: 'WON', incoming: 'ORDERED', drafts: false })
    expect(termsOfDoor('MOVED')).toEqual({ quotes: null, incoming: 'QUOTED', drafts: false })
    expect(termsOfDoor('LOST')).toEqual({ quotes: 'LOST', incoming: 'ENDED', drafts: false })
    expect(termsOfDoor('OPEN_QUOTES')).toEqual({ quotes: 'OPEN_QUOTES', incoming: null, drafts: false })
    expect(DOORS).toEqual([...BEFORE_ORDER_GROUPS, 'OPEN_QUOTES'])
    // The page term is FIXED (`?tab=quotes&group=<G>`); anything else opens no door.
    expect(doorOf(new URLSearchParams('tab=quotes&group=TO_ANSWER'))).toBe('TO_ANSWER')
    expect(doorOf(new URLSearchParams('tab=quotes&group=NOPE'))).toBeNull()
    expect(doorOf(null)).toBeNull()
    expect(doorCount(answer(), 'OPEN_QUOTES')).toBe(4)
    expect(doorCount(answer(), 'LOST')).toBe(4)
  })

  it('a door is a real link that keeps the page\'s terms; the same door again, or ✕, is the address without it (ONE replace)', () => {
    const base = `/w/DEMO/sales/customers/${PARTY}`
    const params = new URLSearchParams(`tab=quotes&dock=Quote.${PARTY}`)
    expect(doorAddress(base, params, 'TO_ANSWER')).toBe(`${base}?tab=quotes&dock=Quote.${PARTY}&group=TO_ANSWER`)
    expect(doorAddress(base, new URLSearchParams('tab=quotes&group=LOST'), null)).toBe(`${base}?tab=quotes`)
    expect(toggledDoor('LOST', 'LOST')).toBeNull()
    expect(toggledDoor('LOST', 'WON')).toBe('WON')
    expect(toggledDoor(null, 'WON')).toBe('WON')
    const hook = readFileSync(new URL('./use-quotes-tab.ts', import.meta.url), 'utf8')
    expect(hook.match(/router\.replace\(/g)?.length).toBe(1)
    // F-CQ-205: every door is this tab's own — WRITING opens the section "Customer is writing" here (no hop to the Work tab).
    expect(hook).not.toContain('draftsAddress')
    expect(doorAddress(base, new URLSearchParams('tab=quotes'), 'WRITING')).toBe(`${base}?tab=quotes&group=WRITING`)
  })
})

describe('F-CQ-101: the sections — heads that never hide a record, lines that tell the truth', () => {
  it('each kind\'s open and closed numbers (portal orders as the reader may read them, C20), its closed doors, its own number under a door', () => {
    expect(quoteCountsOf(answer())).toEqual({ open: 2 + 1 + 1 + 1, closed: 1 + 2 })
    expect(incomingCountsOf(answer())).toEqual({ open: 1 + 0 + 0, closed: 1 + 1 + 1 + 1 + 0 + 1 })
    expect(quoteCountsOf(answer({ byKind: { ...answer().byKind, quotes: null } }))).toBeNull()
    expect(incomingCountsOf(answer({ byKind: { ...answer().byKind, requests: null, portalOrders: null } }))).toBeNull()
    expect(closedDoorsOf(answer(), 'quotes')).toEqual([{ group: 'WON', count: 1 }, { group: 'LOST', count: 2 }])
    expect(closedDoorsOf(answer(), 'incoming')).toEqual([{ group: 'WON', count: 2 }, { group: 'MOVED', count: 1 }, { group: 'LOST', count: 2 }])
    expect(kindDoorCount(answer(), 'quotes', 'WAITING_CUSTOMER')).toBe(1)
    expect(kindDoorCount(answer(), 'incoming', 'WAITING_CUSTOMER')).toBe(0)
    expect(kindDoorCount(answer(), 'quotes', 'OPEN_QUOTES')).toBe(4)
    expect(kindDoorCount(answer(), 'incoming', 'PREPARING')).toBeNull()
  })

  it('a section\'s state: folded under a door without its kind, none at all, only closed ones (no door), else the list', () => {
    expect(sectionStateOf({ open: 2, closed: 1 }, true, 'TO_ANSWER')).toBe('folded')
    expect(sectionStateOf({ open: 0, closed: 0 }, false, null)).toBe('none')
    expect(sectionStateOf({ open: 0, closed: 3 }, false, null)).toBe('onlyClosed')
    expect(sectionStateOf({ open: 0, closed: 3 }, false, 'LOST')).toBe('list')
    expect(sectionStateOf({ open: 2, closed: 0 }, false, null)).toBe('list')
    // Not read yet: the list stays the judge.
    expect(sectionStateOf(null, false, null)).toBe('list')
    expect(sectionCountOf({ open: 4, closed: 7 }, 'incoming', null, null, null)).toEqual({ key: 'sec.countOpen', params: { open: 4, closed: 7 } })
    expect(sectionCountOf({ open: 7, closed: 3 }, 'quotes', null, null, null)).toEqual({ key: 'sec.countNotClosed', params: { open: 7, closed: 3 } })
    expect(sectionCountOf({ open: 7, closed: 3 }, 'quotes', 'APPROVAL', 1, 'Waiting for approval')).toEqual({ key: 'sec.countGroup', params: { count: 1, group: 'Waiting for approval' } })
    expect(sectionCountOf(null, 'quotes', null, null, null)).toBeNull()
  })

  it('the tab takes the page\'s ONE count read (F-CQ-302), with the lists\' host options; change requests are not here', () => {
    const tab = readFileSync(new URL('../QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('useQuotesTab(party.id, counts)') // F-CQ-302: the page's counts, handed in
    expect(tab).toContain("defaultSort: 'urgent'")
    expect(tab).toContain("defaultRank: 'urgent'")
    expect(tab).toContain('tiles: false')
    expect(tab).toContain('kinds: TAB_KINDS')
    expect(TAB_KINDS).toEqual(['REQUEST', 'CATALOGUE_ORDER'])
    expect(tab).toContain("columns: 'host'")
    expect(tab).toContain('liveParty: party.id')
    // Requests & portal orders first (what waits on us), then Quotes (L3).
    expect(tab.indexOf('<IncomingSection {...sections} />')).toBeLessThan(tab.indexOf('<QuotesSection {...sections} />'))
    const page = readFileSync(new URL('../CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).not.toContain('readBeforeOrderCounts')
  })

  it('the live re-read: a quote, a request or a portal order (its draft too) of THIS customer, coalesced; never another customer\'s', () => {
    expect(countsMoved({ type: 'quote.sent', fields: { quoteId: 'q-1' } }, PARTY)).toBe(true)
    expect(countsMoved({ type: 'inquiry.changed', fields: { partyId: PARTY } }, PARTY)).toBe(true)
    expect(countsMoved({ type: 'inquiry.changed', fields: { partyId: 'another' } }, PARTY)).toBe(false)
    expect(countsMoved({ type: 'portal_order_request.draft_changed', fields: { requestId: 'd-1' } }, PARTY)).toBe(true)
    expect(countsMoved({ type: 'sales_order.created', fields: {} }, PARTY)).toBe(false)
  })
})

describe('F-CQ-104: the tab\'s room → the lists\' columns (never the window); each list\'s own layout on this tab', () => {
  it('tiers by the list\'s own room: S < 720 · M− 720–839 (779: the date folds) · M 840–1199 (863, 1185) · L ≥ 1200 (1314) · XL ≥ 1600 (1794)', () => {
    expect([343, 779, 863, 1067, 1185, 1312, 1794].map(roomTier)).toEqual(['S', 'M-', 'M', 'M', 'M', 'L', 'XL'])
    expect(roomTier(null)).toBeNull()
    expect(hostTier(null)).toBe('M')
    expect(datesFold('M-')).toBe(true)
    expect(datesFold('M')).toBe(false)
    expect(reaches('L', 'M')).toBe(true)
    expect(reaches('M', 'L')).toBe(false)
    // A column the room leaves out: hidden and an opt-in choice in Customise ("In view" counts only what is shown, P0-B5).
    const column = { colId: 'updated', headerName: 'Updated' }
    // cq fx2 W-02: a shown column says it is shown (the grid would keep a hidden state when the room grows live).
    expect(byRoom(column, true)).toEqual({ ...column, hide: false })
    expect(byRoom(column, false, 'Updated (from a wider list)')).toEqual({ colId: 'updated', headerName: 'Updated', hide: true, context: { optIn: true, toolLabel: 'Updated (from a wider list)' } })
  })

  it('the wrapper maps only the layout key (views, exports, fields pass through): a Sales › Quotes layout never touches the tab', () => {
    const read: string[] = []
    const written: string[] = []
    const parent = {
      pageKey: null,
      query: 'tab=quotes',
      linked: { view: 'v-1', export: 'e-1' },
      goTo: () => undefined,
      readLayout: (key: string) => (read.push(key), null),
      writeLayout: (key: string) => void written.push(key),
      listViews: (key: string) => Promise.resolve({ key }),
    } as unknown as ListToolsTransport
    const scoped = scopedTransport(parent, { listKey: 'sales.quotes', page: '/w/DEMO/sales/quotes', query: `party=${PARTY}`, goTo: () => undefined, layoutKey: QUOTES_LAYOUT_KEY })
    scoped.readLayout('sales.quotes')
    scoped.writeLayout('sales.quotes', null)
    scoped.readLayout('sales.quotes.2')
    expect(read).toEqual([QUOTES_LAYOUT_KEY, 'sales.quotes.2'])
    expect(written).toEqual([QUOTES_LAYOUT_KEY])
    expect(scoped.pageKey).toBe('sales.quotes')
    expect(scoped.listViews).toBe(parent.listViews)
    // Without a layout key the wrapper is as it was (Sales › Quotes, a second list).
    const plain = scopedTransport(parent, { listKey: 'sales.quotes', page: '/w/DEMO/sales/quotes', query: '', goTo: () => undefined })
    expect(plain.readLayout).toBe(parent.readLayout)
    expect([QUOTES_LAYOUT_KEY, INQUIRIES_LAYOUT_KEY]).toEqual(['sales.quotes:customer-quotes', 'sales.inquiries:customer-quotes'])
    const tab = readFileSync(new URL('../QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('layoutKey={QUOTES_LAYOUT_KEY}')
    expect(tab).toContain('layoutKey={INQUIRIES_LAYOUT_KEY}')
  })

  it('the room is the tab root\'s own (a ResizeObserver), never the window; the head\'s New windows set the customer', () => {
    const hook = readFileSync(new URL('./use-quotes-tab.ts', import.meta.url), 'utf8')
    expect(hook).toContain('new ResizeObserver(')
    expect(hook).not.toContain('matchMedia')
    expect(hook).not.toContain('window.innerWidth')
    const quotes = readFileSync(new URL('../../../quotes/list/use-quotes-list.ts', import.meta.url), 'utf8')
    expect(quotes).toContain('if (open && lock) pick(lock)')
    const request = readFileSync(new URL('../../../inquiries/use-new-request.ts', import.meta.url), 'utf8')
    expect(request).toContain("withWho(emptyNewRequest(DEFAULT_CURRENCY), 'customer', startParty)")
  })
})

describe('F-CQ-101: the words in both languages (before-order.json; no key left, every placeholder said)', () => {
  it('every group, its why, the band\'s and the sections\' words', () => {
    for (const locale of LOCALES) {
      const b = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      const params = { customer: 'Seed Racing', count: 3, group: 'To answer', who: 'us', open: 4, closed: 7 }
      for (const door of DOORS) {
        expect(b(`group.${door}`, params), `${locale} group.${door}`).not.toBe(`group.${door}`)
        expect(b(`door.why.${door}`), `${locale} door.why.${door}`).not.toBe(`door.why.${door}`)
      }
      for (const key of ['band.title', 'band.pipeline', 'band.closed', 'band.newRequest', 'band.newRequestShort', 'band.newQuote', 'band.newQuoteShort', 'band.segTitle', 'band.segTitleClosed', 'band.everything' /* F-CQ-B: the phone's button */, 'band.waitsOn' /* F-CQ-B fx1: said on the phone */, 'band.who.us', 'band.who.customer', 'band.who.approver', 'band.info', 'band.failed', 'band.retry', 'door.showAll' /* F-CQ-B fx1: door.close left with the old ✕ link (the sheet's chip names itself) */, 'sec.incoming', 'sec.countOpen', 'sec.countNotClosed', 'sec.countGroup', 'empty.tab', 'empty.tabBody', 'empty.incomingNone', 'empty.quotesNone', 'empty.incomingNoLive', 'empty.closedDoors', 'fold.incoming', 'fold.quotes', 'fold.drafts', 'note.noRequests', 'note.noQuotes', 'foot.closedLeftOut', 'foot.door']) {
        const line = b(key, params)
        expect(line, `${locale} ${key}`).not.toBe(key)
        expect(line, `${locale} ${key}`).not.toContain('{')
      }
      for (const count of [1, 2]) expect(b('band.samples', { count }), `${locale} samples ${count}`).not.toContain('{')
      // C4 / C32: no approver role named anywhere in the band's words.
      expect(b('door.why.APPROVAL'), locale).not.toMatch(/Finance|Amministrazione|Owner|Titolare/)
    }
    const it = createTranslator('it', messagesFor('it', ['before-order'])['before-order']!)
    expect(it('group.WAITING_CUSTOMER', { customer: 'Seed Racing' })).toBe('In attesa di Seed Racing')
    expect(it('band.newQuoteShort')).toBe('Nuovo preventivo…')
  })
})

// ---- F-CQ-205 (customer page › Quotes & incoming, 10-design §3.5; settles C3, C14): "Customer is writing" — the drafts section on this
// tab (the Work tab's own parts mounted here, read only), read only while it shows, never counted but in WRITING.
describe('F-CQ-205: the drafts section', () => {
  const tab = readFileSync(new URL('../QuotesIncomingTab.tsx', import.meta.url), 'utf8')
  it('mounted with the drafts\' right (orders.view), last; read only while it shows and the counts say there is one', () => {
    expect(tab).toContain('{tab.rights.drafts && <DraftsSection {...sections} />}')
    expect(tab.indexOf('<QuotesSection {...sections} />')).toBeLessThan(tab.indexOf('<DraftsSection {...sections} />'))
    expect(tab).toContain('const showing = tab.terms.drafts && !hidden && count !== 0')
    expect(tab).toContain('useCustomerDrafts(party.id, showing, untitled)')
    // One list, no copy: the Work tab's list and window; no Views ▾ here; each draft's garment (the portalOrder picture source).
    expect(tab).toContain('<CustomerDraftsList')
    expect(tab).toContain('<DraftWindow')
    expect(tab).toContain("pictures: { read: readPictures, header: b('drafts.picture') }")
    const list = readFileSync(new URL('../drafts/view/CustomerDraftsList.tsx', import.meta.url), 'utf8')
    expect(list).not.toContain('readonly views?:') // F-CQ-303: no Views ▾ at all (the Work tab's Drafts view left)
    expect(list).toContain('source="portalOrder"')
  })
  it('the words in both languages', () => {
    for (const locale of LOCALES) {
      const b = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      for (const key of ['sec.writingSub', 'drafts.picture', 'fold.drafts']) expect(b(key, { customer: 'Seed Racing' }), `${locale} ${key}`).not.toContain('{')
    }
  })
})
// ---- end F-CQ-205

// ---- cq T (customer page › Quotes & incoming, 15-steps T.1): the gallery — the tab's REAL parts (one set: the live tab and the
// gallery draw the same frame, sections and drafts frame), every case the plan lists, each window built from the real acts, each
// role's rights from its own template; the Quotes list's Sort ▾ and chips cases, Incoming's To answer and held-rank cases.
import { designScreen as tabScreen, type QuotesTabCase } from './fixtures'
import { CHIP_ROWS, designScreen as quotesScreen } from '../../../quotes/list/fixtures'
import { designScreen as incomingScreen } from '../../../inquiries/fixtures'
import { quoteWhereOf } from '../../../quotes/model'
import { INCOMING_ROWS, listOf } from '../../../inquiries/demo/fixtures'

describe('cq T: the tab\'s gallery', () => {
  const ids = tabScreen.cases.map((item) => item.id)
  const of = (id: string): QuotesTabCase => tabScreen.cases.find((item) => item.id === id)!.model

  it('every case T.1 lists: the data, the doors, each role, each bar, every window, the menus, the widths', () => {
    const wanted = [
      'busy', 'drafts-only', 'nothing', 'all-closed', 'door-to-answer', 'door-lost', 'door-writing',
      'role-sales', 'role-finance', 'role-viewer', 'role-production',
      'bar-owner-quotes', 'bar-owner-incoming', 'bar-sales', 'bar-finance', 'bar-viewer', 'bar-production',
      'win-cancel', 'win-ask-approval', 'win-make-orders', 'win-new-link', 'win-mark-lost', 'win-ask-about', 'win-receipt', 'win-assign', 'win-decline', 'win-add-task',
      'win-make-quote', 'win-decline-one', 'win-accept-order', 'win-accept-quote', 'win-refuse', 'win-revise-expired', 'win-approve', 'win-reject',
      'more-quotes', 'more-incoming', 'row-menu', 'sort', 'customise', 'phone', 'room-779', 'room-863', 'room-1067', 'dark',
    ]
    for (const id of wanted) expect(ids, id).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(tabScreen.screen).toBe('SCR-033-quotes')
  })

  it('the counts are the server\'s own sums (each door = its rows); a kind the role does not read is null, never 0', () => {
    const busy = of('busy').counts!
    expect(busy.groups).toMatchObject({ WRITING: 2, TO_ANSWER: 3, PREPARING: 2, APPROVAL: 1, WAITING_CUSTOMER: 2, ORDER_WAITS: 1, WON: 1, MOVED: 2, LOST: 3 })
    expect(busy.waitsOnUs).toBe(4)
    expect(of('busy').quotes.rows.items).toHaveLength(5)
    expect(of('busy').incoming.list?.rows).toHaveLength(4)
    expect(of('role-finance').counts!.byKind.requests).toBeNull()
    expect(of('role-production').counts!.byKind.quotes).toBeNull()
  })

  it('each window is the real act at a step: its plan, its "Not on (why)", its receipt', () => {
    expect(of('win-cancel').quotes.many!.plan.runs).toHaveLength(2)
    expect(of('win-cancel').quotes.many!.plan.notOn.map((one) => one.why.key)).toEqual(['acts.why.quoteClosed'])
    const orders = of('win-make-orders').quotes.many!
    expect(orders.plan.runs.map((one) => !!one.field)).toEqual([true, false])
    expect(orders.plan.notOn.map((one) => one.why.key)).toEqual(['list.where.orderWaits.ACCOUNT_ON_HOLD', 'acts.why.hasOrder'])
    expect(of('win-mark-lost').incoming.many!.plan.notOn.map((one) => one.why.key)).toEqual(['acts.why.portalOwn'])
    expect(of('win-ask-about').incoming.many!.plan.notOn.map((one) => one.why.key)).toEqual(['acts.why.askedAlready'])
    expect(of('win-receipt').quotes.many!.receipt).toEqual({ done: 1, left: 1, rest: [expect.any(String)] })
    expect(of('win-add-task').quotes.tasks!.records).toHaveLength(3)
    expect(of('win-make-quote').incoming.verb!.dialog).toMatchObject({ kind: 'quote' })
    expect(of('win-refuse').incoming.catalogueVerb!.dialog).toMatchObject({ kind: 'refuse' })
    expect(of('win-revise-expired').quotes.quoteDialog!.quote.current.status).toBe('EXPIRED')
    // The windows open on the page's customer (never another demo customer's name).
    expect(of('win-make-quote').incoming.verb!.loaded).toMatchObject({ status: 'ready', value: { fromWords: 'Seed Customer One' } })
  })

  it('the live tab and the gallery draw the same parts (no copy of the frame in the gallery)', () => {
    const live = readFileSync(new URL('../QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(live).toContain('<QuotesTabFrame')
    expect(live).toContain('<TabSection kind="quotes"')
    expect(live).toContain('<TabSection kind="incoming"')
    expect(live).toContain('<DraftsFrame')
    expect(live).not.toContain('function SectionHead')
    expect(live).not.toContain('function ClosedDoors')
    const gallery = readFileSync(new URL('./fixtures.ts', import.meta.url), 'utf8')
    expect(gallery).toContain('createElement(QuotesTabFrame')
    expect(gallery).toContain("createElement(TabSection, { kind: 'incoming'")
    expect(gallery).toContain('manyActModelOf(')
    const hook = readFileSync(new URL('../../../_shared/many-acts/use-many-act.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const model: ManyActModel | null = state ? manyActModelOf(state) : null')
  })

  it('the lists\' own galleries: Sort ▾ Most urgent first and every chip of a quote; To answer and the held rank', () => {
    const quoteIds = quotesScreen.cases.map((item) => item.id)
    expect(quoteIds).toEqual(expect.arrayContaining(['sort-urgent', 'chips']))
    const keys = new Set(CHIP_ROWS.flatMap((row) => quoteWhereOf(row, '2026-10-29', 'Seed Customer One').chips.map((one) => one.key)))
    for (const key of ['list.where.approvalRejected', 'list.where.holdsSent', 'list.where.approval', 'list.where.approvedReady', 'list.where.endsIn', 'record.validEnded', 'list.where.remindedOn', 'list.where.acceptedOrder', 'list.where.acceptedWaits', 'list.where.declined', 'status.EXPIRED']) expect([...keys], key).toContain(key)
    const incomingIds = incomingScreen.cases.map((item) => item.id)
    expect(incomingIds).toEqual(expect.arrayContaining(['tile-to-answer', 'urgent-held']))
    // The demo counts carry the two new tiles, counted from the rows by the rules' table.
    const counts = listOf().counts
    expect(counts.TO_ANSWER).toBe(INCOMING_ROWS.filter((one) => ['NEW', 'ASSIGNED', 'SENT', 'OPEN'].includes(one.state)).length)
    expect(counts.ENDED).toBe(INCOMING_ROWS.filter((one) => ['DECLINED', 'LOST', 'REFUSED', 'WITHDRAWN'].includes(one.state)).length)
  })
})
// ---- end cq T

// ---- cq W3 (customer page › Quotes & incoming, 15-steps W3; 13-backend R13–R17): the Work lane's files — P0-B2 (one shown tab), the
// dock a third, the page's ONE count read (the badge = what waits on us; the band and the Work line read it), the drafts left the Work
// tab (its line's door → WRITING), Reply to N given a record type on both bars and rows, the dock's door line, the dead keys out.
import { recordTabs, shownTab, SIDES, OPEN_QUOTES as PARTY_OPEN_QUOTES } from '../../../../parties/_shared/model'
import { OPEN_QUOTES as DOMAIN_OPEN_QUOTES } from '@nexus/factory-domain/sales/before-order/groups'
import { RECORD_CAN } from '../../../../parties/_shared/fixtures'
import { pageCountsMoved } from './use-before-order-counts'
import { incomingLinksOf, quoteLinksOf } from './links'
import { quoteBarOf, quoteRightsOf } from '../../../quotes/list/bar'
import { designScreen as galleryScreen } from './fixtures'

describe('cq W3: the page around the tab', () => {
  it('F-CQ-301 (P0-B2): one shown tab — the asked one when the reader sees it, else the first; the page and the view read the same rule', () => {
    const warehouse = recordTabs(SIDES.customers, { ...RECORD_CAN, quotes: false, inquiries: false, orders: true })
    expect(warehouse).not.toContain('quotes')
    expect(shownTab(warehouse, 'quotes')).toBe(warehouse[0])
    expect(shownTab(recordTabs(SIDES.customers, { ...RECORD_CAN, inquiries: true }), 'quotes')).toBe('quotes')
    expect(shownTab([], 'quotes')).toBe('overview')
    const page = readFileSync(new URL('../CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain('const tab = shownTab(recordTabs(SIDES.customers, can), record.model.tab)')
    const view = readFileSync(new URL('../view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const tab: RecordTab = shownTab(tabs, model.tab)')
    expect(view).toContain("defaultWidth={tab === 'work' || tab === 'quotes' || tab === 'overview' || tab === 'money' || tab === 'people' || tab === 'terms' ? 'third' : undefined}") // F-CO-103 (S13): the Overview a third too; F-CM-104 (D2): Money a third too; F-CA-119 (D2): People a third too; F-CT-406 (D3): Terms a third too — Portal stays 40 %
  })

  it('F-CQ-302: the page reads the counts ONCE (every tab); the badge = what waits on us there, marked; the band and the Work line read it', () => {
    const page = readFileSync(new URL('../CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain('const pageCounts = useBeforeOrderCounts(partyId, record.party !== null && record.party !== undefined)')
    expect(page).toContain('const quotesBadge = pageCounts.counts ? { count: pageCounts.counts.waitsOnUs, attention: (pageCounts.counts.waitsOnUs ?? 0) > 0 } : null')
    expect(page).not.toContain('useBeforeOrder(')
    const hook = readFileSync(new URL('./use-quotes-tab.ts', import.meta.url), 'utf8')
    expect(hook).not.toContain('readBeforeOrderCounts')
    expect(hook).toContain('const { counts, failed, onRetry } = page')
    const view = readFileSync(new URL('../view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("...(id === 'quotes' && quotesBadge?.attention ? {")
    // Read again on THIS customer's quote / request / portal order, and on every order event (the Work line's rule); never another's.
    const fields = (partyId: string) => ({ partyId })
    expect(pageCountsMoved({ type: 'quote.sent', fields: fields(PARTY) }, PARTY)).toBe(true)
    expect(pageCountsMoved({ type: 'quote.sent', fields: fields('another') }, PARTY)).toBe(false)
    expect(pageCountsMoved({ type: 'sales_order.confirmed', fields: {} }, PARTY)).toBe(true)
    expect(pageCountsMoved({ type: 'product.updated', fields: {} }, PARTY)).toBe(false)
    // OPEN_QUOTES: the domain's one list (the parties model no longer keeps its own).
    expect([...PARTY_OPEN_QUOTES].sort()).toEqual([...DOMAIN_OPEN_QUOTES].sort())
  })

  it('F-CQ-303: the drafts left the Work tab — no view, no list, no window there; the line\'s and the empty line\'s door go to WRITING', () => {
    const tab = readFileSync(new URL('../view/WorkTab.tsx', import.meta.url), 'utf8')
    for (const gone of ['DRAFTS_VIEW', 'useCustomerDrafts', '<CustomerDraftsList', '<DraftWindow', 'draftsAddress']) expect(tab, gone).not.toContain(gone)
    expect(tab).toContain("href: quotesGroupDoor(`${prefix}${basePath}`, 'WRITING')")
    const band = readFileSync(new URL('../view/WorkBand.tsx', import.meta.url), 'utf8')
    expect(band).not.toContain('onDrafts')
  })

  it('F-CQ-304: Ask / Reply to N leads the Quotes bar (rights from the session), the Incoming bar has Reply under More ▾, each row "Reply to <customer>…"', () => {
    const rights = quoteRightsOf(['threads.post', 'partners.tasks.manage', 'tasks.manage'], { manage: false, send: false }, { price: false })
    expect(rights).toMatchObject({ threads: true, customerTasks: true, tasks: true })
    expect(quoteBarOf(rights, [{ status: 'DRAFT', order: null, versionId: null, partyId: PARTY }], 'Seed Customer One').promoted.map((act) => act.id)).toEqual(['ask', 'addTask'])
    const quotes = readFileSync(new URL('../../../quotes/list/use-quotes-list.ts', import.meta.url), 'utf8')
    expect(quotes).toContain("const onReply = (picked: readonly QuoteListRow[], ask: boolean) => reply.open(picked, lock, { todo: ask, recordType: 'Quote' })")
    // Hooks before the model reads them (the lead's lesson of fx1): the window's hook stands above `const model`.
    expect(quotes.indexOf('const reply = useReplyMany(')).toBeLessThan(quotes.indexOf('const model: QuotesListViewModel = {'))
    const incoming = readFileSync(new URL('../../../inquiries/use-inquiries-list.ts', import.meta.url), 'utf8')
    expect(incoming).toContain('const onReply = (rows: readonly IncomingRow[]) => reply.open(rows.map(replyRowOf), lock, { recordType: replyTypeOf(rows) })')
    expect(incoming.indexOf('const reply = useReplyMany(')).toBeLessThan(incoming.indexOf('const model: InquiriesModel = {'))
    for (const view of ['../../../quotes/list/view/QuotesListView.tsx', '../../../inquiries/view/InquiriesView.tsx']) {
      const source = readFileSync(new URL(view, import.meta.url), 'utf8')
      expect(source, view).toContain('{model.reply && <ReplyManyDialog model={model.reply} actions={actions?.reply} />}')
      // cq fx5 (W3-2): the row's Reply is held with the Reply window's no-portal words — one held-item helper in both views.
      expect(source, view).toContain("heldRowItem('reply', t(")
    }
    expect(galleryScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['win-ask-quotes', 'win-reply-requests']))
    const ask = galleryScreen.cases.find((item) => item.id === 'win-ask-quotes')!.model.quotes.reply!
    expect([ask.recordType, ask.asked, ask.todo?.on, ask.targets.every((target) => target.recordType === 'Quote')]).toEqual(['Quote', true, true, true])
  })

  it('F-CQ-305: the dock\'s door line from the row\'s own data (a click docks that record); the dead keys out of parties', () => {
    const quote = quoteLinksOf({ companyId: 'c', madeFrom: { inquiryId: 'i1', number: 'SEED-INQ-0005' }, fromPortalOrder: null, order: { state: 'MADE', id: 'o1', number: 'SEED-SO-0150', status: 'CONFIRMED', reason: null, words: null } })
    expect(quote.map((link) => [link.kind, link.pick.type, link.pick.label])).toEqual([['cameFromRequest', 'Inquiry', 'SEED-INQ-0005'], ['becameOrder', 'SalesOrder', 'SEED-SO-0150']])
    expect(quoteLinksOf({ companyId: 'c', madeFrom: undefined, fromPortalOrder: { id: 'p1', number: 'SEED-RQ-0086' }, order: null }).map((link) => link.kind)).toEqual(['cameFromPortal'])
    expect(quoteLinksOf({ companyId: 'c', madeFrom: undefined, fromPortalOrder: null, order: { state: 'WAITS', id: null, number: null, status: null, reason: 'NOT_MADE', words: null } })).toEqual([])
    expect(incomingLinksOf({ companyId: 'c', request: null, catalogueOrder: { quote: { id: 'q1', number: 'SEED-QT-0012' }, salesOrder: null } as never }).map((link) => link.kind)).toEqual(['becameQuote'])
    const work = readFileSync(new URL('../view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(work).toContain('onClick={() => dock.onRow(link.pick)}')
    expect(work).toContain("{b(`dock.${link.kind}`, { number: link.pick.label })}")
    const tab = readFileSync(new URL('../QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('links: quoteLinksOf(row) /* F-CQ-305 */')
    expect(tab).toContain('links: incomingLinksOf(row) /* F-CQ-305 */')
    for (const locale of LOCALES) {
      const b = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      for (const key of ['dock.cameFromRequest', 'dock.cameFromPortal', 'dock.becameQuote', 'dock.becameOrder']) expect(b(key, { number: 'SEED-QT-0012' }), `${locale} ${key}`).toContain('SEED-QT-0012')
      const parties = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      for (const key of ['customers.quotesTab.incoming', 'customers.quotesTab.noQuotes', 'customers.quotesTab.noRequests']) expect(parties(key), `${locale} ${key}`).toBe(key)
    }
  })

  it('T part 2: the customer page\'s gallery mounts the tab (its own parts) for its customer; the Work cases\' drafts are on Quotes & incoming', () => {
    const gallery = readFileSync(new URL('../fixtures.ts', import.meta.url), 'utf8')
    expect(gallery).toContain('createElement(QuotesTabDesign, { model: quotesTabFor({ id: record.party.id, name: record.party.tradeName ?? record.party.legalName }) })')
    expect(gallery).toContain("{ tab: 'quotes', can: { ...RECORD_CAN, inquiries: true } }) },")
    expect(gallery).not.toContain('DRAFTS_VIEW')
    expect(gallery).toContain("href: quotesGroupDoor(recordHref, 'WRITING')")
    // The golden step: the band, a door's count = its rows, Sort ▾, one ticked quote's bar; nothing written.
    const golden = readFileSync(new URL('../../../../../../tests/golden-flow/01-customer.ts', import.meta.url), 'utf8')
    expect(golden).toContain("await sales.go(`/sales/customers/${P1}?tab=quotes`)")
    expect(golden).toContain("expect(written, 'nothing was written').toEqual([])")
    expect(golden.indexOf('// ---- cq T.2')).toBeGreaterThan(golden.indexOf('// ---- end cw T.2'))
  })
})
// ---- end cq W3

// ---- cq fx2 (customer page › Quotes & incoming, 30-walk.md W-01 … W-17): the walk's gaps, each fixed where the walk read its cause.
import { SectionFoot } from './view/QuotesTabParts'
import { sectionStateIn, type Door } from './band'
import { countKeyOf, taskWordsOf } from '../../../inquiries/view/InquiriesView'

describe('cq fx2: the walk\'s gaps', () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const quotesView = src('../../../quotes/list/view/QuotesListView.tsx')
  const incomingView = src('../../../inquiries/view/InquiriesView.tsx')
  const frame = src('../../../../../list-frame/ListFrame.tsx')

  it('W-01: a phone card\'s title is the number — the thread door sits on New messages, never on the number column', () => {
    expect(quotesView).toContain("cardDoor: model.cardDoor ? { column: 'newMessages'")
    expect(incomingView).toContain("column: model.columns === 'host' ? 'newMessages'")
    expect(quotesView).toContain("number: { role: 'title' as const }")
    expect(incomingView).toContain("number: { role: 'title' as const }")
  })

  it('W-02: a room column shown again after the dock closes says so (the grid kept "hidden"; Customise counted it)', () => {
    const column = { colId: 'validUntil', headerName: 'Valid until' }
    const narrow = byRoom(column, false, 'Valid until (from a wider list)')
    expect(narrow.hide).toBe(true)
    expect(byRoom(column, true).hide).toBe(false)
  })

  it('W-03: a door that holds none of a kind folds that list to its quiet line (never "No quotes yet" for a customer who has them)', () => {
    const counts = answer()
    const tab = (door: Door) => ({ counts, door, terms: termsOfDoor(door) })
    // Lost: the customer lost 2 quotes and 1 request — both lists show; To answer: 1 request, no quote group.
    expect(kindDoorCount(counts, 'quotes', 'WAITING_CUSTOMER')).toBe(1)
    expect(sectionStateIn(tab('WAITING_CUSTOMER'), 'incoming')).toBe('folded') // requests WAITING_CUSTOMER: 0 in the answer
    expect(sectionStateIn(tab('WAITING_CUSTOMER'), 'quotes')).toBe('list')
    expect(sectionStateIn(tab('TO_ANSWER'), 'incoming')).toBe('list')
  })

  it('W-04: "Customer is writing" fits the tab\'s room — Files and Wanted by from 1000 px, two-fact cells wrap, nothing cut', () => {
    const list = src('../drafts/view/CustomerDraftsList.tsx')
    expect(list).toContain('const roomy = model.room === undefined || model.room === null || model.room >= 1000')
    for (const id of ['files', 'wanted']) expect(list.slice(list.indexOf(`colId: '${id}'`)).split('colId:')[1], id).toContain('hide: !roomy')
    const narrow = ['draft', 'lines', 'ready', 'changed', 'more'].map((id) => Number(list.slice(list.indexOf(`colId: '${id}'`)).match(/minWidth: (\d+)/)![1]))
    expect(narrow.reduce((sum, width) => sum + width, 0) + 76 /* the Picture */).toBeLessThanOrEqual(779 - 40)
    expect(src('../QuotesIncomingTab.tsx')).toContain('room: tab.room /* cq fx2 W-04 */')
    expect(src('./quotes-tab.css')).toContain('.fw-cwd-cell.is-wrap .fw-cwd-sub')
  })

  it('W-05: narrow headers whole — New messages draws its icon (its words its name), ⋯ draws no word and keeps its button whole', () => {
    for (const view of [quotesView, incomingView]) {
      expect(view).toContain('headerComponent: MessagesHeader /* cq fx2 W-05 */')
      expect(view).toContain('cellClass: MORE_CELL')
    }
    const heads = src('../../../_shared/list-heads/list-heads.css')
    expect(heads).toContain('.ag-header-cell.fw-list-more .ag-header-cell-text')
  })

  it('W-06: the draft window draws no decision, names the customer as the page does and shows the draft\'s garment', () => {
    const window = src('../drafts/view/DraftWindow.tsx')
    expect(window).toContain('customer: model.customer, ...(model.picture ? { picture: model.picture } : {})')
    const pane = src('../../../inquiries/view/pane/catalogue/CataloguePane.tsx')
    expect(pane).toContain('<span className="fw-rp-who">{model.draft?.customer ?? request.party.name}</span>')
    expect(pane).toContain('{model.draft?.picture ?? <ShoppingCart size={16} />}')
  })

  it('W-07: words by kind — "1 portal order", "2 requests", "3 requests and portal orders"; the task window too', () => {
    const r = (kind: 'REQUEST' | 'CATALOGUE_ORDER' | 'CHANGE_REQUEST') => ({ kind })
    expect(countKeyOf([r('REQUEST'), r('REQUEST')])).toBe('list.count')
    expect(countKeyOf([r('CATALOGUE_ORDER')])).toBe('list.countPortal')
    expect(countKeyOf([r('REQUEST'), r('CATALOGUE_ORDER')])).toBe('list.countMixed')
    expect(countKeyOf([r('REQUEST'), r('CHANGE_REQUEST')])).toBe('list.countAny')
    expect(countKeyOf([])).toBe('list.count')
    expect(taskWordsOf([{ type: 'Inquiry' }, { type: 'Inquiry' }])).toBe('tasks.request')
    expect(taskWordsOf([{ type: 'PortalOrderRequest' }])).toBe('tasks.portal')
    expect(taskWordsOf([{ type: 'Inquiry' }, { type: 'PortalOrderRequest' }])).toBe('tasks.incoming')
    for (const locale of LOCALES) {
      const inq = createTranslator(locale, messagesFor(locale, ['sales-inquiries'])['sales-inquiries']!)
      for (const key of ['list.countPortal', 'list.countChange', 'list.countMixed', 'list.countAny']) for (const count of [1, 2]) expect(inq(key, { count }), `${locale} ${key}`).toContain(String(count))
      const b = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      expect(b('tasks.request.title', { count: 2 }), locale).not.toMatch(/portal/i)
      for (const noun of ['portal', 'incoming']) for (const key of ['title', 'assigneeHint', 'supervisor', 'noSupervisor', 'where', 'held.none', 'held.tooMany', 'made', 'due']) expect(b(`tasks.${noun}.${key}`, { count: 2, max: 50, name: 'x', date: 'y' }), `${locale} ${noun} ${key}`).not.toMatch(/tasks\.[a-z]|\{/)
    }
  })

  it('W-08: under Rows: All nothing is "left out" — the head counts every state, the closed foot goes', () => {
    const tab = { counts: answer(), failed: false, door: null, terms: NO_DOOR, rights: OWNER, room: 1000, hrefs: {} as never, everything: '', prefix: '/w/DEMO' }
    expect(SectionFoot({ kind: 'incoming', customer: 'Seed Racing', tab, every: true })).toBeNull()
    expect(SectionFoot({ kind: 'incoming', customer: 'Seed Racing', tab: { ...tab, door: 'LOST' }, every: false })).toBeNull()
    expect(SectionFoot({ kind: 'incoming', customer: 'Seed Racing', tab, every: false })).not.toBeNull()
    const parts = src('./view/QuotesTabParts.tsx')
    expect(parts).toContain("const count = all ? { key: 'sec.countAll', params: { count: all.open + all.closed } }")
    const live = src('../QuotesIncomingTab.tsx')
    expect(live).toContain("const incomingEvery = model.address.tile === 'ALL'")
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)('sec.countAll', { count: 7 }), locale).toContain('7')
  })

  it('W-09: the Kind option is short (the why in its title); one customer\'s search names no customer', () => {
    expect(incomingView).toContain("<option value=\"\" disabled title={t('list.kindNotHereHint')}>")
    expect(incomingView).toContain("placeholder={model.locked ? t('list.searchHost') : t('list.search')")
    for (const locale of LOCALES) {
      const inq = createTranslator(locale, messagesFor(locale, ['sales-inquiries'])['sales-inquiries']!)
      expect(inq('list.kindNotHere').length, locale).toBeLessThanOrEqual(32)
      expect(inq('list.kindNotHereHint'), locale).not.toBe('list.kindNotHereHint')
    }
  })

  it('W-10 / W-11: the change request\'s door asks no engine task first; its kind is said once in its chip', () => {
    expect(src('../../../../home/approvals/Approvals.tsx')).toContain('tasks: can.tasks && controls.kind !== REQUEST_INBOX_KIND')
    expect(incomingView).toContain("if (chip.key === 'where.kindState' && typeof chip.params?.kind === 'string' && own.state")
  })

  it('W-12 / W-13: the Sales pages fit 1440 (the ⋯ at 56, New messages at 116); New quote / New request hidden without their right', () => {
    // cq fx5 W-12: New messages takes the icon header and 52–64 px on Sales › Quotes too (its 116 px cut "New mes…").
    expect(quotesView).toContain("headerTooltip: l('columnHint'), headerComponent: MessagesHeader, minWidth: 52, maxWidth: 64,")
    expect(quotesView).not.toContain('minWidth: 88, maxWidth: 88')
    expect(incomingView).not.toContain('minWidth: 72, maxWidth: 72')
    expect(quotesView).not.toContain("heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNewQuote?.(true)}")
    expect(quotesView).toContain('{model.can.manage && (')
    expect(incomingView).toContain('{model.can.manage && newButton}')
  })

  it('W-14: each list\'s foot says the order\'s rule, its notes and what the tab left out (the frame\'s foot)', () => {
    expect(frame).toContain('{foot && <span className="fw-list-foot">{foot}</span>}')
    expect(quotesView).toContain("{model.filters.sort === 'urgent' && <span>{t('list.sort.ruleUrgent')}</span>}")
    expect(incomingView).toContain("{model.rank === 'urgent' && <span>{t('rank.rule')}</span>}{model.foot}")
    const live = src('../QuotesIncomingTab.tsx')
    expect(live).toContain('<SectionFoot kind="quotes"')
    expect(live).toContain('<SectionFoot kind="incoming"')
  })

  it('W-15: the keys stay on the list after a mouse pick; the phone\'s select bar stays in view', () => {
    // cq fx5 W-15: fx2's one tick after the click came before the dock's redraw (the walk: focus on the body); the bar stuck to the
    // bottom, which a bar at the top of its list never reaches. Both moved — see 'cq fx5' below.
    expect(frame).not.toContain('if (column) now.setFocusedCell(index, column)')
    expect(frame).toContain('api.setFocusedCell(index, column)')
    expect(src('../../../../../list-frame/list-frame.css')).toContain('.fw-rcf .fw-list-cards > .nds-cardlist-bulk {')
  })

  it('W-16 / W-17: on the tab the rows decide the company code; Company only from XL (L fits whole)', () => {
    expect(incomingView).toContain("const manyCompanies = model.columns === 'host' ? new Set((rows ?? []).map((row) => row.companyId)).size > 1 : companies.length > 1")
    expect(incomingView).toContain("cellRenderer: CompanyCell }, 'XL')] : []),")
  })
})
// ---- end cq fx2

// ---- cq fx3 (30-walk.md § Second look: W2-1, W2-1b, W2-3; W2-2 is in orders/list/reply-many.vitest.test.ts)
import { beforeOrderFor, beforeOrderOf, NO_BEFORE_ORDER } from '../before-order'

describe('cq fx3: the second look\'s gaps', () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('W2-1: a reader who cannot open Quotes & incoming gets no Work line (every part is a door there; Warehouse sees no drafts)', () => {
    expect(beforeOrderFor(answer(), false)).toEqual(NO_BEFORE_ORDER)
    expect(beforeOrderFor(answer(), true)).toEqual(beforeOrderOf(answer()))
    expect(beforeOrderFor(null, true)).toEqual(NO_BEFORE_ORDER)
    const page = src('../CustomerRecord.tsx')
    expect(page).toContain('const opensQuotesTab = can.quotes || can.inquiries === true')
    expect(page).toContain('beforeOrderFor(pageCounts.counts, opensQuotesTab)')
  })

  it('W2-1b: asked for Quotes & incoming without its right, the Work tab shows with one line why, until the reader leaves Work', () => {
    const page = src('../CustomerRecord.tsx')
    expect(page).toContain("if (record.model.tab === 'quotes' && tab !== 'quotes') setQuotesTabNote(true)")
    expect(page).toContain("quotesTabNote={quotesTabNote && tab === 'work' /* F-CQ-306 */}")
    const view = src('../view/CustomerRecordView.tsx')
    expect(view).toContain("{tab === 'work' && quotesTabNote && <QuotesTabNote />}")
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)('note.noTab'), locale).not.toBe('note.noTab')
  })

  it('W2-3: the door line is in the dock\'s head (the pick band\'s line), and the record docked from it keeps its way back', () => {
    const work = src('../view/WorkTab.tsx')
    expect(work).toContain("scope === 'record' && pick?.links && pick.links.length > 0 ? (")
    expect(work.indexOf('// ---- F-CQ-305 / cq fx3 W2-3')).toBeGreaterThan(0)
    expect(work.indexOf('// ---- F-CQ-305 / cq fx3 W2-3')).toBeLessThan(work.indexOf("{scope === 'record' && pick ? ("))
    expect(work).not.toContain('<p className="fw-qt-doors" aria-label={b(\'dock.line\')}>')
    const quote = quoteLinksOf({ id: 'q1', number: 'SEED-QT-0012', companyId: 'c', madeFrom: { inquiryId: 'i1', number: 'SEED-INQ-0005' }, fromPortalOrder: null, order: null })
    expect(quote[0]!.pick.links).toEqual([{ kind: 'becameQuote', pick: { type: 'Quote', id: 'q1', label: 'SEED-QT-0012', companyId: 'c' } }])
    const request = incomingLinksOf({ id: 'i1', number: 'SEED-INQ-0005', kind: 'REQUEST', companyId: 'c', request: { quote: { id: 'q1', number: 'SEED-QT-0012' }, order: null } as never, catalogueOrder: null })
    expect(request[0]!.pick.links).toEqual([{ kind: 'cameFromRequest', pick: { type: 'Inquiry', id: 'i1', label: 'SEED-INQ-0005', companyId: 'c' } }])
    const portal = incomingLinksOf({ id: 'p1', number: 'SEED-RQ-0086', kind: 'CATALOGUE_ORDER', companyId: 'c', request: null, catalogueOrder: { quote: { id: 'q1', number: 'SEED-QT-0012' }, salesOrder: null } as never })
    expect(portal[0]!.pick.links?.[0]!.kind).toBe('cameFromPortal')
  })
})
// ---- end cq fx3

// ---- cq fx5 (30-walk.md § Last look: W3-1, W-15, W-04, W-12, W3-2, W-09; the bars' and the window's cases are in many-acts and reply-many)
describe('cq fx5: the last look\'s gaps', () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('W3-1: the shell clips without being a box the browser scrolls (a tap on Select slid the page 13–29 px at 375)', () => {
    const shell = src('../../../../../shell/office/office-shell.css')
    const office = shell.slice(shell.indexOf('.fw-office {'), shell.indexOf('}', shell.indexOf('.fw-office {')))
    expect(office).toContain('overflow: clip;')
    expect(office).not.toContain('overflow: hidden;')
  })

  it('W-15: the focus comes back to the picked row after the dock re-draws the rows; j walks on from it; the phone bar sticks at the top', () => {
    const frame = src('../../../../../list-frame/ListFrame.tsx')
    // The row the keys stand on is kept by the frame (a redraw clears the grid's own), on every focus, a click's too.
    expect(frame).toContain('if (at?.data && !isGroupMarker(at.data)) keysAt.current = { id: rowId(at.data), colId:')
    // Once the docked row changes, the focus goes back while the rows settle — only when the list held it and it fell to the body.
    expect(frame).toContain('const timers = [0, 80, 240, 600].map((ms) => window.setTimeout(back, ms))')
    expect(frame).toContain('if (now && now !== document.body && now.isConnected) return')
    expect(frame).toContain('gridOwns.current = gridEl.contains(event.target as Node | null)')
    // The frame's own restore is never reported as the keys' move (the page already shows that row).
    expect(frame).toContain('if (restoring.current) return')
    expect(frame).toContain('const focused = api && !api.isDestroyed() ? (api.getFocusedCell()?.rowIndex ?? kept) : null')
    // The refs are declared before anything reads them.
    expect(frame.indexOf('const keysAt = useRef')).toBeLessThan(frame.indexOf('keysAt.current &&'))
    const css = src('../../../../../list-frame/list-frame.css')
    expect(css).toContain('top: calc(var(--fw-rcf-top, 16px) - 16px);')
    expect(css).toContain('.fw-rcf .fw-list-cards > .nds-cardlist-bar:has(> .nds-cardlist-all)')
    expect(css).not.toContain('bottom: var(--nds-space-8);\n  z-index: 2;')
  })

  it('W-04: Ready\'s tag wraps under "5 of 6" in its least width; "Wanted by" has 132 px — and the columns still fit their rooms', () => {
    const list = src('../drafts/view/CustomerDraftsList.tsx')
    expect(list).toContain('<span className="fw-cwd-inline is-wrap">')
    expect(list).toContain("{ colId: 'wanted', headerName: t('customers.drafts.col.wanted'), minWidth: 132,")
    expect(src('./quotes-tab.css')).toContain('.fw-cwd-inline.is-wrap {\n  display: flex;\n  flex-wrap: wrap;')
  })

  it('W-12: the Sales pages at 1440 — New messages an icon at 52–64 px; Number / Customer (quotes), Customer / Subject (requests) wrap', () => {
    const quotes = src('../../../quotes/list/view/QuotesListView.tsx')
    expect(quotes).toContain("minWidth: 130, flex: 1, cellRenderer: NumberCell, cellClass: 'fw-ql-wraps', autoHeight: true")
    expect(quotes).toContain("minWidth: 180, flex: 2, cellRenderer: CustomerCell, cellClass: 'fw-ql-wraps', autoHeight: true")
    expect(quotes).not.toContain('minWidth: 116, flex: 0.8')
    expect(src('../../../quotes/quotes.css')).toContain('.fw-ql-wraps .fw-ql-ellipsis {')
    const incoming = src('../../../inquiries/view/InquiriesView.tsx')
    expect(incoming).toContain("cellRenderer: CustomerCell, cellClass: 'fw-inq-wraps', autoHeight: true")
    expect(incoming).toContain("cellRenderer: SubjectCell, cellClass: 'fw-inq-wraps', autoHeight: true")
    expect(incoming).not.toContain("headerTooltip: l('columnHint'), minWidth: 116, flex: 0.5,")
    expect(incoming).toContain("{ colId: 'wantedDate', headerName: t('col.wanted'), minWidth: 112")
    expect(incoming).toContain("{ colId: 'company', headerName: t('col.company'), minWidth: 120")
    const css = src('../../../inquiries/inquiries.css')
    for (const rule of ['.fw-inq-wraps .fw-inq-subject {', '.fw-inq-wraps .fw-sheet-door,', '.fw-inq-wraps .fw-inq-who {']) expect(css).toContain(rule)
  })

  it('W3-2: the tab reads the customer\'s portal once (partners.view + threads.post) and both lists hold Reply with it', () => {
    const tab = src('../QuotesIncomingTab.tsx')
    expect(tab).toContain("useReplyPortal(party.id, session.permissions.includes('partners.view') && session.permissions.includes('threads.post'))")
    expect(tab.match(/replyPortal: replyPortal \?\? null, \/\/ cq fx5 W3-2/g)).toHaveLength(2)
    expect(src('../../../quotes/list/view/QuotesListView.tsx')).toContain("replyPortalHeld(latest.current.model.replyPortal, 'Quote',")
    expect(src('../../../inquiries/view/InquiriesView.tsx')).toContain("replyPortalHeld(m.replyPortal, 'Inquiry',")
  })

  it('W-09: on a phone Kind and How it came fold into More ▾ (a popover, no packages/ui change); its words in both languages', () => {
    const incoming = src('../../../inquiries/view/InquiriesView.tsx')
    expect(incoming).toContain('{!repliesView && (phone ? (')
    expect(incoming).toContain("triggerLabel={t('list.moreTools')} label={t('list.moreTools')} hoverDelay={0}")
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['sales-inquiries'])['sales-inquiries']!)('list.moreTools'), locale).not.toBe('list.moreTools')
  })
})
// ---- end cq fx5
