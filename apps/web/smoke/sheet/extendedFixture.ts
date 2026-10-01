import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, type Page } from '@playwright/test'
import { sheetFixtureDatabaseConfig } from '../../../../scripts/ci/sheet-fixture-target.mjs'
import { openSheet, readSheet, type Scope, type SheetRead } from './grid'
import { assertSaved, type Save } from './wire'
import { browserMutation } from './browserRequest'

export interface EditorSeed {
  workspace: string; nonce: string; family: string; children: string[]; name: string
  records: Array<Record<string, unknown>>; protectors: Array<Record<string, string>>
}

export function editorSeed(): EditorSeed {
  if (!process.env.SHEET_EDITOR_SEED) throw new Error('SHEET_EDITOR_SEED must name the supplemental editor seed output')
  const seed = JSON.parse(readFileSync(process.env.SHEET_EDITOR_SEED, 'utf8')) as EditorSeed
  if (!/^e2e_sheet_editors_[a-f0-9]{16}$/.test(seed.workspace) || seed.children.length !== 2 || !seed.name.endsWith(seed.nonce)) throw new Error('Invalid supplemental fixture identity')
  return seed
}

export function editorScope(seed: EditorSeed): Scope {
  return { name: 'master', family: seed.family, locale: 'it',
    page: `/w/${seed.workspace}/products/${seed.family}/edit/studio?scope=master&market=IT&locale=it&tab=sheet`,
    api: `/backend/api/products/${seed.family}/studio/sheet?scope=master&market=IT&locale=it` }
}

/** One read-only connection to the explicitly named disposable DB; no .env or default application connection. */
export async function storedEditorProducts(seed: EditorSeed) {
  const config = sheetFixtureDatabaseConfig(process.env.SHEET_EDITOR_DATABASE_URL ?? '')
  const client = new pg.Client(config)
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SELECT set_config('nexus.workspace_id',$1,true)`, [seed.workspace])
    const result = await client.query(`SELECT id,name,version,"parentId","categoryAttributes","impactProtectors","variationAxes","localizedContent"
      FROM "Product" WHERE "workspaceId"=$1 AND id = ANY($2::text[]) ORDER BY id`, [seed.workspace, [seed.family, ...seed.children]])
    expect(result.rows).toHaveLength(3)
    expect(result.rows.find(row => row.id === seed.family)?.name).toBe(seed.name)
    await client.query('COMMIT')
    return result.rows as Array<{ id: string; name: string; version: number; parentId: string | null; categoryAttributes: Record<string, unknown> | null; impactProtectors: unknown; variationAxes: string[]; localizedContent: Record<string, unknown> | null }>
  } finally { await client.end() }
}

export async function openEditorFixture(page: Page, seed: EditorSeed, scope = editorScope(seed)) {
  await storedEditorProducts(seed)
  await openSheet(page, scope)
  await expect(page.getByText(seed.name, { exact: true }).first(), 'private fixture nonce must come through the actual app').toBeVisible()
  await assertEditorTheme(page)
  const read = await readSheet(page, editorScope(seed), seed.workspace)
  expect(read.rows.map(row => row.id).sort()).toEqual([seed.family, ...seed.children].sort())
  return read
}

export async function assertEditorTheme(page: Page) {
  const theme = await page.evaluate(() => localStorage.getItem('nexus:theme'))
  expect(['light', 'dark']).toContain(theme)
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(theme === 'dark')
}

export function rowIn(read: SheetRead, id: string) {
  const row = read.rows.find(row => row.id === id)
  expect(row, 'the exact synthetic product must be present').toBeTruthy()
  return row!
}

/** Cleanup uses the same canonical bulk endpoint, its fresh product token, and the server's own write field. */
export async function restoreEditorValue(page: Page, seed: EditorSeed, id: string, key: string, value: unknown) {
  const scope = editorScope(seed)
  const fresh = await readSheet(page, scope, seed.workspace)
  const row = rowIn(fresh, id), column = fresh.columns.find(column => column.key === key)
  expect(column?.writeField).toBeTruthy()
  if (JSON.stringify(row.values[key]?.value) === JSON.stringify(value)) return
  const unitKey = `restore-${randomUUID()}`
  const response = await browserMutation<Save['answer']>(page, seed.workspace, '/backend/api/products/bulk-save', 'POST', { operationId: randomUUID(), units: [{
      key: unitKey, expectedVersion: row.version,
      marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }],
      changes: [{ id, field: column!.writeField, value }],
    }] })
  assertSaved({ status: response.status, answer: response.body }, 'restore supplemental editor value')
  expect(rowIn(await readSheet(page, scope, seed.workspace), id).values[key]?.value).toEqual(value)
}
