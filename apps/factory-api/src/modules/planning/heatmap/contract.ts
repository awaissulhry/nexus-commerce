import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { HEAT_BANDS, MAX_WEEKS } from '@nexus/factory-domain/planning/heatmap/bands'

/**
 * The load heatmap (B-W2b-321; PLN-117): lanes down (lines, work centres, workshop capacity lines), weeks across; each
 * cell its load % (one decimal; null: nothing available), band and the text it writes. No money, no person.
 */
export const heatmapContract = defineContract({
  querystring: input({ siteId: id(), from: businessDate().optional(), weeks: z.coerce.number().int().min(1).max(MAX_WEEKS).optional() }),
  response: {
    200: output({
      site: output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() }),
      from: businessDate(),
      to: businessDate(),
      today: businessDate(),
      asOf: instant(),
      weeks: z.array(output({ key: z.string(), from: businessDate(), to: businessDate() })),
      lanes: z.array(
        output({
          kind: z.enum(['LINE', 'WORK_CENTRE', 'WORKSHOP']),
          id: id(),
          code: z.string(),
          name: z.string(),
          workCentreKind: z.string().nullable(),
          /** MINUTES for our lanes; a workshop line's unit (null: no capacity set). */
          unit: z.enum(['MINUTES', 'PIECES']).nullable(),
          cells: z.array(output({ key: z.string(), from: businessDate(), to: businessDate(), loadPct: z.string().nullable(), band: z.enum(HEAT_BANDS), text: z.string(), available: z.string().nullable(), booked: z.string(), over: z.boolean() })),
        }),
      ),
      legend: z.array(output({ band: z.enum(HEAT_BANDS), words: z.string() })),
      counts: output({ cellsOver: z.number().int(), lanesOver: z.number().int() }),
    }),
  },
})
