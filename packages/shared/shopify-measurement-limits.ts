/**
 * A measurement `min` / `max` limit in any unit of its kind, for all 32 of Shopify's measurement kinds (Lane B slice B3a,
 * docs/shopify-metafields/PLAN-2026-09-28.md §6.3, gap G14).
 *
 * Unit names — sources, read 2026-09-28:
 * - Long names (`kilograms`, `celsius`, …): shopify.dev "List of data types" — the only names a VALUE may use
 *   (`shopifyMeasurementUnits`). A limit is a value of its own kind: `metafieldDefinitionTypes` (Admin API, read through the
 *   Shopify connector) gives every measurement `min` / `max` the kind itself as its input type. So every long name is a
 *   valid limit unit.
 * - Short names: shopify.dev "List of validation options" shows `g` (weight), `ml` (volume) and `cm` (dimension); Shopify's
 *   content guide ("Grammar and mechanics", unit abbreviations) lists km, mi, px, MP, ppi, dpi, KB, GB, TB, L, kg, oz, lb.
 *   Shopify documents no short name for the other kinds; the standard symbols below (°C, km/h, Hz, …) are read too, so a
 *   limit written that way is still checked.
 *
 * Nexus refuses a value only when Shopify certainly would. It never refuses when:
 * - the limit's unit is one Nexus does not know (or the limit has no unit) — Shopify checks it when you publish;
 * - the two units do not convert: a dipole and an isotropic antenna gain, pixels and megapixels, pixels and dots per inch,
 *   per gram and per millilitre, and months or years against a fixed time (a month has no fixed number of days);
 * - the value is inside the limit under one reading of a unit Shopify does not define: a kilobyte of 1,000 or 1,024 bytes,
 *   a US or an imperial gallon, a short or a long ton, the calorie and the BTU (thermochemical or international), and
 *   the horsepower (metric, mechanical or electrical). A value is refused only when every reading refuses it.
 * Temperature is not a factor: Celsius and Fahrenheit have their own zero, so both sides are compared in kelvin.
 */
import { shopifyMeasurementUnits } from './shopify-field-codecs.js'

/** A unit's size in one reading: the base it converts through, and how many of that base it is. */
type Size = readonly [base: string, size: number]
type Reading = Readonly<Record<string, Size>>

const at = (base: string, units: Record<string, number>): Record<string, Size> =>
  Object.fromEntries(Object.entries(units).map(([unit, size]) => [unit, [base, size] as const]))
const one = (...parts: Array<Record<string, Size>>): Reading[] => [Object.assign({}, ...parts)]
/** `grams_per_day`, `grams_per_hour`, …: every amount per every time. */
const per = (base: string, amounts: Record<string, number>, times: Record<string, number>) =>
  at(base, Object.fromEntries(Object.entries(amounts).flatMap(([amount, size]) => Object.entries(times).map(([time, seconds]) => [`${amount}_per_${time}`, size / seconds]))))

const INCH = 0.0254, FOOT = 0.3048, MILE = 1609.344, POUND = 0.45359237, GRAVITY = 9.80665, US_GALLON = 3.785411784, IMPERIAL_GALLON = 4.54609
const TIMES = { day: 86400, hour: 3600, minute: 60, second: 1 }
/** One British thermal unit in joules, from a calorie: calorie × grams per pound × 5/9 (°F to °C). */
const btu = (calorie: number) => calorie * POUND * 1000 * 5 / 9
const bytes = (k: number) => at('B', { bytes: 1, kilobytes: k, megabytes: k ** 2, gigabytes: k ** 3, terabytes: k ** 4 })
const bits = (k: number) => at('bit/s', { bits_per_second: 1, kilobits_per_second: k, megabits_per_second: k ** 2, gigabits_per_second: k ** 3 })
const energy = (calorie: number) => at('J', { joules: 1, kilojoules: 1000, calories: calorie, kilocalories: calorie * 1000 })
const massFlow = (ton: number) => per('kg/s', { grams: 0.001, ounces: POUND / 16, pounds: POUND, kilograms: 1, tons: ton, tonnes: 1000 }, TIMES)
const power = (horsepower: number) => at('W', { milliwatts: 0.001, watts: 1, kilowatts: 1000, horsepower })
const thermalPower = (joules: number) => at('W', { british_thermal_units_per_hour: joules / 3600, tons_of_refrigeration: 12000 * joules / 3600, kilowatts: 1000 })
const flow = (gallon: number) => per('L/s', { liters: 1, gallons: gallon, cubic_feet: FOOT ** 3 * 1000, cubic_meters: 1000 }, { hour: 3600, minute: 60, second: 1 })

/** Every kind but temperature: its readings (one when every unit is defined exactly). Pinned to `shopifyMeasurementUnits` by test. */
const READINGS: Record<string, readonly Reading[]> = {
  antenna_gain: one(at('dBi', { decibels_isotropic: 1 }), at('dBd', { decibels_dipole: 1 })),
  area: one(at('m²', { square_centimeters: 1e-4, square_feet: FOOT ** 2, square_inches: INCH ** 2, square_meters: 1, square_yards: (3 * FOOT) ** 2 })),
  battery_charge_capacity: one(at('mAh', { milliamp_hours: 1 })),
  battery_energy_capacity: one(at('Wh', { watt_hours: 1 })),
  capacitance: one(at('F', { picofarads: 1e-12, nanofarads: 1e-9, microfarads: 1e-6, farads: 1 })),
  concentration: one(at('mg/g', { milligrams_per_gram: 1 }), at('mg/mL', { milligrams_per_milliliter: 1 })),
  data_storage_capacity: [bytes(1000), bytes(1024)],
  data_transfer_rate: [bits(1000), bits(1024)],
  dimension: one(at('m', { millimeters: 0.001, centimeters: 0.01, meters: 1, inches: INCH, feet: FOOT, yards: 3 * FOOT })),
  display_density: one(at('ppi', { pixels_per_inch: 1 }), at('dpi', { dots_per_inch: 1 })),
  distance: one(at('m', { kilometers: 1000, miles: MILE })),
  duration: one(at('s', { nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1, minutes: 60, hours: 3600, days: 86400 }), at('month', { months: 1, years: 12 })),
  electric_current: one(at('A', { milliamperes: 1e-3, amperes: 1, kiloamperes: 1e3 })),
  electrical_resistance: one(at('Ω', { ohms: 1, kiloohms: 1e3 })),
  energy: [energy(4.184), energy(4.1868)],
  frequency: one(at('Hz', { hertz: 1, kilohertz: 1e3, megahertz: 1e6, gigahertz: 1e9 })),
  illuminance: one(at('lx', { lux: 1, foot_candles: 1 / FOOT ** 2 })),
  inductance: one(at('H', { microhenries: 1e-6, millihenries: 1e-3, henries: 1 })),
  luminous_flux: one(at('lm', { lumens: 1 })),
  mass_flow_rate: [massFlow(2000 * POUND), massFlow(2240 * POUND)],
  power: [power(550 * FOOT * POUND * GRAVITY), power(735.49875), power(746)],
  pressure: one(at('Pa', { pounds_per_square_inch: POUND * GRAVITY / INCH ** 2, bars: 1e5 })),
  resolution: one(at('px', { pixels: 1 }), at('MP', { megapixels: 1 })),
  rotational_speed: one(at('rpm', { revolutions_per_minute: 1 })),
  sound_level: one(at('dB', { decibels: 1 })),
  speed: one(at('m/s', { kilometers_per_hour: 1000 / 3600, feet_per_second: FOOT, miles_per_hour: MILE / 3600, meters_per_second: 1 })),
  thermal_power: [thermalPower(btu(4.184)), thermalPower(btu(4.1868)), thermalPower(1055.056)],
  voltage: one(at('V', { volts: 1 })),
  volume: one(at('L', {
    milliliters: 0.001, centiliters: 0.01, liters: 1, cubic_meters: 1000,
    us_fluid_ounces: US_GALLON / 128, us_pints: US_GALLON / 8, us_quarts: US_GALLON / 4, us_gallons: US_GALLON,
    imperial_fluid_ounces: IMPERIAL_GALLON / 160, imperial_pints: IMPERIAL_GALLON / 8, imperial_quarts: IMPERIAL_GALLON / 4, imperial_gallons: IMPERIAL_GALLON,
  })),
  volumetric_flow_rate: [flow(US_GALLON), flow(IMPERIAL_GALLON)],
  weight: one(at('kg', { grams: 0.001, kilograms: 1, ounces: POUND / 16, pounds: POUND })),
}

const symbols = (units: Record<string, readonly string[]>) => Object.fromEntries(Object.entries(units).flatMap(([unit, names]) => names.map(name => [name, unit])))
const perSymbols = (amounts: Record<string, string>, times: Record<string, string>) =>
  Object.fromEntries(Object.entries(amounts).flatMap(([symbol, amount]) => Object.entries(times).map(([time, unit]) => [`${symbol}/${time}`, `${amount}_per_${unit}`])))
/** Short names a LIMIT may use, per kind → the long name. Case matters (mW is not MW). A value never uses them. */
const SHORT: Record<string, Record<string, string>> = {
  antenna_gain: symbols({ decibels_isotropic: ['dBi'], decibels_dipole: ['dBd'] }),
  area: symbols({ square_centimeters: ['cm2', 'cm²'], square_feet: ['ft2', 'ft²', 'sq ft'], square_inches: ['in2', 'in²', 'sq in'], square_meters: ['m2', 'm²'], square_yards: ['yd2', 'yd²', 'sq yd'] }),
  battery_charge_capacity: symbols({ milliamp_hours: ['mAh'] }),
  battery_energy_capacity: symbols({ watt_hours: ['Wh'] }),
  /* Micro: the micro sign (U+00B5) and the Greek mu (U+03BC) look the same; both are read, and a plain u. */
  capacitance: symbols({ picofarads: ['pF'], nanofarads: ['nF'], microfarads: ['\u00B5F', '\u03BCF', 'uF'], farads: ['F'] }),
  concentration: symbols({ milligrams_per_gram: ['mg/g'], milligrams_per_milliliter: ['mg/mL', 'mg/ml'] }),
  data_storage_capacity: symbols({ bytes: ['B'], kilobytes: ['kB', 'KB'], megabytes: ['MB'], gigabytes: ['GB'], terabytes: ['TB'] }),
  data_transfer_rate: symbols({ bits_per_second: ['bps', 'bit/s'], kilobits_per_second: ['kbps', 'Kbps', 'kbit/s'], megabits_per_second: ['Mbps', 'Mbit/s'], gigabits_per_second: ['Gbps', 'Gbit/s'] }),
  dimension: symbols({ millimeters: ['mm'], centimeters: ['cm'], meters: ['m'], inches: ['in'], feet: ['ft'], yards: ['yd'] }),
  display_density: symbols({ pixels_per_inch: ['ppi', 'PPI'], dots_per_inch: ['dpi', 'DPI'] }),
  distance: symbols({ kilometers: ['km'], miles: ['mi'] }),
  duration: symbols({ nanoseconds: ['ns'], microseconds: ['\u00B5s', '\u03BCs', 'us'], milliseconds: ['ms'], seconds: ['s'], minutes: ['min'], hours: ['h'], days: ['d'] }),
  electric_current: symbols({ milliamperes: ['mA'], amperes: ['A'], kiloamperes: ['kA'] }),
  /* Omega: the Greek capital (U+03A9) and the ohm sign (U+2126) look the same; both are read. */
  electrical_resistance: symbols({ ohms: ['\u03A9', '\u2126', 'ohm'], kiloohms: ['k\u03A9', 'k\u2126', 'kohm'] }),
  energy: symbols({ joules: ['J'], kilojoules: ['kJ'], calories: ['cal'], kilocalories: ['kcal'] }),
  frequency: symbols({ hertz: ['Hz'], kilohertz: ['kHz'], megahertz: ['MHz'], gigahertz: ['GHz'] }),
  illuminance: symbols({ lux: ['lx'], foot_candles: ['fc'] }),
  inductance: symbols({ microhenries: ['\u00B5H', '\u03BCH', 'uH'], millihenries: ['mH'], henries: ['H'] }),
  luminous_flux: symbols({ lumens: ['lm'] }),
  mass_flow_rate: perSymbols({ g: 'grams', oz: 'ounces', lb: 'pounds', kg: 'kilograms', t: 'tonnes' }, { d: 'day', h: 'hour', min: 'minute', s: 'second' }),
  power: symbols({ milliwatts: ['mW'], watts: ['W'], kilowatts: ['kW'], horsepower: ['hp'] }),
  pressure: symbols({ pounds_per_square_inch: ['psi'], bars: ['bar'] }),
  resolution: symbols({ pixels: ['px'], megapixels: ['MP'] }),
  rotational_speed: symbols({ revolutions_per_minute: ['rpm', 'RPM'] }),
  sound_level: symbols({ decibels: ['dB'] }),
  speed: symbols({ kilometers_per_hour: ['km/h', 'kph'], feet_per_second: ['ft/s'], miles_per_hour: ['mph'], meters_per_second: ['m/s'] }),
  temperature: symbols({ celsius: ['°C', 'C'], fahrenheit: ['°F', 'F'], kelvin: ['K'] }),
  thermal_power: symbols({ british_thermal_units_per_hour: ['BTU/h', 'Btu/h'], tons_of_refrigeration: ['TR'], kilowatts: ['kW'] }),
  voltage: symbols({ volts: ['V'] }),
  volume: symbols({ milliliters: ['ml', 'mL'], centiliters: ['cl', 'cL'], liters: ['l', 'L'], cubic_meters: ['m3', 'm³'] }),
  volumetric_flow_rate: perSymbols({ l: 'liters', L: 'liters', m3: 'cubic_meters', 'm³': 'cubic_meters', ft3: 'cubic_feet', 'ft³': 'cubic_feet' }, { h: 'hour', min: 'minute', s: 'second' }),
  weight: symbols({ grams: ['g'], kilograms: ['kg'], ounces: ['oz'], pounds: ['lb', 'lbs'] }),
}

/** A unit of `kind` as Shopify's long name (`g` → `grams`); null when Nexus does not know it for that kind. */
export function shopifyMeasurementUnit(kind: string, unit: string): string | null {
  if (shopifyMeasurementUnits[kind]?.includes(unit)) return unit
  return SHORT[kind]?.[unit] ?? null
}

/** Whether Nexus can read a stored limit (`{"unit":"g","value":10}`) of `kind`: a number and a unit it knows. */
export function shopifyMeasurementLimitReadable(kind: string, limit: string): boolean {
  try {
    const bound: unknown = JSON.parse(limit)
    if (!bound || typeof bound !== 'object' || Array.isArray(bound)) return false
    const b = bound as Record<string, unknown>
    return Number.isFinite(numberOf(b.value)) && typeof b.unit === 'string' && !!shopifyMeasurementUnit(kind, b.unit)
  } catch { return false }
}
/** `12.5` or `"12.5"` → 12.5; anything else → NaN. */
export const numberOf = (value: unknown): number =>
  typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN

const kelvin = (unit: string, n: number) => unit === 'celsius' ? n + 273.15 : unit === 'fahrenheit' ? (n - 32) * 5 / 9 + 273.15 : n
/* Converted numbers carry floating-point dust (2000 nanofarads is 2.0000000000000003 microfarads). A value within one part
   in a billion of a limit in another unit is not refused; Shopify's own check decides that last digit. */
const DUST = 1e-9

/**
 * True only when `value` certainly breaks the `min` / `max` limit — under every reading of an ambiguous unit. False when it is
 * inside, when Nexus cannot tell (a unit it does not know, units that do not convert, a value inside under one reading), or
 * when a number is missing. The same unit compares the numbers exactly.
 */
export function shopifyMeasurementBreaksLimit(kind: string, rule: 'min' | 'max', value: { value: number; unit: string }, limit: { value: number; unit: string }): boolean {
  const unit = shopifyMeasurementUnit(kind, value.unit), limitUnit = shopifyMeasurementUnit(kind, limit.unit)
  if (!unit || !limitUnit || !Number.isFinite(value.value) || !Number.isFinite(limit.value)) return false
  const breaks = (a: number, b: number, dust = DUST * Math.max(Math.abs(a), Math.abs(b))) => rule === 'min' ? a < b - dust : a > b + dust
  if (unit === limitUnit) return breaks(value.value, limit.value, 0)
  if (kind === 'temperature') return breaks(kelvin(unit, value.value), kelvin(limitUnit, limit.value))
  const readings = READINGS[kind] ?? []
  return readings.length > 0 && readings.every(reading => {
    const [base, size] = reading[unit] ?? ['', NaN], [limitBase, limitSize] = reading[limitUnit] ?? ['', NaN]
    return base === limitBase && breaks(value.value * size, limit.value * limitSize)
  })
}

/** For the table test: every unit each kind can convert, per reading. */
export const shopifyMeasurementReadings = (kind: string): ReadonlyArray<Readonly<Record<string, readonly [string, number]>>> => READINGS[kind] ?? []
/** For the table test: the short names of a kind → long names. */
export const shopifyMeasurementShortNames = (kind: string): Readonly<Record<string, string>> => SHORT[kind] ?? {}
