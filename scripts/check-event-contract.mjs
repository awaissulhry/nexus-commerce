#!/usr/bin/env node
/**
 * EV.1 §guard — the event contract holds.
 *
 * WHY
 * The catalogue (packages/events/catalog.ts) is only a contract if nothing can
 * route around it. Three ways it could rot, each silent in production:
 *
 *   1. A publish of an event type that is not declared. It throws at runtime —
 *      inside whatever mutation raised it, which is a bad place to find out.
 *   2. A raw Redis stream command outside the driver. Then the envelope format,
 *      the sharding and the trimming policy exist in two places, and they drift.
 *   3. A TENTH in-process event bus. Nine already exist, none of them shared a
 *      vocabulary, and every one is invisible to a second replica. New buses
 *      go through the broker; the nine are a fixed, shrinking baseline.
 *
 * WHAT IT CHECKS (TypeScript AST, not a regex — a regex reads comments and
 * strings, and misses a call split across lines)
 *
 * The catalogue itself is read from SOURCE, also by AST: no dependency on
 * packages/events/dist being built, so this can never pass against a stale
 * copy of the contract it is enforcing.
 *
 *   node scripts/check-event-contract.mjs
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve from the script's own location, not the caller's cwd. pre-push cds
// to the repo root so relative paths happened to work there — but a guard that
// only runs correctly from one directory is a guard someone will run wrong.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const atRoot = (p) => join(repoRoot, p)

const DRIVER = 'apps/api/src/lib/events/redis-streams.driver.ts'
const STREAM_COMMANDS = new Set(['xadd', 'xread', 'xreadgroup', 'xack', 'xautoclaim', 'xgroup', 'xinfo', 'xlen'])

/** The nine in-process buses that predate the broker. This list only shrinks. */
const BUS_BASELINE = new Set([
  'apps/api/src/services/ads-execution-events.service.ts',
  'apps/api/src/services/inbound-events.service.ts',
  'apps/api/src/services/listing-events.service.ts',
  'apps/api/src/services/marketing-events.service.ts',
  'apps/api/src/services/order-events.service.ts',
  'apps/api/src/services/outbound-events.service.ts',
  'apps/api/src/services/po-events.service.ts',
  'apps/api/src/services/review-events.service.ts',
  'apps/api/src/services/sync-logs-events.service.ts',
])

/** Which argument carries the event type, per publisher. */
const PUBLISHERS = new Map([
  ['publishEvent', 1],            // publishEvent(tx, type, payload)
  ['publishEphemeral', 0],
  ['publishEphemeralDynamic', 0],
  ['buildEnvelope', 0],
])

function fail(lines, hint) {
  console.error(`\n❌ event contract: ${lines.length} violation(s)\n`)
  for (const l of lines) console.error(`   ${l}`)
  console.error(`\n   ${hint}\n`)
  process.exit(1)
}

// ── 1. read the catalogue from source ───────────────────────────────────────
const catalogPath = 'packages/events/catalog.ts'
const catalogSrc = readFileSync(atRoot(catalogPath), 'utf8')
const catalogFile = ts.createSourceFile(catalogPath, catalogSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const declared = new Set()
;(function findEvents(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(catalogFile) === 'EVENTS' && node.initializer) {
    // `EVENTS = { … } as const satisfies …` — unwrap the assertions to the literal.
    let init = node.initializer
    while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression
    if (ts.isObjectLiteralExpression(init)) {
      for (const prop of init.properties) {
        if (prop.name) declared.add(prop.name.getText(catalogFile).replace(/^['"]|['"]$/g, ''))
      }
    }
  }
  ts.forEachChild(node, findEvents)
})(catalogFile)

if (declared.size === 0) {
  fail([`${catalogPath}: could not read any event from the EVENTS registry`],
       'The guard parses the EVENTS object literal. If its shape changed, update this parser — do not delete the check.')
}

// ── 2. gather sources (tracked + untracked; a fresh session writes untracked) ─
// DIRECTORY pathspecs, not `**/*.ts` globs. git's `src/**/*.ts` matches only
// files at least one directory DEEP — it silently skipped apps/api/src/index.ts
// (where the event infrastructure is registered) and 12 others. A guard blind
// to the file that wires the thing it guards is worse than no guard.
const glob = '"apps/api/src/" "packages/events/" "services/"'
const list = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8', cwd: repoRoot }).split('\n').filter(Boolean) } catch { return [] }
}
const all = [...new Set([...list(`git ls-files ${glob}`), ...list(`git ls-files --others --exclude-standard ${glob}`)])]
  .filter((f) => !f.endsWith('.d.ts'))

const badTypes = []
const rawStreams = []
const newBuses = []

for (const f of all) {
  let src
  try { src = readFileSync(atRoot(f), 'utf8') } catch { continue }
  const isTest = /\.vitest\.test\.ts$/.test(f)
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      // 1. publish of an undeclared type
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null

      if (name && PUBLISHERS.has(name) && !isTest) {
        // Unwrap `as X`, `satisfies X` and parentheses. Without this, a type
        // string carrying any cast — `'foo' as never` — is not a
        // StringLiteral node and slips through unchecked. That is a FALSE
        // NEGATIVE, and it was in this guard's first draft: the mutation test
        // that should have caught an undeclared type reported nothing at all.
        let arg = node.arguments[PUBLISHERS.get(name)]
        while (
          arg &&
          (ts.isAsExpression(arg) || ts.isSatisfiesExpression(arg) || ts.isParenthesizedExpression(arg) ||
           ts.isTypeAssertionExpression?.(arg))
        ) {
          arg = arg.expression
        }
        // Only a string literal can be checked statically. A variable is
        // validated at runtime by the catalogue — flagging it here would be a
        // false positive, and a false positive makes people change correct code.
        if (arg && ts.isStringLiteralLike(arg) && !declared.has(arg.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(arg.getStart(sf))
          badTypes.push(`${f}:${line + 1}  ${name}('${arg.text}') — not in the catalogue`)
        }
      }

      // 2. raw stream command outside the driver
      if (
        ts.isPropertyAccessExpression(callee) &&
        STREAM_COMMANDS.has(callee.name.text) &&
        f !== DRIVER && !isTest
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        rawStreams.push(`${f}:${line + 1}  .${callee.name.text}(…) outside the driver`)
      }
    }

    // 3. a new in-process bus: `const listeners = new Set<…>()` at module scope
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === 'listeners' &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.expression.getText(sf) === 'Set' &&
      !BUS_BASELINE.has(f) && !isTest
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      newBuses.push(`${f}:${line + 1}  new in-process event bus`)
    }

    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (badTypes.length) {
  fail(badTypes, `Declare the event in ${catalogPath}, or fix the type string. Publishing an undeclared event throws at runtime, inside the mutation that raised it.`)
}
if (rawStreams.length) {
  fail(rawStreams, `Redis stream commands belong in ${DRIVER}. Anywhere else and the envelope format, sharding and trim policy exist twice.`)
}
if (newBuses.length) {
  fail(newBuses, `A new in-process bus is invisible to every other replica — the exact defect EV.1 exists to remove. Publish through lib/events instead (publishEvent for facts, publishEphemeral for refresh hints).`)
}

console.log(
  `✓ event contract: ${declared.size} declared events, no undeclared publishes, ` +
  `no raw stream commands outside the driver, no new in-process buses (${all.length} files scanned)`,
)
