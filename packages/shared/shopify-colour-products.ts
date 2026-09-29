/**
 * Shopify colour products — the pure plan (docs/studies/shopify-linked-variations-PLAN.md §3, PR 2).
 *
 * Nexus keeps ONE family (style → colour → size). On a store that shows colours as separate products, each value of the
 * split axis becomes its own Shopify product and every other axis stays a native option inside it. The products are
 * grouped by a separate step (theme metafields today); this module only decides, from Nexus data, which products exist,
 * which variants each one holds, in which order, and what each product's colour is called. It never reads or writes
 * Shopify. With no split axis the family stays one product, and the same checks apply to it.
 *
 * Identity: a colour product is keyed by its split value's key (`color:black`, a dictionary option code), never by the
 * value's text, so a renamed colour keeps its product. A value that is not a dictionary option has no such key and
 * cannot be split.
 */

/** Shopify's limit on native options per product. */
export const SHOPIFY_OPTION_LIMIT = 3
/** The most variants the Nexus Shopify publisher sends in one product (content-publisher). */
export const SHOPIFY_VARIANT_LIMIT = 250
/** Shopify's limit on a `list.product_reference` value: the most products one group can list. */
export const SHOPIFY_LINKED_LIST_LIMIT = 128
/** The most products Impact's linked-products block shows (theme `product_list` setting). */
export const IMPACT_LINKED_SHOWN_LIMIT = 50

export interface ColourPlanAxis { code: string; label: string }
export interface ColourPlanVariant { productId: string; sku: string; values: Readonly<Record<string, string>> }
/** The family as the Nexus loader reads it: axes in Shared order, each variant's value key per axis code. */
export interface ColourPlanFamily {
  familyId: string
  axes: readonly ColourPlanAxis[]
  variants: readonly ColourPlanVariant[]
  /** Per axis code, the value keys in the family's value order (Shared order, then the loader's own completion). */
  valueOrder: Readonly<Record<string, readonly string[]>>
  /** Value key → the Nexus value text ("Nero", "XL"). */
  valueLabels: Readonly<Record<string, string>>
  /** Value keys that are not dictionary options (their key would change with their text). */
  unmapped: readonly string[]
}
export interface ColourPlanSettings {
  /** The axis whose values become separate products; null keeps one product. */
  splitAxis: string | null
  /** Axis code → the Shopify option name ("Taglia" → "Size"). Default: the axis label. */
  optionNames?: Readonly<Record<string, string>>
  /** Split value key → the colour name the operator chose for Shopify ("Black"). Default: the Nexus value. */
  colourNames?: Readonly<Record<string, string>>
}

export interface ColourPlanOption { axis: string; name: string; values: string[] }
export interface ColourPlanProductVariant { productId: string; sku: string; options: Array<{ name: string; value: string }> }
export interface ColourPlanProduct {
  /** The split value key, or '' for a one-product family. The stable identity of this Shopify product in Nexus. */
  key: string
  /** Position in the group: the order of the products in every product's list, which is the order customers see. */
  position: number
  /** The Nexus value ("Nero"); '' for a one-product family. */
  nexusValue: string
  /** What Shopify shows as this product's colour; '' for a one-product family. */
  colourName: string
  colourNameSource: 'operator' | 'nexus' | null
  options: ColourPlanOption[]
  variants: ColourPlanProductVariant[]
}
export type ColourPlanIssueCode =
  | 'split-axis-unknown' | 'missing-value' | 'unmapped-split-value' | 'duplicate-variant' | 'too-many-options'
  | 'blank-option-name' | 'duplicate-option-name' | 'duplicate-option-value' | 'too-many-variants' | 'blank-colour-name' | 'duplicate-colour-name'
  | 'too-many-products' | 'more-than-shown'
export interface ColourPlanIssue { severity: 'error' | 'warning'; code: ColourPlanIssueCode; message: string; productIds: string[]; key?: string }
export interface ColourPlan {
  familyId: string
  mode: 'colour-products' | 'one-product'
  splitAxis: string | null
  products: ColourPlanProduct[]
  /** True when the products are to be grouped: two or more colour products. A single colour needs no group. */
  grouped: boolean
  issues: ColourPlanIssue[]
}

const fold = (text: string) => text.trim().toLocaleLowerCase('en')
const quoted = (texts: string[]) => texts.map(t => `"${t}"`).join(', ')

/** Keys in the family's value order; a key the order does not name keeps its place of first use after the named ones. */
function ordered(keys: Iterable<string>, order: readonly string[] | undefined): string[] {
  const unique = [...new Set(keys)]
  const rank = new Map((order ?? []).map((key, i) => [key, i] as const))
  return unique.map((key, i) => ({ key, i })).sort((a, b) => (rank.get(a.key) ?? rank.size + a.i) - (rank.get(b.key) ?? rank.size + b.i)).map(e => e.key)
}

/** The Shopify products of one family on one store, with every problem that would stop them from being published. */
export function planColourProducts(family: ColourPlanFamily, settings: ColourPlanSettings): ColourPlan {
  const issues: ColourPlanIssue[] = []
  const label = (key: string) => family.valueLabels[key] ?? key
  const split = settings.splitAxis
  if (split !== null && !family.axes.some(a => a.code === split)) {
    issues.push({ severity: 'error', code: 'split-axis-unknown', message: `The family has no "${split}" axis to show as separate products.`, productIds: [] })
    return { familyId: family.familyId, mode: 'colour-products', splitAxis: split, products: [], grouped: false, issues }
  }
  const native = family.axes.filter(a => a.code !== split)
  const optionName = (axis: ColourPlanAxis) => (settings.optionNames?.[axis.code] ?? axis.label).trim()

  // Every variant needs a value on every axis: without one it has no place in any product.
  const complete = family.variants.filter(variant => {
    const missing = family.axes.filter(a => !variant.values[a.code]?.trim())
    if (missing.length) issues.push({ severity: 'error', code: 'missing-value', productIds: [variant.productId],
      message: `${variant.sku} has no ${missing.map(a => a.label).join(' or ')} value.` })
    return !missing.length
  })

  if (native.length > SHOPIFY_OPTION_LIMIT) issues.push({ severity: 'error', code: 'too-many-options', productIds: [],
    message: `Shopify allows ${SHOPIFY_OPTION_LIMIT} options per product; ${native.length} would remain (${native.map(a => a.label).join(', ')}).` })
  const names = native.map(optionName)
  if (names.some(name => !name)) issues.push({ severity: 'error', code: 'blank-option-name', productIds: [], message: 'Every Shopify option needs a name.' })
  const repeatedNames = [...new Set(names.filter((name, i) => name && names.findIndex(n => fold(n) === fold(name)) !== i))]
  if (repeatedNames.length) issues.push({ severity: 'error', code: 'duplicate-option-name', productIds: [],
    message: `Two Shopify options share the name ${quoted(repeatedNames)}. Give each option its own name.` })

  const groups = new Map<string, ColourPlanVariant[]>()
  for (const key of ordered(complete.map(v => split === null ? '' : v.values[split]), split === null ? [] : family.valueOrder[split])) groups.set(key, [])
  for (const variant of complete) groups.get(split === null ? '' : variant.values[split])!.push(variant)

  const products: ColourPlanProduct[] = [...groups].map(([key, variants], position) => {
    const options = native.map(axis => ({ axis: axis.code, name: optionName(axis), values: ordered(variants.map(v => v.values[axis.code]), family.valueOrder[axis.code]) }))
    const sorted = [...variants].sort((a, b) => {
      for (const option of options) {
        const d = option.values.indexOf(a.values[option.axis]) - option.values.indexOf(b.values[option.axis])
        if (d) return d
      }
      return 0
    })
    // Shopify tells variants and values apart by their text, so two keys with the same text are the same value there.
    for (const option of options) {
      const byText = new Map<string, string[]>()
      for (const value of option.values) byText.set(fold(label(value)), [...byText.get(fold(label(value))) ?? [], value])
      for (const same of byText.values()) if (same.length > 1) issues.push({ severity: 'error', code: 'duplicate-option-value', key,
        productIds: variants.filter(v => same.includes(v.values[option.axis])).map(v => v.productId),
        message: `${option.name} would list ${quoted(same.map(label))} as separate values, but Shopify reads them as one. Use one spelling.` })
    }
    const combinations = new Map<string, ColourPlanVariant[]>()
    for (const variant of sorted) {
      const combination = JSON.stringify(options.map(o => fold(label(variant.values[o.axis]))))
      combinations.set(combination, [...combinations.get(combination) ?? [], variant])
    }
    for (const same of combinations.values()) if (same.length > 1) issues.push({ severity: 'error', code: 'duplicate-variant', key, productIds: same.map(v => v.productId),
      message: `${same.map(v => v.sku).join(' and ')} have the same ${[...(split === null ? [] : [label(key)]), ...options.map(o => label(same[0].values[o.axis]))].join(' / ') || 'values'}. Each variant needs its own combination.` })
    if (sorted.length > SHOPIFY_VARIANT_LIMIT) issues.push({ severity: 'error', code: 'too-many-variants', key, productIds: [],
      message: `${split === null ? 'This product' : `"${label(key)}"`} has ${sorted.length} variants; Nexus publishes at most ${SHOPIFY_VARIANT_LIMIT} per Shopify product.` })
    const chosen = split === null ? undefined : settings.colourNames?.[key]?.trim()
    return {
      key, position, nexusValue: split === null ? '' : label(key),
      colourName: split === null ? '' : chosen || label(key).trim(), colourNameSource: split === null ? null : chosen ? 'operator' : 'nexus',
      options: options.map(o => ({ ...o, values: o.values.map(label) })),
      variants: sorted.map(v => ({ productId: v.productId, sku: v.sku, options: options.map(o => ({ name: o.name, value: label(v.values[o.axis]) })) })),
    }
  })

  if (split !== null) {
    const unmapped = new Set(family.unmapped)
    for (const product of products) {
      const ids = groups.get(product.key)!.map(v => v.productId)
      if (unmapped.has(product.key)) issues.push({ severity: 'error', code: 'unmapped-split-value', key: product.key, productIds: ids,
        message: `"${product.nexusValue}" is not an option of the attribute yet. Add it (or map it) first, so its Shopify product keeps its identity when the value is renamed.` })
      if (!product.colourName) issues.push({ severity: 'error', code: 'blank-colour-name', key: product.key, productIds: ids, message: `Name the colour of the "${product.nexusValue}" product for Shopify.` })
    }
    const byName = new Map<string, ColourPlanProduct[]>()
    for (const product of products.filter(p => p.colourName)) byName.set(fold(product.colourName), [...byName.get(fold(product.colourName)) ?? [], product])
    for (const same of byName.values()) if (same.length > 1) issues.push({ severity: 'error', code: 'duplicate-colour-name', productIds: same.flatMap(p => groups.get(p.key)!.map(v => v.productId)),
      message: `${quoted(same.map(p => p.nexusValue))} would all be called "${same[0].colourName}" on Shopify. Give each colour its own name.` })
    if (products.length > SHOPIFY_LINKED_LIST_LIMIT) issues.push({ severity: 'error', code: 'too-many-products', productIds: [],
      message: `Shopify can group at most ${SHOPIFY_LINKED_LIST_LIMIT} products; this family has ${products.length} colours.` })
    else if (products.length > IMPACT_LINKED_SHOWN_LIMIT) issues.push({ severity: 'warning', code: 'more-than-shown', productIds: [],
      message: `The theme shows at most ${IMPACT_LINKED_SHOWN_LIMIT} colours; this family has ${products.length}. The rest are grouped but not shown.` })
  }

  return { familyId: family.familyId, mode: split === null ? 'one-product' : 'colour-products', splitAxis: split, products, grouped: split !== null && products.length >= 2, issues }
}
