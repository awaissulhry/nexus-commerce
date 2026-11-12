import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { COLOURS, ITEMS, LOCATIONS, LOTS, named, ROLE_PERMISSIONS, SITE, SITE_SOUTH, stockRow } from '../../../_shared/stock/fixtures'
import { designScreen as movesScreen } from '../../moves/fixtures'
import { ledgerQueryOf, movesAddressOf, movesQueryString } from '../../moves/model'
import { MovesView } from '../../moves/view/MovesView'
import { blankDraft } from '../adjust/model'
import { adjustBody, adjustChecks } from '../adjust/model'
import { designScreen as stockScreen } from '../fixtures'
import { stockAddressOf, stockLines, stockQueryString, STOCK_TILES } from '../model'
import { StockView } from '../view/StockView'
import { PLACES, POSTING_HARD, POSTING_OK, POSTING_SOFT, POSTING_TOO_FAR, RULES, TRANSIT, TRANSIT_ROW, WHY_LINING } from './demo/fixtures'
import {
  approvalNoticeOf,
  bridgeSteps,
  isInTransit,
  lowCount,
  moveHeldKey,
  moveInputs,
  movePlan,
  moveProblemOf,
  movesAddressOfLink,
  moveStartHeldKey,
  moveTargets,
  periodFromDay,
  placesById,
  postingHeldOf,
  searchLow,
  transitHref,
  whyKeyOf,
  type MoveDialogModel,
} from './model'
import { LOW_ROWS } from './demo/fixtures'
import { DEPTH_NAMESPACE } from './model'
import { ApprovalBanner, PostingNote } from './view/AdjustParts'

const NAMESPACES = ['shell', 'lists', 'stock']
const draw = (view: unknown, model: unknown, locale: 'it' | 'en' = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(view as never, { model } as never)))
// A key of this step's catalogue left on screen ("wd.move.title").
const LEFT_KEY = /\bwd\.[a-zA-Z]+(?:\.[a-zA-Z_]+)+\b/

const hide = (n: number, location = LOCATIONS.cutting, area = '30.0000') =>
  stockRow({ item: ITEMS.leather, location: named(location), colour: COLOURS.black, lot: { ...LOTS.nappa, qualityStatus: 'RELEASED' }, hide: { id: `hide-${n}`, code: `HD-${n}` }, onHand: area, held: '0.0000', available: area })
const lining = stockRow({ item: ITEMS.lining, location: named(LOCATIONS.binA2), colour: COLOURS.black, lot: { ...LOTS.lining, qualityStatus: 'RELEASED' }, onHand: '120.0000', held: '0.0000', available: '120.0000' })
const ROWS = [hide(1), hide(2, LOCATIONS.cutting, '20.0000'), hide(3, LOCATIONS.binA1), lining]
const LINES = stockLines(ROWS, false, false)
const lineAt = (place: string, item = ITEMS.leather.id) => LINES.find((line) => line.location.id === place && line.item.id === item)!
const byId = placesById(PLACES)
const dialog = (lines: MoveDialogModel['lines'], draft: Partial<MoveDialogModel['draft']> = {}): MoveDialogModel => ({ lines, planned: movePlan(lines, ROWS), draft: { toLocationId: '', quantity: '', note: '', ...draft }, targets: moveTargets(PLACES, SITE.id), posting: false, problem: null })

describe('B-W2b-327 stock and moves in depth: why is it this number, in transit, below minimum', () => {
  it('explains the row’s own stock key and turns the ledger’s links into Movements addresses', () => {
    expect(whyKeyOf(lineAt(LOCATIONS.binA2.id, ITEMS.lining.id))).toEqual({ siteId: SITE.id, itemId: ITEMS.lining.id, itemColourId: COLOURS.black.id, lotId: LOTS.lining.id, hideId: null, locationId: LOCATIONS.binA2.id })
    const href = movesAddressOfLink('/w/DEMO', WHY_LINING.steps[1]!.link, { why: '1' })
    expect(href).toBe(`/w/DEMO/warehouse/moves?site=${SITE.id}&item=${ITEMS.lining.id}&lot=${LOTS.lining.id}&location=${LOCATIONS.binA2.id}&reasons=ISSUE&why=1`)
    // A posting-day period of the API's link is not an address term (a key reads its whole ledger).
    expect(movesAddressOfLink('', { path: '/inventory/ledger', query: { siteId: 's', itemId: 'i', postedTo: '2026-10-30' } })).toBe('/warehouse/moves?site=s&item=i')
  })

  it('draws the balance bridge from the start through each reason to the end read apart', () => {
    expect(bridgeSteps(WHY_LINING).map((step) => [step.kind, step.reason, step.amount])).toEqual([
      ['start', null, 0],
      ['step', 'RECEIPT', 150],
      ['step', 'ISSUE', -32],
      ['step', 'COUNT', 2],
      ['total', null, 120],
    ])
    expect(periodFromDay(null, new Date('2026-10-30T09:00:00Z'), 'Europe/Rome')).toBeNull()
    // 30 days before 30 Oct 00:30 in Rome is 30 Sep (Rome's day, not UTC's).
    expect(periodFromDay(30, new Date('2026-10-29T23:30:00Z'), 'Europe/Rome')).toBe('2026-09-30')
  })

  it('says what lies in transit and links the sending site’s transfers in transit', () => {
    const [transit] = stockLines([TRANSIT_ROW], false, false)
    expect(isInTransit(transit!, byId)).toBe(true)
    expect(isInTransit(lineAt(LOCATIONS.binA2.id, ITEMS.lining.id), byId)).toBe(false)
    expect(transitHref('/w/DEMO', SITE.id)).toBe(`/w/DEMO/warehouse/transfers?from=${SITE.id}&tile=IN_TRANSIT`)
  })

  it('counts below minimum over the sites read — unknown when one read failed, never 0 — and searches its rows', () => {
    expect(lowCount([2, 1])).toBe(3)
    expect(lowCount([2, null])).toBeNull()
    expect(lowCount([])).toBeNull()
    expect(searchLow(LOW_ROWS, 'zip').map((row) => row.item.code)).toEqual([ITEMS.zip.code])
    expect(searchLow(LOW_ROWS, 'rosso').length).toBe(1)
    expect(STOCK_TILES).toContain('low')
    expect(stockQueryString({ ...stockAddressOf(null), tile: 'low' })).toBe('tile=low')
    expect(stockAddressOf(new URLSearchParams('tile=low')).tile).toBe('low')
  })
})

describe('B-W2b-327 Move…: one move per stock key, a hide whole, blocked and transit places refused first', () => {
  it('moves each hide of a folded leather row whole, and another row by its stock key', () => {
    const leather = lineAt(LOCATIONS.cutting.id)
    expect(leather.hides).toBe(2)
    expect(movePlan([leather], ROWS).map((entry) => [entry.label, entry.input.hideId, entry.input.quantity])).toEqual([
      ['HD-1', 'hide-1', '30.0000'],
      ['HD-2', 'hide-2', '20.0000'],
    ])
    const plan = movePlan([lineAt(LOCATIONS.binA2.id, ITEMS.lining.id)], ROWS)
    expect(plan).toHaveLength(1)
    expect(plan[0]!.input).toMatchObject({ itemId: ITEMS.lining.id, lotId: LOTS.lining.id, fromLocationId: LOCATIONS.binA2.id, quantity: '120.0000' })
  })

  it('holds Move with the reason: a blocked place either side, a transit place, the same place, part of a row', () => {
    const liningLine = lineAt(LOCATIONS.binA2.id, ITEMS.lining.id)
    expect(moveHeldKey(dialog([liningLine]), byId)).toEqual({ key: 'wd.move.held.pick' })
    // Bin A1 is blocked by a running count in the demo places.
    expect(moveHeldKey(dialog([liningLine], { toLocationId: LOCATIONS.binA1.id, quantity: '1' }), byId)).toEqual({ key: 'wd.move.held.toBlocked', params: { code: LOCATIONS.binA1.code } })
    expect(moveHeldKey(dialog([lineAt(LOCATIONS.binA1.id)], { toLocationId: LOCATIONS.binA2.id }), byId)).toEqual({ key: 'wd.move.held.fromBlocked', params: { code: LOCATIONS.binA1.code } })
    expect(moveHeldKey(dialog([liningLine], { toLocationId: LOCATIONS.binA2.id, quantity: '1' }), byId)).toEqual({ key: 'wd.move.held.same' })
    expect(moveHeldKey(dialog([liningLine], { toLocationId: LOCATIONS.receiving.id, quantity: '0' }), byId)).toEqual({ key: 'wd.move.held.quantity' })
    expect(moveHeldKey(dialog([liningLine], { toLocationId: LOCATIONS.receiving.id, quantity: '121' }), byId)).toEqual({ key: 'wd.move.held.tooMuch' })
    expect(moveHeldKey(dialog([liningLine], { toLocationId: LOCATIONS.receiving.id, quantity: '40,5' }), byId)).toBeNull()
    const [transit] = stockLines([TRANSIT_ROW], false, false)
    expect(moveHeldKey(dialog([transit!], { toLocationId: LOCATIONS.receiving.id }), byId)).toEqual({ key: 'wd.move.held.transit', params: { code: TRANSIT.code } })
    const south = stockLines([stockRow({ siteId: SITE_SOUTH.id, siteCode: SITE_SOUTH.code, item: ITEMS.zip, location: { id: 's1', code: 'S-MAG', name: 'Sud' }, onHand: '5.0000', held: '0.0000', available: '5.0000' })], false, false)
    expect(moveHeldKey(dialog([liningLine, ...south], { toLocationId: LOCATIONS.receiving.id }), byId)).toEqual({ key: 'wd.move.held.sites' })
    // A move never goes to a place outside the site or in transit.
    expect(moveTargets(PLACES, SITE.id).some((place) => place.kind === 'TRANSIT')).toBe(false)
  })

  it('sends part of one row, the rest whole; rows already there are left out', () => {
    const liningLine = lineAt(LOCATIONS.binA2.id, ITEMS.lining.id)
    expect(moveInputs(dialog([liningLine], { toLocationId: LOCATIONS.receiving.id, quantity: '40,5', note: ' per WO ' }))).toEqual([
      { key: liningLine.id, label: `${ITEMS.lining.code} · ${LOTS.lining.code}`, input: expect.objectContaining({ quantity: '40.5', toLocationId: LOCATIONS.receiving.id, note: 'per WO' }) },
    ])
    const two = moveInputs(dialog([lineAt(LOCATIONS.cutting.id), liningLine], { toLocationId: LOCATIONS.binA2.id }))
    expect(two.map((entry) => entry.input.hideId ?? entry.input.itemId)).toEqual(['hide-1', 'hide-2'])
  })

  it('says a refused move in our words and holds Move… where it cannot start', () => {
    expect(moveProblemOf(new ApiError('conflict', 409, 'conflict', 'Location X is blocked.', null, [{ path: 'warehouse/LOCATION_BLOCKED' }]))).toEqual({ key: 'wd.move.problem.blocked' })
    expect(moveProblemOf(new ApiError('invalid', 400, 'validation', 'Not that kind.', null, [{ path: 'body/toLocationId' }]))).toEqual({ key: 'wd.move.problem.kind' })
    expect(moveProblemOf(new ApiError('conflict', 409, 'conflict', 'Below zero.', null, [{ path: 'body/quantity' }]))).toEqual({ key: 'wd.move.problem.notEnough' })
    expect(moveProblemOf(new Error('x'))).toEqual({ key: 'wd.move.problem.write' })
    expect(moveStartHeldKey([lineAt(LOCATIONS.cutting.id)], { transfer: false }, false)).toBe('wd.move.held.noRight')
    expect(moveStartHeldKey([lineAt(LOCATIONS.cutting.id)], { transfer: true }, true)).toBe('wd.move.held.pastDate')
    expect(moveStartHeldKey([], { transfer: true }, false)).toBe('wd.move.held.pickRows')
    expect(moveStartHeldKey([lineAt(LOCATIONS.cutting.id)], { transfer: true }, false)).toBeNull()
  })
})

describe('B-W2b-327 adjustments: the approval banner, the posting day, waiting for a yes', () => {
  it('shows the banner only with a value set and an approval rule on; the value only with the cost grain', () => {
    expect(approvalNoticeOf(RULES, [{ name: 'Finance' }])).toEqual({ amount: 50_000, currency: 'EUR', approvers: ['Finance'] })
    expect(approvalNoticeOf({ ...RULES, adjustmentApproval: { ...RULES.adjustmentApproval, approvalRules: { active: 0 } } }, null)).toBeNull()
    expect(approvalNoticeOf({ ...RULES, adjustmentApproval: { ...RULES.adjustmentApproval, inForce: { set: false } } }, null)).toBeNull()
    expect(approvalNoticeOf({ ...RULES, adjustmentApproval: { ...RULES.adjustmentApproval, inForce: { set: true }, held: 'Needs the cost grain.' } }, null)).toEqual({ amount: null, currency: 'EUR', approvers: [] })
    expect(approvalNoticeOf(null, null)).toBeNull()
  })

  it('checks a posting day as the post will: the limit with its earliest day, a closed month, a soft lock’s reason', () => {
    expect(postingHeldOf({ day: '', check: null, lockReason: '' })).toBeNull()
    expect(postingHeldOf({ day: '2026-10-28', check: { status: 'loading' }, lockReason: '' })).toEqual({ key: 'wd.posting.checking' })
    expect(postingHeldOf({ day: '2026-10-28', check: { status: 'ready', value: POSTING_OK }, lockReason: '' })).toBeNull()
    expect(postingHeldOf({ day: '2026-10-20', check: { status: 'ready', value: POSTING_TOO_FAR }, lockReason: '' })).toEqual({ key: 'wd.posting.tooFar', params: { earliest: '2026-10-27' } })
    expect(postingHeldOf({ day: '2026-09-30', check: { status: 'ready', value: POSTING_HARD }, lockReason: '' })).toEqual({ key: 'wd.posting.closed' })
    expect(postingHeldOf({ day: '2026-09-30', check: { status: 'ready', value: POSTING_SOFT }, lockReason: '' })).toEqual({ key: 'wd.posting.lockReason' })
    expect(postingHeldOf({ day: '2026-09-30', check: { status: 'ready', value: POSTING_SOFT }, lockReason: 'Inventario di fine settembre' })).toBeNull()
  })

  it('sends the posting date and a soft lock’s reason with the adjustment, and holds the post until the day is checked', () => {
    const target = { siteId: SITE.id, siteCode: SITE.code, item: ITEMS.lining, colour: COLOURS.black, lot: LOTS.lining, hide: null, location: named(LOCATIONS.binA2), onHand: '120.0000' }
    const draft = { ...blankDraft(target), quantity: '2', note: 'Rotolo rovinato', postingDay: '2026-09-30', lockReason: 'Inventario di fine settembre' }
    expect(adjustChecks({ target, draft, withCost: false, postingCheck: { status: 'loading' } })).toEqual(['posting'])
    const model = { target, draft, withCost: false, postingCheck: { status: 'ready' as const, value: POSTING_SOFT } }
    expect(adjustChecks(model)).toEqual([])
    expect(adjustBody(model)).toMatchObject({ postingDate: '2026-09-30', periodLockOverride: { reason: 'Inventario di fine settembre' } })
    expect(adjustBody({ ...model, draft: { ...draft, postingDay: '' } })).not.toHaveProperty('postingDate')
  })
})

describe('B-W2b-327 Movements: the period by posting day, moves dated apart, the waiting adjustments in the address', () => {
  it('reads by posting day from the period’s first Rome day (no running balance then), and moves dated apart', () => {
    const now = new Date('2026-10-30T09:00:00Z')
    const address = { ...movesAddressOf(null), period: '30d' as const, by: 'posting' as const, dated: 'back' as const }
    expect(ledgerQueryOf(address, now, null)).toMatchObject({ from: null, postedFrom: '2026-09-30', backDated: true })
    expect(ledgerQueryOf({ ...address, by: 'entry', dated: 'same' }, now, null)).toMatchObject({ postedFrom: null, backDated: false, from: '2026-09-30T09:00:00.000Z' })
    const round = movesAddressOf(new URLSearchParams(movesQueryString({ ...address, waiting: 'all' })))
    expect([round.by, round.dated, round.waiting]).toEqual(['posting', 'back', 'all'])
    expect(movesQueryString(movesAddressOf(null))).toBe('')
  })
})

describe('B-W2b-327 draws every W2b design case in both languages with no key left', () => {
  const W2B = (cases: readonly { id: string }[]) => cases.filter((item) => item.id.startsWith('w2b-'))
  for (const locale of LOCALES) {
    it(`Stock’s ${W2B(stockScreen.cases).length} and Movements’ ${W2B(movesScreen.cases).length} cases in ${locale}`, () => {
      for (const item of stockScreen.cases) {
        const html = draw(StockView, item.model.page, locale)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-060/${item.id} (${locale})`).toBeNull()
        expect(/\{[a-zA-Z]+\}/.test(html), `SCR-060/${item.id} (${locale}) placeholder`).toBe(false)
      }
      for (const item of movesScreen.cases) {
        const html = draw(MovesView, item.model.page, locale)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-064/${item.id} (${locale})`).toBeNull()
        expect(/\{[a-zA-Z]+\}/.test(html), `SCR-064/${item.id} (${locale}) placeholder`).toBe(false)
      }
    })
  }

  it('says the step’s words on screen: below minimum, the approval banner, the posting day, waiting for a yes', () => {
    // The grid's cells and the dialogs draw in the browser; the tiles, banners and the band draw here.
    expect(draw(StockView, stockScreen.cases.find((item) => item.id === 'w2b-low')!.model.page)).toContain('below their minimum')
    expect(draw(StockView, stockScreen.cases.find((item) => item.id === 'w2b-waiting')!.model.page)).toContain('Waiting for approval by Amministrazione')
    expect(draw(MovesView, movesScreen.cases.find((item) => item.id === 'w2b-waiting-closed')!.model.page)).toContain('Waiting for approval')
    const part = (element: ReturnType<typeof createElement>, locale: 'it' | 'en' = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['stock', DEPTH_NAMESPACE]) }, element))
    expect(part(createElement(ApprovalBanner, { notice: approvalNoticeOf(RULES, [{ name: 'Amministrazione' }])! }))).toMatch(/Needs approval above €\s?500\.00/)
    // Without the cost grain the value is held: never a figure.
    expect(part(createElement(ApprovalBanner, { notice: { amount: null, currency: 'EUR', approvers: ['Amministrazione'] } }))).not.toMatch(/€|EUR|500/)
    expect(part(createElement(PostingNote, { posting: { day: '2026-10-20', check: { status: 'ready', value: POSTING_TOO_FAR }, lockReason: '' }, onLockReason: () => undefined }), 'it')).toContain('27/10/2026')
    expect(part(createElement(PostingNote, { posting: { day: '2026-09-30', check: { status: 'ready', value: POSTING_SOFT }, lockReason: '' }, onLockReason: () => undefined }))).toContain('Why it goes into a closed month')
    expect(ROLE_PERMISSIONS.readOnly).not.toContain('inventory.transfer')
  })
})
