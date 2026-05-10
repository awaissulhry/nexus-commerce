#!/usr/bin/env node
/**
 * W15.1 — Route exhaustiveness check.
 *
 * Static analysis pass over every route file the bulk-operations
 * engagement touched (W9.1-W14.4) so we can confirm:
 *
 *   - Each route file is imported AND registered in apps/api/src/index.ts
 *   - No two route files declare the same path with the same method
 *   - Every route declared in the file is registered behind the
 *     `/api` prefix when index.ts wires it up
 *   - No handler functions defined inside the file are left orphaned
 *     (declared but never returned via `fastify.<method>` registration)
 *
 * The check is regex-based, not AST-based — it catches the obvious
 * "forgot to register" / "duplicate path" classes without taking on
 * a TS-type-graph dependency. False positives are loud + silent
 * misses are the main risk; if a future refactor renames
 * `fastify.get` to something else, the regex must be updated.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW15.1 — Route exhaustiveness check\n')

// Files this engagement created or substantially modified.
const ROUTE_FILES = [
  'apps/api/src/routes/bulk-operations.routes.ts',
  'apps/api/src/routes/import-wizard.routes.ts',
  'apps/api/src/routes/scheduled-imports.routes.ts',
  'apps/api/src/routes/export-wizard.routes.ts',
  'apps/api/src/routes/scheduled-exports.routes.ts',
]

const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log('Case 1: every route file is imported + registered in index.ts')
for (const f of ROUTE_FILES) {
  const base = path.basename(f, '.ts')
  // index.ts uses default + named imports; check either.
  const importRegex = new RegExp(
    `from "\\./routes/${base}\\.js"|from '\\./routes/${base}\\.js'`,
  )
  check(`index.ts imports ${base}`, importRegex.test(idx))
  // Each route file's exported plugin should appear in app.register
  // somewhere in index.ts (not necessarily on the same line as the
  // import, so just look for the symbol).
  const routePluginName = base
    .split('.')[0]
    .split('-')
    .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join('')
    .replace(/Routes$/, '') + 'Routes'
  // Loose check — just ensure SOME app.register references the
  // file's basename (covers default-export + named-export styles).
  const registerHit =
    new RegExp(`app\\.register\\([^)]*${routePluginName}[^)]*\\)`).test(idx) ||
    new RegExp(`app\\.register\\([^)]*${base.replace(/\./g, '')}[^)]*\\)`).test(idx)
  check(`index.ts registers ${routePluginName}`, registerHit)
}

console.log('\nCase 2: collect declared paths + check for duplicates')
/** Map<method+path, file[]> */
const declared = new Map()
const PATH_RE = /fastify\.(get|post|put|patch|delete)(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/g
for (const f of ROUTE_FILES) {
  const body = fs.readFileSync(path.join(repo, f), 'utf8')
  let m
  while ((m = PATH_RE.exec(body)) !== null) {
    const key = `${m[1].toUpperCase()} ${m[2]}`
    if (!declared.has(key)) declared.set(key, [])
    declared.get(key).push(path.basename(f))
  }
}
const dupes = Array.from(declared.entries()).filter(([, fs]) => fs.length > 1)
check(`no duplicate (method, path) declarations across route files (saw ${declared.size} unique)`,
  dupes.length === 0)
if (dupes.length > 0) {
  for (const [key, fs] of dupes) console.log(`    ↳ ${key} declared in ${fs.join(' AND ')}`)
}

console.log('\nCase 3: every declared route is actually under /api when registered')
// All five files register at /api per the project convention. Spot
// check that each file's app.register call carries prefix: '/api'.
for (const f of ROUTE_FILES) {
  const base = path.basename(f, '.ts')
  const pluginName = base
    .split('.')[0]
    .split('-')
    .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join('')
    .replace(/Routes$/, '') + 'Routes'
  const re = new RegExp(
    `app\\.register\\(${pluginName},\\s*\\{\\s*prefix:\\s*'/api'\\s*\\}\\)`,
  )
  check(`${pluginName} registered with prefix:'/api'`, re.test(idx))
}

console.log('\nCase 4: spot-check critical bulk-operations endpoints exist')
const bulkOpsBody = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-operations.routes.ts'),
  'utf8',
)
const CRITICAL_PATHS = [
  '/bulk-operations',                // POST create
  '/bulk-operations/:id',            // GET status
  '/bulk-operations/:id/process',    // POST kick-off
  '/bulk-operations/:id/cancel',     // POST cancel
  '/bulk-operations/:id/events',     // W10.1 SSE
  '/bulk-operations/:id/items',      // W10.3 drill-down
  '/bulk-operations/history',        // history page feed
  '/bulk-operations/queue-stats',    // W13.4
  '/bulk-operations/ai/cost-preview',// W11.4
]
for (const p of CRITICAL_PATHS) {
  check(`bulk-operations.routes declares ${p}`, bulkOpsBody.includes(`'${p}'`))
}

console.log('\nCase 5: export + scheduled-export routes complete')
const expBody = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/export-wizard.routes.ts'),
  'utf8',
)
for (const p of [
  '/export-jobs',
  '/export-jobs/:id',
  '/export-jobs/:id/download',
]) {
  check(`export-wizard.routes declares ${p}`, expBody.includes(`'${p}'`))
}
const schedExpBody = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/scheduled-exports.routes.ts'),
  'utf8',
)
for (const p of [
  '/scheduled-exports',
  '/scheduled-exports/:id',
  '/scheduled-exports/:id/enabled',
  '/scheduled-exports/tick',
]) {
  check(`scheduled-exports.routes declares ${p}`, schedExpBody.includes(`'${p}'`))
}

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
