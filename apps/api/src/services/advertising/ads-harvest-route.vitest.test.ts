/**
 * PB-6b — the intent router (ads-harvest-route.ts), pure: which of the product's Brand, Competitor or Category ad groups a
 * harvested term lands in, by its own words. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { destinationAdGroups, isIntentRouter, resolveDestination, routeIntent, themedRouter, type IntentRouter } from './ads-harvest-route.js'

const router: IntentRouter = { router: 'intent', BRAND: 'ag-brand', COMPETITOR: 'ag-rival', CATEGORY: 'ag-cat', brand: ['testbrand', 'test brand line'], competitor: ['rivalco'] }

describe('routeIntent — brand beats competitor; else category', () => {
  it('a term holding a brand term as words is BRAND, even when it names a competitor too', () => {
    expect(routeIntent('testbrand jacket', router)).toBe('BRAND')
    expect(routeIntent('rivalco vs testbrand jacket', router)).toBe('BRAND')
    expect(routeIntent('Test  Brand LINE gloves', router)).toBe('BRAND') // case and spaces folded
  })

  it('a competitor term as words is COMPETITOR; anything else is CATEGORY (the conservative default)', () => {
    expect(routeIntent('rivalco jacket', router)).toBe('COMPETITOR')
    expect(routeIntent('waterproof jacket', router)).toBe('CATEGORY')
    expect(routeIntent('jacket', { brand: [], competitor: [] })).toBe('CATEGORY')
  })

  it('word bounds: a brand term inside another word is not the brand', () => {
    expect(routeIntent('testbrandish jacket', router)).toBe('CATEGORY')
    expect(routeIntent('supertestbrand', router)).toBe('CATEGORY')
    expect(routeIntent('rivalcom jacket', router)).toBe('CATEGORY')
    expect(routeIntent('test brand jacket', router)).toBe('CATEGORY') // "test brand line" is the term, not "test brand"
  })
})

describe('resolveDestination — a plain id, or the router\'s pick', () => {
  it('a plain ad group id is the landing, whatever the term', () => {
    expect(resolveDestination('testbrand jacket', 'ag-1')).toEqual({ adGroupId: 'ag-1' })
    expect(resolveDestination('B0TEST0001', 'ag-pat')).toEqual({ adGroupId: 'ag-pat' })
  })

  it('the router lands each term in its intent\'s ad group and says which', () => {
    expect(resolveDestination('testbrand jacket', router)).toEqual({ adGroupId: 'ag-brand', intent: 'BRAND' })
    expect(resolveDestination('rivalco jacket', router)).toEqual({ adGroupId: 'ag-rival', intent: 'COMPETITOR' })
    expect(resolveDestination('waterproof jacket', router)).toEqual({ adGroupId: 'ag-cat', intent: 'CATEGORY' })
  })

  it('an ASIN never goes through the router; a router missing an ad group, or nothing, lands nowhere', () => {
    expect(resolveDestination('B0TEST0001', router)).toBeNull()
    expect(resolveDestination('b0test0001', router)).toBeNull()
    expect(resolveDestination('testbrand jacket', { ...router, BRAND: '' })).toBeNull()
    expect(resolveDestination('testbrand jacket', null)).toBeNull()
    expect(resolveDestination('testbrand jacket', undefined)).toBeNull()
    expect(resolveDestination('testbrand jacket', '')).toBeNull()
  })

  it('every ad group a destination may land in', () => {
    expect(destinationAdGroups(router)).toEqual(['ag-brand', 'ag-rival', 'ag-cat'])
    expect(destinationAdGroups({ ...router, COMPETITOR: 'ag-cat' })).toEqual(['ag-brand', 'ag-cat'])
    expect(destinationAdGroups('ag-1')).toEqual(['ag-1'])
    expect(destinationAdGroups({ router: 'other' })).toEqual([])
    expect(isIntentRouter({ router: 'intent', BRAND: 'a', COMPETITOR: 'b' })).toBe(false)
  })
})

describe('themedRouter — the SP Super Wizard\'s hosts, known by theme', () => {
  const hosts = [{ adGroupId: 'x-brand', theme: 'brand' }, { adGroupId: 'x-rival', theme: 'competitor' }, { adGroupId: 'x-cat', theme: 'category' }]
  const lists = { brand: ['testbrand jacket', 'TestBrand Jacket', ' '], competitor: ['rivalco jacket'] }

  it('one host per theme: a router over the three, the lists once each', () => {
    expect(themedRouter(hosts, lists)).toEqual({ router: 'intent', BRAND: 'x-brand', COMPETITOR: 'x-rival', CATEGORY: 'x-cat', brand: ['TestBrand Jacket'], competitor: ['rivalco jacket'] })
  })

  it('a theme with no host hands its terms to Category; no Category host, a host without a theme or a theme twice: none', () => {
    expect(themedRouter([hosts[0], hosts[2]], lists)).toMatchObject({ BRAND: 'x-brand', COMPETITOR: 'x-cat', CATEGORY: 'x-cat' })
    expect(themedRouter([hosts[0], hosts[1]], lists)).toBeNull()
    expect(themedRouter([...hosts, { adGroupId: 'x-what', theme: null }], lists)).toBeNull()
    expect(themedRouter([...hosts, { adGroupId: 'x-cat-2', theme: 'category' }], lists)).toBeNull()
    expect(themedRouter([hosts[2]], lists)).toBeNull()
  })
})
