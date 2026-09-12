import { z } from 'zod'

export const informationInventorySchema = z.object({
  inventoryItemId: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/\d+$/), tracked: z.boolean(),
  locations: z.array(z.object({ locationId: z.string().regex(/^gid:\/\/shopify\/Location\/\d+$/), name: z.string(), active: z.boolean(),
    available: z.number().int().min(-1000000000).max(1000000000), onHand: z.number().int().min(-1000000000).max(1000000000),
  }).strict()).max(1000),
}).strict()
export type InformationInventory = z.infer<typeof informationInventorySchema>
export function inventoryEditError(before: string | null, after: string | null): string | null {
  try {
    const old = informationInventorySchema.parse(JSON.parse(before ?? 'null')), next = informationInventorySchema.parse(JSON.parse(after ?? 'null'))
    if (old.inventoryItemId !== next.inventoryItemId || old.tracked !== next.tracked || old.locations.length !== next.locations.length || new Set(next.locations.map(l => l.locationId)).size !== next.locations.length) return 'Inventory identities changed. Refresh the location quantities.'
    if (!next.tracked) return 'Enable Track quantity and synchronize it before setting inventory.'
    if (!next.locations.length) return 'This variant is not stocked at any location. Activate a stocking location in Shopify or the inventory workspace first.'
    for (const location of next.locations) {
      const baseline = old.locations.find(l => l.locationId === location.locationId)
      if (!baseline || baseline.active !== location.active || baseline.name !== location.name) return 'Choose an existing stocking location.'
      const available = baseline.available !== location.available, onHand = baseline.onHand !== location.onHand
      if ((available || onHand) && !location.active) return 'Inventory cannot be adjusted at an inactive location.'
      if (available && onHand) return 'Change either available or on-hand stock at a location. Shopify adjusts the related quantity automatically.'
    }
    return null
  } catch { return 'Enter whole-number quantities for the existing stocking locations.' }
}
