import { describe, expect, it } from 'vitest'
import { autoLoadKey, fieldsLoadOutcome, loadButtonLabel, missingFields, notLoadedTitle } from './missingFields'

/**
 * P0 item 8 (2026-09-30) — a missing channel field list is loaded, not left as a silently short sheet: the second
 * business's eBay 57988 locally, Motovento eBay DE in production.
 */
describe('missingFields', () => {
  it('a missing eBay list is loadable, and the banner names the channel and market', () => {
    expect(missingFields('EBAY', 'IT', ['EBAY:57988'])).toEqual({ loadable: ['57988'], unloadable: [] })
    expect(notLoadedTitle('EBAY', 'DE')).toBe('eBay fields for DE are not loaded yet.')
    expect(loadButtonLabel('EBAY')).toBe('Load eBay fields')
    expect(missingFields('AMAZON', 'DE', ['OUTERWEAR', 'COAT'])).toEqual({ loadable: ['COAT', 'OUTERWEAR'], unloadable: [] })
  })

  it('a key loading cannot fix keeps its own sentence (no category chosen), and the Shopify store list keeps its own banner', () => {
    expect(missingFields('EBAY', 'DE', ['EBAY:*'])).toEqual({ loadable: [], unloadable: ['No eBay category is chosen for eBay · DE. Choose one in Categories.'] })
    expect(missingFields('SHOPIFY', 'GLOBAL', ['SHOPIFY:*'])).toBeNull()
    expect(missingFields('EBAY', 'IT', [])).toBeNull()
  })
})

describe('one automatic attempt per open sheet', () => {
  it('keys the attempt on the channel, market and the missing lists, in any order; nothing loadable, no attempt', () => {
    expect(autoLoadKey('EBAY', 'IT', ['57988'])).toBe('EBAY|IT|57988')
    expect(autoLoadKey('AMAZON', 'DE', ['OUTERWEAR', 'COAT'])).toBe(autoLoadKey('AMAZON', 'DE', ['COAT', 'OUTERWEAR']))
    expect(autoLoadKey('EBAY', 'DE', [])).toBeNull()
  })
})

describe('fieldsLoadOutcome', () => {
  const answer = (status: number, body: unknown) => ({ status, body: body as never, conflict: null })

  it('every list loaded → the sheet reloads', () => {
    expect(fieldsLoadOutcome('EBAY', answer(200, { results: [{ productType: '57988', outcome: 'added' }] }))).toEqual({ state: 'loaded' })
    expect(fieldsLoadOutcome('EBAY', answer(200, { results: [{ productType: '57988', outcome: 'already' }] }))).toEqual({ state: 'loaded' })
  })

  it('eBay not reached → "Could not reach eBay. Try again." with the reason', () => {
    expect(fieldsLoadOutcome('EBAY', answer(200, { results: [{ productType: '57988', outcome: 'failed', error: 'eBay 503: Service unavailable' }] }))).toEqual({
      state: 'failed', message: 'Could not reach eBay. Try again. (57988: eBay 503: Service unavailable)' })
    const long = fieldsLoadOutcome('EBAY', answer(200, { results: [{ productType: '1', outcome: 'failed', error: 'x'.repeat(500) }] }))
    expect(long.state === 'failed' && long.message.length).toBeLessThan(160)
  })

  it('the server refused, or never answered: says which, never "loaded"', () => {
    expect(fieldsLoadOutcome('EBAY', answer(400, { error: 'Only rule sets in use in this market can be downloaded' }))).toEqual({
      state: 'failed', message: 'eBay fields could not be loaded: Only rule sets in use in this market can be downloaded' })
    expect(fieldsLoadOutcome('EBAY', 'no-answer')).toEqual({ state: 'failed', message: 'No answer from the server. The download may still be running: wait a moment, then try again.' })
    expect(fieldsLoadOutcome('EBAY', { status: 409, body: null, conflict: 'running' }).state).toBe('failed')
  })
})

describe('a partial load says how many lists are left (code review 2026-09-30)', () => {
  it('the server loads at most 25 per call: remaining > 0 is not "loaded"', () => {
    const outcome = fieldsLoadOutcome('AMAZON', { status: 200, conflict: null, body: { results: [{ productType: 'SHIRT', outcome: 'added' }], remaining: 15 } })
    expect(outcome).toEqual({ state: 'partial', remaining: 15, message: '15 more Amazon field lists to load. Choose Load Amazon fields again.' })
  })
  it('remaining 0 is loaded', () => {
    expect(fieldsLoadOutcome('EBAY', { status: 200, conflict: null, body: { results: [{ productType: '57988', outcome: 'added' }], remaining: 0 } })).toEqual({ state: 'loaded' })
  })
})
