/**
 * The product sheet saves a 500-row fill-handle drag as ONE request, and every value is stored.
 *
 * The defect (measured 2026-09-29, eBay · IT "Description theme", 250 variations): the fill handle saved each row as its
 * own `PATCH /api/products/bulk`, all at once; the server rebuilt the whole family per request and 224 of 250 rows
 * failed or were never confirmed. This drives the REAL gesture — mouse down on the fill handle, the wheel to scroll
 * while the button is held, mouse up on row 500 — then reads every row back from the API.
 *
 * LOCAL ONLY. Needs a web dev server (PLAYWRIGHT_BASE_URL) pointed at a LOCAL API (E2E_API_URL, hard rule 3), a login
 * on that API (E2E_EMAIL / E2E_PASSWORD — test values, never a real password) and the LOCAL database the API uses
 * (E2E_DATABASE_URL), which `fixtures/bulk-autosave-seed.mjs` reseeds before the test:
 *
 *   E2E_DATABASE_URL=postgresql://…@127.0.0.1:<port>/<db> E2E_API_URL=http://127.0.0.1:<api> \
 *   E2E_EMAIL=… E2E_PASSWORD=… PLAYWRIGHT_BASE_URL=http://127.0.0.1:<web> npx playwright test sheet-bulk-autosave
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test, type Page, type Request } from '@playwright/test'

const env = {
  api: process.env.E2E_API_URL,
  email: process.env.E2E_EMAIL,
  password: process.env.E2E_PASSWORD,
  database: process.env.E2E_DATABASE_URL,
}
const FAMILY = 'e2e_bulk_autosave'
const ROWS = 500
const THEME = { id: 'e2e_theme_a', label: 'E2E Theme A' }
const COLUMN = 'descriptionThemeId'

const cell = (page: Page, rowIndex: number) => page.locator(`.ag-row[row-index="${rowIndex}"] .ag-cell[col-id="${COLUMN}"]`)

test.describe('product sheet — one operation, one save', () => {
  test.skip(!env.api || !env.email || !env.password || !env.database,
    'Needs E2E_API_URL, E2E_EMAIL, E2E_PASSWORD and E2E_DATABASE_URL (a LOCAL stack) — see the header of this file.')
  test.setTimeout(300_000)
  // Wide enough that the column and its fill handle are fully on screen, never under the scrollbar.
  test.use({ viewport: { width: 1680, height: 1000 } })

  test.beforeAll(() => {
    // The seed refuses any database that is not on this machine.
    execFileSync(process.execPath, [join(__dirname, 'fixtures', 'bulk-autosave-seed.mjs'), String(ROWS)],
      { env: { ...process.env, E2E_DATABASE_URL: env.database }, stdio: 'inherit' })
  })

  test(`fills ${ROWS} rows with the fill handle as ONE request and stores every value`, async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(env.email!)
    await page.getByLabel('Password').fill(env.password!)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'))

    const bulkSaves: Request[] = []
    const rowPatches: Request[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path === '/api/products/bulk-save') bulkSaves.push(request)
      if (request.method() === 'PATCH' && path === '/api/products/bulk') rowPatches.push(request)
    })

    await page.goto(`/products/${FAMILY}/edit/studio?scope=EBAY&market=IT`)
    await expect(page.locator('.ag-row[row-index="1"]')).toBeVisible({ timeout: 60_000 })

    // Keyboard to the column: focusing a cell makes the grid scroll the column into view.
    await page.locator('.ag-row[row-index="1"] .ag-cell').nth(1).click()
    for (let i = 0; i < 80; i++) {
      if (await page.locator('.ag-cell-focus').getAttribute('col-id') === COLUMN) break
      await page.keyboard.press('ArrowRight')
    }
    await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', COLUMN)

    // Row 1 gets the value the drag will copy (its own one-cell save).
    await page.keyboard.press('Enter')
    await page.getByText(THEME.label, { exact: true }).click()
    await expect.poll(() => bulkSaves.length).toBe(1)
    await expect(cell(page, 1)).toContainText(THEME.label)
    // Its save settled and its "saved" mark faded, so no repaint of that cell lands in the middle of the drag.
    await expect(cell(page, 1)).not.toHaveClass(/nds-cell-is-(saving|saved|waiting)/, { timeout: 30_000 })
    // Bring the column to the middle, away from the scrollbar that would sit over its fill handle.
    await cell(page, 1).evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }))
    await page.waitForTimeout(300)
    await cell(page, 1).click()

    // The drag: hold the fill handle, scroll with the wheel while holding it, keep the pointer on the deepest row.
    const handle = page.locator('.ag-fill-handle')
    await expect(handle).toBeVisible()
    // The point a real pointer must press: one the handle itself owns (its corner can sit under the next row).
    const grip = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect()
      for (const [x, y] of [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 1, r.y + 1], [r.x + 2, r.y + 2]]) {
        if (document.elementFromPoint(x, y) === el) return { x, y }
      }
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { x: -1, y: -1, top: top ? `${top.tagName}.${top.className}` : 'nothing' }
    })
    expect(grip.x, `the fill handle is covered by ${'top' in grip ? grip.top : '?'}`).toBeGreaterThan(0)
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x, grip.y + 30, { steps: 4 })
    const third = (await cell(page, 3).boundingBox())!
    await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2, { steps: 4 })
    // The deepest row whose cell is fully ON SCREEN (the grid also renders rows below the viewport, off screen).
    const deepestOnScreen = () => page.evaluate((column) => {
      const viewport = document.querySelector('.ag-body-viewport, .ag-grid-viewport')!.getBoundingClientRect()
      // On screen = the pointer at the cell's centre lands on THAT cell (not on the footer or a scrollbar over it).
      const onScreen = [...document.querySelectorAll<HTMLElement>(`.ag-cell[col-id="${column}"]`)]
        .map((el) => ({ el, row: Number(el.closest('.ag-row')?.getAttribute('row-index')), r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => r.top >= viewport.top + 40 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.ag-cell') === el)
        .sort((a, b) => b.row - a.row)[0]
      return onScreen ? { row: onScreen.row, x: onScreen.r.x + onScreen.r.width / 2, y: onScreen.r.y + onScreen.r.height / 2 } : null
    }, COLUMN)
    let deepest = await deepestOnScreen()
    for (let i = 0; i < 400 && (deepest?.row ?? 0) < ROWS; i++) {
      await page.mouse.wheel(0, 900)
      deepest = await deepestOnScreen()
      if (deepest) await page.mouse.move(deepest.x, deepest.y, { steps: 2 })
    }
    expect(deepest?.row).toBe(ROWS)
    // The grid reads the pointer on its next frame; release only after it has had one on row 500.
    await page.mouse.move(deepest!.x + 2, deepest!.y, { steps: 2 })
    await page.waitForTimeout(300)
    await page.mouse.up()

    // ONE request for the whole operation, never one per row.
    await expect.poll(() => bulkSaves.length, { timeout: 30_000 }).toBe(2)
    const operation = bulkSaves[1]
    expect((operation.postDataJSON() as { units: unknown[] }).units).toHaveLength(ROWS - 1)
    const answer = await (await operation.response())!.json() as { saved: number; failed: number }
    expect(answer).toMatchObject({ saved: ROWS - 1, failed: 0 })
    expect(rowPatches).toHaveLength(0)
    await expect(page.locator('.nds-grid-sheet-status')).toContainText('Saved', { timeout: 60_000 })
    await expect(page.locator('.nds-grid-sheet-status')).not.toContainText('Saving')
    expect(bulkSaves).toHaveLength(2)

    // Every value is STORED: read the sheet back from the API, not from the grid.
    const read = await page.request.get(`${env.api}/api/products/${FAMILY}/studio/sheet?scope=channel&channel=EBAY&market=IT&locale=it`)
    expect(read.ok()).toBe(true)
    const sheet = await read.json() as { rows: Array<{ rowKind: string; sku: string; values: Record<string, { value: unknown }> }> }
    const variants = sheet.rows.filter((row) => row.rowKind === 'variant')
    expect(variants).toHaveLength(ROWS)
    expect(variants.filter((row) => row.values[COLUMN]?.value !== THEME.id).map((row) => row.sku)).toEqual([])
  })
})
