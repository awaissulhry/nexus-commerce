import { describe, expect, it } from 'vitest'
import { shopifyMeasurementUnits } from './shopify-field-codecs'
import { validateShopifyField } from './shopify-linked-products'
import { shopifyMeasurementBreaksLimit, shopifyMeasurementLimitReadable, shopifyMeasurementReadings, shopifyMeasurementShortNames, shopifyMeasurementUnit } from './shopify-measurement-limits'
import { SHOPIFY_MEASUREMENT_KINDS } from './shopify-type-catalog'

/*
 * Lane B slice B3a (docs/shopify-metafields/PLAN-2026-09-28.md §5, §6.3, gap G14): a measurement limit in any unit of its
 * kind, for all 32 kinds. Nexus refuses only when Shopify certainly would, with the §5 sentence and the limit in its own
 * words; a limit it cannot read or convert is left to Shopify's check at publish.
 */
const check = (type: string, rule: string, limit: unknown, value: unknown) =>
  validateShopifyField({ type, validations: [{ name: rule, value: typeof limit === 'string' ? limit : JSON.stringify(limit) }] }, JSON.stringify(value))

describe('B3a · the unit table covers every kind and every unit', () => {
  it('has 32 kinds, and every long unit converts in every reading (temperature by its own scale)', () => {
    expect(SHOPIFY_MEASUREMENT_KINDS).toHaveLength(32)
    for (const kind of SHOPIFY_MEASUREMENT_KINDS) {
      const units = shopifyMeasurementUnits[kind]
      if (kind === 'temperature') { expect(shopifyMeasurementReadings(kind)).toEqual([]); continue }
      const readings = shopifyMeasurementReadings(kind)
      expect(readings.length, kind).toBeGreaterThan(0)
      for (const reading of readings) {
        expect(Object.keys(reading).sort(), kind).toEqual([...units].sort())
        for (const [base, size] of Object.values(reading)) { expect(base).not.toBe(''); expect(size).toBeGreaterThan(0) }
      }
    }
  })
  it('maps every short name to a long name of the same kind, and reads long names as themselves', () => {
    for (const kind of SHOPIFY_MEASUREMENT_KINDS) {
      for (const unit of shopifyMeasurementUnits[kind]) expect(shopifyMeasurementUnit(kind, unit)).toBe(unit)
      for (const [short, long] of Object.entries(shopifyMeasurementShortNames(kind))) {
        expect(shopifyMeasurementUnits[kind], `${kind} · ${short}`).toContain(long)
        expect(shopifyMeasurementUnit(kind, short)).toBe(long)
      }
    }
  })
  it('reads Shopify’s documented short units and a few symbols exactly; case matters; another kind’s unit is unknown', () => {
    expect(['g', 'ml', 'cm'].map((unit, i) => shopifyMeasurementUnit(['weight', 'volume', 'dimension'][i], unit))).toEqual(['grams', 'milliliters', 'centimeters'])
    expect(shopifyMeasurementUnit('temperature', '°C')).toBe('celsius')
    expect(shopifyMeasurementUnit('speed', 'km/h')).toBe('kilometers_per_hour')
    expect(shopifyMeasurementUnit('power', 'mW')).toBe('milliwatts')
    expect(shopifyMeasurementUnit('power', 'MW')).toBeNull()
    expect(shopifyMeasurementUnit('electrical_resistance', 'Ω')).toBe('ohms')
    expect(shopifyMeasurementUnit('electrical_resistance', 'Ω')).toBe('ohms')
    expect(shopifyMeasurementUnit('weight', 'KILOGRAMS')).toBeNull()
    expect(shopifyMeasurementUnit('weight', 'liters')).toBeNull()
    expect(shopifyMeasurementUnit('weight', 'parsecs')).toBeNull()
  })
})

/* For every kind: a limit in a DIFFERENT unit (a short name when the kind has one unit, or when its units do not convert),
   a value just inside it and one just outside it, and the exact sentence. Values computed by hand, then by a scratch run. */
const EVERY_KIND: Array<[kind: string, rule: 'min' | 'max', limit: { unit: string; value: number }, unit: string, inside: number, outside: number, sentence: string]> = [
  ['antenna_gain', 'max', { unit: 'dBi', value: 5 }, 'decibels_isotropic', 5, 5.01, 'Enter 5 dBi or less.'],
  ['area', 'max', { unit: 'square_meters', value: 2 }, 'square_feet', 21.527, 21.53, 'Enter 2 square meters or less.'],
  ['battery_charge_capacity', 'min', { unit: 'mAh', value: 3000 }, 'milliamp_hours', 3000, 2999.9, 'Enter 3000 mAh or more.'],
  ['battery_energy_capacity', 'max', { unit: 'Wh', value: 100 }, 'watt_hours', 100, 100.1, 'Enter 100 Wh or less.'],
  ['capacitance', 'max', { unit: 'microfarads', value: 2 }, 'nanofarads', 2000, 2000.1, 'Enter 2 microfarads or less.'],
  ['concentration', 'max', { unit: 'mg/g', value: 5 }, 'milligrams_per_gram', 5, 5.1, 'Enter 5 mg/g or less.'],
  ['data_storage_capacity', 'max', { unit: 'gigabytes', value: 2 }, 'megabytes', 2000, 2049, 'Enter 2 gigabytes or less.'],
  ['data_transfer_rate', 'min', { unit: 'megabits_per_second', value: 100 }, 'kilobits_per_second', 102400, 99999, 'Enter 100 megabits per second or more.'],
  ['dimension', 'max', { unit: 'ft', value: 3 }, 'centimeters', 91.44, 91.45, 'Enter 3 ft or less.'],
  ['display_density', 'min', { unit: 'ppi', value: 300 }, 'pixels_per_inch', 300, 299, 'Enter 300 ppi or more.'],
  ['distance', 'max', { unit: 'miles', value: 2 }, 'kilometers', 3.2186, 3.2187, 'Enter 2 miles or less.'],
  ['duration', 'max', { unit: 'hours', value: 2 }, 'minutes', 120, 120.01, 'Enter 2 hours or less.'],
  ['electric_current', 'max', { unit: 'A', value: 2 }, 'milliamperes', 2000, 2000.5, 'Enter 2 A or less.'],
  ['electrical_resistance', 'min', { unit: 'kiloohms', value: 2 }, 'ohms', 2000, 1999.9, 'Enter 2 kiloohms or more.'],
  ['energy', 'max', { unit: 'kilojoules', value: 2000 }, 'kilocalories', 477.6, 478.1, 'Enter 2000 kilojoules or less.'],
  ['frequency', 'max', { unit: 'GHz', value: 2.4 }, 'megahertz', 2400, 2400.1, 'Enter 2.4 GHz or less.'],
  ['illuminance', 'min', { unit: 'foot_candles', value: 50 }, 'lux', 538.2, 538.19, 'Enter 50 foot candles or more.'],
  ['inductance', 'max', { unit: 'mH', value: 2 }, 'microhenries', 2000, 2000.1, 'Enter 2 mH or less.'],
  ['luminous_flux', 'min', { unit: 'lm', value: 800 }, 'lumens', 800, 799.9, 'Enter 800 lm or more.'],
  ['mass_flow_rate', 'max', { unit: 'kilograms_per_hour', value: 36 }, 'grams_per_second', 10, 10.01, 'Enter 36 kilograms per hour or less.'],
  ['power', 'max', { unit: 'horsepower', value: 2 }, 'kilowatts', 1.47, 1.493, 'Enter 2 horsepower or less.'],
  ['pressure', 'max', { unit: 'psi', value: 30 }, 'bars', 2.068, 2.069, 'Enter 30 psi or less.'],
  ['resolution', 'min', { unit: 'MP', value: 12 }, 'megapixels', 12, 11.9, 'Enter 12 MP or more.'],
  ['rotational_speed', 'max', { unit: 'rpm', value: 3000 }, 'revolutions_per_minute', 3000, 3000.5, 'Enter 3000 rpm or less.'],
  ['sound_level', 'max', { unit: 'dB', value: 85 }, 'decibels', 85, 85.1, 'Enter 85 dB or less.'],
  ['speed', 'max', { unit: 'miles_per_hour', value: 30 }, 'kilometers_per_hour', 48.28, 48.29, 'Enter 30 miles per hour or less.'],
  ['temperature', 'min', { unit: 'fahrenheit', value: 14 }, 'celsius', -10, -10.01, 'Enter 14 fahrenheit or more.'],
  ['thermal_power', 'max', { unit: 'kilowatts', value: 3.5 }, 'british_thermal_units_per_hour', 11940, 11960, 'Enter 3.5 kilowatts or less.'],
  ['voltage', 'max', { unit: 'V', value: 230 }, 'volts', 230, 230.1, 'Enter 230 V or less.'],
  ['volume', 'max', { unit: 'us_gallons', value: 2 }, 'liters', 7.57, 7.571, 'Enter 2 us gallons or less.'],
  ['volumetric_flow_rate', 'max', { unit: 'cubic_meters_per_hour', value: 3.6 }, 'liters_per_second', 1, 1.001, 'Enter 3.6 cubic meters per hour or less.'],
  ['weight', 'min', { unit: 'lb', value: 2 }, 'kilograms', 0.9072, 0.9071, 'Enter 2 lb or more.'],
]

describe('B3a · every kind: a limit in another unit, a value just inside and just outside', () => {
  it('covers all 32 kinds once', () => {
    expect(EVERY_KIND.map(row => row[0]).sort()).toEqual([...SHOPIFY_MEASUREMENT_KINDS].sort())
  })
  it.each(EVERY_KIND)('%s %s %j: %s', (kind, rule, limit, unit, inside, outside, sentence) => {
    expect(limit.unit).not.toBe(unit)
    expect(check(kind, rule, limit, { value: inside, unit })).toBeNull()
    expect(check(kind, rule, limit, { value: outside, unit })).toBe(sentence)
    expect(check(`list.${kind}`, rule, limit, [{ value: inside, unit }, { value: outside, unit }])).toBe(`Value 2: ${sentence}`)
  })
  it('a value exactly at a limit in another unit is inside, whatever the floating-point dust (2000 nF is 2.0000000000000003 µF)', () => {
    expect(2000 * 1e-9).not.toBe(2 * 1e-6)
    expect(check('capacitance', 'max', { unit: 'microfarads', value: 2 }, { value: 2000, unit: 'nanofarads' })).toBeNull()
    expect(check('capacitance', 'min', { unit: 'microfarads', value: 2 }, { value: 2000, unit: 'nanofarads' })).toBeNull()
    expect(check('dimension', 'min', { unit: 'ft', value: 3 }, { value: 91.44, unit: 'centimeters' })).toBeNull()
  })
  it('the same unit compares the typed numbers exactly, with no tolerance', () => {
    expect(check('weight', 'max', { unit: 'kilograms', value: 2 }, { value: 2.000000000001, unit: 'kilograms' })).toBe('Enter 2 kilograms or less.')
    expect(check('weight', 'max', { unit: 'kg', value: 2 }, { value: '2.0', unit: 'kilograms' })).toBeNull()
  })
})

describe('B3a · temperature across Celsius, Fahrenheit and kelvin (not a plain factor)', () => {
  it.each([
    ['min', { unit: 'fahrenheit', value: 14 }, 'celsius', -10, -10.01, 'Enter 14 fahrenheit or more.'],
    ['min', { unit: 'fahrenheit', value: 14 }, 'kelvin', 263.15, 263.14, 'Enter 14 fahrenheit or more.'],
    ['min', { unit: 'fahrenheit', value: 14 }, 'fahrenheit', 14, 13.99, 'Enter 14 fahrenheit or more.'],
    ['max', { unit: 'kelvin', value: 323.15 }, 'celsius', 50, 50.01, 'Enter 323.15 kelvin or less.'],
    ['max', { unit: 'kelvin', value: 323.15 }, 'fahrenheit', 122, 122.01, 'Enter 323.15 kelvin or less.'],
    ['max', { unit: 'celsius', value: 100 }, 'fahrenheit', 212, 212.01, 'Enter 100 celsius or less.'],
    ['max', { unit: 'celsius', value: 100 }, 'kelvin', 373.15, 373.16, 'Enter 100 celsius or less.'],
    ['min', { unit: 'celsius', value: -40 }, 'fahrenheit', -40, -40.01, 'Enter -40 celsius or more.'],
    ['min', { unit: 'kelvin', value: 0 }, 'celsius', -273.15, -273.16, 'Enter 0 kelvin or more.'],
    ['max', { unit: '°C', value: 0 }, 'fahrenheit', 32, 32.01, 'Enter 0 °C or less.'],
    ['max', { unit: 'F', value: 32 }, 'kelvin', 273.15, 273.16, 'Enter 32 F or less.'],
  ] as const)('%s %j vs %s: %d inside, %d outside', (rule, limit, unit, inside, outside, sentence) => {
    expect(check('temperature', rule, limit, { value: inside, unit })).toBeNull()
    expect(check('temperature', rule, limit, { value: outside, unit })).toBe(sentence)
  })
})

describe('B3a · refused only when Shopify certainly refuses', () => {
  it('a unit Shopify does not define is refused only when EVERY reading refuses (inside under one reading → allowed)', () => {
    // A kilobyte of 1,000 or 1,024 bytes: 2,040 MB is over 2 GB of 1,000, under 2 GB of 1,024.
    expect(check('data_storage_capacity', 'max', { unit: 'gigabytes', value: 2 }, { value: 2040, unit: 'megabytes' })).toBeNull()
    // Both readings agree that 3,073 KB is over 3 MB (3,073,000 > 3,000,000 and 3,146,752 > 3,145,728), though the widest
    // spans overlap (3,073,000 < 3,145,728): the prefixes are read together, one convention at a time.
    expect(check('data_storage_capacity', 'max', { unit: 'megabytes', value: 3 }, { value: 3073, unit: 'kilobytes' })).toBe('Enter 3 megabytes or less.')
    // Thermochemical or international calorie: 477.9 kcal is 1999.5 or 2000.9 kJ.
    expect(check('energy', 'max', { unit: 'kilojoules', value: 2000 }, { value: 477.9, unit: 'kilocalories' })).toBeNull()
    // A US or an imperial gallon: 2.5 gallons a minute is 9.46 or 11.37 litres.
    expect(check('volumetric_flow_rate', 'max', { unit: 'liters_per_minute', value: 10 }, { value: 2.5, unit: 'gallons_per_minute' })).toBeNull()
    expect(check('volumetric_flow_rate', 'max', { unit: 'liters_per_minute', value: 10 }, { value: 2.7, unit: 'gallons_per_minute' })).toBe('Enter 10 liters per minute or less.')
    // Metric, mechanical or electrical horsepower: 2.7 hp is 1986 to 2014 W.
    expect(check('power', 'max', { unit: 'kilowatts', value: 2 }, { value: 2.7, unit: 'horsepower' })).toBeNull()
    // A short or a long ton: 1.05 t/h is 953 or 1067 kg/h …
    expect(check('mass_flow_rate', 'max', { unit: 'kilograms_per_hour', value: 1000 }, { value: 1.05, unit: 'tons_per_hour' })).toBeNull()
    // … but tons against tons are exact, whichever ton it is: 1.05 t/h is 25.2 t/day.
    expect(check('mass_flow_rate', 'max', { unit: 'tons_per_day', value: 24 }, { value: 1.05, unit: 'tons_per_hour' })).toBe('Enter 24 tons per day or less.')
    // A ton of refrigeration is 12,000 BTU/h under every BTU.
    expect(check('thermal_power', 'max', { unit: 'TR', value: 2 }, { value: 24001, unit: 'british_thermal_units_per_hour' })).toBe('Enter 2 TR or less.')
    expect(check('thermal_power', 'max', { unit: 'TR', value: 2 }, { value: 24000, unit: 'british_thermal_units_per_hour' })).toBeNull()
  })
  it('units that do not convert are never compared', () => {
    expect(check('antenna_gain', 'max', { unit: 'dBi', value: 5 }, { value: 10, unit: 'decibels_dipole' })).toBeNull()
    expect(check('concentration', 'max', { unit: 'mg/g', value: 5 }, { value: 50, unit: 'milligrams_per_milliliter' })).toBeNull()
    expect(check('display_density', 'min', { unit: 'ppi', value: 300 }, { value: 72, unit: 'dots_per_inch' })).toBeNull()
    expect(check('resolution', 'min', { unit: 'megapixels', value: 12 }, { value: 100, unit: 'pixels' })).toBeNull()
    // A month has no fixed number of days; months and years convert between themselves only.
    expect(check('duration', 'max', { unit: 'days', value: 60 }, { value: 3, unit: 'months' })).toBeNull()
    expect(check('duration', 'max', { unit: 'years', value: 2 }, { value: 24, unit: 'months' })).toBeNull()
    expect(check('duration', 'max', { unit: 'years', value: 2 }, { value: 25, unit: 'months' })).toBe('Enter 2 years or less.')
  })
  it('a limit Nexus cannot read is allowed, never refused with "cannot be read"', () => {
    for (const limit of ['{"unit":"parsecs","value":3}', '{"unit":"liters","value":3}', '{"value":3}', '{"unit":"kg"}', '{"unit":"kg","value":"x"}', '3', 'abc', '[1]', 'null']) {
      expect(check('weight', 'max', limit, { value: 999, unit: 'kilograms' }), limit).toBeNull()
    }
    expect(check('temperature', 'min', '{"unit":"rankine","value":500}', { value: -200, unit: 'celsius' })).toBeNull()
  })
  it('a stored value in a unit of another kind is still refused by its own rule first', () => {
    expect(check('weight', 'max', { unit: 'kg', value: 2 }, { value: 1, unit: 'liters' })).toBe('Choose a unit from the list.')
  })
  it('the helper says false (not "breaks") when a number is missing', () => {
    expect(shopifyMeasurementBreaksLimit('weight', 'max', { value: NaN, unit: 'kilograms' }, { value: 1, unit: 'kg' })).toBe(false)
    expect(shopifyMeasurementBreaksLimit('weight', 'max', { value: 5, unit: 'kilograms' }, { value: NaN, unit: 'kg' })).toBe(false)
    expect(shopifyMeasurementBreaksLimit('invented', 'max', { value: 5, unit: 'x' }, { value: 1, unit: 'x' })).toBe(false)
  })
  it('knows which stored limits it can read', () => {
    expect(shopifyMeasurementLimitReadable('temperature', '{"unit":"fahrenheit","value":14}')).toBe(true)
    expect(shopifyMeasurementLimitReadable('temperature', '{"unit":"°F","value":"14"}')).toBe(true)
    expect(shopifyMeasurementLimitReadable('temperature', '{"unit":"rankine","value":14}')).toBe(false)
    expect(shopifyMeasurementLimitReadable('temperature', '{"value":14}')).toBe(false)
    expect(shopifyMeasurementLimitReadable('temperature', '14')).toBe(false)
    expect(shopifyMeasurementLimitReadable('temperature', 'not json')).toBe(false)
  })
})
