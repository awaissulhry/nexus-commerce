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

  it('the tab reads its counts itself (W1; no prop added to the page), with the lists\' host options; change requests are not here', () => {
    const tab = readFileSync(new URL('../QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('useQuotesTab(party.id)')
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
    expect(byRoom(column, true)).toBe(column)
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
      for (const key of ['band.title', 'band.pipeline', 'band.closed', 'band.newRequest', 'band.newRequestShort', 'band.newQuote', 'band.newQuoteShort', 'band.segTitle', 'band.segTitleClosed', 'band.waitsOn', 'band.who.us', 'band.who.customer', 'band.who.approver', 'band.info', 'band.failed', 'band.retry', 'door.showAll', 'door.close', 'sec.incoming', 'sec.countOpen', 'sec.countNotClosed', 'sec.countGroup', 'empty.tab', 'empty.tabBody', 'empty.incomingNone', 'empty.quotesNone', 'empty.incomingNoLive', 'empty.closedDoors', 'fold.incoming', 'fold.quotes', 'fold.drafts', 'note.noRequests', 'note.noQuotes', 'foot.closedLeftOut', 'foot.door']) {
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
    expect(list).toContain('readonly views?: { readonly model: OrdersListModel; readonly actions?: OrdersListActions } | null')
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
