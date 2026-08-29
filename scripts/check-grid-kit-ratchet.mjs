#!/usr/bin/env node
/**
 * GDS §8.7 — the rebuild backlog, as a ratchet.
 *
 * The platform is being rebuilt page by page onto the DS grid (`design-system/grid`). Five older
 * grid kits and ~200 raw `<table>` files are the backlog. This counts the importers of each kit
 * and the files with a real JSX `<table`, and fails the push if ANY count goes UP — a new page
 * built on a retiring kit is the one thing the rebuild must not produce. Counts going DOWN are
 * progress; lower the baseline with --write and say so in the commit.
 *
 * Counted against the INDEX plus untracked files (a `git ls-files`-only guard is blind to what a
 * session just wrote). A "real" `<table` is one followed by a `<tbody` or `<thead` somewhere in
 * the file — six files mention `<table` in prose only and never render one.
 *
 *   node scripts/check-grid-kit-ratchet.mjs           # report
 *   node scripts/check-grid-kit-ratchet.mjs --check   # exit 1 on a rise (pre-push)
 *   node scripts/check-grid-kit-ratchet.mjs --write   # re-freeze (state WHY in the commit)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const BASELINE = 'scripts/grid-kit-baseline.json'
const ROOT = 'apps/web/src/'
const EXEMPT_TABLE_FILES = new Set([
  // not grids: key-value, form rows, print/email, the untouchable flat-file editor, two heatmap charts
  'apps/web/src/components/flat-file/FlatFileGrid.tsx',
  'apps/web/src/components/insights/charts/HeatmapGrid.tsx',
  'apps/web/src/app/dashboard/overview/_components/HeatmapPanel.tsx',
  'apps/web/src/app/marketing/reviews/heatmap/HeatmapGrid.tsx',
])

const KITS = {
  dsDataGrid: { label: 'DS DataGrid (<table>)', test: (src) => /from ['"][^'"]*design-system\/components(\/DataGrid)?['"]/.test(src) && /\bDataGrid\b/.test(src) && /<DataGrid\b/.test(src) },
  gridLens: { label: 'app/_shared/grid-lens', test: (src) => /from ['"]@\/app\/_shared\/grid-lens/.test(src) },
  adsDataGrid: { label: 'AdsDataGrid (WorkspaceGrid shim)', test: (src) => /from ['"][^'"]*_grid\/AdsDataGrid['"]/.test(src) },
  workspaceGrid: { label: 'DS WorkspaceGrid (direct)', test: (src) => /from ['"][^'"]*workspace-grid\/WorkspaceGrid['"]/.test(src) },
  tanstack: { label: '@tanstack/react-table', test: (src) => /from ['"]@tanstack\/react-table['"]/.test(src) },
}

const tracked = execSync(`git ls-files "${ROOT}**/*.tsx" "${ROOT}**/*.ts"`, { encoding: 'utf8' }).split('\n').filter(Boolean)
const untracked = execSync(`git ls-files --others --exclude-standard "${ROOT}**/*.tsx" "${ROOT}**/*.ts"`, { encoding: 'utf8' }).split('\n').filter(Boolean)
const files = [...new Set([...tracked, ...untracked])].filter((f) => !/\.(vitest\.)?test\.tsx?$/.test(f) && !f.startsWith('apps/web/src/design-system/'))

const counts = Object.fromEntries(Object.keys(KITS).map((k) => [k, []]))
counts.rawTable = []
for (const f of files) {
  let src
  try { src = readFileSync(f, 'utf8') } catch { continue }
  for (const [k, kit] of Object.entries(KITS)) if (kit.test(src)) counts[k].push(f)
  if (f.endsWith('.tsx') && /<table[\s>]/.test(src) && /<t(body|head)[\s>]/.test(src) && !EXEMPT_TABLE_FILES.has(f) && !f.startsWith('apps/web/src/app/design/')) counts.rawTable.push(f)
}
const now = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length]))
const labels = { ...Object.fromEntries(Object.entries(KITS).map(([k, v]) => [k, v.label])), rawTable: 'raw <table> (JSX, non-exempt)' }

const mode = process.argv[2]
if (mode === '--write') {
  writeFileSync(BASELINE, JSON.stringify({ note: 'GDS rebuild backlog. Each count may only go DOWN; lower it here when a page is rebuilt and say so in the commit.', updatedAt: new Date().toISOString().slice(0, 10), counts: now }, null, 2) + '\n')
  console.log('✓ grid-kit baseline written:', now)
  process.exit(0)
}
const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).counts : null
let rose = false
for (const k of Object.keys(now)) {
  const b = base?.[k]
  const flag = b != null && now[k] > b ? '❌ ROSE' : b != null && now[k] < b ? '↓ (lower the baseline)' : ''
  console.log(`  ${labels[k].padEnd(34)} ${String(now[k]).padStart(4)}  baseline ${b ?? '—'}  ${flag}`)
  if (b != null && now[k] > b) rose = true
}
if (mode === '--check') {
  if (!base) { console.error(`❌ grid-kit ratchet: no baseline — run with --write first`); process.exit(1) }
  if (rose) {
    console.error(`\n❌ grid-kit ratchet: a retiring grid kit gained an importer. New grids are built on design-system/grid (NexusGrid).\n`)
    process.exit(1)
  }
  console.log('✓ grid-kit ratchet: no retiring kit gained an importer')
}
