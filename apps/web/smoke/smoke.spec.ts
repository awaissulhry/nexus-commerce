/**
 * @smoke journeys — each one crosses web → proxy → API → PostgreSQL (with row-level security) and back.
 * Seeded by scripts/ci/seed-smoke.mts; the owner is signed in once by global-setup.ts.
 */
import { expect, test } from '@playwright/test'
import { authenticatedStudioPage } from '../../../scripts/studio-browser-auth.mjs'
import { smokeSeed } from './seed'

const seed = smokeSeed()
const A = seed.workspaces.a
const B = seed.workspaces.b
const [a1, a2] = seed.products[A]
const [b1] = seed.products[B]

test.describe('@smoke', () => {
  test('the sign-in page renders for a signed-out visitor', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    await page.goto('/login')
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await context.close()
  })

  test('the products page lists this business\'s products', async ({ page }) => {
    await page.goto(`/w/${A}/products`)
    await expect(page.getByText(a1.name).first()).toBeVisible()
    await expect(page.getByText(a2.name).first()).toBeVisible()
  })

  test('a product opens in the editor', async ({ page }) => {
    await page.goto(`/w/${A}/products/${a1.id}/edit`)
    await expect(page.getByText(a1.sku).first()).toBeVisible()
  })

  test('the orders page loads', async ({ page }) => {
    const response = await page.goto(`/w/${A}/orders`)
    expect(response?.status()).toBeLessThan(400)
    await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0)
  })

  test('the settings page loads', async ({ page }) => {
    const response = await page.goto(`/w/${A}/settings`)
    expect(response?.status()).toBeLessThan(400)
    await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0)
  })

  test('a business sees only its own products', async ({ page }) => {
    await page.goto(`/w/${B}/products`)
    await expect(page.getByText(b1.name).first()).toBeVisible()
    await expect(page.getByText(a1.name)).toHaveCount(0)
    await expect(page.getByText(a2.name)).toHaveCount(0)
  })

  test('signing out ends the session', async ({ browser, baseURL }) => {
    // Its own sign-in: signing out the shared session would sign out every other test.
    process.env.STUDIO_TEST_EMAIL = seed.email
    process.env.STUDIO_TEST_PASSWORD = seed.password
    const page = await authenticatedStudioPage(browser, { base: baseURL!, viewport: { width: 1280, height: 800 } })
    await page.goto('/login')
    const after = await page.evaluate(async () => {
      const csrf = await fetch('/backend/api/auth/csrf', { credentials: 'include' })
      const token = (await csrf.json()).csrfToken
      const out = await fetch('/backend/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'x-nexus-csrf': token } })
      const me = await fetch('/backend/api/auth/me', { credentials: 'include' })
      const body = await me.json().catch(() => ({}))
      return { logout: out.status, me: me.status, user: Boolean(body?.user) }
    })
    expect(after.logout).toBeLessThan(400)
    expect(after.user).toBe(false)
    await page.context().close()
  })
})
