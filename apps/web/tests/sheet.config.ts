/**
 * The product-sheet specs (`sheet-*.spec.ts`), driven in a real browser against a PRODUCTION build (`next start`) and a
 * local API on a disposable seeded database — CI's `sheet` job (.github/workflows/ci.yml, plan P3 root cause #11: "CI
 * never opens the sheet"). Separate from ../playwright.config.ts, which targets the live site.
 *
 *   E2E_DATABASE_URL=… E2E_API_URL=http://127.0.0.1:8080 E2E_EMAIL=… E2E_PASSWORD=… E2E_WORKSPACE_ID=nexus_legacy_workspace \
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 [SHEET_SHARD=1/3] npx playwright test -c tests/sheet.config.ts
 *
 * ONE worker per run: the specs reseed shared families (`e2e_bulk_autosave` is 6 rows for one spec and 500 for another;
 * both alias specs use `e2e_aaa_save`), so two files at once would rewrite each other's rows. Shards run on separate
 * machines with separate databases, so sharding is safe. `PLAYWRIGHT_CHROMIUM_PATH` launches a browser already on the
 * machine (a container's /opt/pw-browsers/chromium) instead of the one `playwright install` fetches.
 */
import { defineConfig, devices } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined

/**
 * CI's shards, by file. Playwright's own `--shard` keeps a file's serial tests together and put the three heaviest files
 * (alias save, the 500-row fill, list Clear: 18 of 33 tests) on one shard. Weighed by hand instead: the alias file (9
 * tests at two widths and two themes) alone; the fill, Clear and missing fields; the list keys and the save races.
 * Every `sheet-*.spec.ts` must be in exactly ONE shard — a new spec in none would never run in CI — and SHEET_SHARD's
 * count must be this list's length (ci.yml's matrix), or the config refuses to load.
 */
export const SHARDS = [
  ['sheet-alias-save'],
  ['sheet-bulk-autosave', 'sheet-list-clear', 'sheet-missing-fields'],
  ['sheet-select-keys', 'sheet-save-races'],
]
const specs = readdirSync(__dirname).filter((f) => /^sheet-.*\.spec\.ts$/.test(f)).map((f) => f.replace(/\.spec\.ts$/, ''))
const placed = SHARDS.flat()
const unplaced = specs.filter((f) => !placed.includes(f))
const twice = placed.filter((f, i) => placed.indexOf(f) !== i)
const gone = placed.filter((f) => !specs.includes(f))
if (unplaced.length || twice.length || gone.length) {
  throw new Error(`tests/sheet.config.ts SHARDS: every sheet spec in exactly one shard — in none: ${unplaced.join(', ') || '-'}; in two: ${twice.join(', ') || '-'}; listed but missing: ${gone.join(', ') || '-'}`)
}
const shard = process.env.SHEET_SHARD?.match(/^(\d+)\/(\d+)$/)
if (process.env.SHEET_SHARD && (!shard || Number(shard[2]) !== SHARDS.length || Number(shard[1]) < 1 || Number(shard[1]) > SHARDS.length)) {
  throw new Error(`SHEET_SHARD=${process.env.SHEET_SHARD}: expected n/${SHARDS.length} (tests/sheet.config.ts SHARDS)`)
}
const files = shard ? SHARDS[Number(shard[1]) - 1] : specs

export default defineConfig({
  testDir: '.',
  testMatch: files.map((f) => `${f}.spec.ts`),
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  globalSetup: './fixtures/sheet-global-setup.ts',
  outputDir: process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), 'nexus-sheet-results'),
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: process.env.E2E_REPORT_DIR ?? join(tmpdir(), 'nexus-sheet-report') }]]
    : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // As ../playwright.config.ts, where these specs were first proven: the primary market's locale.
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'sheet', use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) } }],
})
