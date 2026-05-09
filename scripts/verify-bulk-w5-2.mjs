#!/usr/bin/env node
// Verify W5.2 — bulk-action-template routes (source-level).
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

console.log('\nW5.2 — bulk-action-template routes\n')

const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-action-templates.routes.ts'),
  'utf8',
)
const index = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log('Case 1: every CRUD endpoint registered')
check('GET /bulk-action-templates',
  /fastify\.get<[\s\S]*?>\([\s\S]*?'\/bulk-action-templates'/.test(routes))
check('GET /bulk-action-templates/:id',
  /fastify\.get<[\s\S]*?>\([\s\S]*?'\/bulk-action-templates\/:id'/.test(routes))
check('POST /bulk-action-templates',
  /fastify\.post<[\s\S]*?>\([\s\S]*?'\/bulk-action-templates'/.test(routes))
check('PATCH /bulk-action-templates/:id',
  /fastify\.patch<[\s\S]*?>\([\s\S]*?'\/bulk-action-templates\/:id'/.test(routes))
check('DELETE /bulk-action-templates/:id',
  /fastify\.delete<[\s\S]*?>\([\s\S]*?'\/bulk-action-templates\/:id'/.test(routes))
check('POST /bulk-action-templates/:id/duplicate',
  /'\/bulk-action-templates\/:id\/duplicate'/.test(routes))
check('POST /bulk-action-templates/:id/apply',
  /'\/bulk-action-templates\/:id\/apply'/.test(routes))

console.log('\nCase 2: registered in index.ts')
check('imports bulkActionTemplateRoutes',
  /import bulkActionTemplateRoutes/.test(index))
check('registered with /api prefix',
  /app\.register\(bulkActionTemplateRoutes,\s*\{\s*prefix:\s*'\/api'\s*\}\)/.test(index))

console.log('\nCase 3: error-code translations')
check('400 for missing required parameter',
  /Required parameter missing[\s\S]{0,200}code\(400\)/.test(routes))
check('400 for unknown actionType',
  /not in KNOWN_BULK_ACTION_TYPES[\s\S]{0,200}code\(400\)/.test(routes))
check('404 for missing template on PATCH',
  /Template not found[\s\S]{0,200}code\(404\)/.test(routes))
check('409 for editing a builtin',
  /Cannot update a built-in[\s\S]{0,200}code\(409\)/.test(routes))
check('409 for deleting a builtin',
  /Cannot delete a built-in[\s\S]{0,200}code\(409\)/.test(routes))

console.log('\nCase 4: apply path uses BulkActionService.createJob')
check('apply runs applyParameters',
  /templateService\.applyParameters\(\s*template,\s*body\.params/.test(routes))
check('apply hands result to bulkActionService.createJob',
  /bulkActionService\.createJob\(\{[\s\S]{0,500}actionType:\s*template\.actionType/.test(routes))
check('apply records usage telemetry (best-effort)',
  /void templateService\.recordUsage\(id\)/.test(routes))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
