/**
 * PressableRow — the keyboard/AT contract (hub #648).
 *
 * These assertions cannot live in apps/web's vitest suite: it is `environment: 'node'` with no
 * jsdom, no React plugin and no @testing-library, deliberately ("the day a test needs to render a
 * component, that is the day to add jsdom, and not before"). Tab order and accessible names are
 * also exactly the things jsdom approximates rather than reproduces, so a real browser is the
 * honest instrument, not a fallback.
 *
 * What is asserted, and why each one is the thing that would actually break:
 *  - the row's accessible name IS its visible label (no aria-label to drift from the screen);
 *  - a click on a nested control does NOT activate the row — the property that `z-index: 1` on
 *    `.nds-prow-actions` buys by construction, and that a descendant click guard would have had to
 *    re-earn on every surface;
 *  - Tab reaches the row's button, then each nested control in DOM order;
 *  - `aria-pressed` appears only on a row given `active`, because an action row is not a toggle.
 *
 * Runs against the DS catalog at /design-system. No auth.
 */
import { expect, test } from '@playwright/test'

const ROW = 'Open the September restock plan'
const TOGGLE = 'Only show out of stock'

/**
 * Everything is scoped to the story container. The catalog renders the whole DS on one page, so a
 * bare `getByRole('button', { name: 'Edit' })` is a strict-mode violation against an unrelated
 * component — a locator can be wrong in a way that looks like a component failure.
 */
// 🔴 `.first()` is not defensive padding. `/design-system` renders TokenCatalog TWICE — once inside
// the app shell and once at body level (the dark preview) — so every locator here resolves to two
// elements and three PressableRows appear as six. Measured, after a strict-mode violation pointed
// at it. Same shape as grid-lab hosting more than one grid.
const story = (page: import('@playwright/test').Page) => page.getByTestId('prow-story').first()

test.beforeEach(async ({ page }) => {
  await page.goto('/design-system')
  // Wait for the element to exist AND settle before scrolling: hydration re-renders the catalog,
  // and a handle taken before that detaches ("Element is not attached to the DOM").
  await expect(story(page).getByRole('button', { name: ROW })).toBeVisible()
  await story(page).scrollIntoViewIfNeeded()
})

test('the row exposes its visible label as its accessible name', async ({ page }) => {
  // getByRole matches on the accessible name, so this passing IS the assertion.
  await expect(story(page).getByRole('button', { name: ROW })).toHaveCount(1)
})

test('clicking a nested control does not activate the row', async ({ page }) => {
  const log = story(page).getByTestId('prow-log')
  await expect(log).toHaveText(/nothing yet/)

  await story(page).getByRole('checkbox', { name: 'Include in export' }).check()
  await expect(log).toHaveText(/checkbox → true/)
  await expect(log).not.toHaveText(/row opened/)

  await story(page).getByRole('button', { name: 'Edit' }).click()
  await expect(log).toHaveText(/nested button/)
  await expect(log).not.toHaveText(/row opened/)
})

test('clicking the row surface — including under the label — activates the row', async ({ page }) => {
  // Locator.click() scrolls the target into view first; page.mouse.click() does NOT, and the row
  // sits ~3800px down this catalog. An earlier version of this spec clicked into empty viewport and
  // failed against a component that was working — the probe was wrong, not the subject.
  const row = story(page).locator('.nds-prow').first()
  const box = (await row.boundingBox())!
  // A point in the row's dead space: past the label, clear of the actions region on the right.
  await row.click({ position: { x: box.width * 0.55, y: box.height / 2 } })
  await expect(story(page).getByTestId('prow-log')).toHaveText(/row opened/)
})

test('a click in the actions region does not reach the row, by construction', async ({ page }) => {
  // The complement of the test above, at the same y. The property that separates these two points is
  // `position: relative` on `.nds-prow-actions` — verified by mutation: making it `static` fails this
  // test and the nested-control one while the other five pass. Removing only `z-index: 1` fails
  // nothing, because DOM order already decides between two positioned elements at `z-index: auto`.
  const row = story(page).locator('.nds-prow').first()
  const box = (await row.boundingBox())!
  await row.click({ position: { x: box.width * 0.93, y: box.height / 2 } })
  await expect(story(page).getByTestId('prow-log')).not.toHaveText(/row opened/)
})

test('Tab reaches the row button, then each nested control in DOM order', async ({ page }) => {
  await story(page).getByRole('button', { name: ROW }).focus()
  const seen: string[] = []
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Tab')
    seen.push(
      await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null
        if (!a) return 'none'
        return a.getAttribute('aria-label') ?? a.textContent?.trim() ?? a.tagName
      }),
    )
  }
  expect(seen).toEqual(['Include in export', 'Edit'])
})

test('aria-pressed appears only on a row given `active`', async ({ page }) => {
  // An action row is not a toggle; claiming aria-pressed="false" would announce a state it lacks.
  await expect(story(page).getByRole('button', { name: ROW })).not.toHaveAttribute('aria-pressed', /.*/)

  const toggle = story(page).getByRole('button', { name: TOGGLE })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})

test('a disabled row does not activate', async ({ page }) => {
  const disabled = story(page).getByRole('button', { name: 'Disabled row' })
  await expect(disabled).toBeDisabled()
  await disabled.click({ force: true })
  await expect(story(page).getByTestId('prow-log')).not.toHaveText(/should never fire/)
})

/**
 * hub #657 — the three states PES.4's rows need. Each asserts BOTH that the right property is
 * present and that the wrong ones are absent: adopting the row would have traded one ratchet red
 * for three screen-reader regressions, and "aria-pressed on a disclosure" is exactly that shape.
 */
test('a disclosure row toggles aria-expanded, and never claims aria-pressed', async ({ page }) => {
  const row = story(page).getByRole('button', { name: 'Channel overrides' })
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await expect(row).not.toHaveAttribute('aria-pressed', /.*/)
  await row.press('Enter')
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(row).not.toHaveAttribute('aria-pressed', /.*/)
})

test('a current row exposes aria-current and never claims aria-pressed', async ({ page }) => {
  const row = story(page).getByRole('button', { name: 'Amazon UK' })
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(row).not.toHaveAttribute('aria-pressed', /.*/)
  await expect(row).not.toHaveAttribute('aria-expanded', /.*/)
})

test('a described row keeps the label as its NAME and carries the sentence as its DESCRIPTION', async ({ page }) => {
  const row = story(page).getByRole('button', { name: 'Xavia' })
  // The name is still the visible label — the whole point of describedby over aria-label.
  await expect(row).toHaveCount(1)
  // Resolve the description the way an AT client does: follow aria-describedby to its target.
  const described = await row.evaluate((el) => {
    const id = el.getAttribute('aria-describedby')
    if (!id) return null
    const target = document.getElementById(id)
    return target ? target.textContent : null
  })
  expect(described).toBe('inherited value; activate to pin an override')
  // …and the sentence must not be part of the visible label.
  await expect(row).toHaveText('Xavia')
})
