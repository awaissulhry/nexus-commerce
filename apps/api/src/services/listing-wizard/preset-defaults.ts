/** Listing presets carry reusable behavior, never the preview product's facts or identities. */
type Bag = Record<string, unknown>
const record = (value: unknown): Bag => value && typeof value === 'object' && !Array.isArray(value) ? value as Bag : {}
const unsafe = new Set(['__proto__', 'prototype', 'constructor'])

export function reusablePresetDefaults(state: unknown): { defaults: Bag; excluded: string[] } {
  const input = record(state), defaults: Bag = {}, excluded: string[] = []
  const strategy = record(input.skuStrategy), pickedStrategy: Bag = {}
  for (const [key, value] of Object.entries(strategy)) {
    const allowed = key === 'fbaFbm' ? ['same', 'suffixed'] : ['parentSku', 'childSku'].includes(key) ? ['shared', 'per-marketplace'] : []
    if (typeof value === 'string' && allowed.includes(value)) pickedStrategy[key] = value
    else excluded.push(`skuStrategy.${key}`)
  }
  if (Object.keys(pickedStrategy).length) defaults.skuStrategy = pickedStrategy
  const variations = record(input.variations), pickedVariations: Bag = {}
  for (const [key, value] of Object.entries(variations)) {
    if (key === 'commonTheme' && typeof value === 'string') pickedVariations[key] = value
    else if (key === 'themeByChannel' || key === 'customAttributesByChannel') {
      const entries = Object.entries(record(value)).filter(([channel, v]) => !unsafe.has(channel) &&
        (key === 'themeByChannel' ? typeof v === 'string' : Array.isArray(v) && v.every(item => typeof item === 'string')))
      if (entries.length) pickedVariations[key] = Object.fromEntries(entries)
      if (entries.length !== Object.keys(record(value)).length) excluded.push(`variations.${key}`)
    } else excluded.push(`variations.${key}`)
  }
  if (Object.keys(pickedVariations).length) defaults.variations = pickedVariations
  for (const key of Object.keys(input)) if (!['skuStrategy', 'variations'].includes(key)) excluded.push(key)
  return { defaults, excluded }
}

/** Only absent keys inherit. Explicit blanks, false, zero, arrays and null remain owned values. */
export function fillPresetDefaults(existing: Bag, defaults: Bag): Bag {
  const result: Bag = { ...existing }
  for (const [key, value] of Object.entries(defaults)) {
    if (unsafe.has(key)) continue
    if (!Object.prototype.hasOwnProperty.call(existing, key)) result[key] = value
    else if (value && typeof value === 'object' && !Array.isArray(value) && existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])) {
      result[key] = fillPresetDefaults(record(existing[key]), record(value))
    }
  }
  return result
}
