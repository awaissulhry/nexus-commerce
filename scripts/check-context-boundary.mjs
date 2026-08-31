#!/usr/bin/env node
/**
 * PH.4b — bounded-context boundaries, enforced in code.
 *
 * WHY
 * The architecture decision was ONE database with per-context boundaries
 * enforced in code, rather than DB-per-service across 412 models. That only
 * means anything if something checks it. Without a check, "boundary" is a
 * comment.
 *
 * Advertising first, because it is measurably the cleanest seam: 251 files
 * touch 80 models that NOTHING outside advertising touches. Those 80 are the
 * context's private storage. The other 51 models it uses are genuinely shared
 * (`product` alone is read by 202 files outside advertising) and are NOT
 * claimed here — pretending otherwise would flag correct code, and a false
 * positive makes people change things that were right.
 *
 * THE RULE
 * A file outside the advertising context may not touch an advertising-OWNED
 * model. When advertising becomes its own service those 80 tables move with
 * it, and anything still reaching into them from outside becomes a
 * cross-service database read — the exact coupling that makes extraction
 * impossible.
 *
 * 🔴 THE OWNED SET IS FROZEN IN THE BASELINE, NOT RECOMPUTED.
 * Deriving "owned = touched only by advertising" at runtime would be
 * self-defeating: adding the first outside caller would reclassify the model
 * as shared and the guard would report success. The list only changes when
 * someone runs --baseline deliberately.
 *
 *   node scripts/check-context-boundary.mjs            # census
 *   node scripts/check-context-boundary.mjs --check    # exit 1 on a violation
 *   node scripts/check-context-boundary.mjs --baseline
 */
import ts from 'typescript'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts/context-boundary-baseline.json')

/** The advertising context: the files that will move together. */
const ADVERTISING = [
  /^apps\/api\/src\/services\/advertising\//,
  /^apps\/api\/src\/services\/ads-core\//,
  /^apps\/api\/src\/services\/marketing\//,
  /^apps\/api\/src\/routes\/advertising.*\.ts$/,
  /^apps\/api\/src\/routes\/ebay-ads\.routes\.ts$/,
  /^apps\/api\/src\/jobs\/ad-.*\.ts$/,
  /^apps\/api\/src\/jobs\/ads-.*\.ts$/,
  /^apps\/api\/src\/workers\/ads-sync\.worker\.ts$/,
]
const EXEMPT = [/\.test\.ts$/, /\.vitest\.test\.ts$/, /__tests__\//, /^apps\/api\/src\/scripts\//]
/**
 * Which identifiers in THIS file are actually the database client.
 *
 * `prisma` and `tx` are the conventions (an import and a $transaction callback
 * parameter). `db` is NOT assumed: it is a common local variable name — in
 * advertising.routes.ts alone, `const db = campaign.dynamicBidding ?? {}`
 * produced 26 false hits, which inflated the baseline and would have failed a
 * push for naming a local variable. It counts only when the file really
 * imports the client under that name.
 *
 * A false positive here is worse than a miss: it makes someone change correct
 * code to satisfy a guard that was wrong.
 */
function clientNames(sf) {
  const names = new Set(['prisma', 'tx'])
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteralLike(st.moduleSpecifier) &&
      /(^|\/)db\.(js|ts)$/.test(st.moduleSpecifier.text) &&
      st.importClause?.name
    ) {
      names.add(st.importClause.name.text)
    }
  }
  return names
}
const NOT_MODELS = new Set([
  '$transaction', '$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe',
  '$connect', '$disconnect', '$on', '$extends', '$use',
])

const isAds = (f) => ADVERTISING.some((re) => re.test(f))

function sourceFiles() {
  const list = (cmd) => {
    try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] }
  }
  const dir = 'apps/api/src/'
  return [...new Set([...list(`git ls-files "${dir}"`), ...list(`git ls-files --others --exclude-standard "${dir}"`)])]
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !EXEMPT.some((re) => re.test(f)))
}

/** model name -> Set of files that touch it */
function modelUsage() {
  const byModel = new Map()
  for (const rel of sourceFiles()) {
    let src
    try { src = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
    if (!/\b(prisma|tx|db)\./.test(src)) continue
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const CLIENTS = clientNames(sf)
    const visit = (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && CLIENTS.has(n.expression.text)) {
        const m = n.name.text
        if (/^[a-z]/.test(m) && !NOT_MODELS.has(m)) {
          if (!byModel.has(m)) byModel.set(m, new Set())
          byModel.get(m).add(rel)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return byModel
}

/**
 * Every Prisma model name, from the schema.
 *
 * Guards against the bug this check shipped with: property access on a local
 * variable was registered as a model, so ten invented names ('bidAutomation',
 * 'targetAcos', …) sat in the owned set — the guard was "protecting" fields of
 * a JSON blob. Anything not in the schema is not a model, and saying so here
 * makes that unrepeatable rather than merely fixed.
 */
function prismaModels() {
  const schema = readFileSync(join(ROOT, 'packages/database/prisma/schema.prisma'), 'utf8')
  return new Set(
    [...schema.matchAll(/^model (\w+)/gm)].map((m) => m[1][0].toLowerCase() + m[1].slice(1)),
  )
}

const MODELS = prismaModels()
const usage = modelUsage()
const mode = process.argv[2] ?? '--census'

if (mode === '--baseline') {
  const owned = []
  const shared = []
  for (const [model, files] of usage) {
    if (!MODELS.has(model)) continue // not a Prisma model — a local, not a table
    const inside = [...files].some(isAds)
    const outside = [...files].some((f) => !isAds(f))
    if (inside && !outside) owned.push(model)
    else if (inside && outside) shared.push(model)
  }
  owned.sort(); shared.sort()
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: 'Models owned privately by the advertising context. FROZEN — regenerating this from current usage would let the first violation reclassify a model as shared and pass. Only widen it deliberately.',
        updatedAt: new Date().toISOString().slice(0, 10),
        context: 'advertising',
        ownedCount: owned.length,
        owned,
        sharedNote: 'Touched by advertising AND other contexts. NOT owned, NOT guarded — flagging these would flag correct code.',
        shared,
      },
      null, 2,
    ) + '\n',
  )
  console.log(`baseline written: advertising owns ${owned.length} model(s); ${shared.length} shared with other contexts`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error(`\n❌ context boundary: no baseline at ${BASELINE}\n\n   Run: node scripts/check-context-boundary.mjs --baseline\n`)
  process.exit(1)
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const owned = new Set(base.owned)

// A baseline entry that is not a real model means the collector mis-parsed
// something. Fail loudly rather than guard a name that cannot exist.
const phantom = [...owned].filter((m) => !MODELS.has(m))
if (phantom.length) {
  console.error(`\n❌ context boundary: ${phantom.length} baseline entr(ies) are not Prisma models:\n`)
  for (const m of phantom) console.error(`   ${m}`)
  console.error(`\n   Regenerate with --baseline. A guard protecting a name with no table behind it is noise.\n`)
  process.exit(1)
}

const violations = []
for (const [model, files] of usage) {
  if (!owned.has(model)) continue
  for (const f of files) if (!isAds(f)) violations.push(`${f}  →  prisma.${model}`)
}

if (mode === '--census') {
  const adsFiles = sourceFiles().filter(isAds).length
  console.log(`advertising context: ${adsFiles} file(s), ${owned.size} privately-owned model(s), ${base.shared.length} shared`)
  console.log(violations.length ? `\n${violations.length} boundary violation(s):` : `\nno boundary violations`)
  for (const v of violations.slice(0, 20)) console.log(`  ${v}`)
  process.exit(0)
}

if (violations.length) {
  console.error(`\n❌ context boundary: ${violations.length} file(s) outside advertising touch an advertising-OWNED model:\n`)
  for (const v of violations) console.error(`   ${v}`)
  console.error(
    `\n   These ${owned.size} tables are advertising's private storage — they move with it when it becomes\n` +
      `   its own service, and a read from outside becomes a cross-service database call.\n` +
      `   Go through the advertising service's own API instead, or — if the data is genuinely shared —\n` +
      `   move the model out of \`owned\` in the baseline, deliberately.\n`,
  )
  process.exit(1)
}
console.log(`✓ context boundary: advertising's ${owned.size} owned model(s) are untouched from outside the context`)
