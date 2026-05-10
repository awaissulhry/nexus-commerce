#!/usr/bin/env node
// Verify W9.2 — XLSX + PDF renderers + routes.
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

console.log('\nW9.2 — XLSX + PDF renderers + routes\n')

const r = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/export/renderers.ts'),
  'utf8',
)
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/export-wizard.routes.ts'),
  'utf8',
)
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log('Case 1: render dispatcher covers every format')
for (const fmt of ['csv','json','xlsx','pdf']) {
  check(`renderExport handles '${fmt}'`,
    new RegExp(`format === '${fmt}'`).test(r))
}

console.log('\nCase 2: XLSX renderer')
check('uses exceljs',
  /\(await import\('exceljs'\)\)\.default/.test(r))
check('sheet name sanitised + capped at 31',
  /slice\(0, 31\)[\s\S]{0,200}\[\\\[\\\]:\*\?\/\\\\\]/.test(r))
check('header row bolded',
  /getRow\(1\)\.font = \{ bold: true \}/.test(r))
check('column widths sized to header label',
  /col\.width = Math\.max\(c\.label\.length \+ 2, 10\)/.test(r))
check('returns spreadsheet content-type',
  /vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/.test(r))

console.log('\nCase 3: PDF renderer')
check('uses pdfkit (default-import compat)',
  /import\('pdfkit'\)/.test(r))
check('A4 landscape',
  /size: 'A4', margin: 36, layout: 'landscape'/.test(r))
check('drawHeader on every page break',
  /drawHeader\(doc\.y\)/.test(r) &&
    /addPage\(\)[\s\S]{0,80}drawHeader/.test(r))
check('text() ellipsis: true for column overflow',
  /ellipsis: true/.test(r))
check('title block + row count + date',
  /\$\{input\.rows\.length\} rows · \$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}/.test(r))
check('returns application/pdf',
  /contentType: 'application\/pdf'/.test(r))

console.log('\nCase 4: routes registered')
for (const ep of [
  '/export-jobs',
  '/export-jobs/:id',
  '/export-jobs/:id/download',
]) {
  check(`route ${ep}`, routes.includes(`'${ep}'`))
}
check('download attaches Content-Disposition with filename',
  /Content-Disposition[\s\S]{0,80}attachment; filename="\$\{out\.filename\}"/.test(routes))
check('download sets Content-Type from job',
  /Content-Type[\s\S]{0,40}out\.contentType/.test(routes))
check('400 for invalid format / empty columns',
  /Unknown format/.test(routes) &&
  /columns is required/.test(routes) &&
  /\b400\b/.test(routes))

console.log('\nCase 5: index wires the routes')
check('imports exportWizardRoutes',
  /import exportWizardRoutes/.test(idx))
check('registered with /api prefix',
  /app\.register\(exportWizardRoutes,\s*\{\s*prefix:\s*'\/api'\s*\}\)/.test(idx))

console.log('\nCase 6: dynamic imports avoid loader weight')
check('exceljs lazy-imported (not at module top)',
  !/^import ExcelJS/m.test(r))
check('pdfkit lazy-imported',
  !/^import PDFKit/m.test(r))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
