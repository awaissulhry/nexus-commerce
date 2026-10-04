/**
 * Ads fix 5c (review 7.2, 7.13) — the protected-terms panel's view logic, pinned.
 *
 * A failed load is never an empty list, a row names the match the write gate applies, new terms
 * default to CONTAINS, and "Always negate" can no longer be sent.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MATCH_TYPE, MATCH_OPTIONS, addProtectionBody, effectiveMatchType, failedLoad, matchHint,
  matchLabel, readProtections, showNothingProtected, splitProtections, type Protection,
} from './protectedTermsView'

const p = (over: Partial<Protection>): Protection => ({
  id: 'p1', mode: 'WHITELIST', term: 'xavia', isPrefix: false, matchType: null,
  marketplace: null, campaignId: null, reason: null, createdBy: null, ...over,
})

describe('readProtections — a failed load is not an empty list', () => {
  it('an OK answer with a list is loaded', () => {
    expect(readProtections(true, 200, { items: [p({})] })).toEqual({ status: 'loaded', items: [p({})] })
  })
  it('an OK answer with an empty list is loaded and empty', () => {
    expect(readProtections(true, 200, { items: [] })).toEqual({ status: 'loaded', items: [] })
  })
  it('a server error is failed, with the status', () => {
    expect(readProtections(false, 503, null)).toEqual({ status: 'failed', message: 'Nexus could not read the list (HTTP 503).' })
  })
  it('a server error with a message says it', () => {
    expect(readProtections(false, 500, { error: 'database unavailable' }))
      .toEqual({ status: 'failed', message: 'Nexus could not read the list (database unavailable).' })
  })
  it('an OK answer without a list is failed, not empty', () => {
    expect(readProtections(true, 200, { ok: true }).status).toBe('failed')
    expect(readProtections(true, 200, null).status).toBe('failed')
  })
  it('a network error is failed', () => {
    expect(failedLoad(new Error('Failed to fetch'))).toEqual({ status: 'failed', message: 'Nexus could not read the list (Failed to fetch).' })
    expect(failedLoad('x')).toEqual({ status: 'failed', message: 'Nexus could not read the list (no answer).' })
  })
})

describe('showNothingProtected — only after a load that worked', () => {
  it('never while loading or after a failed load', () => {
    expect(showNothingProtected({ status: 'loading' })).toBe(false)
    expect(showNothingProtected({ status: 'failed', message: 'x' })).toBe(false)
  })
  it('when the list loaded with no protected term', () => {
    expect(showNothingProtected({ status: 'loaded', items: [] })).toBe(true)
    expect(showNothingProtected({ status: 'loaded', items: [p({ mode: 'BLACKLIST' })] })).toBe(true)
  })
  it('not when a protected term exists', () => {
    expect(showNothingProtected({ status: 'loaded', items: [p({})] })).toBe(false)
  })
})

describe('match type — what the write gate applies', () => {
  it('a stored matchType wins', () => {
    expect(effectiveMatchType(p({ matchType: 'CONTAINS' }))).toBe('CONTAINS')
    expect(effectiveMatchType(p({ matchType: 'CONTAINS', isPrefix: true }))).toBe('CONTAINS')
    expect(effectiveMatchType(p({ matchType: 'PREFIX' }))).toBe('PREFIX')
    expect(effectiveMatchType(p({ matchType: 'EXACT', isPrefix: true }))).toBe('EXACT')
  })
  it('null falls back to isPrefix, as the gate does', () => {
    expect(effectiveMatchType(p({ isPrefix: true }))).toBe('PREFIX')
    expect(effectiveMatchType(p({ isPrefix: false }))).toBe('EXACT')
  })
  it('an unknown value matches exactly, as the gate does', () => {
    expect(effectiveMatchType(p({ matchType: 'contains' }))).toBe('EXACT')
  })
  it('every row gets a label — the ten live CONTAINS rows no longer look like EXACT', () => {
    expect(matchLabel(p({ matchType: 'CONTAINS' }))).toBe('Contains')
    expect(matchLabel(p({ isPrefix: true }))).toBe('Starts with')
    expect(matchLabel(p({}))).toBe('Exact')
  })
  it('new terms start on CONTAINS and all three can be chosen', () => {
    expect(DEFAULT_MATCH_TYPE).toBe('CONTAINS')
    expect(MATCH_OPTIONS.map((o) => o.value)).toEqual(['CONTAINS', 'PREFIX', 'EXACT'])
  })
  it('the hint uses the typed term', () => {
    expect(matchHint('CONTAINS', ' Gale ')).toBe('Blocks any negative that contains “gale” anywhere, such as “giacca moto gale”.')
    expect(matchHint('PREFIX', '')).toBe('Blocks a negative that starts with “xavia”, but not “giacca moto xavia”.')
    expect(matchHint('EXACT', 'xavia')).toBe('Blocks only the negative “xavia” itself.')
  })
})

describe('"Always negate" is gone', () => {
  it('the add body is always WHITELIST and carries the chosen match type', () => {
    expect(addProtectionBody({ term: '  xavia ', matchType: 'CONTAINS', marketplace: '', reason: ' ' }))
      .toEqual({ mode: 'WHITELIST', term: 'xavia', matchType: 'CONTAINS', marketplace: null, reason: null })
    expect(addProtectionBody({ term: 'gale', matchType: 'EXACT', marketplace: 'IT', reason: 'brand' }))
      .toEqual({ mode: 'WHITELIST', term: 'gale', matchType: 'EXACT', marketplace: 'IT', reason: 'brand' })
  })
  it('a stored BLACKLIST row is listed apart as not used, not as a protected term', () => {
    const white = p({ id: 'w' })
    const black = p({ id: 'b', mode: 'BLACKLIST', term: 'cheap' })
    expect(splitProtections([white, black])).toEqual({ terms: [white], retired: [black] })
  })
})
