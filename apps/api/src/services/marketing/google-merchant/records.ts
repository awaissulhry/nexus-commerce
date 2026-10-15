/**
 * Google Ads programme 2, G12 (2026-10-16) — what Nexus itself made and wrote in Merchant Center, from its own change
 * records (AgentChange, read through the workspace-scoped client: only this business's rows).
 *
 *   data sources Nexus made   a create of set-google-merchant-data-sources that ran (after.created). Nexus writes product
 *                             inputs and promotions ONLY into these, and changes the settings of these only: never the
 *                             primary feed that Shopify's Google channel (or anything else) owns.
 *   a product input's state   the Merchant API cannot read a product input back (productInputs has insert, patch and
 *                             delete, no get: products_v1 discovery document, 2026-10-16), so what Nexus last wrote for
 *                             an offer in one of its data sources is its own last record of it (null: deleted). Each
 *                             change records the whole input it left; undo puts the one before back.
 *   a promotion's state       the same for a promotion in a Nexus data source (Google reads it back, but the record is
 *                             exactly what Nexus sent, in the shape the tool takes).
 *   an unknown outcome        a change Merchant Center did not answer (it may have applied) is recorded too, with what it
 *                             sent and `outcome: 'unknown'`: the next change of that input says so and replaces it whole.
 */
import prisma from '../../../db.js'
import { MERCHANT_DATA_SOURCES_TOOL } from '../../gateway/google-merchant-calls.js'

export const PRODUCTS_TOOL = 'set-google-merchant-products'
export const DATA_SOURCES_TOOL = MERCHANT_DATA_SOURCES_TOOL
export const PROMOTIONS_TOOL = 'set-google-merchant-promotions'

type Json = Record<string, any>
const recordOf = (after: unknown): Json => (after && typeof after === 'object' && !Array.isArray(after) ? after as Json : {})
const field = (path: string, equals: string | boolean) => ({ after: { path: [path], equals } })

/** The data sources (ids) Nexus made in this Merchant Center account for this business. */
export async function nexusDataSourceIds(merchantCenterId: string): Promise<Set<string>> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: DATA_SOURCES_TOOL, AND: [field('created', true), field('merchantCenterId', merchantCenterId)] },
    select: { after: true },
  })
  const ids = new Set<string>()
  for (const row of rows) {
    const after = recordOf(row.after)
    if (typeof after.dataSourceId === 'string') ids.add(after.dataSourceId)
  }
  return ids
}

/**
 * What Nexus last wrote of one thing (`key`) in one of its data sources: `state` (null = deleted), when, and whether
 * Google confirmed it (`outcome` unknown: Merchant Center did not answer, so it may or may not hold `state`), or null with
 * no record.
 */
export interface RecordedState { state: Json | null; at: string; outcome: 'done' | 'unknown' }

async function lastState(tool: string, merchantCenterId: string, dataSourceId: string, key: string): Promise<RecordedState | null> {
  const row = await prisma.agentChange.findFirst({
    where: { toolName: tool, AND: [field('key', key), field('merchantCenterId', merchantCenterId), field('dataSourceId', dataSourceId)] },
    orderBy: { executedAt: 'desc' },
    select: { after: true, executedAt: true },
  })
  if (!row) return null
  const after = recordOf(row.after)
  const state = after.state && typeof after.state === 'object' && !Array.isArray(after.state) ? after.state as Json : null
  return { state, at: row.executedAt.toISOString(), outcome: after.outcome === 'unknown' ? 'unknown' : 'done' }
}

export const recordedInput = (merchantCenterId: string, dataSourceId: string, key: string) => lastState(PRODUCTS_TOOL, merchantCenterId, dataSourceId, key)
export const recordedPromotion = (merchantCenterId: string, dataSourceId: string, key: string) => lastState(PROMOTIONS_TOOL, merchantCenterId, dataSourceId, key)

/** How many product inputs (or promotions) Nexus's records say one of its data sources still holds. */
export async function recordedCount(tool: typeof PRODUCTS_TOOL | typeof PROMOTIONS_TOOL, merchantCenterId: string, dataSourceId: string): Promise<number> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: tool, AND: [field('dataSourceId', dataSourceId), field('merchantCenterId', merchantCenterId)] },
    orderBy: { executedAt: 'desc' },
    select: { after: true },
  })
  const seen = new Set<string>()
  let held = 0
  for (const row of rows) {
    const after = recordOf(row.after)
    if (typeof after.key !== 'string' || seen.has(after.key)) continue
    seen.add(after.key)
    // An input whose last change has an unknown outcome may still be there: counted.
    if ((after.state && typeof after.state === 'object') || after.outcome === 'unknown') held += 1
  }
  return held
}
