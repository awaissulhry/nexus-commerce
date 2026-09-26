/**
 * The Shopify orders shadow report route: one GET, behind the integrations permission and the switch.
 * The service is stood in; its own suite proves the read-only behaviour.
 */
import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { FEATURES } from '@nexus/shared/permissions'

const m = vi.hoisted(() => ({ report: vi.fn() }))
vi.mock('../services/shopify/order-shadow-report.service.js', () => ({ shopifyShadowReport: m.report }))

import routes from './shopify-shadow-report.routes.js'

const app = Fastify()
await app.register(routes, { prefix: '/api' })
afterEach(() => vi.resetAllMocks())

it('is mapped to the integrations permission, for reads and for anything else on the path', () => {
  expect(permissionForRoute('GET', '/api/shopify/shadow-report/:accountId')).toBe(FEATURES.settingsIntegrationsManage)
  expect(permissionForRoute('POST', '/api/shopify/shadow-report/:accountId')).toBe(FEATURES.settingsIntegrationsManage)
})

it('registers a GET only: there is no way to post to it', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/shopify/shadow-report/acct-1' })
  expect(r.statusCode).toBe(404)
  expect(m.report).not.toHaveBeenCalled()
})

it('returns the report for the account in the path, with the window it was asked for', async () => {
  m.report.mockResolvedValue({ readOnly: true, orders: { total: 3 } })
  const r = await app.inject({ method: 'GET', url: '/api/shopify/shadow-report/acct-1?days=30' })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ ok: true, report: { readOnly: true, orders: { total: 3 } } })
  expect(m.report).toHaveBeenCalledWith('acct-1', { days: 30 })
})

it('no days → the service default', async () => {
  m.report.mockResolvedValue({ readOnly: true })
  await app.inject({ method: 'GET', url: '/api/shopify/shadow-report/acct-1' })
  expect(m.report).toHaveBeenCalledWith('acct-1', { days: undefined })
})

it('a days value that is not a whole number is passed as NaN, for the service to refuse', async () => {
  m.report.mockRejectedValue(Object.assign(new Error('The window is a whole number of days from 1 to 90.'), { code: 'SHOPIFY_SHADOW_REPORT_WINDOW', statusCode: 400 }))
  const r = await app.inject({ method: 'GET', url: '/api/shopify/shadow-report/acct-1?days=abc' })
  expect(m.report.mock.calls[0][1].days).toBeNaN()
  expect(r.statusCode).toBe(400)
})

it.each([
  ['SHOPIFY_SHADOW_REPORT_OFF', 404],
  ['SHOPIFY_THROTTLED', 429],
  ['SHOPIFY_QUERY_FAILED', 502],
  ['ACCOUNT_NEEDS_SIGNIN', 409],
])('%s answers %i with the code and the sentence', async (code, statusCode) => {
  m.report.mockRejectedValue(Object.assign(new Error(`sentence for ${code}`), { code, statusCode }))
  const r = await app.inject({ method: 'GET', url: '/api/shopify/shadow-report/acct-1' })
  expect(r.statusCode).toBe(statusCode)
  expect(r.json()).toEqual({ ok: false, code, error: `sentence for ${code}` })
})

it('an unexpected failure is a 500 that says nothing was written', async () => {
  m.report.mockRejectedValue(new Error('The selected account is not Shopify.'))
  const r = await app.inject({ method: 'GET', url: '/api/shopify/shadow-report/acct-1' })
  expect(r.statusCode).toBe(500)
  expect(r.json()).toMatchObject({ ok: false, code: 'SHOPIFY_SHADOW_REPORT_FAILED', error: 'The selected account is not Shopify.' })
})
