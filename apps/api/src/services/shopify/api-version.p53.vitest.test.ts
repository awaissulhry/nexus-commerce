/**
 * P5.3 — one Shopify API version, and the routine that keeps it moving.
 *
 * Plan row: *"Shopify: remove or move the 6 `2024-01` clients to `2026-07`. Then a
 * routine: move to the newest version every quarter."* Deadline: **already out of
 * support**.
 *
 * ## What was left, measured rather than assumed
 *
 * P1.4 did most of it: `SHOPIFY_API_VERSION` became the single accessor and the six
 * clients came down to **two**, both READS.
 *
 * | site | what it was |
 * |---|---|
 * | `utils/config.ts:45` | `process.env.SHOPIFY_API_VERSION \|\| "2024-01"` — a stale default |
 * | `services/images/shopify-live-images.service.ts:97` | a hard-coded `'2024-01'` on a REST `GET /products/{id}.json` |
 *
 * 🟢 **Both were dead, and this time it is measured, not inferred.**
 * `/admin/api/2024-01/` has **0 rows** in `OutboundApiCallLog`; every Shopify call
 * there is on `2026-07` (43 `graphql.node`, plus metafield, metaobject, publication
 * and locale reads). The previous session suspected the REST read had never run from
 * P2.4's *"production has no `SHOPIFY_*` variable"*; the call ledger says so directly.
 *
 * And `config.ts`'s value is dead twice over: a census of `.apiVersion` finds only the
 * channel spec and the call-ledger row — **nothing reads it** — and `loadShopifyConfig`
 * only runs when all three `SHOPIFY_*` variables are set.
 *
 * ## Why moving them is safe, and why `2024-01` was not
 *
 * `2024-01` has been out of Shopify support for over a year, so the REST path was
 * broken on *both* versions. It looked like the cautious value and was not. The
 * supported version at least fails clearly if the path ever runs.
 *
 * The real answer for that reader is GraphQL — every other Shopify path already goes
 * through `services/shopify/admin-client.ts` — and the comment there says so. A REST
 * products read is not like-for-like on a modern version, which is why this slice
 * moves the version and does **not** claim the reader is now correct.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHOPIFY_API_VERSION } from './api-version.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const codeLines = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))

describe('Shopify API version (P5.3)', () => {
  const files = walk(SRC)

  it('is defined exactly once', () => {
    const definitions: string[] = []
    for (const file of files) {
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        if (/SHOPIFY_API_VERSION\s*=\s*'/.test(line)) definitions.push(`${file.replace(SRC, 'src')}: ${line.trim()}`)
      }
    }
    expect(definitions, `more than one definition:\n${definitions.join('\n')}`).toHaveLength(1)
    expect(definitions[0]).toContain('services/shopify/api-version.ts')
  })

  it('no code line names a Shopify API version as a literal', () => {
    // A quarterly bump has to be one line. A second literal is how the six clients
    // drifted apart in the first place.
    const hits: string[] = []
    for (const file of files) {
      if (file.endsWith('services/shopify/api-version.ts')) continue
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        // A Shopify version is YYYY-MM on a quarter boundary.
        if (/['"`]20\d\d-(01|04|07|10)['"`]/.test(line) && !/amazon|ebay|etsy/i.test(line)) {
          hits.push(`${file.replace(SRC, 'src')}: ${line.trim().slice(0, 120)}`)
        }
      }
    }
    expect(hits, `use SHOPIFY_API_VERSION instead:\n${hits.join('\n')}`).toEqual([])
  })

  it('positive control: the definition itself IS a literal of that shape', () => {
    // Without this, the census above passes just as well if the pattern stopped
    // matching anything — "could not measure" wearing "measured empty"'s clothes.
    const def = readFileSync(join(SRC, 'services', 'shopify', 'api-version.ts'), 'utf8')
    expect(codeLines(def).filter((l) => /['"]20\d\d-(01|04|07|10)['"]/.test(l))).toHaveLength(1)
  })

  it('is a supported version, not the one that was out of support', () => {
    expect(SHOPIFY_API_VERSION).toMatch(/^20\d\d-(01|04|07|10)$/)
    expect(SHOPIFY_API_VERSION).not.toBe('2024-01')
    expect(SHOPIFY_API_VERSION).toBe('2026-07')
  })

  it('both former 2024-01 sites now read the accessor', () => {
    expect(readFileSync(join(SRC, 'utils', 'config.ts'), 'utf8'))
      .toContain('process.env.SHOPIFY_API_VERSION || SHOPIFY_API_VERSION')
    expect(readFileSync(join(SRC, 'services', 'images', 'shopify-live-images.service.ts'), 'utf8'))
      .toContain('const apiVersion = SHOPIFY_API_VERSION')
  })

  it('the gateway still refuses a Shopify CHANGE on any other version (control)', () => {
    // P1.4's rule, untouched by this slice: reads move here, changes were already
    // pinned — and the gateway's own comment says "their version moves in P5.3".
    const gw = readFileSync(join(SRC, 'services', 'gateway', 'gateway.ts'), 'utf8')
    expect(gw).toContain("req.channel === 'SHOPIFY' && req.kind !== 'read'")
    expect(gw).toContain('`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`')
  })
})
