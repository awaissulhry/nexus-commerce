/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MARKET_LANGUAGE_EXEMPTIONS, marketLanguageViolations } from './market-languages-guard.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
}
describe('LX.2 market language guard', () => {
  it('rejects regional literals and channel-less Marketplace lookups with positive controls', () => {
    expect(marketLanguageViolations('services/probe.ts', `const tag = 'it_IT'; prisma.marketplace.findFirst({where:{code:'DE'}}); marketplaceRows.find(m=>m.code===code);`)).toHaveLength(3)
    expect(marketLanguageViolations('services/probe.ts', `prisma.marketplace.findFirst({where:{code:'DE',channel:'AMAZON'}}); marketplaceRows.find(m=>m.channel===channel&&m.code===code);`)).toEqual([])
    expect(marketLanguageViolations('services/amazon/flat-file.service.ts', `const tag = 'it_IT'`)).toEqual([])
    expect(marketLanguageViolations('services/channel-batch/amazon-batch-feed.service.ts', `const tag = 'it_IT'`)).toEqual([])
    expect(marketLanguageViolations('services/amazon/not-exempt.ts', `const tag = 'it_IT'`)).toHaveLength(1)
    expect(marketLanguageViolations('services/probe.ts', `const where = {code:'DE'}; prisma.marketplace.findFirst({where});`)).toHaveLength(1)
    expect(marketLanguageViolations('services/probe.ts', `const coordinate = {code:'DE'}; const args = {where:{...coordinate}}; prisma.marketplace.findFirst(args);`)).toHaveLength(1)
    expect(marketLanguageViolations('services/probe.ts', `const coordinate = {channel:'AMAZON',code:'DE'}; prisma.marketplace.findFirst({where:coordinate});`)).toEqual([])
  })
  it('scans tracked and untracked API sources, naming every Owner exemption', () => {
    const all = files(root).map(path => relative(root, path).replace(/\\/g, '/'))
    const checked = all.filter(path => !/(?:\.test\.tsx?$|\/__tests__\/)/.test(path))
    const exempt = checked.filter(path => MARKET_LANGUAGE_EXEMPTIONS.some(pattern => pattern.test(path)))
    const violations = checked.flatMap(path => marketLanguageViolations(path, readFileSync(join(root, path), 'utf8')))
    process.stdout.write(`${JSON.stringify({ guard: 'LX.2', scanned: checked.length, exempt, violations }, null, 2)}\n`)
    expect(checked.length).toBeGreaterThan(100)
    expect(exempt).toContain('services/amazon/flat-file.service.ts')
    expect(exempt).toContain('services/channel-batch/amazon-batch-feed.service.ts')
    // LX.F P2-10 — the exemption is now the TWO files that carry a map, not the 13
    // the `flat-file[^/]*` glob matched. The other 11 had nothing to exempt and
    // were unguarded forever; they are checked like every other file now.
    expect(exempt).toHaveLength(2)
    // LX.F P2-9 — one violation remains, found by a rule the guard did not have:
    // `toListingLanguage`'s `{ IT:'it-IT', DE:'de-DE', … }` (Appendix A's eBay map).
    // It is VT.1's file and the fix changes a signature used by the Owner-untouchable
    // flat-file routes, so it is baselined in `scripts/market-languages-baseline.json`
    // and requested from VT.1 (LX.F finding F-LX-6) rather than edited here.
    expect(violations).toEqual([expect.stringMatching(/^services\/ebay-variation-push\.service\.ts:\d+: market to language map; the only authority is Marketplace\.languages$/)])
  })

  it('detects the three shapes Appendix A deletes, each with the arm that must NOT fire', () => {
    // A market→language map written with two-letter codes — the shape ALL TWELVE of
    // Appendix A's definitions use, and the one the guard could not see.
    expect(marketLanguageViolations('services/probe.ts', `const MARKET_LANGUAGE = { DE:'de', BE:'fr', IT:'it' }`)).toHaveLength(1)
    // Not a language map: ICU cannot name `eur`/`gbp` as languages, so the rule is
    // derived rather than a hand-written list of codes.
    expect(marketLanguageViolations('services/probe.ts', `const CURRENCY = { DE:'eur', UK:'gbp' }`)).toEqual([])
    // A hardcoded fallback, but only in a file that participates in the axis.
    const axis = `import { normalizeLanguage } from './content-language.js'\nconst language = row?.language ?? 'it'`
    expect(marketLanguageViolations('services/probe.ts', axis)).toHaveLength(1)
    expect(marketLanguageViolations('services/probe.ts', `const language = row?.language ?? 'it'`)).toEqual([])
    // The dash form, which `normalizeLanguage` accepts, used AS a language…
    expect(marketLanguageViolations('services/probe.ts', `const locale = 'de-DE'`)).toHaveLength(1)
    // …and the 59-file false-positive class it must not touch: display locales.
    expect(marketLanguageViolations('services/probe.ts', `new Intl.DateTimeFormat('en-US', {})`)).toEqual([])
    expect(marketLanguageViolations('services/probe.ts', `const body = { 'Accept-Language': 'en-US' }`)).toEqual([])
  })

  it('R-LX-29 — detects the REVERSE direction, language → market, with every arm that must not fire', () => {
    // The shape `TranslationsLens.tsx`'s `MARKETPLACE_FOR_LOCALE` had, which this guard reported the
    // same 1 violation before AND after someone deleted it: it could not see this direction at all.
    expect(marketLanguageViolations('services/probe.ts', `const MARKETPLACE_FOR_LOCALE = { de: 'DE', it: 'IT' }`))
      .toEqual(['services/probe.ts:1: language to market map; a language does not name a market — read the coordinate, never derive it from a language code'])
    // …and the same mapping written as control flow.
    expect(marketLanguageViolations('services/probe.ts', `function market(language: string) { switch (language) { case 'it': return 'IT' } }`))
      .toEqual(['services/probe.ts:1: switch on a language that yields a market; a language does not name a market — read the coordinate, never derive it from a language code'])
    // A switch on something that is NOT language-named needs TWO pairs before it is a map: one
    // `case 'it': return 'IT'` on an unnamed subject is as likely a country or a unit.
    expect(marketLanguageViolations('services/probe.ts', `function f(kind: string) { switch (kind) { case 'it': return 'IT' } }`)).toEqual([])
    expect(marketLanguageViolations('services/probe.ts', `function f(kind: string) { switch (kind) { case 'it': return 'IT'; case 'de': return 'DE' } }`)).toHaveLength(1)
    // One entry is not a map; a 3-letter value is not a market code; a non-language key is not a
    // language (ICU decides, as it does for the forward direction).
    expect(marketLanguageViolations('services/probe.ts', `const M = { de: 'DE' }`)).toEqual([])
    expect(marketLanguageViolations('services/probe.ts', `const M = { de: 'EUR', it: 'USD' }`)).toEqual([])
    expect(marketLanguageViolations('services/probe.ts', `const M = { xx: 'DE', zz: 'IT' }`)).toEqual([])
    // The two directions cannot both fire on one object: the case of the keys separates them.
    expect(marketLanguageViolations('services/probe.ts', `const M = { DE: 'de', IT: 'it' }`))
      .toEqual(['services/probe.ts:1: market to language map; the only authority is Marketplace.languages'])
    // The authority and the guard itself may write either direction down.
    expect(marketLanguageViolations('services/pim/market-languages.ts', `const M = { de: 'DE', it: 'IT' }`)).toEqual([])
    expect(marketLanguageViolations('services/pim/market-languages-guard.ts', `const M = { de: 'DE', it: 'IT' }`)).toEqual([])
    // KNOWN and deliberate: an enum member is not a literal, so this rule does not see it. Stated
    // here so the next reader does not mistake the silence for coverage.
    expect(marketLanguageViolations('services/probe.ts', `function market(language: string) { switch (language) { case 'it': return Marketplace.IT } }`)).toEqual([])
  })
})
