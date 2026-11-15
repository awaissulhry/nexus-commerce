import { describe, expect, it } from 'vitest'
import { bookingProblems, comesOn, isTestPickup, moveProblems, moveRefusal, pickupViaOf, pickupWindow, readyTimeOf, testPickupReference, weekdaysInOrder, type PickupBooking } from './rules'

const NOW = new Date('2026-11-16T09:00:00.000Z') // a Monday
const ADDRESS = { name: 'Made-up Works', line1: 'Via Finta 1', postalCode: '20100', city: 'Milano', country: 'IT' }
const booking = (over: Partial<PickupBooking> = {}): PickupBooking => ({
  via: 'SENDCLOUD',
  carrierCode: 'brt',
  readyAt: new Date('2026-11-16T14:00:00.000Z'),
  parcels: 2,
  pallets: 0,
  address: null,
  repeatWeekdays: [],
  note: null,
  providerReference: null,
  weightKg: null,
  ...over,
})
const paths = (problems: readonly { path: string }[]) => problems.map((problem) => problem.path)

describe('booking a pickup (LOG-048)', () => {
  it('takes a one-off through Sendcloud and a recurring round by phone with its note', () => {
    expect(bookingProblems(booking({ weightKg: '12.5' }), NOW)).toEqual([])
    expect(bookingProblems(booking({ via: 'PHONE', note: 'With the depot, Anna', repeatWeekdays: ['MONDAY', 'FRIDAY'], providerReference: 'BRT-77' }), NOW)).toEqual([])
    expect(bookingProblems(booking({ address: ADDRESS }), NOW)).toEqual([])
  })

  it('refuses what a carrier cannot take: no goods, a time gone or too far, a carrier code with spaces, weekdays twice', () => {
    expect(paths(bookingProblems(booking({ parcels: 0, pallets: 0 }), NOW))).toEqual(['body/parcels'])
    expect(paths(bookingProblems(booking({ parcels: -1, pallets: 10_000 }), NOW))).toEqual(['body/parcels', 'body/pallets'])
    expect(paths(bookingProblems(booking({ readyAt: new Date('2026-11-16T08:00:00.000Z') }), NOW))).toEqual(['body/readyAt'])
    expect(paths(bookingProblems(booking({ readyAt: new Date('2027-02-01T08:00:00.000Z') }), NOW))).toEqual(['body/readyAt'])
    expect(paths(bookingProblems(booking({ carrierCode: 'b r t' }), NOW))).toEqual(['body/carrierCode'])
    expect(paths(bookingProblems(booking({ via: 'PHONE', note: 'x', repeatWeekdays: ['MONDAY', 'MONDAY', 'FUNDAY'] }), NOW))).toEqual(['body/repeatWeekdays/1', 'body/repeatWeekdays/2'])
    expect(paths(bookingProblems(booking({ address: { ...ADDRESS, country: 'it' } }), NOW))).toEqual(['body/address/country'])
  })

  it('keeps a note only for a phone booking, and a recurring round only by phone', () => {
    expect(paths(bookingProblems(booking({ via: 'PHONE' }), NOW))).toEqual(['body/note'])
    expect(paths(bookingProblems(booking({ repeatWeekdays: ['TUESDAY'] }), NOW))).toEqual(['body/repeatWeekdays'])
    expect(paths(bookingProblems(booking({ note: 'by phone' }), NOW))).toEqual(['body/note'])
    expect(paths(bookingProblems(booking({ providerReference: 'X' }), NOW))).toEqual(['body/providerReference'])
    expect(paths(bookingProblems(booking({ via: 'PHONE', note: 'ok', weightKg: '3' }), NOW))).toEqual(['body/weightKg'])
    expect(paths(bookingProblems(booking({ weightKg: '0' }), NOW))).toEqual(['body/weightKg'])
    expect(paths(bookingProblems(booking({ via: 'PHONE', note: 'ok', providerReference: 'a\nb' }), NOW))).toEqual(['body/providerReference'])
  })
})

describe('after the booking', () => {
  it('confirms by hand only what waits; FAILED and CANCELLED are final', () => {
    expect(moveRefusal('REQUESTED', 'CONFIRMED')).toBeNull()
    expect(moveRefusal('CONFIRMED', 'CONFIRMED')?.code).toBe('NOT_REQUESTED')
    expect(moveRefusal('CONFIRMED', 'FAILED')).toBeNull()
    expect(moveRefusal('CONFIRMED', 'CANCELLED')).toBeNull()
    expect(moveRefusal('FAILED', 'CANCELLED')?.code).toBe('FINAL')
    expect(moveRefusal('CANCELLED', 'FAILED')?.code).toBe('FINAL')
  })

  it('a failure says why; a reference comes with the confirmation, once', () => {
    expect(paths(moveProblems({ status: 'FAILED', providerReference: null, words: null }, null))).toEqual(['body/words'])
    expect(moveProblems({ status: 'FAILED', providerReference: null, words: 'The driver did not come' }, null)).toEqual([])
    expect(moveProblems({ status: 'CONFIRMED', providerReference: 'R-1', words: null }, null)).toEqual([])
    expect(paths(moveProblems({ status: 'CONFIRMED', providerReference: 'R-2', words: null }, 'R-1'))).toEqual(['body/providerReference'])
    expect(moveProblems({ status: 'CONFIRMED', providerReference: 'R-1', words: null }, 'R-1')).toEqual([])
    expect(paths(moveProblems({ status: 'CANCELLED', providerReference: 'R-1', words: null }, null))).toEqual(['body/providerReference'])
  })

  it('marks the TEST pickup of test mode and a phone booking by its note', () => {
    const reference = testPickupReference('0190b3c4-0000-7000-8000-000000000001')
    expect(reference).toMatch(/^TEST-PU-[0-9A-F]{10}$/)
    expect(testPickupReference('0190b3c4-0000-7000-8000-000000000001')).toBe(reference)
    expect(isTestPickup(reference)).toBe(true)
    expect(isTestPickup('FPU-1234')).toBe(false)
    expect(pickupViaOf({ note: 'with Anna' })).toBe('PHONE')
    expect(pickupViaOf({ note: null })).toBe('SENDCLOUD')
  })
})

describe('the day a pickup comes', () => {
  const zone = 'Europe/Rome'
  it('a one-off on its day (a failed one too), a recurring round on its weekdays from its first day, never a cancelled one', () => {
    const once = { readyAt: new Date('2026-11-16T14:00:00.000Z'), repeatWeekdays: [], status: 'CONFIRMED' as const }
    expect(comesOn(once, '2026-11-16', zone)).toBe(true)
    expect(comesOn(once, '2026-11-17', zone)).toBe(false)
    expect(comesOn({ ...once, status: 'FAILED' }, '2026-11-16', zone)).toBe(true)
    expect(comesOn({ ...once, status: 'CANCELLED' }, '2026-11-16', zone)).toBe(false)
    const round = { readyAt: new Date('2026-11-17T14:30:00.000Z'), repeatWeekdays: ['MONDAY', 'TUESDAY'], status: 'CONFIRMED' as const }
    expect(comesOn(round, '2026-11-16', zone)).toBe(false)
    expect(comesOn(round, '2026-11-17', zone)).toBe(true)
    expect(comesOn(round, '2026-11-23', zone)).toBe(true)
    expect(comesOn(round, '2026-11-25', zone)).toBe(false)
    expect(comesOn({ ...round, status: 'FAILED' }, '2026-11-23', zone)).toBe(false)
  })

  it('reads the ready time on the site clock and asks Sendcloud for a window within the day', () => {
    expect(readyTimeOf(new Date('2026-11-16T14:00:00.000Z'), zone)).toBe('15:00')
    const window = pickupWindow(new Date('2026-11-16T14:00:00.000Z'), zone)
    expect(window.until.toISOString()).toBe('2026-11-16T18:00:00.000Z')
    const late = pickupWindow(new Date('2026-11-16T21:00:00.000Z'), zone)
    expect(late.until.toISOString()).toBe('2026-11-16T22:59:00.000Z')
    expect(weekdaysInOrder(['FRIDAY', 'MONDAY'])).toEqual(['MONDAY', 'FRIDAY'])
  })
})
