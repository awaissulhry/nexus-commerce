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
 */
import prisma from '../../../db.js'

export const PRODUCTS_TOOL = 'set-google-merchant-products'
export const DATA_SOURCES_TOOL = 'set-google-merchant-data-sources'
export const PROMOTIONS_TOOL = 'set-google-merchant-promotions'

type Json = Record<string, any>
const recordOf = (after: unknown): Json => (after && typeof after === 'object' && !Array.isArray(after) ? after as Json : {})

/** The data sources (ids) Nexus made in this Merchant Center account for this business. */
export async function nexusDataSourceIds(merchantCenterId: string): Promise<Set<string>> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: DATA_SOURCES_TOOL, after: { path: ['created'], equals: true } },
    select: { after: true },
  })
  const ids = new Set<string>()
  for (const row of rows) {
    const after = recordOf(row.after)
    if (after.merchantCenterId === merchantCenterId && typeof after.dataSourceId === 'string') ids.add(after.dataSourceId)
  }
  return ids
}

/** What Nexus last wrote of one thing (`key`) in one of its data sources: `state` (null = deleted), or null with no record. */
async function lastState(tool: string, merchantCenterId: string, dataSourceId: string, key: string): Promise<{ state: Json | null; at: string } | null> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: tool, after: { path: ['key'], equals: key } },
    orderBy: { executedAt: 'desc' },
    select: { after: true, executedAt: true },
    take: 50,
  })
  for (const row of rows) {
    const after = recordOf(row.after)
    if (after.merchantCenterId !== merchantCenterId || after.dataSourceId !== dataSourceId) continue
    const state = after.state && typeof after.state === 'object' && !Array.isArray(after.state) ? after.state as Json : null
    return { state, at: row.executedAt.toISOString() }
  }
  return null
}

export const recordedInput = (merchantCenterId: string, dataSourceId: string, key: string) => lastState(PRODUCTS_TOOL, merchantCenterId, dataSourceId, key)
export const recordedPromotion = (merchantCenterId: string, dataSourceId: string, key: string) => lastState(PROMOTIONS_TOOL, merchantCenterId, dataSourceId, key)

/** How many product inputs (or promotions) Nexus's records say one of its data sources still holds. */
export async function recordedCount(tool: typeof PRODUCTS_TOOL | typeof PROMOTIONS_TOOL, merchantCenterId: string, dataSourceId: string): Promise<number> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: tool, after: { path: ['dataSourceId'], equals: dataSourceId } },
    orderBy: { executedAt: 'desc' },
    select: { after: true },
  })
  const seen = new Set<string>()
  let held = 0
  for (const row of rows) {
    const after = recordOf(row.after)
    if (after.merchantCenterId !== merchantCenterId || typeof after.key !== 'string' || seen.has(after.key)) continue
    seen.add(after.key)
    if (after.state && typeof after.state === 'object') held += 1
  }
  return held
}
