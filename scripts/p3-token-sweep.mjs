#!/usr/bin/env node
/**
 * P3 — app-wide raw-class → semantic-token sweep (UI_REBUILD_STRATEGY.md).
 *
 * Codemods the raw Tailwind classes that fail the legibility bar into
 * the P0 semantic tokens. Every mapping is MONOTONIC — it only ever
 * darkens text / strengthens a border, never the reverse — so the
 * change cannot reduce contrast on any element. `dark:`-prefixed
 * occurrences are skipped (the token already auto-flips, so rewriting
 * them is a pointless no-op).
 *
 * Mappings:
 *   text-slate-400   -> text-tertiary    (fails AA -> 4.7:1 AA)
 *   border-slate-200 -> border-default   (~1.4:1   -> visible slate-300)
 *   border-slate-100 -> border-subtle    (near-0   -> slate-200)
 *
 * EXCLUDED (never touched):
 *   - the amazon-flat-file + ebay-flat-file dirs, and any FlatFile file
 *     (standing hard constraint: zero changes without explicit approval)
 *   - the app/design dir (style-guide + the intentional "before" demos)
 *
 * Usage:
 *   node scripts/p3-token-sweep.mjs            # dry-run: counts only
 *   node scripts/p3-token-sweep.mjs --apply    # write changes
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'apps/web/src'
const APPLY = process.argv.includes('--apply')

// (?<!dark:) skips dark-prefixed classes; (?![\w-]) prevents matching a
// longer class (text-slate-4000) while still allowing the /opacity tail.
const MAPPINGS = [
  { from: /(?<!dark:)text-slate-400(?![\w-])/g, to: 'text-tertiary', label: 'text-slate-400 → text-tertiary' },
  { from: /(?<!dark:)border-slate-200(?![\w-])/g, to: 'border-default', label: 'border-slate-200 → border-default' },
  { from: /(?<!dark:)border-slate-100(?![\w-])/g, to: 'border-subtle', label: 'border-slate-100 → border-subtle' },
]

const EXCLUDE = [
  /amazon-flat-file/i,
  /ebay-flat-file/i,
  /flatfile/i,
  /[/\\]app[/\\]design[/\\]/,
]

const shouldSkip = (path) => EXCLUDE.some((re) => re.test(path))

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walk(p, acc)
    } else if (/\.(tsx|ts)$/.test(name)) {
      acc.push(p)
    }
  }
  return acc
}

const files = walk(ROOT)
const counts = Object.fromEntries(MAPPINGS.map((m) => [m.label, 0]))
const changedFiles = []

for (const file of files) {
  if (shouldSkip(file)) continue
  const original = readFileSync(file, 'utf8')
  let next = original
  for (const m of MAPPINGS) {
    next = next.replace(m.from, () => {
      counts[m.label]++
      return m.to
    })
  }
  if (next !== original) {
    changedFiles.push(file)
    if (APPLY) writeFileSync(file, next, 'utf8')
  }
}

console.log(`\n  P3 token sweep — ${APPLY ? '\x1b[33mAPPLY\x1b[0m' : 'dry-run'}`)
console.log(`  scanned ${files.length} files under ${ROOT}\n`)
for (const m of MAPPINGS) {
  console.log(`    ${counts[m.label].toString().padStart(5)}  ${m.label}`)
}
const total = Object.values(counts).reduce((a, b) => a + b, 0)
console.log(`  ${'─'.repeat(50)}`)
console.log(`    ${total.toString().padStart(5)}  total in ${changedFiles.length} files\n`)

if (APPLY) {
  writeFileSync('/tmp/p3-changed.txt', changedFiles.map((f) => relative('.', f)).join('\n') + '\n')
  console.log('  wrote changed-file list → /tmp/p3-changed.txt\n')
} else {
  console.log('  sample of files that would change:')
  changedFiles.slice(0, 12).forEach((f) => console.log('    ' + relative('.', f)))
  console.log('\n  re-run with --apply to write.\n')
}
