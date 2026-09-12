import { Ajv, type ValidateFunction } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const validators = new Map<string, ValidateFunction>()
export function shopifyJsonSchemaError(schema: string, value: string): string | null {
  try {
    let validate = validators.get(schema)
    if (!validate) {
      const parsed = JSON.parse(schema), Constructor = /2020-12/.test(parsed.$schema ?? '') ? Ajv2020 : /2019-09/.test(parsed.$schema ?? '') ? Ajv2019 : Ajv
      const ajv = new Constructor({ strict: false, allErrors: false, validateFormats: true })
      addFormats(ajv); validate = ajv.compile(parsed)
      if (validators.size >= 50) validators.delete(validators.keys().next().value!)
      validators.set(schema, validate)
    }
    return validate(JSON.parse(value)) ? null : `The store’s JSON schema requires ${validate.errors?.[0]?.instancePath || 'this value'} ${validate.errors?.[0]?.message ?? 'to match its definition'}.`
  } catch { return 'This definition’s JSON schema cannot be validated. Refresh the store schema; your value is preserved.' }
}

// Shopify's validation documentation also contains legacy abbreviated unit names. Convert the
// constraint and the current unit into the same dimension; never compare unlike bare numbers.
const factors: Record<string, Record<string, number>> = {
  dimension: { mm: .001, millimeters: .001, cm: .01, centimeters: .01, m: 1, meters: 1, in: .0254, inches: .0254, ft: .3048, feet: .3048, yd: .9144, yards: .9144 },
  weight: { g: .001, grams: .001, kg: 1, kilograms: 1, oz: .028349523125, ounces: .028349523125, lb: .45359237, pounds: .45359237 },
  volume: { ml: .001, milliliters: .001, cl: .01, centiliters: .01, l: 1, liters: 1, m3: 1000, cubic_meters: 1000, us_fluid_ounces: .0295735295625, us_pints: .473176473, us_quarts: .946352946, us_gallons: 3.785411784, imperial_fluid_ounces: .0284130625, imperial_pints: .56826125, imperial_quarts: 1.1365225, imperial_gallons: 4.54609 },
}
export function shopifyObjectBoundError(type: string, value: Record<string, unknown>, rule: { name: string; value: string }): string | null {
  try {
    const bound = JSON.parse(rule.value)
    let actual = Number(type === 'money' ? value.amount : value.value), limit: number
    if (typeof bound === 'number') limit = bound
    else {
      if (!bound || typeof bound.value !== 'number' || typeof bound.unit !== 'string') throw new Error('Invalid constraint')
      const currentFactor = factors[type]?.[String(value.unit)], boundFactor = factors[type]?.[bound.unit]
      if (String(value.unit) === bound.unit) limit = bound.value
      else if (currentFactor && boundFactor) { actual *= currentFactor; limit = bound.value * boundFactor }
      else throw new Error('Unknown unit conversion')
    }
    if (!Number.isFinite(actual) || !Number.isFinite(limit)) throw new Error('Invalid constraint')
    return (rule.name === 'min' ? actual < limit : actual > limit) ? `Shopify requires ${rule.name} ${rule.value}.` : null
  } catch { return 'This definition’s measurement bound cannot be read. Refresh the store schema; your value is preserved.' }
}
