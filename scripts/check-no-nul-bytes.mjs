#!/usr/bin/env node
/**
 * A NUL byte in a source file makes this repo's `grep` SKIP the whole file.
 *
 * The shell's `grep` here is a function over `ugrep -I --ignore-files`: `-I`
 * treats a file containing a NUL byte as binary and never reports a match in it.
 * So one `\0` inside a template literal removes an entire file from every
 * repo-wide set claim — "no other caller", "13 exemptions", "every publish path"
 * — without any error anywhere. It happened twice in this tree: a dedup tuple in
 * `services/pim/amazon-content-payload.ts` (a PUBLISH path) and a fixture key in
 * `design/variation-projection/fixtures.ts` (LX.F F1, 2026-09-13).
 *
 * This gate is therefore about the INSTRUMENT, not about style. Use a printable
 * delimiter (`|`, or the escape ``, which is two bytes of source text and
 * one invisible character at runtime — the escape is fine, the literal is not).
 *
 * Usage: node scripts/check-no-nul-bytes.mjs        (gate: exit 1 on ANY offender — STRICT)
 *        node scripts/check-no-nul-bytes.mjs --ratchet   (exit 1 only on a NEW offender)
 *        node scripts/check-no-nul-bytes.mjs --baseline  (record today's offenders)
 *
 * 🔴 STRICT IS THE DEFAULT since 2026-09-13 (LX.F2, ruling R-LX-19). It used to be a
 * ratchet over `scripts/nul-bytes-baseline.json`, which carried the 13 files that
 * already had NUL bytes when LX.F wrote the gate (ads, factory, agent-fleet,
 * datasheet, two apps/api probe scripts). All 13 are FIXED — every one was an
 * in-memory delimiter (a Map key, a sha256 separator) whose reader lives in the same
 * file, so each was changed together with its reader, and every literal `\0` became
 * the SOURCE ESCAPE `\u001f` (U+001F UNIT SEPARATOR): six printable bytes in the
 * file, one invisible character at runtime, identical splitting behaviour, and the
 * file stays readable by this repo's `grep`. Measured after the sweep: 10,888 tracked
 * source files, 0 carrying a NUL byte.
 *
 * The baseline mode is KEPT so an emergency can re-record, but a baseline file is no
 * longer shipped: a lane's gate list runs this script with no argument and expects 0.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts/nul-bytes-baseline.json')
const mode = process.argv[2]

const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss|md|sql|prisma|ya?ml|html|txt|sh)$/i
/**
 * TRACKED **and UNTRACKED** — measured the hard way (LX.F, 2026-09-13 14:2x).
 *
 * The first spelling of this gate listed `git ls-files` only, and in this repo whole
 * programmes live UNCOMMITTED in the working tree: the file whose NUL byte started this
 * gate (`services/pim/amazon-content-payload.ts`) is itself untracked, so the gate could
 * not have caught its own founding defect. `--others --exclude-standard` adds the
 * untracked files while still honouring `.gitignore`, which is what the LX.2 guard's own
 * test does for the same reason ("scans tracked and untracked API sources").
 */
const list = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0')
const files = [...new Set([...list(['ls-files', '-z']), ...list(['ls-files', '-z', '--others', '--exclude-standard'])])]
  .filter(path => path && EXTENSIONS.test(path) && !/(^|\/)(node_modules|\.next|\.next-formula-qa|dist|coverage)\//.test(path))

let scanned = 0
const offenders = []
for (const path of files) {
  let bytes
  try {
    if (statSync(path).size > 32 * 1024 * 1024) continue
    bytes = readFileSync(path)
  } catch { continue } // a file listed but not present (mid-rebase) is not this gate's business
  scanned++
  const offsets = []
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) offsets.push(i)
  if (offsets.length) offenders.push({ path, count: offsets.length, first: offsets[0] })
}

// A positive control for the instrument itself: prove it CAN see a NUL byte.
const control = Buffer.from('a\0b')
const controlFires = [...control].filter(byte => byte === 0).length === 1

console.log(`NUL-byte gate: ${scanned} source files scanned (tracked + untracked) · ${offenders.length} carrying a NUL byte · detector control ${controlFires ? 'fired' : 'DID NOT FIRE'}`)
if (!controlFires) {
  console.error('✗ the detector itself is broken — a known NUL byte was not seen')
  process.exit(1)
}
if (mode === '--baseline') {
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(offenders.map(o => [o.path, o.count])), null, 2) + '\n')
  console.log(`baseline written: ${offenders.length} files`)
  process.exit(0)
}
let baseline = {}
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { baseline = {} }
// LX.F2 R-LX-19 — strict unless a caller explicitly asks for the ratchet. `--strict`
// stays accepted so the gate lists written before this change keep working.
const strict = mode !== '--ratchet'
const failures = offenders.filter(o => strict || !(o.path in baseline) || o.count > baseline[o.path])
const carried = offenders.length - failures.length
for (const offender of failures) console.error(`✗ ${offender.path}: ${offender.count} NUL byte(s), first at offset ${offender.first}${offender.path in baseline ? ` (baseline ${baseline[offender.path]})` : ' (NEW)'}`)
const fixed = Object.keys(baseline).filter(path => !offenders.some(o => o.path === path))
if (fixed.length) console.log(`${fixed.length} baseline file(s) now clean — rerun with --baseline to tighten: ${fixed.join(', ')}`)
if (failures.length) {
  console.error('A NUL byte makes this repo\'s grep skip the file, so every repo-wide set claim silently omits it. Use a printable delimiter (| or the escape \\u001f) and change its reader in the same write.')
  process.exit(1)
}
console.log(strict ? `0 NUL bytes anywhere in ${scanned} source files (STRICT).` : `${carried} known offender(s) carried by the baseline; 0 new.`)
process.exit(0)
