/**
 * PIM D.4 — Internal variable registry.
 *
 * The "right column" of the mapping canvas: well-known PIM source paths
 * an operator can map external schema fields to. Grouped so the canvas
 * can render category headings. Each entry has:
 *   - path:    the dotted path that becomes FieldMappingRule.source
 *   - label:   what the operator sees
 *   - hint:    short description of where the value comes from
 *   - group:   render grouping
 *
 * The path syntax matches D.5 publish-validator's resolveSourcePath:
 *   - `title`                              top-level resolver key
 *   - `localizedContent.{locale}.title`    locale-substituted lookup
 *   - `categoryAttributes.<key>`           walks into JSONB
 *   - `variantAttributes.<key>`            ditto
 *
 * Operators can still author custom paths via the existing
 * FieldRuleRow editor; the canvas is the curated guided path.
 */

export type VariableGroup =
  | 'Locale content'
  | 'Master'
  | 'Variant'
  | 'Technical attributes'
  | 'Channel'

export interface InternalVariable {
  path: string
  label: string
  hint: string
  group: VariableGroup
}

export const INTERNAL_VARIABLES: InternalVariable[] = [
  // ── Locale content (Phase B.1 fields) ──────────────────────────
  { group: 'Locale content', path: 'localizedContent.{locale}.title',        label: 'Title (current locale)',       hint: 'Localized title, falls back to en' },
  { group: 'Locale content', path: 'localizedContent.{locale}.description',  label: 'Description (current locale)', hint: 'Localized description' },
  { group: 'Locale content', path: 'localizedContent.{locale}.bulletPoints', label: 'Bullet points (current locale)', hint: 'Localized array of bullets' },
  { group: 'Locale content', path: 'localizedContent.{locale}.keywords',     label: 'Keywords (current locale)',    hint: 'Localized search keywords' },
  { group: 'Locale content', path: 'localizedContent.en.title',              label: 'Title (English explicit)',     hint: 'Force English regardless of locale' },
  { group: 'Locale content', path: 'localizedContent.it.title',              label: 'Title (Italian explicit)',     hint: 'Force Italian regardless of locale' },

  // ── Master columns (A.4 synthesis surfaces these as top-level) ─
  { group: 'Master', path: 'name',         label: 'Name (master)',         hint: 'Top-level Product.name' },
  { group: 'Master', path: 'description',  label: 'Description (master)',  hint: 'Top-level Product.description' },
  { group: 'Master', path: 'bulletPoints', label: 'Bullet points (master)', hint: 'Top-level Product.bulletPoints' },
  { group: 'Master', path: 'keywords',     label: 'Keywords (master)',     hint: 'Top-level Product.keywords' },
  { group: 'Master', path: 'brand',        label: 'Brand',                 hint: 'Product.brand' },
  { group: 'Master', path: 'manufacturer', label: 'Manufacturer',          hint: 'Product.manufacturer' },
  { group: 'Master', path: 'basePrice',    label: 'Base price',            hint: 'Product.basePrice (decimal)' },
  { group: 'Master', path: 'gtin',         label: 'GTIN',                  hint: 'Product.gtin' },
  { group: 'Master', path: 'upc',          label: 'UPC',                   hint: 'Product.upc' },
  { group: 'Master', path: 'ean',          label: 'EAN',                   hint: 'Product.ean' },

  // ── Variant axes (Phase A.1 variantAttributes JSONB) ────────────
  { group: 'Variant', path: 'variantAttributes.Color',    label: 'Variant: Color',    hint: 'For products with Color axis' },
  { group: 'Variant', path: 'variantAttributes.Size',     label: 'Variant: Size',     hint: 'For products with Size axis' },
  { group: 'Variant', path: 'variantAttributes.Material', label: 'Variant: Material', hint: 'For products with Material axis' },
  { group: 'Variant', path: 'variantAttributes.BodyType', label: 'Variant: Body Type', hint: 'Men / Women / Kids / Unisex' },

  // ── Technical attributes (categoryAttributes JSONB) ─────────────
  // These are deliberately seeded — Xavia common attributes per
  // [[project_xavia_context]]. Operators can add custom paths via the
  // existing FieldRuleRow editor for anything not here.
  { group: 'Technical attributes', path: 'categoryAttributes.material',     label: 'Material',      hint: 'e.g. Cowhide, Kangaroo' },
  { group: 'Technical attributes', path: 'categoryAttributes.armor',        label: 'Armor',         hint: 'e.g. CE Level 2' },
  { group: 'Technical attributes', path: 'categoryAttributes.color',        label: 'Color (tech)',  hint: 'Free-form color descriptor' },
  { group: 'Technical attributes', path: 'categoryAttributes.size',         label: 'Size (tech)',   hint: 'Apparel sizing' },
  { group: 'Technical attributes', path: 'categoryAttributes.weight_kg',    label: 'Weight (kg)',   hint: 'Kilograms' },
  { group: 'Technical attributes', path: 'categoryAttributes.country_of_origin', label: 'Country of origin', hint: 'ISO 3166 country code' },

  // ── Channel-specific (resolver picks up channel listing overrides) ─
  { group: 'Channel', path: 'title',       label: 'Title (resolved)',       hint: 'Channel override → master fallback' },
  { group: 'Channel', path: 'description', label: 'Description (resolved)', hint: 'Channel override → master fallback' },
  { group: 'Channel', path: 'price',       label: 'Price (resolved)',       hint: 'Channel override → master fallback' },
]

export function variablesByGroup(): Record<VariableGroup, InternalVariable[]> {
  const groups: Record<VariableGroup, InternalVariable[]> = {
    'Locale content': [],
    Master: [],
    Variant: [],
    'Technical attributes': [],
    Channel: [],
  }
  for (const v of INTERNAL_VARIABLES) groups[v.group].push(v)
  return groups
}
