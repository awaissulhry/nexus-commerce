#!/usr/bin/env node
/**
 * check-css-parse — the design system's stylesheets must PARSE.
 *
 * Built by DS.1 after a live incident (hub #262, 2026-09-02): a `star-slash` inside a comment in
 * `design-system/grid/theme/grid.css` ended that comment early, the rest of the block became
 * declarations, and the whole studio route came back as a Turbopack error page. **No guard saw it.**
 * `tsc` does not read CSS, the token guards scan for names rather than structure, and the DS
 * conformance ratchets count violations in text that parses. A stylesheet that does not parse is the
 * one failure that takes a route down rather than degrading it, and it was the only one with no gate.
 *
 * The file now carries a comment warning that "a `*` immediately before a `/` ends the comment".
 * That is a comment relying on a human reading it. This is the mechanism.
 *
 * WHAT IT CHECKS (structure only — never style, never tokens; those have their own guards):
 *   1. comments balance      — every opener closes, no closer without an opener, no unclosed at EOF
 *   2. braces balance        — outside comments and strings
 *   3. no NUL bytes          — a NUL makes the file read as binary and every ad-hoc `grep` skips it
 *                              silently (DS1-17: two DS sources were invisible to grep all night)
 *
 * It is STRICT BY DEFAULT and exits non-zero on any finding. That is deliberate: a sibling guard
 * (`check-css-token-definitions.mjs`) prints ❌ and exits 0 unless given `--check`, and a batch runner
 * keyed on `$?` reads that as PASS — which is exactly how I reported "all guards green" while one of
 * them was printing three failures at me (DS1-10). A gate with an advisory mode is a gate that lies to
 * the next person in a hurry.
 *
 *   node scripts/check-css-parse.mjs
 *   node scripts/check-css-parse.mjs --self-test   # re-creates the #262 incident, asserts it is caught
 */
import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const ROOTS = ['apps/web/src/design-system', 'apps/factory/src/design-system']

/**
 * Every stylesheet under the design systems, TRACKED OR NOT.
 *
 * 🔴 This used to read `git ls-files` alone, with the comment "so untracked scratch is ignored".
 * That reasoning was wrong for this programme and the comment was mine (hub #591). **Nothing here is
 * committed**, so untracked is not scratch — it is the work. ~563 entries are untracked, including
 * whole DS surfaces, and every green this gate printed was over the tracked subset only. A guard
 * that silently narrows its own input is worse than no guard, because it reports a ✓ for a set
 * nobody chose.
 *
 * `--exclude-standard` so `.gitignore` still applies — build output is not source.
 */
const sheets = () =>
  ROOTS.flatMap((r) => {
    let out = ''
    try {
      out = execSync(`git ls-files '${r}/**/*.css'`, { encoding: 'utf8' })
        + '\n' + execSync(`git ls-files --others --exclude-standard '${r}/**/*.css'`, { encoding: 'utf8' })
    } catch {
      return []
    }
    // `git ls-files` lists TRACKED paths, including ones deleted in the working tree. This programme
    // commits nothing, so a deleted-but-tracked file is the normal state here, not an edge case —
    // `readFileSync` then throws ENOENT and the door stops reporting for every lane until someone
    // notices. Found when the same shape crashed `check-global-exposure` on its first run (DS1-28).
    return [...new Set(out.split('\n'))].filter((f) => f && existsSync(f))
  })

/**
 * Scan one stylesheet. Walks character by character rather than using a regex: a regex cannot
 * distinguish a `*­/` inside a string from one that closes a comment, and getting THAT wrong is how a
 * guard invents a failure in code that is fine (a false positive is worse than a false negative —
 * it trains people to bypass the gate).
 */
export function scanCss(src, file = '<input>') {
  const issues = []
  const nul = src.indexOf('\u0000')
  if (nul !== -1) {
    issues.push({ file, line: src.slice(0, nul).split('\n').length, msg: 'NUL byte — this file reads as binary, so plain `grep` skips it silently (use `grep -a`; see DS1-17)' })
  }

  let line = 1
  let depth = 0 // brace depth outside comments/strings
  let i = 0
  let commentStart = 0
  let inComment = false
  let quote = null // ' or "

  while (i < src.length) {
    const c = src[i]
    const two = src.slice(i, i + 2)

    if (c === '\n') { line++; i++; continue }

    if (inComment) {
      if (two === '*/') { inComment = false; i += 2; continue }
      // CSS has no nested comments: an inner `/*` is literal text, not an opener. Not an error.
      i++
      continue
    }

    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) { quote = null }
      i++
      continue
    }

    if (two === '/*') { inComment = true; commentStart = line; i += 2; continue }
    if (two === '*/') {
      issues.push({ file, line, msg: '`*/` with no open comment — an earlier comment closed sooner than intended (a `*` immediately before a `/` ends it)' })
      i += 2
      continue
    }
    if (c === '"' || c === "'") { quote = c; i++; continue }
    if (c === '{') { depth++; i++; continue }
    if (c === '}') {
      depth--
      if (depth < 0) { issues.push({ file, line, msg: 'unbalanced `}` — more closing than opening braces' }); depth = 0 }
      i++
      continue
    }
    i++
  }

  if (inComment) issues.push({ file, line: commentStart, msg: 'comment opened here is never closed' })
  if (depth > 0) issues.push({ file, line, msg: `${depth} unclosed \`{\` at end of file` })
  return issues
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ['the #262 incident: a glob before a slash ends the comment', '/* names --nds-note-*/ and more\n   still comment */\n.a { color: red; }', true],
    ['unclosed comment', '.a { color: red; }\n/* never closed\n', true],
    ['unbalanced brace', '.a { color: red;\n', true],
    ['NUL byte', '.a { content: "x\u0000y"; }\n', true],
    ['clean sheet', '/* fine */\n.a { color: red; }\n.b { content: "*/"; }\n', false],
    ['`*/` inside a string is not a comment close', '.a::after { content: "*/"; }\n', false],
  ]
  let bad = 0
  for (const [name, src, shouldFail] of cases) {
    const got = scanCss(src).length > 0
    const ok = got === shouldFail
    if (!ok) bad++
    console.log(`  ${ok ? '✓' : '✗'} ${name} — expected ${shouldFail ? 'CAUGHT' : 'clean'}, got ${got ? 'CAUGHT' : 'clean'}`)
  }
  console.log(bad === 0 ? '\n✓ self-test: the guard catches the incident it was built for, and does not invent failures' : `\n✗ self-test: ${bad} case(s) wrong`)
  process.exit(bad === 0 ? 0 : 1)
}

const files = sheets()
if (files.length === 0) {
  console.log('✗ css-parse: found NO stylesheets to scan — the glob is wrong, which is a guard that cannot fail')
  process.exit(1)
}

// One header line, always (hub #566). This scanner is the exception that proves the rule: comments
// are its SUBJECT — an unbalanced one is the #262 incident it exists to catch — so stripping them
// would delete the defect. Stated, so nobody "fixes" it into consistency with the others.
console.log('  comments: NOT stripped — they are what this gate checks')
const all = files.flatMap((f) => scanCss(readFileSync(f, 'utf8'), f))
if (all.length === 0) {
  console.log(`✓ css-parse: ${files.length} DS stylesheets parse (comments balanced, braces balanced, no NUL bytes)`)
  process.exit(0)
}

console.log(`\n  ❌ ${all.length} CSS parse problem${all.length === 1 ? '' : 's'}:\n`)
for (const p of all) console.log(`  ${p.file}:${p.line}\n      ${p.msg}`)
console.log('\n  A stylesheet that does not parse takes the route DOWN rather than degrading it.\n')
process.exit(1)
