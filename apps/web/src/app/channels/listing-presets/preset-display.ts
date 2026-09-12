/** Human-readable labels for stored wizard defaults; value resolution stays on the API. */
export function displayPresetDefaults(input: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  const rows: Array<{ key: string; label: string; value: string }> = []
  const bag = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const strategy = bag(input.skuStrategy), variations = bag(input.variations)
  const labels: Record<string, string> = { parentSku: 'Parent SKU strategy', childSku: 'Variant SKU strategy', fbaFbm: 'Fulfilment SKU strategy' }
  const values: Record<string, string> = { shared: 'Shared across markets', 'per-marketplace': 'Separate for each market', same: 'Same SKU for FBA and FBM', suffixed: 'Add an FBA or FBM suffix' }
  for (const [key, label] of Object.entries(labels)) {
    if (Object.prototype.hasOwnProperty.call(strategy, key)) rows.push({ key: `skuStrategy.${key}`, label, value: values[String(strategy[key])] ?? String(strategy[key] ?? 'No value') })
  }
  if (Object.prototype.hasOwnProperty.call(variations, 'commonTheme')) rows.push({ key: 'variations.commonTheme', label: 'Default variation theme', value: String(variations.commonTheme || 'No theme selected') })
  for (const [channel, value] of Object.entries(bag(variations.themeByChannel))) rows.push({ key: `variations.themeByChannel.${channel}`, label: `${channel.replace(/[:_]/g, ' ')} variation theme`, value: String(value || 'No theme selected') })
  for (const [channel, value] of Object.entries(bag(variations.customAttributesByChannel))) rows.push({ key: `variations.customAttributesByChannel.${channel}`, label: `${channel.replace(/[:_]/g, ' ')} custom variation attributes`, value: Array.isArray(value) && value.length ? value.join(', ') : 'None' })
  return rows
}
