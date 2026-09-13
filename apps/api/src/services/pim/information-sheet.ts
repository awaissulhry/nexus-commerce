import { getStudioSheet, type GetStudioSheetInput, type StudioSheet } from './studio-sheet.service.js'
import { sheetLanguages, widenLanguageSheets } from './language-sheet.js'

/** One operator sheet pipeline for a single language and the saved Languages view. */
export async function getInformationSheet(input: GetStudioSheetInput): Promise<StudioSheet> {
  if (input.locales) {
    const started = Date.now()
    const sheets = await Promise.all(sheetLanguages(input.locales).map(locale => getInformationSheet({ ...input, locales: undefined, locale })))
    const sheet = widenLanguageSheets(sheets)
    return { ...sheet, meta: { ...sheet.meta, tookMs: Date.now() - started } }
  }
  const sheet = await getStudioSheet(input)
  if (sheet.scope.channel !== 'SHOPIFY') return sheet
  const { enrichShopifyChannelSheet } = await import('../shopify/channel-sheet.service.js')
  return enrichShopifyChannelSheet(sheet)
}
