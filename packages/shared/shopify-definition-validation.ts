import { Ajv, type ValidateFunction } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { shopifyBoundWords } from './shopify-field-rules.js'
import { shopifyMeasurementUnits } from './shopify-field-codecs.js'
import { numberOf, shopifyMeasurementBreaksLimit } from './shopify-measurement-limits.js'

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

/**
 * A structured value against one `min` / `max` limit, with the limit in its own words: "Enter 500 g or less." (PLAN §5).
 * A measurement limit may use any unit of its kind — all 32 kinds, short or long names (G14, `shopify-measurement-limits.ts`).
 * Nexus refuses only when Shopify certainly would: a limit it cannot read or convert is left to Shopify's check at publish
 * (it used to refuse every save with "measurement bound cannot be read", which the user could not fix).
 */
export function shopifyObjectBoundError(type: string, value: Record<string, unknown>, rule: { name: string; value: string }): string | null {
  if (rule.name !== 'min' && rule.name !== 'max') return null
  let bound: unknown
  try { bound = JSON.parse(rule.value) } catch { return null }
  let breaks: boolean
  if (shopifyMeasurementUnits[type]) {
    const limit = bound && typeof bound === 'object' && !Array.isArray(bound) ? bound as Record<string, unknown> : {}
    breaks = shopifyMeasurementBreaksLimit(type, rule.name, { value: numberOf(value.value), unit: String(value.unit) }, { value: numberOf(limit.value), unit: typeof limit.unit === 'string' ? limit.unit : '' })
  } else {
    // Money: Shopify offers no limit today; a plain number compares with the amount, as before.
    const actual = numberOf(type === 'money' ? value.amount : value.value)
    breaks = typeof bound === 'number' && Number.isFinite(actual) && (rule.name === 'min' ? actual < bound : actual > bound)
  }
  return breaks ? `Enter ${shopifyBoundWords(rule.value)} or ${rule.name === 'min' ? 'more' : 'less'}.` : null
}
