/**
 * PES.5 — no source may pass `null` into a compound-unique `where`.
 *
 * ── Why this needs a test at all ────────────────────────────────────────────
 * Prisma types EVERY field of a compound-unique input as NON-NULLABLE, even when
 * the underlying column is nullable:
 *
 *   ChannelListingProductId_channel_marketplaceCompoundUniqueInput = {
 *     productId: string; channel: string; marketplace: string
 *     channelConnectionId: string   // <- column IS nullable
 *     aliasId: string               // <- column WAS nullable
 *   }
 *
 * So a null is refused at query-build time ("Argument `x` must not be null") and
 * a NULL discriminator can be stored and indexed but never TARGETED.
 *
 * `strictNullChecks` is OFF in apps/api/tsconfig.json, so `null` satisfies
 * `string` and the COMPILER CANNOT SEE THIS. A green `tsc` is not evidence here
 * — that is exactly how 16 swept call sites shipped and 500'd every channel
 * write (reference_api_tsconfig_not_strict).
 *
 * The scan below matches braces rather than running a regex over the file, so a
 * `null` in a neighbouring object cannot produce a false positive and a
 * multi-line object cannot hide one (reference_verification_probe_false_positives).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src')
/** Compound-unique key names on models whose keys contain a nullable column. */
const COMPOUND_KEYS = ['productId_channelMarket', 'productId_channel_marketplace', 'variantId_channel_marketplace']

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.includes('.test.')) out.push(p)
  }
  return out
}

/** The object literal that follows `key:`, by brace matching. */
function objectAfter(src: string, at: number): string | null {
  const open = src.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

describe('compound-unique wheres never carry a null', () => {
  it('no call site passes null into a compound-unique key', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8')
      for (const key of COMPOUND_KEYS) {
        let idx = src.indexOf(`${key}:`)
        while (idx !== -1) {
          const obj = objectAfter(src, idx)
          if (obj) {
            // Only flag a null bound to a FIELD of this object.
            const nulls = [...obj.matchAll(/(\w+)\s*:\s*null\b/g)].map((m) => m[1])
            // `?? null` is the same defect wearing a different hat.
            const coalesced = [...obj.matchAll(/(\w+)\s*:[^,}]*\?\?\s*null\b/g)].map((m) => m[1])
            const bad = [...new Set([...nulls, ...coalesced])]
            if (bad.length) {
              const line = src.slice(0, idx).split('\n').length
              offenders.push(`${file.replace(SRC, 'src')}:${line} — ${key} carries null for: ${bad.join(', ')}`)
            }
          }
          idx = src.indexOf(`${key}:`, idx + 1)
        }
      }
    }

    // ── KNOWN, PRE-EXISTING, NOT THIS LANE'S KEY ───────────────────────────
    // Every remaining offender is `channelConnectionId: … ?? null`, which is
    // MAP.2b's key, not PES.5's. It has the IDENTICAL defect — the column is
    // nullable, Prisma types it non-null in the compound input, so any
    // UNATTRIBUTED listing makes these throw "Argument `channelConnectionId`
    // must not be null" at query-build time and 500 the write.
    //
    // They are harmless TODAY only because every listing happens to carry a
    // connection: 977/977 attributed, measured 2026-09-01. That is a property of
    // the current DATA, not a guarantee — the first Shopify listing created
    // before Shopify is connected breaks all ten at once.
    //
    // Allow-listed rather than fixed: the durable fix is the same NOT NULL
    // discriminator treatment PES.5 applied to aliasKey, and that is MAP's key
    // and MAP's decision. Allow-listed rather than DELETED so the guard still
    // catches the eleventh (reference_scanner_false_positive_worse — a guard
    // that stops failing is worse than one that never ran).
    const KNOWN_MAP2B = (o: string) => o.endsWith('carries null for: channelConnectionId')
    const unexpected = offenders.filter((o) => !KNOWN_MAP2B(o))

    // A null here does not fail a type-check (strictNullChecks is off) and does
    // not fail until the query is BUILT at runtime — so this is the only thing
    // standing between a null and a 500 on every write through that key.
    expect(unexpected).toEqual([])

    // And the known set must not GROW silently either.
    expect(offenders.filter(KNOWN_MAP2B).length).toBeLessThanOrEqual(10)
  })

  it('the scanner actually finds a planted offender (it is not passing vacuously)', () => {
    // A guard that cannot fail is worse than no guard
    // (reference_a_scanner_passing_for_the_wrong_reason).
    const planted = `
      await prisma.channelListing.upsert({
        where: { productId_channel_marketplace: { productId: 'p', channel: 'EBAY',
                 marketplace: 'IT', channelConnectionId: null, aliasKey: '' } },
      })`
    const obj = objectAfter(planted, planted.indexOf('productId_channel_marketplace:'))
    expect(obj).not.toBeNull()
    const found = [...obj!.matchAll(/(\w+)\s*:\s*null\b/g)].map((m) => m[1])
    expect(found).toEqual(['channelConnectionId'])
  })
})
