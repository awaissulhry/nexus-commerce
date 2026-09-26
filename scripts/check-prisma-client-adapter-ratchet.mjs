#!/usr/bin/env node
/**
 * Prisma 7 — a PrismaClient needs a driver adapter. A ratchet, not a rewrite.
 *
 * WHY
 * Since the Prisma 7 upgrade (2026-09-25) `new PrismaClient()` without an adapter throws
 * "A driver adapter is required" the moment it is constructed. About 300 one-off scripts
 * (scripts/, apps/api/scripts/, packages/database/scripts/) were written for Prisma 6 and
 * still do it. None is wired into a tool, a schedule or CI, so rewriting them blind would
 * only move untested code around. This stops the pile from growing instead: a script that is
 * reused gets fixed on the way past, and a new one cannot be written the old way.
 *
 * THE RULE
 * A file may keep the adapter-less constructions it has. It may not gain one. A NEW file is
 * held at ZERO. The fix for any of them: import the client from `@nexus/database` (it brings
 * the adapter, the business scope and the runtime role), or pass `{ adapter }` explicitly.
 *
 * WHAT IT COUNTS
 * Each `new PrismaClient(...)` whose argument text does not mention `adapter`, in tracked
 * .ts/.mts/.cts/.js/.mjs/.cjs files. Occurrences inside `//` or `*` comment lines are skipped.
 *
 *   node scripts/check-prisma-client-adapter-ratchet.mjs            # census
 *   node scripts/check-prisma-client-adapter-ratchet.mjs --check    # exit 1 if any file rose
 *   node scripts/check-prisma-client-adapter-ratchet.mjs --baseline # rewrite the baseline
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts/prisma-client-adapter-baseline.json')
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/
const NEEDLE = 'new PrismaClient('

/** Adapter-less constructions in one source text. */
export function countAdapterless(source) {
  let count = 0
  let from = 0
  for (;;) {
    const at = source.indexOf(NEEDLE, from)
    if (at < 0) return count
    from = at + NEEDLE.length
    const lineStart = source.lastIndexOf('\n', at) + 1
    const before = source.slice(lineStart, at)
    if (before.includes('//') || /^\s*\*/.test(before)) continue
    let depth = 1
    let end = from
    while (end < source.length && depth > 0) {
      if (source[end] === '(') depth++
      else if (source[end] === ')') depth--
      end++
    }
    if (!source.slice(from, end).includes('adapter')) count++
  }
}

function census() {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(file => CODE.test(file) && !file.includes('node_modules/'))
  const counts = {}
  for (const file of files) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    const source = readFileSync(path, 'utf8')
    if (!source.includes(NEEDLE)) continue
    const n = countAdapterless(source)
    if (n > 0) counts[file] = n
  }
  return counts
}

const mode = process.argv[2]
if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = census()
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  if (mode === '--baseline') {
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n')
    console.log(`prisma-client-adapter: baseline written — ${total} in ${Object.keys(counts).length} files`)
  } else if (mode === '--check') {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
    const rose = Object.entries(counts).filter(([file, n]) => n > (baseline[file] ?? 0))
    if (rose.length) {
      console.error('\n❌ prisma-client-adapter ratchet: `new PrismaClient()` without an adapter throws under Prisma 7.')
      for (const [file, n] of rose) console.error(`   ${file}: ${n} (baseline ${baseline[file] ?? 0})`)
      console.error('   Import the client from `@nexus/database`, or pass `{ adapter }`.\n')
      process.exit(1)
    }
    console.log(`✓ prisma-client-adapter: ${total} grandfathered in ${Object.keys(counts).length} files, none new.`)
  } else {
    for (const [file, n] of Object.entries(counts).sort(([, a], [, b]) => b - a).slice(0, 20)) console.log(`${n}\t${file}`)
    console.log(`total ${total} in ${Object.keys(counts).length} files`)
  }
}
