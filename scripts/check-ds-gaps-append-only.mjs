#!/usr/bin/env node
/**
 * GDS §8.6 — `.claude/DS-GAPS.md` is APPEND-ONLY.
 *
 * The file is the design system's ledger of what the app needed and could not get. Its value is
 * that nothing is ever quietly taken out of it: a gap marked ✅ RESOLVED stays, with its
 * measurement, because the next session that meets the same shape needs the history, and a count
 * that was "subtracted" once made an audit report a gap closed that had not been. The rule was a
 * memory note; this makes it a gate.
 *
 * Line count and the set of `## ` headings may only GROW. Editing a line in place is allowed (a
 * typo, a status flip from OPEN to RESOLVED) — the check is on removal, not on change.
 *
 *   node scripts/check-ds-gaps-append-only.mjs --check
 *   node scripts/check-ds-gaps-append-only.mjs --write   # re-freeze after an approved rewrite
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const FILE = '.claude/DS-GAPS.md'
const BASELINE = 'scripts/ds-gaps-baseline.json'

const text = readFileSync(FILE, 'utf8')
const lines = text.split('\n').length
const headings = text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.trim())

if (process.argv[2] === '--write') {
  writeFileSync(BASELINE, JSON.stringify({ note: 'DS-GAPS.md is append-only: lines and headings may only grow.', updatedAt: new Date().toISOString().slice(0, 10), lines, headings }, null, 2) + '\n')
  console.log(`✓ DS-GAPS baseline written: ${lines} lines, ${headings.length} headings`)
  process.exit(0)
}
if (!existsSync(BASELINE)) { console.error('❌ DS-GAPS append-only: no baseline — run with --write first'); process.exit(1) }
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const missing = base.headings.filter((h) => !headings.includes(h))
const problems = []
if (lines < base.lines) problems.push(`line count fell ${base.lines} → ${lines}`)
if (missing.length) problems.push(`heading(s) removed: ${missing.map((h) => JSON.stringify(h)).join(', ')}`)
if (problems.length) {
  console.error(`\n❌ DS-GAPS append-only: ${problems.join('; ')}.\n   The ledger only grows — mark a gap RESOLVED in place, never delete it.\n`)
  process.exit(1)
}
console.log(`✓ DS-GAPS append-only: ${lines} lines (≥ ${base.lines}), ${headings.length} headings (all ${base.headings.length} baseline headings present)`)
