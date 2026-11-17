import { describe, expect, it } from 'vitest'
import { WORKING_DAY_MINUTES } from '../sales/inquiries/rules'
import { amberOf, WAITING_THRESHOLD_DAYS, waitingOf } from './waiting'

/** B-TH-028: the one waiting rule (a request by its state, any other record by its newest shared message). */
describe('waitingOf', () => {
  const came = new Date('2026-11-10T09:00:00.000Z')
  const asked = new Date('2026-11-11T10:00:00.000Z')

  it('a request waits on us while NEW or ASSIGNED, since it came; on the customer while NEED_INFO, since our question; nobody once closed', () => {
    expect(waitingOf({ request: { status: 'NEW', receivedAt: came }, lastShared: null, hasParty: false })).toEqual({ on: 'US', since: came, thresholdDays: WAITING_THRESHOLD_DAYS.REQUEST })
    expect(waitingOf({ request: { status: 'ASSIGNED', receivedAt: came }, lastShared: { direction: 'OUTBOUND', at: asked }, hasParty: true })).toMatchObject({ on: 'US', since: came })
    expect(waitingOf({ request: { status: 'NEED_INFO', receivedAt: came }, lastShared: { direction: 'OUTBOUND', at: asked }, lastOutbound: asked, hasParty: true })).toMatchObject({ on: 'CUSTOMER', since: asked })
    // Need info with no question of ours on the thread (asked outside it): since it came.
    expect(waitingOf({ request: { status: 'NEED_INFO', receivedAt: came }, lastShared: null, lastOutbound: null, hasParty: true })).toMatchObject({ on: 'CUSTOMER', since: came })
    for (const status of ['QUOTED', 'ORDERED', 'DECLINED', 'LOST'] as const) expect(waitingOf({ request: { status, receivedAt: came }, lastShared: { direction: 'INBOUND', at: asked }, hasParty: true })).toBeNull()
  })

  it('any other record waits by its newest shared message: theirs on us, ours on them; no party or no shared message: nobody', () => {
    expect(waitingOf({ lastShared: { direction: 'INBOUND', at: asked }, hasParty: true })).toEqual({ on: 'US', since: asked, thresholdDays: WAITING_THRESHOLD_DAYS.OTHER })
    expect(waitingOf({ lastShared: { direction: 'OUTBOUND', at: asked }, hasParty: true })).toMatchObject({ on: 'CUSTOMER', since: asked })
    expect(waitingOf({ lastShared: null, hasParty: true })).toBeNull()
    expect(waitingOf({ lastShared: { direction: 'INBOUND', at: asked }, hasParty: false })).toBeNull()
  })

  it('amber after 1 working day on us for a request, 3 for any other record; never while it waits on the customer', () => {
    const request = waitingOf({ request: { status: 'NEW', receivedAt: came }, lastShared: null, hasParty: true })!
    expect(amberOf(request, WORKING_DAY_MINUTES)).toBe(false)
    expect(amberOf(request, WORKING_DAY_MINUTES + 1)).toBe(true)
    const other = waitingOf({ lastShared: { direction: 'INBOUND', at: asked }, hasParty: true })!
    expect(amberOf(other, 2 * WORKING_DAY_MINUTES + 1)).toBe(false)
    expect(amberOf(other, 3 * WORKING_DAY_MINUTES + 1)).toBe(true)
    const theirs = waitingOf({ lastShared: { direction: 'OUTBOUND', at: asked }, hasParty: true })!
    expect(amberOf(theirs, 100 * WORKING_DAY_MINUTES)).toBe(false)
  })
})
