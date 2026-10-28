import { z } from 'zod'
import { defineEvent } from '../events/define'
import { INTEGRATION_PROVIDERS } from '../ports/provider'

/**
 * The integration platform's events (plan A1 §3.3, §4; feature PLT-194). The inbound route emits
 * `integration.inbound_received` in the transaction that stores a verified webhook receipt, so the receipt and the job
 * that processes it exist together or not at all; the worker's handler (apps/factory-api/src/platform/inbound) then
 * processes the receipt once. Never on a live screen.
 */
export const events = [
  defineEvent({
    type: 'integration.inbound_received',
    context: 'integration',
    description: 'A verified webhook from an outside service was stored and waits for processing.',
    payload: z.strictObject({
      receiptId: z.uuid(),
      accountId: z.uuid(),
      provider: z.enum(INTEGRATION_PROVIDERS),
    }),
  }),
] as const
