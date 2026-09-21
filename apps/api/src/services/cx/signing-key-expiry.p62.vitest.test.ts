/**
 * P6.2 — the eBay signing key has a death date, and now something knows it.
 *
 * ## Measured 2026-09-21
 *
 * | fact | state |
 * |---|---|
 * | `ChannelApp` EBAY/production signing key | **exists** — `signingKeyEnc` and `signingKeyId` both set |
 * | its expiry | **unknown**; no column existed |
 * | `createEbaySigningKey` → `expirationTime` | read, logged into a `signing_key_created` event, **dropped** |
 * | `getEbaySigningKey` — a READ that returns it | exists, has a passing test, **zero production callers** |
 * | `secretExpiresAt` / `rotatedAt` on all 5 `ChannelApp` rows | **NULL** — nothing has ever rotated |
 * | the alert job's query | `where: { secretExpiresAt: { not: null } }` — the signing key was not even selected |
 *
 * 🔴 The key that signs eBay **refunds** (P0.3 made refunds signed) and finances calls
 * will expire on a date nothing recorded. The first symptom would be every signed call
 * failing with 215xxx — an error class `EbayApiError.isSignatureError` already knows by
 * name, and which nothing anticipated.
 *
 * The plan row is *"rotate app secrets and the eBay signing key too, not only account
 * tokens"*. You cannot rotate on a schedule you cannot see, so the date comes first.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldAskForSigningKeyExpiry, SIGNING_KEY_RECHECK_MS } from './signing-key-expiry.js'

const HERE = import.meta.dirname
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')

const app = (o: Partial<{ signingKeyId: string | null; signingKeyExpiresAt: Date | null; signingKeyCheckedAt: Date | null }> = {}) => ({
  signingKeyId: 'key-1', signingKeyExpiresAt: null, signingKeyCheckedAt: null, ...o,
})

describe('shouldAskForSigningKeyExpiry (P6.2 — a read, not a habit)', () => {
  const NOW = Date.UTC(2026, 8, 21, 12, 0, 0)

  it('asks when we have NEVER asked — the case every existing key is in', () => {
    expect(shouldAskForSigningKeyExpiry(app(), NOW)).toBe(true)
  })

  it('does NOT ask again the same day', () => {
    expect(shouldAskForSigningKeyExpiry(app({
      signingKeyCheckedAt: new Date(NOW - 60_000), signingKeyExpiresAt: new Date('2027-01-01'),
    }), NOW)).toBe(false)
  })

  it('asks again once the answer is a day old', () => {
    expect(shouldAskForSigningKeyExpiry(app({
      signingKeyCheckedAt: new Date(NOW - SIGNING_KEY_RECHECK_MS - 1), signingKeyExpiresAt: new Date('2027-01-01'),
    }), NOW)).toBe(true)
  })

  it('a key eBay reports NO expiry for is not re-asked every sweep', () => {
    // 🔴 The discriminator. "eBay named no date" and "we never asked" both leave
    // signingKeyExpiresAt null. Keying the decision on `checkedAt` is what stops the
    // first case becoming 96 calls a day — and what stops the second being mistaken
    // for a settled answer. P3.6: no_data is never a pass.
    expect(shouldAskForSigningKeyExpiry(app({
      signingKeyExpiresAt: null, signingKeyCheckedAt: new Date(NOW - 60_000),
    }), NOW)).toBe(false)
  })

  it('never asks when there is no key to ask about', () => {
    expect(shouldAskForSigningKeyExpiry(app({ signingKeyId: null }), NOW)).toBe(false)
    expect(shouldAskForSigningKeyExpiry(app({ signingKeyId: null, signingKeyCheckedAt: null }), NOW)).toBe(false)
  })
})

describe('the key lifecycle (P6.2)', () => {
  const client = read('connectors/ebay/client.ts')
  const apps = read('apps.service.ts')

  it('the expiry that was dropped is now stored', () => {
    expect(client).toContain('created.expirationTime ? new Date(created.expirationTime) : null')
    expect(apps).toContain('signingKeyExpiresAt: expiresAt ?? null')
    expect(apps).toContain('signingKeyCheckedAt: new Date()')
  })

  it('a key near its end is REPLACED instead of used until it fails', () => {
    // Before this, signingKeyFor returned the stored key forever.
    expect(client).toContain('const due = signingKeyIsDue(app.signingKeyExpiresAt)')
    expect(client).toContain('if (app.signingKey?.privateKey && app.signingKey.jwe && !due) return app.signingKey')
  })

  it('a key with NO recorded date is still used — absence is not expiry', () => {
    // The opposite mistake would replace a perfectly good key (a live eBay call) every
    // time we simply had not asked yet. P4.3b's lesson in the other direction.
    expect(client).toContain('if (!expiresAt) return false')
  })

  it('the recovery calls the READ that had never been called', () => {
    expect(client).toContain('export async function recoverEbaySigningKeyExpiry(')
    expect(client).toContain('await getEbaySigningKey(signingKeyId, {')
    expect(client).toContain("await recordSigningKeyExpiry('EBAY', environment, expiresAt)")
  })

  it('the recovery reports a failure rather than taking signing down', () => {
    const fn = client.slice(client.indexOf('export async function recoverEbaySigningKeyExpiry('))
    expect(fn.slice(0, 1800)).toContain('return { checked: false, signingKeyId, expiresAt: null, error }')
  })
})

describe('the alert (P6.2 — the signing key was not even selected)', () => {
  const job = readFileSync(join(HERE, '..', '..', 'jobs', 'channel-alerts.job.ts'), 'utf8')
  const svc = read('channel-alerts.service.ts')

  it('the sweep now selects rows that carry ONLY a signing-key date', () => {
    // The old query was `where: { secretExpiresAt: { not: null } }`, so a row whose
    // only date was the signing key's never came back at all.
    expect(job).toContain('OR: [{ secretExpiresAt: { not: null } }, { signingKeyExpiresAt: { not: null } }]')
    expect(job).toContain('signingKeyExpiryAlert(app.channelKey, app.environment')
  })

  it('it is its OWN alert kind, not the app secret’s', () => {
    expect(svc).toContain("'channel-signing-key-expiry',")
    expect(svc).toContain('export function signingKeyExpiryAlert(')
  })

  it('the wording does not tell an operator to do what the system does itself', () => {
    // An expired app secret is replaced by a human in eBay's console; an expired
    // signing key is replaced automatically on the next signed call. Telling someone
    // to go and fix the second is how alerts get ignored.
    const fn = svc.slice(svc.indexOf('export function signingKeyExpiryAlert('))
    expect(fn.slice(0, 2200)).toContain('replaced automatically on the next signed call')
    expect(fn.slice(0, 2200)).toContain('has not run')
  })

  it('the two credentials get different entity ids, so one cannot dedupe the other', () => {
    const fn = svc.slice(svc.indexOf('export function signingKeyExpiryAlert('))
    expect(fn.slice(0, 2200)).toContain('`${channelKey}:${environment}:signing-key`')
  })
})

describe('wiring (P6.2)', () => {
  const heartbeat = readFileSync(join(HERE, '..', '..', 'jobs', 'cx-heartbeat.job.ts'), 'utf8')

  it('the heartbeat runs the check, and a failure does not fail the sweep', () => {
    expect(heartbeat).toContain('await refreshEbaySigningKeyExpiry().catch(')
  })
})
