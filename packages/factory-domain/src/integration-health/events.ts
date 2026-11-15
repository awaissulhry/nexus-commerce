import { z } from 'zod'
import { defineEvent } from '../events/define'
import { INTEGRATION_PROVIDERS } from '../ports/provider'
import { ERROR_SOURCES } from './errors'

/**
 * Integration health's events (B-W2b-415; plan A1 §3.4):
 *
 *   integration.error_opened      a failed message came into the error queue (the collector found a dead event, a
 *                                 failed or rejected webhook, a failed or refused call, a background job out of tries)
 *   integration.error_retried     an item was sent again once (by a person, or the system saw it go through)
 *   integration.error_dismissed   a person dismissed an item with a reason
 *   integration.account_tested    a connection's harmless test call ran (Test, or Reconnect: its circuit closed first)
 *   jobs.run_requested            a person asked a scheduled job to run now
 *   jobs.run_finished             a scheduled job's run ended: every Run now, and a scheduled tick only when it FAILED
 *
 * Ids, codes and states only: never a provider's message, a payload or a person's name. The Connections page and the
 * Security page read again on them.
 */
export const events = [
  defineEvent({
    type: 'integration.error_opened',
    context: 'integration-health',
    description: 'A failed message came into the error queue: a dead event, a failed or rejected webhook, a failed or refused call, a background job out of tries.',
    payload: z.strictObject({
      itemId: z.uuid(),
      source: z.enum(ERROR_SOURCES),
      provider: z.enum(INTEGRATION_PROVIDERS).nullable(),
    }),
    live: { permission: 'integrations.view', fields: ['source'] },
  }),
  defineEvent({
    type: 'integration.error_retried',
    context: 'integration-health',
    description: 'An item of the error queue was sent again once, by a person or (it went through on its own) by the system.',
    payload: z.strictObject({
      itemId: z.uuid(),
      source: z.enum(ERROR_SOURCES),
      bySystem: z.boolean(),
    }),
    live: { permission: 'integrations.view', fields: ['source'] },
  }),
  defineEvent({
    type: 'integration.error_dismissed',
    context: 'integration-health',
    description: 'A person dismissed an item of the error queue with a reason: nothing more is done with it.',
    payload: z.strictObject({
      itemId: z.uuid(),
      source: z.enum(ERROR_SOURCES),
    }),
    live: { permission: 'integrations.view', fields: ['source'] },
  }),
  defineEvent({
    type: 'integration.account_tested',
    context: 'integration-health',
    description: "A connection's harmless test call ran through the gateway (Test, or Reconnect after its circuit was closed).",
    payload: z.strictObject({
      accountId: z.uuid(),
      outcome: z.enum(['OK', 'FAILED', 'REFUSED']),
      reconnect: z.boolean(),
    }),
    live: { permission: 'integrations.view', fields: ['outcome'] },
  }),
  defineEvent({
    type: 'jobs.run_requested',
    context: 'integration-health',
    description: 'A person asked a scheduled job to run now, once, for this business.',
    payload: z.strictObject({
      jobKey: z.string().min(3).max(100),
      requestId: z.string().min(1).max(200),
    }),
    live: { permission: 'security.view', fields: ['jobKey'] },
  }),
  defineEvent({
    type: 'jobs.run_finished',
    context: 'integration-health',
    description: "A scheduled job's run ended: every Run now, and a scheduled tick only when it failed.",
    payload: z.strictObject({
      runId: z.uuid(),
      jobKey: z.string().min(3).max(100),
      trigger: z.enum(['SCHEDULE', 'RUN_NOW']),
      status: z.enum(['SUCCEEDED', 'FAILED']),
    }),
    live: { permission: 'security.view', fields: ['jobKey', 'status'] },
  }),
] as const
