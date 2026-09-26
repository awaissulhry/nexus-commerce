/**
 * CX Etsy E4 — the retry sweep must not spend an attempt a handler deliberately kept: a handler
 * that must wait for its owner (a sign-in hold) throws `InboundDeferred`; the claim gives the
 * attempt back (proven on PostgreSQL, claims.vitest.test.ts) and the sweep counts it as deferred,
 * never as a failure. The handler runs under the row's claim, which completes the row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ completed: [] as Array<{ id: string; ok: boolean }>, deferred: [] as Array<{ id: string; delayMs: number }>, contexts: [] as unknown[], behaviour: 'defer' as 'defer' | 'fail' | 'ok' }))

vi.mock('../services/cx/ingress/ledger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/cx/ingress/ledger.js')>()
  return {
    ...original,
    dueInboundEvents: async () => [{ id: 'row-9', workspaceId: 'ws-1', channel: 'ETSY', eventType: 'order.paid', externalId: 'msg_9', payload: {}, attempts: 2, signatureOk: true, verifiedBy: 'none', connectionId: 'conn-etsy' }],
    deadLetterInbound: async () => undefined,
  }
})
vi.mock('../services/cx/ingress/claims.js', () => {
  return {
    inboundDatabaseNow: async () => new Date(),
    claimInbound: async (id: string) => ({ id, token: 'claim', attempt: 3, payload: {}, connectionId: 'conn-etsy', eventType: 'order.paid', channel: 'ETSY' }),
    runWithInboundClaim: async (claim: any, work: any) => {
      try { const result = await work(claim, new AbortController().signal); h.completed.push({ id: claim.id, ok: true }); return result } catch (error) {
        // The same (mocked) ledger module the sweep imports, loaded at call time: one class for `instanceof`.
        const { InboundDeferred } = await import('../services/cx/ingress/ledger.js')
        if (error instanceof InboundDeferred) h.deferred.push({ id: claim.id, delayMs: error.delayMs })
        else h.completed.push({ id: claim.id, ok: false })
        throw error
      }
    },
  }
})
vi.mock('../services/cx/ingress/handlers.js', () => {
  return {
    canReplayInbound: () => true,
    inboundHandlerFor: async () => async (_payload: unknown, context: unknown) => {
      const { InboundDeferred } = await import('../services/cx/ingress/ledger.js')
      h.contexts.push(context)
      if (h.behaviour === 'defer') throw new InboundDeferred('auth hold', 30 * 60 * 1000)
      if (h.behaviour === 'fail') throw new Error('boom')
    },
  }
})
vi.mock('../services/cx/ingress/ebay-processing.js', () => ({ dueEbayInboundEvents: async () => [], processEbayInbound: async () => ({ kind: 'done' }), ebayInboundProcessingEnabled: () => false }))
vi.mock('../lib/workspace-ingress.js', () => ({ withIngressWorkspace: (_id: string, work: () => unknown) => work() }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true, schedule: () => ({ stop: () => {} }) } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_n: string, fn: () => Promise<unknown>) => fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { runInboundRetrySweep } = await import('./inbound-retry.job.js')

beforeEach(() => { h.completed.length = 0; h.deferred.length = 0; h.contexts.length = 0 })

describe('the retry sweep and a deferred event', () => {
  it('counts a deferred event and does NOT close it out (no attempt spent)', async () => {
    h.behaviour = 'defer'
    const stats = await runInboundRetrySweep()
    expect(stats).toMatchObject({ due: 1, deferred: 1, failed: 0, succeeded: 0 })
    expect(h.completed).toEqual([])
    expect(h.deferred).toEqual([{ id: 'row-9', delayMs: 30 * 60 * 1000 }])
  })
  it('CONTROL — an ordinary failure is still closed out as a failure', async () => {
    h.behaviour = 'fail'
    expect(await runInboundRetrySweep()).toMatchObject({ failed: 1, deferred: 0 })
    expect(h.completed).toEqual([{ id: 'row-9', ok: false }])
  })
  it('runs the handler under the row\'s claim, which completes the row', async () => {
    h.behaviour = 'ok'
    expect(await runInboundRetrySweep()).toMatchObject({ succeeded: 1 })
    expect(h.contexts).toEqual([{ connectionId: 'conn-etsy', eventType: 'order.paid', channel: 'ETSY', signal: expect.any(AbortSignal) }])
    expect(h.completed).toEqual([{ id: 'row-9', ok: true }])
  })
})
