import { existsSync } from 'node:fs'

/** Standalone probes use an explicitly supplied test session, never an anonymous measurement. */
export async function authenticatedStudioPage(browser, { base, viewport }) {
  const storageState = process.env.STUDIO_STORAGE_STATE ?? process.env.CENSUS_STORAGE_STATE
  if (storageState && !existsSync(storageState)) throw new Error(`Studio storage state does not exist: ${storageState}`)
  const context = await browser.newContext({ viewport, ...(storageState ? { storageState } : {}) })
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const api = process.env.STUDIO_API_BASE ?? 'http://localhost:8091'
  if (process.env.STUDIO_TEST_EMAIL && process.env.STUDIO_TEST_PASSWORD) {
    const csrf = await context.request.get(`${api}/api/auth/csrf`)
    const token = (await csrf.json()).csrfToken
    const login = await context.request.post(`${api}/api/auth/login`, { headers: { 'X-CSRF-Token': token }, data: { email: process.env.STUDIO_TEST_EMAIL, password: process.env.STUDIO_TEST_PASSWORD } })
    if (!login.ok()) throw new Error(`Studio test sign-in refused (${login.status()})`)
  }
  const me = await context.request.get(`${api}/api/auth/me`)
  if (!me.ok() || !(await me.json()).user) {
    await context.close()
    throw new Error('A signed-in studio session is required. Set STUDIO_STORAGE_STATE to an existing test session, or STUDIO_TEST_EMAIL and STUDIO_TEST_PASSWORD for normal local sign-in.')
  }
  return page
}
