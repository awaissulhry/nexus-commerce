/**
 * P4.5g — "reconnect once for a true expiry date" is the wrong instruction.
 *
 * ## Amazon's rule, and what it says about this account
 *
 * **CONFIRMED (P0.8, from Amazon's Ads release note of 2026-05-26):** refresh tokens
 * issued **on or after 2026-07-30** expire 365 days after consent. Tokens issued
 * **before** that date are **not affected**.
 *
 * Measured on the development database 2026-09-21: all nine `AmazonAdsConnection` rows
 * carry `tokenIssuedAt = 2026-05-17T02:45:45Z` (sub-second apart, the backfill) with
 * `tokenIssuedAtIsEstimate: true`.
 *
 * 🟢 **The estimate's direction supports the conclusion.** The schema records that the
 * backfill used `createdAt` as a **conservative floor** — consent happened at or before
 * the row existed — so the true consent is **≤ 2026-05-17** and is earlier than the
 * cut-off whichever way the estimate is wrong. This is the rare case where an
 * approximate input still settles the question, and it is worth saying out loud because
 * the same reasoning in the other direction would be invalid.
 *
 * 🔴 **So the plan row inverts.** A reconnect would not reveal an expiry; it would
 * **create** one, turning a token with no expiry into a token that dies 365 days later.
 * P0.8 spotted this and wrote *"P4.5 must decide from the grant date"*. This is that
 * decision: **do not reconnect.**
 *
 * ## The defect that made the screen agree with the wrong instruction
 *
 * `ChannelConnection.refreshTokenExpiresAt` reads **2027-09-08T09:00:02.920Z**, exactly
 * 365 days after `lastRefreshAt`. It is **not** Amazon's answer:
 * `token.service.storeGrant` computes
 * `grant.refreshExpiresInSec ?? spec.auth.refreshTokenLifetimeSec`; the Ads connect
 * flow sets no `refreshExpiresInSec`; the spec's constant is `365 * 86_400`. LWA has no
 * `refresh_token_expires_in` — that is eBay's field.
 *
 * The connections route called it `measuredExpiry` and set `isEstimate: false` from it,
 * over a comment reading *"The grant reported a real refresh-token lifetime, which is
 * on the connection."* It did not. A derived number wearing a measurement's badge, and
 * a comment asserting a property the data does not have — both banked traps, together.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adsRefreshExpiry, ADS_365_DAY_RULE_FROM } from './ads-token-expiry.js'

const SRC = join(import.meta.dirname, '..', '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

/** The measured shape of all nine rows. */
const MEASURED_CONSENT = new Date('2026-05-17T02:45:45.055Z')

describe('adsRefreshExpiry (P4.5g)', () => {
  it('a grant from BEFORE 2026-07-30 has NO expiry — the measured case', () => {
    const e = adsRefreshExpiry({
      consentAt: MEASURED_CONSENT,
      consentIsEstimate: true,
      storedExpiresAt: new Date('2027-09-08T09:00:02.920Z'),
    })
    expect(e.expiresAt).toBeNull()
    expect(e.provenance).toBe('none')
    // Not an estimate: "there is no expiry" is a conclusion from Amazon's rule, not a
    // guess at a date.
    expect(e.isEstimate).toBe(false)
    expect(e.note).toMatch(/would START a 365-day clock/)
  })

  it('the stored 2027-09-08 date is DISCARDED, not shown as a fallback', () => {
    // This is the whole point: a plausible-looking date already exists, and showing it
    // is what invited the reconnect. `predict BEFORE you write` — the prediction is
    // null, and a fallback to the stored value would have passed unnoticed.
    const e = adsRefreshExpiry({
      consentAt: MEASURED_CONSENT,
      consentIsEstimate: true,
      storedExpiresAt: new Date('2027-09-08T09:00:02.920Z'),
    })
    expect(e.expiresAt).toBeNull()
  })

  it('a grant from ON the cut-off DOES expire, 365 days later (the boundary)', () => {
    const e = adsRefreshExpiry({ consentAt: ADS_365_DAY_RULE_FROM, consentIsEstimate: false, storedExpiresAt: null })
    expect(e.provenance).toBe('derived')
    expect(e.expiresAt?.toISOString()).toBe('2027-07-30T00:00:00.000Z')
    expect(e.isEstimate).toBe(false)
  })

  it('one millisecond before the cut-off does NOT expire (the other side)', () => {
    const e = adsRefreshExpiry({
      consentAt: new Date(ADS_365_DAY_RULE_FROM.getTime() - 1),
      consentIsEstimate: false,
      storedExpiresAt: null,
    })
    expect(e.provenance).toBe('none')
  })

  it('an ESTIMATED consent after the cut-off gives an estimated date', () => {
    const e = adsRefreshExpiry({ consentAt: new Date('2026-08-15T00:00:00Z'), consentIsEstimate: true, storedExpiresAt: null })
    expect(e.provenance).toBe('derived')
    expect(e.isEstimate).toBe(true)
    expect(e.note).toMatch(/approximate/)
  })

  it('"we do not know" is a DIFFERENT answer from "there is none"', () => {
    // P3.6's rule applied to a date: a screen that cannot tell those apart is not
    // reporting health.
    const e = adsRefreshExpiry({ consentAt: null, consentIsEstimate: true, storedExpiresAt: new Date('2027-01-01T00:00:00Z') })
    expect(e.provenance).toBe('unknown')
    expect(e.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(e.isEstimate).toBe(true)
    expect(e.note).toMatch(/cannot be checked/)
  })

  it('a lifetime the CHANNEL reports beats our rule', () => {
    // Nothing produces this today; it is the seam for the day Amazon does report one.
    const e = adsRefreshExpiry({
      consentAt: MEASURED_CONSENT,
      consentIsEstimate: true,
      storedExpiresAt: null,
      channelReportedLifetimeSec: 30 * 86_400,
    })
    expect(e.provenance).toBe('channel')
    expect(e.isEstimate).toBe(false)
    expect(e.expiresAt?.toISOString()).toBe('2026-06-16T02:45:45.055Z')
  })
})

describe('the connections screen (P4.5g)', () => {
  const route = read('routes/advertising.routes.ts')

  it('no longer calls the derived column a measurement', () => {
    // Code, not comments: the header above the block quotes the old line on purpose,
    // to record what it used to claim.
    const code = route.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(code.filter((l) => l.includes('const measuredExpiry ='))).toEqual([])
    expect(code.filter((l) => l.includes('measuredExpiry ? false'))).toEqual([])
    // Positive control: the block is still there to be checked.
    expect(code.filter((l) => l.includes('const expiry = adsRefreshExpiry({'))).toHaveLength(1)
  })

  it('takes its answer from the rule, and reports where it came from', () => {
    expect(route).toContain('const expiry = adsRefreshExpiry({')
    expect(route).toContain('tokenExpiryProvenance: expiry.provenance')
    expect(route).toContain('tokenExpiryNote: expiry.note')
  })

  it("'no_expiry' is its own status, not folded into 'unknown' or 'ok'", () => {
    expect(route).toContain("tokenExpiryStatus: expiry.provenance === 'none' ? 'no_expiry'")
  })

  it('the response SHAPE only grew — the nine web call sites are untouched', () => {
    for (const field of ['tokenExpiresAt', 'tokenIssuedAtIsEstimate', 'daysToTokenExpiry', 'tokenExpiryStatus']) {
      expect(route, `${field} disappeared from the response`).toContain(`${field}`)
    }
  })
})

describe('the evidence this rests on (P4.5g — positive controls)', () => {
  it('the spec really does declare the 365-day constant we stopped trusting', () => {
    // If this constant were removed, `refreshTokenExpiresAt` would stop being derived
    // and the reasoning above would need re-deriving rather than re-asserting.
    expect(read('services/cx/connectors/amazon-ads/spec.ts')).toContain('refreshTokenLifetimeSec: 365 * 86_400')
  })

  it('storeGrant really does fall back to that constant', () => {
    expect(read('services/cx/token.service.ts')).toContain(
      'grant.refreshExpiresInSec ?? spec.auth.refreshTokenLifetimeSec ?? null',
    )
  })

  it('the Ads connect flow really does set no refreshExpiresInSec', () => {
    const cb = read('routes/amazon-ads-auth.routes.ts')
    const grant = cb.slice(cb.indexOf('const grant: GrantResult = {'), cb.indexOf('await storeGrant('))
    expect(grant.length).toBeGreaterThan(50)
    expect(grant).not.toContain('refreshExpiresInSec')
  })
})
