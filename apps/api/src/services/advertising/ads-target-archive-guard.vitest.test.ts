/**
 * ACR Stage 5 — the deletion-reconciliation guards, and what they do NOT protect against.
 *
 * On 2026-08-05 every Sponsored Brands keyword on this account was archived locally while Amazon
 * still served 60 enabled + 18 paused, within ~30 minutes of a reconcile that had just corrected
 * them. Cause: `archiveMissingTargets` archived anything absent from a fetch that only ever asks
 * `/sp/*`, so SB/SD targets are missing by construction rather than by deletion.
 *
 * These tests exist because BOTH existing guards looked like they covered it and neither did.
 */
import { describe, it, expect } from 'vitest'
import { archiveAllowed } from './ads-keyword-list-sync.service.js'

describe('archiveAllowed — the circuit breaker', () => {
  it('never archives on an empty diff', () => {
    expect(archiveAllowed(0, 100)).toBe(false)
  })

  it('allows a small absolute number, so genuine small-scope deletions still reconcile', () => {
    expect(archiveAllowed(5, 6)).toBe(true)    // tiny scope, proportion is high but count is low
    expect(archiveAllowed(20, 20)).toBe(true)  // at the absolute floor
  })

  it('blocks a wipe: more than half of a large live set in one pass', () => {
    expect(archiveAllowed(60, 100)).toBe(false)
    expect(archiveAllowed(50, 100)).toBe(true) // exactly half is allowed
  })
})

describe('why the guards missed the SB wipe — the lesson, encoded', () => {
  /**
   * The cap is PER PASS. A wrong-family fetch does not fail and does not stop, so it simply
   * runs again — and each pass is individually "allowed" while the set converges on zero.
   * Measured on prod: 70 live SB keywords went to 36 archived, then to all 78, in ~30 minutes.
   */
  it('repeated passes defeat the 50% cap entirely', () => {
    let live = 70
    let passes = 0
    while (live > 0 && passes < 20) {
      const wouldArchive = live // a wrong-family fetch sees NONE of them, every time
      const permitted = Math.min(wouldArchive, Math.max(20, Math.ceil(live * 0.5)))
      if (!archiveAllowed(permitted, live)) break
      live -= permitted
      passes += 1
    }
    // The breaker slowed it to a handful of passes. It did not prevent the wipe.
    expect(live).toBe(0)
    expect(passes).toBeLessThanOrEqual(5)
  })

  /**
   * H.9 tracks whether the fetch ERRORED, because "empty on error != deleted". But an SP fetch
   * asked about SB entities SUCCEEDS and correctly returns nothing about them. Success plus an
   * empty result is exactly what a real deletion looks like, so no error-based guard can tell
   * the two apart. Only scoping the archive to the family the fetch could see can.
   */
  it('a successful wrong-family fetch is indistinguishable from a real deletion', () => {
    const sbKeywordsOnAmazon = ['kw-sb-1', 'kw-sb-2']
    const seenBySpFetch = new Set<string>() // /sp/keywords/list, asked about SB ad groups
    const missing = sbKeywordsOnAmazon.filter((k) => !seenBySpFetch.has(k))
    expect(missing).toEqual(sbKeywordsOnAmazon) // all "missing", none deleted
    // The fetch did not throw, so posOk/negOk are both true and H.9 permits the archive.
    const fetchErrored = false
    expect(fetchErrored).toBe(false)
  })
})
