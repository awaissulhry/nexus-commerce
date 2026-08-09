/**
 * NAF.WF-S7R / S7.d — the drift defence for this page's teaching layer.
 *
 * Six sections were rebuilt and each did its own teaching pass. Reading them
 * as one text afterwards found a glossary entry still promising features that
 * had shipped, a term whose tooltip contradicted the sentence it sat inside,
 * and a card header claiming six paragraphs above thirteen. None of that
 * failed a test, because nothing tested it.
 *
 * Diligence is not a defence — the industry's own answer to documentation
 * drift is a single source of truth plus MECHANICAL detection. So:
 *
 *   1. every `<Term k="…">` on this page resolves to a real glossary entry —
 *      a renamed or deleted key fails here instead of rendering the bare word
 *      with no tooltip and no error;
 *   2. every term minted FOR this page is still used by it — an orphaned
 *      definition is a definition nobody is maintaining;
 *   3. no `<Term>` is nested inside a link — the recorded tabIndex trap.
 *
 * This reads the files as text on purpose. It is a lint, not a render test:
 * it must keep working when the components change shape.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const GLOSSARY = join(HERE, '../../marketing/ads/rules-automation/fleet/glossary.tsx')

/** Terms this page minted (locks-doc glossary protocol). Others are shared. */
const MINTED_HERE = ['workflow', 'trigger', 'gate', 'draft', 'publish', 'step', 'revision', 'test']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : []
  })
}

const sources = walk(HERE).map((f) => ({ file: f, text: readFileSync(f, 'utf8') }))
const usedKeys = [
  ...new Set(sources.flatMap(({ text }) => [...text.matchAll(/<Term k="([a-z-]+)"/g)].map((m) => m[1]!))),
]
const glossary = readFileSync(GLOSSARY, 'utf8')
const definedKeys = new Set(
  [...glossary.matchAll(/\n {2}'?([a-z-]+)'?: \{\n {4}title:/g)].map((m) => m[1]!),
)

describe('workflows page — glossary wiring (WF-S7.d)', () => {
  it('finds the terms it is meant to be checking', () => {
    expect(usedKeys.length).toBeGreaterThan(5)
    expect(definedKeys.size).toBeGreaterThan(20)
  })

  it('every <Term> used on this page resolves to a glossary entry', () => {
    const unknown = usedKeys.filter((k) => !definedKeys.has(k))
    expect(unknown, `no glossary entry for: ${unknown.join(', ')}`).toEqual([])
  })

  it('every term minted for this page is still used by it', () => {
    const orphans = MINTED_HERE.filter((k) => !usedKeys.includes(k))
    expect(orphans, `minted here but no longer used: ${orphans.join(', ')}`).toEqual([])
  })

  it('every term minted for this page still exists in the glossary', () => {
    const missing = MINTED_HERE.filter((k) => !definedKeys.has(k))
    expect(missing, `minted here but gone from the glossary: ${missing.join(', ')}`).toEqual([])
  })

  it('no <Term> is nested inside a link', () => {
    /* `Term` renders tabIndex={0}, so one inside an <a> is a second focus stop
       whose Enter activates the link anyway. Recorded at S1.d, after it
       shipped once. Crude but effective: within a single line, a <Term> that
       follows an unclosed <Link or <a. */
    const offenders: string[] = []
    for (const { file, text } of sources) {
      text.split('\n').forEach((line, i) => {
        const t = line.indexOf('<Term ')
        if (t < 0) return
        const open = Math.max(line.lastIndexOf('<Link', t), line.lastIndexOf('<a ', t))
        if (open >= 0 && !line.slice(open, t).includes('</')) {
          offenders.push(`${file.split('/').pop()}:${i + 1}`)
        }
      })
    }
    expect(offenders, `Term inside a link at: ${offenders.join(', ')}`).toEqual([])
  })
})
