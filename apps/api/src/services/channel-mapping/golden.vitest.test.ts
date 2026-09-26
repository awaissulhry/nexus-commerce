/**
 * CHMAP M5 — the golden test (study §8.6): anonymised copies of the Owner's real files (`__fixtures__/golden`, built
 * by `scripts/chmap-golden-build.mts`, scanned for private data) go through the real readers and the export, and must
 * give the pinned result: every filled cell accounted for, the file written back cell for cell, and the same mapping
 * decisions. A change to a reader, a rule, the export or a schema fixture that moves any number fails here, with the
 * cells that moved.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { amazonGolden, ebayGolden, loadSpec, type GoldenMarket } from './__tests__/golden-pipeline.js'

const DIR = new URL('./__fixtures__/golden/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as {
  fixtures: { id: string; kind: 'amazon' | 'ebay'; why: string; file: string; filename?: string; market?: GoldenMarket; specs: string[]; expected: Awaited<ReturnType<typeof amazonGolden>> }[]
}
const specsOf = (files: string[]) => new Map(files.map(f => {
  const spec = loadSpec(readFileSync(new URL(`specs/${f}`, DIR)))
  return [spec.category, spec] as const
}))

describe('CHMAP golden files (anonymised copies of the Owner’s files)', () => {
  it('has the fixtures the study names', () => {
    expect(manifest.fixtures.map(f => f.id)).toEqual(['amazon-it-coat-pants', 'amazon-de-coat-pants', 'amazon-fr-coat-pants', 'amazon-es-coat-pants', 'amazon-de-suit', 'amazon-de-market-parent', 'amazon-it-flat-file-2024', 'ebay-it-177104', 'ebay-it-legacy'])
  })

  for (const fixture of manifest.fixtures) {
    it(`${fixture.id} — ${fixture.why}`, async () => {
      const bytes = readFileSync(new URL(fixture.file, DIR))
      const got = fixture.kind === 'amazon' ? await amazonGolden(bytes, specsOf(fixture.specs), fixture.market!) : await ebayGolden(bytes, fixture.filename!, specsOf(fixture.specs))
      // check 1 — every filled cell accounted for, exactly once.
      expect(got.read).toMatchObject({ unaccounted: 0, duplicated: 0, dangling: 0 })
      // check 2 — the round trip: the differences are exactly the pinned ones (for most files: none).
      expect(got.differences).toEqual(fixture.expected.differences)
      // check 3 — the version pin: the form, the decisions and every count.
      expect(got).toEqual(fixture.expected)
    }, 60_000)
  }
})
