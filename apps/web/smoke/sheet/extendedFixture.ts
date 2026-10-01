import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { sheetFixtureDatabaseConfig } from '../../../../scripts/ci/sheet-fixture-target.mjs'
import { editingCells, elsewhereInRow, openSheet, readSheet, type Scope, type SheetRead } from './grid'
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

/** The bulk-save receipt row the answer names, read through the same restricted login inside the fixture business. */
export async function storedReceipt(seed: EditorSeed, operationId: unknown) {
  expect(typeof operationId, 'the answer names its BulkOperation receipt').toBe('string')
  const client = new pg.Client(sheetFixtureDatabaseConfig(process.env.SHEET_EDITOR_DATABASE_URL ?? ''))
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SELECT set_config('nexus.workspace_id',$1,true)`, [seed.workspace])
    const result = await client.query(`SELECT "workspaceId",status,"changeCount","productCount","expectedVersion",changes,"cascadeCount","affectedChildren"
      FROM "BulkOperation" WHERE id = $1`, [operationId])
    await client.query('COMMIT')
    expect(result.rows, 'exactly one receipt row in the fixture business').toHaveLength(1)
    return result.rows[0] as { workspaceId: string; status: string; changeCount: number; productCount: number; expectedVersion: number | null
      changes: Array<Record<string, unknown>>; cascadeCount: number; affectedChildren: string[] }
  } finally { await client.end() }
}

/**
 * A real reload, then the mount wait `openSheet` uses: rows rendered and the grid's own api reachable. The fixture name
 * is in the page header before the grid has rows, so it alone does not prove the grid is there to focus.
 */
export async function reloadEditorFixture(page: Page, seed: EditorSeed) {
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id] .ag-cell').length > 1, null, { timeout: 120_000 })
  await expect.poll(() => editingCells(page).catch(() => -1), { timeout: 30_000, message: 'the reloaded grid mounts with no open editor' }).toBe(0)
  await expect(page.getByText(seed.name, { exact: true }).first()).toBeVisible()
  await assertEditorTheme(page)
}

/**
 * The click-away that commits an open popup editor: with `stopEditingWhenCellsLoseFocus` (GridSheet.tsx) AG opens the
 * editor as a modal popup and a pointer press outside it closes the popup and keeps the value (ag-grid-community
 * `_onPopupEditorClosed`: only Escape reverts). At desktop width the press goes to the pinned Product cell of the same
 * row (`elsewhereInRow`). Below 640 px the Shared sheet pins no column (useNarrowSheet.ts, NARROW_SHEET_PX), so that cell
 * scrolls away: an operator taps another grid cell the editor does not cover (same row first), and when the editor
 * covers the whole grid, the nearest neutral spot outside it. Never a control: a button or checkbox would act.
 */
export async function clickAway(page: Page, cell: Locator) {
  const pinned = await elsewhereInRow(page, cell)
  if (await pinned.count()) return pinned.click()
  const target = await cell.evaluate((editing) => {
    const control = 'button, input, select, textarea, a, label, summary, [contenteditable], [role="button"], [role="checkbox"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="switch"], [role="columnheader"]'
    const popup = editing.ownerDocument.querySelector('.ag-popup-editor')
    const neutral = (hit: Element | null): hit is Element => !!hit && !popup?.contains(hit) && !hit.closest(control) && !hit.closest('nav, header, [role="navigation"], [role="banner"]')
    const describe = (hit: Element) => `${hit.tagName.toLowerCase()}${hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\s+/).join('.') : ''}`
    const row = editing.closest('.ag-row')?.getAttribute('row-index')
    const cells = [...document.querySelectorAll('.ag-row[row-index] .ag-cell[col-id]')].flatMap(el => {
      const box = el.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2
      if (el === editing || box.width < 8 || box.height < 8 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return []
      const hit = document.elementFromPoint(x, y)
      return neutral(hit) && el.contains(hit) ? [{ x, y, row: el.closest('.ag-row')?.getAttribute('row-index'), what: `cell ${el.getAttribute('col-id')}` }] : []
    })
    const inGrid = cells.find(found => found.row === row) ?? cells[0]
    if (inGrid) return inGrid
    const box = popup?.getBoundingClientRect()
    if (!box) return null
    let best: { x: number; y: number; distance: number; what: string } | null = null
    for (let y = 4; y < innerHeight; y += 8) for (let x = 4; x < innerWidth; x += 8) {
      const hit = document.elementFromPoint(x, y)
      if (!neutral(hit)) continue
      const distance = Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom))
      if (distance >= 12 && (!best || distance < best.distance)) best = { x, y, distance, what: `outside the editor: ${describe(hit)}` }
    }
    return best
  })
  expect(target, 'a neutral spot outside the open editor to click away to').toBeTruthy()
  test.info().annotations.push({ type: 'click-away', description: `${target!.what} at ${Math.round(target!.x)},${Math.round(target!.y)}` })
  await page.mouse.click(target!.x, target!.y)
}

/**
 * Cleanup after every outcome, told truthfully: a cleanup failure fails a test that passed; after a test failure it is
 * attached beside that first error and never replaces it.
 */
export async function truthfulCleanup(bodyFailed: boolean, cleanup: () => Promise<void>) {
  try { await cleanup() } catch (error) {
    if (!bodyFailed) throw error
    await test.info().attach('cleanup-failed-after-test-failure', { body: String((error as Error)?.stack ?? error), contentType: 'text/plain' })
  }
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
