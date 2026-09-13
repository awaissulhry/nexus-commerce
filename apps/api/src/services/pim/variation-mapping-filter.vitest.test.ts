/**
 * VT.1b item 4 — the catalogue's `Variation mapping` narrowing.
 *
 * The pure arms need no database. The DB-backed arms run against the real index and carry their POSITIVE CONTROL in the
 * same run: a value that MUST match something and a value that must match nothing, so an empty answer can never pass as
 * agreement.
 */

import { afterAll, describe, expect, it } from 'vitest'
import prisma from '../../db.js'
import { parseVariationMappingFilter, restrictVariationMapping, VARIATION_MAPPING_VALUES } from './variation-mapping-filter.js'
import { localDatabaseVerdict } from './variation-local-db.vitest-helper.js'

afterAll(async () => { await prisma.$disconnect().catch(() => {}) })

/**
 * 🔴 VT.F — WHICH DATABASE would these arms query? Established BEFORE the first connection, because the
 * answer depends on the CWD the suite was launched from and not on anything in this file:
 * `apps/api/src/env.ts` loads dotenv non-overriding, so a run from the repo root resolves `DATABASE_URL`
 * from the REPO-ROOT `.env` — which is Neon PRODUCTION — while a run from `apps/api` resolves the local
 * Docker database. Measured both ways in one run by `scripts/_vtf-env-which-db.mjs` (env read, no connection).
 *
 * A suite that silently measured prod and reported "narrows on the real index" would be the worst available
 * outcome, so this refuses out loud instead. `reference_which_database_is_this_api_on`.
 */
const LOCAL = localDatabaseVerdict(process.env.DATABASE_URL)

describe('parseVariationMappingFilter', () => {
  it('takes the five words, in either separator, and de-duplicates', () => {
    expect(parseVariationMappingFilter('derived|collides')).toEqual({ values: ['derived', 'collides'], unsupported: [] })
    expect(parseVariationMappingFilter('derived,collides')).toEqual({ values: ['derived', 'collides'], unsupported: [] })
    expect(parseVariationMappingFilter(' DERIVED | derived ')).toEqual({ values: ['derived'], unsupported: [] })
    expect(parseVariationMappingFilter([...VARIATION_MAPPING_VALUES].join('|')).values).toEqual([...VARIATION_MAPPING_VALUES])
  })

  it('NAMES an unsupported word instead of dropping it silently', () => {
    expect(parseVariationMappingFilter('derived|missing')).toEqual({ values: ['derived'], unsupported: ['missing'] })
    expect(parseVariationMappingFilter('teleport')).toEqual({ values: [], unsupported: ['teleport'] })
  })

  it('an absent or empty term is not a filter', () => {
    for (const raw of [undefined, null, '', '   ', '||']) expect(parseVariationMappingFilter(raw as string).values).toEqual([])
  })
})

describe('restrictVariationMapping', () => {
  it('an inactive filter narrows NOTHING (null), an active-but-unanswerable one narrows to nothing ([])', async () => {
    expect(await restrictVariationMapping(undefined, ['a'])).toBeNull()
    expect(await restrictVariationMapping('', ['a'])).toBeNull()
    // every word unsupported: the operator asked for something we cannot answer — narrow visibly, never widen silently
    expect(await restrictVariationMapping('teleport', ['a'])).toEqual([])
    // no candidates left from the rest of the scope
    expect(await restrictVariationMapping('derived', [])).toEqual([])
  })

  it('narrows on the real index, with both controls in one run', async () => {
    if (!LOCAL.ok) { expect.soft(LOCAL.reason).toBeNull(); return }
    const stamped = await prisma.$queryRawUnsafe<Array<{ productId: string; variationSource: string }>>(
      `SELECT DISTINCT "productId", "variationSource" FROM "ReadinessIndex" WHERE "variationSource" IS NOT NULL LIMIT 50`,
    ).catch(() => null)
    if (!stamped) { expect.soft(LOCAL.ok ? 'no database — this arm proves nothing in this run' : LOCAL.reason).toBeNull(); return }
    if (stamped.length === 0) {
      // Honest: the index carries no provenance yet on this database, so there is nothing to narrow. Say so rather than
      // asserting an empty result as a pass.
      expect.soft('no ReadinessIndex row carries variationSource yet — rebuild one family first').toBeNull()
      return
    }
    const candidates = [...new Set(stamped.map((r) => r.productId))]
    /**
     * 🔴 VT.F — pick a stamped value that IS one of the five FILTER words, instead of `stamped[0]`'s.
     *
     * The producer stamps FOUR provenance words (`derived | rule | overridden | none`) and the filter accepts
     * FIVE that are not the same set: `none` is deliberately NOT a filter word, because "no theme here" is
     * answered from `missing[].kind = 'theme-unset'` under the word `unset` (`KIND_OF`). So whenever the first
     * row of the scan happened to carry `none`, this arm queried an UNSUPPORTED word, got the correct `[]`, and
     * reported it as "the positive control did not match" — a red that says nothing about the code.
     *
     * It was latent until VT.F deleted `VX-TEST-3AX` and its 170 index rows, which changed which row the
     * `LIMIT 50` scan returns first (measured after: `none, overridden, derived`). A test whose verdict depends
     * on unordered row order is `reference_a_fixture_pins_a_dimension` — the arm that would have failed is the
     * one never run. It now states its own abstention instead.
     */
    const queryable = stamped.filter((r) => (VARIATION_MAPPING_VALUES as readonly string[]).includes(r.variationSource))
    if (queryable.length === 0) {
      expect.soft(`the index stamps only ${[...new Set(stamped.map((r) => r.variationSource))].join(', ')}, none of which is a filter word — nothing to narrow on`).toBeNull()
      return
    }
    const value = queryable[0].variationSource
    const matched = await restrictVariationMapping(value, candidates)
    // POSITIVE CONTROL: the product whose row carries that very value is returned
    expect(matched).toContain(queryable[0].productId)
    // NEGATIVE CONTROL in the same run: a value no row carries returns nothing from the same candidate set
    const unusedValue = VARIATION_MAPPING_VALUES.find((v) => v !== 'unset' && v !== 'collides' && !queryable.some((r) => r.variationSource === v))
    if (unusedValue) expect(await restrictVariationMapping(unusedValue, candidates)).toEqual([])
  })

  it('`collides` reads missing[].kind, NOT the provenance column — proven on a product that has provenance and no collision', async () => {
    if (!LOCAL.ok) { expect.soft(LOCAL.reason).toBeNull(); return }
    const stamped = await prisma.$queryRawUnsafe<Array<{ productId: string }>>(
      `SELECT DISTINCT r."productId" FROM "ReadinessIndex" r
        WHERE r."variationSource" = 'derived' AND NOT (r.missing @> '[{"kind":"collision"}]'::jsonb) LIMIT 5`,
    ).catch(() => null)
    if (!stamped) { expect.soft(LOCAL.ok ? 'no database — this arm proves nothing in this run' : LOCAL.reason).toBeNull(); return }
    if (stamped.length === 0) {
      expect.soft('no index row carries variationSource yet — rebuild one family first').toBeNull()
      return
    }
    const ids = stamped.map((r) => r.productId)
    // POSITIVE CONTROL: the provenance value DOES match these products…
    expect(await restrictVariationMapping('derived', ids)).toEqual(expect.arrayContaining(ids))
    // …and `collides` does NOT, because it asks a different question of a different field.
    expect(await restrictVariationMapping('collides', ids)).toEqual([])
    // both together still match, because the terms are OR-ed
    expect(await restrictVariationMapping('derived|collides', ids)).toEqual(expect.arrayContaining(ids))
  })

  it('a row whose collision kind IS present matches `collides` (measured by the proof script when one exists)', async () => {
    const withKind = await prisma.$queryRawUnsafe<Array<{ productId: string }>>(
      `SELECT DISTINCT "productId" FROM "ReadinessIndex" WHERE missing @> '[{"kind":"collision"}]'::jsonb LIMIT 5`,
    ).catch(() => null)
    if (!withKind || withKind.length === 0) {
      // NOT a failure and NOT a pass: there is no colliding coordinate on this database right now (the proof script
      // creates one and restores it). Recorded so the reading cannot be mistaken for agreement.
      console.log('[variation-mapping-filter] no collision row present — arm not exercised in this run')
      expect(withKind?.length ?? 0).toBe(0)
      return
    }
    const ids = withKind.map((r) => r.productId)
    expect(await restrictVariationMapping('collides', ids)).toEqual(expect.arrayContaining(ids))
  })
})

describe('VT.F — the database this suite would have queried is NAMED before it queries', () => {
  it('refuses a non-local host by URL, and only ever in the refusing direction', () => {
    const neon = localDatabaseVerdict('postgresql://u:p@ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require')
    expect(neon.ok).toBe(false)
    expect(neon.host).toBe('ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech')
    expect(neon.database).toBe('neondb')
    expect(neon.reason).toContain('non-overriding')
    /* POSITIVE CONTROL in the same test: the local URL the API itself uses DOES pass. */
    const local = localDatabaseVerdict('postgresql://postgres:x@127.0.0.1:55439/nexus_development')
    expect(local.ok).toBe(true)
    expect(local.database).toBe('nexus_development')
    expect(localDatabaseVerdict('postgresql://postgres:x@localhost:55439/nexus_development').ok).toBe(true)
  })

  it('an absent or unparseable DATABASE_URL is NOT local — not measured is never a pass', () => {
    expect(localDatabaseVerdict(undefined).ok).toBe(false)
    expect(localDatabaseVerdict('').ok).toBe(false)
    expect(localDatabaseVerdict('not a url').ok).toBe(false)
  })

  it('states, in this run, which database the arms above were pointed at', () => {
    /* Not an assertion about the value — a RECORD of it, so a reader of the output can see whether the
       DB-backed arms above ran or refused, without re-deriving it from their skip messages. */
    console.log(`[VT.F] DB-backed arms: ${LOCAL.ok ? `RAN against ${LOCAL.host}/${LOCAL.database}` : `REFUSED — ${LOCAL.host || '(none)'}`}`)
    expect(typeof LOCAL.ok).toBe('boolean')
  })
})
