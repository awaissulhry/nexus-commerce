import { optionLabel } from './optionLabel'
import { optionCode, parseScalarValue } from '@/design-system/grid/editors/scalarValue'
import { compareForAgGrid } from '@/design-system/grid/sortValues'
import { marketLabel } from '../scopes'
import { isReferenceField } from '@nexus/shared/reference-values'

export type ReferenceLabels = Record<string, Record<string, string>>
export interface NamedColumn { key: string; kind: string; shape?: string; options?: string[]; optionLabels?: Record<string, string> }

/** Reference labels are display metadata; only the server may resolve an assignment. */
export function parseReferenceOrScalarValue(column: NamedColumn, value: unknown): unknown {
  return isReferenceField(column.key) ? value === '' ? null : value : parseScalarValue(column, value)
}

export function mergeReferenceLabels(current: ReferenceLabels, incoming: ReferenceLabels): ReferenceLabels {
  const result = { ...current }
  for (const [key, names] of Object.entries(incoming)) {
    const known = Object.fromEntries(Object.entries(names).filter(([, name]) => typeof name === 'string' && name.trim()))
    result[key] = { ...current[key], ...known }
  }
  return result
}

/** Database IDs and provider IDs identify a marketplace; country codes name the country. */
export function marketplaceReferenceLabels(body: unknown, channel: string): Record<string, string> {
  const candidates = new Map<string, Set<string>>()
  const add = (id: unknown, label: unknown) => {
    if (typeof id !== 'string' || !id || typeof label !== 'string' || !label.trim()) return
    const names = candidates.get(id) ?? new Set<string>()
    names.add(label.trim()); candidates.set(id, names)
  }
  if (!Array.isArray(body)) return {}
  for (const item of body) {
    if (!item || (channel !== 'MASTER' && item.channel !== channel) || typeof item.code !== 'string') continue
    const code = item.code.toUpperCase()
    const country = marketLabel(code === 'GB' ? 'UK' : code).split(' · ').pop()!
    add(code, country)
    if (code === 'GB' || code === 'UK') { add('GB', country); add('UK', country) }
    add(item.id, item.name); add(item.marketplaceId, item.name)
  }
  return Object.fromEntries([...candidates].filter(([, names]) => names.size === 1).map(([id, names]) => [id, [...names][0]]))
}

const fulfillmentLabels = {
  DEFAULT: 'Fulfilled by merchant (FBM)', MFN: 'Fulfilled by merchant (FBM)', FBM: 'Fulfilled by merchant (FBM)',
  AFN: 'Fulfilled by Amazon (FBA)', FBA: 'Fulfilled by Amazon (FBA)',
  AMAZON_EU: 'Fulfilled by Amazon (Europe)', AMAZON_NA: 'Fulfilled by Amazon (North America)',
  AMAZON_JP: 'Fulfilled by Amazon (Japan)', AMAZON_IN: 'Fulfilled by Amazon (India)',
}
const fixedLabels: ReferenceLabels = {
  fulfillmentChannel: fulfillmentLabels,
  fulfillment_channel_code: fulfillmentLabels,
  // `fulfillment_availability__fulfillment_channel_code` is the Amazon scope's Fulfillment method column: the server
  // labels it FBA / FBM in Nexus's own words (channel-specs/amazon.ts), so no fixed table overrides it here.
  listingFormat: { FIXED_PRICE: 'Fixed price', AUCTION: 'Auction' },
  listingDuration: { GTC: 'Good until cancelled', ...Object.fromEntries([1, 3, 5, 7, 10, 30].map(days => [`DAYS_${days}`, `${days} ${days === 1 ? 'day' : 'days'}`])) },
  descriptionThemeId: { none: 'No theme' },
}

/**
 * Item 7 (product sheet consistency, 2026-10-05) — a name two or more options share is shown with its code, as
 * Amazon's own template does: Amazon's size list names `numeric_100` and `numeric_height_100` both "100". Display only:
 * the codes, the allowed values, paste of a code and the server's autocorrect stay as they are (a pasted bare "100"
 * still matches no single option). An option whose name IS its code keeps it.
 */
function qualifySharedLabels(options: readonly string[], names: Record<string, string>): void {
  const fold = (name: string) => name.trim().toLowerCase()
  const shown = [...new Set(options)].map(code => ({ code, name: names[code] ?? code }))
  const counts = new Map<string, number>()
  for (const { name } of shown) counts.set(fold(name), (counts.get(fold(name)) ?? 0) + 1)
  for (const { code, name } of shown) {
    if ((counts.get(fold(name)) ?? 0) > 1 && name !== code) names[code] = `${name} (${code})`
  }
}

/** Add display metadata only. IDs, allowed values, validation and row objects stay intact. */
export function nameReferenceColumns<C extends NamedColumn>(columns: C[], labels: ReferenceLabels): Array<C & Pick<NamedColumn, 'optionLabels'>> {
  return columns.map(column => {
    const names = { ...column.optionLabels, ...labels[column.key], ...fixedLabels[column.key] }
    // Provider enums occasionally repeat their machine key as the display name.
    // Only humanize declared enum labels, never opaque IDs or free-form product content.
    for (const code of column.options ?? []) {
      // Amazon's variation-axis codes are English, even when PTD labels are localized codes.
      const name = column.key === 'variation_theme' ? code : names[code] ?? code
      if (/^[A-Z]+(?:_[A-Z]+)+(?:\/[A-Z_]+)*$/.test(name)) {
        names[code] = name.split('/').map(part => part.charAt(0) + part.slice(1).toLowerCase().replace(/_/g, ' ')).join(' / ')
      }
    }
    qualifySharedLabels(column.options ?? [], names)
    return Object.keys(names).length ? { ...column, optionLabels: names } : column
  })
}

/** Text references need the same names for filtering, sorting and clipboard as for rendering. */
export function referenceColumnDef<R>(column: NamedColumn, valueOf: (row: R) => unknown): {
  valueFormatter?: (p: { value: unknown }) => string
  getQuickFilterText?: (p: { value: unknown }) => string
  valueParser?: (p: { newValue: unknown }) => unknown
  filterValueGetter?: (p: { data?: R }) => string
  comparator?: (a: unknown, b: unknown, nodeA?: unknown, nodeB?: unknown, descending?: boolean) => number
} {
  if (column.shape === 'list' || column.shape === 'measure' || column.kind === 'boolean') return {}
  const referenceParser = isReferenceField(column.key) ? { valueParser: (p: { newValue: unknown }) => p.newValue } : {}
  if (!column.optionLabels) return referenceParser
  const label = (value: unknown) => optionLabel(value, column.optionLabels)
  return {
    valueFormatter: (p: { value: unknown }) => label(p.value),
    getQuickFilterText: (p: { value: unknown }) => label(p.value),
    ...(column.kind === 'text' ? {
      valueParser: (p: { newValue: unknown }) => typeof p.newValue === 'string' && !isReferenceField(column.key)
        ? optionCode({ options: Object.keys(column.optionLabels!), optionLabels: column.optionLabels }, p.newValue) : p.newValue,
      filterValueGetter: (p: { data?: R }) => p.data ? label(valueOf(p.data)) : '',
      comparator: (a, b, _nodeA, _nodeB, descending = false) => compareForAgGrid(label(a) || null, label(b) || null, descending),
    } : {}),
    ...referenceParser,
  }
}

export function referenceSearchText(value: unknown, labels?: Record<string, string>): string {
  const names = (Array.isArray(value) ? value : [value]).map(item => optionLabel(item, labels)).join(' ')
  return `${value ?? ''} ${names}`.trim().toLowerCase()
}

export function referenceTooltip(value: unknown, labels?: Record<string, string>): string | undefined {
  if (value == null || value === '' || Array.isArray(value) || !labels) return undefined
  const name = optionLabel(value, labels)
  return name !== String(value) ? `${name}\nID: ${String(value)}` : undefined
}
