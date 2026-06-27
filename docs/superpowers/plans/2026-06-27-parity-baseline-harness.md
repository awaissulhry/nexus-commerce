# Parity Baseline Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the evidence-gated parity harness that captures golden baselines of the current app's observable behavior (starting with the Products list) from production, and re-verifies any new implementation against them — so no rebuild step can silently change behavior.

**Architecture:** A small ESM (`.mjs`) harness under `scripts/parity/` following the repo's existing `verify-*.mjs` conventions (prod base URL via env, `fetch`, pass/fail counters, non-zero exit on drift). Pure helpers (`normalize`, `deepDiff`) are unit-tested with the built-in `node --test` runner. Data parity is captured/verified against the open `/api/products` endpoint. UI parity is captured with Playwright (screenshot + accessibility-tree snapshot) reusing `apps/web`'s existing Playwright install. This is Plan 1 of 3 (Plan 2 = Foundation DS components; Plan 3 = new Products page, which verifies against these baselines).

**Tech Stack:** Node 18+ ESM, `node:test`, `fetch` (global), Playwright `@playwright/test@^1.60`, npm workspaces.

## Global Constraints

- **Additive only** — this plan changes NO existing runtime behavior; it adds scripts + committed baselines. Do not modify any app/api/web source.
- **ESM conventions** — all scripts are `.mjs`, no transpile; follow `scripts/verify-*.mjs` style (counters, `process.exit(fail>0?1:0)`).
- **Prod URLs** — API: `https://nexusapi-production-b7bb.up.railway.app` · Web: `https://nexus-commerce-three.vercel.app`. Override via `PARITY_TARGET` / `API_BASE_URL` (API) and `PARITY_WEB` (web).
- **Auth** — `/api/products` is open to unauth'd browser clients; no Bearer header needed for capture/verify.
- **Package manager** — npm workspaces (npm 10). Repo root = `/Users/awais/nexus-commerce`.
- **Commits** — concurrent sessions share `main`; commit ONLY the files listed in each task via `git add <paths>` (never `git add -A`). End every commit message body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Do not touch** the flat-file editor pages/routes (out of scope here regardless).

---

### Task 1: Parity lib — pure helpers (`normalize`, `deepDiff`)

**Files:**
- Create: `scripts/parity/lib/parity.mjs`
- Test: `scripts/parity/lib/parity.test.mjs`

**Interfaces:**
- Produces: `normalize(value, dropKeys: string[]): any` (recursively drops `dropKeys`, sorts object keys for stable ordering); `deepDiff(a, b, path=''): Array<{path, expected, actual}>` (deep structural diff; arrays compared by index + length).

- [ ] **Step 1: Write the failing tests**

```js
// scripts/parity/lib/parity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, deepDiff } from './parity.mjs'

test('normalize drops volatile keys and is order-stable', () => {
  const a = normalize({ b: 1, a: 2, updatedAt: 'x', nested: { z: 1, updatedAt: 'y' } }, ['updatedAt'])
  assert.deepEqual(Object.keys(a), ['a', 'b', 'nested'])
  assert.equal('updatedAt' in a, false)
  assert.equal('updatedAt' in a.nested, false)
  assert.equal(JSON.stringify(a), JSON.stringify({ a: 2, b: 1, nested: { z: 1 } }))
})

test('deepDiff returns empty for equal structures', () => {
  assert.deepEqual(deepDiff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), [])
})

test('deepDiff reports changed value with path', () => {
  const d = deepDiff({ a: { b: 1 } }, { a: { b: 2 } })
  assert.equal(d.length, 1)
  assert.equal(d[0].path, '.a.b')
  assert.equal(d[0].expected, 1)
  assert.equal(d[0].actual, 2)
})

test('deepDiff reports added/removed keys and array length', () => {
  const d = deepDiff({ a: 1, arr: [1] }, { b: 2, arr: [1, 9] })
  const paths = d.map((x) => x.path).sort()
  assert.ok(paths.includes('.a'))
  assert.ok(paths.includes('.b'))
  assert.ok(paths.includes('.arr.length'))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/parity/lib/parity.test.mjs`
Expected: FAIL — `Cannot find module './parity.mjs'` (or `normalize is not a function`).

- [ ] **Step 3: Implement the helpers**

```js
// scripts/parity/lib/parity.mjs
export function normalize(value, dropKeys = []) {
  const drop = new Set(dropKeys)
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) {
        if (drop.has(k)) continue
        out[k] = walk(v[k])
      }
      return out
    }
    return v
  }
  return walk(value)
}

export function deepDiff(a, b, path = '') {
  const diffs = []
  if (a === b) return diffs
  const aObj = a && typeof a === 'object'
  const bObj = b && typeof b === 'object'
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
    diffs.push({ path: path || '(root)', expected: a, actual: b })
    return diffs
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push({ path: `${path}.length`, expected: a.length, actual: b.length })
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`))
    return diffs
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) { diffs.push({ path: `${path}.${k}`, expected: undefined, actual: b[k] }); continue }
    if (!(k in b)) { diffs.push({ path: `${path}.${k}`, expected: a[k], actual: undefined }); continue }
    diffs.push(...deepDiff(a[k], b[k], `${path}.${k}`))
  }
  return diffs
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/parity/lib/parity.test.mjs`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/parity/lib/parity.mjs scripts/parity/lib/parity.test.mjs
git commit -m "feat(parity): pure normalize + deepDiff helpers with node:test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Parity lib — IO + reporting helpers

**Files:**
- Modify: `scripts/parity/lib/parity.mjs` (append exports)
- Test: `scripts/parity/lib/parity.io.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveBaseUrl(): string` (`PARITY_TARGET` || `API_BASE_URL` || prod default, trailing slashes stripped); `fetchJson(base, path): Promise<any>`; `goldenPath(name): string`; `writeGolden(name, data): void`; `readGolden(name): any` (baselines dir = `scripts/parity/baselines/`); `makeReporter(title): { ok(l), bad(l, d), summary(): number }`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/parity/lib/parity.io.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBaseUrl, makeReporter } from './parity.mjs'

test('resolveBaseUrl honors PARITY_TARGET and strips trailing slash', () => {
  const prev = process.env.PARITY_TARGET
  process.env.PARITY_TARGET = 'https://example.test/'
  assert.equal(resolveBaseUrl(), 'https://example.test')
  if (prev === undefined) delete process.env.PARITY_TARGET; else process.env.PARITY_TARGET = prev
})

test('resolveBaseUrl falls back to prod when unset', () => {
  const a = process.env.PARITY_TARGET, b = process.env.API_BASE_URL
  delete process.env.PARITY_TARGET; delete process.env.API_BASE_URL
  assert.equal(resolveBaseUrl(), 'https://nexusapi-production-b7bb.up.railway.app')
  if (a !== undefined) process.env.PARITY_TARGET = a
  if (b !== undefined) process.env.API_BASE_URL = b
})

test('reporter counts and returns exit code', () => {
  const r = makeReporter('t')
  r.ok('one'); r.bad('two', 'detail')
  assert.equal(r.summary(), 1)
  const r2 = makeReporter('t2'); r2.ok('a')
  assert.equal(r2.summary(), 0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/parity/lib/parity.io.test.mjs`
Expected: FAIL — `resolveBaseUrl is not a function`.

- [ ] **Step 3: Append the implementation to `scripts/parity/lib/parity.mjs`**

```js
// --- append to scripts/parity/lib/parity.mjs ---
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINES = join(HERE, '..', 'baselines')

export function resolveBaseUrl() {
  const raw = process.env.PARITY_TARGET || process.env.API_BASE_URL || 'https://nexusapi-production-b7bb.up.railway.app'
  return raw.replace(/\/+$/, '')
}

export async function fetchJson(base, path) {
  const url = `${base}${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  return res.json()
}

export function goldenPath(name) { return join(BASELINES, name) }
export function writeGolden(name, data) {
  mkdirSync(BASELINES, { recursive: true })
  writeFileSync(goldenPath(name), JSON.stringify(data, null, 2) + '\n')
}
export function readGolden(name) { return JSON.parse(readFileSync(goldenPath(name), 'utf8')) }

export function makeReporter(title) {
  let pass = 0, fail = 0
  return {
    ok(l) { console.log('  ✓', l); pass++ },
    bad(l, d) { console.log('  ✗', l, d !== undefined ? `\n      -> ${typeof d === 'string' ? d : JSON.stringify(d)}` : ''); fail++ },
    summary() { console.log(`\n${title}: ${pass} passed, ${fail} failed`); return fail === 0 ? 0 : 1 },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/parity/lib/parity.io.test.mjs`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/parity/lib/parity.mjs scripts/parity/lib/parity.io.test.mjs
git commit -m "feat(parity): base-url/fetch/golden-IO/reporter helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Products surface + `capture` CLI + committed golden

**Files:**
- Create: `scripts/parity/surfaces/products.mjs`
- Create: `scripts/parity/surfaces/index.mjs`
- Create: `scripts/parity/capture.mjs`
- Create (generated): `scripts/parity/baselines/products-list.json`

**Interfaces:**
- Consumes: `normalize`, `resolveBaseUrl`, `fetchJson`, `writeGolden` from `../lib/parity.mjs`.
- Produces: `surfaces` map `{ products }`; each surface = `{ name, golden, path, dropKeys, build(raw) }`. `build(raw)` returns `{ total, stats, count, products: normalized[] }` sorted by `sku`.

- [ ] **Step 1: Create the products surface**

```js
// scripts/parity/surfaces/products.mjs
import { normalize } from '../lib/parity.mjs'

// Deterministic canonical query: fixed page/limit, include coverage (per-channel
// listing status) + tags so the Channels column data is captured. Drop volatile
// fields that change between identical requests.
export const products = {
  name: 'products',
  golden: 'products-list.json',
  path: '/api/products?page=1&limit=200&includeCoverage=true&includeTags=true',
  dropKeys: ['updatedAt', 'createdAt', 'syncedAt', 'version', 'syncQueue'],
  build(raw) {
    const items = [...(raw.products || [])].sort((a, b) => String(a.sku).localeCompare(String(b.sku)))
    return {
      total: raw.total,
      stats: raw.stats,
      count: items.length,
      products: items.map((p) => normalize(p, this.dropKeys)),
    }
  },
}
```

```js
// scripts/parity/surfaces/index.mjs
import { products } from './products.mjs'
export const surfaces = { products }
```

- [ ] **Step 2: Create the capture CLI**

```js
// scripts/parity/capture.mjs
import { resolveBaseUrl, fetchJson, writeGolden } from './lib/parity.mjs'
import { surfaces } from './surfaces/index.mjs'

const names = process.argv.slice(2)
const targets = names.length ? names : Object.keys(surfaces)
const base = resolveBaseUrl()
console.log(`Capturing [${targets.join(', ')}] from ${base}`)
for (const name of targets) {
  const surface = surfaces[name]
  if (!surface) { console.error(`unknown surface "${name}". known: ${Object.keys(surfaces).join(', ')}`); process.exit(2) }
  const golden = surface.build(await fetchJson(base, surface.path))
  writeGolden(surface.golden, golden)
  console.log(`  ✓ baselines/${surface.golden} — ${golden.count} products, total=${golden.total}`)
}
```

- [ ] **Step 3: Generate the golden from prod**

Run: `node scripts/parity/capture.mjs products`
Expected: prints `Capturing [products] from https://nexusapi-production-b7bb.up.railway.app` and `✓ baselines/products-list.json — <N> products, total=<N>`, and creates `scripts/parity/baselines/products-list.json`.

- [ ] **Step 4: Sanity-check the golden** (ESM-safe; no `require`)

Run: `grep -m1 '"total"' scripts/parity/baselines/products-list.json && grep -c '"coverage"' scripts/parity/baselines/products-list.json && grep -c '"sku"' scripts/parity/baselines/products-list.json`
Expected: a `"total": <N>` line, a `coverage` occurrence count > 0 (per-channel status captured), and a `sku` count equal to the product count.

- [ ] **Step 5: Commit**

```bash
git add scripts/parity/surfaces/products.mjs scripts/parity/surfaces/index.mjs scripts/parity/capture.mjs scripts/parity/baselines/products-list.json
git commit -m "feat(parity): products surface + capture CLI + committed golden

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `verify` CLI (data parity gate)

**Files:**
- Create: `scripts/parity/verify.mjs`

**Interfaces:**
- Consumes: `resolveBaseUrl`, `fetchJson`, `readGolden`, `deepDiff`, `makeReporter` from `./lib/parity.mjs`; `surfaces` from `./surfaces/index.mjs`.
- Produces: a CLI that exits 0 when the target matches the golden, 1 on drift.

- [ ] **Step 1: Create the verify CLI**

```js
// scripts/parity/verify.mjs
import { resolveBaseUrl, fetchJson, readGolden, deepDiff, makeReporter } from './lib/parity.mjs'
import { surfaces } from './surfaces/index.mjs'

const names = process.argv.slice(2)
const targets = names.length ? names : Object.keys(surfaces)
const base = resolveBaseUrl()
const r = makeReporter('parity')
console.log(`Verifying [${targets.join(', ')}] against ${base}`)
for (const name of targets) {
  const surface = surfaces[name]
  if (!surface) { console.error(`unknown surface "${name}"`); process.exit(2) }
  const golden = readGolden(surface.golden)
  const current = surface.build(await fetchJson(base, surface.path))
  const diffs = deepDiff(golden, current)
  if (diffs.length === 0) r.ok(`${name}: ${current.count} products match golden`)
  else {
    for (const d of diffs.slice(0, 50)) r.bad(`${name} drift at ${d.path}`, `expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.actual)}`)
    if (diffs.length > 50) console.log(`  …and ${diffs.length - 50} more`)
  }
}
process.exit(r.summary())
```

- [ ] **Step 2: Verify against prod (proves harness correctness — same source must match)**

Run: `node scripts/parity/verify.mjs products`
Expected: `✓ products: <N> products match golden` and `parity: 1 passed, 0 failed`, exit 0.

- [ ] **Step 3: Prove it catches drift (negative check)**

Manually confirm the gate fails on drift:
1. Edit `scripts/parity/baselines/products-list.json` — change the top-level `"total"` value (e.g. add 1).
2. Run: `node scripts/parity/verify.mjs products; echo "exit=$?"`
   Expected: a `✗ products drift at .total` line, `parity: 0 passed, 1 failed`, and `exit=1`.
3. Restore the golden: `git checkout scripts/parity/baselines/products-list.json`
4. Re-run `node scripts/parity/verify.mjs products` → back to `1 passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add scripts/parity/verify.mjs
git commit -m "feat(parity): verify CLI (data-parity gate, exits 1 on drift)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: UI baseline — current Products screenshot + control inventory (Playwright)

**Files:**
- Create: `apps/web/tests/parity/products.parity.spec.ts`
- Create (generated): `apps/web/tests/parity/baselines/products-current.png`
- Create (generated): `apps/web/tests/parity/baselines/products-controls.aria.yml`

**Interfaces:**
- Consumes: prod web URL via `PARITY_WEB` (default prod). Reuses `apps/web` Playwright install + config.
- Produces: a committed "before" screenshot and an accessibility-tree snapshot (the control inventory) of the current `/products`. (Plan 3 adds the sibling assertion that the new route's controls are a superset.)

- [ ] **Step 1: Create the capture spec**

```ts
// apps/web/tests/parity/products.parity.spec.ts
import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = process.env.PARITY_WEB || 'https://nexus-commerce-three.vercel.app'
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'baselines')

test('products: capture current visual + control inventory', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${WEB}/products`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.getByText('Manage products', { exact: false }).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(OUT, 'products-current.png'), fullPage: true })
  const aria = await page.locator('main').ariaSnapshot()
  writeFileSync(join(OUT, 'products-controls.aria.yml'), aria + '\n')
})
```

- [ ] **Step 2: Run it against prod to generate the baselines**

Run: `cd apps/web && npx playwright test tests/parity/products.parity.spec.ts --reporter=line`
Expected: 1 passed; files `apps/web/tests/parity/baselines/products-current.png` and `products-controls.aria.yml` created. (If Chromium is missing, run `npx playwright install chromium` first.)

- [ ] **Step 3: Sanity-check the control inventory**

Run: `grep -c "button\|link\|textbox" apps/web/tests/parity/baselines/products-controls.aria.yml`
Expected: a count well above 30 (the page exposes ~80 interactive controls), confirming the inventory captured the toolbar/bulk/row controls.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/parity/products.parity.spec.ts apps/web/tests/parity/baselines/products-current.png apps/web/tests/parity/baselines/products-controls.aria.yml
git commit -m "test(parity): capture current /products visual + control inventory baseline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Developer entrypoints (npm scripts + README)

**Files:**
- Modify: `package.json` (root — add three scripts)
- Create: `scripts/parity/README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: `npm run parity:capture`, `npm run parity:verify`, `npm run parity:ui`.

- [ ] **Step 1: Add scripts to root `package.json`**

In the root `"scripts"` block, add (keep existing entries; match surrounding comma/format):

```json
    "parity:capture": "node scripts/parity/capture.mjs",
    "parity:verify": "node scripts/parity/verify.mjs",
    "parity:ui": "npm --prefix apps/web exec -- playwright test tests/parity/products.parity.spec.ts"
```

- [ ] **Step 2: Write the README**

```markdown
<!-- scripts/parity/README.md -->
# Parity Baseline Harness

Proves the rebuild does not silently change behavior. Capture golden baselines
from the CURRENT app, then re-verify any new build against them before cutover.

## Data parity (API)
- Capture (writes baselines/): `node scripts/parity/capture.mjs products`
- Verify a target:            `node scripts/parity/verify.mjs products`
- Target selection (env, precedence): `PARITY_TARGET` > `API_BASE_URL` > prod default
  (`https://nexusapi-production-b7bb.up.railway.app`).
- Exit code: 0 = matches golden, 1 = drift (prints each drifting path).

## UI parity (Playwright)
- Capture current page baseline: `npm run parity:ui` (target via `PARITY_WEB`,
  default `https://nexus-commerce-three.vercel.app`).
- Produces a "before" screenshot + an accessibility-tree control inventory under
  `apps/web/tests/parity/baselines/`.

## Surfaces
- `products` — the /products list. Add new surfaces in `scripts/parity/surfaces/`.

## Workflow per page cutover
1. (done) golden captured from prod.
2. Build the new surface behind a route toggle.
3. Point `PARITY_TARGET` / `PARITY_WEB` at the new build; run verify; it must pass
   (data) and the control inventory must remain a superset before the old page is retired.
```

- [ ] **Step 3: Verify the npm scripts resolve**

Run: `npm run parity:verify products`
Expected: same PASS output as Task 4 Step 2 (`parity: 1 passed, 0 failed`).

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/parity/README.md
git commit -m "chore(parity): npm entrypoints + harness README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for Plan 3 (new Products page) — not implemented here

When the new `/products` is built behind a route toggle, parity is enforced by:
- **Data:** `PARITY_TARGET=<new-api-or-same> node scripts/parity/verify.mjs products` must exit 0 (the new page consumes the same `/api/products`; this guards the data layer was not altered).
- **Controls:** a sibling Playwright spec captures the new route's `ariaSnapshot()` and asserts every accessible control name in `products-controls.aria.yml` that maps to a *kept* feature is still reachable (relocated is fine; missing is a fail).
- **Visual:** the new page screenshot is diffed against the approved mockup (self-verify), NOT against `products-current.png` (which is intentionally the old design and kept only as the "before" reference).
