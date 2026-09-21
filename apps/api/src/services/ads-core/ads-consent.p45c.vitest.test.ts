/**
 * P4.5c — the Amazon Ads consent page, per region.
 *
 * ## The decision this slice had to make first
 *
 * The plan calls the North-America-for-every-region consent page a **GAP**
 * (FINAL-PLAN.md §4.1, §13.3), and as a capability it is. The evidence says it is not
 * a live breakage:
 *
 * - the EU grant this account runs on **was obtained through
 *   `https://www.amazon.com/ap/oa`** and works — 9 EU profiles, 469k logged calls;
 * - `services/cx/connectors/amazon-ads/spec.ts` says so in its header, written by a
 *   session that had already tried the regional hosts: *"the regional consent hosts
 *   this file guessed as a stub are not what the account was granted through."*
 *
 * So moving the default would risk a live, working sign-in to close a gap nobody has
 * hit — and a broken connect is only discovered by an operator, in the middle of one.
 *
 * The capability is therefore real and **explicit**: `NEXUS_ADS_CONSENT_REGIONAL=1`
 * uses each region's own page, `/connect?region=…` names the region, and the chosen
 * host is logged. With the variable unset every URL is byte-identical to today's — and
 * the pre-existing assertion in `spec.vitest.test.ts:72` is the control that proves it.
 *
 * The symptom this gap actually produces is an advertiser whose Amazon account is
 * EU-only or FE-only being unable to sign in at the North American page. That is when
 * to flip it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADS_CONSENT_HOSTS, adsConsentUrl } from './ads-regions.js'

const SRC = join(import.meta.dirname, '..', '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

afterEach(() => { delete process.env.NEXUS_ADS_CONSENT_REGIONAL })

describe('adsConsentUrl (P4.5c)', () => {
  it('OFF by default: every region gets the page the working grant came through', () => {
    for (const region of ['EU', 'NA', 'FE', null, 'nonsense']) {
      expect(adsConsentUrl(region)).toBe('https://www.amazon.com/ap/oa')
    }
  })

  it('ON: each region gets its own page', () => {
    process.env.NEXUS_ADS_CONSENT_REGIONAL = '1'
    expect(adsConsentUrl('EU')).toBe('https://eu.account.amazon.com/ap/oa')
    expect(adsConsentUrl('FE')).toBe('https://apac.account.amazon.com/ap/oa')
    expect(adsConsentUrl('NA')).toBe('https://www.amazon.com/ap/oa')
  })

  it('ON with no region falls back to NA, not to a throw', () => {
    // Unlike adsHostFor, this one cannot refuse: refusing here means an operator
    // clicking Connect gets an error page instead of Amazon. NA is the page that
    // demonstrably works, so it is the right floor.
    process.env.NEXUS_ADS_CONSENT_REGIONAL = '1'
    expect(adsConsentUrl(null)).toBe(ADS_CONSENT_HOSTS.NA)
    expect(adsConsentUrl('GLOBAL')).toBe(ADS_CONSENT_HOSTS.NA)
  })

  it('the three pages are three different hosts', () => {
    expect(new Set(Object.values(ADS_CONSENT_HOSTS)).size).toBe(3)
  })

  it('only the consent page is regional — the token endpoint is not', () => {
    // Amazon serves LWA tokens from one host for all three regions. Making that
    // regional too is the obvious next "fix" and would break every exchange.
    expect(read('routes/amazon-ads-auth.routes.ts')).toContain(
      "const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'",
    )
  })
})

describe('census (P4.5c — one decision, two call sites)', () => {
  it('neither call site spells a consent host itself', () => {
    const offenders: string[] = []
    for (const f of ['routes/amazon-ads-auth.routes.ts', 'services/cx/connectors/amazon-ads/spec.ts']) {
      for (const line of read(f).split('\n')) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        if (/'https:\/\/(www\.amazon\.com|eu\.account|apac\.account)[^']*\/ap\/oa/.test(line)) {
          offenders.push(`${f}: ${line.trim()}`)
        }
      }
    }
    expect(offenders, `these decide the consent host locally:\n${offenders.join('\n')}`).toEqual([])
  })

  it('both call sites go through adsConsentUrl (positive control)', () => {
    expect(read('routes/amazon-ads-auth.routes.ts')).toContain('const consentHost = adsConsentUrl(region)')
    expect(read('services/cx/connectors/amazon-ads/spec.ts')).toContain('authorizeUrl: (ctx) => adsConsentUrl(ctx.region),')
  })

  it('the route logs which host it sent the operator to', () => {
    // A failed sign-in should say which page it went to rather than leave it to be
    // guessed — the one diagnostic this gap needs when it finally bites.
    expect(read('routes/amazon-ads-auth.routes.ts')).toContain("{ state, region, consentHost }")
  })
})
