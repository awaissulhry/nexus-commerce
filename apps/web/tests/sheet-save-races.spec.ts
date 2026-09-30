/** Local-only save/reload races. The caller seeds and removes the synthetic E2E_ALIAS_FIXTURE. */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'

const fixture = process.env.E2E_ALIAS_FIXTURE ? JSON.parse(readFileSync(process.env.E2E_ALIAS_FIXTURE, 'utf8')) as { family: string; child: string } : null
const auth = process.env.E2E_AUTH_STATE
const api = process.env.E2E_API_URL ?? 'http://localhost:4006'
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3006'
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)

async function fieldCell(page: Page, key: string) {
  await page.keyboard.press('Escape')
  const focused = page.locator('.ag-cell-focus')
  const row = page.locator(`.ag-row[row-id="${fixture!.child}"]`)
  // Reload removes focus while keeping horizontal scroll; focus a rendered cell before Home.
  await (await focused.count() ? focused : row.locator('.ag-cell').first()).press('Home')
  await row.locator('.ag-cell[col-id="ag-Grid-AutoColumn"]').click({ position: { x: 100, y: 3 } })
  for (let i = 0; i < 70 && await page.locator('.ag-cell-focus').getAttribute('col-id') !== key; i++) await page.keyboard.press('ArrowRight')
  await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', key)
  return row.locator(`.ag-cell[col-id="${key}"]`)
}
async function edit(page: Page, key: string, value: string) {
  await fieldCell(page, key)
  await page.keyboard.press('Enter')
  const input = page.locator('.ag-cell-inline-editing input, .ag-popup-editor textarea, .ag-popup-editor input').first()
  await expect(input).toBeVisible()
  await input.fill(value)
  const pending = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/products/bulk-save'))
  await page.keyboard.press('Enter')
  const response = await pending
  return { request: response.request().postDataJSON(), body: await response.json() }
}
test.describe('product sheet save snapshots', () => {
  test.skip(!fixture || !auth || !process.env.E2E_DATABASE_URL, 'Needs a synthetic local fixture, private database and local auth state.')
  test.use({ storageState: auth, actionTimeout: 15_000 })
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test('a read during a Shared save keeps the next text cell writable', async ({ page }) => {
    if (!local(base) || !local(api) || ![fixture!.family, fixture!.child].every(id => id.startsWith('e2e_'))) throw new Error('Synthetic local fixture required')
    let holdRead = false, holdSave = false, readReady = false, saveReady = false, blockReads = false
    let releaseRead!: () => void, releaseSave!: () => void
    await page.route('**/*', async route => {
      const url = route.request().url()
      if (!local(url)) return route.abort()
      if (holdRead && url.includes('/studio/sheet?')) {
        holdRead = false
        const plain = new URL(url); plain.searchParams.delete('cells')
        const response = await route.fetch({ url: plain.toString() }), body = await response.json()
        expect(response.ok()).toBe(true)
        // This visible witness proves React adopted this old read before the save reply arrives.
        body.rows.find((row: { id: string }) => row.id === fixture!.child).sku = 'E2E-OLD-READ-WITNESS'
        await new Promise<void>(resolve => { releaseRead = resolve; readReady = true })
        return route.fulfill({ response, json: body })
      }
      if (blockReads && url.includes('/studio/sheet?')) return route.abort()
      if (holdSave && route.request().method() === 'POST' && url.endsWith('/api/products/bulk-save')) {
        holdSave = false
        const response = await route.fetch()
        await new Promise<void>(resolve => { releaseSave = resolve; saveReady = true })
        return route.fulfill({ response })
      }
      return route.continue()
    })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.goto(`/w/${LEGACY_WORKSPACE_ID}/products/${fixture!.family}/edit/studio?scope=master&market=DE&locale=de`)
    await expect(page.locator(`.ag-row[row-id="${fixture!.child}"]`)).toBeVisible({ timeout: 90_000 })
    holdRead = true
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Refresh progress/ }).click()
    await expect.poll(() => readReady).toBe(true)
    holdSave = true
    const first = edit(page, 'name', `Held title ${Date.now()}`)
    try {
      await expect.poll(() => saveReady).toBe(true)
      blockReads = true // A follow-up read must not repair a missing reply token for this test.
      releaseRead()
      await page.keyboard.press('Home')
      await expect(page.locator(`.ag-row[row-id="${fixture!.child}"]`)).toContainText('E2E-OLD-READ-WITNESS')
      releaseSave()
      const confirmed = await first
      expect(confirmed.body.failed).toBe(0)
      const final = `Description after read ${Date.now()}`
      const second = await edit(page, 'description', final)
      expect(second.body).toMatchObject({ saved: 1, failed: 0, units: [{ status: 200, body: { errors: [] } }] })
      expect(second.request.units[0].changes[0].contentVersion).toBe(confirmed.body.units[0].body.contentVersions[0].version)
      blockReads = false
      await page.reload()
      await expect(await fieldCell(page, 'description')).toContainText(final)
    } finally { releaseRead?.(); releaseSave?.(); await first.catch(() => undefined) }
  })

  for (const width of [1680, 390]) for (const colorScheme of ['light', 'dark'] as const) {
    test(`${colorScheme}, ${width}px: reload after a conflict and cell copy accepts a recreated translation`, async ({ page }, info) => {
      if (!local(base) || !local(api) || ![fixture!.family, fixture!.child].every(id => id.startsWith('e2e_'))) throw new Error('Synthetic local fixture required')
      let oldRead: string | null = null, replayRead = false, blockReads = false
      await page.route('**/*', async route => {
        const url = route.request().url()
        if (!local(url)) return route.abort()
        if (url.includes('/studio/sheet?')) {
          if (replayRead && oldRead) {
            replayRead = false
            const witness = JSON.parse(oldRead)
            witness.rows.find((row: { id: string }) => row.id === fixture!.child).sku = 'E2E-COPY-OLD-READ'
            return route.fulfill({ status: 200, contentType: 'application/json', json: witness })
          }
          if (blockReads) return route.abort()
          if (oldRead === null) {
            const response = await route.fetch()
            oldRead = await response.text()
            return route.fulfill({ response, body: oldRead })
          }
        }
        return route.continue()
      })
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await page.addInitScript(theme => { localStorage.setItem('nexus:theme', theme) }, colorScheme)
      await page.goto(`/w/${LEGACY_WORKSPACE_ID}/products/${fixture!.family}/edit/studio?scope=master&market=DE&locale=de`)
      await expect(page.locator(`.ag-row[row-id="${fixture!.child}"]`)).toBeVisible({ timeout: 90_000 })
      const external = `Recreated ${width} ${colorScheme} ${Date.now()}`
      // Change only the synthetic translation outside this browser, as another writer would.
      const fresh = JSON.parse(execFileSync(process.execPath, [join(__dirname, 'fixtures/recreate-sheet-translation.mjs'), fixture!.child, external], { encoding: 'utf8' }))
      expect(fresh.contentVersion).toBe(1)
      blockReads = true
      const conflict = await edit(page, 'brand', `Stale brand ${Date.now()}`)
      expect(conflict.body.units[0].status).toBe(409)
      replayRead = true
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Refresh progress/ }).click()
      await expect.poll(() => replayRead).toBe(false)
      await page.locator(`.ag-row[row-id="${fixture!.child}"] .ag-cell`).first().press('Home')
      await expect(page.locator(`.ag-row[row-id="${fixture!.child}"]`)).toContainText('E2E-COPY-OLD-READ')
      // The real value setter copies this old cell. Its version confirmation must survive that copy.
      const copied = await edit(page, 'name', `Before fresh reload ${Date.now()}`)
      expect(copied.body.units[0].status).toBe(409)
      blockReads = false
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Reload/ }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(await fieldCell(page, 'name')).toContainText(external)
      const final = `After reload ${width} ${colorScheme} ${Date.now()}`
      const saved = await edit(page, 'name', final)
      expect(saved.body).toMatchObject({ saved: 1, failed: 0, units: [{ status: 200, body: { errors: [] } }] })
      expect(saved.request.units[0].expectedVersion).toBe(fresh.productVersion)
      expect(saved.request.units[0].changes[0].contentVersion).toBe(1)
      await page.screenshot({ path: info.outputPath('saved-after-conflict.png'), fullPage: true })
      await page.reload()
      await expect(await fieldCell(page, 'name')).toContainText(final)
    })
  }
})
