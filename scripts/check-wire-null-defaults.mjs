#!/usr/bin/env node
/**
 * Guard: a `??` / `||` default over a field the WIRE declared nullable, feeding something an
 * operator reads.
 *
 * ── The class, and why it earns a guard ─────────────────────────────────────────────────────────
 * Four times in one night (PES, 2026-09-01/02) a server carefully distinguished "absent" from
 * "zero/default", and the client collapsed the distinction to avoid rendering an empty:
 *
 *   `clampPct(percent) → 0`      a readiness of `null` rendered as **0% ready** on a real screen
 *   `aliasKey ?? 'primary'`      would have missed the upsert's ON CONFLICT and INSERTed a listing
 *   `listingStatus ?? 'DRAFT'`   a coordinate with NO listing rendered identically to a draft one
 *   `?? []` over a required list  a genuinely absent array reading as "no issues"
 *
 * Every one type-checks, every one looks like defensive coding, and every one turns a measured
 * absence into a confident claim. The failure is invisible precisely because a plausible default
 * looks like data.
 *
 * ── What it flags, and what it deliberately does not ────────────────────────────────────────────
 * It reads the CONTRACT files first (`types.ts` mirrors and `*.service.ts` interfaces), collecting
 * every field declared `T | null` / `T | undefined` / `?:`. Then it flags a `??` or `||` whose left
 * side ends in one of those field names and whose right side is a **substantive literal** — a
 * string, a number, `true`, or a non-empty array.
 *
 * `?? null`, `?? undefined`, `?? []` and `?? {}` are NOT flagged: they preserve the absence.
 *
 * 🔴 **It finds the SHAPE, not the sin, and cannot tell them apart.** `listing?.quantity ?? '—'` and
 * `readOnlyReason ?? 'No listing on this coordinate.'` are the SAME shape as `?? 'DRAFT'` and are
 * correct — they NAME the absence. `totalAvailable ?? 0` is the same shape again and renders "0 in
 * stock" for "we don't know". Only a human can say which is which, so this ratchets rather than
 * blocks: the baseline is the reviewed set, and a rise means one new site needs that judgement.
 *
 * 🔴 A false positive here is worse than a miss (`reference_scanner_false_positive_worse`): it sends
 * someone to "fix" correct code. So this is ADVISORY by default and ratcheted — `--check` fails only
 * when the count rises above the recorded baseline.
 *
 * Usage:
 *   node scripts/check-wire-null-defaults.mjs            report (exit 0)
 *   node scripts/check-wire-null-defaults.mjs --check    exit 1 if above baseline
 *   node scripts/check-wire-null-defaults.mjs --baseline rewrite the baseline file
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const CHECK = process.argv.includes('--check')
const WRITE_BASELINE = process.argv.includes('--baseline')
const BASELINE_FILE = join(ROOT, 'scripts', 'wire-null-defaults-baseline.json')

const SKIP = new Set(['node_modules', '.git', '.claude', '.next', '.next-dev', 'dist', 'build', 'coverage', '.turbo', '.vercel'])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

const files = walk(ROOT)

/**
 * Pass 1 — every field a contract declares nullable.
 *
 * Collected by NAME rather than by type identity: full type resolution needs a whole-program
 * checker, which is minutes on this repo, and the name is what the flagged expression actually
 * carries. The cost is that a same-named local field can collide, which is why this is advisory and
 * why every finding prints its file and line for a human to check (`scanner_false_positive_worse`:
 * hand-verify one instance before believing the number).
 */
const nullableFields = new Set()
for (const file of files) {
  // 🔴 The WIRE contracts only — the studio's mirrors and the sheet services that feed them. A
  // first pass collected every nullable field in every interface in the repo (2,271 names,
  // including `value`, `code`, `message`, `length`) and matched 88,914 sites: a confidently
  // specific wrong number, which is worse than no guard at all
  // (reference_scanner_false_positive_worse). The class is narrow and the scan must be too.
  if (!/_studio\/.*types\.ts$|pim\/(studio-sheet|sheet-rows|sync-queue|sheet-columns)\.service\.ts$/.test(file)) continue
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (ts.isPropertySignature(node) && node.name && ts.isIdentifier(node.name)) {
      const optional = !!node.questionToken
      const unionWithNull =
        node.type &&
        ts.isUnionTypeNode(node.type) &&
        node.type.types.some(
          (t) => t.kind === ts.SyntaxKind.NullKeyword || t.kind === ts.SyntaxKind.UndefinedKeyword,
        )
      if (optional || unionWithNull) nullableFields.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
}

/** A default that INVENTS a value, as opposed to one that preserves the absence. */
function isSubstantiveDefault(node) {
  if (ts.isStringLiteral(node)) return node.text.length > 0
  if (ts.isNumericLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (ts.isArrayLiteralExpression(node)) return node.elements.length > 0
  if (ts.isObjectLiteralExpression(node)) return node.properties.length > 0
  return false
}

/**
 * Pass 2 — TYPE-CHECKED, and scoped to the studio.
 *
 * 🔴 Name matching does not work for this class and the evidence is in the history of this file: the
 * repo-wide name scan found 88,914 sites, and narrowing to studio contracts + render paths still
 * found 500 — of which a hand-checked sample was ~0% true positives (`presets.find()?.label ??`,
 * `c.width ?? 100`, `e?.message ??`: local config and Error objects, not wire data). `label`,
 * `width`, `status` and `message` are universal names. Only the checker can say that THIS
 * `listingStatus` is `SheetListing.listingStatus` and not any other.
 *
 * A Program over the studio alone keeps the checker affordable, and the studio is where the class
 * was found four times.
 */
const SCOPE = join(ROOT, 'apps/web/src/app/products/[id]/edit/_studio')
const scopeFiles = files.filter(
  (f) => f.startsWith(SCOPE) && /\.tsx$/.test(f) && !/\.(test|spec|vitest\.test)\.tsx?$/.test(f),
)
const program = ts.createProgram(scopeFiles, {
  target: ts.ScriptTarget.Latest,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: false,
  noEmit: true,
  /**
   * 🔴 `strict` is NOT optional here — without `strictNullChecks` TypeScript ERASES `null` from a
   * union, so `listingStatus: string | null` reports as `string` and this guard finds nothing while
   * looking like it works. Measured: the checker resolved the declaration at the right line, whose
   * source text reads `string | null`, and still returned `string`. The guard for "a tool collapsed
   * an absence into a value" was itself defeated by exactly that.
   */
  strict: true,
  skipLibCheck: true,
  baseUrl: join(ROOT, 'apps/web'),
  paths: { '@/*': ['src/*'] },
})
const checker = program.getTypeChecker()

/** Does this symbol's declaration live in a WIRE contract (a mirror or a sheet service)? */
function isWireSymbol(sym) {
  for (const d of sym?.getDeclarations() ?? []) {
    const f = d.getSourceFile()?.fileName ?? ''
    if (/_studio\/.*types\.ts$/.test(f)) return true
    if (/pim\/(studio-sheet|sheet-rows|sync-queue|sheet-columns)\.service\.ts$/.test(f)) return true
  }
  return false
}

const findings = []
for (const src of program.getSourceFiles()) {
  if (!scopeFiles.includes(src.fileName)) continue
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      isSubstantiveDefault(node.right)
    ) {
      let left = node.left
      while (ts.isParenthesizedExpression(left)) left = left.expression
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) {
        const sym = checker.getSymbolAtLocation(left.name)
        if (sym && isWireSymbol(sym)) {
          const t = checker.getTypeOfSymbolAtLocation(sym, left.name)
          const nullable = (t.flags & ts.TypeFlags.Union)
            ? t.types.some((x) => x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
            : false
          if (nullable) {
            const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
            findings.push({
              file: relative(ROOT, src.fileName),
              line: line + 1,
              field: left.name.text,
              snippet: node.getText(src).replace(/\s+/g, ' ').slice(0, 90),
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

if (WRITE_BASELINE) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ count: findings.length }, null, 2) + '\n')
  console.log(`  baseline written: ${findings.length}`)
  process.exit(0)
}

const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).count : null

console.log(`\n  wire-null defaults: ${findings.length} (${nullableFields.size} nullable contract fields known)`)
if (baseline !== null) console.log(`  baseline: ${baseline}`)
for (const f of findings.slice(0, 40)) {
  console.log(`    ${f.file}:${f.line}  [${f.field}]  ${f.snippet}`)
}
if (findings.length > 40) console.log(`    … ${findings.length - 40} more`)

console.log(`
  Each of these invents a value the wire declined to give. Ask: does the server distinguish "absent"
  from this default? If it does, render the absence — a plausible default looks like data.
`)

if (CHECK && baseline !== null && findings.length > baseline) {
  console.log(`  ❌ ${findings.length} > baseline ${baseline} — a new wire-null default was added.\n`)
  process.exit(1)
}
process.exit(0)
