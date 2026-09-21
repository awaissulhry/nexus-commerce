/**
 * P6.2b — the fix for a P6.2 feature that was 0% working in production.
 *
 * ## What production said (deployment `5e51055d`, 2026-09-21, the deploy P6.2 shipped on)
 *
 * ```
 * [cx-ebay] could not read the signing key expiry
 *   Invalid `prisma.channelApp.update()` invocation:
 *     signingKeyExpiresAt: new Date("Invalid Date")
 *   Invalid value for argument `signingKeyExpiresAt`: Provided Date object is invalid.
 * ```
 *
 * at **09:12:58, 09:13:07, 09:15:02 and 09:15:09** — four live eBay Key Management calls in
 * two minutes, against a design that asks once a day.
 *
 * ## The two defects, and why the second is the worse one
 *
 * 1. **Epoch seconds handed to a date-string parser.** eBay returns `expirationTime` as epoch
 *    seconds; `key-management.ts` normalises it to a string, and its own type comment says so
 *    (*"eBay returns epoch seconds; normalised to a string here"*), and its own fixture uses
 *    `1731536000`. Both consumers then did `new Date(created.expirationTime)`.
 *    **`new Date('1731536000')` is Invalid Date** — a bare digit string goes to `Date.parse`,
 *    which reads date strings, not epochs. The same digits as a *number* parse fine, which is
 *    why it read as correct.
 * 2. **One bad value took the whole row down.** `recordSigningKeyExpiry` writes the expiry AND
 *    `signingKeyCheckedAt` in one `update`. Prisma refuses the whole statement, so the
 *    checked-at never landed — and `shouldAskForSigningKeyExpiry` uses exactly that column as
 *    its once-a-day throttle. The write that stores the throttle was the write that failed, so
 *    the sweep asked again every heartbeat, forever.
 *
 * ## 🔴 Why P6.2's own tests passed the whole time
 *
 * They asserted the **source text**:
 *
 * ```ts
 * expect(client).toContain('created.expirationTime ? new Date(created.expirationTime) : null')
 * ```
 *
 * That pins the characters, not the result. A control has to target the LAYER the claim is
 * about: the claim was *"the expiry is now stored"*, and nothing here ever stored one. Every
 * test below runs the code and looks at the value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>>, meta: {} as Record<string, unknown> }))

vi.mock('../../db.js', () => ({
  default: {
    channelApp: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        // Stand in for Prisma's own refusal — this is the behaviour that cost the row.
        for (const [k, v] of Object.entries(args.data)) {
          if (v instanceof Date && Number.isNaN(v.getTime())) {
            throw new Error(`Invalid value for argument \`${k}\`: Provided Date object is invalid. Expected Date.`)
          }
        }
        h.updates.push(args.data)
        return {}
      }),
      findUnique: vi.fn(async () => null),
    },
  },
}))

vi.mock('../../lib/crypto.js', () => ({ encryptCredentials: vi.fn(async () => ({ blob: 'sealed' })) }))

import { ebayEpochToDate } from './connectors/ebay/key-management.js'
import { recordSigningKeyExpiry, storeSigningKey } from './apps.service.js'
import { shouldAskForSigningKeyExpiry } from './signing-key-expiry.js'

beforeEach(() => { h.updates = [] })
afterEach(() => { vi.clearAllMocks() })

describe('P6.2b — ebayEpochToDate', () => {
  it('🔴 THE DEFECT: the string form of epoch seconds, which `new Date()` refuses', () => {
    expect(String(new Date('1731536000'))).toBe('Invalid Date')          // what the old code did
    expect(ebayEpochToDate('1731536000')?.toISOString()).toBe('2024-11-13T22:13:20.000Z')
  })
  it('the number form — the shape the repo fixture already used', () => {
    expect(ebayEpochToDate(1731536000)?.toISOString()).toBe('2024-11-13T22:13:20.000Z')
  })
  it('milliseconds are told apart from seconds by magnitude, not by trust', () => {
    expect(ebayEpochToDate(1731536000000)?.toISOString()).toBe('2024-11-13T22:13:20.000Z')
    expect(ebayEpochToDate('1731536000000')?.toISOString()).toBe('2024-11-13T22:13:20.000Z')
  })
  it('an ISO string still works, in case eBay ever changes shape', () => {
    expect(ebayEpochToDate('2027-03-01T00:00:00.000Z')?.toISOString()).toBe('2027-03-01T00:00:00.000Z')
  })
  it.each([undefined, null, '', 'never', {}, [], NaN, Infinity])('%p is null, not a broken Date', (v) => {
    expect(ebayEpochToDate(v)).toBeNull()
  })
  it('a date outside 2000–2100 is refused — 1970 is a parse failure wearing a date', () => {
    expect(ebayEpochToDate(0)).toBeNull()
    expect(ebayEpochToDate(1)).toBeNull()          // 1 second past the epoch, i.e. seconds-as-ms
    expect(ebayEpochToDate(2)).toBeNull()          // the fixture in signing.vitest.test.ts:322
    expect(ebayEpochToDate(99999999999999)).toBeNull()
  })
  it('🔴 a FINITE but absurd number is null — the year check alone cannot catch it', () => {
    // Found by a surviving mutation. new Date(1e300) is an Invalid Date, and an Invalid Date's
    // getUTCFullYear() is NaN — so `NaN < 2000` and `NaN > 2100` are BOTH false and the year
    // bound waves it through. The NaN guard before it is what refuses it. Same family as the
    // banked `Array.isArray([])` trap: a comparison against NaN is false in both directions, so
    // a range check is not a validity check.
    expect(ebayEpochToDate(1e300)).toBeNull()
    expect(ebayEpochToDate('1e300')).toBeNull()
    expect(ebayEpochToDate(8.64e15 + 1)).toBeNull()
  })
  it('never returns an invalid Date — the property the callers depend on', () => {
    for (const v of ['1731536000', 1731536000, 'never', '', null, 0, {}, '2027-03-01', 1e300, 8.64e15 + 1]) {
      const d = ebayEpochToDate(v)
      if (d !== null) expect(Number.isNaN(d.getTime())).toBe(false)
    }
  })
})

describe('P6.2b — one bad date must not take the record with it', () => {
  it('🔴 THE REGRESSION: an invalid Date is stored as null, and checkedAt STILL lands', async () => {
    await expect(recordSigningKeyExpiry('EBAY', 'production', new Date('nonsense'))).resolves.toBeUndefined()
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].signingKeyExpiresAt).toBeNull()
    expect(h.updates[0].signingKeyCheckedAt).toBeInstanceOf(Date)
  })
  it('POSITIVE CONTROL: the stub really does refuse an invalid Date, as Prisma does', async () => {
    const prisma = (await import('../../db.js')).default as unknown as { channelApp: { update: (a: unknown) => Promise<unknown> } }
    await expect(prisma.channelApp.update({ data: { signingKeyExpiresAt: new Date('nonsense') } }))
      .rejects.toThrow('Provided Date object is invalid')
    expect(h.updates).toHaveLength(0)
  })
  it('POSITIVE CONTROL: a real date is stored as itself, not flattened to null', async () => {
    const real = new Date('2027-03-01T00:00:00.000Z')
    await recordSigningKeyExpiry('EBAY', 'production', real)
    expect(h.updates[0].signingKeyExpiresAt).toEqual(real)
  })
  it('🔴 storeSigningKey has the SAME guard — a new key is not lost to a bad expiry', async () => {
    // Found by a surviving mutation. This is the worse of the two paths: storeSigningKey writes
    // the PRIVATE KEY, and eBay never hands that back a second time. If the row refused because
    // the expiry beside it was unusable, the only copy of the key would be gone.
    const key = { signingKeyId: 'k1', jwe: 'j', privateKey: 'pk', cipher: 'ED25519' }
    await expect(storeSigningKey('EBAY', 'production', key, new Date('nonsense'))).resolves.toBeUndefined()
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].signingKeyId).toBe('k1')
    expect(h.updates[0].signingKeyEnc).toBe('sealed')
    expect(h.updates[0].signingKeyExpiresAt).toBeNull()
    expect(h.updates[0].signingKeyCheckedAt).toBeInstanceOf(Date)
  })
  it('POSITIVE CONTROL: storeSigningKey keeps a real expiry', async () => {
    const real = new Date('2027-03-01T00:00:00.000Z')
    await storeSigningKey('EBAY', 'production', { signingKeyId: 'k1', jwe: 'j', privateKey: 'pk', cipher: 'ED25519' }, real)
    expect(h.updates[0].signingKeyExpiresAt).toEqual(real)
  })
  it('a genuine null is still a null — "eBay named no date" survives the guard', async () => {
    await recordSigningKeyExpiry('EBAY', 'production', null)
    expect(h.updates[0].signingKeyExpiresAt).toBeNull()
    expect(h.updates[0].signingKeyCheckedAt).toBeInstanceOf(Date)
  })
})

describe('P6.2b — and that is why the throttle never engaged', () => {
  const NOW = Date.UTC(2026, 8, 21, 12, 0, 0)
  it('the write that failed was the write that stores the throttle', async () => {
    // Before the fix: the update threw, so checkedAt stayed null…
    const neverStored = { signingKeyId: 'k', signingKeyExpiresAt: null, signingKeyCheckedAt: null }
    expect(shouldAskForSigningKeyExpiry(neverStored, NOW)).toBe(true)   // …so it asked again. Every time.

    // After the fix: the same unusable answer still records checkedAt…
    await recordSigningKeyExpiry('EBAY', 'production', new Date('nonsense'))
    const afterFix = {
      signingKeyId: 'k',
      signingKeyExpiresAt: h.updates[0].signingKeyExpiresAt as Date | null,
      signingKeyCheckedAt: h.updates[0].signingKeyCheckedAt as Date,
    }
    expect(shouldAskForSigningKeyExpiry(afterFix, NOW)).toBe(false)     // …so it waits a day.
  })
})
