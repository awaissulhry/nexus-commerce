import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { leftKeys, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { LOCALES } from '../../../../lib/i18n/locales'
import { BLOCKED_BY, LIST_SORTS, WAITING_ON, WORK_ORDER_RISKS, type WorkOrderRow } from '../../_shared/api'
import { designScreen, RISK_OPEN, RISK_ROWS, /* F-PR-18 */ URGENCY_ROWS } from '../fixtures'
import {
  blockedKeyOf,
  boardMarksOf,
  cleared,
  customerCellOf,
  customerGroupsOf,
  doneOf,
  FILTER_CHOICES,
  filterChange,
  groupFigures,
  groupKeyOf,
  groupsToCount,
  healthCellOf,
  listAddress,
  listQueryOf,
  listTiles,
  MIXED_GROUP,
  narrowed,
  NO_CUSTOMER_GROUP,
  termsOf,
  waitingInputOf,
  withScreenSort,
  type ListTerms,
  // F-PR-18
  customerUrgencyCellOf,
} from './model'
// F-PR-18: the domain's states (the API's filter and column take the same list).
import { CUSTOMER_URGENCY_STATES } from '@nexus/factory-domain/production-brand/urgency-state'

/**
 * F-PR-03 — the work orders list by risk (production plan §5, 06-tree A.3, B-PR-34's list): the address (sort by risk by default and
 * written on every address, the computed filters, the customer filter, the grouping) and the export that follows it, the tiles At
 * risk and Waiting on customer, each cell's words, the board's marks, the groups by customer. Wall PW-02 (web side): every read
 * names the customer filter's `partyId`; a grouped list names only customers of rows the API gave; a person limited to one customer
 * sees nothing of the other anywhere on the page.
 */

const PARAMS = (query: string) => new URLSearchParams(query)
const A = '0190f0e2-6666-7000-8000-000000000001'
const B = '0190f0e2-6666-7000-8000-000000000002'
const MODES = ['table', 'board', 'calendar', 'cards'] as const
const terms = (query: string): ListTerms => termsOf(PARAMS(query), MODES)
const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const row = (number: string): WorkOrderRow => RISK_ROWS.find((entry) => entry.number === number)!

describe('F-PR-03 — the list’s address and the export that follows it', () => {
  it('mirrors the API’s sorts, risks and blocks (B-PR-34, risk.ts) and the domain’s waiting owners', () => {
    const api = readFileSync(new URL('../../../../../../factory-api/src/modules/production/work-orders/risk.ts', import.meta.url), 'utf8')
    expect(api).toContain(`export const LIST_SORTS = [${LIST_SORTS.map((value) => `'${value}'`).join(', ')}] as const`)
    expect(api).toContain(`export const WORK_ORDER_RISKS = [${WORK_ORDER_RISKS.map((value) => `'${value}'`).join(', ')}] as const`)
    expect(api).toContain(`export const BLOCKED_BY = [${BLOCKED_BY.map((value) => `'${value}'`).join(', ')}] as const`)
    expect(WAITING_ON).toEqual(['BRAND', 'SUPPLIER', 'WORKSHOP', 'US'])
  })

  it('reads every term of the address; an unknown value turns its term off, never a guess', () => {
    const read = terms(`view=late&q=JKT&sort=due&waitingOn=BRAND&risk=AT_RISK&blockedBy=HOLD&party=${A}&group=party&mode=board`)
    expect(read).toMatchObject({ view: 'late', q: 'JKT', sort: 'due', waitingOn: 'BRAND', risk: 'AT_RISK', blockedBy: 'HOLD', party: A, group: 'party', mode: 'board' })
    expect(terms('')).toMatchObject({ view: 'open', sort: 'risk', waitingOn: null, risk: null, blockedBy: null, party: null, group: null, mode: 'table' })
    expect(terms('sort=oldest&waitingOn=nobody&risk=SOON&blockedBy=x&party=not-an-id&group=site')).toMatchObject({ sort: 'risk', waitingOn: null, risk: null, blockedBy: null, party: null, group: null })
  })

  it('writes the sort on every address it makes (the screen’s default too), and each term the export reads by the API’s name', () => {
    expect(listAddress('/w/F1/production/work-orders', terms(''))).toBe('/w/F1/production/work-orders?sort=risk')
    const all = terms(`view=late&q=JKT&sort=due&waitingOn=BRAND&risk=AT_RISK&blockedBy=HOLD&party=${A}&group=party`)
    expect(listAddress('/p', all)).toBe(`/p?view=late&q=JKT&sort=due&waitingOn=BRAND&risk=AT_RISK&blockedBy=HOLD&party=${A}&group=party`)
    expect(listAddress('/p', terms('rush=true&due=this-week'), { new: true })).toBe('/p?due=this-week&rush=true&sort=risk&new=1')
    // A round trip keeps every term.
    expect(terms(listAddress('/p', all).split('?')[1]!)).toEqual(all)
  })

  it('PW-02: each read sends the customer filter as partyId with the sort and the computed filters (the API walls them)', () => {
    expect(listQueryOf(terms(`party=${B}&sort=risk&waitingOn=SUPPLIER&blockedBy=MATERIAL`))).toMatchObject({ open: true, partyId: B, sort: 'risk', waitingOn: 'SUPPLIER', blockedBy: 'MATERIAL', risk: undefined, limit: 50 })
    expect(listQueryOf(terms('view=late'), 'risk~0~2026-11-01~0190f0e2-9191-7000-8000-000000000008')).toMatchObject({ late: true, partyId: undefined, cursor: 'risk~0~2026-11-01~0190f0e2-9191-7000-8000-000000000008' })
  })

  it('the export of an address that names no sort is told the screen’s (risk); every other term, the customer too, as it was', () => {
    expect(withScreenSort('')).toBe('sort=risk')
    expect(withScreenSort(`party=${A}&view=late`)).toBe(`party=${A}&sort=risk&view=late`)
    expect(withScreenSort(`sort=due&party=${A}`)).toBe(`sort=due&party=${A}`)
    expect(withScreenSort('?waitingOn=BRAND')).toBe('sort=risk&waitingOn=BRAND')
  })

  it('narrowed / cleared: Clear filters takes every filter off, the sort, the mode and the grouping stay', () => {
    const on = terms(`q=X&risk=LATE&party=${A}&group=party&sort=due&mode=board`)
    expect(narrowed(on)).toBe(true)
    expect(narrowed(terms(''))).toBe(false)
    expect(cleared(on)).toMatchObject({ view: 'all', q: '', risk: null, party: null, group: 'party', sort: 'due', mode: 'board' })
    expect(filterChange('waitingOn', 'BRAND')).toEqual({ waitingOn: 'BRAND' })
    expect(filterChange('risk', 'nonsense')).toEqual({ risk: null })
    expect(filterChange('blockedBy', null)).toEqual({ blockedBy: null })
    expect(filterChange('unknown', 'x')).toBeNull()
  })
})

describe('F-PR-03 — the tiles', () => {
  it('Drafts · Released · In progress · Late · At risk · On hold · Waiting on customer; the last two as the API’s filters', () => {
    const counts = { draft: 2, released: 1, inProgress: 4, completed: 1, open: 7, late: 2, onHold: 1, atRisk: 3, waitingOnCustomer: 2 }
    const tiles = listTiles(terms(''), counts)
    // F-PR-21: Mine first (`?supervisor=me`; its count not in this answer: "—").
    expect(tiles.map((tile) => [tile.id, tile.count])).toEqual([['mine', null], ['draft', 2], ['released', 1], ['inProgress', 4], ['late', 2], ['atRisk', 3], ['onHold', 1], ['waitingOnCustomer', 2]])
    expect(tiles.find((tile) => tile.id === 'atRisk')!.next).toEqual({ risk: 'AT_RISK' })
    const pressed = listTiles(terms('risk=AT_RISK&waitingOn=BRAND'), counts)
    expect(pressed.filter((tile) => tile.active).map((tile) => tile.id)).toEqual(['atRisk', 'waitingOnCustomer'])
    expect(pressed.find((tile) => tile.id === 'waitingOnCustomer')!.next).toEqual({ waitingOn: null })
    expect(listTiles(terms('view=late'), counts).find((tile) => tile.id === 'late')).toMatchObject({ active: true, next: { view: 'open' } })
    // Not read: every tile says "—" (null), never 0; an older API without the new counts: those two "—".
    expect(listTiles(terms(''), null).every((tile) => tile.count === null)).toBe(true)
    expect(listTiles(terms(''), { draft: 1, released: 0, inProgress: 0, completed: 0, open: 1, late: 0 }).find((tile) => tile.id === 'atRisk')!.count).toBeNull()
  })
})

describe('F-PR-03 — each row’s cells', () => {
  it('Customer: the name (parties.view) or the code, each order with its PO; mixed and none said in words', () => {
    expect(customerCellOf(row('WO-00009'), true)).toEqual({ name: 'Moto Demo S.r.l.', mixed: false, orders: [{ id: row('WO-00009').orders[0]!.id, number: 'SO-DEMO-0042', po: 'PO-ESEMPIO-7' }] })
    expect(customerCellOf(row('WO-00011'), false)).toMatchObject({ name: 'BETA', orders: [{ number: 'SO-DEMO-0043', po: null }] })
    expect(customerCellOf({ customer: null, mixedCustomers: true, orders: [] }, true)).toEqual({ name: null, mixed: true, orders: [] })
    expect(customerCellOf({ customer: null, orders: [] }, true)).toEqual({ name: null, mixed: false, orders: [] })
  })

  it('Done = finished of the pieces, bar and words one figure; a draft and a site that counts no finish say so', () => {
    expect(doneOf(row('WO-00009'))).toEqual({ percent: 23, words: { key: 'progress.finished', params: { done: 6, total: 26 } } })
    expect(doneOf(row('WO-00012'))).toEqual({ percent: null, words: { key: 'progress.notFrozen' } })
    expect(doneOf({ status: 'IN_PROGRESS', pieces: 10, progress: { cut: 10, bundled: 10, sewn: 4, finished: null } })).toEqual({ percent: null, words: { key: 'list.doneNotCounted' } })
    expect(doneOf({ status: 'RELEASED', pieces: 10, progress: { cut: 0, bundled: 0, sewn: 0, finished: 0 } })).toEqual({ percent: 0, words: { key: 'progress.finished', params: { done: 0, total: 10 } } })
  })

  it('Health from the risk: late with its days, at risk (planned after due, or a person’s raise with its reason), blocked, on track, no date', () => {
    expect(healthCellOf(row('WO-00008'))).toEqual({ kind: 'health', input: { computed: 'LATE', daysLate: 5 } })
    expect(healthCellOf(row('WO-00009'))).toMatchObject({ kind: 'health', input: { computed: 'AT_RISK', raised: null } })
    expect(healthCellOf(row('WO-00012'))).toMatchObject({ kind: 'health', input: { computed: 'ON_TIME', raised: { reason: 'MATERIAL_LATE' } } })
    expect(healthCellOf(row('WO-00011'))).toEqual({ kind: 'blocked', by: 'CUSTOMER' })
    expect(healthCellOf(row('WO-00010'))).toEqual({ kind: 'health', input: { computed: 'ON_TIME' } })
    expect(healthCellOf({ ...row('WO-00010'), dueDate: null })).toEqual({ kind: 'health', input: { computed: 'NOT_PROMISED' } })
    // Finished: no health; an older answer without a risk: not known (never a made-up "on track").
    expect(healthCellOf(row('WO-00006'))).toEqual({ kind: 'none' })
    expect(healthCellOf({ status: 'IN_PROGRESS', dueDate: null })).toEqual({ kind: 'unknown' })
  })

  it('Waiting on and Blocked by: who and since when for an open one; nothing for a finished one; "—" when nothing is known', () => {
    expect(waitingInputOf(row('WO-00003'))).toEqual({ who: 'BRAND', since: '2026-10-26T15:00:00Z' })
    expect(waitingInputOf(row('WO-00007'))).toEqual({ who: undefined, since: null })
    expect(waitingInputOf(row('WO-00005'))).toEqual({ who: null, since: null })
    expect(blockedKeyOf(row('WO-00012'))).toBe('blocked.MATERIAL')
    expect(blockedKeyOf(row('WO-00009'))).toBeNull()
  })

  it('a board card’s marks: its health when not on track and who it waits on with how long', () => {
    const now = Date.parse('2026-10-29T09:42:00Z')
    expect(boardMarksOf(row('WO-00008'), now)).toEqual([
      { words: [{ key: 'parts.health.lateBy', params: { count: 5 } }], tone: 'danger' },
      { words: [{ key: 'parts.waiting.office.US' }, { key: 'parts.age.days', params: { count: 2 } }], tone: 'neutral' },
    ])
    expect(boardMarksOf(row('WO-00011'), now)[0]).toEqual({ words: [{ key: 'risk.BLOCKED' }], tone: 'warning' })
    expect(boardMarksOf(row('WO-00007'), now)).toEqual([])
  })
})

describe('F-PR-03 — grouped by customer (PW-02: only customers of the rows the API gave)', () => {
  it('one group per customer of the loaded rows, in the list’s order (the most at risk first); mixed and none apart', () => {
    const mixed: WorkOrderRow = { ...RISK_OPEN[0]!, id: 'x-mixed', customer: null, mixedCustomers: true }
    const none: WorkOrderRow = { ...RISK_OPEN[0]!, id: 'x-none', customer: null, mixedCustomers: false }
    const groups = customerGroupsOf([...RISK_OPEN, mixed, none], true)
    expect(groups.map((group) => [group.kind, group.name])).toEqual([['customer', 'Moto Demo S.r.l.'], ['customer', 'Esempio Racing S.p.A.'], ['mixed', null], ['none', null]])
    expect(customerGroupsOf(RISK_OPEN, false).map((group) => group.name)).toEqual(['ALPHA', 'BETA'])
    expect(groupKeyOf(mixed)).toBe(MIXED_GROUP)
    expect(groupKeyOf(none)).toBe(NO_CUSTOMER_GROUP)
  })

  it('PW-02: rows of one customer make one group — a customer the person may see but with no row here is never named', () => {
    const onlyB = RISK_OPEN.filter((entry) => entry.customer?.id === B)
    const groups = customerGroupsOf(onlyB, true)
    expect(groups.map((group) => group.partyId)).toEqual([B])
    expect(JSON.stringify(groups)).not.toContain('Moto Demo')
    expect(groupsToCount(groups, {})).toEqual([B])
    expect(groupsToCount(groups, { [B]: 'reading' })).toEqual([])
  })

  it('a header’s figures are the server’s for the customer’s whole production (never summed from the rows on screen)', () => {
    expect(groupFigures({ draft: 1, released: 0, inProgress: 1, completed: 0, open: 2, late: 1, atRisk: 0, waitingOnCustomer: 2 })).toEqual({ key: 'group.figures', params: { open: 2, late: 1, atRisk: 0, waiting: 2 } })
  })
})

describe('F-PR-03 — the screen (both languages)', () => {
  const IDS = ['risk', 'risk-tile', 'risk-waiting', 'risk-customer', 'risk-grouped', 'risk-grouped-reading', 'risk-limited', 'risk-board', 'risk-no-match']

  it('every F-PR-03 case draws with no key left on screen, in it and en', () => {
    for (const id of IDS) {
      for (const locale of LOCALES) {
        const html = draw(id, locale)
        expect(leftKeys(html, ['risk', 'blocked', 'group', 'sort', 'filter', 'waitingChoice', 'board', 'tile', 'col', 'list', 'customer', 'parts']), `${id} ${locale}`).toEqual([])
      }
    }
  })

  it('the toolbar: Sort (risk first selected), Group, the customer filter; the tiles At risk and Waiting on customer with their counts', () => {
    const text = textOf(draw('risk'))
    for (const words of ['Risk first', 'Due date', 'Newest first', 'No grouping', 'By customer', 'All customers', 'At risk', 'Waiting on customer']) expect(text).toContain(words)
    const it = textOf(draw('risk', 'it'))
    for (const words of ['Prima i più a rischio', 'Per cliente', 'Tutti i clienti', 'A rischio', 'Tocca al cliente']) expect(it).toContain(words)
  })

  it('PW-02: a person limited to one customer sees nothing of the other — not its name, code, order, PO or a filter choice', () => {
    for (const locale of LOCALES) {
      const html = draw('risk-limited', locale)
      expect(html).not.toContain('Moto Demo')
      expect(html).not.toContain('ALPHA')
      expect(html).not.toContain('PO-ESEMPIO-7')
      expect(html).not.toContain('SO-DEMO-0042')
      expect(textOf(html)).toContain(locale === 'en' ? 'All my customers' : 'Tutti i miei clienti')
    }
  })

  it('the dynamic words exist in both languages (risks, blocks, waiting choices, sorts, tiles, columns)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production']).production!)
      const keys = [
        ...FILTER_CHOICES.waitingOn.map((choice) => choice.key),
        ...FILTER_CHOICES.risk.map((choice) => choice.key),
        ...FILTER_CHOICES.blockedBy.map((choice) => choice.key),
        ...['risk', 'due', 'newest'].map((sort) => `sort.${sort}`),
        'tile.atRisk',
        'tile.waitingOnCustomer',
        ...['stage', 'done', 'health', 'waitingOn', 'blockedBy'].map((col) => `col.${col}`),
        'group.figures',
        'group.total',
        'group.mixedNote',
        'group.noneNote',
        'list.doneNotCounted',
        'list.po',
      ]
      for (const key of keys) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})

// ---- F-PR-18: the Customer urgency column (under Columns ▾) and its filter ----------------------------------------------------------
describe('F-PR-18 — Work orders: the Customer urgency column and filter', () => {
  it('the filter is an address term the API reads (a computed filter over every page), cleared with the others; an unknown value is off', () => {
    expect(terms('customerUrgency=ASKED').customerUrgency).toBe('ASKED')
    expect(terms('customerUrgency=urgent').customerUrgency).toBeNull()
    const asked = terms('customerUrgency=SET_BACK')
    expect(listAddress('/w/DEMO/production/work-orders', asked)).toBe('/w/DEMO/production/work-orders?sort=risk&customerUrgency=SET_BACK')
    expect(listQueryOf(asked)).toMatchObject({ customerUrgency: 'SET_BACK', sort: 'risk' })
    expect(listQueryOf(terms('')).customerUrgency).toBeUndefined()
    expect(narrowed(asked)).toBe(true)
    expect(cleared(asked).customerUrgency).toBeNull()
    expect(filterChange('customerUrgency', 'URGENT')).toEqual({ customerUrgency: 'URGENT' })
    expect(filterChange('customerUrgency', 'nope')).toEqual({ customerUrgency: null })
    expect(FILTER_CHOICES.customerUrgency.map((choice) => choice.value)).toEqual([...CUSTOMER_URGENCY_STATES])
  })

  it('mirrors the API’s filter and column (the same domain list in its contract)', () => {
    const contract = readFileSync(new URL('../../../../../../factory-api/src/modules/production/work-orders/contract.ts', import.meta.url), 'utf8')
    expect(contract).toContain('customerUrgency: z.enum(CUSTOMER_URGENCY_STATES).optional()')
    expect(contract).toContain('urgencyState: z.enum(CUSTOMER_URGENCY_STATES).nullable()')
  })

  it('each cell: Urgent 2 (the place in the customer’s OWN list) · Urgent – asked · Regular · Set to regular by us · none', () => {
    expect(customerUrgencyCellOf({ urgencyState: 'URGENT', customerUrgency: 'URGENT', urgentRank: 2 })).toEqual({ state: 'URGENT', key: 'urgency.cell.URGENT', params: { rank: 2 }, tone: 'info' })
    expect(customerUrgencyCellOf({ urgencyState: 'URGENT', customerUrgency: 'URGENT', urgentRank: null })).toMatchObject({ key: 'urgency.cell.URGENT_SOME' })
    expect(customerUrgencyCellOf({ urgencyState: 'ASKED', customerUrgency: 'REGULAR', urgentRank: null })).toMatchObject({ key: 'urgency.cell.ASKED', tone: 'warning' })
    expect(customerUrgencyCellOf({ urgencyState: 'SET_BACK', customerUrgency: 'REGULAR', urgentRank: null })).toMatchObject({ key: 'urgency.cell.SET_BACK' })
    expect(customerUrgencyCellOf({ urgencyState: 'REGULAR', customerUrgency: 'REGULAR', urgentRank: null })).toMatchObject({ key: 'urgency.cell.REGULAR' })
    expect(customerUrgencyCellOf({ urgencyState: null, customerUrgency: null, urgentRank: null })).toBeNull()
    // An older answer without the state: its urgency alone.
    expect(customerUrgencyCellOf({ customerUrgency: 'URGENT', urgentRank: 1 })).toMatchObject({ key: 'urgency.cell.URGENT', params: { rank: 1 } })
  })

  it('the words in both languages: Italian says "Urgenza cliente" and "Urgente (cliente)" ("Urgente" alone is the rush flag)', () => {
    for (const locale of LOCALES) {
      const tw = createTranslator(locale, messagesFor(locale, ['production-work-orders'])['production-work-orders']!)
      for (const key of ['urgency.column', 'urgency.filter', 'urgency.hint', 'urgency.cell.URGENT_SOME', 'urgency.cell.ASKED', 'urgency.cell.REGULAR', 'urgency.cell.SET_BACK', ...FILTER_CHOICES.customerUrgency.map((choice) => choice.key)]) expect(tw(key), `${locale}: ${key}`).not.toBe(key)
    }
    const it = createTranslator('it', messagesFor('it', ['production-work-orders'])['production-work-orders']!)
    expect(it('urgency.column')).toBe('Urgenza cliente')
    expect(it('urgency.cell.URGENT', { rank: 2 })).toBe('Urgente (cliente) 2')
    expect(it('urgency.choice.URGENT')).not.toBe('Urgente')
  })

  it('PW-06 (web side): the cell names no customer and no place in our plan; only the rows the API gave are drawn', () => {
    const html = draw('urgency-rows')
    expect(leftKeys(html, ['urgency'])).toEqual([])
    for (const rowOf of URGENCY_ROWS) {
      const cell = customerUrgencyCellOf(rowOf)
      if (cell?.params) expect(Object.keys(cell.params)).toEqual(['rank'])
    }
    const filtered = textOf(draw('urgency-filter'))
    for (const other of URGENCY_ROWS.filter((entry) => entry.urgencyState !== 'ASKED')) expect(filtered).not.toContain(other.number)
    // Nothing matches: the empty state offers to show every work order (the filter off with the others).
    expect(textOf(draw('urgency-none'))).toContain(createTranslator('en', messagesFor('en', ['production']).production!)('list.clearFilters'))
  })
})
// ---- end F-PR-18
