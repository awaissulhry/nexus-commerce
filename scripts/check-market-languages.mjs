#!/usr/bin/env node
/**
 * LX.2's language-authority guard, as a GATE (LX.F P2-11).
 *
 * `Marketplace.languages` is the only market→language authority (design LX.2 /
 * Owner decision D3). The AST guard that enforces it
 * (`apps/api/src/services/pim/market-languages-guard.ts`) existed only inside one
 * vitest file, so `/usr/bin/grep -rln "marketLanguageViolations" scripts/` found
 * NOTHING: a gate nobody's `npm run` reaches is a gate that goes quiet. The other
 * nine gates in this repo are node scripts whose exit code goes in the ledger, so
 * this is one too.
 *
 * R-LX-29 (CLOSE.1, 2026-09-13) — TWO changes, both measured, both announced in
 * `docs/lx-prompts-2026-09-13.md` because they move every lane's baseline:
 *
 *  1. The guard now also detects the REVERSE direction — a language→market literal, as a map
 *     (`{ de: 'DE' }`) or as a switch (`case 'it': return 'IT'`). The reasoning is in
 *     `market-languages-guard.ts`; the short version is that `TranslationsLens.tsx`'s
 *     `MARKETPLACE_FOR_LOCALE` lived through the whole programme and this gate reported the SAME 1
 *     violation before and after it was deleted. The in-run instrument control therefore expects
 *     **5** shapes, not 3.
 *  2. The scan covers `apps/web/src` as well as `apps/api/src`. That is not tidiness: the one real
 *     language→market map this ruling exists for was a WEB file, so a rule added to an API-only scan
 *     would have been pointed at a tree that never contained it — "the dangerous green has nothing
 *     to look at" (`reference_control_must_target_the_branch`). Measured cost: 2,978 more files, 16
 *     pre-existing violations, none of them new work, each baselined WITH ITS OWNER below.
 *     API paths stay relative to `apps/api/src` (`services/…`) so neither the Owner's exemption
 *     patterns nor the existing baseline entry moves; web paths are repo-relative
 *     (`apps/web/src/…`), which is also how they are unambiguous.
 *
 * Usage: node scripts/check-market-languages.mjs            (gate)
 *        node scripts/check-market-languages.mjs --baseline (record known violations)
 *        node scripts/check-market-languages.mjs --strict    (fail on ANY violation)
 *
 * Exit 0 = no NEW violation · exit 1 = a new hardcoded market↔language definition.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = join(ROOT, 'apps/api')
const BASELINE = join(ROOT, 'scripts/market-languages-baseline.json')
const mode = process.argv[2]

// The guard is TypeScript and uses the TS compiler API, so it runs under tsx in a
// child process; the API half of the scan walks apps/api/src exactly as its own test
// does, and R-LX-29 added the web half beside it (see the header).
const scan = `
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MARKET_LANGUAGE_EXEMPTIONS, marketLanguageViolations } from './src/services/pim/market-languages-guard.ts'
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
// [directory, the prefix the violation is REPORTED under]. API keeps its bare paths (R-LX-29).
const roots = [['src', ''], ['../web/src', 'apps/web/src/']]
const checked = []
for (const [root, prefix] of roots) {
  for (const path of files(root).map(path => relative(root, path).replace(/\\\\/g, '/'))) {
    if (!/(?:\\.test\\.tsx?$|\\/__tests__\\/)/.test(path)) checked.push({ file: join(root, path), reported: prefix + path })
  }
}
const exempt = checked.filter(entry => MARKET_LANGUAGE_EXEMPTIONS.some(pattern => pattern.test(entry.reported))).map(entry => entry.reported)
const violations = checked.flatMap(entry => marketLanguageViolations(entry.reported, readFileSync(entry.file, 'utf8')))
// The instrument's own positive control, in the same run: FIVE shapes that MUST fire — the three
// market→language ones, and R-LX-29's two in the reverse direction.
const control = marketLanguageViolations('services/probe.ts', "const tag = 'it_IT'; const MAP = { DE:'de', IT:'it' }; prisma.marketplace.findFirst({where:{code:'DE'}}); const FOR_LOCALE = { de:'DE', it:'IT' }; function market(language) { switch (language) { case 'it': return 'IT' } }").length
console.log(JSON.stringify({ scanned: checked.length, exempt, violations, control }))
`

let report
try {
  const out = execFileSync('npx', ['tsx', '-e', scan], { cwd: API, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  report = JSON.parse(out.trim().split('\n').filter(line => line.startsWith('{')).pop())
} catch (error) {
  console.error('✗ the guard could not run:', error.stderr?.toString().slice(-800) ?? error.message)
  process.exit(1)
}

console.log(`LX.2 language-authority gate: ${report.scanned} files scanned · ${report.exempt.length} Owner exemption(s) · ${report.violations.length} violation(s) · instrument control ${report.control} (expects 5)`)
for (const path of report.exempt) console.log(`  exempt (Owner, untouchable): ${path}`)
if (report.control !== 5) {
  console.error('✗ the guard itself did not fire on its known-bad control — the gate proves nothing')
  process.exit(1)
}

if (mode === '--baseline') {
  writeFileSync(BASELINE, JSON.stringify(report.violations, null, 2) + '\n')
  console.log(`baseline written: ${report.violations.length} known violation(s)`)
  process.exit(0)
}
let baseline = []
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { baseline = [] }
/**
 * The baseline key drops the LINE NUMBER (LX.F, measured 2026-09-13 14:2x).
 *
 * Keyed by `path:line: reason`, this ratchet went red for an edit that moved a known
 * violation by ONE line — VT.1 changed something above `ebay-variation-push.service.ts`
 * and the gate reported `:455` as NEW and `:454` as "now fixed", with no defect either
 * way. That is a false alarm AND a false all-clear in the same run. The repo's other
 * ratchets key by FILE (`raw-primitives-baseline.json` is `{file: count}`) for exactly
 * this reason, so this one keys by path + reason and counts occurrences: a NEW violation
 * of the same kind in the same file still fails, because the count rises.
 */
const key = violation => {
  const match = /^(.*?):\d+: (.*)$/.exec(violation)
  return match ? `${match[1]}: ${match[2]}` : violation
}
const tally = list => list.reduce((counts, violation) => counts.set(key(violation), (counts.get(key(violation)) ?? 0) + 1), new Map())
const now = tally(report.violations), before = mode === '--strict' ? new Map() : tally(baseline)
const fresh = report.violations.filter(violation => (now.get(key(violation)) ?? 0) > (before.get(key(violation)) ?? 0)
  && report.violations.filter(other => key(other) === key(violation)).indexOf(violation) >= (before.get(key(violation)) ?? 0))
const carried = report.violations.filter(violation => !fresh.includes(violation))
const cleared = [...before.entries()].filter(([entry, count]) => (now.get(entry) ?? 0) < count).map(([entry]) => entry)
// Printed on every run, green or not: a baselined literal is still a literal, and the owners are in
// CLOSE.1's ledger section. A count alone lets 16 real defects read as housekeeping.
for (const violation of carried) console.log(`  carried by the baseline (still true): ${violation}`)
for (const violation of fresh) console.error(`✗ ${violation}`)
if (cleared.length) console.log(`${cleared.length} baseline violation(s) now fixed — rerun with --baseline to tighten`)
if (fresh.length) {
  console.error('Read the market\'s languages through `marketLanguages(channel, code)`; serialize a provider tag with `languageTag(language, code)`.')
  process.exit(1)
}
console.log(`${report.violations.length - fresh.length} known violation(s) carried by the baseline; 0 new.`)
process.exit(0)
