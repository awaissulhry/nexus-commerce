#!/usr/bin/env node
/**
 * Help-cursor ratchet (2026-08-20) — the operator ruled the question-mark cursor out,
 * everywhere and permanently: hovering an info/eye icon (or anything else) must keep the
 * default cursor; the tooltip alone carries the explanation.
 *
 * Baseline is ZERO. 55 occurrences across 17 files were removed the day this shipped
 * (two shared sources — ads.css `.info` and SyncTip's TipText default prop — plus 44
 * page-local drift rules). Any literal reintroduction fails the push.
 *
 * Scans apps/web/src source files only (.css/.ts/.tsx), skipping node_modules and
 * generated output. Comments count too — do not write the literal in a comment; describe
 * it instead ("question-mark cursor"), or this guard becomes the thing it checks for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file's own location, not process.cwd(), so the guard gives the same
// answer from the pre-push hook (repo root) and from any subdirectory.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/web/src')
const PATTERNS = [/cursor\s*:\s*help/i, /cursor\s*:\s*['"]help['"]/i, /\bcursor-help\b/]
const EXT = new Set(['.css', '.ts', '.tsx'])

const hits = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { walk(p); continue }
    const dot = name.lastIndexOf('.')
    if (dot === -1 || !EXT.has(name.slice(dot))) continue
    const lines = readFileSync(p, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (PATTERNS.some((re) => re.test(line))) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
}
walk(ROOT)

if (hits.length) {
  console.error(`❌ help-cursor ratchet: ${hits.length} occurrence(s) of a help cursor — the baseline is 0.`)
  console.error('   The operator ruled the question-mark cursor out everywhere (2026-08-20).')
  console.error('   Keep the default cursor; let the tooltip carry the explanation.\n')
  for (const h of hits) console.error('   ' + h)
  process.exit(1)
}
console.log('✓ help-cursor ratchet: 0 occurrences (baseline 0)')
