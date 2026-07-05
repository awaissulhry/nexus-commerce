// FF1.5 — WorkbookModel assembly tests (TDD — written before implementations).
import { describe, it, expect } from 'vitest'
import { buildWorkbookModel, mapManifestToFields } from '../registry/index'
import { MASTER_FIELDS } from '../registry/master-fields'
import { CHANNEL_MARKET_FIELDS } from '../registry/channel-fields'

const mockPrisma = {
  channelListing: {
    findMany: async () => [{ marketplace: 'IT' }, { marketplace: 'DE' }],
  },
  marketplace: {
    findMany: async () => [{ code: 'IT' }],
  },
}

describe('buildWorkbookModel', () => {
  it('returns sheets named [Products, Amazon, eBay] for channels AMAZON + EBAY', async () => {
    const model = await buildWorkbookModel(mockPrisma, { channels: ['AMAZON', 'EBAY'] })
    expect(model.sheets.map(s => s.name)).toEqual(['Products', 'Amazon', 'eBay'])
  })

  it('Products sheet sharedFields is MASTER_FIELDS (same reference)', async () => {
    const model = await buildWorkbookModel(mockPrisma, { channels: ['AMAZON', 'EBAY'] })
    expect(model.sheets[0].sharedFields).toBe(MASTER_FIELDS)
  })

  it('Amazon sheet marketFields is CHANNEL_MARKET_FIELDS (same reference)', async () => {
    const model = await buildWorkbookModel(mockPrisma, { channels: ['AMAZON', 'EBAY'] })
    expect(model.sheets[1].marketFields).toBe(CHANNEL_MARKET_FIELDS)
  })

  it('eBay sheet marketFields is CHANNEL_MARKET_FIELDS (same reference)', async () => {
    const model = await buildWorkbookModel(mockPrisma, { channels: ['AMAZON', 'EBAY'] })
    expect(model.sheets[2].marketFields).toBe(CHANNEL_MARKET_FIELDS)
  })

  it('markets.AMAZON contains the discovered market list', async () => {
    const model = await buildWorkbookModel(mockPrisma, { channels: ['AMAZON', 'EBAY'] })
    // sortMarkets puts IT first (PRIMARY), then DE
    expect(model.markets.AMAZON).toEqual(['IT', 'DE'])
  })
})

describe('mapManifestToFields', () => {
  it('maps a manifest column with selectionOnly=true to a strict-enum FieldDefinition', () => {
    const fields = mapManifestToFields({
      groups: [
        {
          columns: [
            {
              id: 'material',
              fieldRef: 'material',
              labelEn: 'Material',
              kind: 'text',
              options: ['Cotton', 'Leather'],
              selectionOnly: true,
            },
          ],
        },
      ],
    })
    expect(fields).toHaveLength(1)
    expect(fields[0].id).toBe('material')
    expect(fields[0].source.column).toBe('categoryAttributes.material')
    expect(fields[0].enumMode).toBe('strict')
    expect(fields[0].channel).toBe('AMAZON')
  })
})
