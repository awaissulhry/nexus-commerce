/**
 * Meta ads (steps 1 + 2) in a real browser, with EVERY API call answered by `page.route` from made-up fixtures shaped
 * like the contract (`src/lib/meta-ads/contract.ts`). No API, no database, no Meta account and no login are needed: the
 * web runs with business profiles off and auth not enforced, and `/api/auth/me` is mocked. A call the spec does not know
 * fails the test (`unmocked`), so a new call on these screens cannot reach a real server.
 *
 * What it holds:
 *   - Ads › Meta at 1440 and 390 px, light and dark: the totals, the graph and the three tabs; a day not read is
 *     "Not read", never a 0; Enter on a campaign row opens its window and Esc closes it; no write control, no sideways
 *     scroll;
 *   - (1440, light) the six states without numbers show no amount and no currency;
 *   - Settings › Channels (1440, light): Meta offers no sign-in popup; "Connect Meta" takes the three values (the secret
 *     and the token in password fields), sends them once, clears them; the asset picker holds an ad account another
 *     business picked, is used by keyboard and sends the selection body.
 *
 * Run it against a LOCAL web dev server whose API address is a dead port (every call must be mocked):
 *   cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:9 npx next dev -p 3000 -H 127.0.0.1
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test meta-ads-surfaces
 * It refuses any base URL that is not local. Fixtures are made up: no business names, numbers or ids (the repo is public).
 */
import { expect, test, type Page, type Route } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
const LOCAL = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)
const PAGE = '/marketing/ads/meta'

// ─── Fixtures (made up) ─────────────────────────────────────────────────

const READ_AT = '2026-10-20T06:52:00.000Z'
const WINDOW = { from: '2026-10-17', to: '2026-10-19', provisionalFrom: '2026-10-19' }
const COVERAGE = { daysInWindow: 3, daysRead: 2, missingDays: ['2026-10-18'] }

const metrics = (spendCents: number, clicks = 50) => ({
  impressions: clicks * 20, clicks, linkClicks: clicks - 10, spendCents, purchases: 2, purchaseValueCents: spendCents * 3, ctr: 0.05,
  cpcCents: Math.round(spendCents / clicks), cpmCents: Math.round(spendCents / clicks / 20 * 1000), roas: 3, costPerPurchaseCents: spendCents / 2,
})
const NOT_READ = { reach: null, impressions: null, clicks: null, linkClicks: null, spendCents: null, purchases: null, purchaseValueCents: null }
const DAYS = [
  { date: '2026-10-17', provisional: false, read: true, reach: 600, ...metrics(3000) },
  { date: '2026-10-18', provisional: false, read: false, ...NOT_READ },
  { date: '2026-10-19', provisional: true, read: true, reach: 500, ...metrics(2000) },
]

function metaConnection(state: string) {
  const chosen = state !== 'choose_account'
  return {
    connectionId: 'conn_meta_1', label: 'Meta', state, stateText: `The ${state.replace(/_/g, ' ')} sentence.`, authStatus: state === 'sign_in_needed' ? 'needs_reauth' : 'connected',
    systemUser: { id: '120000000000001', name: 'Test system user' }, appId: '1234567',
    token: { checkedAt: READ_AT, isValid: state !== 'token_problem', expiresAt: null, neverExpires: true, renewsFrom: null, lastRenewedAt: null, type: null, typeText: '',
      scopes: ['ads_read'], missing: [{ scope: 'pages_show_list', required: false, neededFor: 'list the Facebook Pages' }], problem: state === 'token_problem' ? 'The token was revoked.' : null },
    adAccount: chosen ? { adAccountId: '1234567890', name: 'Test Shop A', currency: 'EUR', timeZone: 'Europe/Rome', statusText: 'Active', businessId: null } : null,
    page: null, instagram: null, lastError: null,
    read: { lastReadAt: state === 'ok' ? READ_AT : null, lastDataDay: state === 'ok' ? '2026-10-19' : null, nextReadAt: '2026-10-21T06:50:00.000Z', lastStatus: null, lastError: null },
  }
}

function overview(state: string) {
  const c = state === 'not_connected' ? null : metaConnection(state)
  const numbers = state === 'ok'
  return {
    connections: c ? [c] : [], connection: c,
    account: numbers ? { adAccountId: '1234567890', name: 'Test Shop A', statusText: 'Active', accountStatus: 1, disableReason: 0, amountSpentCents: 150000, spendCapCents: null, balanceCents: 0, settingsReadAt: READ_AT, lastReadAt: READ_AT, lastSyncStatus: 'SUCCESS', lastSyncError: null } : null,
    window: WINDOW, currency: numbers ? 'EUR' : null, timeZone: numbers ? 'Europe/Rome' : null, dataAsOf: numbers ? READ_AT : null,
    coverage: numbers ? COVERAGE : { daysInWindow: 3, daysRead: 0, missingDays: [] },
    totals: numbers ? metrics(5000, 100) : null, previous: null, days: numbers ? DAYS : [],
  }
}

const CAMPAIGN = {
  campaignId: 'cmp_meta_1', metaCampaignId: '120000000000101', name: 'Test sales campaign', status: 'ACTIVE', effectiveStatus: 'ACTIVE',
  objective: 'OUTCOME_SALES', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', dailyBudgetCents: 5000, lifetimeBudgetCents: null,
  startTime: '2026-09-01T00:00:00Z', stopTime: null, settingsReadAt: READ_AT, metrics: metrics(5000, 100),
}
const AD_SET = {
  adSetId: 'ads_meta_1', metaAdSetId: '120000000000201', metaCampaignId: CAMPAIGN.metaCampaignId, name: 'Test ad set', status: 'ACTIVE', effectiveStatus: 'ACTIVE',
  optimizationGoal: 'OFFSITE_CONVERSIONS', billingEvent: 'IMPRESSIONS', bidStrategy: null, bidAmountCents: null, dailyBudgetCents: null, lifetimeBudgetCents: null,
  startTime: '2026-09-01T00:00:00Z', endTime: null, metrics: metrics(5000, 100),
}
const AD = {
  adId: 'ad_meta_1', metaAdId: '120000000000301', metaAdSetId: AD_SET.metaAdSetId, metaCampaignId: CAMPAIGN.metaCampaignId, name: 'Test ad', status: 'ACTIVE', effectiveStatus: 'ACTIVE',
  creative: { name: 'Test creative', title: null, body: 'A made-up summer jacket', objectType: 'SHARE', thumbnailUrl: null }, issues: null, metrics: metrics(5000, 100),
}
const listOf = <T>(items: T[]) => ({ window: WINDOW, currency: 'EUR', dataAsOf: READ_AT, coverage: COVERAGE, items, nextCursor: null, total: items.length })

const CHOICES = {
  systemUser: { id: '120000000000001', name: 'Test system user' },
  adAccounts: { items: [
    { adAccountId: '1234567890', name: 'Test Shop A', currency: 'EUR', timeZone: 'Europe/Rome', accountStatus: 1, statusText: 'Active', businessId: null, businessName: null, takenByAnotherBusiness: false },
    // Another business's account arrives as its id only.
    { adAccountId: '1234567891', takenByAnotherBusiness: true },
  ], error: null },
  pages: { items: [], error: null },
  instagram: { items: [], error: 'Meta did not list the Instagram accounts.' },
}

type Answer = { status?: number; body: unknown }
type Mock = { unmocked: string[]; writes: string[]; connects: unknown[]; saved: unknown[] }

function answerFor(path: string, state: string): Answer | undefined {
  switch (path) {
    // The app shell, the ads sidebar and the bell.
    case '/api/auth/csrf': return { body: { csrfToken: 'test-csrf-token' } }
    case '/api/auth/me': return { body: { user: { id: 'user_test', email: 'tester@example.com', displayName: 'Test Person', roleKeys: ['owner'], mfaEnabled: false, mfaRequired: false }, isOwner: true, permissions: [] } }
    case '/api/notifications': return { body: { rows: [], unreadCount: 0 } }
    case '/api/advertising/suggestions/count': return { body: { pending: 0 } }
    case '/api/advertising/connections': return { body: { items: [], markets: { markets: [] } } }
    case '/api/connections': return { body: { connections: [] } }
    case '/api/sidebar/counts': return { body: {} }
    case '/api/admin/push-health': return { body: { summary: { dlqDepth: 0 } } }
    // Meta (step 2 reads, step 1 connection).
    case '/api/meta-ads/overview': return { body: overview(state) }
    case '/api/meta-ads/campaigns': return { body: listOf([CAMPAIGN]) }
    case '/api/meta-ads/adsets': return { body: listOf([AD_SET]) }
    case '/api/meta-ads/ads': return { body: listOf([AD]) }
    case `/api/meta-ads/campaigns/${CAMPAIGN.campaignId}/days`: return { body: { campaign: CAMPAIGN, currency: 'EUR', window: WINDOW, coverage: COVERAGE, days: DAYS } }
    case '/api/meta-ads/connections': return { body: { items: state === 'not_connected' ? [] : [metaConnection(state)] } }
    case '/api/meta-ads/connections/conn_meta_1/choices': return { body: CHOICES }
    // Settings › Channels.
    case '/api/accounts': return { body: { accounts: [], notConnected: [] } }
    case '/api/google-ads/connections': return { body: { items: [] } }
    case '/api/cx/channels': return { body: { channels: [{
      key: 'META', channelType: 'META', displayName: 'Meta', available: true, authMode: 'api_key', connectMode: 'token_entry',
      permissionModel: 'oauth_scopes', requiredScopes: ['ads_read'], reviewGatedScopes: [], regions: [], defaultRegion: null,
      refreshTokenLifetimeSec: null, rotatesRefreshToken: false, webhooks: null, sandbox: null, connectException: null, apiVersion: 'v25.0',
    }] } }
  }
  return undefined
}

/** Answers every `/api/*` (and `/backend/api/*`) call from the fixtures, on whatever host the web was built to call. */
async function mockApi(page: Page, state = 'ok'): Promise<Mock> {
  const mock: Mock = { unmocked: [], writes: [], connects: [], saved: [] }
  await page.route((url) => /^\/(backend\/)?api\//.test(url.pathname), async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^\/backend/, '')
    const method = req.method()
    const reply = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (method === 'POST' && path === '/api/meta-ads/connect') {
      mock.connects.push(req.postDataJSON())
      return reply(200, { connectionId: 'conn_meta_1', placement: 'new', systemUser: { id: '120000000000001', name: 'Test system user' }, token: {}, adAccountsSeen: 2 })
    }
    if (method === 'PUT' && path === '/api/meta-ads/connections/conn_meta_1/selection') {
      mock.saved.push(req.postDataJSON())
      return reply(200, { connection: metaConnection('first_read_pending') })
    }
    if (method !== 'GET' && method !== 'HEAD') {
      if (path.startsWith('/api/meta-ads')) mock.writes.push(`${method} ${path}`)
      else mock.unmocked.push(`${method} ${path}`)
      return reply(405, { error: 'Not in this test.' })
    }
    const answer = answerFor(path, state)
    if (!answer) {
      mock.unmocked.push(`${method} ${path}`)
      return reply(404, { error: 'Not mocked.' })
    }
    return reply(answer.status ?? 200, answer.body)
  })
  return mock
}

/** Every console error and uncaught page error: every call is mocked, so none may fail. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  return errors
}

const content = (page: Page) => page.locator('main.h10-main')
const view = (page: Page) => content(page).locator('.mads-view')

/** A button that would change Meta (or anything else): none may exist on the read-only page. */
const WRITE_VERB = /^(pause|enable|resume|remove|delete|apply|dismiss|edit|save|create|add|raise|lower|increase|decrease|set|change|update|publish|send|approve)\b/i
async function writeButtons(scope: ReturnType<Page['locator']>): Promise<string[]> {
  const names = await scope.getByRole('button').evaluateAll((els) => els
    .filter((el) => (el as HTMLElement).offsetParent !== null && !el.closest('.ag-overlay-error-panel'))
    .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim()))
  return names.filter((n) => WRITE_VERB.test(n))
}

/** Presses Tab until `test()` holds for the focused element (at most `max` presses). */
async function tabUntil(page: Page, test: () => Promise<boolean>, max = 40): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    if (await test()) return true
  }
  return false
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0)
}

test.skip(!LOCAL(BASE), 'runs only against a local web server, with every API call mocked')

// The dev server compiles the page on its first visit.
test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000)
  await request.get(PAGE, { timeout: 230_000 })
})

const LOOKS = [
  { name: '1440 light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: '1440 dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: '390 light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: '390 dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
] as const

for (const look of LOOKS) {
  test.describe(`Ads › Meta, ${look.name}`, () => {
    test.use({ viewport: look.viewport, colorScheme: look.colorScheme })
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((mode) => { try { window.localStorage.setItem('nexus:theme', mode) } catch { /* private mode */ } }, look.colorScheme)
    })

    test('totals, the days and the three tabs; read only, no sideways scroll', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(PAGE)
      const main = content(page)
      await expect(main.getByRole('heading', { name: 'Meta ads' })).toBeVisible()
      await expect(main.locator('.nds-metrics')).toBeVisible()
      const views = main.getByRole('tablist', { name: 'Meta ads views' })
      await expect(views.getByRole('tab')).toHaveCount(3)
      await expect(view(page).getByText('Test sales campaign')).toBeVisible()
      await views.getByRole('tab', { name: 'Ad sets' }).click()
      await expect(view(page).getByText('Test ad set')).toBeVisible()
      await views.getByRole('tab', { name: 'Ads' }).click()
      await expect(view(page).getByText('A made-up summer jacket')).toBeVisible()
      if (look.colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
      await noSidewaysScroll(page)
      expect(await writeButtons(main)).toEqual([])
      expect(mock.unmocked).toEqual([])
      expect(mock.writes).toEqual([])
      expect(errors).toEqual([])
    })

    test('keyboard: Enter on a campaign row opens its window, Esc closes it; a day not read says "Not read", never 0', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(PAGE)
      const main = content(page)
      await expect(view(page).getByText('Test sales campaign')).toBeVisible()
      const panel = view(page)
      const inGrid = () => panel.evaluate((el) => !!document.activeElement?.closest('.ag-root') && el.contains(document.activeElement))
      await main.getByRole('tablist', { name: 'Meta ads views' }).getByRole('tab', { name: 'Campaigns' }).focus()
      expect(await tabUntil(page, inGrid), 'Tab never reached the campaigns grid').toBe(true)
      // Into the first row (the header is the grid's tab stop).
      await page.keyboard.press('ArrowDown')
      await expect(panel.locator('.ag-cell:focus')).toHaveCount(1)
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Test sales campaign' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('row', { name: /18 Oct 2026/ })).toContainText('Not read')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })
  })
}

test.describe('Ads › Meta, honest states (1440, light)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })

  for (const state of ['not_connected', 'sign_in_needed', 'token_problem', 'permission_missing', 'choose_account', 'first_read_pending']) {
    test(`no amount and no currency when ${state}`, async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page, state)
      await page.goto(PAGE)
      const main = content(page)
      await expect(main.getByRole('heading', { name: 'Meta ads' })).toBeVisible()
      await expect(main.locator('.nds-empty')).toBeVisible()
      expect(await main.innerText()).not.toMatch(/€|\bEUR\b|\d+\.\d{2}\b/)
      await expect(main.locator('.nds-metrics')).toHaveCount(0)
      await expect(main.getByRole('tablist', { name: 'Meta ads views' })).toHaveCount(0)
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })
  }
})

test.describe('Settings › Channels: Connect Meta and the asset picker (1440, light)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })

  test('no popup; the three values are sent once and cleared; the picker holds a taken account and saves by keyboard', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = watchErrors(page)
    const mock = await mockApi(page, 'not_connected')
    let popups = 0
    page.on('popup', () => { popups++ })
    await page.goto('/settings/channels?tab=connect', { timeout: 110_000 })
    await page.getByRole('button', { name: 'Connect Meta' }).click()
    const form = page.getByRole('dialog', { name: 'Connect Meta' })
    await expect(form).toBeVisible()
    await expect(form.getByLabel('App secret')).toHaveAttribute('type', 'password')
    await expect(form.getByLabel('System-user token')).toHaveAttribute('type', 'password')
    await form.getByLabel('App ID').fill('1234567')
    await form.getByLabel('App secret').fill('0123456789abcdef0123456789abcdef')
    await form.getByLabel('System-user token').fill('fixture-system-user-token-000000')
    await form.getByLabel('System-user token').press('Enter')
    await expect(form).toBeHidden()
    expect(mock.connects).toEqual([{ appId: '1234567', appSecret: '0123456789abcdef0123456789abcdef', systemUserToken: 'fixture-system-user-token-000000' }])
    expect(popups).toBe(0)
    expect(await page.evaluate(() => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }))).not.toMatch(/fixture-system-user-token|0123456789abcdef/)

    const picker = page.getByRole('dialog', { name: 'Choose Meta assets' })
    await expect(picker).toBeVisible()
    await expect(picker.getByText('Meta did not list the Instagram accounts.')).toBeVisible()
    const adAccount = picker.getByLabel('Ad account')
    await adAccount.focus()
    await page.keyboard.press('Enter')
    // An account another business picked is held and shown by its id only, never chosen for the person; Save waits.
    await expect(page.getByRole('option', { name: /Used by another business/ })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('option', { name: /Used by another business/ })).toContainText('act_1234567891')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(adAccount).toContainText('Test Shop A')
    await picker.getByRole('button', { name: 'Save and start reading' }).focus()
    await page.keyboard.press('Enter')
    await expect(picker).toBeHidden()
    expect(mock.saved).toEqual([{ adAccountId: '1234567890', pageId: null, instagramId: null }])
    await expect(page.getByText('Meta assets saved.')).toBeVisible()
    expect(mock.unmocked).toEqual([])
    expect(errors).toEqual([])
  })
})
