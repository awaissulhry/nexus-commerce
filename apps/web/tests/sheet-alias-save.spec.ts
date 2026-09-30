/**
 * Local browser proof for shared product tokens across listing aliases, on a synthetic two-alias eBay · DE family:
 * `fixtures/sheet-alias-seed.mjs` (primary and alias drafts on parent and child, German translations) — seeded in
 * `beforeAll` from E2E_DATABASE_URL, or handed in as a file through E2E_ALIAS_FIXTURE. The signed-in state comes from
 * E2E_AUTH_STATE (`fixtures/sheet-global-setup.ts` writes it). This changes only that family's shared and pinned German
 * titles. No production URL or live channel is allowed. Env: `fixtures/sheet-e2e.ts`; CI: the `sheet` job.
 */
import { expect, test, type Page } from '@playwright/test'
import { aliasFixture, aliasFixtureAvailable, isLocal as local, sheetEnv, studioPath, type AliasFixture } from './fixtures/sheet-e2e'

const auth = sheetEnv.auth
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
let fixture: AliasFixture | null = null
const studio = () => studioPath(fixture!.family, `scope=EBAY&market=DE&account=${fixture!.account}&locale=de`)

async function titleCell(page: Page, rowId: string) {
  const row = page.locator(`.ag-row[row-id="${rowId}"]`)
  await page.keyboard.press('Escape')
  const focused = page.locator('.ag-cell-focus')
  // A phone scrolls the identity column out of the DOM while Title is edited.
  if (await focused.count()) await focused.press('Home')
  await row.locator('.ag-cell[col-id="ag-Grid-AutoColumn"]').click({ position: { x: 100, y: 3 } })
  for (let i = 0; i < 20 && await page.locator('.ag-cell-focus').getAttribute('col-id') !== 'name'; i++) await page.keyboard.press('ArrowRight')
  await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', 'name')
  return row.locator('.ag-cell[col-id="name"]')
}

test.describe('an immediate shared save through a sibling alias', () => {
  test.skip(!aliasFixtureAvailable() || !auth, 'Needs E2E_DATABASE_URL (or E2E_ALIAS_FIXTURE) and E2E_AUTH_STATE — see fixtures/sheet-e2e.ts.')
  test.describe.configure({ mode: 'serial' })
  test.use({ storageState: auth })
  test.setTimeout(180_000)
  test.beforeAll(() => { fixture = aliasFixture() })

  for (const width of [1680, 390]) for (const colorScheme of ['light', 'dark'] as const) {
    test(`${colorScheme}, ${width}px: the second save uses the confirmed product version before a read`, async ({ page }, info) => {
      if (!local(base)) throw new Error('This test may only use a local web app and local API.')
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await page.addInitScript(theme => { localStorage.setItem('nexus:theme', theme) }, colorScheme)
      let blockSheetReads = false, completedReads = 0
      await page.route('**/*', async route => {
        const url = route.request().url()
        if (!local(url)) return route.abort()
        if (url.includes('/studio/sheet?') && blockSheetReads) return route.abort()
        return route.continue()
      })
      page.on('response', response => { if (response.url().includes('/studio/sheet?') && response.ok()) completedReads++ })
      await page.goto(studio(), { waitUntil: 'domcontentloaded' })
      const first = `primary:${fixture!.child}`, second = `${fixture!.alias}:${fixture!.child}`
      await expect(page.locator(`.ag-row[row-id="${first}"]`)).toBeVisible({ timeout: 90_000 })
      await expect.poll(() => page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(colorScheme === 'dark')
      const save = async (rowId: string, value: string) => {
        const target = await titleCell(page, rowId)
        await page.keyboard.press('Enter')
        const input = page.locator('.ag-cell-inline-editing input, .ag-popup-editor textarea, .ag-popup-editor input').first()
        await expect(input).toBeVisible()
        await input.fill(value)
        await page.keyboard.press('Enter')
        const result = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/products/bulk-save'))
        await page.getByRole('button', { name: 'Edit the shared German', exact: true }).click()
        const response = await result, body = await response.json()
        expect(response.status()).toBe(200)
        expect(body).toMatchObject({ saved: 1, failed: 0, units: [{ status: 200, body: { errors: [] } }] })
        await expect(target).toContainText(value)
        return { request: response.request().postDataJSON(), body }
      }
      blockSheetReads = true
      const readsBefore = completedReads
      const firstSave = await save(first, `Primary ${width} ${colorScheme} ${Date.now()}`)
      const finalTitle = `Alias ${width} ${colorScheme} ${Date.now()}`
      const secondSave = await save(second, finalTitle)
      expect(secondSave.request.units[0].expectedVersion).toBe(firstSave.body.units[0].body.currentVersion)
      expect(secondSave.request.units[0].changes[0].contentAddress).toEqual({ tier: 'language', language: 'de' })
      expect(completedReads).toBe(readsBefore)
      await page.screenshot({ path: info.outputPath('saved.png'), fullPage: true })
      blockSheetReads = false
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(await titleCell(page, first)).toContainText(finalTitle)
      await expect(await titleCell(page, second)).toContainText(finalTitle)
    })
  }

  test('a paste across aliases skips unchanged shared values and keeps the next edit writable', async ({ page }) => {
    if (!local(base)) throw new Error('This test may only use a local web app and local API.')
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin })
    let blockReads = false
    await page.route('**/*', route => {
      const url = route.request().url()
      if (!local(url) || blockReads && url.includes('/studio/sheet?')) return route.abort()
      return route.continue()
    })
    const primary = `primary:${fixture!.child}`, alias = `${fixture!.alias}:${fixture!.child}`
    await page.goto(studio())
    await expect(page.locator(`.ag-row[row-id="${primary}"]`)).toBeVisible({ timeout: 90_000 })
    blockReads = true
    const writes: unknown[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/products/bulk-save')) writes.push(request.postDataJSON())
    })
    const save = async (action: () => Promise<void>) => {
      const before = writes.length
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/products/bulk-save'))
      await action()
      const choice = page.getByRole('button', { name: 'Edit the shared German', exact: true })
      await expect.poll(async () => writes.length > before || await choice.isVisible()).toBe(true)
      if (writes.length === before) await choice.click()
      const answer = await response, body = await answer.json()
      expect(answer.status()).toBe(200)
      expect(body.failed).toBe(0)
      for (const unit of body.units) { expect(unit.status).toBe(200); expect(unit.body.errors ?? []).toEqual([]) }
      await expect(page.locator('.nds-cell-is-saving')).toHaveCount(0)
      expect(writes).toHaveLength(before + 1)
      return { request: answer.request().postDataJSON(), body }
    }
    const edit = (rowId: string, value: string) => save(async () => {
      await titleCell(page, rowId)
      await page.keyboard.press('Enter')
      const input = page.locator('.ag-cell-inline-editing input, .ag-popup-editor textarea, .ag-popup-editor input').first()
      await expect(input).toBeVisible()
      await input.fill(value)
      await page.keyboard.press('Enter')
    })
    const current = `Current ${Date.now()}`, next = `Next ${Date.now()}`, final = `Final ${Date.now()}`
    const initial = await edit(alias, current)
    // The old primary display remains until a read; the database already holds Current.
    await expect(await titleCell(page, primary)).not.toContainText(current)
    const parentTitle = (await (await titleCell(page, `${fixture!.alias}:${fixture!.family}`)).locator('.nds-cell-longtext-text').innerText()).trim()
    expect(parentTitle).toBe('German original')
    const batch = await save(async () => {
      await titleCell(page, primary)
      await page.evaluate(text => navigator.clipboard.writeText(text), [current, parentTitle, next].join('\n'))
      await page.keyboard.press('ControlOrMeta+V')
    })
    // This UI path filters the unchanged primary value. The lower-level regression separately
    // covers callers that do send a no-op and a changed alias together.
    expect(batch.request.units).toHaveLength(1)
    expect(batch.request.units[0]).toMatchObject({ expectedVersion: initial.body.units[0].body.currentVersion,
      changes: [{ id: fixture!.child, value: next }] })
    const confirmed = Math.max(...batch.body.units.map((unit: { body: { currentVersion: number } }) => unit.body.currentVersion))
    const last = await edit(primary, final)
    expect(last.request.units[0].expectedVersion).toBe(confirmed)
    blockReads = false
    await page.reload()
    await expect(await titleCell(page, primary)).toContainText(final)
    await expect(await titleCell(page, alias)).toContainText(final)
  })
  for (const width of [1680, 390]) for (const colorScheme of ['light', 'dark'] as const) {
    test(`${colorScheme}, ${width}px: an older sheet read keeps the next pin save writable`, async ({ page }, info) => {
      if (!local(base)) throw new Error('This test may only use a local web app and local API.')
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await page.addInitScript(theme => { localStorage.setItem('nexus:theme', theme) }, colorScheme)
      let snapshot: string | null = null, capture = false, replay = false, replays = 0
      await page.route('**/*', async route => {
        const url = route.request().url()
        if (!local(url)) return route.abort()
        if (url.includes('/studio/sheet?')) {
          if (replay && snapshot) {
            replay = false; replays++
            return route.fulfill({ status: 200, contentType: 'application/json', body: snapshot })
          }
          if (capture) {
            capture = false
            const response = await route.fetch()
            expect(response.ok()).toBe(true)
            snapshot = await response.text()
            return route.fulfill({ response, body: snapshot })
          }
        }
        return route.continue()
      })
      await page.goto(studio())
      const rowId = `primary:${fixture!.child}`
      await expect(page.locator(`.ag-row[row-id="${rowId}"]`)).toBeVisible({ timeout: 90_000 })
      await expect.poll(() => page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(colorScheme === 'dark')
      let writes = 0
      page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/products/bulk-save')) writes++ })
      const edit = async (value: string) => {
        await titleCell(page, rowId)
        await page.keyboard.press('Enter')
        const input = page.locator('.ag-cell-inline-editing input, .ag-popup-editor textarea, .ag-popup-editor input').first()
        await expect(input).toBeVisible()
        await input.fill(value)
        const before = writes
        const pending = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/products/bulk-save'))
        await page.keyboard.press('Enter')
        const pin = page.getByRole('button', { name: 'Pin on eBay · DE · de', exact: true })
        await expect.poll(async () => writes > before || await pin.isVisible()).toBe(true)
        if (writes === before) await pin.click()
        const response = await pending, body = await response.json()
        expect(response.status()).toBe(200)
        expect(body).toMatchObject({ saved: 1, failed: 0, units: [{ status: 200, body: { errors: [] } }] })
        await expect(page.locator('.nds-cell-is-saving')).toHaveCount(0)
        await expect(await titleCell(page, rowId)).toContainText(value)
        return { request: response.request().postDataJSON(), body }
      }
      const refresh = async () => {
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'More', exact: true }).click()
        await page.getByRole('menuitem', { name: /^Refresh progress/ }).click()
      }
      const old = `Pin before read ${width} ${colorScheme} ${Date.now()}`
      await edit(old)
      capture = true
      await refresh()
      await expect.poll(() => snapshot !== null).toBe(true)
      const confirmed = await edit(`Pin confirmed ${width} ${colorScheme} ${Date.now()}`)
      replay = true
      await refresh()
      await expect.poll(() => replays).toBe(1)
      // Fault injection is limited to one old read. All saves and the final read use the local API.
      await expect(await titleCell(page, rowId)).toContainText(old)
      const final = `Pin after old read ${width} ${colorScheme} ${Date.now()}`
      const next = await edit(final)
      expect(next.request.units[0].expectedVersion).toBe(confirmed.body.units[0].body.currentVersion)
      expect(next.request.units[0].changes[0].contentVersion).toBe(confirmed.body.units[0].body.contentVersions[0].version)
      await page.screenshot({ path: info.outputPath('saved-after-old-read.png'), fullPage: true })
      await page.reload()
      await expect(await titleCell(page, rowId)).toContainText(final)
    })
  }


})
