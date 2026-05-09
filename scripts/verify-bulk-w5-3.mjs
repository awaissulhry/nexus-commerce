#!/usr/bin/env node
// Verify W5.3 — Template library UI in BulkOperationModal.
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

console.log('\nW5.3 — Template library UI\n')

const lib = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/components/TemplateLibrary.tsx'),
  'utf8',
)
const modal = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationModal.tsx'),
  'utf8',
)

console.log('Case 1: TemplateLibrary component')
check('exports TemplateLibrary', /export function TemplateLibrary/.test(lib))
check('exports ServerTemplate type', /export interface ServerTemplate/.test(lib))
check('exports ParameterDecl type', /export interface ParameterDecl/.test(lib))

console.log('\nCase 2: library fetches via /api/bulk-action-templates')
check('GET endpoint',
  /\/api\/bulk-action-templates['`]/.test(lib))
check('DELETE endpoint',
  /method:\s*'DELETE'/.test(lib) &&
    /\/api\/bulk-action-templates\//.test(lib))
check('duplicate endpoint',
  /\/api\/bulk-action-templates\/\$\{[^}]*\.id\}\/duplicate/.test(lib))

console.log('\nCase 3: browse + save tabs')
check('Browse tab', /Browse \(\{templates\.length\}\)/.test(lib))
check('Save tab', /Save current/.test(lib))
check('save tab disabled when no draft',
  /disabled=\{!currentDraft\}/.test(lib))

console.log('\nCase 4: search + categories')
check('search input',
  /placeholder="Search templates…"/.test(lib))
check('grouped by category', /grouped\s*=\s*useMemo/.test(lib))
check('CATEGORY_LABELS map',
  /CATEGORY_LABELS:\s*Record<string, string>/.test(lib))

console.log('\nCase 5: template row affordances')
check('Duplicate button', /title="Duplicate"/.test(lib))
check('Delete button (only for non-builtin)',
  /\{!t\.isBuiltin && \(/.test(lib))
check('Built-in icon (BookMarked)',
  /<BookMarked/.test(lib))

console.log('\nCase 6: BulkOperationModal wires the library')
check('imports TemplateLibrary + ServerTemplate type',
  /import\s*\{[\s\S]{0,80}TemplateLibrary,[\s\S]{0,80}ServerTemplate[\s\S]{0,80}\}\s*from\s*'\.\/components\/TemplateLibrary'/.test(modal))
check('templateLibraryOpen state',
  /const \[templateLibraryOpen, setTemplateLibraryOpen\]/.test(modal))
check('appliedTemplateId state',
  /const \[appliedTemplateId, setAppliedTemplateId\]/.test(modal))
check('Templates trigger button',
  /Templates[\s\S]{0,80}<\/button>/.test(modal) &&
    /setTemplateLibraryOpen\(true\)/.test(modal))
check('renders TemplateLibrary',
  /<TemplateLibrary[\s\S]{0,800}onSelect/.test(modal))
check('onSelect fills opType + payload',
  /setOpType\(template\.actionType[\s\S]{0,80}setPayload\(template\.actionPayload/.test(modal))
check('appliedTemplateId set on select',
  /setAppliedTemplateId\(template\.id\)/.test(modal))
check('header badge shows when from-template',
  /from template/.test(modal))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
