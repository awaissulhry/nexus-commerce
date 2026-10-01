/** The real authenticated API, restricted local test login, and actual pg queries; never a mocked statement count. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkBulkSql } from './bulk-sql-budget.mts'

const url = new URL(process.env.DATABASE_URL ?? '')
assert(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) && url.pathname.includes('test'), 'SQL budgets require a loopback test database')
assert(process.env.SMOKE_SEED, 'SMOKE_SEED is required')
const seed = JSON.parse(readFileSync(process.env.SMOKE_SEED, 'utf8'))
const root = new URL('../../../../', import.meta.url)
const requires = ['apps/api/package.json', 'packages/database/package.json'].map(file => createRequire(fileURLToPath(new URL(file, root))))
let trips = 0, statements = 0
for (const pg of new Set(requires.map(require => require('pg')))) {
  const original = pg.Client.prototype.query
  pg.Client.prototype.query = function (...args: unknown[]) {
    trips++
    // One ScopedQuery sends two SQL statements in one network round trip.
    statements += args[0]?.constructor?.name === 'ScopedQuery' ? 2 : 1
    return original.apply(this, args)
  }
}
process.env.RBAC_COVERAGE = '1'
process.env.NEXUS_WORKSPACES_ENABLED = '1'
process.env.NEXUS_DISABLE_BACKGROUND_JOBS = '1'
process.env.ENABLE_QUEUE_WORKERS = '0'
process.env.NEXUS_AMAZON_ENV_TOKEN = 'off'
const { app } = await import(fileURLToPath(new URL('apps/api/src/index.ts', root)))
await app.ready()
try {
  const cookies = new Map<string, string>()
  const adopt = (response: { cookies: Array<{ name: string; value: string }> }) => {
    for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value)
  }
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf' })
  assert.equal(csrf.statusCode, 200)
  adopt(csrf)
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    headers: { cookie: cookieHeader(), 'x-nexus-csrf': csrf.json().csrfToken, origin: process.env.SHEET_ORIGIN ?? 'http://localhost:3000' },
    payload: { email: seed.email, password: seed.password } })
  assert.equal(login.statusCode, 200, 'normal local sign-in must succeed before counting SQL')
  adopt(login)
  const headers = { cookie: cookieHeader(), 'x-nexus-workspace-id': seed.workspaces.a }
  const routes = [
    { url: '/api/auth/me', trips: 3, sql: 6 },
    { url: '/api/pim/formulas/functions', trips: 2, sql: 4 },
    { url: '/api/saved-views?surface=product-edit%3Aviews%3AEBAY', trips: 3, sql: 6 },
  ]
  for (const route of routes) {
    assert.equal((await app.inject({ method: 'GET', url: route.url, headers })).statusCode, 200)
    // One request at a time. Extra background queries can only make this conservative guard fail, never falsely pass.
    const before = { trips, statements }
    const response = await app.inject({ method: 'GET', url: route.url, headers })
    assert.equal(response.statusCode, 200, `${route.url}: a failed request is not a speed result`)
    const measured = { url: route.url, trips: trips - before.trips, sql: statements - before.statements }
    console.log(`SHEET_SQL ${JSON.stringify(measured)}`)
    assert(measured.trips > 0 && measured.sql > 0, 'the SQL instrument must see real authenticated reads')
    assert(measured.trips <= route.trips, `${route.url}: ${measured.trips} round trips > ${route.trips}`)
    assert(measured.sql <= route.sql, `${route.url}: ${measured.sql} SQL statements > ${route.sql}; original target remains <= 10`)
  }
  assert(process.env.SHEET_SEED, 'SHEET_SEED is required for bulk SQL budgets')
  const sheetSeed = JSON.parse(readFileSync(process.env.SHEET_SEED, 'utf8'))
  assert.equal(sheetSeed.workspace, seed.workspaces.a, 'the bulk fixture must belong to the signed-in business')
  const csrfToken = cookies.get('nexus_csrf') ?? cookies.get('__Host-nexus_csrf')
  assert(csrfToken, 'the real sign-in must provide a CSRF cookie')
  await checkBulkSql(app, sheetSeed.families.speed, {
    ...headers,
    origin: process.env.SHEET_ORIGIN ?? 'http://localhost:3000',
    'x-nexus-csrf': csrfToken,
  }, () => ({ trips, statements }))
} finally {
  await app.close()
}
process.exit(0)
