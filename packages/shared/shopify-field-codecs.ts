/** Shopify 2026-07 value formats. Store definitions supply constraints and availability.
 * https://shopify.dev/docs/apps/build/metafields/list-of-data-types
 * This table describes types, never merchant namespaces, keys or translated labels. */
export const shopifyMeasurementUnits: Record<string, readonly string[]> = {
  antenna_gain: ['decibels_isotropic', 'decibels_dipole'],
  area: ['square_centimeters', 'square_feet', 'square_inches', 'square_meters', 'square_yards'],
  battery_charge_capacity: ['milliamp_hours'], battery_energy_capacity: ['watt_hours'],
  capacitance: ['picofarads', 'nanofarads', 'microfarads', 'farads'],
  concentration: ['milligrams_per_gram', 'milligrams_per_milliliter'],
  data_storage_capacity: ['bytes', 'kilobytes', 'megabytes', 'gigabytes', 'terabytes'],
  data_transfer_rate: ['bits_per_second', 'kilobits_per_second', 'megabits_per_second', 'gigabits_per_second'],
  dimension: ['inches', 'feet', 'yards', 'millimeters', 'centimeters', 'meters'],
  display_density: ['pixels_per_inch', 'dots_per_inch'], distance: ['kilometers', 'miles'],
  duration: ['nanoseconds', 'microseconds', 'milliseconds', 'seconds', 'minutes', 'hours', 'days', 'months', 'years'],
  electric_current: ['milliamperes', 'amperes', 'kiloamperes'], electrical_resistance: ['ohms', 'kiloohms'],
  energy: ['joules', 'calories', 'kilojoules', 'kilocalories'], frequency: ['hertz', 'kilohertz', 'megahertz', 'gigahertz'],
  illuminance: ['lux', 'foot_candles'], inductance: ['microhenries', 'millihenries', 'henries'], luminous_flux: ['lumens'],
  mass_flow_rate: ['grams', 'ounces', 'pounds', 'kilograms', 'tons', 'tonnes'].flatMap(unit => ['day', 'hour', 'minute', 'second'].map(time => `${unit}_per_${time}`)),
  power: ['milliwatts', 'watts', 'horsepower', 'kilowatts'], pressure: ['pounds_per_square_inch', 'bars'],
  resolution: ['pixels', 'megapixels'], rotational_speed: ['revolutions_per_minute'], sound_level: ['decibels'],
  speed: ['kilometers_per_hour', 'feet_per_second', 'miles_per_hour', 'meters_per_second'],
  temperature: ['celsius', 'fahrenheit', 'kelvin'], thermal_power: ['british_thermal_units_per_hour', 'kilowatts', 'tons_of_refrigeration'],
  voltage: ['volts'], volume: ['milliliters', 'centiliters', 'liters', 'cubic_meters', 'us_fluid_ounces', 'us_pints', 'us_quarts', 'us_gallons', 'imperial_fluid_ounces', 'imperial_pints', 'imperial_quarts', 'imperial_gallons'],
  volumetric_flow_rate: ['liters', 'gallons', 'cubic_feet', 'cubic_meters'].flatMap(unit => ['hour', 'minute', 'second'].map(time => `${unit}_per_${time}`)),
  weight: ['ounces', 'pounds', 'grams', 'kilograms'],
}
const scalarTypes = ['single_line_text_field', 'multi_line_text_field', 'boolean', 'number_integer', 'number_decimal', 'date', 'date_time', 'color', 'url', 'id', 'language', 'jurisdiction', 'json', 'rich_text_field', 'money', 'rating', 'link']
const referenceTypes = ['product_reference', 'variant_reference', 'collection_reference', 'page_reference', 'article_reference', 'file_reference', 'metaobject_reference', 'mixed_reference', 'customer_reference', 'company_reference', 'order_reference', 'disclosure_reference', 'product_taxonomy_value_reference']
export function shopifyTypeSupported(type: string): boolean {
  const base = type.replace(/^list\./, '')
  return scalarTypes.includes(base) || referenceTypes.includes(base) || !!shopifyMeasurementUnits[base]
}
export function shopifyTypeReason(type: string): string | null {
  if (type.replace(/^list\./, '') === 'product_taxonomy_disclosure_reference') return 'Shopify lists this internal type, but the pinned 2026-07 API does not expose TaxonomyDisclosure resources for reading or selecting a value. Manage its taxonomy link through Shopify; the stored value is preserved.'
  return shopifyTypeSupported(type) ? null : `The ${type} type needs a Nexus value adapter. Its existing data is preserved; refresh the store schema after updating the connector.`
}
export const shopifyObjectType = (type: string) => !!shopifyMeasurementUnits[type] || ['money', 'rating', 'link'].includes(type)
export const shopifyDecimal = (value: unknown): boolean => (typeof value === 'number' || typeof value === 'string') && /^-?\d+(\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value))
export function shopifyObjectError(type: string, value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Enter a structured value.'
  const v = value as Record<string, unknown>
  if (shopifyMeasurementUnits[type]) {
    if (!shopifyDecimal(v.value)) return 'Enter a numeric measurement.'
    if (!shopifyMeasurementUnits[type].includes(String(v.unit))) return 'Choose a unit supported by this measurement type.'
  }
  if (type === 'money' && (!shopifyDecimal(v.amount) || !/^[A-Z]{3}$/.test(String(v.currency_code)))) return 'Enter an amount and a three-letter currency code.'
  if (type === 'rating' && (![v.value, v.scale_min, v.scale_max].every(shopifyDecimal) || Number(v.scale_min) >= Number(v.scale_max) || Number(v.value) < Number(v.scale_min) || Number(v.value) > Number(v.scale_max))) return 'Enter a rating within its declared scale.'
  if (type === 'link') {
    if (typeof v.text !== 'string' || !v.text.trim()) return 'Enter the link text.'
    try { if (typeof v.url !== 'string' || !['https:', 'http:'].includes(new URL(v.url).protocol)) return 'Enter an HTTP or HTTPS link.' } catch { return 'Enter a valid link URL.' }
  }
  return null
}
