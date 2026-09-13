import { existsSync } from 'node:fs'

/**
 * Standalone probes use an explicitly supplied test session, never an anonymous measurement.
 *
 * 🔴 LX.FIN — `colorScheme` added (additive, optional, default unchanged). LX.6 and LX.F2 both recorded
 * "1440 and light theme HELD — the instrument cannot resize or emulate the media query" and the DARK
 * half of R-LX-3's bar went unmeasured for two lanes. Playwright takes both at context level; the
 * missing piece was that this helper hard-coded the option list and dropped anything else a caller
 * passed. Every existing caller passes `{ base, viewport }` and is unaffected.
 *
 * NOTE for a caller reading dark: this app's theme is a `.dark` CLASS applied by `useTheme`
 * (`apps/web/src/lib/theme/use-theme.ts`), whose default mode is `'system'` — so `colorScheme: 'dark'`
 * alone does reach it, through `matchMedia('(prefers-color-scheme: dark)')`. Setting
 * `localStorage['nexus:theme']` is the explicit belt; ASSERT `documentElement.classList.contains('dark')`
 * either way, because a theme reading whose class never landed is a light-mode screenshot with a dark
 * label on it.
 */
export async function authenticatedStudioPage(browser, { base, viewport, colorScheme }) {
  const storageState = process.env.STUDIO_STORAGE_STATE ?? process.env.CENSUS_STORAGE_STATE
  if (storageState && !existsSync(storageState)) throw new Error(`Studio storage state does not exist: ${storageState}`)
  const context = await browser.newContext({ viewport, ...(colorScheme ? { colorScheme } : {}), ...(storageState ? { storageState } : {}) })
  const page = await context.newPage()
  const authErrors = []
  const onConsole = message => { if (message.type() === 'error') authErrors.push(message.text()) }
  const onFailed = request => authErrors.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`)
  page.on('console', onConsole)
  page.on('requestfailed', onFailed)
  // AuthProvider also mints CSRF during hydration. Finish that request before
  // starting sign-in, otherwise two fresh tokens can race on the same cookie.
  const bootAuth = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/me', { timeout: 15000 })
  // Start on a stable public route: / redirects to the dashboard, whose signed-out
  // redirect can otherwise abort sign-in or the gate's first studio navigation.
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' })
  await bootAuth
  const api = process.env.STUDIO_API_BASE ?? 'http://localhost:8091'
  if (process.env.STUDIO_TEST_EMAIL && process.env.STUDIO_TEST_PASSWORD) {
    // Use the browser's normal cookie/CORS path, including secure localhost cookies.
    // APIRequestContext does not apply Chromium's localhost secure-context exception.
    const login = await page.evaluate(async ({ api, email, password }) => {
      const csrf = await fetch(`${api}/api/auth/csrf`, { credentials: 'include' })
      const token = (await csrf.json()).csrfToken
      const response = await fetch(`${api}/api/auth/login`, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-nexus-csrf': token }, body: JSON.stringify({ email, password }) })
      const result = await response.json().catch(() => ({}))
      return { ok: response.ok, status: response.status, code: result.code }
    }, { api, email: process.env.STUDIO_TEST_EMAIL, password: process.env.STUDIO_TEST_PASSWORD }).catch(error => {
      throw new Error(`${error.message}; browser: ${authErrors.join(' | ')}`)
    })
    if (!login.ok) throw new Error(`Studio test sign-in refused (${login.status}, ${login.code ?? 'no error code'})`)
  }
  const signedIn = await page.evaluate(async api => {
    const me = await fetch(`${api}/api/auth/me`, { credentials: 'include' })
    return me.ok && !!(await me.json()).user
  }, api)
  if (!signedIn) {
    await context.close()
    throw new Error('A signed-in studio session is required. Set STUDIO_STORAGE_STATE to an existing test session, or STUDIO_TEST_EMAIL and STUDIO_TEST_PASSWORD for normal local sign-in.')
  }
  page.off('console', onConsole)
  page.off('requestfailed', onFailed)
  await page.close()
  // Keep the authenticated context, with no pending login-page redirects.
  return context.newPage()
}
