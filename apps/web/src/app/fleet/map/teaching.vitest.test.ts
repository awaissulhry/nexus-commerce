/**
 * NAF.SB.M-S8R S8.f — the two tests that keep the teaching layer honest.
 *
 * WHY THESE EXIST, in one measurement.
 *
 * The drawer told operators for months that *"Spend can read $0.0000 while a
 * worker has clearly run"*. When Section 8 swept the live page for a
 * four-decimal currency string it found exactly one, and it was that sentence.
 * The card had rendered money at 2dp since S2R, and since S7.c a worker that
 * did not run in the window renders `— no runs`, not a zero of any width. The
 * prose was the only evidence for its own claim.
 *
 * Underneath it, five of the eight hand-written `DEFINITIONS` keys had no
 * reader at all, under a file header that says *"Everything is keyed here; the
 * surfaces look it up."*
 *
 * Neither failure is exotic. Both are the same shape — **prose that outlived
 * the code it describes** — and both are cheap to test for. So:
 *
 *   1. every hand-written definition must be read by something;
 *   2. every UI string the drawer quotes must still exist in the component
 *      that renders it.
 *
 * Test 2 is the one that would have caught `$0.0000` the day S7.c shipped.
 *
 * Deliberately grep-based rather than AST-based. The failure mode being caught
 * is a string that vanished, and a regex finds that. An AST pass would be more
 * precise about *where* it is used and would cost more than the defect does.
 *
 * COMMENTS ARE STRIPPED BEFORE SEARCHING. This repo has already shipped a guard
 * that a comment could satisfy (`reference_ds_guard_greps_comments`), and both
 * strings below appear in prose comments as well as in JSX — `Colour by` is in
 * `OverlayRail.tsx` twice, once of each. A test that passes on a comment is a
 * test that passes after the feature is deleted.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const read = (f: string) => readFileSync(join(DIR, f), 'utf8')

/** Source with comments removed, so a claim cannot be satisfied by prose. */
function code(f: string): string {
  return read(f)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

describe('S8.f/1 — every hand-written definition has a reader', () => {
  /* The census keys are spread in from `CHIPS` and cannot go dead: a chip's
     definition is written where the chip is declared. Only the literals below
     are hand-authored here, and only they can rot. */
  const source = read('definitions.tsx')
  /* Bounded to the object literal. My first cut sliced to end-of-file and
     picked up `k` and `children` — the `Def` component's destructured props,
     two functions further down — so the test reported two dead definitions
     that do not exist. A parser that over-reports is a parser nobody trusts,
     which is why the first `it` below guards the parser itself. */
  const start = source.indexOf('export const DEFINITIONS')
  const objectBody = source.slice(start, source.indexOf('\n}', start))
  const keys = [...objectBody.matchAll(/^ {2}'?([a-z][a-z-]*)'?:/gm)].map((m) => m[1])

  const READERS = [
    'CensusBand.tsx',
    'HowThisMapWorks.tsx',
    'InspectorRail.tsx',
    'ListView.tsx',
    'MapCanvas.tsx',
    'MapClient.tsx',
    'OverlayRail.tsx',
  ]

  it('finds the hand-written keys, and only those (guards the parser itself)', () => {
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).toContain('carried')
    /* `k` and `children` are `Def`'s props. If they appear, the slice has run
       past the object literal again. */
    expect(keys).not.toContain('k')
    expect(keys).not.toContain('children')
  })

  it.each(keys)('`%s` is read by a surface', (key) => {
    const used = READERS.some((f) => {
      const c = code(f)
      return c.includes(`DEFINITIONS.${key}`) || c.includes(`DEFINITIONS['${key}']`) || c.includes(`k="${key}"`)
    })
    expect(used, `DEFINITIONS['${key}'] is defined and nothing renders it`).toBe(true)
  })
})

describe('S8.f/2 — the drawer only quotes strings the page still renders', () => {
  /* Each entry: a string the drawer puts in front of an operator as something
     they will see, and the component that has to still be rendering it. */
  const CLAIMS: Array<[quoted: string, renderedBy: string]> = [
    ['not yet run', 'MapCanvas.tsx'],
    ['no runs', 'MapCanvas.tsx'],
    ['Colour by', 'OverlayRail.tsx'],
    ['Table', 'MapClient.tsx'],
    ['Graph', 'MapClient.tsx'],
    ['Window', 'MapClient.tsx'],
  ]

  const drawer = read('HowThisMapWorks.tsx')

  it.each(CLAIMS)('the drawer says "%s", and %s still renders it', (quoted, renderedBy) => {
    expect(drawer, `the drawer no longer mentions "${quoted}" — drop it from CLAIMS`).toContain(
      quoted,
    )
    expect(
      code(renderedBy),
      `the drawer tells operators about "${quoted}" and ${renderedBy} no longer renders it`,
    ).toContain(quoted)
  })

  /* The specific regression. `$0.0000` was true when it was written and false
     three sections later; the card has printed 2dp since S2R.

     Checked against COMMENT-STRIPPED source, and that is not a loophole — it is
     the point. S8.b's commit comment quotes the deleted sentence verbatim so the
     next reader knows what was removed and why, and this test failed on it. An
     operator reads the rendered drawer, not the file. */
  it('does not claim a four-decimal figure the card cannot print', () => {
    expect(code('HowThisMapWorks.tsx')).not.toMatch(/\$\d+\.\d{4}/)
  })
})
