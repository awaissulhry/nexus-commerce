import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SET_ASIDE_REASONS } from '@nexus/factory-domain/planning/decisions'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { REQUEST_HOLDS, REQUEST_STATUSES, REQUEST_WARNINGS } from '@nexus/factory-domain/purchasing/requests/requests'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, listAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { ROLES } from '../../_shared/buying/fixtures'
import { convertRequests, listRequests, previewConversion, rejectPlanLines, requestParams } from './api'
import { ALL_ROWS, designScreen, OPEN_ROWS, PREVIEW } from './fixtures'
import {
  confirmHeld,
  convertRefusal,
  convertRequestsOf,
  draftHeld,
  filtersOf,
  GROUPS,
  grouped,
  historyPhrases,
  intoBody,
  intoOf,
  neighbours,
  nettingPhrases,
  NO_FILTERS,
  plusDays,
  rejectConfirmHeld,
  rejectHeld,
  rejectLinesOf,
  requestQuery,
  requestsAddress,
  requestsCan,
  roundingPhrases,
  say,
  selectableWhy,
  sourceHref,
  sourcePhrase,
  TILES,
  tileValue,
  viewOf,
  VIEWS,
  weekMonday,
} from './model'

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so every dialog's words
// are checked too.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), subtitle as never, children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * Purchasing › Requests to buy (SCR-236; B-W2a-69 on B-W2a-10's API): the saved views as the API's own filters, the
 * address, the tiles, why a row may not be picked, the groups, the netting and rounding in our words, why Draft POs and
 * Reject are held (and the dialogs' Confirm), the bodies the API takes, the calls as the API takes them, the page links,
 * and every design case drawn in Italian and English with no message key or placeholder left on screen.
 */

const words = (locale: 'it' | 'en') => createTranslator(locale, messagesFor(locale, ['purchasing-requests'])['purchasing-requests'] ?? {})
const byCode = (code: string, colour: string | null = null) => ALL_ROWS.find((entry) => entry.item.code === code && (colour === null || entry.colour?.code === colour))!

describe('requests to buy: the views, the address, the tiles', () => {
  it('maps each view to the API’s own query (a tile and its list agree)', () => {
    const today = '2026-10-30'
    expect(requestQuery('open', NO_FILTERS, today)).toMatchObject({ status: 'OPEN' })
    expect(requestQuery('need14', NO_FILTERS, today)).toMatchObject({ status: 'OPEN', needBy: '2026-11-13' })
    expect(requestQuery('held', { ...NO_FILTERS, kind: 'REORDER' }, today)).toMatchObject({ status: 'OPEN', held: true, kind: 'REORDER' })
    expect(requestQuery('converted', NO_FILTERS, today).status).toBe('CONVERTED')
    expect(requestQuery('setAside', NO_FILTERS, today).status).toBe('SET_ASIDE')
    expect(requestQuery('all', { ...NO_FILTERS, site: 's1', q: ' zip ' }, today)).toMatchObject({ status: 'ALL', siteId: 's1', q: ' zip ' })
    expect(requestParams({ status: 'OPEN', held: true, q: ' zip ', siteId: 's1' })).toEqual({ siteId: 's1', kind: undefined, status: 'OPEN', needBy: undefined, held: 'true', q: 'zip', cursor: undefined, limit: 200 })
    expect(plusDays('2026-12-25', 14)).toBe('2027-01-08')
  })

  it('reads and writes the address (defaults left out)', () => {
    expect(viewOf(new URLSearchParams(''))).toBe('open')
    expect(viewOf(new URLSearchParams('view=need14'))).toBe('need14')
    expect(viewOf(new URLSearchParams('view=nonsense'))).toBe('open')
    expect(filtersOf(new URLSearchParams('site=s1&kind=PLAN&q=nappa&group=week'))).toEqual({ site: 's1', kind: 'PLAN', q: 'nappa', group: 'week' })
    expect(filtersOf(new URLSearchParams('kind=STAFF&group=colour'))).toEqual(NO_FILTERS)
    expect(requestsAddress('/w/DEMO/purchasing/requests', 'open', NO_FILTERS)).toBe('/w/DEMO/purchasing/requests')
    expect(requestsAddress('/w/DEMO/purchasing/requests', 'held', { site: null, kind: 'REORDER', q: ' zip ', group: 'supplier' }, 'reorder:x')).toBe('/w/DEMO/purchasing/requests?view=held&kind=REORDER&q=zip&group=supplier&open=reorder%3Ax')
  })

  it('draws the tiles: 0 is 0, unknown is —, waiting approval is always — (staff requests are W2b)', () => {
    const counts = { asOf: 'x', open: 7, needWithin14Days: 0, waitingApproval: null, convertedToday: 1 }
    expect(TILES.map((tile) => tileValue(tile, counts))).toEqual(['7', '0', '—', '1'])
    expect(TILES.map((tile) => tileValue(tile, null))).toEqual(['—', '—', '—', '—'])
    expect(TILES.map((tile) => tile.view)).toEqual(['open', 'need14', null, 'converted'])
  })

  it('reads the roles: buyer drafts and rejects with costs; planner rejects without; warehouse and read-only read', () => {
    expect(requestsCan(ROLES.buyer)).toMatchObject({ view: true, manage: true, decide: true, cost: true })
    expect(requestsCan(ROLES.planner)).toMatchObject({ view: true, manage: false, decide: true, cost: false })
    expect(requestsCan(ROLES.warehouse)).toMatchObject({ view: true, manage: false, decide: false, cost: false })
    expect(requestsCan(ROLES.readOnly)).toMatchObject({ view: true, manage: false, decide: false })
    expect(requestsCan(ROLES.sales).view).toBe(false)
  })
})

describe('rows: what may be picked, the groups, the words from the numbers', () => {
  const t = words('en')
  it('says why a row may not be picked', () => {
    const converted = ALL_ROWS.find((entry) => entry.status === 'CONVERTED')!
    const rejected = ALL_ROWS.find((entry) => entry.status === 'SET_ASIDE')!
    const noSupplier = ALL_ROWS.find((entry) => entry.hold?.code === 'NO_SUPPLIER')!
    expect(say(t, selectableWhy(converted)!)).toBe('Already in purchase order PO-DEMO-0007')
    expect(say(t, selectableWhy(rejected)!)).toMatch(/^Rejected: put it back/)
    expect(say(t, selectableWhy(noSupplier)!)).toMatch(/^No supplier yet/)
    expect(selectableWhy(byCode('DEMO-LEA-01', 'BLK'))).toBeNull()
  })

  it('groups by supplier (by name) and by need week (soonest first), the API’s order kept inside a group', () => {
    expect(grouped(OPEN_ROWS, 'none').rows.map((entry) => entry.id)).toEqual(OPEN_ROWS.map((entry) => entry.id))
    const weeks = grouped(OPEN_ROWS, 'week')
    expect([...new Set(weeks.rows.map((entry) => entry.needWeek))]).toEqual(['2026-W45', '2026-W46', '2026-W47'])
    expect([...weeks.first.values()].reduce((sum, count) => sum + count, 0)).toBe(OPEN_ROWS.length)
    const suppliers = grouped(OPEN_ROWS, 'supplier')
    const names = [...new Set(suppliers.rows.map((entry) => entry.supplier?.name ?? '~'))]
    expect(names.at(-1)).toBe('~')
    expect(names.slice(0, -1)).toEqual([...names.slice(0, -1)].sort((a, b) => a.localeCompare(b)))
    expect(GROUPS).toEqual(['none', 'supplier', 'week'])
    expect(weekMonday('2026-W46')).toBe('2026-11-09')
  })

  it('writes the netting, the rounding, the source and the history in our words (never the API’s English)', () => {
    const leather = byCode('DEMO-LEA-01', 'BLK')
    const netting = nettingPhrases(leather, 'en').map((entry) => say(t, entry))
    expect(netting).toEqual(['Needed: 520 ft²', 'Usable stock: − 60 ft²', 'Held stock not counted: 35 ft²', 'Already on order: − 62 ft²', 'Short: 398 ft²', 'Buy 420 ft², in the supplier’s unit and steps'])
    expect(roundingPhrases(leather, 'en').map((entry) => say(t, entry))).toEqual(['At least the minimum: 400 ft²', 'In steps: 420 ft²'])
    expect(say(t, sourcePhrase(leather))).toBe('Shortage for 2 work orders (WO-DEMO-0221, WO-DEMO-0225…)')
    const zip = byCode('DEMO-ZIP-04')
    expect(nettingPhrases(zip, 'it').map((entry) => say(words('it'), entry))[0]).toBe('Posizione di scorta: 40 utilizzabili + 0 in ordine − 18 riservati = 22 pz')
    expect(historyPhrases(zip).map((entry) => entry.words.key)).toEqual(['history.reorderLive'])
    expect(historyPhrases(ALL_ROWS.find((entry) => entry.status === 'SET_ASIDE')!).map((entry) => say(t, entry.words))).toEqual(['The plan run found it', 'Rejected: the customer supplies it'])
    expect(JSON.stringify(netting)).not.toContain(leather.plan!.why)
  })

  it('opens the source record: the plan line on What to buy & make, a reorder row’s material', () => {
    const leather = byCode('DEMO-LEA-01', 'BLK')
    expect(sourceHref('/w/DEMO', leather)).toBe(`/w/DEMO/planning/mrp?site=${leather.siteId}&line=${leather.refId}`)
    expect(sourceHref('/w/DEMO', byCode('DEMO-ZIP-04'))).toBe(`/w/DEMO/products/materials/${byCode('DEMO-ZIP-04').item.id}`)
    expect(neighbours(['a', 'b', 'c'], 'b')).toEqual({ index: 1, previous: 'a', next: 'c' })
    expect(neighbours(['a'], 'a')).toEqual({ index: 0, previous: null, next: null })
  })
})

describe('held in our words, and the bodies the API takes', () => {
  const t = words('en')
  const buyer = requestsCan(ROLES.buyer)
  const leather = byCode('DEMO-LEA-01', 'BLK')
  const zip = byCode('DEMO-ZIP-04')

  it('Draft POs: no right, offline, nothing picked, nothing open', () => {
    expect(say(t, draftHeld([leather], requestsCan(ROLES.planner), false)!)).toBe('Drafting purchase orders needs purchasing.manage')
    expect(say(t, draftHeld([leather], buyer, true)!)).toBe('Offline: wait for the connection')
    expect(say(t, draftHeld([], buyer, false)!)).toBe('Select requests first')
    expect(draftHeld([ALL_ROWS.find((entry) => entry.status === 'CONVERTED')!], buyer, false)?.key).toBe('held.noneOpen')
    expect(draftHeld([leather, zip], buyer, false)).toBeNull()
  })

  it('Reject: planning.decide, a reorder point cannot be rejected, plan rows can', () => {
    expect(rejectHeld([leather], requestsCan(ROLES.warehouse), false)?.key).toBe('held.noDecide')
    expect(say(t, rejectHeld([leather, zip], buyer, false)!)).toBe('A reorder point cannot be rejected: change the reorder rule')
    expect(rejectHeld([leather], requestsCan(ROLES.planner), false)).toBeNull()
    expect(rejectLinesOf([leather, zip])).toEqual([{ id: leather.refId, version: leather.version }])
    expect(rejectConfirmHeld({ reason: '', note: '', busy: false, requestIds: ['x'] })?.key).toBe('reject.pickReason')
    expect(rejectConfirmHeld({ reason: 'OTHER', note: ' ', busy: false, requestIds: ['x'] })?.key).toBe('reject.noteNeeded')
    expect(rejectConfirmHeld({ reason: 'OTHER', note: 'gone', busy: false, requestIds: ['x'] })).toBeNull()
  })

  it('the conversion: open requests with their version and the picked supplier; per card its draft or a new one', () => {
    expect(convertRequestsOf([leather, zip, ALL_ROWS.find((entry) => entry.status === 'CONVERTED')!], { [leather.id]: 'sup-2' })).toEqual([
      // The API names the row behind each request (its refId: the plan line, the reorder rule), not `plan:<id>`.
      { kind: 'PLAN', id: leather.refId, version: leather.version, supplierId: 'sup-2' },
      { kind: 'REORDER', id: zip.refId, version: zip.version },
    ])
    expect(leather.refId).not.toBe(leather.id)
    const [existing, withOpen, fresh] = PREVIEW.cards
    expect([intoOf(existing!, {}), intoOf(withOpen!, {}), intoOf(fresh!, {})]).toEqual(['existing', 'new', 'new'])
    const picked = { [`${withOpen!.supplier.id}|${withOpen!.siteId}`]: 'existing' as const, [`${existing!.supplier.id}|${existing!.siteId}`]: 'new' as const, [`${fresh!.supplier.id}|${fresh!.siteId}`]: 'existing' as const }
    expect(intoBody(PREVIEW.cards, picked).map((entry) => entry.purchaseOrderId)).toEqual([null, withOpen!.openDraft!.id, null])
    expect(confirmHeld({ preview: { status: 'ready', value: PREVIEW }, busy: false }, false)).toBeNull()
    expect(confirmHeld({ preview: { status: 'ready', value: { ...PREVIEW, held: [{ requestId: 'x', code: 'NO_SUPPLIER', message: 'x' }] } }, busy: false }, false)?.key).toBe('draft.heldFirst')
    expect(confirmHeld({ preview: { status: 'ready', value: { ...PREVIEW, cards: [{ ...existing!, mayDraft: false }] } }, busy: false }, false)?.key).toBe('draft.noRight')
    expect(confirmHeld({ preview: { status: 'loading' }, busy: false }, false)?.key).toBe('held.loading')
  })

  it('says a refused conversion in our words', () => {
    const refused = (kind: 'invalid' | 'conflict', paths: string[] = []) => new ApiError(kind, kind === 'invalid' ? 400 : 409, kind, 'English', null, paths.map((path) => ({ path, message: 'x' })))
    expect(convertRefusal(refused('invalid', ['body/requests/0/supplierId'])).key).toBe('refused.notApproved')
    expect(convertRefusal(refused('conflict')).key).toBe('refused.changed')
    expect(convertRefusal(new Error('x')).key).toBe('problem.write')
  })
})

describe('the calls, as the API takes them', () => {
  function fake() {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const api: ApiClient = createApiClient({
      baseUrl: 'http://api.test',
      csrfToken: () => 'csrf',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        const url = String(input)
        calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get('idempotency-key') })
        const body = url.includes('/preview')
          ? PREVIEW
          : url.includes('/convert')
            ? { orders: [], lines: [] }
            : url.includes('/set-aside')
              ? { runId: 'r', decision: 'IGNORED', lines: [] }
              : { asOf: '2026-10-30T08:00:00.000Z', requests: OPEN_ROWS, matching: 7, nextCursor: null }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    return { api, calls }
  }

  it('reads the queue, previews, converts with the dialog’s key, rejects through planning', async () => {
    const { api, calls } = fake()
    const page = await listRequests(api, requestQuery('need14', { ...NO_FILTERS, kind: 'PLAN' }, '2026-10-30'))
    expect(page.requests).toHaveLength(OPEN_ROWS.length)
    expect(calls[0]!.url).toBe('http://api.test/purchasing/requests?kind=PLAN&status=OPEN&needBy=2026-11-13&limit=200')
    const body = { requests: [{ kind: 'PLAN' as const, id: 'plan:x', version: 3 }] }
    expect((await previewConversion(api, body)).cards).toHaveLength(3)
    await convertRequests(api, { ...body, into: [{ supplierId: 's', siteId: 'site', purchaseOrderId: null }] }, 'key-1')
    await rejectPlanLines(api, [{ id: 'r1', version: 2 }], 'OTHER', ' gone ', 'key-2')
    expect(calls.slice(1).map((call) => [call.method, call.url.replace('http://api.test', ''), call.key])).toEqual([
      ['POST', '/purchasing/requests/preview', null],
      ['POST', '/purchasing/requests/convert', 'key-1'],
      ['POST', '/planning/requirements/set-aside', 'key-2'],
    ])
    expect(calls[3]!.body).toEqual({ lines: [{ id: 'r1', version: 2 }], reason: 'OTHER', note: 'gone' })
  })

  it('is an Office page and a list page', () => {
    expect(OFFICE_PAGES.has('/purchasing/requests')).toBe(true)
    expect(LIST_PAGES['/purchasing/requests']).toBe('/purchasing/requests')
    expect(listAddress('/purchasing/requests', { view: 'need14' }, OFFICE_PAGES)).toBe('/purchasing/requests?view=need14')
  })
})

const LEFT_KEY = /\b(?:common|live|problem|noAccess|band|tile|tiles|list|view|kind|groupBy|site|col|group|source|by|quantityFrom|orderBy|supplier|supplierFrom|status|notOpen|hold|warning|row|bulk|held|keys|detail|preference|net|rounding|history|reason|draft|party|refused|reject|notice|csv|uom|poStatus)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs purchasing.manage"). */
const SAID = /\b(?:purchasing\.[a-z.]+|planning\.decide|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'purchasing-requests']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('draws the dialogs and the detail (the DS Modal in place)', () => {
    const html = (id: string, locale: 'it' | 'en') => render(screen, screen.cases.find((item) => item.id === id)!.model, locale)
    expect(html('draft-ready', 'en')).toContain('Add to draft PO-DEMO-0004')
    expect(html('draft-ready', 'it')).toContain('Crea 3 ordini')
    expect(html('draft-held', 'en')).toContain('Leave them out')
    expect(html('draft-done', 'en')).toContain('PO-DEMO-0009')
    expect(html('detail-plan', 'en')).toContain('Short: 398 ft²')
    expect(html('detail-reorder', 'it')).toContain('PO-DEMO-0003')
    expect(html('reject-other', 'en')).toContain('Another reason needs a note')
    expect(html('no-access', 'en')).toContain('Requests to buy are not in your role')
    // No money for a role without the cost grain: not even a label (the grid's columns draw in the browser only).
    expect(html('detail-plan', 'en')).toContain('Unit price')
    expect(html('read-only', 'en')).not.toContain('Unit price')
    expect(html('read-only', 'en')).not.toContain('€')
    expect(html('open', 'en')).toContain('>Draft POs<')
  })

  it('has words for every status, hold, warning, view, unit, reason and tile in both languages', () => {
    for (const locale of LOCALES) {
      const t = words(locale)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const status of REQUEST_STATUSES) has(`status.${status}`)
      for (const hold of REQUEST_HOLDS) has(`hold.${hold}`)
      for (const warning of REQUEST_WARNINGS) has(`warning.${warning}`)
      for (const view of VIEWS) has(`view.${view}`)
      for (const group of GROUPS) has(`groupBy.${group}`)
      for (const uom of UOMS) has(`uom.${uom}`)
      for (const reason of SET_ASIDE_REASONS) has(`reason.${reason}`)
      for (const tile of TILES) has(`tile.${tile.id}`)
      for (const from of ['CHOSEN', 'FIRM', 'SITE', 'DEFAULT']) has(`supplierFrom.${from}`)
      has('supplierFrom.SOURCE', { count: 2 })
      for (const rule of ['WHOLE_UNITS', 'MINIMUM', 'MULTIPLE', 'MAXIMUM', 'LOT_SIZE', 'UP_TO_MAXIMUM', 'OTHER']) has(`rounding.${rule}`)
    }
  })
})
