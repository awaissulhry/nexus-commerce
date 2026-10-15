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
  /** Axis code → the Shopify option NAME ("Taglia" → "Size"). Default: the axis label. Names only; values: `sizeMap`. */
  optionNames?: Readonly<Record<string, string>>
  /** Split value key → the colour name the operator chose for Shopify ("Black"). Default: the Nexus value. */
  colourNames?: Readonly<Record<string, string>>
  /**
   * Split value key → what the store shows for that colour today (Find's read): its product, its swatch group and its
   * colour name. Default: nothing known — the family's colours are one swatch group and no name is the store's.
   */
  swatches?: Readonly<Record<string, ColourSwatch>>
  /**
   * The size map: native axis code → { Nexus value → the Shopify option value it is on this store } ("44" → "XS"). A
   * value the map does not name is itself. Every product, Find's pairing, Confirm, the sync's size identity check, size
   * create and size order then read the mapped value; the Nexus value stays beside it (`nexusValue(s)`).
   */
  sizeMap?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

/**
 * What the store shows for one colour (Feature 1, read by Find): the Shopify product, the products its colour list names
 * (`custom.variation_products`, itself included on a well-formed group; null or empty: in no group), and the colour
 * name it shows (`custom.variation_value`).
 */
export interface ColourSwatch { shopifyProductId: string | null; group: readonly string[] | null; name?: string | null }

/** `values`: as Shopify holds them (the size map applied); `nexusValues`: the Nexus value of each, only when the map changed one. */
export interface ColourPlanOption { axis: string; name: string; values: string[]; nexusValues?: string[] }
/** Each option's `value` as Shopify holds it; `nexusValue` only when the size map pairs it with another value. */
export interface ColourPlanProductVariant { productId: string; sku: string; options: Array<{ name: string; value: string; nexusValue?: string }> }
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
  /** Its swatch group: an index into the plan's `swatchGroups`; null for a one-product family, or a colour no group takes. */
  swatchGroup: number | null
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
  /** True when the products are to be grouped: a swatch group of two or more colour products. A single colour needs no group. */
  grouped: boolean
  /** The swatch groups (value keys, in colour order): the store's groups (`swatchGroupsOf`), else one group of every colour. */
  swatchGroups: string[][]
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

/**
 * The store's swatch groups among these colours (Feature 1: each colour keeps the group it has on Shopify). Two colours
 * are in one group when the colour list of either names the other's product. A colour whose product lists no group and
 * that no list names is loose. With no group on the store at all, every colour is one group (Nexus groups the family, as
 * before); with exactly one, a loose colour joins it (the simplest safe rule: a colour Nexus adds to a family the store
 * shows as one group); with two or more, Nexus cannot tell which group a loose colour belongs to: it is `unplaced`, no
 * group takes it, and the link writer refuses until the store puts it in one. Groups come in the order of their first
 * colour. Inside a group, colours keep the order the store's lists hold them in (the Owner: the store stays as it is):
 * the first stored list of the group, then any other member's list; a colour no list names (new to the group) comes
 * last. A family the store does not group yet keeps the order given (the family's colour order).
 */
export function swatchGroupsOf(keys: readonly string[], swatches: Readonly<Record<string, ColourSwatch>> = {}): { groups: string[][]; unplaced: string[] } {
  const unique = [...new Set(keys)]
  const productOf = (key: string) => swatches[key]?.shopifyProductId || null
  const lists = (key: string) => !!productOf(key) && (swatches[key]?.group?.length ?? 0) > 0
  const keyOf = new Map<string, string>()
  for (const key of unique) { const id = productOf(key); if (id && !keyOf.has(id)) keyOf.set(id, key) }
  const parent = new Map(unique.map(key => [key, key]))
  const root = (key: string): string => { let at = key; while (parent.get(at) !== at) at = parent.get(at)!; return at }
  for (const key of unique.filter(lists)) for (const id of swatches[key]!.group!) {
    const other = keyOf.get(id)
    if (other && root(other) !== root(key)) parent.set(root(other), root(key))
  }
  const listed = new Set(unique.filter(lists).map(root))
  const components = new Map<string, string[]>()
  for (const key of unique) if (listed.has(root(key))) components.set(root(key), [...components.get(root(key)) ?? [], key])
  const loose = unique.filter(key => !listed.has(root(key)))
  // The store's order: every id the members' lists name, in list order (members in the order given), first seen first.
  const inStoreOrder = (members: string[]) => {
    const order = [...new Set(members.flatMap(key => lists(key) ? swatches[key]!.group! : []))]
    const rank = (key: string) => { const i = order.indexOf(productOf(key) ?? ''); return i < 0 ? order.length : i }
    return members.map((key, i) => ({ key, i })).sort((a, b) => rank(a.key) - rank(b.key) || a.i - b.i).map(e => e.key)
  }
  const groups = [...components.values()]
  if (!groups.length) return { groups: unique.length ? [unique] : [], unplaced: [] }
  if (groups.length === 1) return { groups: [inStoreOrder(unique.filter(key => groups[0].includes(key) || loose.includes(key)))], unplaced: [] }
  return { groups: groups.map(inStoreOrder), unplaced: loose }
}

/** The Shopify products of one family on one store, with every problem that would stop them from being published. */
export function planColourProducts(family: ColourPlanFamily, settings: ColourPlanSettings): ColourPlan {
  const issues: ColourPlanIssue[] = []
  const label = (key: string) => family.valueLabels[key] ?? key
  const split = settings.splitAxis
  if (split !== null && !family.axes.some(a => a.code === split)) {
    issues.push({ severity: 'error', code: 'split-axis-unknown', message: `The family has no "${split}" axis to show as separate products.`, productIds: [] })
    return { familyId: family.familyId, mode: 'colour-products', splitAxis: split, products: [], grouped: false, swatchGroups: [], issues }
  }
  const native = family.axes.filter(a => a.code !== split)
  const optionName = (axis: ColourPlanAxis) => (settings.optionNames?.[axis.code] ?? axis.label).trim()
  // The size map: the value Shopify holds for a Nexus value of a native axis (itself when the map does not name it).
  const shopifyValue = (axis: string, key: string) => settings.sizeMap?.[axis]?.[label(key)]?.trim() || label(key)

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
    // Shopify tells variants and values apart by their text, so two keys with the same text are the same value there
    // (also two Nexus values the size map pairs with one Shopify value).
    for (const option of options) {
      const byText = new Map<string, string[]>()
      for (const value of option.values) byText.set(fold(shopifyValue(option.axis, value)), [...byText.get(fold(shopifyValue(option.axis, value))) ?? [], value])
      for (const same of byText.values()) if (same.length > 1) issues.push({ severity: 'error', code: 'duplicate-option-value', key,
        productIds: variants.filter(v => same.includes(v.values[option.axis])).map(v => v.productId),
        message: same.some(value => shopifyValue(option.axis, value) !== label(value))
          ? `The size map pairs ${quoted(same.map(label))} with one Shopify ${option.name} value, "${shopifyValue(option.axis, same[0])}". Pair each with its own value.`
          : `${option.name} would list ${quoted(same.map(label))} as separate values, but Shopify reads them as one. Use one spelling.` })
    }
    const combinations = new Map<string, ColourPlanVariant[]>()
    for (const variant of sorted) {
      const combination = JSON.stringify(options.map(o => fold(shopifyValue(o.axis, variant.values[o.axis]))))
      combinations.set(combination, [...combinations.get(combination) ?? [], variant])
    }
    for (const same of combinations.values()) if (same.length > 1) issues.push({ severity: 'error', code: 'duplicate-variant', key, productIds: same.map(v => v.productId),
      message: `${same.map(v => v.sku).join(' and ')} have the same ${[...(split === null ? [] : [label(key)]), ...options.map(o => shopifyValue(o.axis, same[0].values[o.axis]))].join(' / ') || 'values'}. Each variant needs its own combination.` })
    if (sorted.length > SHOPIFY_VARIANT_LIMIT) issues.push({ severity: 'error', code: 'too-many-variants', key, productIds: [],
      message: `${split === null ? 'This product' : `"${label(key)}"`} has ${sorted.length} variants; Nexus publishes at most ${SHOPIFY_VARIANT_LIMIT} per Shopify product.` })
    const chosen = split === null ? undefined : settings.colourNames?.[key]?.trim()
    return {
      key, position, nexusValue: split === null ? '' : label(key),
      colourName: split === null ? '' : chosen || label(key).trim(), colourNameSource: split === null ? null : chosen ? 'operator' : 'nexus', swatchGroup: null,
      options: options.map(o => {
        const values = o.values.map(value => shopifyValue(o.axis, value)), nexusValues = o.values.map(label)
        return { ...o, values, ...(values.some((value, i) => value !== nexusValues[i]) ? { nexusValues } : {}) }
      }),
      variants: sorted.map(v => ({ productId: v.productId, sku: v.sku, options: options.map(o => {
        const value = shopifyValue(o.axis, v.values[o.axis]), nexusValue = label(v.values[o.axis])
        return { name: o.name, value, ...(value !== nexusValue ? { nexusValue } : {}) }
      }) })),
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
    // Feature 1 — each colour keeps the swatch group it has on the store. A name repeats freely across groups, and
    // inside one group when the store already shows it that way (adopting what the store shows); Nexus refuses only a
    // repeat it would create itself: a colour whose name equals another's in its group and is not the name its own
    // product shows. The refusal names that colour (its key), so it stops that colour only.
    const swatch = swatchGroupsOf(products.map(p => p.key), settings.swatches)
    swatch.groups.forEach((members, index) => { for (const product of products) if (members.includes(product.key)) product.swatchGroup = index })
    const storeName = (key: string) => settings.swatches?.[key]?.name?.trim() ?? null
    for (const members of swatch.groups) {
      const byName = new Map<string, ColourPlanProduct[]>()
      for (const product of products.filter(p => p.colourName && members.includes(p.key))) byName.set(fold(product.colourName), [...byName.get(fold(product.colourName)) ?? [], product])
      for (const same of byName.values()) if (same.length > 1) for (const product of same) {
        if (product.colourName === storeName(product.key)) continue
        issues.push({ severity: 'error', code: 'duplicate-colour-name', key: product.key, productIds: groups.get(product.key)!.map(v => v.productId),
          message: `"${product.nexusValue}" would be called "${product.colourName}" on Shopify, like ${quoted(same.filter(o => o !== product).map(o => o.nexusValue))} in the same swatch group. Give it its own name.` })
      }
    }
    const largest = Math.max(0, ...swatch.groups.map(g => g.length))
    const counted = swatch.groups.length > 1 ? `one swatch group of this family has ${largest} colours` : `this family has ${largest} colours`
    if (largest > SHOPIFY_LINKED_LIST_LIMIT) issues.push({ severity: 'error', code: 'too-many-products', productIds: [],
      message: `Shopify can group at most ${SHOPIFY_LINKED_LIST_LIMIT} products; ${counted}.` })
    else if (largest > IMPACT_LINKED_SHOWN_LIMIT) issues.push({ severity: 'warning', code: 'more-than-shown', productIds: [],
      message: `The theme shows at most ${IMPACT_LINKED_SHOWN_LIMIT} colours; ${swatch.groups.length > 1 ? `one swatch group of this family has ${largest}` : `this family has ${largest}`}. The rest are grouped but not shown.` })
    return { familyId: family.familyId, mode: 'colour-products', splitAxis: split, products, grouped: swatch.groups.some(g => g.length >= 2), swatchGroups: swatch.groups, issues }
  }

  return { familyId: family.familyId, mode: 'one-product', splitAxis: split, products, grouped: false, swatchGroups: [], issues }
}

// ── Find (PR 3): which Shopify product is each colour, and which variant each size ──────────────────────────────────

/** A Shopify product as Find reads it. A variant's `options` are its option values in the product's option order. */
export interface ColourCandidate {
  id: string; title: string; handle: string; status: string
  /** The colour the product shows today (the grouping value field), when set. */
  colourName: string | null
  /** The products its grouping list names (itself included, on a well-formed group). */
  group: string[]
  variants: Array<{ id: string; sku: string | null; inventoryItemId: string | null; options: string[] }>
}
/** `operator`: the Shopify product the operator chose for this colour (Find's `choices`). */
export type ColourMatchMethod = 'linked' | 'operator' | 'sku' | 'name' | 'group'
export interface ColourMatchVariant { productId: string; sku: string; shopifyVariantId: string; inventoryItemId: string | null; shopifySku: string | null; by: 'sku' | 'options' }
export type ColourMatchIssueCode = 'sku-spread' | 'product-claimed-twice' | 'sku-of-another-colour' | 'sku-differs' | 'variant-ambiguous' | 'chosen-not-found' | 'sku-outside-choice'
export interface ColourMatchIssue { code: ColourMatchIssueCode; message: string; productIds: string[] }
export interface ColourMatch {
  key: string
  shopifyProductId: string | null
  method: ColourMatchMethod | null
  /** The colour the Shopify product shows today: the operator's name starts from it. */
  shopifyColourName: string | null
  variants: ColourMatchVariant[]
  /** Nexus variants the Shopify product does not have yet. Find never adds them. */
  missing: Array<{ productId: string; sku: string; options: string[] }>
  /** Shopify variants Nexus does not know. They stay exactly as they are: Nexus never deletes a variant. */
  extra: Array<{ shopifyVariantId: string; sku: string | null; options: string[] }>
  /**
   * Matched Shopify variants whose SKU Nexus writes on Confirm (stock sync compares SKUs exactly): those with no SKU, and
   * those whose SKU differs from the Nexus SKU only in letter case (`from`: Shopify's spelling). Shopify follows Nexus;
   * a Shopify SKU is never copied into Nexus (the Owner: Nexus SKUs never change).
   */
  skusToWrite: Array<{ shopifyVariantId: string; sku: string; from?: string }>
  /**
   * In a product the operator chose: sizes paired by their option values whose Shopify variant carries another SKU (of
   * another colour, or with another prefix). Confirm replaces them with the Nexus SKUs on Shopify only when the
   * operator asks for it (`replaceSkus`); without that the colour is refused.
   */
  skusToReplace: Array<{ productId: string; shopifyVariantId: string; from: string; to: string }>
  issues: ColourMatchIssue[]
}

const skuKey = (sku: string | null | undefined) => (sku ?? '').trim().toLocaleUpperCase('en')
const valuesKey = (values: readonly string[]) => JSON.stringify(values.map(fold).sort())
/** Shopify names the only variant of a product without options "Default Title". */
const DEFAULT_TITLE = 'Default Title'

/** A SKU that differs from another only in letter case (no surrounding spaces): Nexus writes its own spelling over it. */
const caseOnly = (shopify: string | null, nexus: string) => !!shopify && shopify !== nexus && shopify === shopify.trim() && shopify.toLocaleUpperCase('en') === nexus.trim().toLocaleUpperCase('en')

/**
 * Pairs each colour product of the plan with at most one Shopify product, and each of its variants with at most one
 * Shopify variant. Order of evidence: an existing link; the product the operator chose (`chosen`, value key → product);
 * the colour's SKUs (all in ONE product); the colour's name (the operator's, or the Nexus value) against the product's
 * colour; and, when exactly one colour and one product of an already-matched group are left, each other. Sizes are
 * matched inside the product by SKU, then by option values. A proposal only: nothing is written, and every doubt is an
 * issue.
 */
export function matchColourProducts(plan: ColourPlan, candidates: readonly ColourCandidate[], linked: Readonly<Record<string, string>> = {},
  chosenByOperator: Readonly<Record<string, string>> = {}): ColourMatch[] {
  const byId = new Map(candidates.map(c => [c.id, c]))
  const skuColour = new Map<string, string>()
  for (const product of plan.products) for (const variant of product.variants) if (skuKey(variant.sku)) skuColour.set(skuKey(variant.sku), product.key)
  const chosen = new Map<string, { id: string; method: ColourMatchMethod }>()
  const early = new Map<string, ColourMatchIssue[]>()
  const note = (key: string, issue: ColourMatchIssue) => early.set(key, [...early.get(key) ?? [], issue])
  const taken = () => new Set([...chosen.values()].map(c => c.id))
  const productIdsOf = (key: string) => plan.products.find(p => p.key === key)!.variants.map(v => v.productId)

  for (const product of plan.products) {
    const id = linked[product.key]
    if (id && byId.has(id)) chosen.set(product.key, { id, method: 'linked' })
  }
  // The operator's choice outranks every guess. A product the operator chose for one colour is never another colour's
  // by its SKUs: the SKUs it holds are that choice's to replace (`skusToReplace`), not a claim.
  for (const product of plan.products.filter(p => !chosen.has(p.key) && chosenByOperator[p.key])) {
    const id = chosenByOperator[product.key]
    if (!byId.has(id)) { note(product.key, { code: 'chosen-not-found', productIds: productIdsOf(product.key), message: `The Shopify product chosen for "${product.nexusValue}" was not found in the store. Choose another product.` }); continue }
    chosen.set(product.key, { id, method: 'operator' })
  }
  const operatorTaken = new Set([...chosen.values()].filter(c => c.method === 'operator').map(c => c.id))
  // The chosen colour's SKUs must not sit in a product nobody chose for them (two products holding one SKU confuse
  // stock and orders): an issue, never a silent override.
  for (const [key, pick] of chosen) {
    if (pick.method !== 'operator') continue
    const product = plan.products.find(p => p.key === key)!
    const skus = new Set(product.variants.map(v => skuKey(v.sku)).filter(Boolean))
    const elsewhere = candidates.filter(c => !operatorTaken.has(c.id) && c.variants.some(v => skus.has(skuKey(v.sku))))
    if (elsewhere.length) note(key, { code: 'sku-outside-choice', productIds: productIdsOf(key),
      message: `Some "${product.nexusValue}" SKUs are in ${elsewhere.map(c => `"${c.title}"`).join(', ')}, not in "${byId.get(pick.id)!.title}", the product chosen for it. Keep one colour's sizes in one product.` })
  }
  for (const product of plan.products.filter(p => !chosen.has(p.key) && !early.has(p.key))) {
    const skus = new Set(product.variants.map(v => skuKey(v.sku)).filter(Boolean))
    const hits = candidates.filter(c => !operatorTaken.has(c.id) && c.variants.some(v => skus.has(skuKey(v.sku))))
    if (hits.length === 1) chosen.set(product.key, { id: hits[0].id, method: 'sku' })
    else if (hits.length > 1) note(product.key, { code: 'sku-spread', productIds: productIdsOf(product.key),
      message: `The "${product.nexusValue}" SKUs are in ${hits.length} Shopify products (${hits.map(h => h.title).join(', ')}). Keep one colour's sizes in one product.` })
  }
  for (const product of plan.products.filter(p => !chosen.has(p.key) && !early.has(p.key))) {
    const names = new Set([product.colourName, product.nexusValue].filter(Boolean).map(fold))
    const hits = candidates.filter(c => c.colourName && names.has(fold(c.colourName)) && !taken().has(c.id))
    if (hits.length === 1) chosen.set(product.key, { id: hits[0].id, method: 'name' })
  }
  const open = plan.products.filter(p => !chosen.has(p.key) && !early.has(p.key))
  if (open.length === 1 && chosen.size) {
    const members = new Set([...chosen.values()].flatMap(c => byId.get(c.id)!.group))
    const left = candidates.filter(c => members.has(c.id) && !taken().has(c.id))
    if (left.length === 1) chosen.set(open[0].key, { id: left[0].id, method: 'group' })
  }
  // One Shopify product can be one colour only: claimed by two, it is neither's.
  const claims = new Map<string, string[]>()
  for (const [key, c] of chosen) claims.set(c.id, [...claims.get(c.id) ?? [], key])
  for (const [id, keys] of claims) if (keys.length > 1) for (const key of keys) {
    chosen.delete(key)
    note(key, { code: 'product-claimed-twice', productIds: productIdsOf(key), message: `"${byId.get(id)!.title}" matches ${keys.length} colours. Pick the colour it shows.` })
  }

  return plan.products.map(product => {
    const pick = chosen.get(product.key), candidate = pick ? byId.get(pick.id)! : null
    const issues = [...early.get(product.key) ?? []]
    const variants: ColourMatchVariant[] = [], missing: ColourMatch['missing'] = [], skusToWrite: ColourMatch['skusToWrite'] = []
    const skusToReplace: ColourMatch['skusToReplace'] = []
    const used = new Set<string>()
    for (const variant of product.variants) {
      const values = variant.options.map(o => o.value)
      if (!candidate) { missing.push({ productId: variant.productId, sku: variant.sku, options: values }); continue }
      let by: ColourMatchVariant['by'] = 'sku'
      let hits = candidate.variants.filter(sv => skuKey(sv.sku) && skuKey(sv.sku) === skuKey(variant.sku))
      if (!hits.length) { by = 'options'; hits = candidate.variants.filter(sv => valuesKey(sv.options) === valuesKey(values.length ? values : [DEFAULT_TITLE])) }
      hits = hits.filter(sv => !used.has(sv.id))
      if (hits.length > 1) issues.push({ code: 'variant-ambiguous', productIds: [variant.productId], message: `${variant.sku} fits ${hits.length} Shopify variants of "${candidate.title}".` })
      if (hits.length !== 1) { missing.push({ productId: variant.productId, sku: variant.sku, options: values }); continue }
      const hit = hits[0]
      used.add(hit.id)
      if (by === 'options' && skuKey(hit.sku) && pick?.method === 'operator') skusToReplace.push({ productId: variant.productId, shopifyVariantId: hit.id, from: hit.sku!, to: variant.sku })
      else if (by === 'options' && skuKey(hit.sku)) {
        const owner = skuColour.get(skuKey(hit.sku))
        issues.push(owner && owner !== product.key
          ? { code: 'sku-of-another-colour', productIds: [variant.productId], message: `In "${candidate.title}", the ${values.join(' / ') || 'only'} variant has SKU ${hit.sku}, a SKU of another colour in Nexus.` }
          : { code: 'sku-differs', productIds: [variant.productId], message: `In "${candidate.title}", the ${values.join(' / ') || 'only'} variant has SKU ${hit.sku}; Nexus has ${variant.sku}. Stock sync needs the same SKU. Change one of them.` })
      } else if (by === 'options') skusToWrite.push({ shopifyVariantId: hit.id, sku: variant.sku })
      else if (caseOnly(hit.sku, variant.sku)) skusToWrite.push({ shopifyVariantId: hit.id, sku: variant.sku, from: hit.sku! })
      variants.push({ productId: variant.productId, sku: variant.sku, shopifyVariantId: hit.id, inventoryItemId: hit.inventoryItemId, shopifySku: hit.sku, by })
    }
    const extra = candidate ? candidate.variants.filter(sv => !used.has(sv.id)).map(sv => ({ shopifyVariantId: sv.id, sku: sv.sku, options: sv.options })) : []
    for (const sv of extra) {
      const owner = skuColour.get(skuKey(sv.sku))
      if (owner && owner !== product.key) issues.push({ code: 'sku-of-another-colour', productIds: productIdsOf(owner).filter(id => plan.products.find(p => p.key === owner)!.variants.some(v => v.productId === id && skuKey(v.sku) === skuKey(sv.sku))),
        message: `"${candidate!.title}" holds SKU ${sv.sku}, which is another colour in Nexus.` })
    }
    return { key: product.key, shopifyProductId: candidate?.id ?? null, method: pick?.method ?? null, shopifyColourName: candidate?.colourName ?? null,
      variants, missing, extra, skusToWrite, skusToReplace, issues }
  })
}
