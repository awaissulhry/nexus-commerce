import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SIZE_CURVE_CHANGES } from '../sales/size-curves/rules'

/**
 * Quote speed-ups (B-W2b-302; SAL-269). apps/factory-api's modules/sales/size-curves emits it in the command that makes the
 * change. Its own module folder (the event guard wants src/<module>/events.ts): the code is factory-domain sales/size-curves.
 * Goal-seek, paste, bulk size changes and fills move W1's `quote.lines_changed` (each line changed or added).
 *
 *   size_curve.changed  a size curve was made, renamed, its shares changed, archived or restored
 *
 * Reaches the office's quote screens (quotes.view): ids and what changed; no figure.
 */
export const events = [
  defineEvent({
    type: 'size_curve.changed',
    context: 'quote-speedups',
    description: 'A size curve (the shares per size a quote line is filled from) was made, renamed, its shares changed, or it was archived or restored.',
    payload: z.strictObject({ sizeCurveId: z.uuid(), companyId: z.uuid().nullable(), sizeScaleId: z.uuid(), change: z.enum(SIZE_CURVE_CHANGES), fields: z.array(z.string()) }),
    live: { permission: 'quotes.view', fields: ['sizeCurveId', 'companyId', 'change'] },
  }),
] as const
