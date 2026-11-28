import { describe, expect, it } from 'vitest'
import { ACTION_FACES, ACTION_ICONS, actionFaceOf, CUSTOMER_ALLOWED_ACTIONS, CUSTOMER_OWN_ROWS_ONLY, customerMayRead, floorFaceOf, ORDER_LOG_ACTIONS, PICTURE_SET_ACTION, whoFaceOf, type LogActorRow } from './faces'

/** owb- (order workflow, b2.4): who each door sees on a log row, and the customer's ALLOW-list. Made-up names only. */
const ALPHA = 'party-brand-alpha'
const BETA = 'party-brand-beta'
const office: LogActorRow = { audience: 'OFFICE', actorId: 'user-sam', actorName: 'Sam Sales' }
const worker: LogActorRow = { audience: 'FLOOR', actorId: 'worker-pia', actorName: 'Pia Stitcher', departmentNo: 4 }
const buyer: LogActorRow = { audience: 'PARTNER', actorId: 'user-bianca', actorName: 'Bianca Buyer', actorPartyId: ALPHA }
const system: LogActorRow = { audience: 'SYSTEM', actorId: 'system', actorName: null }

describe('whoFaceOf: one log, three faces', () => {
  it('office: names (office user, customer person); a worker by name only behind an open gate, else the department', () => {
    expect(whoFaceOf(office, 'office', { workerNamesOpen: false })).toEqual({ face: 'PERSON', name: 'Sam Sales', departmentNo: null })
    expect(whoFaceOf(buyer, 'office', { workerNamesOpen: false })).toEqual({ face: 'PERSON', name: 'Bianca Buyer', departmentNo: null })
    expect(whoFaceOf(worker, 'office', { workerNamesOpen: true })).toEqual({ face: 'PERSON', name: 'Pia Stitcher', departmentNo: null })
    expect(whoFaceOf(worker, 'office', { workerNamesOpen: false })).toEqual({ face: 'DEPARTMENT', name: null, departmentNo: 4 })
    expect(whoFaceOf(system, 'office', { workerNamesOpen: true })).toEqual({ face: 'SYSTEM', name: null, departmentNo: null })
  })

  it('portal: a worker\'s name never reaches the customer, nor an office person\'s — "The factory"; its own colleague by name', () => {
    for (const row of [office, worker, { ...worker, departmentNo: null }]) {
      const who = whoFaceOf(row, 'portal', { workerNamesOpen: true, viewerPartyId: ALPHA })
      expect(who).toEqual({ face: 'THE_FACTORY', name: null, departmentNo: null })
      expect(JSON.stringify(who)).not.toContain('Pia')
      expect(JSON.stringify(who)).not.toContain('Sam')
    }
    expect(whoFaceOf(buyer, 'portal', { workerNamesOpen: false, viewerPartyId: ALPHA })).toEqual({ face: 'PERSON', name: 'Bianca Buyer', departmentNo: null })
    // Brand wall: another customer's person is never named to this one.
    expect(whoFaceOf(buyer, 'portal', { workerNamesOpen: false, viewerPartyId: BETA })).toEqual({ face: 'THE_FACTORY', name: null, departmentNo: null })
    expect(whoFaceOf(buyer, 'portal', { workerNamesOpen: false, viewerPartyId: null })).toMatchObject({ face: 'THE_FACTORY' })
  })

  it('floor: "You" for the device\'s worker, "Office" for the office and the customer, the department for a colleague — never a name, gate or not', () => {
    expect(whoFaceOf(worker, 'floor', { workerNamesOpen: true, viewerWorkerId: 'worker-pia' })).toEqual({ face: 'YOU', name: null, departmentNo: null })
    expect(whoFaceOf(worker, 'floor', { workerNamesOpen: true, viewerWorkerId: 'worker-ola' })).toEqual({ face: 'DEPARTMENT', name: null, departmentNo: 4 })
    expect(whoFaceOf(office, 'floor', { workerNamesOpen: true, viewerWorkerId: 'worker-pia' })).toEqual({ face: 'OFFICE', name: null, departmentNo: null })
    expect(whoFaceOf(buyer, 'floor', { workerNamesOpen: true, viewerWorkerId: 'worker-pia' })).toEqual({ face: 'OFFICE', name: null, departmentNo: null })
    const faces = floorFaceOf([worker, office, buyer, system, { ...worker, actorId: 'worker-ola', actorName: 'Ola Cutter', departmentNo: 2 }], { viewerWorkerId: 'worker-pia' })
    expect(faces.map((who) => who.face)).toEqual(['YOU', 'OFFICE', 'OFFICE', 'SYSTEM', 'DEPARTMENT'])
    expect(faces.every((who) => who.name === null)).toBe(true)
    // A hidden-name floor: no viewer worker known, still no name anywhere.
    expect(floorFaceOf([worker], {}).map((who) => who.name)).toEqual([null])
  })
})

describe('the actions: one word and one icon each', () => {
  it('every word key has one icon; every mapped action names a known key; an unknown action is OTHER', () => {
    expect(Object.keys(ACTION_ICONS).sort()).toEqual([...ORDER_LOG_ACTIONS].sort())
    for (const [action, faceOf] of Object.entries(ACTION_FACES)) {
      expect(ORDER_LOG_ACTIONS, action).toContain(faceOf.key)
      expect(faceOf.icon, action).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
    expect(actionFaceOf(PICTURE_SET_ACTION)).toEqual({ key: 'PICTURE_SET', icon: 'image' })
    expect(actionFaceOf('orders.changePromise')).toEqual({ key: 'PROMISE_MOVED', icon: 'calendar-clock' })
    expect(actionFaceOf('production.holds.place')).toEqual({ key: 'OTHER', icon: 'history' })
  })
})

describe('the customer\'s ALLOW-list (never a hide-list)', () => {
  it('holds the life, the promise, the picture, the shipments; never a hold, Rush, a note, a cost, a price, a team, a basket move', () => {
    for (const action of ['portalOrdering.send', 'portalOrdering.withdraw', 'orders.changePromise', PICTURE_SET_ACTION, 'orders.markReady', 'orders.cancel', 'shipping.ship', 'shipping.recordPod']) expect(CUSTOMER_ALLOWED_ACTIONS.has(action), action).toBe(true)
    for (const action of ['orders.priority', 'shipping.holdPlaced', 'shipping.placeHold', 'quality.holds.place', 'orders.close', 'orders.moneyPlan', 'orders.waiveDeposit', 'brandPrices.fromRequest', 'portalOrdering.takePrices', 'credit.orderGoesOn', 'orders.askApproval', 'tasks.create', 'production.baskets.move', 'production.teams.assign', 'orders.restrict', 'sales.orderChangeNotes', 'threads.post', 'notes.add']) expect(CUSTOMER_ALLOWED_ACTIONS.has(action), action).toBe(false)
    // An office note action is not on the list — whatever its name.
    expect([...CUSTOMER_ALLOWED_ACTIONS].filter((action) => /note|hold|cost|price|rush|priority|team|basket|worker/i.test(action))).toEqual([])
    // Every allowed action has a word of its own (never OTHER to a customer).
    for (const action of CUSTOMER_ALLOWED_ACTIONS) expect(actionFaceOf(action).key, action).not.toBe('OTHER')
    for (const action of CUSTOMER_OWN_ROWS_ONLY) expect(CUSTOMER_ALLOWED_ACTIONS.has(action), action).toBe(true)
  })

  it('lines added or taken out: the customer reads its OWN people\'s rows only; a row of another party never', () => {
    expect(customerMayRead({ action: 'portalOrdering.addLines', audience: 'PARTNER', actorPartyId: ALPHA }, ALPHA)).toBe(true)
    expect(customerMayRead({ action: 'portalOrdering.addLines', audience: 'OFFICE', actorPartyId: null }, ALPHA)).toBe(false)
    expect(customerMayRead({ action: 'portalOrdering.removeLine', audience: 'PARTNER', actorPartyId: BETA }, ALPHA)).toBe(false)
    expect(customerMayRead({ action: 'orders.changePromise', audience: 'OFFICE', actorPartyId: null }, ALPHA)).toBe(true)
    expect(customerMayRead({ action: 'orders.priority', audience: 'OFFICE', actorPartyId: null }, ALPHA)).toBe(false)
  })
})
