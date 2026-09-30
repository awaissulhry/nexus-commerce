/**
 * What every product-sheet spec (`tests/sheet-*.spec.ts`) reads from its environment, in one place, so each one can run
 * from a clean seed with env only — no private files (plan P3, root cause #11: CI never opened the sheet).
 *
 *   E2E_DATABASE_URL   the LOCAL database the API uses (loopback, name contains "test"); the specs' seeds write there
 *   E2E_API_URL        the LOCAL API (hard rule 3: the web app must be pointed at it too)
 *   E2E_EMAIL / E2E_PASSWORD   a login on that API — test values, never a real password
 *   E2E_WORKSPACE_ID   the business the login and the seeds use (business profiles on, as in production)
 *   E2E_AUTH_STATE     a saved signed-in state; `sheet-global-setup.ts` writes it from E2E_EMAIL / E2E_PASSWORD
 *   E2E_ALIAS_FIXTURE  optional: a JSON file { family, child, alias, account }; without it the alias specs seed
 *                      `sheet-alias-seed.mjs` themselves
 *
 * `tests/sheet.config.ts` runs them the way CI's `sheet` job does (.github/workflows/ci.yml).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

export const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1']
export const isLocal = (url: string) => LOOPBACK.includes(new URL(url).hostname)

export const sheetEnv = {
  api: process.env.E2E_API_URL,
  email: process.env.E2E_EMAIL,
  password: process.env.E2E_PASSWORD,
  database: process.env.E2E_DATABASE_URL,
  auth: process.env.E2E_AUTH_STATE,
  /** The business the seeds write to and the studio opens under (`/w/<id>`). */
  workspace: process.env.E2E_WORKSPACE_ID ?? 'nexus_legacy_workspace',
}

/** A studio address under the business, as the app builds it with business profiles on. */
export const studioPath = (family: string, query: string) => `/w/${sheetEnv.workspace}/products/${family}/edit/studio?${query}`

export interface AliasFixture { family: string; child: string; alias: string; account: string }

/** Whether the alias specs can get a fixture: a file handed in, or a local database to seed one into. */
export const aliasFixtureAvailable = () => !!(process.env.E2E_ALIAS_FIXTURE || sheetEnv.database)

/**
 * The two-alias eBay · DE family: the file E2E_ALIAS_FIXTURE names, or a fresh seed (`sheet-alias-seed.mjs`, which
 * refuses any database that is not a local test one). Call it in `beforeAll`: a reseed resets the family.
 */
export function aliasFixture(): AliasFixture {
  const fixture = process.env.E2E_ALIAS_FIXTURE
    ? JSON.parse(readFileSync(process.env.E2E_ALIAS_FIXTURE, 'utf8')) as AliasFixture
    : JSON.parse(execFileSync(process.execPath, [join(__dirname, 'sheet-alias-seed.mjs')], { encoding: 'utf8' }).trim().split('\n').pop()!) as AliasFixture
  if (![fixture.family, fixture.child, fixture.alias].every(id => id.startsWith('e2e_'))) throw new Error('Use a synthetic e2e_ fixture only.')
  return fixture
}

/**
 * The stored sheet, read through the page's own fetch: it carries the session and, with business profiles on, the
 * business (`/backend/api/…`, apps/web/CLAUDE.md). A bare request from the test has neither.
 */
export async function readStoredSheet(page: Page, family: string, query: string) {
  const path = `/api/products/${family}/studio/sheet?${query}`
  const read = await page.evaluate(async (url) => {
    const res = await fetch(url)
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) }
  }, process.env.E2E_WORKSPACE_ID ? `/backend${path}` : `${sheetEnv.api}${path}`)
  if (!read.ok) throw new Error(`sheet read answered ${read.status}`)
  return read.body as { rows: Array<{ id: string; aliasId?: string | null; rowKind: string; sku: string; values: Record<string, { value: unknown } | undefined> }> }
}
