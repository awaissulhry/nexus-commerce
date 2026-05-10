#!/usr/bin/env node
// Verify W14.1 — i18n catalog for the W9-W13 bulk surfaces.
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

console.log('\nW14.1 — i18n catalog\n')

const en = JSON.parse(
  fs.readFileSync(path.join(repo, 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'),
)
const it = JSON.parse(
  fs.readFileSync(path.join(repo, 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'),
)

const REQUIRED_KEYS = [
  // Nav
  'bulkOps.nav.imports',
  'bulkOps.nav.exports',
  'bulkOps.nav.automation',
  'bulkOps.nav.schedules',
  'bulkOps.nav.history',
  // Exports wizard
  'bulkOps.exports.title',
  'bulkOps.exports.description',
  'bulkOps.exports.newExport',
  'bulkOps.exports.format',
  'bulkOps.exports.name',
  'bulkOps.exports.filters',
  'bulkOps.exports.columns',
  'bulkOps.exports.run',
  'bulkOps.exports.recent',
  'bulkOps.exports.empty',
  'bulkOps.exports.deletePrompt',
  'bulkOps.exports.deleteDescription',
  // Active jobs strip
  'bulkOps.activeJobs.label',
  'bulkOps.activeJobs.viewAll',
  'bulkOps.activeJobs.cancel',
  'bulkOps.activeJobs.cancelling',
  'bulkOps.activeJobs.eta.short',
  'bulkOps.activeJobs.failedSuffix',
  // Cancel confirm dialog
  'bulkOps.cancel.confirmInflight',
  'bulkOps.cancel.confirmQueued',
  'bulkOps.cancel.keepRunning',
  'bulkOps.cancel.keepQueued',
  // History + diff drawer
  'bulkOps.history.duration',
  'bulkOps.history.viewItem',
  'bulkOps.history.diff.title',
  'bulkOps.history.diff.before',
  'bulkOps.history.diff.after',
  'bulkOps.history.diff.status',
  'bulkOps.history.diff.duration',
  'bulkOps.history.diff.target',
  'bulkOps.history.diff.error',
  // AI verbs + cost preview
  'bulkOps.ai.translate.label',
  'bulkOps.ai.seo.label',
  'bulkOps.ai.altText.label',
  'bulkOps.ai.cost.estimateLabel',
  // Queue stats
  'bulkOps.queue.statsTitle',
  'bulkOps.queue.workersDisabled',
  'bulkOps.queue.workersEnabled',
  'bulkOps.queue.waiting',
  'bulkOps.queue.active',
  'bulkOps.queue.completed',
  'bulkOps.queue.failed',
  'bulkOps.queue.delayed',
]

console.log('Case 1: every required key present in both catalogs')
for (const k of REQUIRED_KEYS) {
  check(`en[${k}]`, typeof en[k] === 'string' && en[k].length > 0)
  check(`it[${k}]`, typeof it[k] === 'string' && it[k].length > 0)
}

console.log('\nCase 2: placeholders preserved in translation')
const PLACEHOLDER_KEYS = [
  'bulkOps.exports.deletePrompt', // {name}
  'bulkOps.activeJobs.eta.short', // {value}{unit}
  'bulkOps.activeJobs.failedSuffix', // {count}
  'bulkOps.cancel.confirmInflight', // {processed}, {total}
  'bulkOps.history.diff.title', // {sku}
  'bulkOps.ai.cost.estimateLabel', // {cost}, {productCount}
  'bulkOps.queue.workersEnabled', // {threshold}
]
for (const k of PLACEHOLDER_KEYS) {
  const enPh = (en[k]?.match(/\{[^}]+\}/g) ?? []).sort().join(',')
  const itPh = (it[k]?.match(/\{[^}]+\}/g) ?? []).sort().join(',')
  check(`${k} placeholders match en=[${enPh}] it=[${itPh}]`, enPh === itPh && enPh !== '')
}

console.log('\nCase 3: catalogs parse as valid JSON')
check('en.json valid', typeof en === 'object' && en !== null)
check('it.json valid', typeof it === 'object' && it !== null)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
