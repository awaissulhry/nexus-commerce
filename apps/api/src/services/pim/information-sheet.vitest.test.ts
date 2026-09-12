import { expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ sheet: vi.fn(), enrich: vi.fn() }))
vi.mock('./studio-sheet.service.js', () => ({ getStudioSheet: calls.sheet }))
vi.mock('../shopify/channel-sheet.service.js', () => ({ enrichShopifyChannelSheet: calls.enrich }))
import { getInformationSheet } from './information-sheet.js'

it('preserves the exact channel/account/market/locale and applies the same native adapter to every consumer', async () => {
  const input = { productId: 'parent', scope: 'channel' as const, channel: 'SHOPIFY', market: 'GLOBAL', accountId: 'store', locale: 'de' }
  const raw = { scope: { channel: 'SHOPIFY' }, rows: [] }
  const enriched = { ...raw, rows: [{ id: 'native-child', completeness: { overall: { pct: 73 } } }] }
  calls.sheet.mockResolvedValue(raw); calls.enrich.mockResolvedValue(enriched)
  expect(await getInformationSheet(input)).toBe(enriched)
  expect(calls.sheet).toHaveBeenCalledWith(input)
  expect(calls.enrich).toHaveBeenCalledWith(raw)
})

it('returns ordinary channel rows without replacing resolved nulls or rebuilding completeness', async () => {
  const raw = { scope: { channel: 'EBAY' }, rows: [{ values: { color: { value: null } }, completeness: { overall: { pct: 76 } } }] }
  calls.sheet.mockResolvedValue(raw)
  expect(await getInformationSheet({ productId: 'p', scope: 'channel', channel: 'EBAY', market: 'IT' })).toBe(raw)
})
