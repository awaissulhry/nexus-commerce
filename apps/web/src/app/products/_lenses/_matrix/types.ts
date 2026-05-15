// Supported content-locale codes for the Status Matrix master columns.
// These are product translation languages, independent of the UI locale.
export const CONTENT_LOCALES = ['en', 'it', 'de', 'fr', 'es'] as const
export type ContentLocale = (typeof CONTENT_LOCALES)[number]

export const CONTENT_LOCALE_LABELS: Record<ContentLocale, string> = {
  en: 'English',
  it: 'Italiano',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
}

export const CONTENT_LOCALE_FLAGS: Record<ContentLocale, string> = {
  en: '🇬🇧',
  it: '🇮🇹',
  de: '🇩🇪',
  fr: '🇫🇷',
  es: '🇪🇸',
}

// Channels that appear as column groups in the matrix.
export const CHANNEL_GROUPS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number]

// Per-channel marketplace codes. SHOPIFY has a single global store.
export const CHANNEL_MARKETPLACES: Record<ChannelGroup, string[]> = {
  AMAZON: ['IT', 'DE', 'FR', 'UK', 'ES'],
  EBAY: ['IT', 'DE', 'FR', 'UK'],
  SHOPIFY: ['GLOBAL'],
}

export const CHANNEL_LABELS: Record<ChannelGroup, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
}

// Traffic-light status for a single (channel, marketplace) cell.
// 'override' = listing is live but at least one followMaster* flag is false.
export type TrafficLight = 'live' | 'override' | 'error' | 'none'

export interface MarketplaceCoverageCell {
  status: TrafficLight
  // For parent rows: counts of children in a given status.
  errorChildCount: number
  overrideChildCount: number
  totalChildren: number
}

// Key format used in the marketplaceCoverage map: "AMAZON:IT", "EBAY:DE", etc.
export type MarketplaceKey = `${ChannelGroup}:${string}`

import type { ProductRow } from '../../_types'

// Flat row type shared by MatrixTable and StatusMatrixLens.
export type MatrixFlatRow =
  | { kind: 'parent'; product: ProductRow; depth: 0 }
  | { kind: 'child'; product: ProductRow; depth: 1 }

// Translations map returned from the API (top locales only).
export type ProductTranslations = Partial<Record<ContentLocale, { name: string; description: string | null }>>
