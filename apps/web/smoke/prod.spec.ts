/** @prod — read-only checks after a production deployment. GET only; nothing signs in or writes. */
import { expect, test } from '@playwright/test'

test.describe('@prod', () => {
  test('the sign-in page renders', async ({ page }) => {
    const response = await page.goto('/login')
    expect(response?.status()).toBeLessThan(400)
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('the web proxy reaches a healthy API', async ({ request }) => {
    const response = await request.get('/backend/api/health/ready')
    expect(response.status()).toBe(200)
    expect((await response.json()).status).toBe('healthy')
  })

  test('the page\'s own scripts and styles load', async ({ page }) => {
    const assets: { url: string; status: number }[] = []
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/_next/static/')) assets.push({ url: response.url(), status: response.status() })
    })
    // 'load', not 'networkidle': the sign-in page keeps a request open, so the network never goes idle
    // (measured on the first production run, 2026-09-26: three 30 s timeouts).
    await page.goto('/login', { waitUntil: 'load' })
    expect(assets.length, 'no /_next/static asset was requested — the check would measure nothing').toBeGreaterThan(0)
    expect(assets.filter(asset => asset.status >= 400)).toEqual([])
  })
})
