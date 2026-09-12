#!/usr/bin/env node
/**
 * check-global-exposure — nothing may put an object on `window` / `globalThis` in a production bundle
 * without a decision.
 *
 * From a live incident (hub #500): the grid lab's `onGridReady` published a live AG `GridApi` on
 * `window.__gdsSheet` in the DEPLOYED bundle — `applyTransaction`, `setGridOption`, the lot — for
 * anyone who opened `/design/grid-lab`. Not interestingly exploitable; shipped without anyone deciding
 * it should. It is now `NODE_ENV`-guarded, and this is the gate that keeps the next one from shipping.
 *
 * WHAT IT REPORTS: every `__`-prefixed global assignment reachable from a client bundle, split into
 * GUARDED and UNGUARDED, with the unguarded count ratcheted. Guarded is reported too, deliberately —
 * so fixing one reads as a NUMBER MOVING rather than a line silently disappearing from a list.
 *
 * 🔴 THREE RULES IT ENCODES, each from a mistake made during the sweep that motivated it. A door
 * missing any one of them reports clean on live findings:
 *
 *   1. THREE SYNTACTIC FORMS, not one. `window.__x` and `globalThis.__x` MISS the aliased cast —
 *      `const g = globalThis as unknown as { __x }` contains neither string, and BOTH factory cases
 *      lived in that form. A door keyed on dotted access reports zero in apps/factory and looks clean.
 *   2. `'use client'` IS NOT ON LINE 1. It sits at line 11 in one importer here and line 13 in
 *      another, after docblocks. Detecting it with `head -3` classified nine client components as
 *      server and would have reported 1 unguarded instead of 2.
 *   3. `import type` ERASES. A client file importing a server module type-only does NOT pull it into
 *      the bundle — that is the only reason `lib/events.ts`'s `__factoryHub` is not a finding. A door
 *      that counts importers without distinguishing type imports manufactures findings, and a door
 *      with false positives is bypassed on day one.
 *
 *   4. A SUFFIX TEST IS NOT AN IDENTITY TEST. Matching importers by `[^'"]*events` made
 *      `@/lib/use-factory-events` count as an import of `lib/events.ts`; the door's FIRST run
 *      reported 3 unguarded, one of them the very case its own rule 3 says is not a finding. Compare
 *      the specifier's own basename with `===`, and scope to one app — both apps carry a `lib/db.ts`,
 *      a `lib/events.ts` and a design system.
 *
 * STATED LIMIT: client-reachability is computed one import level deep (the file itself carries
 * `'use client'`, or a direct value-importer does). A global assigned in a module reached only
 * transitively through two server-looking hops is NOT flagged. Widening that is a real change, not a
 * tweak — it needs a module graph, and a guess in either direction is worse than a stated boundary.
 *
 *   node scripts/check-global-exposure.mjs
 *   node scripts/check-global-exposure.mjs --self-test
 */
import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const ROOTS = ['apps/web/src', 'apps/factory/src']
/**
 * 🔴 1, not the 2 this door was commissioned at. The two live cases were routed the moment they were
 * found; DS.2 landed `use-factory-events.ts` at 06:50 — the `globalThis` singleton is now a
 * module-scope `const MANAGER`, which every one of its 9 importers shares identically — while this
 * file was still being written. Holding the ratchet at 2 would have left standing room for one new
 * global to ship unnoticed, which is the opposite of what a ratchet is for. It comes down as fixes
 * land; the remaining 1 is `GdsScenarios.tsx` (routed to PES.2).
 */
const RATCHET = 0

const files = () =>
  ROOTS.flatMap((r) => {
    try {
      // TRACKED OR NOT (hub #591). Nothing in this programme is committed, so `git ls-files` alone
      // scans a subset nobody chose — ~563 entries are untracked, whole surfaces among them.
      // `--exclude-standard` keeps `.gitignore` honoured so build output stays out.
      return [...new Set([
        ...execSync(`git ls-files '${r}/**/*.ts' '${r}/**/*.tsx'`, { encoding: 'utf8' }).split('\n'),
        ...execSync(`git ls-files --others --exclude-standard '${r}/**/*.ts' '${r}/**/*.tsx'`, { encoding: 'utf8' }).split('\n'),
      ])]
        // `git ls-files` lists tracked paths, including ones DELETED in the working tree — this
        // programme commits nothing, so that is the normal state, not an edge case. A guard that
        // throws ENOENT on a deleted file is a guard that stops reporting.
        .filter((f) => f && !/\.(test|vitest\.test)\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && existsSync(f))
    } catch {
      return []
    }
  })

const USE_CLIENT = /['"]use client['"]/

/**
 * The basenames this file pulls into its bundle: value `import`s, side-effect `import 'x'`, and
 * `export ... from` (a re-export loads the module too). `import type { X } from` is EXCLUDED — it
 * erases (rule 3).
 *
 * 🔴 Returns the specifier's OWN basename, and callers must compare it with `===`. The first version
 * of this door tested `from ['"][^'"]*${base}['"]`, i.e. suffix — so `@/lib/use-factory-events`
 * matched the target `events`, nine client files were read as importing `lib/events.ts`, and the door
 * reported 3 unguarded against a docblock that says `__factoryHub` is not a finding. That is the
 * BASENAME HOMONYM (rule 4): the same mistake as `from './MasterSheet'` matching a different
 * MasterSheet earlier in this programme. A suffix test is not an identity test.
 */
export function valueImportBases(src) {
  const bases = new Set()
  const add = (spec) => bases.add(spec.split('/').pop().replace(/\.(tsx?|jsx?|mjs)$/, ''))
  for (const m of src.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?from\s*['"]([^'"]+)['"]/g)) add(m[1])
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) add(m[1])
  return bases
}

/** apps/web and apps/factory both hold a `lib/db.ts`, a `lib/events.ts` and a whole design system. */
const appRoot = (f) => f.split('/').slice(0, 2).join('/')

/**
 * Find `__`-prefixed global assignments, in all three forms (rule 1), with a brace-aware check for an
 * enclosing `NODE_ENV !== 'production'` (or `=== 'development'`) block.
 */
/**
 * Blank out comments, PRESERVING newlines so reported line numbers stay true.
 *
 * 🔴 DS.2's catch: the file most likely to contain an explanation of a defect is the file that just
 * FIXED it, so a text scan is at its least reliable exactly where it is being asked to confirm a fix.
 * Their `use-factory-events.ts` docblock says `globalThis` twice while explaining why it is gone
 * (`grep -c` → 2, real references → 0), and they had hit the identical thing an hour earlier with a
 * comment reading `position: fixed` inside the change that removed it.
 *
 * This door required assignment SYNTAX, so their prose never matched and the live run was already
 * correct — but `// window.__x = probe` in a scanned file would have counted, and that is the same
 * bug one keystroke away. Strings are deliberately NOT blanked: `window['__x'] = 1` is a real
 * exposure whose key is a string literal, and blanking it would trade a rare false positive for a
 * routine false negative.
 */
/* MOVED 2026-09-02 (hub #684, DS.1-b) to `scripts/lib/strip-comments.mjs` so
   `ds-conformance-guard` and `check-grid-modules` can share this exact implementation.
   They could not import it from here: this module runs its full scan and exits at import
   time. Re-exported so this file's public surface is unchanged. The rationale above still
   applies and is why the helper reads the way it does. */
export { stripComments } from './lib/strip-comments.mjs'
import { stripComments } from './lib/strip-comments.mjs'

export function scanSource(rawSrc, file = '<input>') {
  const src = stripComments(rawSrc)
  const lines = src.split('\n')
  // Aliases: `const g = globalThis as ... {` / `= window as ... {`
  const aliases = new Set()
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:window|globalThis)\s+as\b/g)) aliases.add(m[1])

  const direct = /(?:window|globalThis)\s*\.\s*(__\w+)\s*(?:=|\?\?=)/
  const cast = /\(\s*(?:window|globalThis)\s+as[^)]*\)\s*\.\s*(__\w+)\s*(?:=|\?\?=)/
  const bracket = /(?:window|globalThis)\s*\[\s*['"](__\w+)['"]\s*\]\s*(?:=|\?\?=)/

  // Shape A — an enclosing DEV-ONLY BLOCK.
  const opensDevBlock = (l) =>
    /process\.env\.NODE_ENV\s*!==\s*['"]production['"]/.test(l) ||
    /process\.env\.NODE_ENV\s*===\s*['"](development|test)['"]/.test(l)
  // Shape B — a PRODUCTION EARLY RETURN. Everything after it in the same block is dev-only, and the
  // first version of this door could not see it: PES.2 wrote `if (NODE_ENV === 'production') return`,
  // a perfectly real guard, and was told it was unguarded. A door that says you are wrong without
  // saying what to write sends people to reshape working code.
  const testsForProd = (l) =>
    /process\.env\.NODE_ENV\s*===\s*['"]production['"]/.test(l) ||
    /process\.env\.NODE_ENV\s*!==\s*['"](development|test)['"]/.test(l)

  const out = []
  let devDepth = 0 // brace depth of the innermost enclosing dev-only block, 0 = none
  let bailDepth = -1 // brace depth at a production early return; the rest of that block is dev-only
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (opensDevBlock(line) && line.includes('{')) devDepth = depth + 1

    // A production test only guards if it actually BAILS — `=== 'production'` followed by work is
    // the opposite of a guard. Conservative on purpose: a bail buried below other statements in the
    // block is not credited, which over-reports rather than under-reports.
    if (bailDepth < 0 && testsForProd(line)) {
      let bails = /\breturn\b/.test(line)
      if (!bails && line.includes('{')) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          if (!lines[j].trim()) continue
          bails = /^\s*return\b/.test(lines[j])
          break
        }
      }
      if (bails) bailDepth = depth
    }

    let name = null
    for (const re of [direct, cast, bracket]) {
      const m = line.match(re)
      if (m) { name = m[1]; break }
    }
    if (!name) {
      for (const a of aliases) {
        const m = line.match(new RegExp(`\\b${a}\\s*\\.\\s*(__\\w+)\\s*(?:=|\\?\\?=)`))
        if (m) { name = m[1]; break }
      }
    }
    // A type-position mention (`as unknown as { __x?: T }`) is a declaration, not an assignment.
    if (name && !/[?:]\s*$/.test(line.split(name)[1] ?? '')) {
      out.push({ file, line: i + 1, name, guarded: devDepth > 0 || bailDepth >= 0, text: (rawSrc.split('\n')[i] ?? line).trim().slice(0, 96) })
    }

    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (devDepth && depth < devDepth) devDepth = 0
    if (bailDepth >= 0 && depth < bailDepth) bailDepth = -1
  }
  return out
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ['form 1 — direct, unguarded (GdsScenarios)', 'useEffect(() => {\n  window.__gdsProbe = probe\n})', 1, 0],
    ['form 2 — cast, GUARDED (GdsSheetScenario)',
      "if (process.env.NODE_ENV !== 'production') {\n  ;(window as unknown as { __gdsSheet?: unknown }).__gdsSheet = { api }\n}", 0, 1],
    ['form 3 — aliased cast, unguarded (use-factory-events)',
      'const g = globalThis as unknown as { __factoryEventManager?: M };\nfunction m(){ return (g.__factoryEventManager ??= { source: null }); }', 1, 0],
    ['bracket access', "window['__sneaky'] = 1", 1, 0],
    ['type-position declaration is NOT an assignment', 'const g = globalThis as unknown as { __factoryHub?: Hub };', 0, 0],
    ['a guarded block that has CLOSED no longer guards', "if (process.env.NODE_ENV !== 'production') {\n  window.__a = 1\n}\nwindow.__b = 2", 1, 1],
    ['no globals at all', 'const x = window.innerWidth', 0, 0],
    ['a line comment describing a removed assignment is NOT one (DS.2)',
      '// was: window.__gdsProbe = probe, before the guard\nconst x = 1', 0, 0],
    ['a docblock explaining the fix is NOT the defect (DS.2)',
      '/**\n * A `globalThis` singleton shipped a live EventSource:\n * const g = globalThis as unknown as { __m }; g.__m = mk()\n */\nconst MANAGER = { source: null }', 0, 0],
    ['a REAL assignment below such a docblock is still caught',
      '/** explains that window.__old = x used to exist */\nwindow.__new = y', 1, 0],
    ['shape B — production EARLY RETURN, same line (PES.2\'s form)',
      "if (process.env.NODE_ENV === 'production') return\nwindow.__x = 1", 0, 1],
    ['shape B — early return in block form',
      "if (process.env.NODE_ENV === 'production') {\n  return\n}\nwindow.__x = 1", 0, 1],
    ['a production test that does NOT bail is not a guard',
      "if (process.env.NODE_ENV === 'production') { log() }\nwindow.__x = 1", 1, 0],
    ['an assignment BEFORE the bail still runs in production',
      "window.__early = 1\nif (process.env.NODE_ENV === 'production') return\nwindow.__late = 2", 1, 1],
    ['the bail stops guarding once its block closes',
      "function a() {\n  if (process.env.NODE_ENV === 'production') return\n  window.__in = 1\n}\nwindow.__out = 2", 1, 1],
  ]
  const importCases = [
    ['homonym: `use-factory-events` is NOT `events`', "import { useFactoryEvents } from '@/lib/use-factory-events'", 'events', false],
    ['the real import of `events`', "import { hub } from './events'", 'events', true],
    ['`import type` erases — not a bundle import', "import type { Hub } from './events'", 'events', false],
    ['side-effect import loads the module', "import './events'", 'events', true],
    ['re-export loads the module too', "export { hub } from './events'", 'events', true],
    ['inline type specifier is still a value import', "import { type Hub, hub } from './events'", 'events', true],
  ]
  let bad = 0
  for (const [name, src, base, want] of importCases) {
    const got = valueImportBases(src).has(base)
    const ok = got === want
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — expected ${want}, got ${got}`)
  }
  for (const [name, src, wantUn, wantG] of cases) {
    const r = scanSource(src)
    const un = r.filter((x) => !x.guarded).length
    const g = r.filter((x) => x.guarded).length
    const ok = un === wantUn && g === wantG
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — expected ${wantUn} unguarded / ${wantG} guarded, got ${un}/${g}`)
  }
  console.log(bad === 0
    ? '\n[ok] self-test: three syntactic forms caught, guarded distinguished, no false positive from type position or basename homonym'
    : `\n[fail] self-test: ${bad} case(s) wrong`)
  process.exit(bad === 0 ? 0 : 1)
}

const all = files()
if (all.length === 0) {
  console.log('[fail] global-exposure: scanned ZERO files — the glob is wrong, which is a guard that cannot fail')
  process.exit(1)
}

const sources = new Map(all.map((f) => [f, readFileSync(f, 'utf8')]))
/** Rule 2: the directive is anywhere in the file, not on line 1. Rule 3: type-only importers erase. */
const isClient = (f) => {
  const src = sources.get(f) ?? ''
  if (USE_CLIENT.test(src)) return true
  const base = f.replace(/\.tsx?$/, '').split('/').pop()
  const root = appRoot(f)
  for (const [other, otherSrc] of sources) {
    if (other === f || appRoot(other) !== root) continue
    if (USE_CLIENT.test(otherSrc) && valueImportBases(otherSrc).has(base)) return true
  }
  return false
}

const hits = []
for (const [f, src] of sources) {
  const found = scanSource(src, f)
  if (found.length && isClient(f)) hits.push(...found)
}
const unguarded = hits.filter((h) => !h.guarded)
const guarded = hits.filter((h) => h.guarded)

// One header line, always (hub #566): whether a scanner strips comments changes what its output MEANS.
console.log('  comments: stripped (strings deliberately kept — a bracket key is a real hit)')
console.log(`global-exposure: ${all.length} files scanned · ${unguarded.length} unguarded · ${guarded.length} guarded (ratchet ${RATCHET})`)
for (const h of guarded) console.log(`   guarded    ${h.file}:${h.line}  ${h.name}`)
for (const h of unguarded) console.log(`   UNGUARDED  ${h.file}:${h.line}  ${h.name}\n                ${h.text}`)

if (unguarded.length > RATCHET) {
  console.log(`\n  [fail] ${unguarded.length} unguarded exceeds the ratchet of ${RATCHET}.`)
  console.log('  A `__`-prefixed global in a production bundle ships a live handle to anyone who opens the page.')
  console.log('  Guard it with either shape this door recognises, then re-run:')
  console.log("    A   if (process.env.NODE_ENV !== 'production') { window.__x = … }")
  console.log("    B   if (process.env.NODE_ENV === 'production') return   // rest of the block is dev-only")
  console.log('  Or lower the ratchet if you removed one.\n')
  process.exit(1)
}
if (unguarded.length < RATCHET) {
  console.log(`\n  [note] ${unguarded.length} unguarded is BELOW the ratchet of ${RATCHET} — lower RATCHET to ${unguarded.length} to hold the gain.`)
}
process.exit(0)
