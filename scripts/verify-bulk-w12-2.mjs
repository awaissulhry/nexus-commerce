#!/usr/bin/env node
// Verify W12.2 — Shopify bulkOperationRunMutation wrapper.
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

console.log('\nW12.2 — Shopify bulk mutation\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/channel-batch/shopify-bulk-mutation.service.ts'),
  'utf8',
)

console.log('Case 1: GraphQL operations defined')
check('STAGED_UPLOADS_CREATE mutation literal',
  /stagedUploadsCreate\(\$input: \[StagedUploadInput!\]!\)/.test(svc) &&
  /stagedTargets/.test(svc))
check('BULK_OPERATION_RUN_MUTATION mutation literal',
  /bulkOperationRunMutation\(mutation: \$mutation, stagedUploadPath: \$stagedUploadPath\)/.test(svc))
check('CURRENT_BULK_OPERATION query literal',
  /currentBulkOperation\(type: MUTATION\)/.test(svc))

console.log('\nCase 2: pipeline')
check('submitShopifyBulkMutation exported',
  /export async function submitShopifyBulkMutation/.test(svc))
check('rejects empty mutation',
  /mutation required/.test(svc))
check('rejects empty operations',
  /operations must be non-empty/.test(svc))
check('packs JSONL one-per-line',
  /map\(\(o\) => JSON\.stringify\(o\)\)\.join\('\\n'\)/.test(svc))
check('multipart/form-data upload to staged URL',
  /new FormData\(\)/.test(svc) &&
  /target\.parameters/.test(svc) &&
  /form\.append\('file'/.test(svc))
check('runs bulk mutation with stagedUploadPath',
  /stagedUploadPath: target\.resourceUrl/.test(svc))
check('throws on userErrors at each step',
  /stagedUploadsCreate userErrors/.test(svc) &&
  /bulkOperationRunMutation userErrors/.test(svc))

console.log('\nCase 3: poller')
check('pollShopifyBulkStatus exported',
  /export async function pollShopifyBulkStatus/.test(svc))
check('returns ShopifyBulkPollResult shape',
  /id:[\s\S]{0,400}status:[\s\S]{0,400}errorCode:[\s\S]{0,400}url:[\s\S]{0,400}objectCount:/.test(svc))
check('throws when no current op',
  /no current bulk operation in flight/.test(svc))

console.log('\nCase 4: dry-run path')
check('NEXUS_SHOPIFY_BULK_DRYRUN gates submission',
  /NEXUS_SHOPIFY_BULK_DRYRUN/.test(svc))
check('dry-run returns synthesized id',
  /dryRun: true/.test(svc) &&
  /gid:\/\/shopify\/BulkOperation\/dryrun-/.test(svc))

console.log('\nCase 5: env resolution')
check('SHOPIFY_SHOP_NAME defaulted from env',
  /process\.env\.SHOPIFY_SHOP_NAME/.test(svc))
check('SHOPIFY_ACCESS_TOKEN defaulted from env',
  /process\.env\.SHOPIFY_ACCESS_TOKEN/.test(svc))
check('rejects missing shop / token',
  /SHOPIFY_SHOP_NAME required/.test(svc) &&
  /SHOPIFY_ACCESS_TOKEN required/.test(svc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
