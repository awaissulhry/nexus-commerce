/**
 * P6.7 — probe the eBay keyset for new scopes WITHOUT risking the consent request.
 *
 * Plan row: *"eBay: probe the keyset for returns, cancellation and inquiry scopes; add
 * the accepted ones; reconnect both accounts once."* Plan §4.1: *"eBay has no returns,
 * cancellation or inquiry scopes in its 20."*
 *
 * ## 🔴 The two halves of that row must not happen together
 *
 * eBay refuses the **whole** consent request when one scope is outside the app's
 * keyset, and names none of them — the operator sees only
 * `{"error_id":"invalid_scope"}`. That is how `sell.logistics` and
 * `commerce.catalog.readonly` stopped **every** eBay connect from 2026-08-29 until
 * 2026-09-16. `scopes.ts` carries the rule it cost: *"Add a scope only after the deploy
 * check passes with it."*
 *
 * So "probe" and "add" are separate steps, and this slice builds the probe: a candidate
 * is asked **alone, beside the base scope**, never inside the real request.
 *
 * ## What is NOT done here, and why
 *
 * The exact scope strings for returns / cancellation / inquiry were **not established**
 * in this session:
 *
 * - eBay's OAuth scope reference (`developer.ebay.com/api-docs/static/oauth-scopes.html`)
 *   answers **HTTP 403** to an automated fetch;
 * - a web search returned the Post-Order user guide but no scope list;
 * - the probe itself needs `EBAY_CLIENT_ID` and `EBAY_RUNAME`, which are **not in the
 *   local environment**, and Railway variable reads were refused by the auto-mode
 *   classifier again this session. Running it here returns, correctly,
 *   *"could not measure"*.
 *
 * Inventing scope strings and adding them is precisely the 2026-09-16 outage. So the
 * row stays **open**, with the measuring apparatus ready and one variable away.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EBAY_REQUIRED_SCOPES, EBAY_SCOPE_BASE } from './scopes.js'

const check = readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', '..', 'scripts', 'check-ebay-consent-scopes.mts'),
  'utf8',
)

/** The candidate block's real CODE — its header quotes the constant on purpose. */
const candidateCode = () =>
  check
    .slice(check.indexOf('const candidates ='), check.indexOf('const full = await ask('))
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

describe('candidate scopes (P6.7)', () => {
  it('the probe reads candidates from their own variable', () => {
    expect(check).toContain("process.env.EBAY_CANDIDATE_SCOPES ?? ''")
  })

  it('a candidate is asked ALONE beside the base scope, never in the real request', () => {
    // The whole safety property. If a candidate ever joined EBAY_REQUIRED_SCOPES
    // before being accepted, one refusal would stop every eBay connect.
    expect(check).toContain('const one = await ask([EBAY_SCOPE_BASE, scope])')
    const block = candidateCode()
    expect(block.length).toBeGreaterThan(200) // the slice found the block
    expect(block).not.toContain('EBAY_REQUIRED_SCOPES')
    expect(block).not.toContain('.push(')
  })

  it('a refused candidate does NOT fail the deploy', () => {
    // A candidate is information, not a gate: a scope we do not have and do not use
    // must not block a release. The only exits are the pre-existing ones.
    const block = candidateCode()
    expect(block).not.toContain('process.exit')
    expect(block).not.toContain('couldNotMeasure(')
  })

  it('each of the three answers is reported distinctly', () => {
    // accepted / refused / could-not-measure. Collapsing the third into "refused"
    // would turn a quiet network into "you do not have this scope".
    const block = candidateCode()
    expect(block).toContain('ACCEPTED')
    expect(block).toContain('refused')
    expect(block).toContain('could not measure')
  })

  it('with no candidates set, the probe behaves exactly as before', () => {
    expect(check).toContain('if (candidates.length) {')
  })
})

describe('the live scope list (P6.7 — unchanged, deliberately)', () => {
  it('still holds only scopes eBay has accepted', () => {
    expect(EBAY_REQUIRED_SCOPES).toContain(EBAY_SCOPE_BASE)
    expect(EBAY_REQUIRED_SCOPES).toHaveLength(20)
  })

  it('has NOT gained a returns / cancellation / inquiry scope on a guess', () => {
    // 🔴 The scope strings could not be established this session, and an unverified
    // scope in this list is the 2026-09-16 outage. It stays out until measured.
    const guesses = ['return', 'cancel', 'inquiry', 'dispute.post-order', 'post-order']
    for (const g of guesses) {
      const hit = EBAY_REQUIRED_SCOPES.filter((s) => s.toLowerCase().includes(g))
      expect(hit, `an unverified "${g}" scope is in the consent list`).toEqual([])
    }
  })

  it('the two scopes that caused the outage are still absent (positive control)', () => {
    // These are known-refused for this keyset. Their absence proves the list is the
    // measured one, not a wish list.
    expect(EBAY_REQUIRED_SCOPES.some((s) => s.endsWith('/sell.logistics'))).toBe(false)
    expect(EBAY_REQUIRED_SCOPES.some((s) => s.endsWith('/commerce.catalog.readonly'))).toBe(false)
  })
})
