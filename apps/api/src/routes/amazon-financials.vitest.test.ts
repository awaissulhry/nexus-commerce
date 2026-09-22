import Fastify from 'fastify'
import { beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ legacy: vi.fn(), yesterday: vi.fn(), compare: vi.fn(), probe: vi.fn() }))
vi.mock('../services/amazon-financial-events.service.js', async original => ({
  ...await original<object>(), syncFinancialEvents: calls.legacy, syncYesterdayFinancialEvents: calls.yesterday,
  syncFinancialTransactions: calls.compare, probeFinancialTransactionsEnvelope: calls.probe,
}))
const routes = (await import('./amazon-financials.routes.js')).default
beforeEach(() => { vi.resetAllMocks(); calls.compare.mockResolvedValue({ dryRun: true, txCreated: 0 }); calls.probe.mockResolvedValue({ ok: true }) })
async function post(body: unknown) {
  const app = Fastify()
  await app.register(routes)
  const result = await app.inject({ method: 'POST', url: '/financials/sync', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) })
  await app.close()
  return result
}
it.each([[], 'dryRun=true', null, 42, { dryRun:'true' }, { useV0:'false' }, { probe:'true' }, { useV0:false }, { accountId:'seller-2' }, { start:null, end:null }].map(body => ({body})))('rejects malformed or unsafe requests without invoking a channel service: $body', async ({body}) => {
  expect((await post(body)).statusCode).toBe(400)
  for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled()
})
it('binds a valid dry run to its named account and dates', async () => {
  const body = { useV0:false, dryRun:true, accountId:'seller-2', marketplaceId:'APJ6JRA9NG5V4', start:'2026-09-20T00:00:00Z', end:'2026-09-21T00:00:00Z' }
  expect((await post(body)).json()).toMatchObject({ success:true, txCreated:0 })
  expect(calls.compare).toHaveBeenCalledWith(new Date(body.start),new Date(body.end),body.marketplaceId,{dryRun:true,accountId:'seller-2'})
  expect(calls.legacy).not.toHaveBeenCalled()
})
it('threads a probe account through the actual route', async () => {
  expect((await post({probe:true,accountId:'seller-2'})).statusCode).toBe(200)
  expect(calls.probe).toHaveBeenCalledWith(expect.any(Date),expect.any(Date),undefined,'seller-2')
})
it('preserves the deliberate legacy default for a valid empty request', async () => {
  expect((await post({})).statusCode).toBe(200)
  expect(calls.yesterday).toHaveBeenCalledTimes(1)
  expect(calls.compare).not.toHaveBeenCalled()
})
