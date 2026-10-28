import { describe, expect, it } from 'vitest'

import { longTextMarkLabel, longTextState, NEAR_RATIO } from './longTextState'

const AMAZON = 'Amazon · DE'

describe('longTextState', () => {
  it('an empty value is `empty`, and says whether it is required', () => {
    expect(longTextState('', { maxLength: 200 }).state).toBe('empty')
    expect(longTextState(null).state).toBe('empty')
    expect(longTextState(undefined).state).toBe('empty')
    expect(longTextState('', { required: true }).title).toContain('Required')
    expect(longTextState('', {}).title).not.toContain('Required')
  })

  it('a value inside its cap is `filled`, and the tooltip carries the figures the cell no longer shows', () => {
    const r = longTextState('x'.repeat(50), { maxLength: 200, capFrom: AMAZON })
    expect(r.state).toBe('filled')
    expect(r.title).toBe(`50 of 200 characters (${AMAZON})`)
  })

  it('warns at 80% of the cap — `over` is too late to be the first notice', () => {
    expect(longTextState('x'.repeat(159), { maxLength: 200 }).state).toBe('filled')
    expect(longTextState('x'.repeat(160), { maxLength: 200 }).state).toBe('near')
    expect(NEAR_RATIO).toBe(0.8)
  })

  it('says how much room is left while there is still room to use', () => {
    expect(longTextState('x'.repeat(180), { maxLength: 200 }).title).toContain('20 left')
  })

  /**
   * 🔴 The old renderer used `n >= cap`, so a value of exactly 200 against a 200-character cap
   * painted as already refused — while `lengthValidation`, the thing that actually refuses it, has
   * always used `n > cap`. The sheet and the validator disagreed by one. "Max 200" allows 200.
   */
  it('is `over` only PAST the cap, matching the validator rather than the old renderer', () => {
    expect(longTextState('x'.repeat(200), { maxLength: 200 }).state).toBe('near')
    expect(longTextState('x'.repeat(201), { maxLength: 200 }).state).toBe('over')
    expect(longTextState('x'.repeat(201), { maxLength: 200 }).title).toContain('1 over the cap')
  })

  /** UX.1's condition 1: a mark names its source, or "80% of the tightest cap" means nothing. */
  it('names the channel that imposes the cap, in the tooltip and in the label', () => {
    const r = longTextState('x'.repeat(199), { maxLength: 200, capFrom: AMAZON })
    expect(r.title).toContain(AMAZON)
    expect(longTextMarkLabel(r)).toBe(`Near the ${AMAZON} cap`)
  })

  /**
   * DS1-25's defensive branch, kept deliberately at the hub's direction: a declared cap with no
   * named source must still read honestly and must never invent one. No measured column is shaped
   * this way today (37/37 carry `capFrom`), which is exactly why it is worth an explicit test —
   * a branch with no live example is the one that rots unnoticed.
   */
  it('NAMES the missing source when a declared cap arrives without `capFrom`', () => {
    const r = longTextState('x'.repeat(19_000), { maxBytes: 20_000 })
    // 🔴 Not a bare figure — the absence is STATED. I first asserted the silent form here, which was
    // this module's behaviour until 04:36:38; the change is right and the test was wrong. A cap with
    // no attributable source is exactly the case where omitting the clause reads as "no source
    // exists" rather than "none was supplied", which is the error this whole module exists to avoid.
    expect(r.title).toBe('19000 of 20000 bytes (cap source not stated) — 1000 left')
    expect(longTextMarkLabel(r)).toBe('Near the cap — source not stated')
  })

  /**
   * DEFENSIVE BRANCH, not the live shape — since PES.5's fix every capped column carries `capFrom`
   * (measured 2026-09-02: 37 of 37). Kept because a producer that omits it must still render
   * honestly: state that the source is unknown, never substitute a generic stand-in. The old
   * assertion was `'Over the channel cap'`, which reads as "we know the channel and it is
   * unremarkable" rather than "we cannot say whose cap this is" (DS1-25).
   */
  it('degrades honestly when the cap has no named source — says so, rather than inventing one', () => {
    expect(longTextMarkLabel(longTextState('x'.repeat(999), { maxLength: 200 }))).toBe('Over the cap — source not stated')
  })

  /**
   * UX.1's condition 2, and the majority case: 60 of 96 columns on GALE-JACKET carry no cap at all.
   * The absence of a cap is not compliance with one.
   */
  describe('condition 2 — no cap known', () => {
    it('is `unchecked`, never `filled`', () => {
      const r = longTextState('some text', {})
      expect(r.state).toBe('unchecked')
      expect(r.state).not.toBe('filled')
    })

    it('states that no cap was SUPPLIED rather than showing a reassuring nothing', () => {
      expect(longTextState('some text', {}).title).toContain('no length cap was supplied')
      expect(longTextMarkLabel(longTextState('some text', {}))).toBe('No length cap supplied')
    })

    /**
     * 🔴 UX.1's amendment: `unchecked` means "no cap known HERE", never "no cap exists". Some of the
     * 60 uncapped columns are UNDELIVERED, not uncapped — `product_description`'s 20,000-byte cap
     * reached the cell as a unit flag with the cap dropped. This asserts the model never hardens
     * that into a claim about the field, which is what it would then have to retract.
     */
    it('never claims the FIELD has no limit — only that none was supplied here', () => {
      const r = longTextState('some text', {})
      for (const phrase of ['no limit', 'unlimited', 'no cap exists', 'for this field']) {
        expect(`${phrase}: ${r.title.toLowerCase().includes(phrase)}`).toBe(`${phrase}: false`)
      }
    })

    it('moves off `unchecked` the moment a cap is supplied, with nothing to retract', () => {
      const before = longTextState('x'.repeat(19_000), {})
      const after = longTextState('x'.repeat(19_000), { maxBytes: 20_000 })
      expect(before.state).toBe('unchecked')
      expect(after.state).toBe('near')
    })

    it('reports no cap, length or unit to claim a measurement against', () => {
      const r = longTextState('some text', { capFrom: AMAZON })
      expect([r.cap, r.length, r.unit]).toEqual([null, null, null])
    })

    it('treats a zero or negative cap as no cap, not as an instantly-breached one', () => {
      expect(longTextState('x', { maxLength: 0 }).state).toBe('unchecked')
      expect(longTextState('x', { maxBytes: 0 }).state).toBe('unchecked')
    })
  })

  /**
   * 🔴 The bug this module was built around: `lengthCapFor` returned `col.maxLength ?? null`, so a
   * BYTE cap was used only as a unit flag and never as the cap. `product_description` declares a real
   * 20,000-byte cap that the cell counted against `undefined` and reported as fine.
   *
   * 🔴 The SHAPE of that column, corrected. This docblock used to say it carries
   * `maxLength: null, maxBytes: 20000` "on the live contract". **It does not — the wire OMITS.**
   * Measured by the hub on the endpoint, `GET /products/:id/studio/columns` (GALE-JACKET, master,
   * DE/de, 96 columns, 2026-09-02 04:32):
   *
   *   | field       | absent | value | null |
   *   |-------------|--------|-------|------|
   *   | `maxLength` |     60 |    36 |  **0** |
   *   | `maxBytes`  |     81 |    15 |  **0** |
   *   | `capFrom`   |     60 |    36 |    —   |
   *
   * `schema-caps.ts:99` coerces a missing cap to `undefined`, and the route declares no response
   * schema, so `JSON.stringify` drops the key. Zero nulls in 96 columns, in either unit. The
   * live-shaped input below therefore OMITS `maxLength`; the `null` spelling is kept alongside it as
   * the defensive branch, labelled as such, because a consumer may be wider than its producer.
   */
  describe('a byte cap is a cap', () => {
    it('applies `maxBytes` when there is no character cap — the LIVE shape, `maxLength` absent', () => {
      const r = longTextState('x'.repeat(19_000), { maxBytes: 20_000 })
      expect(r.state).toBe('near')
      expect(r.cap).toBe(20_000)
      expect(r.unit).toBe('bytes')
      expect(r.state).not.toBe('unchecked')
    })

    /** The DEFENSIVE branch: no measured column spells it this way (0 nulls in 96), but a consumer
     *  that is wider than its producer must answer the same. Same input, two spellings, one answer. */
    it('answers identically when an absent character cap is spelled `null`', () => {
      expect(longTextState('x'.repeat(19_000), { maxLength: null, maxBytes: 20_000 }))
        .toEqual(longTextState('x'.repeat(19_000), { maxBytes: 20_000 }))
    })

    it('counts BYTES against a byte cap, so multibyte text is measured as the channel measures it', () => {
      // 'é' is two UTF-8 bytes: 6 characters, 12 bytes.
      const r = longTextState('éééééé', { maxBytes: 12 })
      expect(r.length).toBe(12)
      expect(r.unit).toBe('bytes')
    })

    it('🔴 takes the WORSE of the two caps — inside the character cap can still be over the byte cap', () => {
      // 1,000 two-byte characters: 1,000 chars (inside 1,998) but 2,000 bytes… and 2,001 breaks it.
      const text = 'é'.repeat(1_000) + 'x'
      const r = longTextState(text, { maxLength: 1_998, maxBytes: 2_000 })
      expect(r.state).toBe('over')
      expect(r.unit).toBe('bytes')
      expect(r.cap).toBe(2_000)
    })

    it('keeps a single-cap column’s answer identical when the other cap is absent', () => {
      const both = longTextState('x'.repeat(50), { maxLength: 200, maxBytes: null })
      const one = longTextState('x'.repeat(50), { maxLength: 200 })
      expect(both).toEqual(one)
    })
  })
})

/**
 * PES.5 measured all 91 cached Amazon schemas: `maxLength` and `maxUtf8ByteLength` are INDEPENDENT
 * properties — 1,061 fields declare both, with **14 distinct ratios**, and 185 declare a byte cap
 * only. So neither unit is reliably the tighter one, and any rule that picks a unit up front is
 * wrong on some real field. These are the four shapes, each binding differently.
 */
describe('the four measured schema shapes', () => {
  const CAP = 'Amazon · DE'

  it('`size` (50 chars / 2000 bytes) — the CHARACTER cap binds, at a fortieth of the byte cap', () => {
    const r = longTextState('x'.repeat(45), { maxLength: 50, maxBytes: 2000, capFrom: CAP })
    expect([r.state, r.unit, r.cap]).toEqual(['near', 'characters', 50])
    // Quoting bytes alone here would report 45 of 2000 — comfortable, and wrong.
    // `also max N unit` is `lengthValidation`'s own phrasing for the same fact, so the tooltip
    // while typing and the refusal on publish use the same words for the same cap.
    expect(r.title).toBe(`45 of 50 characters (${CAP}) — 5 left · also max 2000 bytes`)
  })

  it('🔴 `style` / `pattern` (2200 chars / 2000 bytes) — the BYTE cap binds on pure ASCII', () => {
    // A field the schema labels "2200 characters" refuses at 2000 bytes, with no multibyte involved.
    const r = longTextState('x'.repeat(2100), { maxLength: 2200, maxBytes: 2000, capFrom: CAP })
    expect(r.state).toBe('over')
    expect([r.unit, r.cap]).toEqual(['bytes', 2000])
    expect(r.title).toContain('100 over the cap')
    expect(r.title).toContain('also max 2200 characters')
  })

  it('`style` at 1900 ASCII — both read `near`, and the tie goes to the one actually running out', () => {
    // 1900/2200 = 86% · 1900/2000 = 95%. "First declared" would name the char cap; the byte cap is
    // the one 100 away from refusing.
    const r = longTextState('x'.repeat(1900), { maxLength: 2200, maxBytes: 2000, capFrom: CAP })
    expect([r.state, r.unit, r.cap]).toEqual(['near', 'bytes', 2000])
    expect(r.title).toContain('100 left')
  })

  it('`age_range_description` (1998 / 2000) — EITHER can bind, depending on the text', () => {
    const ascii = longTextState('x'.repeat(1999), { maxLength: 1998, maxBytes: 2000 })
    expect([ascii.state, ascii.unit]).toEqual(['over', 'characters'])
    const multibyte = longTextState('é'.repeat(1001), { maxLength: 1998, maxBytes: 2000 })
    expect([multibyte.state, multibyte.unit]).toEqual(['over', 'bytes'])
  })

  /**
   * `product_description` — byte cap only, `maxLength` ABSENT rather than null (hub, 04:32), and
   * `capFrom` PRESENT since PES.5's producer fix at 04:30:25 (hub re-measured: 37 capped / 37
   * carrying `capFrom`, `product_description` → "Amazon · DE").
   *
   * 🔴 TWICE NOW this block has carried a claim that a fixture test cannot support — mine, that it
   * "will fail loudly when PES.5 sets `capFrom`", and a later edit stating **"It did exactly that."**
   * It did not, and it could not have. `longTextState` is a pure function over a literal written on
   * the line above; **no change on the server can reach it**, so this test would have gone on passing
   * while describing a wire shape that had ceased to exist. A green test is not a witness to the
   * contract it was written from.
   *
   * The fixture is now the measured shape. What actually couples this file to the wire is the
   * measurement cited in the docblock above — an endpoint, a date and counts someone can re-run —
   * and nothing else. If that is not written down, nothing here notices when it changes.
   */
  it('`product_description` (byte-only) — a byte cap alone is still a cap, and it names its source', () => {
    const r = longTextState('x'.repeat(19_000), { maxBytes: 20_000, capFrom: AMAZON })
    expect([r.state, r.unit, r.cap]).toEqual(['near', 'bytes', 20_000])
    expect(r.state).not.toBe('unchecked')
    // Only one cap is declared, so there is no "also" clause; the source clause is present now.
    expect(r.title).toBe(`19000 of 20000 bytes (${AMAZON}) — 1000 left`)
    expect(longTextMarkLabel(r)).toBe(`Near the ${AMAZON} cap`)
  })

  it('🔴 names EVERY declared cap with its unit — a single number is wrong on one of these', () => {
    const r = longTextState('x'.repeat(100), { maxLength: 2200, maxBytes: 2000 })
    expect(r.title).toContain('characters')
    expect(r.title).toContain('bytes')
  })
})
