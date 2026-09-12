#!/usr/bin/env node
/**
 * Raw-primitive ratchet — every hand-rolled control the design system already ships.
 *
 * WHY THIS EXISTS
 * The platform is converting to the DS a directory at a time, and the parts not yet reached
 * (`app/products`, `app/fulfillment`, …) will be converted when those pages are rebuilt. That is
 * a deliberate decision, not neglect. What must NOT happen meanwhile is the pile growing: every
 * new `<button>` written today is one more thing to convert later, and it arrives with none of
 * the accessibility the DS component carries — this sweep found unlabelled icon buttons at
 * 1.89:1, a link failing AA on its own page ground, and a segmented control unreachable by Tab.
 *
 * THE RULE
 * A file may keep the raw controls it has. It may not gain one. A NEW file may have none at all.
 * Anything genuinely not in the DS gets ADDED to the DS — that is the whole point of the gap log
 * at `.claude/DS-GAPS.md`, and 89 of 98 gaps filed during this sweep were closed that way.
 *
 * Use the DS instead:
 *   <button>   → Button · ToolbarButton · FilterChip · TokenChip · SegmentedControl
 *   <input>    → Input · Checkbox · Radio · DateField      <select> → Listbox · Select · MultiSelect
 *   <textarea> → Textarea                                  <table>  → DataGrid · WorkspaceGrid
 *
 * EXEMPT
 *   design-system/**        it IS the design system
 *   *-flat-file/**          hard no-touch zone; its violations cannot be fixed, so they are not counted
 *   *.test.*, *.stories.*   not shipped UI
 *
 *   node scripts/check-raw-primitives-ratchet.mjs           # census
 *   node scripts/check-raw-primitives-ratchet.mjs --check   # exit 1 if any file rose
 *   node scripts/check-raw-primitives-ratchet.mjs --baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname
const BASELINE = join(ROOT, 'scripts/raw-primitives-baseline.json')

const PATTERNS = {
  button: /<button\b/g,
  input: /<input\b/g,
  select: /<select\b/g,
  textarea: /<textarea\b/g,
  table: /<table\b/g,
}

const EXEMPT = [/design-system\//, /-flat-file\//, /\.test\./, /\.stories\./, /\/catalog\//]

/* 🔴 DISCLOSED EDIT by DS.1 under hub ruling #591 — enumeration only, no rule and no baseline
   touched. This listed TRACKED files only; nothing in this programme is committed, so that is a
   subset nobody chose, and every green it printed was over it. `--exclude-standard` keeps
   `.gitignore` honoured. The function keeps its name for its callers. */
function tracked() {
  return [...new Set([
    ...execSync('git ls-files "apps/web/src/**/*.tsx"', { cwd: ROOT, encoding: 'utf8' }).split('\n'),
    ...execSync('git ls-files --others --exclude-standard "apps/web/src/**/*.tsx"', { cwd: ROOT, encoding: 'utf8' }).split('\n'),
  ])]
    .filter(Boolean)
    .filter((f) => !EXEMPT.some((re) => re.test(f)))
}

/**
 * Strip comments and string literals so `"<button>"` in a docstring or a string is not counted as a
 * control. The docstring said this before the code did (DS.1's comment audit, #575c): only comments
 * were stripped, so `'<button>'` inside a real string literal — the exact case named here — still
 * counted.
 *
 * 🔴 QUOTED REGIONS ARE MATCHED ON ONE LINE ONLY, and that is a deliberate under-reach. A general
 * string tokenizer breaks on JSX: `<p>don't stop</p>` is text, not a string, and a tokenizer that
 * opens a string at that apostrophe stays open until the next one — blanking whatever lies between,
 * which could include a REAL `<button` and make the ratchet UNDERCOUNT. For a gate, undercounting is
 * the dangerous direction: it lets new raw controls in silently, where overcounting merely annoys.
 * Requiring both quotes on one line means a lone apostrophe in JSX text can never open a region, and
 * the only way to lose a real control is for one to sit BETWEEN two apostrophes on a single line of
 * JSX text — which no longer parses as the tag it looks like anyway.
 *
 * Replacement preserves length so nothing downstream that counts offsets is disturbed.
 */
function code(src) {
  const blank = (m) => ' '.repeat(m.length)
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    // same-line quoted regions only — see the note above on why this deliberately under-reaches
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/`(?:[^`\\\n]|\\.)*`/g, blank)
}

const counts = {}
for (const rel of tracked()) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) continue
  const src = code(readFileSync(p, 'utf8'))
  let n = 0
  for (const re of Object.values(PATTERNS)) n += (src.match(re) ?? []).length
  if (n) counts[rel] = n
}
const total = Object.values(counts).reduce((a, b) => a + b, 0)
const mode = process.argv[2] ?? '--census'

if (mode === '--baseline') {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: 'Raw DS-replaceable controls per file. This may only FALL. A file absent here is held at ZERO, so anything NEW must use the design system. See the script header.',
        updatedAt: new Date().toISOString().slice(0, 10),
        total,
        files: counts,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`baseline written: ${Object.keys(counts).length} files, ${total} raw controls`)
  process.exit(0)
}

if (mode === '--census') {
  console.log(`${Object.keys(counts).length} file(s) hold ${total} raw control(s) the DS already ships\n`)
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${f}`)
  }
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const risen = Object.entries(counts).filter(([f, n]) => n > (base.files[f] ?? 0))
if (risen.length) {
  console.error(`❌ raw-primitive ratchet: ${risen.length} file(s) gained a hand-rolled control:`)
  for (const [f, n] of risen) {
    const was = base.files[f] ?? 0
    console.error(`   ${f}: ${was} → ${n}`)
    // `was === 0` means the file is new OR was already clean. Either way the rule is the same,
    // and saying "NEW FILE" for a file that merely had no raw controls sends you looking for a
    // file that is not there.
    if (!was) console.error(`     This file had NONE — it must use the design system. See the script header for the mapping.`)
  }
  console.error(
    `\n   Anything the DS genuinely does not cover gets ADDED to the DS, not hand-rolled here.\n` +
      `   File it in .claude/DS-GAPS.md — 89 of the 98 gaps filed during the sweep were closed that way.`,
  )
  process.exit(1)
}
console.log(`✓ raw-primitive ratchet: ${total} raw control(s) (baseline ${base.total}) — no file rose`)
