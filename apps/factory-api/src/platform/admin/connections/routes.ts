import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getAccountContract, listAccountsContract, listCallsContract, listInboundContract, pauseAccountContract, resumeAccountContract } from './contract'
import { getAccount, listAccounts, listCalls, listInbound, setAccountPaused } from './connections'
import { manifest } from './manifest'

/**
 * Connections & API in the Office (B-W0-28, SCR-087):
 *   GET  /integrations/accounts                       the accounts (mode, state, last OK and error, calls 24 h)
 *   GET  /integrations/accounts/:accountId            one account
 *   GET  /integrations/accounts/:accountId/calls      its call ledger, newest first (`failed=true`: only failures)
 *   GET  /integrations/accounts/:accountId/inbound    the webhooks it sent, newest first (never a body)
 *   POST /integrations/accounts/:accountId/pause      the kill switch: the gateway refuses its calls
 *   POST /integrations/accounts/:accountId/resume     calls reach it again
 * Never a secret: whether one is saved and when, nothing more.
 */
export default defineRoutes('admin-connections', manifest, async (app) => {
  app.get('/integrations/accounts', { schema: listAccountsContract }, async (request) => ({
    accounts: await listAccounts(request, { provider: request.query.provider, includeDisabled: request.query.includeDisabled === 'true' }),
  }))
  app.get('/integrations/accounts/:accountId', { schema: getAccountContract }, async (request) => ({ account: await getAccount(request, request.params.accountId) }))
  app.get('/integrations/accounts/:accountId/calls', { schema: listCallsContract }, async (request) =>
    listCalls(request, request.params.accountId, { failed: request.query.failed === 'true', before: request.query.before, limit: request.query.limit }),
  )
  app.get('/integrations/accounts/:accountId/inbound', { schema: listInboundContract }, async (request) =>
    listInbound(request, request.params.accountId, { status: request.query.status, before: request.query.before, limit: request.query.limit }),
  )
  app.post('/integrations/accounts/:accountId/pause', { schema: pauseAccountContract }, async (request) => ({
    account: await setAccountPaused(request, request.params.accountId, true, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/integrations/accounts/:accountId/resume', { schema: resumeAccountContract }, async (request) => ({
    account: await setAccountPaused(request, request.params.accountId, false, request.body, idempotencyKeyFrom(request)),
  }))
})
