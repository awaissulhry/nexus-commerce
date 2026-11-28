import { describe, expect, it } from 'vitest'
import en from '../../../../messages/en/production-baskets.json'
import { board, card, route, step } from './fixtures'
import { allCards, cardStateOf, columnsOf, customerWords, filterOptions, moveTargets, orderHref, printAgainReady, READY, targetIds } from './model'
import { isEmpty, lateOpen, mayAnswerLate, mayShare, promiseReasonFor, proposedPromise } from './parts/from-the-floor/model'

describe('owb-fl9 — the Baskets board (office)', () => {
  it('has one column per department in use, in the server\'s order, then Ready to ship', () => {
    const columns = columnsOf(board, 'en')
    expect(columns.map((column) => column.key)).toEqual(['dept-1', 'dept-2', 'dept-8', READY])
    expect(columns.map((column) => column.department?.no ?? null)).toEqual([1, 2, 8, null])
    // An empty department in use keeps its column (the board keeps its shape).
    expect(columns[0]!.cards).toEqual([])
    expect(allCards(board).map((entry) => entry.code)).toEqual(['B-0431', 'B-0385', 'B-0402'])
  })

  it('names the customer on the office card and only the CODE on the floor card', () => {
    expect(customerWords(card(), 'office')).toBe('Seed Racing Example')
    expect(customerWords(card(), 'floor')).toBe('SEED')
    // The server left the name out (a person not allowed that customer): the office reads the code too.
    expect(customerWords(card({ customer: { code: 'SEED', name: null } }), 'office')).toBe('SEED')
  })

  it('says the state, and Ready to ship in that column', () => {
    expect(cardStateOf(card({ state: 'PAUSED' }), false)).toBe('PAUSED')
    expect(cardStateOf(card({ state: 'something new' }), false)).toBe('WAITING')
    expect(cardStateOf(card(), true)).toBe('READY')
  })

  it('offers the filters the board carries: its teams, its departments, its orders', () => {
    const options = filterOptions(board, 'en')
    expect(options.teams).toEqual([{ id: 'team-blue', label: 'Team Blue' }])
    expect(options.departments.map((option) => option.id)).toEqual(['dept-1', 'dept-2', 'dept-8'])
    expect(options.orders.map((option) => option.id).sort()).toEqual(['order-100', 'order-101'])
  })
})

describe('owb-fl9 — "Move it to" offers only the steps of ITS route', () => {
  it('lists the route\'s steps (never a skipped one, never where it is) and Ready to ship; back before, forward after', () => {
    const targets = moveTargets(route, 'op-cut')
    expect(targetIds(targets)).toEqual(['op-pattern', 'op-stitch', 'op-quality', 'op-pack', null])
    expect(targets.find((target) => target.operationId === 'op-pattern')!.kind).toBe('BACK')
    expect(targets.find((target) => target.operationId === 'op-stitch')!.kind).toBe('FORWARD')
    expect(targetIds(targets)).not.toContain('op-patch')
    expect(targetIds(targets)).not.toContain('op-cut')
  })

  it('holds Ready to ship until the route\'s last step is done (settle 7), in words', () => {
    expect(moveTargets(route, 'op-cut').at(-1)).toMatchObject({ operationId: null, held: 'PACK_FIRST' })
    const packed = [...route.slice(0, 5), step('op-pack', 60, 'DONE')]
    expect(moveTargets(packed, 'op-quality').at(-1)).toMatchObject({ operationId: null, held: null })
    expect(en.window.packFirst).toBe('Pack it first: Packed at Packing makes it ready to ship.')
  })

  it('from Ready to ship, every step of its route is back', () => {
    const targets = moveTargets(route, null)
    expect(targets.every((target) => target.kind === 'BACK')).toBe(true)
    expect(targetIds(targets)).not.toContain(null)
  })

  it('shows "Print its card and pages again…" only once S3\'s slot says it is built', () => {
    expect(printAgainReady({ PrintAgainWindow: () => null })).toBe(false)
    expect(printAgainReady({ PrintAgainWindow: () => null, PRINT_AGAIN_READY: true })).toBe(true)
    expect(orderHref('/w/A', 'order-100', 'files')).toBe('/w/A/sales/orders/order-100?tab=files')
  })
})

describe('owb-fl9 — From the floor', () => {
  const empty = { photos: [], changes: [], late: [] }
  it('says one sentence when the floor sent nothing', () => {
    expect(isEmpty(empty)).toBe(true)
    expect(isEmpty({ ...empty, late: [{ id: 'l1', days: 2, reason: 'MATERIAL', state: 'OPEN', at: '2026-11-28T09:00:00.000Z', basketCodes: ['B-0431'] }] })).toBe(false)
    expect(en.floor.empty).toBe('Nothing from the floor for this order yet.')
  })

  it('lets only sales or the owner share a photo, and only orders.manage answer a late warning', () => {
    expect(mayShare(['files.upload', 'files.manage'])).toBe(true)
    expect(mayShare(['files.upload'])).toBe(false)
    expect(mayAnswerLate(['orders.manage'])).toBe(true)
    expect(mayAnswerLate(['workorders.view'])).toBe(false)
    expect(lateOpen({ state: 'OPEN' })).toBe(true)
    expect(lateOpen({ state: 'KEPT' })).toBe(false)
  })

  it('proposes the promise moved by the late days, and the reason the customer reads', () => {
    expect(proposedPromise('2026-12-10', 2)).toBe('2026-12-12')
    expect(proposedPromise('2026-12-30', 5)).toBe('2027-01-04')
    expect(proposedPromise(null, 2)).toBe('')
    expect(promiseReasonFor('MATERIAL')).toBe('MATERIAL_LATE')
    expect(promiseReasonFor('REDO')).toBe('QUALITY')
    expect(promiseReasonFor('PEOPLE')).toBe('CAPACITY')
  })
})
