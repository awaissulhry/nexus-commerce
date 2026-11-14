import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of currencies and exchange rates (B-W2b-389; PLT-132, PLT-133; apps/factory-api platform/currency; the rules
 * in ../money/currency). Context `currency`, its own module folder. They reach Finance › Settings › Currencies & rates
 * (currencies.view): another person's change shows there at once. No money, no person.
 *
 *   currency.changed        a company's document currency was added, switched off or switched on again
 *   currency.rates_changed  the rates table changed: the ECB's rates of a day read (by the daily job or "Read today's
 *                           rates"), a manual rate of a day kept, corrected or removed, the daily ECB rates switched on or off
 */
export const events = [
  defineEvent({
    type: 'currency.changed',
    context: 'currency',
    description: "A currency a company's documents may be in was added, switched off or switched on again.",
    payload: z.strictObject({
      currencyId: z.uuid(),
      companyId: z.uuid(),
      code: z.string().regex(/^[A-Z]{3}$/),
      action: z.enum(['ADDED', 'SWITCHED_OFF', 'SWITCHED_ON']),
    }),
    live: { permission: 'currencies.view', fields: ['currencyId', 'companyId', 'code', 'action'] },
  }),
  defineEvent({
    type: 'currency.rates_changed',
    context: 'currency',
    description: "The exchange rates changed: the ECB's rates of a day were read, a manual rate of a day was kept, corrected or removed, or the daily ECB rates were switched on or off.",
    payload: z.strictObject({
      action: z.enum(['ECB_READ', 'MANUAL_SET', 'MANUAL_REMOVED', 'FEED_ON', 'FEED_OFF']),
      /** The days whose rates changed (oldest first); none for a switch. */
      days: z.array(z.iso.date()).max(100),
      /** The quote currency of a manual rate; null otherwise. */
      quote: z.string().regex(/^[A-Z]{3}$/).nullable(),
      /** How many rows were added or changed. */
      rows: z.number().int().min(0),
    }),
    live: { permission: 'currencies.view', fields: ['action', 'days', 'quote'] },
  }),
] as const
