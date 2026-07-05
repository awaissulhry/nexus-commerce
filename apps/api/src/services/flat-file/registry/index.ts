// FF1.5 — Registry entry point: assembles a WorkbookModel from the shared
// field registry + discovered markets. Task 7's generator consumes this model.
import type { WorkbookModel, SheetDefinition } from './types'
import { MASTER_FIELDS } from './master-fields'
import { CHANNEL_SHARED_FIELDS, CHANNEL_MARKET_FIELDS } from './channel-fields'
import { EBAY_SHARED_FIELDS } from './ebay-provider'
import { discoverMarkets } from '../market-discovery'

type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

const SHEET_NAME: Record<Channel, SheetDefinition['name']> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
}

export async function buildWorkbookModel(
  prisma: any,
  opts: { channels: Channel[] },
): Promise<WorkbookModel> {
  const markets: WorkbookModel['markets'] = { AMAZON: [], EBAY: [], SHOPIFY: [] }
  for (const ch of opts.channels) {
    markets[ch] = await discoverMarkets(prisma, ch)
  }

  const sheets: SheetDefinition[] = [
    {
      name: 'Products',
      sharedFields: MASTER_FIELDS,
      marketFields: [],
    },
    ...opts.channels.map((ch): SheetDefinition => ({
      name: SHEET_NAME[ch],
      channel: ch,
      sharedFields: [
        ...CHANNEL_SHARED_FIELDS,
        ...(ch === 'EBAY' ? EBAY_SHARED_FIELDS : []),
      ],
      marketFields: CHANNEL_MARKET_FIELDS,
    })),
  ]

  return { markets, sheets }
}

export { mapManifestToFields } from './amazon-provider'
