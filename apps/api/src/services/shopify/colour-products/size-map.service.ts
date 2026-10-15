/**
 * The size map (Feature 2): per family and Shopify destination, the Shopify option value each Nexus value is on this
 * store when they differ — MISANO's EU 44 … 60 are XS … 5XL there. Kept on the family's colour-sync row
 * (`ShopifyColourSync.sizeMap`, one per family and exact destination). The plan applies it (`planColourProducts`,
 * `sizeMap`), so Find's pairing, Confirm, the sync's size identity check (`planColourVariants`), size create and size
 * order all use the mapped value. Without a map every value is itself, exactly as before.
 *
 * Saving writes nothing to Shopify; the next Find pairs the sizes with it. The map is a whole replacement, checked
 * against the family: an axis must be a native option of the plan (never the colour axis) and a value one of that axis's
 * Nexus values. A pairing that does not fit a linked size never reaches the store: the colour sync's identity check
 * refuses that colour before any write ("Shopify changed the size identity or options"), and a new size whose mapped
 * value another SKU holds is refused too (`planColourVariants`). That same check is what a map fixes: a family linked by
 * its SKUs whose EU sizes are letter sizes on Shopify syncs once the map pairs them.
 */
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { contentDestination, type ContentScope } from '../content-workspace.service.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import { colourProductsView, planFor, type Destination } from './find.service.js'
import { commitColourSyncChange, withColourSyncLock } from './sync-work.js'

const text = z.string().trim().min(1, 'Every size needs a value.').max(255)
const bodySchema = z.object({
  /** Native axis code → { Nexus value → Shopify option value }. A value paired with itself is no pairing. */
  sizeMap: z.record(z.string().min(1).max(255), z.record(z.string().min(1).max(255), text)),
}).strict().superRefine((body, ctx) => {
  if (Object.keys(body.sizeMap).length > 3) ctx.addIssue({ code: 'custom', message: 'Shopify has at most 3 options per product.' })
  if (Object.values(body.sizeMap).some(pairs => Object.keys(pairs).length > 250)) ctx.addIssue({ code: 'custom', message: 'Pair at most 250 values per option.' })
})

export async function saveColourSizeMap(productId: string, scope: ContentScope, body: unknown) {
  const input = bodySchema.parse(body ?? {})
  const destination = await contentDestination(productId, scope)
  return withColourSyncLock(destination, () => saveDestination(destination, input.sizeMap))
}

async function saveDestination(d: Destination, wanted: Record<string, Record<string, string>>) {
  const { settings, plan, sizeMap: current = {} } = await planFor(d)
  if (plan.mode !== 'colour-products' || !plan.splitAxis) throw new WorkspaceScopeError('This family has no colour to show as separate Shopify products. Nothing was changed.', 422)
  // Per native axis, the family's Nexus values (the plan carries the mapped ones, the Nexus ones beside them).
  const nexusValues = new Map<string, Set<string>>()
  for (const product of plan.products) for (const option of product.options) {
    const values = nexusValues.get(option.axis) ?? new Set<string>()
    for (const value of option.nexusValues ?? option.values) values.add(value)
    nexusValues.set(option.axis, values)
  }
  const problems: string[] = []
  const next: Record<string, Record<string, string>> = {}
  for (const [axis, pairs] of Object.entries(wanted)) {
    const known = nexusValues.get(axis)
    if (!known) { problems.push(`"${axis}" is not an option of this family's Shopify products.`); continue }
    const unknown = Object.keys(pairs).filter(value => !known.has(value))
    if (unknown.length) problems.push(`${unknown.map(v => `"${v}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a value of this family. Reload, then pair the sizes again.`)
    const kept = Object.entries(pairs).filter(([nexus, shopify]) => known.has(nexus) && shopify !== nexus)
    if (kept.length) next[axis] = Object.fromEntries(kept)
  }
  if (problems.length) throw new WorkspaceScopeError(`${problems.join(' ')} Nothing was changed.`, 409)

  const changed = JSON.stringify(next) !== JSON.stringify(current)
  if (changed) {
    await commitColourSyncChange(async tx => {
      // Due now, as any family change: the colour sync reads the new pairing on its next poll.
      await tx.shopifyColourSync.updateMany({ where: { familyId: d.familyId, channelConnectionId: d.accountId, marketplace: d.marketplace, aliasKey: d.aliasKey ?? '' },
        data: { sizeMap: Object.keys(next).length ? next : Prisma.DbNull, dueAt: new Date(), revision: { increment: 1 } } })
    })
  }
  return { ...await colourProductsView(d, changed ? (await planFor(d)).plan : plan, settings), sizeMapSaved: changed }
}
