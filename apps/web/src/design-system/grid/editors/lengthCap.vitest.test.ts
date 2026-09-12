import { describe, expect, it } from 'vitest'

import { evaluateLengthCaps, lengthCapOf, lengthValidation } from './sheet'

/*
 * #373 / #380 / #382 — EVERY cap the wire declares is enforced, each in its own unit, worst binds.
 *
 * Two defects, one after the other, both mine to record:
 *
 *  1. `maxBytes` was a unit FLAG and never the cap, so `product_description`
 *     (`maxLength: null, maxBytes: 20000`) counted bytes against `null`, took the uncapped early
 *     return and NEVER WARNED — while its header tooltip promised "Max 20000 bytes".
 *  2. My first fix said "a declared byte cap IS the cap" — pick a unit, count in it. Wrong, and
 *     quietly so: it stopped comparing across units by DISCARDING one. The pair below is the
 *     counter-example, and it is live data, not a hypothetical.
 */
const AGE_RANGE = { maxLength: 1998, maxBytes: 2000 } // live: age_range_description

describe('lengthCapOf — both caps are kept; neither is preferred', () => {
  it('reads both, and null means uncapped IN THAT UNIT', () => {
    expect(lengthCapOf(AGE_RANGE)).toEqual({ characters: 1998, bytes: 2000, capFrom: null })
    // 🔴 The LIVE `product_description` shape: `maxLength` is ABSENT, not null. Measured
    // 2026-09-02 04:32 across 96 columns — absent 60 / value 36 / **null 0**. The wire omits an
    // uncapped unit; an earlier version of this file fed `null` and called it the live contract.
    expect(lengthCapOf({ maxBytes: 20000 })).toEqual({ characters: null, bytes: 20000, capFrom: null })
    // ...and `null` is accepted DEFENSIVELY: a consumer may be wider than its producer, never narrower.
    expect(lengthCapOf({ maxLength: null, maxBytes: 20000 })).toEqual({ characters: null, bytes: 20000, capFrom: null })
    expect(lengthCapOf({})).toEqual({ characters: null, bytes: null, capFrom: null })
  })

  it('carries capFrom — a mark that warns has to name whose cap it is', () => {
    expect(lengthCapOf({ maxLength: 200, capFrom: 'Amazon · DE' }).capFrom).toBe('Amazon · DE')
  })
})

describe('🔴 evaluateLengthCaps — neither cap always binds', () => {
  const caps = lengthCapOf(AGE_RANGE)

  it('the CHARACTER cap binds on long ASCII — "bytes win" would have missed this', () => {
    // 1999 ASCII: over 1998 characters, inside 2000 bytes.
    const r = evaluateLengthCaps('x'.repeat(1999), caps)
    expect(r?.over).toBe(true)
    expect(r?.unit).toBe('characters')
    expect(r?.n).toBe(1999)
  })

  it('the BYTE cap binds on multibyte text — "characters win" would have missed this', () => {
    // 1001 × 'é': 1001 characters (inside 1998), 2002 bytes (over 2000).
    const r = evaluateLengthCaps('é'.repeat(1001), caps)
    expect(r?.over).toBe(true)
    expect(r?.unit).toBe('bytes')
    expect(r?.n).toBe(2002)
  })

  it('passes a value that is inside BOTH', () => {
    expect(evaluateLengthCaps('x'.repeat(1998), caps)?.over).toBe(false)
    expect(evaluateLengthCaps('é'.repeat(999), caps)?.over).toBe(false) // 999 chars, 1998 bytes
  })

  it('binds on the cap the value is CLOSEST to, so the warning names the real constraint', () => {
    // Well inside both: the reported cap should still be the tighter one for this content.
    expect(evaluateLengthCaps('é'.repeat(900), caps)?.unit).toBe('bytes') // 1800/2000 vs 900/1998
    expect(evaluateLengthCaps('x'.repeat(1900), caps)?.unit).toBe('characters') // 1900/1998 vs 1900/2000
  })

  it('🔴 returns null when NO cap is declared — unchecked, never a pass and never an invented cap', () => {
    expect(evaluateLengthCaps('anything at all', lengthCapOf({}))).toBeNull()
  })

  it('a single declared cap reads exactly as it would have alone', () => {
    const r = evaluateLengthCaps('x'.repeat(21), lengthCapOf({ maxBytes: 20 }))
    expect(r).toMatchObject({ over: true, unit: 'bytes', cap: 20, n: 21 })
  })

  it('🔴 `n > cap` is over — a cap of 200 allows exactly 200', () => {
    // AG.1 aligned the cell's mark to this; the old renderer used `>=`, a disagreement between the
    // warning and the mark that neither side knew about.
    expect(evaluateLengthCaps('x'.repeat(200), lengthCapOf({ maxLength: 200 }))?.over).toBe(false)
    expect(evaluateLengthCaps('x'.repeat(201), lengthCapOf({ maxLength: 200 }))?.over).toBe(true)
  })

  it('a cap of zero is read as NOT DECLARED, not as a cap nothing can satisfy', () => {
    expect(evaluateLengthCaps('x', lengthCapOf({ maxLength: 0 }))).toBeNull()
  })
})

describe('lengthValidation — the validator says what bound it', () => {
  const v = (col: { maxLength?: number | null; maxBytes?: number | null; capFrom?: string | null }, s: string, req = false) =>
    lengthValidation(lengthCapOf(col), req).validate(s, {}, 'c')

  it('🔴 product_description now warns past 20000 bytes instead of never warning', () => {
    expect(v({ maxLength: null, maxBytes: 20 }, 'x'.repeat(21)).level).toBe('error')
    expect(v({ maxLength: null, maxBytes: 20 }, 'x'.repeat(20)).level).toBeNull()
  })

  it('catches BOTH of the age_range_description cases', () => {
    // Both caps are named, because they are independent — an operator cutting text to fit needs the
    // number they are NOT currently breaking as much as the one they are.
    // 🔴 The message names its SOURCE (DS1-26), and says so when it has none — "the channel cap"
    // told an operator a limit exists without saying whose, on a family listed to several.
    expect(v(AGE_RANGE, 'x'.repeat(1999)).message)
      .toBe('1999 of 1998 characters — source not stated (also max 2000 bytes)')
    expect(v({ ...AGE_RANGE, capFrom: 'Amazon · IT' }, 'x'.repeat(1999)).message)
      .toBe('1999 of 1998 characters — Amazon · IT (also max 2000 bytes)')
    expect(v(AGE_RANGE, 'é'.repeat(1001)).message)
      .toBe('2002 of 2000 bytes — source not stated (also max 1998 characters)')
  })

  it('an uncapped column never warns on length, however long', () => {
    expect(v({}, 'x'.repeat(100000)).level).toBeNull()
  })

  it('required fires on empty, and only on empty', () => {
    expect(v({}, '', true).level).toBe('error')
    expect(lengthValidation(lengthCapOf({}), true).validate(null, {}, 'c').level).toBe('error')
    expect(v({}, '', false).level).toBeNull()
  })
})

/*
 * PES.5's four measured fixtures (#387) — every binding shape that exists in the 91 cached schemas.
 * `maxLength` and `maxUtf8ByteLength` are INDEPENDENT Amazon properties: 1,061 fields declare both
 * across 14 distinct ratios, so neither is derived from the other and no single number describes a
 * column's limit.
 */
describe('the four real binding shapes', () => {
  const at = (col: { maxLength?: number | null; maxBytes?: number | null }, s: string) =>
    evaluateLengthCaps(s, lengthCapOf(col))

  it('`size` 50 / 2000 — the CHARACTER cap binds', () => {
    expect(at({ maxLength: 50, maxBytes: 2000 }, 'x'.repeat(51))?.unit).toBe('characters')
    expect(at({ maxLength: 50, maxBytes: 2000 }, 'x'.repeat(51))?.over).toBe(true)
  })

  it('🔴 `style` / `pattern` 2200 / 2000 — the BYTE cap binds on PURE ASCII', () => {
    // The case that proves the rule is not "multibyte means bytes": 2001 ASCII characters is inside
    // the 2200-character cap and over the 2000-BYTE cap. A unit chosen up front is wrong here.
    const r = at({ maxLength: 2200, maxBytes: 2000 }, 'x'.repeat(2001))
    expect(r?.unit).toBe('bytes')
    expect(r?.over).toBe(true)
  })

  it('`age_range_description` 1998 / 2000 — EITHER can bind, decided by content', () => {
    expect(at({ maxLength: 1998, maxBytes: 2000 }, 'x'.repeat(1999))?.unit).toBe('characters')
    expect(at({ maxLength: 1998, maxBytes: 2000 }, 'é'.repeat(1001))?.unit).toBe('bytes')
  })

  it('`product_description` (no char cap) / 20000 — byte only, and it is CHECKED', () => {
    // The live shape: no `maxLength` key at all.
    const r = at({ maxBytes: 20000 }, 'x'.repeat(20001))
    expect(r?.unit).toBe('bytes')
    expect(r?.over).toBe(true)
    expect(r?.other).toBeNull()
  })

  it('🔴 the message names the cap that bound AND the other one where both are declared', () => {
    const m = (col: { maxLength?: number | null; maxBytes?: number | null; capFrom?: string | null }, s: string) =>
      lengthValidation(lengthCapOf(col)).validate(s, {}, 'c').message
    expect(m({ maxLength: 2200, maxBytes: 2000, capFrom: 'Amazon · DE' }, 'x'.repeat(2001)))
      .toBe('2001 of 2000 bytes — Amazon · DE (also max 2200 characters)')
    // ...and names only the cap that exists when only one does.
    expect(m({ maxBytes: 20, capFrom: 'eBay · IT' }, 'x'.repeat(21)))
      .toBe('21 of 20 bytes — eBay · IT')
    // 🔴 An unstated source SAYS it is unstated — it never borrows "the channel's" authority.
    expect(m({ maxBytes: 20 }, 'x'.repeat(21))).toBe('21 of 20 bytes — source not stated')
  })
})
