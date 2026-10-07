#!/usr/bin/env node
/**
 * 5b (Ads rules & automation review 7.1) — every negative Nexus adds goes through the one negative write service.
 *
 * WHY
 * Protected terms, Amazon's text limits, the duplicate check and the live-write allowlist each bound only the callers
 * that remembered them. Launches, bulk negatives, the bulk sheet, blueprints, AI goals and the launch repair called the
 * Amazon client or wrote the local row themselves, so a protected term could be negated, a retired negative could
 * never come back, and a refused negative still left a local row that no auction honoured.
 * `apps/api/src/services/advertising/ads-negative-kw.service.ts` now runs validate → dedupe → policy → gate → Amazon →
 * local row + audit for all of them. A new path that skips it is invisible in review: it looks like the old ones.
 *
 * THE RULE (baseline 0 — fix the code, never add an allowance)
 * Outside the service, the Amazon client, the negation policy, the syncs and tests, apps/api/src may not:
 *   1. call the client's negative creators `createNegativeKeyword(` / `createNegativeProductTarget(` (W4-11: and the
 *      Sponsored Brands / Display ones, `createSbNegativeKeyword(` / `createSdNegativeTarget(`);
 *   2. name a negative create endpoint — '/sp/negativeKeywords', '/sp/campaignNegativeKeywords', '/sp/negativeTargets',
 *      '/sb/negativeKeywords', '/sd/negativeTargets' (their /list and /delete are other strings) — unless the line says
 *      `// negative-write-exempt: <reason>`;
 *   3. call `adTarget.create` / `createMany` / `upsert` with `isNegative: true` in its argument
 *      (use mirrorNegativeRow / mirrorNegativeKeyword from the service).
 *
 *   node scripts/check-negative-write-path.mjs [--check]
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = 'apps/api/src/'
const ALLOWED = new Set([
  'apps/api/src/services/advertising/ads-negative-kw.service.ts', // the service
  'apps/api/src/services/advertising/ads-api-client.ts', // the client (creators, update and delete paths)
  'apps/api/src/services/advertising/ads-negation-policy.ts', // the wire check names the endpoints it judges
  'apps/api/src/services/advertising/ads-v1-sync.service.ts', // the syncs mirror what Amazon already holds
  'apps/api/src/services/advertising/ads-keyword-list-sync.service.ts',
])
const CREATORS = new Set(['createNegativeKeyword', 'createNegativeProductTarget', 'createSbNegativeKeyword', 'createSdNegativeTarget'])
const ENDPOINTS = new Set(['/sp/negativeKeywords', '/sp/campaignNegativeKeywords', '/sp/negativeTargets', '/sb/negativeKeywords', '/sd/negativeTargets'])
const ROW_WRITES = new Set(['create', 'createMany', 'upsert'])
const EXEMPT = 'negative-write-exempt:'

const list = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] }
}
const files = [...new Set([
  ...list(`git ls-files "${SRC}"`),
  ...list(`git ls-files --others --exclude-standard "${SRC}"`),
])].filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f) && !f.includes('/test-support/') && !f.includes('/__tests__/') && !ALLOWED.has(f))

/** Does this node's subtree hold a property `isNegative: true`? */
function holdsIsNegativeTrue(node) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (ts.isPropertyAssignment(n) && n.name.getText() === 'isNegative' && n.initializer.kind === ts.SyntaxKind.TrueKeyword) { found = true; return }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

const offenders = []
let scanned = 0
for (const rel of files) {
  let src
  try { src = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
  scanned++
  if (!/createNegative(Keyword|ProductTarget)\(|\/sp\/(negativeKeywords|campaignNegativeKeywords|negativeTargets)['"`]|isNegative:\s*true/.test(src)) continue
  const lines = src.split('\n')
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null
      if (name && CREATORS.has(name)) offenders.push(`${rel}:${at(node) + 1}  calls the client's ${name}() — use writeNegativeKeyword / writeNegativeProductTarget`)
      if (name && ROW_WRITES.has(name) && ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression)
          && callee.expression.name.text === 'adTarget' && node.arguments.some(holdsIsNegativeTrue)) {
        offenders.push(`${rel}:${at(node) + 1}  writes a negative AdTarget row itself (adTarget.${name} with isNegative: true) — use mirrorNegativeRow`)
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ENDPOINTS.has(node.text)) {
      const line = at(node)
      if (!lines[line]?.includes(EXEMPT) && !lines[line - 1]?.includes(EXEMPT)) {
        offenders.push(`${rel}:${line + 1}  names the negative endpoint '${node.text}' — negatives are created by the negative write service`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (offenders.length) {
  console.error(`\n❌ negative write path: ${offenders.length} negative write(s) outside the negative write service (baseline 0):\n`)
  for (const o of offenders) console.error(`   ${o}`)
  console.error(
    `\n   Every negative goes through apps/api/src/services/advertising/ads-negative-kw.service.ts, so protected terms,\n` +
      `   Amazon's text limits, the duplicate check and the live-write allowlist bind it, and a refused one leaves no row.\n` +
      `   A genuine exception (a probe that creates nothing) carries // ${EXEMPT} <reason> on the line.\n`,
  )
  process.exit(1)
}
console.log(`✓ negative write path: every negative goes through the negative write service (${scanned} files scanned)`)
