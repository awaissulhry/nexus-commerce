/**
 * A family as colour products see it: the planner's input from the one family loader the Media page and its publishers
 * use (`loadFamily`: axes as dictionary codes, each variant's value keys, the family's value order), then the plan.
 */
import { planColourProducts, type ColourPlan } from '@nexus/shared/shopify-colour-products'
import { loadFamily } from '../../images/media-plan.service.js'
import { canonicalVariantAxis } from '../../pim/variant-attribute-keys.js'

/** The colour axis, by the same rule as the Media page's default axis: its label reads as colour, or its code is `color`. */
export function colourAxisOf(axes: ReadonlyArray<{ code: string; label: string }>): string | null {
  return axes.find(axis => canonicalVariantAxis(axis.label) === canonicalVariantAxis('Color') || axis.code === 'color')?.code ?? null
}

/**
 * The family's Shopify colour products. `splitAxis`: the axis whose values become separate products — the operator's
 * choice when there is one, else the colour axis; a family without one stays one product. `colourNames`: the operator's
 * Shopify colour names, by value key.
 */
export async function loadColourPlan(rootId: string, options: { splitAxis?: string | null; colourNames?: Record<string, string> } = {}): Promise<{ plan: ColourPlan; rootId: string; sku: string }> {
  const { root, family, axes, unmapped } = await loadFamily(rootId)
  const splitAxis = options.splitAxis !== undefined ? options.splitAxis : colourAxisOf(axes)
  const plan = planColourProducts({
    familyId: root.id,
    axes: axes.map(axis => ({ code: axis.code, label: axis.label })),
    variants: family.variants.map(v => ({ productId: v.productId, sku: v.sku, values: v.values })),
    valueOrder: family.valueOrder,
    valueLabels: family.valueLabels,
    unmapped,
  }, { splitAxis, colourNames: options.colourNames })
  return { plan, rootId: root.id, sku: root.sku }
}
