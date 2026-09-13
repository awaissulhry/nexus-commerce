/**
 * VT.1b — R-VT-2: the three arms VT.3 measured, re-run as MY OWN before/after instrument.
 *
 *   cd apps/api && npx tsx scripts/_vt1b-rvt2-probe.mts
 *
 * Pure: `validateMapping` / `parseMapping` / `getRulesFor` only, no database. The overlay is a realistic
 * AUTO_ACCESSORY bucket with the two rule kinds that VT.3 measured as the casualties (a `transforms` expression and an
 * overlay-only rule), so "the marketplace keeps its rules" is asserted on the shapes that actually lost them.
 *
 * The CONTROL is in the same run, every time: the identical mapping WITHOUT the variations key must validate clean and
 * parse to version 12. A run where the control also fails proves the instrument, not the fix.
 */
import {
  getRulesFor,
  parseMapping,
  validateMapping,
  type MarketplaceSchemaMapping,
} from '../src/services/pim/schema-mapping.service.js'

const RULE_BLOCK = {
  theme: 'COLOR_NAME/SIZE_NAME',
  axes: [{ axisKey: 'color', target: 'color', order: 0, included: true }],
  collisions: { resolver: 'fold', foldInto: 'color', foldSeparator: ' / ' },
  split: { mode: 'one', axisKey: null },
}

function baseMapping(): MarketplaceSchemaMapping {
  return {
    version: 12,
    fields: { item_name: { source: 'name' }, brand: { source: 'brand' } },
    byProductType: {
      AUTO_ACCESSORY: {
        // the two shapes VT.3 measured as the casualties
        item_weight: { source: 'weightValue', transforms: [{ type: 'unit', from: 'kg', to: 'g' }] },
        volume_capacity_name: { source: 'categoryAttributes.volume' },
      },
    },
    expressions: { 'Margin 20': '$basePrice * 0.8' },
    lastSyncedAt: null,
    schemaSnapshotVersion: null,
  }
}

const withInBucket = () => {
  const m = baseMapping() as unknown as Record<string, any>
  m.byProductType.AUTO_ACCESSORY.variations = RULE_BLOCK
  return m
}
const withTopLevel = () => {
  const m = baseMapping() as unknown as Record<string, any>
  m.variations = RULE_BLOCK
  return m
}
const withTopLevelByType = () => {
  const m = baseMapping() as unknown as Record<string, any>
  m.variationsByProductType = { AUTO_ACCESSORY: RULE_BLOCK }
  return m
}
/** A rule block that is genuinely malformed — the arm the WRITE path must refuse by name. */
const withBadRule = () => {
  const m = baseMapping() as unknown as Record<string, any>
  m.variationsByProductType = { AUTO_ACCESSORY: { theme: 42, axes: 'nope', collisions: { resolver: 'teleport' } } }
  return m
}
/** An unknown key that is not a variation rule at all — R-VT-2 (a)'s "never parsed to empty". */
const withUnknownKey = () => {
  const m = baseMapping() as unknown as Record<string, any>
  m.byProductType.AUTO_ACCESSORY.somethingNobodyKnows = { not: 'a rule' }
  return m
}

const arms: Array<[string, () => unknown]> = [
  ['CONTROL  — no variations key at all      ', baseMapping as unknown as () => unknown],
  ['ARM A    — VX M2 in-bucket (VT.3\'s arm)  ', withInBucket],
  ['ARM B    — top-level `variations`         ', withTopLevel],
  ['ARM C    — top-level byProductType map    ', withTopLevelByType],
  ['ARM D    — a MALFORMED rule block         ', withBadRule],
  ['ARM E    — an unknown non-rule key        ', withUnknownKey],
]

console.log('arm                                        | write errors | parsed version | AUTO_ACCESSORY field rules resolved')
console.log('-------------------------------------------|--------------|----------------|------------------------------------')
for (const [name, build] of arms) {
  const raw = build()
  const errors = validateMapping(raw, { checkExpressions: true })
  const parsed = parseMapping(raw)
  const resolved = Object.keys(getRulesFor(parsed, 'AUTO_ACCESSORY')).sort()
  console.log(`${name} | ${String(errors.length).padStart(12)} | ${String(parsed.version).padStart(14)} | ${resolved.join(', ')}`)
  if (errors.length) for (const e of errors) console.log(`      write error: ${e}`)
  // R-VT-2 (a): the READ path's warnings — present only after the fix.
  const withWarnings = (await import('../src/services/pim/schema-mapping.service.js')) as Record<string, any>
  if (typeof withWarnings.parseMappingWithWarnings === 'function') {
    for (const w of withWarnings.parseMappingWithWarnings(raw).warnings) console.log(`      read warning: ${w}`)
  }
}
