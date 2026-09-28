/**
 * The Product media cell pop-up (Lane C, docs/product-media-popup/PLAN-2026-09-28.md §7 L7), on the lab page
 * /design/media-popup — the production pop-up on a made-up family on the photo plan and a made-up product with its own
 * list, answered in the page. No auth, no API writes, no store.
 *
 * What is asserted, each the thing that would actually break:
 *  - it opens under the cell from the keyboard, with focus on the main photo, and Tab never leaves it;
 *  - Enter sends ONE save (the lab counts them) and every size of the colour shows it; Esc and open + close send none;
 *  - a click outside saves; a refused save keeps the pop-up open, says why, and holds that click back;
 *  - someone else's change is refused with the plain sentence; the cells keep theirs, not mine;
 *  - the photo drag is live (the photo lifts and moves with the pointer, the others slide);
 *  - no test sends a write to a real API: every non-GET to `/api/` or `/backend/api/` is stopped and fails the test;
 *  - the older gallery: this language's alt text, a video's transcript saved with Ctrl/⌘ + Enter, eBay's own checks;
 *  - phone width: a sheet across the screen, 12 px each side; light and dark; no console errors.
 *
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:3111 npx playwright test media-popup-lab
 */
import { expect, test, type Page } from '@playwright/test'

const panel = (page: Page) => page.locator('[role="dialog"][aria-label^="Product media"]')
const notice = (page: Page) => page.locator('.nds-banner').filter({ hasText: 'saved in the lab' })
const cellCount = (page: Page, sku: string) => page.locator(`[aria-label^="Product media: ${sku},"]`).getAttribute('aria-label')
const firstPhoto = (page: Page, sku: string) => page.locator(`[aria-label^="Product media: ${sku},"] .nds-media-strip-thumbnail img`).first().getAttribute('src')
const saves = (page: Page) => page.locator('#main-content').getByText(/^Saves received by the lab: \d+$/)

/** The lab answers its own paths in the page; anything that still reaches the network as a write is stopped and fails. */
let apiWrites: string[] = []
test.beforeEach(async ({ page }) => {
  apiWrites = []
  const write = (method: string, url: string) => method !== 'GET' && method !== 'HEAD' && /\/(backend\/)?api\//.test(new URL(url).pathname)
  page.context().on('request', request => { if (write(request.method(), request.url())) apiWrites.push(`${request.method()} ${request.url()}`) })
  await page.route(/\/(backend\/)?api\//, route => write(route.request().method(), route.request().url()) ? route.abort() : route.continue())
})
test.afterEach(() => { expect(apiWrites).toEqual([]) })

/** The lab page has no signed-in user: the page frame's own "who am I" and notifications reads answer 401. */
function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error' && !/status of 401/.test(message.text())) errors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400 && !/\/api\/(auth\/me|notifications)/.test(response.url())) errors.push(`${response.status()} ${response.url()}`) })
  return errors
}

async function openLab(page: Page) {
  await page.goto('/design/media-popup')
  await expect(page.getByRole('button', { name: /^LAB-JACKET-BLACK-S/ })).toBeVisible({ timeout: 30_000 })
}
/** Opens a row's pop-up from the keyboard and waits until it can edit ("+ Add" shows once its read has arrived). */
async function openRow(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).focus()
  await page.keyboard.press('Enter')
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('button', { name: '+ Add' })).toBeVisible()
  await expect(panel(page).locator('.nds-media-board-thumb').first()).toBeFocused()
}
const toggle = (page: Page, name: string) => page.getByRole('checkbox', { name, exact: true }).check()

test.describe('Product media pop-up — photo plan', () => {
  test('keyboard: opens with focus on the main photo; Tab stays inside; M + Enter sends one save for every size of the colour', async ({ page }) => {
    const errors = watchErrors(page)
    await openLab(page)
    await expect(saves(page)).toHaveText('Saves received by the lab: 0')
    await openRow(page, /^LAB-JACKET-BLACK-S/)
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label^="Product media"]'))).toBe(true)
    }
    await panel(page).locator('.nds-media-board-thumb').first().focus()
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('m'); await page.keyboard.press('Enter')
    await expect(panel(page)).toHaveCount(0)
    await expect(notice(page)).toHaveCount(1)
    await expect(saves(page)).toHaveText('Saves received by the lab: 1')
    for (const sku of ['LAB-JACKET-BLACK-S', 'LAB-JACKET-BLACK-M', 'LAB-JACKET-BLACK-L'])
      expect(await firstPhoto(page, sku)).toContain('black-side')
    expect(errors).toEqual([])
  })

  test('Esc after a change, and open + close with no change, save nothing', async ({ page }) => {
    await openLab(page)
    const before = await cellCount(page, 'LAB-JACKET-BLACK-S')
    await openRow(page, /^LAB-JACKET-BLACK-S/)
    await page.keyboard.press('Delete'); await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
    await openRow(page, /^LAB-JACKET-BLACK-S/)
    await page.keyboard.press('Enter')
    await expect(panel(page)).toHaveCount(0)
    await expect(notice(page)).toHaveCount(0)
    await expect(saves(page)).toHaveText('Saves received by the lab: 0')
    expect(await cellCount(page, 'LAB-JACKET-BLACK-S')).toBe(before)
  })

  test('a click outside saves; a refused save stays open, says why, and holds the click back', async ({ page }) => {
    await openLab(page)
    await openRow(page, /^LAB-JACKET-BLACK-S/)
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('m')
    await page.getByRole('heading', { name: 'Product media pop-up lab' }).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(notice(page)).toHaveCount(1)

    await toggle(page, 'The server refuses my next save')
    await openRow(page, /^LAB-JACKET-GREY-S/)
    await page.keyboard.press('Delete')
    await page.getByRole('button', { name: /^LAB-JACKET-GREY-M/ }).click()
    await expect(panel(page)).toContainText('Not saved: Someone else changed these photos at the same moment.')
    await expect(panel(page)).toHaveAttribute('aria-label', 'Product media: LAB-JACKET-GREY-S')
  })

  test('someone else changed the set while it was open: refused with the plain sentence; the cells keep theirs, not mine', async ({ page }) => {
    await openLab(page)
    const count = (label: string | null) => Number(/, (\d+) media items?/.exec(label ?? '')?.[1])
    const before = count(await cellCount(page, 'LAB-JACKET-BLACK-M'))
    await toggle(page, 'Someone else changes the set before my next save lands')
    await openRow(page, /^LAB-JACKET-BLACK-M/)
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('m'); await page.keyboard.press('Enter')
    await expect(panel(page)).toContainText('Not saved: Someone changed these photos while this pop-up was open. Nothing was changed.')
    await expect(notice(page)).toHaveCount(0)
    // Their change (the last photo out) is in every size of the colour; mine (side photo first) is not.
    for (const sku of ['LAB-JACKET-BLACK-S', 'LAB-JACKET-BLACK-M', 'LAB-JACKET-BLACK-L']) {
      await expect.poll(async () => count(await cellCount(page, sku))).toBe(before - 1)
      expect(await firstPhoto(page, sku)).not.toContain('black-side')
    }
  })

  test('the drag is live: the photo lifts and follows, the others slide', async ({ page }) => {
    await openLab(page)
    await openRow(page, /^LAB-JACKET · Common/)
    const tiles = panel(page).locator('.nds-media-board-thumb')
    await expect(tiles).toHaveCount(3)
    const a = (await tiles.nth(0).boundingBox())!, c = (await tiles.nth(2).boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down()
    for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + a.width / 2 + ((c.x - a.x + 12) * i) / 12, a.y + a.height / 2 + ((c.y - a.y) * i) / 12)
    const items = panel(page).locator('.nds-media-board-list > li')
    await expect(items.nth(0)).toHaveAttribute('data-sort-state', 'lifted')
    await expect(items.nth(1)).toHaveAttribute('data-sort-state', 'shifted')
    // The lifted photo is under the pointer (it moved), not left in its slot.
    const lifted = (await tiles.nth(0).boundingBox())!
    expect(lifted.x - a.x).toBeGreaterThan((c.x - a.x) / 2)
    await page.mouse.up()
    await expect(tiles.nth(2)).toHaveAttribute('aria-label', /^front, position 3 of 3/)
  })
})

test.describe('Product media pop-up — a product with its own list', () => {
  test('alt text in this language (Enter in the field saves); a video\'s transcript (Ctrl/⌘ + Enter saves)', async ({ page }) => {
    const errors = watchErrors(page)
    await openLab(page)
    await openRow(page, /^LAB-CAP/)
    await expect(panel(page)).toContainText('Italian · own list')
    await panel(page).locator('.nds-media-board-thumb').nth(1).click()
    const alt = panel(page).getByLabel(/Alt text · Italian/)
    await alt.fill('Berretto, retro'); await alt.press('Enter')
    await expect(panel(page)).toHaveCount(0)
    await openRow(page, /^LAB-CAP/)
    await expect(panel(page)).toContainText('Berretto, retro')
    await panel(page).getByRole('button', { name: '+ Add' }).click()
    await panel(page).getByLabel('Select cap clip').check()
    await panel(page).getByRole('button', { name: '− Close' }).click()
    await panel(page).locator('.nds-media-board-thumb').last().click()
    const transcript = panel(page).getByLabel('Transcript')
    await transcript.fill('The cap turns around.'); await transcript.press('Control+Enter')
    await expect(panel(page)).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('an eBay listing: that channel\'s own checks, before any save', async ({ page }) => {
    await openLab(page)
    await page.getByRole('radio', { name: 'eBay IT listing' }).click()
    await openRow(page, /^LAB-CAP/)
    await expect(panel(page)).toContainText('Follows the shared product')
    await panel(page).getByRole('button', { name: '+ Add' }).click()
    await panel(page).getByLabel('Select cap label').check()
    await expect(panel(page).locator('ul[aria-label="Checks"]')).toContainText('cap label is 420 px — eBay needs 500 px on the longest side.')
    await expect(panel(page).locator('ul[aria-label="Checks"]')).toContainText('You can save. Publishing to eBay stays blocked until it is fixed.')
  })
})

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`phone width, ${colorScheme}`, () => {
    test.use({ viewport: { width: 390, height: 780 }, colorScheme })
    test('a sheet across the screen, 12 px each side, nothing sticks out', async ({ page }) => {
      const errors = watchErrors(page)
      await openLab(page)
      await openRow(page, /^LAB-JACKET-BLACK-S/)
      const box = (await panel(page).boundingBox())!
      expect(Math.round(box.x)).toBe(12)
      expect(Math.round(box.width)).toBe(390 - 24)
      const outside = await panel(page).evaluate(p => { const b = p.getBoundingClientRect(); return [...p.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > b.right + 1 || r.left < b.left - 1) }).length })
      expect(outside).toBe(0)
      expect(errors).toEqual([])
    })
  })
}
