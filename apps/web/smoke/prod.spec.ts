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
    const failed: string[] = []
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/_next/static/') && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`)
    })
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    expect(failed).toEqual([])
  })
})
