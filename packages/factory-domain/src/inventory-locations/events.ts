import { z } from 'zod'
import { defineEvent } from '../events/define'
import { BLOCK_REASONS } from '../inventory/locations-depth/blocks'
import { DEFAULT_PURPOSES, HELD_ITEM_KINDS } from '../inventory/locations-depth/kinds'

/**
 * The events of locations in depth (B-W2b-289; SCM-178, SCM-179, SCM-181; apps/factory-api modules/inventory/
 * locations-depth). They reach the locations and warehouse rules screens (inventory.locations.view); never a person. Its
 * own module folder, as inventory-rolls (B-W2b-107): the inventory events file is other steps', so the two never clash.
 *
 *   inventory.location_blocked         once per place blocked, its block changed, or unblocked: by a person, or by a count
 *                                      as its counting starts and ends (countId)
 *   inventory.location_label_changed   once per place whose bin label code was given, changed or taken off (printing
 *                                      gives a place without one its suggested code: one event each)
 *   inventory.default_location_changed once per default place set or cleared for a site, a kind of material (null: the
 *                                      site's fallback) and a purpose
 */
export const events = [
  defineEvent({
    type: 'inventory.location_blocked',
    context: 'inventory-locations',
    description: 'A location was blocked (no move in or out but a count), its block changed, or it was unblocked; by a person, or by a count as its counting started or ended.',
    payload: z.strictObject({
      locationId: z.uuid(),
      code: z.string(),
      change: z.enum(['BLOCKED', 'CHANGED', 'UNBLOCKED']),
      /** The reason now (null once unblocked). */
      reason: z.enum(BLOCK_REASONS).nullable(),
      /** The last day it holds (YYYY-MM-DD, Europe/Rome); null: until it is unblocked. */
      until: z.iso.date().nullable(),
      /** The count that blocked or unblocked it; null: a person. */
      countId: z.uuid().nullable(),
    }),
    live: { permission: 'inventory.locations.view', fields: ['locationId', 'code', 'change', 'reason', 'until', 'countId'] },
  }),
  defineEvent({
    type: 'inventory.location_label_changed',
    context: 'inventory-locations',
    description: "A location's bin label code (what a scan of its label reads) was given, changed or taken off.",
    payload: z.strictObject({
      locationId: z.uuid(),
      code: z.string(),
      labelCode: z.string().nullable(),
      change: z.enum(['SET', 'CHANGED', 'CLEARED']),
    }),
    live: { permission: 'inventory.locations.view', fields: ['locationId', 'code', 'labelCode', 'change'] },
  }),
  defineEvent({
    type: 'inventory.default_location_changed',
    context: 'inventory-locations',
    description: "A site's default location for a kind of material (or every kind) and a purpose (receiving, quality, issue, return, put-away) was set or cleared.",
    payload: z.strictObject({
      siteId: z.uuid(),
      itemKind: z.enum(HELD_ITEM_KINDS).nullable(),
      purpose: z.enum(DEFAULT_PURPOSES),
      /** The place now; null once cleared. */
      locationId: z.uuid().nullable(),
      change: z.enum(['SET', 'CLEARED']),
    }),
    live: { permission: 'inventory.locations.view', fields: ['siteId', 'itemKind', 'purpose', 'locationId', 'change'] },
  }),
] as const
