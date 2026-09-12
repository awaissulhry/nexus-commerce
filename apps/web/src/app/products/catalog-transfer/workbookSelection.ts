import { transferIsStore } from '@nexus/shared/catalog-transfer'
import type { TransferOptions } from './sourceMapping'

export type WorkbookDestination = { accountId: string; marketplace: string; category: string }
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })
export const languageName = (code: string) => { try { return languageNames.of(code) ?? code } catch { return code } }
export const channelName = (channel: string) => ({ AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' } as Record<string, string>)[channel] ?? channel
export const categoryName = (value: string) => value.includes('_') || /^[A-Z]+$/.test(value) ? value.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : value
export function destinationMarkets(options: TransferOptions, accountId: string) {
  const account = options.accounts.find(a => a.id === accountId)
  return options.markets.filter(m => m.channel === account?.channelType && (!account.marketplace || account.marketplace === 'GLOBAL' || account.marketplace === m.code))
}
export function destinationCategories(options: TransferOptions, destination: WorkbookDestination) {
  const channel = options.accounts.find(a => a.id === destination.accountId)?.channelType
  return [...new Set((options.channelCategories ?? []).filter(c => c.channel === channel && (!c.marketplace || c.marketplace === destination.marketplace || c.marketplace === `EBAY_${destination.marketplace}`)).map(c => c.productType))]
}
export function destinationCategoryLabel(options: TransferOptions, destination: WorkbookDestination, category: string) {
  const channel = options.accounts.find(a => a.id === destination.accountId)?.channelType
  const matches = (options.channelCategories ?? []).filter(c => c.channel === channel && c.productType === category)
  return matches.find(c => c.marketplace === destination.marketplace || c.marketplace === `EBAY_${destination.marketplace}`)?.label
    || matches.find(c => !c.marketplace)?.label || categoryName(category)
}
export function workbookSelection(options: TransferOptions, destinations: WorkbookDestination[], extraLanguages: string[]) {
  const requiredLanguages = [...new Set(destinations.flatMap(d => destinationMarkets(options, d.accountId).find(m => m.code === d.marketplace)?.language?.toLowerCase() ?? []))]
  const languages = [...new Set([...requiredLanguages, ...extraLanguages.map(l => l.trim().toLowerCase()).filter(Boolean)])]
  const seen = new Set<string>()
  const destinationErrors = destinations.map(d => {
    if (!options.accounts.some(a => a.id === d.accountId)) return 'Choose a seller account.'
    if (!destinationMarkets(options, d.accountId).some(m => m.code === d.marketplace)) return 'Choose a marketplace available for this account.'
    const store = transferIsStore(options.accounts.find(a => a.id === d.accountId)!.channelType)
    if (!store && !d.category) return 'Choose the product category for this marketplace.'
    if (!store && !destinationCategories(options, d).includes(d.category)) return 'This category has no available field definition. Refresh its channel category before creating a workbook.'
    const key = JSON.stringify([d.accountId, d.marketplace, d.category])
    if (seen.has(key)) return 'This account, marketplace and category is already included. Remove this destination or choose another.'
    seen.add(key)
    return ''
  })
  const languageError = languages.some(l => !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(l)) ? 'Use language codes such as it, de or en-gb, separated by commas.' : languages.length > 30 ? 'Choose at most 30 languages, including marketplace languages.' : ''
  return { requiredLanguages, languages, destinationErrors, languageError }
}
