#!/usr/bin/env node
/**
 * check-token-resolution — every `--nds-*` a stylesheet CONSUMES must be DEFINED in the app that
 * loads it. The eighth pre-push gate (hub #684, found and specified by DS.1-b, 2026-09-02).
 *
 * ── WHY NOTHING ELSE CATCHES THIS ────────────────────────────────────────────────────────────
 * An undefined custom property is neither an error nor a warning. `var(--x)` with no fallback makes
 * the whole declaration INVALID AT COMPUTED-VALUE TIME: the property silently takes its inherited
 * value (for an inherited property such as `color`) or its initial value (`max-width: none`,
 * `z-index: auto`). The page renders WRONG rather than broken, which is the worst failure shape a
 * stylesheet has, because nothing downstream can tell it from a design decision.
 *
 * Every existing gate is blind to it, and each for its own reason:
 *   tsc                     does not read CSS.
 *   check-css-parse         proves a sheet PARSES; an undefined token parses perfectly.
 *   token-guard             checks the FORM of a token (hex, numbered ramps, Tailwind, alias tier),
 *                           never whether a consumed one resolves.
 *   tokens:check            proves the generated CSS matches its generator — a token missing from
 *                           BOTH sides is entirely consistent, and it is web-only besides.
 *   check-ds-fork-drift     is blind to stylesheets, which is why the factory fork is where these
 *                           accumulate.
 *
 * ── INHERITED FROM `check-css-token-definitions.mjs`, WHICH THIS REPLACES (hub #708) ─────────
 * That guard (PES.3, 2026-09-01) was written for the same class and never wired. Its founding
 * incident is kept here because it is the clearest statement of why this matters:
 * `background: var(--nds-warning-bg)` — a token that has never existed — resolves to
 * `rgba(0,0,0,0)` with no error and no console warning, and the banner it styled shipped as a bare
 * outline on transparent, which at a glance reads as a deliberately quiet design rather than a bug.
 * An undefined token is the sibling of an undefined CSS class, one level down, and `var()` has no
 * strict mode to turn on.
 *
 * Two of its rules are carried over verbatim because they are right: a fallback is a deliberate
 * "may not exist" and is never a failure, and TS/TSX inline styles are real consumers. Two of its
 * behaviours are not: its definition set was REPO-WIDE, so a token defined in web counted as
 * defined for factory — the exact hole that let `--nds-popover-max-w` sit inert on the factory fork
 * while web defined it; and it walked `scripts/`, so it reported three guards' own self-test
 * fixtures (`--nds-nope`, `--nds-i`, `--nds-does-not-exist`) as real defects — half its output, and
 * a token whose whole purpose is to be absent must never be reported as absent.
 *
 * ── THE THREE IT WAS BUILT ON, all live, each dead from the day it was written ────────────────
 *   --nds-text-1         web      three ads rules colour text with a token defined NOWHERE in the
 *                                 repo — and never defined under its old `--h10-` name either, so
 *                                 the DS rename carried a broken reference rather than creating it.
 *                                 Dead since 2026-08-21.
 *   --nds-z-drawer       factory  `.nds-drawer` falls to `z-index: auto`, under the rail, the action
 *                                 bar and any modal backdrop. Factory defines every neighbour.
 *   --nds-popover-max-w  factory  #676's D18 popover cap and #678's hovercard cap are BOTH inert at
 *                                 render on that fork, while both were reported as landed.
 *
 * ── WHAT IT WILL NOT DO, stated rather than hidden ───────────────────────────────────────────
 * 1. A PARSER, NOT A GREP (the ruling's requirement, and it earned it: the hub's own grep attempt
 *    reported `--nds-border` undefined in web, which is false — an artefact of its own scaffolding).
 *    postcss walks declarations, so a `var()` inside a CSS comment is structurally invisible rather
 *    than filtered out by a regex that has to be right. postcss-value-parser handles nesting, so
 *    `var(--a, var(--b))` is two occurrences with the correct fallback status for each.
 * 2. SCOPE IS THE APP DIRECTORY, NOT THE IMPORT GRAPH. A token defined in a stylesheet the app never
 *    imports still counts as defined here. Closing that needs real module resolution; the failure it
 *    would add is "defined but unreachable", which is strictly rarer than "never defined at all".
 *    Factory happens to be exact anyway — its six sheets ARE its whole CSS surface.
 * 3. DEFINITIONS COME FROM CSS ONLY, never from `tokens/css-vars.ts`. What the browser resolves is
 *    the stylesheet; reading the generator too would let a token that never reached the generated
 *    file look defined, which is the exact drift `tokens:check` exists to catch and does not cover
 *    on factory.
 * 4. A var in a FALLBACK POSITION is reported as information, never red — it evaluates only when the
 *    outer token is itself missing, so it cannot be the primary defect.
 * 5. Names built at runtime are ABSTAINED BY NAME rather than guessed at, and a token written by
 *    `setProperty` is a real definition this gate would otherwise miss. Both are enumerated in the
 *    output even when empty, because an abstention nobody can see is indistinguishable from a pass.
 *
 * ── VACUOUS-GREEN GUARDS ─────────────────────────────────────────────────────────────────────
 * The dangerous green is the one produced by having nothing to look at. This gate FAILS, loudly,
 * if an app yields zero stylesheets, or zero definitions, or if any stylesheet does not parse —
 * each of those makes "no unresolved tokens" true for a reason that is not the one being claimed.
 *
 *   node scripts/check-token-resolution.mjs              # census, both forks
 *   node scripts/check-token-resolution.mjs --check      # non-zero exit if any token is unresolved
 *   node scripts/check-token-resolution.mjs --self-test  # six cases incl. the vacuous-green guard
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join, relative, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'
import ts from 'typescript'
import { stripComments } from './lib/strip-comments.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APPS = [
  { name: 'web', root: 'apps/web/src' },
  { name: 'factory', root: 'apps/factory/src' },
]

function* walk(dir, ext) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p, ext)
    else if (ext.some((x) => p.endsWith(x))) yield p
  }
}

/* Tracked AND untracked (#591: nothing in this programme is committed, so the untracked set IS the
   push), and TWO globs because a git double-star does not match a file sitting directly in the named
   directory (#601 measured 0 vs 1 on globals.css). The patterns are built below rather than written
   in this comment on purpose: a star followed by a slash ends a block comment. */
function filesFor(appRoot, ext) {
  const deep = `${appRoot}/**/*${ext}`
  const flat = `${appRoot}/*${ext}`
  const out = new Set()
  try {
    for (const cmd of [`git ls-files "${deep}" "${flat}"`, `git ls-files --others --exclude-standard "${deep}" "${flat}"`]) {
      for (const f of execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e9 }).split('\n')) if (f) out.add(f)
    }
  } catch { /* not a git tree — fall through to the walk */ }
  if (out.size === 0) for (const p of walk(join(ROOT, appRoot), [ext])) out.add(relative(ROOT, p))
  return [...out]
}

/** Every `var()` in a value, with its fallback status and whether it sits inside another's fallback. */
function eachVar(nodes, insideFallback, cb) {
  for (const n of nodes) {
    if (n.type === 'function' && n.value === 'var') {
      const comma = n.nodes.findIndex((x) => x.type === 'div' && x.value === ',')
      const first = n.nodes[0]
      if (first && first.type === 'word') cb(first.value, comma >= 0, insideFallback)
      if (comma >= 0) eachVar(n.nodes.slice(comma + 1), true, cb)
    } else if (n.nodes) {
      eachVar(n.nodes, insideFallback, cb)
    }
  }
}

function scanStylesheets(files) {
  const defined = new Map()
  const used = new Map()
  const unparsed = []
  for (const f of files) {
    const abs = isAbsolute(f) ? f : join(ROOT, f)
    if (!existsSync(abs)) continue
    let root
    try { root = postcss.parse(readFileSync(abs, 'utf8'), { from: abs }) }
    catch (e) { unparsed.push(`${f}: ${e.message}`); continue }
    root.walkDecls((decl) => {
      const line = decl.source?.start?.line ?? 0
      if (decl.prop.startsWith('--nds-')) {
        if (!defined.has(decl.prop)) defined.set(decl.prop, [])
        defined.get(decl.prop).push(`${f}:${line}`)
      }
      if (!decl.value.includes('var(')) return
      eachVar(valueParser(decl.value).nodes, false, (name, hasFallback, nested) => {
        if (!name.startsWith('--nds-')) return
        if (!used.has(name)) used.set(name, [])
        used.get(name).push({ at: `${f}:${line}`, hasFallback, nested })
      })
    })
  }
  return { defined, used, unparsed }
}

/* 🔴 EXCLUDED BY PATH, and each exclusion is a false positive someone would otherwise have chased.
   A guard's own SELF-TEST FIXTURES are the sharpest case: the guard this one replaces reported
   `--nds-nope` and `--nds-i` (fixtures inside this very file) and `--nds-does-not-exist` (a fixture
   inside `check-dark-pin-parity.mjs`) as three real defects, because it walked the whole repo
   including `scripts/`. A token whose entire purpose is to be absent must never be reported as
   absent. This gate scans only `apps/*` + `/src`, so `scripts/` is out by construction; the list
   below is what keeps it true as fixtures move INTO an app. */
const EXCLUDE_REF = [/\.(test|spec|vitest\.test)\.[jt]sx?$/, /\.stories\.[jt]sx?$/, /__(tests|fixtures|mocks)__\//, /\/fixtures\//]

/* References living in TS/TSX inline styles — `style={{ background: 'var(--nds-surface-2)' }}`.
   Inherited from the guard this replaces, and NOT optional: the only consumers of `--nds-surface-2`
   are six factory TSX inline styles, so a CSS-only scan called that token clean. A stylesheet is
   not the only thing that consumes a token. Comments are stripped first — the file that motivated
   the original guard carries a comment NAMING the undefined token it documents, and scanning raw
   text would report the documentation of the bug as the bug. */
function scanScriptRefs(appRoot) {
  const used = new Map()
  for (const f of [...filesFor(appRoot, '.ts'), ...filesFor(appRoot, '.tsx')]) {
    if (EXCLUDE_REF.some((re) => re.test(f))) continue
    const abs = join(ROOT, f)
    if (!existsSync(abs)) continue
    const raw = readFileSync(abs, 'utf8')
    if (!raw.includes('var(--nds-')) continue
    const code = stripComments(raw)
    code.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--nds-[\w-]+)\s*([,)])/g)) {
        if (!used.has(m[1])) used.set(m[1], [])
        used.get(m[1]).push({ at: `${f}:${i + 1}`, hasFallback: m[2] === ',', nested: false })
      }
    })
  }
  return used
}

/** Tokens an app writes at RUNTIME, and name PREFIXES it composes dynamically. Comments stripped. */
function objectTokenWrites(code, file = 'styles.tsx') {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const writes = []
  const visit = node => {
    if (ts.isPropertyAssignment(node)) {
      let name = node.name
      if (ts.isComputedPropertyName(name)) name = name.expression
      while (ts.isAsExpression(name) || ts.isParenthesizedExpression(name) || ts.isSatisfiesExpression(name)) name = name.expression
      if ((ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && /^--nds-[\w-]+$/.test(name.text)) {
        writes.push({ name: name.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return writes
}

function scanSources(appRoot) {
  const runtime = new Map()
  const dynamic = new Map()
  for (const f of [...filesFor(appRoot, '.ts'), ...filesFor(appRoot, '.tsx')]) {
    if (EXCLUDE_REF.some((re) => re.test(f))) continue
    const abs = join(ROOT, f)
    if (!existsSync(abs)) continue
    const raw = readFileSync(abs, 'utf8')
    if (!raw.includes('--nds-')) continue
    const code = stripComments(raw)
    const lineOf = (idx) => code.slice(0, idx).split('\n').length
    for (const { name, line } of objectTokenWrites(code, f)) {
      if (!runtime.has(name)) runtime.set(name, [])
      runtime.get(name).push(`${f}:${line}`)
    }
    for (const m of code.matchAll(/setProperty\(\s*['"`](--nds-[\w-]+)['"`]/g)) {
      if (!runtime.has(m[1])) runtime.set(m[1], [])
      runtime.get(m[1]).push(`${f}:${lineOf(m.index)}`)
    }
    for (const m of code.matchAll(/['"`](--nds-[\w-]*)\$\{/g)) {
      if (!dynamic.has(m[1])) dynamic.set(m[1], [])
      dynamic.get(m[1]).push(`${f}:${lineOf(m.index)}`)
    }
  }
  return { runtime, dynamic }
}

function analyse(app) {
  const sheets = filesFor(app.root, '.css')
  const { defined, used, unparsed } = scanStylesheets(sheets)
  const { runtime, dynamic } = scanSources(app.root)
  // TS/TSX inline-style references join the same set — same app, same resolution rule.
  const scriptRefs = scanScriptRefs(app.root)
  for (const [name, occ] of scriptRefs) used.set(name, [...(used.get(name) ?? []), ...occ])
  const abstained = []
  const red = []
  const info = []
  for (const [name, occ] of [...used.entries()].sort()) {
    if (defined.has(name)) continue
    if (runtime.has(name)) { abstained.push({ name, why: `written at runtime — ${runtime.get(name)[0]}` }); continue }
    const dyn = [...dynamic.keys()].find((p) => name.startsWith(p))
    if (dyn) { abstained.push({ name, why: `may be composed from "${dyn}${'${…}'}"` }); continue }
    const hard = occ.filter((o) => !o.hasFallback && !o.nested)
    if (hard.length) red.push({ name, occ: hard })
    else info.push({ name, occ, why: occ.every((o) => o.nested) ? 'only in a fallback position' : 'every use carries a fallback' })
  }
  return { app, sheets, defined, used, unparsed, runtime, dynamic, abstained, red, info }
}

function report(r, { verbose }) {
  const { app } = r
  console.log(`\n── ${app.name}  (${app.root})`)
  console.log(`   ${r.sheets.length} stylesheet(s) · ${r.defined.size} token(s) defined · ${r.used.size} consumed`)
  if (r.unparsed.length) {
    console.error(`   ❌ ${r.unparsed.length} stylesheet(s) did not parse — the scan is INCOMPLETE, not clean:`)
    for (const u of r.unparsed) console.error(`      ${u}`)
  }
  if (r.sheets.length === 0) console.error('   ❌ zero stylesheets found — the glob is wrong, and a gate with nothing to read cannot fail')
  if (r.defined.size === 0) console.error('   ❌ zero token definitions found — the parser read nothing, so any "all resolve" here is vacuous')
  for (const { name, occ } of r.red) {
    console.error(`   🔴 ${name} — consumed with NO fallback, defined nowhere in this app`)
    for (const o of occ) console.error(`        ${o.at}`)
  }
  if (verbose || r.info.length) for (const { name, why, occ } of r.info) {
    console.log(`   ·  ${name} — undefined but ${why} (information, not a failure) — ${occ[0].at}`)
  }
  console.log(`   abstained: ${r.abstained.length}${r.abstained.length ? '' : ' (no runtime-written and no dynamically-composed token names)'}`)
  for (const a of r.abstained) console.log(`      ${a.name} — ${a.why}`)
}

function run({ verbose }) {
  const results = APPS.map(analyse)
  for (const r of results) report(r, { verbose })
  const broken = results.some((r) => r.unparsed.length || r.sheets.length === 0 || r.defined.size === 0)
  const red = results.flatMap((r) => r.red.map((x) => ({ app: r.app.name, ...x })))
  return { results, red, broken }
}

/* Runs ONLY when executed directly. Every scanner in this directory runs its whole check at
   import time and exits, which is why `stripComments` had to be moved out of `check-global-exposure`
   before two gates could share it (#684). A gate that cannot be imported cannot be reused or tested
   from anywhere else, so this one does not repeat that. */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (!isMain) { /* imported for its exports — scan nothing, exit nothing */ }
else {

const mode = process.argv[2] ?? '--census'

if (mode === '--self-test') {
  const dir = mkdtempSync(join(tmpdir(), 'token-res-'))
  const w = (n, css) => { const p = join(dir, n); writeFileSync(p, css); return p }
  const cases = [
    ['an undefined token with NO fallback is caught', w('a.css', 'a{color:var(--nds-nope)}'), 1, 0],
    ['a fallback makes it information, not a failure', w('b.css', 'a{color:var(--nds-nope2, red)}'), 0, 1],
    ['a var() inside a CSS COMMENT is not a consumer at all', w('c.css', '/* var(--nds-incomment) */ a{color:red}'), 0, 0],
    ['a defined token resolves', w('d.css', ':root{--nds-ok:1}\na{opacity:var(--nds-ok)}'), 0, 0],
    ['nested: outer has a fallback, inner sits in it — neither is red', w('e.css', 'a{color:var(--nds-o, var(--nds-i))}'), 0, 2],
  ]
  let bad = 0
  for (const [label, file, wantRed, wantInfo] of cases) {
    const { defined, used } = scanStylesheets([file])
    let red = 0, info = 0
    for (const [name, occ] of used) {
      if (defined.has(name)) continue
      if (occ.some((o) => !o.hasFallback && !o.nested)) red++; else info++
    }
    const ok = red === wantRed && info === wantInfo
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wantRed} red / ${wantInfo} info, got ${red}/${info}`)
  }
  const empty = scanStylesheets([])
  const vacuous = empty.defined.size === 0 && empty.used.size === 0
  console.log(`  ${vacuous ? 'PASS' : 'FAIL'}  the vacuous-green guard has something to fire on — an empty file list yields 0 definitions, which the run treats as a FAILURE rather than a pass`)
  if (!vacuous) bad++
  const scriptCases = [
    ['inline React style', `const el = <div style={{ '--nds-arrow': '2px' }} />`, ['--nds-arrow']],
    ['computed geometry style', `const style = { ['--nds-pad' as string]: '4px' }`, ['--nds-pad']],
    ['type declarations are not writers', `type Style = { '--nds-type': string }`, []],
    ['quoted examples are not writers', `const doc = "{ '--nds-example': '4px' }"`, []],
    ['comments are not writers', `/* const style = { '--nds-comment': 1 } */`, []],
    ['token names used as values are not writers', `const key = '--nds-read-only'`, []],
  ]
  for (const [label, code, expected] of scriptCases) {
    const actual = objectTokenWrites(code).map(w => w.name)
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n[${bad === 0 ? 'ok' : 'FAILED'}] self-test: ${cases.length + scriptCases.length + 1} cases${bad ? `, ${bad} failing` : ''}`)
  process.exit(bad === 0 ? 0 : 1)
}

const { red, broken } = run({ verbose: mode === '--census' })

if (mode === '--check') {
  if (broken) {
    console.error('\n❌ token-resolution: the scan itself is not sound (see above) — this is a failure, not a pass.\n')
    process.exit(1)
  }
  if (red.length) {
    console.error(`\n❌ token-resolution: ${red.length} token(s) consumed with no fallback and defined nowhere in their app.`)
    console.error('   An undefined var() is invalid at computed-value time — the property falls back to its')
    console.error('   inherited or initial value and the surface renders WRONG rather than broken.')
    console.error('   Define it in that app\'s tokens/css-vars.ts and run THAT app\'s generator; never hand-edit')
    console.error('   a generated tokens.css, and never paper over it with a fallback.\n')
    for (const r of red) console.error(`   ${r.app}: ${r.name}`)
    console.error('')
    process.exit(1)
  }
  console.log('\n✓ token-resolution: every --nds-* consumed without a fallback resolves in its own app\n')
  process.exit(0)
}
process.exit(0)
}

export { scanStylesheets, scanSources, analyse, eachVar }
