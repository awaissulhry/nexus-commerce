/**
 * Google Ads step 1a — the two Google surfaces in a real browser, every Google answer MOCKED (`page.route`), so no
 * Google account, no backend Google code and no production data is needed:
 *   - Settings › Channels: the Google card's "Choose accounts" opens the centred picker, and the picker works by
 *     keyboard alone (open a list, choose, Save) and sends the C3 body.
 *   - Ads › Google: no amount and no currency in any state without numbers; a campaign row opens its window (role
 *     dialog) with Enter; no horizontal scroll at 390 and 1440 px, light and dark; no page errors.
 *
 * Needs a signed-in LOCAL stack: PLAYWRIGHT_SESSION_COOKIE (the session cookie's value; its name is
 * PLAYWRIGHT_SESSION_COOKIE_NAME, default `nexus_session`) for the local API at PLAYWRIGHT_API_URL. Without it every
 * test is `fixme` (shown, not run), like the other auth-gated specs here. It refuses any base URL that is not local.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 PLAYWRIGHT_API_URL=http://localhost:8091 \
 *   PLAYWRIGHT_SESSION_COOKIE=… npx playwright test google-ads-surfaces
 *
 * Fixtures are made up: no business names, numbers or ids (the repo is public).
 */
import { expect, test, type Page } from '@playwright/test'

const COOKIE = process.env.PLAYWRIGHT_SESSION_COOKIE
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
const API = process.env.PLAYWRIGHT_API_URL ?? BASE
const LOCAL = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)

const ADS = { customerId: '1112223333', name: 'Test Shop Ads', currency: 'EUR', timeZone: 'Europe/Rome', isTest: true }

function googleAccount(state: string, withAds = true) {
  return {
    connectionId: 'conn_google_1',
    label: 'Google sign-in',
    state,
    stateText: '',
    authStatus: state === 'sign_in_needed' ? 'needs_reauth' : 'connected',
    missingProducts: state === 'permission_missing' ? ['ads'] : [],
    ads: withAds ? ADS : null,
    manager: null,
    merchantCenter: null,
    analytics: null,
    read: {
      lastReadAt: state === 'ok' ? '2026-10-13T06:30:00.000Z' : null,
      lastDataDay: state === 'ok' ? '2026-10-12' : null,
      nextReadAt: '2026-10-14T06:25:00.000Z',
      lastError: state === 'read_failed' ? 'Google did not answer.' : null,
    },
  }
}

const CHOICES = {
  missingProducts: [],
  ads: {
    customers: [
      { customerId: '1112223333', name: 'Test Shop Ads', currency: 'EUR', timeZone: 'Europe/Rome', isTest: true, direct: true, managers: [] },
      { customerId: '4445556666', name: 'Second Test Account', currency: 'EUR', timeZone: 'Europe/Rome', isTest: true, direct: true, managers: [] },
    ],
    error: null,
  },
  merchantCenter: { accounts: [], error: { code: 'not_registered', message: 'Not registered.' } },
  analytics: { properties: [{ propertyId: '321', name: 'Test property', accountName: 'Test analytics' }], error: null },
}

const METRICS = { impressions: 1000, clicks: 50, spendCents: 6000, conversions: 2.5, conversionValueCents: 24000, ctr: 0.05, avgCpcCents: 120, roas: 4, costPerConversionCents: 2400 }
const DAYS = [
  { date: '2026-10-10', provisional: false, read: true, ...METRICS },
  { date: '2026-10-11', provisional: false, read: false, impressions: null, clicks: null, spendCents: null, conversions: null, conversionValueCents: null, ctr: null, avgCpcCents: null, roas: null, costPerConversionCents: null },
  { date: '2026-10-12', provisional: true, read: true, ...METRICS },
]
const CAMPAIGN = {
  campaignId: 'cmp_1', externalCampaignId: '900001', name: 'Test search campaign', status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE',
  type: 'SEARCH', biddingStrategy: 'MAXIMIZE_CONVERSIONS', dailyBudgetCents: 5000, budgetShared: false, startDate: '2026-01-01', endDate: null,
  settingsReadAt: '2026-10-13T06:30:00.000Z', metrics: METRICS,
}

function overview(state: string) {
  const account = googleAccount(state, state !== 'choose_account')
  const ok = state === 'ok'
  return {
    accounts: state === 'not_connected' ? [] : [account],
    account: state === 'not_connected' ? null : account,
    window: { from: '2026-10-10', to: '2026-10-12', provisionalFrom: '2026-10-12' },
    currency: ok ? 'EUR' : null,
    timeZone: ok ? 'Europe/Rome' : null,
    dataAsOf: ok ? '2026-10-13T06:30:00.000Z' : null,
    coverage: { daysInWindow: 3, daysRead: ok ? 2 : 0, missingDays: ok ? ['2026-10-11'] : [] },
    totals: ok ? { ...METRICS, impressions: 2000, clicks: 100, spendCents: 12000, conversions: 5, conversionValueCents: 48000 } : null,
    previous: null,
    days: ok ? DAYS : [],
  }
}

async function signIn(page: Page) {
  await page.context().addCookies([{ name: process.env.PLAYWRIGHT_SESSION_COOKIE_NAME ?? 'nexus_session', value: COOKIE!, url: API }])
}

/** Every Google answer, and the Channels page's catalogue and accounts, from fixtures. Records the C3 bodies. */
async function mockGoogle(page: Page, state: string) {
  const saved: unknown[] = []
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/google-ads\/overview(\?|$)/, (r) => r.fulfill(json(overview(state))))
  await page.route(/\/api\/google-ads\/campaigns(\?|$)/, (r) => r.fulfill(json({ window: overview(state).window, currency: 'EUR', dataAsOf: null, coverage: overview(state).coverage, items: [CAMPAIGN], nextCursor: null, total: 1 })))
  await page.route(/\/api\/google-ads\/campaigns\/[^/]+\/days(\?|$)/, (r) => r.fulfill(json({ campaign: CAMPAIGN, currency: 'EUR', window: overview(state).window, coverage: overview(state).coverage, days: DAYS })))
  await page.route(/\/api\/google-ads\/campaigns\/[^/]+\/changes(\?|$)/, (r) => r.fulfill(json({ items: [{ changedAt: '2026-10-05T10:00:00Z', resourceType: 'CAMPAIGN', operation: 'UPDATE', changedFields: ['status'], source: 'google_automatic', sourceText: 'Google, automatically', summary: 'Status changed' }], coveredFrom: '2026-09-13T22:00:00.000Z', coveredThrough: '2026-10-13T06:00:00.000Z' })))
  await page.route(/\/api\/google-ads\/sync(\?|$)/, (r) => r.fulfill(json({ queued: false, reason: 'A read ran less than an hour ago.' })))
  await page.route(/\/api\/google-ads\/connections(\?|$)/, (r) => r.fulfill(json({ items: state === 'not_connected' ? [] : [googleAccount(state, state !== 'choose_account')] })))
  await page.route(/\/api\/google-ads\/connections\/[^/]+\/choices(\?|$)/, (r) => r.fulfill(json(CHOICES)))
  await page.route(/\/api\/google-ads\/connections\/[^/]+\/selection(\?|$)/, (r) => {
    saved.push(r.request().postDataJSON())
    return r.fulfill(json({ account: googleAccount('first_read_pending') }))
  })
  await page.route(/\/api\/cx\/channels(\?|$)/, (r) => r.fulfill(json({ channels: [{
    key: 'GOOGLE', channelType: 'GOOGLE', displayName: 'Google', available: true, authMode: 'oauth2', connectMode: 'website_oauth',
    permissionModel: 'oauth_scopes', requiredScopes: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/content', 'https://www.googleapis.com/auth/analytics.readonly'],
    reviewGatedScopes: [], regions: [], defaultRegion: null, refreshTokenLifetimeSec: null, rotatesRefreshToken: false, webhooks: null, sandbox: null, connectException: null, apiVersion: 'v25',
  }] })))
  await page.route(/\/api\/accounts(\?|$)/, (r) => r.fulfill(json({ accounts: state === 'not_connected' ? [] : [{
    id: 'conn_google_1', channel: 'GOOGLE', managedBy: 'oauth', label: 'Google sign-in', labelSource: 'signInName', labelIsPlaceholder: false, markets: [],
    health: 'ok', healthReason: null, isPrimary: true, isActive: true, tokenExpiresAt: null, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, authStatus: 'connected',
  }], notConnected: [] })))
  return saved
}

/** Uncaught page errors (network refusals of unmocked calls are not this spec's business). */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(m.text()) })
  return errors
}

test.describe('Google Ads surfaces (mocked Google)', () => {
  test.fixme(!COOKIE, 'needs PLAYWRIGHT_SESSION_COOKIE for a signed-in local stack')
  test.skip(!LOCAL(BASE) || !LOCAL(API), 'runs only against a local stack')

  test('the account picker works by keyboard and sends the C3 body', async ({ page }) => {
    await signIn(page)
    const errors = watchErrors(page)
    const saved = await mockGoogle(page, 'choose_account')
    await page.goto('/settings/channels?tab=connect')
    await page.getByRole('button', { name: 'Choose accounts' }).click()
    const dialog = page.getByRole('dialog', { name: 'Choose Google accounts' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Google has not registered Nexus with this Merchant Center account yet.')).toBeVisible()
    // Save is held until an account is chosen.
    await expect(dialog.getByRole('button', { name: 'Save and start reading' })).toHaveAttribute('aria-disabled', 'true')
    const adsPicker = dialog.getByLabel('Google Ads account')
    await adsPicker.focus()
    await page.keyboard.press('Enter')
    // Sorted by name: "Second Test Account", then "Test Shop Ads". Nothing is highlighted until a key moves.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(adsPicker).toContainText('Test Shop Ads')
    await dialog.getByRole('button', { name: 'Save and start reading' }).focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    expect(saved).toEqual([{ adsCustomerId: '1112223333', managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: null }])
    await expect(page.getByText('Google accounts saved.')).toBeVisible()
    expect(errors).toEqual([])
  })

  for (const state of ['not_connected', 'sign_in_needed', 'permission_missing', 'choose_account', 'first_read_pending']) {
    test(`Ads › Google shows no amount and no currency when ${state}`, async ({ page }) => {
      await signIn(page)
      const errors = watchErrors(page)
      await mockGoogle(page, state)
      await page.goto('/marketing/ads/google')
      const main = page.locator('main')
      await expect(main.getByRole('heading', { name: 'Google Ads' })).toBeVisible()
      await expect(main.locator('.nds-empty')).toBeVisible()
      const text = await main.innerText()
      expect(text).not.toMatch(/€|\bEUR\b|\d+\.\d{2}\b/)
      await expect(main.locator('.nds-metrics')).toHaveCount(0)
      await expect(main.locator('.recharts-wrapper')).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }

  test('Enter on a campaign row opens its window; a day not read says so', async ({ page }) => {
    await signIn(page)
    const errors = watchErrors(page)
    await mockGoogle(page, 'ok')
    await page.goto('/marketing/ads/google')
    await expect(page.getByText('Test search campaign')).toBeVisible()
    await page.locator('main').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('j')
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Test search campaign' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Not read')).toBeVisible()
    await expect(dialog.getByText('Changes in the last 30 days')).toBeVisible()
    await expect(dialog.getByText('Google, automatically')).toBeVisible()
    await expect(dialog.getByRole('button', { name: /pause|enable|resume/i })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    expect(errors).toEqual([])
  })

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [390, 1440]) {
      test(`Ads › Google fits ${width}px in ${colorScheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme })
        await page.setViewportSize({ width, height: 900 })
        await signIn(page)
        const errors = watchErrors(page)
        await mockGoogle(page, 'ok')
        await page.goto('/marketing/ads/google')
        await expect(page.getByText('Test search campaign')).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow).toBeLessThanOrEqual(0)
        expect(errors).toEqual([])
      })
    }
  }
})
