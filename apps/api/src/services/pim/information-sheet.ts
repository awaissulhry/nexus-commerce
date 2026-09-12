import { getStudioSheet, type GetStudioSheetInput, type StudioSheet } from './studio-sheet.service.js'

/** The operator-facing sheet, including native channel adapters, shared by every studio surface. */
export async function getInformationSheet(input: GetStudioSheetInput): Promise<StudioSheet> {
  const sheet = await getStudioSheet(input)
  if (sheet.scope.channel !== 'SHOPIFY') return sheet
  const { enrichShopifyChannelSheet } = await import('../shopify/channel-sheet.service.js')
  return enrichShopifyChannelSheet(sheet)
}
