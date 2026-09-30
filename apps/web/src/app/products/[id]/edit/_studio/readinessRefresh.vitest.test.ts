/**
 * Audit B01, B02, B06 — the readiness a channel scope reads.
 *
 * Before: page load, Reload and every live refresh read the family's every coordinate (GALE eBay IT: 11–13 MB raw), and a
 * save read `only=coordinate` and MERGED it into that answer. The merge was dropped while the family read was still
 * loading, was overwritten by a family read that started before the save (B01), and moved the saved coordinate's rows to
 * the end of the matrix (B06). Now a channel scope reads what it shows (`only=scope`: every chip, the open coordinate's
 * matrix) on every path, and a refresh restarts that one read.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReadinessMatrix, readinessUrl } from './readiness'
import * as readiness from './readiness'

const source = (file: string) => readFileSync(path.join(__dirname, file), 'utf8')

describe('readinessUrl (B02)', () => {
  const q = { market: 'IT', locale: 'it', channel: 'EBAY', accountId: 'acc-1' }

  it('a channel scope asks for what it shows; Shared asks for the family', () => {
    expect(readinessUrl('p1', q)).toMatch(/\/api\/products\/p1\/readiness\?market=IT&locale=it&channel=EBAY&accountId=acc-1&only=scope$/)
    expect(readinessUrl('p1', { market: 'IT', locale: 'it', channel: 'EBAY', listingId: 'l-1' })).toMatch(/\?market=IT&locale=it&channel=EBAY&listingId=l-1&only=scope$/)
    expect(readinessUrl('p1', { market: 'IT', locale: 'it' })).toMatch(/\/api\/products\/p1\/readiness\?market=IT&locale=it$/)
  })

  it('never names a coordinate the server would have to guess: no account and no listing reads the family', () => {
    expect(readinessUrl('p1', { market: 'IT', locale: 'it', channel: 'EBAY' })).not.toContain('only=')
  })
})

describe('one read per scope (B01)', () => {
  const contracts = source('contracts.tsx')

  it('every refresh restarts the one read — no second read that could land out of order', () => {
    // One readiness fetch in the provider, and no coordinate read beside it.
    expect(contracts.match(/fetch\(readinessUrl\(|fetch\(url,/g)).toHaveLength(1)
    expect(contracts).not.toMatch(/only: 'coordinate'|coordinateNonce|mergeCoordinateReadiness/)
    // A refresh (a save, Reload, "Refresh progress") bumps the nonce the read effect depends on: the effect's cleanup
    // aborts a read already in flight, so an answer that started before a save never lands after it.
    expect(contracts).toMatch(/const refreshReadiness = useCallback<ReadinessRefresh>\(\(\) => setAskedNonce\(\(n\) => n \+ 1\), \[\]\)/)
    expect(contracts).toMatch(/useReadinessQuery\(product\.id, [^\n]*liveNonce \+ askedNonce/)
    expect(contracts).toMatch(/\}, \[productId, market, nonce, [^\n]*\]\)/)
  })
})

describe('the matrix keeps the server\'s order (B06)', () => {
  it('no merge re-orders it: every answer replaces the last one whole', () => {
    expect('mergeCoordinateReadiness' in readiness).toBe(false)
    const entry = (coordinateKey: string, language: string) => ({ coordinateKey, channel: coordinateKey === '[]' ? null : 'EBAY', market: null, accountId: null, aliasId: null,
      language, label: coordinateKey, pct: 50, state: 'warn', required: { filled: 1, total: 2 } })
    const served = [entry('["AMAZON","BE","a",null]', 'nl'), entry('["AMAZON","BE","a",null]', 'fr'), entry('["EBAY","IT","b",null]', 'it')]
    expect(parseReadinessMatrix({ matrix: served }).map((e) => `${e.coordinateKey}:${e.language}`)).toEqual(served.map((e) => `${e.coordinateKey}:${e.language}`))
  })
})
