import { describe, expect, it } from 'vitest'
import { SHOPIFY_MEASUREMENT_KINDS, SHOPIFY_TYPE_CATALOG, shopifyBaseType, shopifyTypeInfo } from './shopify-type-catalog'
import { shopifyMeasurementUnits, shopifyTypeReason } from './shopify-field-codecs'

/** The names exactly as `metafieldDefinitionTypes` listed them on 2026-09-28, in its order (read only, Shopify connector). */
const LIVE_2026_09_28 = [
  'antenna_gain', 'area', 'battery_charge_capacity', 'battery_energy_capacity', 'boolean', 'capacitance', 'color', 'concentration',
  'data_storage_capacity', 'data_transfer_rate', 'date_time', 'date', 'dimension', 'display_density', 'distance', 'duration', 'electric_current',
  'electrical_resistance', 'energy', 'frequency', 'id', 'illuminance', 'inductance', 'json', 'jurisdiction', 'language', 'link', 'list.antenna_gain',
  'list.area', 'list.battery_charge_capacity', 'list.battery_energy_capacity', 'list.capacitance', 'list.color', 'list.concentration',
  'list.data_storage_capacity', 'list.data_transfer_rate', 'list.date_time', 'list.date', 'list.dimension', 'list.display_density', 'list.distance',
  'list.duration', 'list.electric_current', 'list.electrical_resistance', 'list.energy', 'list.frequency', 'list.illuminance', 'list.inductance',
  'list.jurisdiction', 'list.link', 'list.luminous_flux', 'list.mass_flow_rate', 'list.number_decimal', 'list.number_integer', 'list.power',
  'list.pressure', 'list.rating', 'list.resolution', 'list.rotational_speed', 'list.single_line_text_field', 'list.sound_level', 'list.speed',
  'list.temperature', 'list.thermal_power', 'list.url', 'list.voltage', 'list.volume', 'list.volumetric_flow_rate', 'list.weight', 'luminous_flux',
  'mass_flow_rate', 'money', 'multi_line_text_field', 'number_decimal', 'number_integer', 'power', 'pressure', 'rating', 'resolution',
  'rich_text_field', 'rotational_speed', 'single_line_text_field', 'sound_level', 'speed', 'temperature', 'thermal_power', 'url', 'voltage', 'volume',
  'volumetric_flow_rate', 'weight', 'company_reference', 'list.company_reference', 'customer_reference', 'list.customer_reference',
  'product_reference', 'list.product_reference', 'collection_reference', 'list.collection_reference', 'variant_reference', 'list.variant_reference',
  'file_reference', 'list.file_reference', 'product_taxonomy_value_reference', 'list.product_taxonomy_value_reference',
  'product_taxonomy_disclosure_reference', 'metaobject_reference', 'list.metaobject_reference', 'mixed_reference', 'list.mixed_reference',
  'disclosure_reference', 'list.disclosure_reference', 'page_reference', 'list.page_reference', 'article_reference', 'list.article_reference',
  'order_reference', 'list.order_reference',
]
const names = SHOPIFY_TYPE_CATALOG.map(entry => entry.name)
const rules = (type: string) => shopifyTypeInfo(type)!.validations.map(rule => `${rule.name}:${rule.type}`)

describe('Shopify type catalog (as read 2026-09-28)', () => {
  it('lists the 118 live types in Shopify’s order, each once', () => {
    expect(names).toEqual(LIVE_2026_09_28)
    expect(new Set(names).size).toBe(118)
  })
  it('has 63 base kinds; 8 of them have no list form', () => {
    const bases = [...new Set(names.map(shopifyBaseType))]
    expect(bases).toHaveLength(63)
    expect(bases.filter(base => !names.includes(`list.${base}`)).sort()).toEqual(
      ['boolean', 'id', 'json', 'language', 'money', 'multi_line_text_field', 'product_taxonomy_disclosure_reference', 'rich_text_field'])
  })
  it('has 32 measurement kinds — exactly the kinds of the unit table', () => {
    expect(SHOPIFY_MEASUREMENT_KINDS).toHaveLength(32)
    expect([...SHOPIFY_MEASUREMENT_KINDS].sort()).toEqual(Object.keys(shopifyMeasurementUnits).sort())
    for (const kind of SHOPIFY_MEASUREMENT_KINDS) expect(rules(kind)).toEqual([`min:${kind}`, `max:${kind}`])
  })
  it('gives every list form its item rules, then list.min and list.max', () => {
    for (const name of names.filter(n => n.startsWith('list.'))) {
      expect(rules(name)).toEqual([...rules(shopifyBaseType(name)), 'list.min:number_integer', 'list.max:number_integer'])
    }
  })
  it('carries the rules Shopify listed (spot checks)', () => {
    expect(rules('single_line_text_field')).toEqual(['min:number_integer', 'max:number_integer', 'regex:single_line_text_field', 'choices:list.single_line_text_field'])
    expect(rules('multi_line_text_field')).toEqual(['min:number_integer', 'max:number_integer', 'regex:single_line_text_field'])
    expect(rules('id')).toEqual(['min:number_integer', 'max:number_integer', 'regex:single_line_text_field'])
    expect(rules('number_decimal')).toEqual(['min:number_decimal', 'max:number_decimal', 'max_precision:number_integer'])
    expect(rules('rating')).toEqual(['scale_min:number_decimal', 'scale_max:number_decimal'])
    expect(rules('json')).toEqual(['schema:json'])
    expect(rules('file_reference')).toEqual(['file_type_options:list.single_line_text_field'])
    expect(rules('product_taxonomy_value_reference')).toEqual(['product_taxonomy_attribute_handle:single_line_text_field'])
    expect(rules('metaobject_reference')).toEqual(['metaobject_definition_id:single_line_text_field', 'metaobject_definition_type:single_line_text_field'])
    expect(rules('mixed_reference')).toEqual(['metaobject_definition_ids:list.single_line_text_field', 'metaobject_definition_types:list.single_line_text_field'])
    for (const none of ['boolean', 'color', 'money', 'language', 'jurisdiction', 'rich_text_field', 'page_reference', 'product_taxonomy_disclosure_reference']) expect(rules(none)).toEqual([])
    expect(shopifyTypeInfo('jurisdiction')!.category).toBe('TEXT')
    expect(shopifyTypeInfo('list.metaobject_reference')!.category).toBe('REFERENCE')
  })
  it('has a Nexus value adapter for every type but one, which says why it is read-only', () => {
    const readOnly = names.filter(name => shopifyTypeReason(name))
    expect(readOnly).toEqual(['product_taxonomy_disclosure_reference'])
  })
})
