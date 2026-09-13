/**
 * LX.FIN (R-LX-25) — every catalogue CONTENT-WRITE surface has an addressed destination.
 *
 * A set claim DERIVED from the source, not from a list I typed — which is the only reason the real
 * scope was found. R-LX-25 named four translation surfaces; scanning `app/products/**` for write
 * verbs against the two content routes found **six** files, and measured on 2026-09-13 through the
 * shared validator (`@nexus/shared/content-language` `contentAddress()`, status 400):
 *
 *   `products/_shared/ProductDrawer.tsx`   4 calls on `/api/products/:id/translations/…` — all 400
 *   `products/_lenses/TranslationsLens.tsx`      `/api/products/ai/bulk-generate`        — 400
 *   `products/_modals/AiBulkGenerateModal.tsx`   the same route, apply pass                — 400
 *   `products/drafts/DraftsClient.tsx`      2 calls on the same route                     — 400
 *   `products/[id]/edit/tabs/MasterDataTab.tsx`            `dryRun: true` — never affected
 *   `…/tabs/amazon-cockpit/autofill/AutoFillCard.tsx`      `dryRun: true` — never affected
 *
 * Two routes, two rules, because the two routes know different things:
 *  - `/translations/:language` is told only the language, so the SURFACE addresses it, through the one
 *    shared derivation `sharedContentAddress`.
 *  - `/ai/bulk-generate` is told the MARKETPLACE and already derives the language from it, so the
 *    SERVER addresses it (`products-ai.routes.ts`) and a surface must name a marketplace. A surface
 *    that also sends an address must take it from the same shared derivation, never a literal.
 *
 * `apps/web` vitest is node-only: this reads the files, it does not render them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry) && !/\.vitest\.test\.tsx?$/.test(entry) ? [full] : []
  })
}

const WRITE_METHOD = /method:\s*'(PUT|POST|PATCH|DELETE)'/
type Call = { file: string; route: 'translations' | 'bulk-generate'; text: string }

/**
 * Each `fetch(` bounded by its OWN argument list — parenthesis-balanced, not a fixed window.
 *
 * 🔴 The first version took 1,800 characters after `fetch(` and reported a false offender: the
 * coverage read in `TranslationsLens.tsx` picked up the prose comment 2.8 KB below it that names
 * `/products/ai/bulk-generate`, so a GET was judged against the write rule. A scanner that reads
 * past its own call site is the "wrong instrument, confident reading" shape, in a test.
 */
function calls(file: string): Call[] {
  const source = readFileSync(file, 'utf8')
  const out: Call[] = []
  for (const match of source.matchAll(/fetch\(/g)) {
    let depth = 0
    let end = match.index + 'fetch'.length
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1
      else if (source[end] === ')') { depth -= 1; if (depth === 0) break }
    }
    const text = source.slice(match.index, end + 1)
    if (!WRITE_METHOD.test(text)) continue
    const route = /\/translations(\/|`)/.test(text) ? 'translations' : /\/ai\/bulk-generate/.test(text) ? 'bulk-generate' : null
    if (route) out.push({ file: file.slice(file.indexOf('products/')), route, text })
  }
  return out
}

const all = sourceFiles(ROOT).flatMap(calls)
const writes = all.filter((call) => !/dryRun:\s*true/.test(call.text))

describe('catalogue content-write surfaces have an addressed destination', () => {
  it('🔴 POSITIVE CONTROL — the scanner sees both routes and both kinds of call', () => {
    // An empty set makes every assertion below vacuous, which is the failure this guards.
    expect(all.length).toBeGreaterThanOrEqual(8)
    expect(all.filter((c) => c.route === 'translations').length).toBeGreaterThanOrEqual(4)
    expect(all.filter((c) => c.route === 'bulk-generate').length).toBeGreaterThanOrEqual(4)
    // The two dry-run previews are recognised as such, and are NOT counted as writes.
    expect(all.length - writes.length).toBeGreaterThanOrEqual(2)
  })

  it('every /translations write carries a contentAddress', () => {
    const offenders = writes.filter((c) => c.route === 'translations' && !/contentAddress/.test(c.text))
    expect(offenders.map((c) => c.file)).toEqual([])
  })

  it('every /ai/bulk-generate write names a marketplace, so the server can address it', () => {
    const offenders = writes.filter((c) => c.route === 'bulk-generate' && !/marketplace/.test(c.text))
    expect(offenders.map((c) => c.file)).toEqual([])
  })

  it('no surface writes its own address literal — the derivation is shared', () => {
    for (const file of new Set(writes.map((c) => c.file))) {
      const source = readFileSync(join(ROOT, file.slice('products/'.length)), 'utf8')
      if (!/contentAddress/.test(source)) continue
      expect(source).toMatch(/sharedContentAddress/)
      expect(source.replace(/sharedContentAddress/g, '')).not.toMatch(/tier:\s*'(language|source|pin)'/)
    }
  })
})
