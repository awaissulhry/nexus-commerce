import { z } from 'zod'
import { documentUnitsView } from '@nexus/factory-domain/sales/mtm/contracts'
import type { ApiClient } from '../../../../../lib/api/client'
import type { FixUnit } from './model'

/** B-W2b-368 (XF1:04): a quote's made-to-measure units (quotes.view): line → rider profile, for the send dialog's MTM fix. */
export async function quoteUnits(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<FixUnit[]> {
  return (await api.get(`/sales/quotes/${encodeURIComponent(quoteId)}/made-to-measure`, { schema: z.object({ made: documentUnitsView }), signal })).made.units
}
