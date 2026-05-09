#!/usr/bin/env node
// Verify W7.4 — bulk-automation-rules CRUD + dry-run routes,
// evaluator wired through tree DSL.
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

console.log('\nW7.4 — bulk-automation-rules routes + evaluator wiring\n')

const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-automation-rules.routes.ts'),
  'utf8',
)
const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/automation-rule.service.ts'),
  'utf8',
)
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log('Case 1: every CRUD endpoint registered')
check('GET /bulk-automation-rules',
  /'\/bulk-automation-rules'/.test(routes))
check('GET /bulk-automation-rules/:id',
  /'\/bulk-automation-rules\/:id'/.test(routes))
check('POST /bulk-automation-rules',
  /fastify\.post<\{ Body: CreateBody \}>\(\s*'\/bulk-automation-rules'/.test(routes))
check('PATCH /bulk-automation-rules/:id',
  /fastify\.patch<[\s\S]*?>\(\s*'\/bulk-automation-rules\/:id'/.test(routes))
check('DELETE /bulk-automation-rules/:id',
  /fastify\.delete<[\s\S]*?>\(\s*'\/bulk-automation-rules\/:id'/.test(routes))
check('POST /:id/dry-run (W7.6)',
  /'\/bulk-automation-rules\/:id\/dry-run'/.test(routes))
check('POST /dry-run-inline (visual-builder preview)',
  /'\/bulk-automation-rules\/dry-run-inline'/.test(routes))

console.log('\nCase 2: domain scoping')
check("DOMAIN constant = 'bulk-operations'",
  /const DOMAIN = 'bulk-operations'/.test(routes))
check('list filters by domain',
  /where: any = \{ domain: DOMAIN \}/.test(routes))
check('get rejects rules from other domains',
  /rule\.domain !== DOMAIN/.test(routes))

console.log('\nCase 3: validation at the boundary')
check('trigger validated against BULK_OPS_TRIGGERS',
  /TRIGGER_SET\.has\(body\.trigger\)/.test(routes))
check('conditions validated by validateConditions()',
  /validateConditions\([\s\S]{0,80}body\.conditions/.test(routes))
check('actions validated against bulk-ops + base set',
  /validateActions/.test(routes) &&
    /'notify' \|\| type === 'log_only'/.test(routes) &&
    /ACTION_SET\.has\(type\)/.test(routes))

console.log('\nCase 4: defensive defaults on create')
check('rules default to enabled=false',
  /enabled: body\.enabled \?\? false/.test(routes))
check('rules default to dryRun=true',
  /dryRun: body\.dryRun \?\? true/.test(routes))
check('default daily cap of 100',
  /maxExecutionsPerDay\s*\?\?\s*100/.test(routes))

console.log('\nCase 5: evaluateRule swapped to tree evaluator')
check('imports evaluateConditions from conditions-tree',
  /\.\/automation\/conditions-tree/.test(svc))
check('evaluateRule uses evaluateConditions',
  /matched = evaluateConditions\(/.test(svc))

console.log('\nCase 6: index.ts wires the routes')
check('imports bulkAutomationRulesRoutes',
  /import bulkAutomationRulesRoutes/.test(idx))
check('registered with /api prefix',
  /app\.register\(bulkAutomationRulesRoutes,\s*\{\s*prefix:\s*'\/api'\s*\}\)/.test(idx))

console.log('\nCase 7: dry-run-inline returns matched + actionsPreview')
check('dry-run-inline returns matched + actionsPreview',
  /actionsPreview: matched/.test(routes))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
