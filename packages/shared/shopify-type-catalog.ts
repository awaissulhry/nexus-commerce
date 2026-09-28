/**
 * Shopify's metafield types, as the Admin API lists them (`metafieldDefinitionTypes`): each type's name, category and the
 * validations a definition of that type may carry. Read on 2026-09-28 (Lane B, docs/shopify-metafields/PLAN-2026-09-28.md
 * §1.1), in Shopify's order. This is Shopify's public list — no store data.
 *
 * It is the one list the "every type" checks walk: a type Shopify adds later must either edit correctly or be read-only
 * with a reason, never crash. A store's live list stays the authority at run time (`ShopifyStoreSchema.types`); this copy
 * is for tests, the lab and the check that compares it with a store's live list.
 *
 * Built from small helpers so each family reads once: a measurement kind takes `min` / `max` in its own kind, and every
 * list form adds `list.min` / `list.max`. `shopify-type-catalog.vitest.test.ts` pins the counts and spot-checks the rows.
 */
export interface ShopifyTypeValidation { name: string; type: string }
export interface ShopifyTypeInfo { name: string; category: string; validations: readonly ShopifyTypeValidation[] }

export const SHOPIFY_TYPE_CATALOG_READ_AT = '2026-09-28'

const v = (name: string, type: string): ShopifyTypeValidation => ({ name, type })
const INT = 'number_integer'
const TEXT = 'single_line_text_field'
const TEXTS = 'list.single_line_text_field'
const LIST = [v('list.min', INT), v('list.max', INT)]
const t = (name: string, category: string, validations: ShopifyTypeValidation[] = []): ShopifyTypeInfo => ({ name, category, validations })
/** A measurement kind: `min` / `max` in its own kind. */
const m = (kind: string) => t(kind, 'MEASUREMENT', [v('min', kind), v('max', kind)])
/** The list form of a type: its item validations, then `list.min` / `list.max`. */
const l = (item: ShopifyTypeInfo) => t(`list.${item.name}`, item.category, [...item.validations, ...LIST])

const date = t('date', 'DATE_TIME', [v('min', 'date'), v('max', 'date')])
const dateTime = t('date_time', 'DATE_TIME', [v('min', 'date_time'), v('max', 'date_time')])
const color = t('color', 'COLOR')
const jurisdiction = t('jurisdiction', 'TEXT')
const link = t('link', 'LINK', [v('allowed_domains', TEXTS)])
const decimal = t('number_decimal', 'NUMBER', [v('min', 'number_decimal'), v('max', 'number_decimal'), v('max_precision', INT)])
const integer = t('number_integer', 'NUMBER', [v('min', INT), v('max', INT)])
const rating = t('rating', 'RATING', [v('scale_min', 'number_decimal'), v('scale_max', 'number_decimal')])
const singleLine = t(TEXT, 'TEXT', [v('min', INT), v('max', INT), v('regex', TEXT), v('choices', TEXTS)])
const url = t('url', 'URL', [v('allowed_domains', TEXTS)])
const ref = (kind: string, validations: ShopifyTypeValidation[] = []) => t(`${kind}_reference`, 'REFERENCE', validations)
const withList = (item: ShopifyTypeInfo) => [item, l(item)]

const MEASURES_A = ['antenna_gain', 'area', 'battery_charge_capacity', 'battery_energy_capacity'] as const
const MEASURES_B = ['concentration', 'data_storage_capacity', 'data_transfer_rate'] as const
const MEASURES_C = ['dimension', 'display_density', 'distance', 'duration', 'electric_current', 'electrical_resistance', 'energy', 'frequency'] as const
const MEASURES_D = ['illuminance', 'inductance'] as const
const MEASURES_E = ['luminous_flux', 'mass_flow_rate'] as const
const MEASURES_F = ['power', 'pressure'] as const
const MEASURES_G = ['resolution'] as const
const MEASURES_H = ['rotational_speed'] as const
const MEASURES_I = ['sound_level', 'speed', 'temperature', 'thermal_power'] as const
const MEASURES_J = ['voltage', 'volume', 'volumetric_flow_rate', 'weight'] as const
/** Every measurement kind, alphabetical (Shopify's list interleaves them with the other kinds). */
export const SHOPIFY_MEASUREMENT_KINDS: readonly string[] = [
  ...MEASURES_A, 'capacitance', ...MEASURES_B, ...MEASURES_C, ...MEASURES_D, ...MEASURES_E, ...MEASURES_F, ...MEASURES_G, ...MEASURES_H, ...MEASURES_I, ...MEASURES_J,
]

/** The list lines of Shopify's response, in its order: the list form of each kind that has one, alphabetical by kind. */
const LISTS: ShopifyTypeInfo[] = [
  ...MEASURES_A.map(k => l(m(k))), l(m('capacitance')), l(color), ...MEASURES_B.map(k => l(m(k))), l(dateTime), l(date),
  ...MEASURES_C.map(k => l(m(k))), ...MEASURES_D.map(k => l(m(k))), l(jurisdiction), l(link), ...MEASURES_E.map(k => l(m(k))),
  l(decimal), l(integer), ...MEASURES_F.map(k => l(m(k))), l(rating), ...MEASURES_G.map(k => l(m(k))), ...MEASURES_H.map(k => l(m(k))),
  l(singleLine), ...MEASURES_I.map(k => l(m(k))), l(url), ...MEASURES_J.map(k => l(m(k))),
]

export const SHOPIFY_TYPE_CATALOG: readonly ShopifyTypeInfo[] = [
  ...MEASURES_A.map(m), t('boolean', 'TRUE_FALSE'), m('capacitance'), color, ...MEASURES_B.map(m), dateTime, date,
  ...MEASURES_C.map(m), t('id', 'ID', [v('min', INT), v('max', INT), v('regex', TEXT)]), ...MEASURES_D.map(m),
  t('json', 'JSON', [v('schema', 'json')]), jurisdiction, t('language', 'LANGUAGE'), link,
  ...LISTS,
  ...MEASURES_E.map(m), t('money', 'MONEY'), t('multi_line_text_field', 'TEXT', [v('min', INT), v('max', INT), v('regex', TEXT)]),
  decimal, integer, ...MEASURES_F.map(m), rating, ...MEASURES_G.map(m), t('rich_text_field', 'TEXT'), ...MEASURES_H.map(m), singleLine,
  ...MEASURES_I.map(m), url, ...MEASURES_J.map(m),
  ...withList(ref('company')), ...withList(ref('customer')), ...withList(ref('product')), ...withList(ref('collection')), ...withList(ref('variant')),
  ...withList(ref('file', [v('file_type_options', TEXTS)])),
  ...withList(ref('product_taxonomy_value', [v('product_taxonomy_attribute_handle', TEXT)])),
  ref('product_taxonomy_disclosure'),
  ...withList(ref('metaobject', [v('metaobject_definition_id', TEXT), v('metaobject_definition_type', TEXT)])),
  ...withList(ref('mixed', [v('metaobject_definition_ids', TEXTS), v('metaobject_definition_types', TEXTS)])),
  ...withList(ref('disclosure', [v('metaobject_definition_ids', TEXTS), v('metaobject_definition_types', TEXTS)])),
  ...withList(ref('page')), ...withList(ref('article')), ...withList(ref('order')),
]

/** `list.weight` → `weight`. */
export const shopifyBaseType = (type: string) => type.replace(/^list\./, '')
export const shopifyTypeInfo = (type: string) => SHOPIFY_TYPE_CATALOG.find(entry => entry.name === type)
