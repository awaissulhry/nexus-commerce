import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { AUTOMATION_KEY } from '../services/shopify/linked-products.service.js'
import { runLinkedAutomation } from '../services/shopify/linked-automation.service.js'

let scheduled: ReturnType<typeof cron.schedule> | null = null
let running = false
export async function runShopifyLinkedAutomationCron() {
  if (running) return
  running = true
  try {
    await recordCronRun('shopify-linked-automation', async () => {
      let after: string | undefined, checked = 0, errors = 0
      do {
        const rows = await prisma.channelListing.findMany({ where: { channel: 'SHOPIFY', marketplace: 'GLOBAL', aliasKey: '', channelConnectionId: { not: null }, product: { deletedAt: null },
          OR: ['MONITOR', 'AUTOMATIC'].map(mode => ({ platformAttributes: { path: [AUTOMATION_KEY, 'mode'], equals: mode } })) },
          select: { id: true, productId: true, channelConnectionId: true }, orderBy: { id: 'asc' }, take: 25, ...(after ? { cursor: { id: after }, skip: 1 } : {}) })
        for (const row of rows) {
          try { await runLinkedAutomation(row.productId, { accountId: row.channelConnectionId!, listingId: row.id, market: 'GLOBAL' }); checked++ }
          catch (error) { errors++; logger.error('Shopify family automation failed', { listingId: row.id, error: error instanceof Error ? error.message : String(error) }) }
        }
        after = rows.length === 25 ? rows[rows.length - 1].id : undefined
      } while (after)
      return `checked=${checked} errors=${errors}`
    })
  } catch (error) { logger.error('Shopify family automation check failed', { error: error instanceof Error ? error.message : String(error) }) }
  finally { running = false }
}
export function startShopifyLinkedAutomationCron() {
  if (!scheduled) scheduled = cron.schedule('*/5 * * * *', runShopifyLinkedAutomationCron)
}
