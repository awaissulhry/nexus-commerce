/**
 * APS.1 — parseFilters contract tests.
 *
 * These lock the two defects that let the ads campaign-builder product picker
 * show 24 non-Amazon rows out of 37, both of which were silent: a dropped
 * query param and a missing channel scope.
 */
import { describe, it, expect } from 'vitest'
import { parseFilters } from './product-search.service.js'

describe('parseFilters — free-text term', () => {
  it('reads the documented `search` param', () => {
    expect(parseFilters({ search: 'GALE' }).search).toBe('GALE')
  })

  it('reads `q` too — the ads picker sends this and was silently unfiltered', () => {
    expect(parseFilters({ q: 'GALE' }).search).toBe('GALE')
  })

  it('`search` wins when both are present', () => {
    expect(parseFilters({ search: 'winner', q: 'loser' }).search).toBe('winner')
  })

  it('trims, and treats blank/absent as no term rather than an empty match', () => {
    expect(parseFilters({ q: '  GALE  ' }).search).toBe('GALE')
    expect(parseFilters({ q: '   ' }).search).toBeUndefined()
    expect(parseFilters({ q: '' }).search).toBeUndefined()
    expect(parseFilters({}).search).toBeUndefined()
  })

  it('ignores non-string values instead of coercing them', () => {
    expect(parseFilters({ q: 42 }).search).toBeUndefined()
    expect(parseFilters({ q: ['a', 'b'] }).search).toBeUndefined()
  })
})

describe('parseFilters — advertisableOn', () => {
  it('defaults to empty, so existing callers are unscoped exactly as before', () => {
    expect(parseFilters({}).advertisableOn).toEqual([])
  })

  it('parses a CSV list, like every other multi-value filter', () => {
    expect(parseFilters({ advertisableOn: 'AMAZON_IT,AMAZON_DE' }).advertisableOn)
      .toEqual(['AMAZON_IT', 'AMAZON_DE'])
  })

  it('parses a repeated-param array', () => {
    expect(parseFilters({ advertisableOn: ['AMAZON_IT'] }).advertisableOn)
      .toEqual(['AMAZON_IT'])
  })

  it('is independent of `channels` — the /products grid facet is untouched', () => {
    const f = parseFilters({ channels: 'EBAY_IT', advertisableOn: 'AMAZON_IT' })
    expect(f.channels).toEqual(['EBAY_IT'])
    expect(f.advertisableOn).toEqual(['AMAZON_IT'])
  })
})
