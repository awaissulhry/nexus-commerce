// PLAN Step 4.0 — the arms that show `check-nds-contrast.mjs` can fail. Run: node --test scripts/check-nds-contrast.test.mjs
// Every rehearsal measures a scratch COPY of tokens.css passed with --tokens; the real file is never edited.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SCRIPT = join(ROOT, 'scripts/check-nds-contrast.mjs')
const REAL = join(ROOT, 'apps/web/src/design-system/styles/tokens.css')
const dir = mkdtempSync(join(tmpdir(), 'nds-contrast-'))
let n = 0
/** A copy of the real tokens with one exact declaration swapped (asserted to exist exactly once in :root). */
function variant(from, to) {
  const css = readFileSync(REAL, 'utf8')
  assert.equal(css.split(from).length - 1, 1, `fixture anchor must occur once: ${from}`)
  const path = join(dir, `tokens-${++n}.css`)
  writeFileSync(path, css.replace(from, to))
  return path
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--json', ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr }
}

test('the real palette: controls hold, the baseline exits 0, every pair is measured', () => {
  const { code, out } = run([])
  assert.equal(code, 0)
  assert.equal(out.controls.positive, 15.48)
  assert.equal(out.controls.negativeOk, true)
  assert.equal(out.unresolved.length, 0)
  assert.equal(out.total.pairs, out.light.pairs + out.dark.pairs)
  assert.ok(out.total.pairs >= 88, 'at least the 09-22 review set')
})

test('the ratchet holds at today’s counts and fails when a count grows', () => {
  const base = run([]).out.total
  assert.equal(run(['--max-failures', String(base.belowAAA), '--max-aa-failures', String(base.belowAA)]).code, 0)
  assert.equal(run(['--max-failures', String(base.belowAAA - 1)]).code, 1)
  assert.equal(run(['--max-aa-failures', String(base.belowAA - 1)]).code, 1)
})

test('a lightened body token is caught, and the ratchet at today’s counts fails on it', () => {
  const base = run([]).out.total
  const path = variant('--nds-text-2: var(--nds-grey-600);', '--nds-text-2: #8a93a1;')
  const { code, out } = run(['--tokens', path, '--max-failures', String(base.belowAAA), '--max-aa-failures', String(base.belowAA)])
  assert.equal(code, 1)
  assert.ok(out.total.belowAA > base.belowAA)
  assert.ok(out.failing.some((r) => r.fg === '--nds-text-2' && r.mode === 'light' && r.belowAA))
})

test('a var() chain is followed to its literal', () => {
  const { out } = run([])
  const row = out.rows.find((r) => r.mode === 'light' && r.fg === '--nds-text' && r.bg === '--nds-surface')
  assert.equal(row.fgHex, '#1c2530') // --nds-text → var(--nds-grey-900) → #1c2530
  assert.equal(row.bgHex, '#ffffff') // --nds-surface → var(--nds-white) → #ffffff
})

test('a dark lookup takes the .dark value, and falls back to :root when .dark does not declare it', () => {
  const { out } = run([])
  assert.equal(out.rows.find((r) => r.mode === 'dark' && r.fg === '--nds-text' && r.bg === '--nds-surface').fgHex, '#e7ebf1')
  const amber = out.rows.find((r) => r.mode === 'dark' && r.fg === '--nds-amber-text')
  assert.equal(amber.fgHex, '#9a6700') // not re-declared in .dark
})

test('an unresolvable token is reported and counted as a failure, never a pass', () => {
  const path = variant('--nds-text-muted: #626c7b;', '--nds-text-muted: var(--nds-zz-absent);')
  const { code, out } = run(['--tokens', path])
  assert.equal(code, 0)
  const light = out.rows.filter((r) => r.mode === 'light' && r.fg === '--nds-text-muted')
  assert.ok(light.length > 0)
  for (const r of light) { assert.equal(r.ratio, null); assert.equal(r.belowAAA, true); assert.equal(r.belowAA, true) }
  assert.ok(out.unresolved.some((u) => u.fg === '--nds-text-muted'))
})

test('a translucent ground is composited over the page surface before it is measured', () => {
  const path = variant('--nds-surface-hover: var(--nds-grey-75);', '--nds-surface-hover: color-mix(in srgb, #000000 50%, transparent);')
  const { out } = run(['--tokens', path])
  const row = out.rows.find((r) => r.mode === 'light' && r.fg === '--nds-text' && r.bg === '--nds-surface-hover')
  assert.equal(row.bgHex, '#808080') // 50% black over #ffffff
})

test('a new text token is measured without editing the script (the pair set is derived)', () => {
  const base = run([]).out.total.pairs
  const path = variant('--nds-text-link: #1a60c4;', '--nds-text-link: #1a60c4;\n  --nds-text-4: #cccccc;')
  const { out } = run(['--tokens', path])
  const surfaces = new Set(out.rows.filter((r) => r.group === 'text').map((r) => r.bg)).size
  assert.equal(out.total.pairs, base + 2 * surfaces)
  assert.ok(out.failing.some((r) => r.fg === '--nds-text-4' && r.belowAA))
})

test('the controls stop the run: a broken positive control or a resolvable "absent" token exits 2', () => {
  assert.equal(run(['--tokens', variant('--nds-text: var(--nds-grey-900);', '--nds-text: #777777;')]).code, 2)
  assert.equal(run(['--tokens', variant('--nds-text-link: #1a60c4;', '--nds-text-link: #1a60c4;\n  --nds-zz-control-never-declared: #ffffff;')]).code, 2)
})

test('R-49: --nds-text-3 is body text — counted strict at 7:1, with no ui verdict beside it', () => {
  const { out } = run([])
  const row = out.rows.find((r) => r.mode === 'dark' && r.fg === '--nds-text-3' && r.bg === '--nds-surface')
  assert.equal(row.tier, 'body')
  assert.ok(row.ratio >= 4.5 && row.ratio < 7) // would pass a ui bar; fails the body bar it is ruled to
  assert.equal(row.belowAAA, true)
  assert.equal(row.ifUi, undefined)
})
