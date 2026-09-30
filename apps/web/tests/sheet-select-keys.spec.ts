/**
 * The product sheet's lists can be used with the keyboard and with one click (P0, 2026-09-30).
 *
 * The defects (measured in production 2026-09-29, eBay · IT "Country of origin"): Enter and Tab closed every list with its
 * OLD value — after the arrow keys, and after typing a filter — and moved on as if it had saved; one click on the cell's
 * chevron did nothing; typing into a selected cell lost the first letter; an open list (an eBay FREE_TEXT aspect) refused a
 * typed value. Only a mouse click on an option worked. These drive the REAL gestures and read the write off the wire.
 *
 * LOCAL ONLY, same stack as `sheet-bulk-autosave.spec.ts` (its header lists the variables): a web dev server
 * (PLAYWRIGHT_BASE_URL) on a LOCAL API (E2E_API_URL), a login on that API (E2E_EMAIL / E2E_PASSWORD — test values) and
 * the LOCAL database (E2E_DATABASE_URL), which `fixtures/bulk-autosave-seed.mjs` reseeds with a small made-up family.
 * Its eBay · IT listing columns need no category: "Package type" is an OPEN list of 29, "Condition" a strict one of 8.
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
const OPEN = 'packageType'
const STRICT = 'conditionId'

const cell = (page: Page, row: number, column: string) => page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="${column}"]`)
const popup = (page: Page) => page.locator('.ag-popup-editor')

async function focusCell(page: Page, row: number, column: string) {
  await page.keyboard.press('Escape')
  await page.locator(`.ag-row[row-index="${row}"] .ag-cell`).nth(1).click()
  for (let i = 0; i < 80; i++) {
    if (await page.locator('.ag-cell-focus').getAttribute('col-id') === column) break
    await page.keyboard.press('ArrowRight')
  }
  await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', column)
  return cell(page, row, column)
}

/** The changes a `bulk-save` carried, as `field = value`. */
const changesOf = (request: Request) => (request.postDataJSON() as { units: Array<{ changes: Array<{ field: string; value: unknown }> }> })
  .units.flatMap((unit) => unit.changes.map((change) => `${change.field} = ${JSON.stringify(change.value)}`))

test.describe('product sheet — lists by keyboard and by one click', () => {
  test.skip(!env.api || !env.email || !env.password || !env.database,
    'Needs E2E_API_URL, E2E_EMAIL, E2E_PASSWORD and E2E_DATABASE_URL (a LOCAL stack) — see the header of this file.')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  test.use({ viewport: { width: 1680, height: 1000 } })

  let page: Page
  const saves: Request[] = []

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(300_000)
    execFileSync(process.execPath, [join(__dirname, 'fixtures', 'bulk-autosave-seed.mjs'), '6'],
      { env: { ...process.env, E2E_DATABASE_URL: env.database }, stdio: 'inherit' })
    page = await browser.newPage()
    await page.goto('/login')
    await page.getByLabel('Email').fill(env.email!)
    await page.getByLabel('Password').fill(env.password!)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'))
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/products/bulk-save')) saves.push(request)
    })
    // Under the business the seed wrote to: a login in two businesses would otherwise land on the profile list.
    await page.goto(`/w/${process.env.E2E_WORKSPACE_ID ?? 'nexus_legacy_workspace'}/products/${FAMILY}/edit/studio?scope=EBAY&market=IT`)
    await expect(page.locator('.ag-row[row-index="1"]')).toBeVisible({ timeout: 90_000 })
  })
  test.afterAll(async () => { await page?.close() })

  test('Enter commits the option the arrows moved to, and moves down', async () => {
    const target = await focusCell(page, 1, OPEN)
    const before = saves.length
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const chosen = (await popup(page).locator('[role="option"].active').textContent())!
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeHidden()
    await expect(target).toContainText(chosen)
    await expect.poll(() => saves.length, { timeout: 30_000 }).toBe(before + 1)
    const sent = changesOf(saves[before])
    expect(sent, sent.join(' · ')).toHaveLength(1)
    expect(sent[0], sent.join(' · ')).not.toContain('null')
    await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', OPEN)
    await expect(page.locator('.ag-row[row-index="2"] .ag-cell-focus')).toBeVisible()
  })

  test('Enter after typing a filter commits the best match', async () => {
    const target = await focusCell(page, 2, OPEN)
    const before = saves.length
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeVisible()
    const label = (await popup(page).locator('[role="option"]').nth(6).textContent())!.trim()
    await page.keyboard.type(label.slice(0, 5), { delay: 80 })
    await expect(popup(page).locator('[role="option"].active')).toHaveText(label)
    await page.keyboard.press('Enter')
    await expect(target).toContainText(label)
    await expect.poll(() => saves.length, { timeout: 30_000 }).toBe(before + 1)
  })

  test('Tab commits the highlighted option and moves right', async () => {
    const target = await focusCell(page, 3, STRICT)
    const before = saves.length
    const old = await target.textContent()
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    await expect.poll(() => saves.length, { timeout: 30_000 }).toBe(before + 1)
    const sent = changesOf(saves[before])
    expect(sent, sent.join(' · ')).toHaveLength(1)
    await expect(target).not.toHaveText(old!)
    await expect(page.locator('.ag-cell-focus')).not.toHaveAttribute('col-id', STRICT)
  })

  test('Enter on a short list commits the option once (not also as a click on the focused option)', async () => {
    const target = await focusCell(page, 4, STRICT)
    const before = saves.length
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const chosen = (await page.evaluate(() => document.activeElement?.textContent ?? '')).trim()
    await page.keyboard.press('Enter')
    await expect(target).toContainText(chosen)
    await expect.poll(() => saves.length, { timeout: 30_000 }).toBe(before + 1)
    await page.waitForTimeout(2_000)
    expect(saves.length).toBe(before + 1)
  })

  test('Enter with nothing changed closes the list and writes nothing', async () => {
    await focusCell(page, 1, OPEN)
    const before = saves.length
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeHidden()
    await page.waitForTimeout(2_000)
    expect(saves.length).toBe(before)
  })

  test('an open list takes a typed value', async () => {
    const target = await focusCell(page, 4, OPEN)
    const typed = `E2E box ${Date.now().toString(36)}`
    const before = saves.length
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeVisible()
    await page.keyboard.type(typed, { delay: 30 })
    // Nothing in the list matches, so the typed value is the only row, highlighted: Enter takes it.
    await expect(popup(page).locator('[role="option"].active')).toHaveText(`Use "${typed}"`)
    await page.keyboard.press('Enter')
    await expect(target).toContainText(typed)
    await expect.poll(() => saves.length, { timeout: 30_000 }).toBe(before + 1)
    expect(changesOf(saves[before])[0]).toContain(JSON.stringify(typed))
  })

  test('one click on the chevron opens the list', async () => {
    const target = await focusCell(page, 5, STRICT)
    await page.keyboard.press('Escape')
    await target.locator('.nds-ag-chev').click()
    await expect(popup(page).locator('[role="option"]').first()).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('on a phone no column is pinned, so a list cell can be reached and opened with one tap', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    try {
      // The pinned Product column was wider than the screen: no other cell could be reached or tapped.
      await expect.poll(() => page.locator('.ag-pinned-left-header .ag-header-cell').count(), { timeout: 10_000 }).toBe(0)
      const target = cell(page, 5, STRICT)
      for (let i = 0; i < 60 && !(await target.isVisible() && (await target.boundingBox())!.x + (await target.boundingBox())!.width <= 390); i++) {
        await page.mouse.move(250, 700)
        await page.mouse.wheel(250, 0)
      }
      await target.locator('.nds-ag-chev').click()
      await expect(popup(page).locator('[role="option"]').first()).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
  })

  test('typing into a selected list cell keeps the first letter', async () => {
    await focusCell(page, 5, OPEN)
    await page.keyboard.type('B')
    await expect(popup(page).locator('input')).toHaveValue('B')
    await page.keyboard.press('Escape')
  })
})
