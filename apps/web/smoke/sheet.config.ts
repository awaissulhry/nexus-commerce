/**
 * P3 guardrail 1 (2026-09-30) — the product-sheet COMMIT SWEEP: for every scope the seed can build (Shared, eBay, Amazon,
 * Etsy) and every editable column the sheet serves, commit one value by keyboard, by mouse and by paste, and assert the one
 * `bulk-save` it sends, its exact body, and the value read back from the API. `sheet/editors.spec.ts` says how.
 *
 * Like `playwright.config.ts` beside it, this suite only ever targets localhost, on a disposable database seeded by
 * `scripts/ci/seed-sheet-fixture.mts`, and refuses to start unless that seed's NONCE comes back through the UI.
 *
 *   SHEET_SEED=<sheet.json> SMOKE_SEED=<smoke.json> SMOKE_BASE_URL=http://localhost:3000 npx playwright test -c smoke/sheet.config.ts
 *   (locally, STUDIO_STORAGE_STATE=<a signed-in state for that stack> replaces SMOKE_SEED)
 */
import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SHEET_STORAGE_STATE = process.env.SHEET_STORAGE_STATE ?? join(tmpdir(), 'nexus-sheet-owner.json')

export default defineConfig({
  testDir: './sheet',
  testMatch: '*.spec.ts',
  // CI runs the commit sweep in its own parts (`SHEET_SWEEP_PART`, sheet/editors.spec.ts); the part for everything else
  // leaves it out.
  testIgnore: process.env.SHEET_SKIP_SWEEP === '1' ? ['**/editors.spec.ts'] : undefined,
  grep: /@sheet/,
  fullyParallel: true,
  // One worker by default: two saves racing on one database lose its serialization race now and then (a 503 "busy" the
  // sheet does not retry), which would read as a failed commit. CI splits the sweep over shards instead.
  workers: Number(process.env.SHEET_WORKERS ?? 1),
  // No retries: a commit that lands only on the second try is the defect this suite exists to catch.
  retries: 0,
  // A chunk commits about 24 values; every failure is tried and reported, so give it room (a chunk holding a whole
  // repeated attribute sets more itself, editors.spec.ts).
  timeout: 600_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never', outputFolder: process.env.SMOKE_REPORT_DIR ?? join(tmpdir(), 'nexus-sheet-report') }]] : 'list',
  globalSetup: './sheet/global-setup.ts',
  outputDir: process.env.SMOKE_OUTPUT_DIR ?? join(tmpdir(), 'nexus-sheet-results'),
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://localhost:3000',
    storageState: SHEET_STORAGE_STATE,
    viewport: { width: 1680, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
    // One gesture never waits long: a list that does not open is a failure to report, not to wait out.
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'sheet', use: { ...devices['Desktop Chrome'], viewport: { width: 1680, height: 1000 } } }],
})
