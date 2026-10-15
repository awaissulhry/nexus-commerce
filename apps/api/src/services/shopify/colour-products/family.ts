/**
 * A family as colour products see it: the planner's input from the one family loader the Media page and its publishers
 * use (`loadFamily`: axes as dictionary codes, each variant's value keys, the family's value order), then the plan.
 */
import { planColourProducts, type ColourPlan, type ColourPlanSettings } from '@nexus/shared/shopify-colour-products'
import { loadFamily } from '../../images/media-plan.service.js'
import { canonicalVariantAxis } from '../../pim/variant-attribute-keys.js'

/** The colour axis, by the same rule as the Media page's default axis: its label reads as colour, or its code is `color`. */
export function colourAxisOf(axes: ReadonlyArray<{ code: string; label: string }>): string | null {
  return axes.find(axis => canonicalVariantAxis(axis.label) === canonicalVariantAxis('Color') || axis.code === 'color')?.code ?? null
}

/**
 * The family's Shopify colour products. `splitAxis`: the axis whose values become separate products — the operator's
 * choice when there is one, else the colour axis; a family without one stays one product. `colourNames`: the operator's
 * Shopify colour names, by value key. `swatches`: what the store shows for each colour (its swatch group and name).
 * `sizeMap`: the destination's size map (Nexus value → Shopify option value; null: an axis not on Shopify).
 */
export async function loadColourPlan(rootId: string, options: { splitAxis?: string | null } & Pick<ColourPlanSettings, 'colourNames' | 'swatches' | 'sizeMap'> = {}): Promise<{ plan: ColourPlan; rootId: string; sku: string }> {
  const { root, family, axes, unmapped, valueTexts } = await loadFamily(rootId)
  const splitAxis = options.splitAxis !== undefined ? options.splitAxis : colourAxisOf(axes)
  // A size is a Shopify option value as the product stores it — the text the Shopify publisher sends
  // (`storedVariationValues`) — never the dictionary option's default label it matches: a stored "46" whose option is
  // labelled otherwise ("EU 46", or a letter size that lists "46" as a synonym) must still pair with Shopify's "46". The
  // split axis keeps the dictionary label (it names the colour product; it is no Shopify option).
  const valueLabels = { ...family.valueLabels }
  for (const [key, text] of Object.entries(valueTexts)) if (splitAxis === null || !key.startsWith(`${splitAxis}:`)) valueLabels[key] = text
  const plan = planColourProducts({
    familyId: root.id,
    axes: axes.map(axis => ({ code: axis.code, label: axis.label })),
    variants: family.variants.map(v => ({ productId: v.productId, sku: v.sku, values: v.values })),
    valueOrder: family.valueOrder,
    valueLabels,
    unmapped,
  }, { splitAxis, colourNames: options.colourNames, swatches: options.swatches, sizeMap: options.sizeMap })
  return { plan, rootId: root.id, sku: root.sku }
}
