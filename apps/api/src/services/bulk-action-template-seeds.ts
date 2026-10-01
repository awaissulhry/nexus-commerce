/**
 * W5.4 — Built-in BulkActionTemplate seeds.
 *
 * Starter templates for everyday catalogue operations. Each carries
 * `isBuiltin=true`: the API refuses to edit or delete one; "Duplicate"
 * (`POST /bulk-action-templates/:id/duplicate`) makes an operator-owned
 * copy (`isBuiltin=false`) instead.
 *
 * When it runs: at every SCHEDULER start, once per active business
 * (`runtime/scheduler.ts`, through `visitActiveWorkspaces`). No env
 * flag gates it.
 *
 * Idempotent: keyed by (userId='__builtin', name), so a re-run updates
 * existing rows in place — a changed payload reaches the rows already
 * in the database at the next scheduler start. Dropping a template
 * from BUILTIN_TEMPLATES does NOT remove its row: name it in
 * RETIRED_BUILTIN_TEMPLATES, and the seeder deletes the built-in row
 * (only that row — an operator's copy, a schedule that names it and
 * the job history stay).
 */

import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import type { ParameterDecl } from './bulk-action-template.service.js'
import { ROUND_DOWN_TO_99 } from './bulk-action/price-rounding.js'

interface SeedTemplate {
  name: string
  description: string
  actionType: string
  channel?: string | null
  actionPayload: Record<string, unknown>
  defaultFilters?: Record<string, unknown> | null
  parameters?: ParameterDecl[]
  category: string
}

export const BUILTIN_TEMPLATES: SeedTemplate[] = [
  // ── Pricing ──────────────────────────────────────────────────────
  {
    name: 'Spring sale — N% off',
    description:
      'Apply a percentage discount to active SKUs. Tweak the percentage at apply time.',
    actionType: 'PRICING_UPDATE',
    actionPayload: {
      adjustmentType: 'PERCENT',
      value: '${pct}',
    },
    parameters: [
      {
        name: 'pct',
        label: 'Discount % (negative = decrease)',
        type: 'number',
        defaultValue: -10,
        required: true,
        min: -90,
        max: 90,
        helpText: 'Negative reduces the price (e.g., -10 = 10% off).',
      },
    ],
    category: 'pricing',
    defaultFilters: { status: 'ACTIVE' },
  },
  {
    name: 'Round prices to .99',
    description:
      'Lower each price to the nearest price ending in .99 at or below it (psychological pricing): 25.40 becomes 24.99, 25.00 becomes 24.99. A price that already ends in .99, or is below 0.99, is skipped.',
    actionType: 'PRICING_UPDATE',
    actionPayload: {
      // No value: each price is rounded from itself (bulk-action/price-rounding.ts).
      adjustmentType: ROUND_DOWN_TO_99,
    },
    category: 'pricing',
  },
  {
    name: 'Flat €N markup',
    description:
      'Add a fixed amount to every price in scope. Use the negative sign to discount.',
    actionType: 'PRICING_UPDATE',
    actionPayload: {
      adjustmentType: 'DELTA',
      value: '${delta}',
    },
    parameters: [
      {
        name: 'delta',
        label: 'Amount to add (€, negative discounts)',
        type: 'number',
        defaultValue: 5,
        required: true,
      },
    ],
    category: 'pricing',
  },
  // ── Inventory ────────────────────────────────────────────────────
  {
    name: 'Reset stock to N',
    description:
      'Set every selected SKU\'s stock to a single value. Useful for seeded inventory imports.',
    actionType: 'INVENTORY_UPDATE',
    actionPayload: {
      adjustmentType: 'ABSOLUTE',
      value: '${qty}',
    },
    parameters: [
      {
        name: 'qty',
        label: 'New stock quantity',
        type: 'number',
        defaultValue: 0,
        required: true,
        min: 0,
      },
    ],
    category: 'inventory',
  },
  {
    name: 'Adjust stock by ±N',
    description:
      'Shift stock by a delta — positive adds, negative removes. Audit-logged as a stock movement.',
    actionType: 'INVENTORY_UPDATE',
    actionPayload: {
      adjustmentType: 'DELTA',
      value: '${delta}',
    },
    parameters: [
      {
        name: 'delta',
        label: 'Quantity change (positive adds)',
        type: 'number',
        defaultValue: 0,
        required: true,
      },
    ],
    category: 'inventory',
  },
  // ── Status ───────────────────────────────────────────────────────
  {
    name: 'End-of-life — set INACTIVE',
    description:
      'Mark every selected product INACTIVE (hides from channels via the master cascade).',
    actionType: 'STATUS_UPDATE',
    actionPayload: {
      status: 'INACTIVE',
    },
    category: 'status',
  },
  {
    name: 'Move to DRAFT (review queue)',
    description:
      'Pull selected products back to DRAFT for re-review. The cascade unlists them from channels.',
    actionType: 'STATUS_UPDATE',
    actionPayload: {
      status: 'DRAFT',
    },
    category: 'status',
  },
  {
    name: 'Republish — set ACTIVE',
    description:
      'Promote DRAFT / INACTIVE products back to ACTIVE. Per-channel followMaster flags decide whether the listing relists.',
    actionType: 'STATUS_UPDATE',
    actionPayload: {
      status: 'ACTIVE',
    },
    category: 'status',
  },
  // ── Channel sync / publish ──────────────────────────────────────
  {
    name: 'Resync prices to all channels',
    description:
      'Push current master prices to every active ChannelListing. Use after a bulk pricing update if some channel pushes failed.',
    actionType: 'LISTING_SYNC',
    actionPayload: {
      syncType: 'PRICE_UPDATE',
      channels: [],
    },
    category: 'channel',
  },
  {
    name: 'Resync inventory to all channels',
    description:
      'Push current stock levels to every active ChannelListing. Defensive after a stock-take or supplier import.',
    actionType: 'LISTING_SYNC',
    actionPayload: {
      syncType: 'QUANTITY_UPDATE',
      channels: [],
    },
    category: 'channel',
  },
  {
    name: 'Full resync (all fields, all channels)',
    description:
      'Push every master field to every channel. Heavy — use sparingly, e.g. after a catalogue migration.',
    actionType: 'LISTING_SYNC',
    actionPayload: {
      syncType: 'FULL_SYNC',
      channels: [],
    },
    category: 'channel',
  },
]

/**
 * Built-ins taken out of the list. The seeder deletes the built-in row of each (matched on name AND action type),
 * in every business it seeds; a name here must never be in BUILTIN_TEMPLATES too.
 *
 * - 'Pause listings (Amazon DE)' (2026-10-01): it set `isPublished=false` on every Amazon listing (it never had a DE
 *   scope), so Nexus skipped every push while the offer stayed live on Amazon. Its payload has been refused since
 *   #206; the real per-market close is Sync Control's "Close offer".
 */
export const RETIRED_BUILTIN_TEMPLATES: ReadonlyArray<{ name: string; actionType: string }> = [
  { name: 'Pause listings (Amazon DE)', actionType: 'MARKETPLACE_OVERRIDE_UPDATE' },
]

const SEED_USER_ID = '__builtin'

/**
 * Seed / refresh the built-in templates. Idempotent — keyed by
 * (userId='__builtin', name). Updates in place when the seed list
 * changes (e.g., we tighten a parameter's bounds in a follow-up).
 * First deletes the retired built-ins (`retired` = rows deleted;
 * 0 once they are gone).
 */
export async function seedBulkActionTemplates(
  prisma: PrismaClient,
): Promise<{ created: number; updated: number; retired: number }> {
  // Only the seeder's own rows: an operator's copy is isBuiltin=false and has its own userId.
  const { count: retired } = await prisma.bulkActionTemplate.deleteMany({
    where: {
      userId: SEED_USER_ID,
      isBuiltin: true,
      OR: RETIRED_BUILTIN_TEMPLATES.map((r) => ({ name: r.name, actionType: r.actionType })),
    },
  })
  let created = 0
  let updated = 0
  for (const t of BUILTIN_TEMPLATES) {
    const existing = await prisma.bulkActionTemplate.findFirst({
      where: { userId: SEED_USER_ID, name: t.name },
    })
    if (existing) {
      await prisma.bulkActionTemplate.update({
        where: { id: existing.id },
        data: {
          description: t.description,
          actionType: t.actionType,
          channel: t.channel ?? null,
          actionPayload: t.actionPayload as never,
          defaultFilters: (t.defaultFilters ?? null) as never,
          parameters: (t.parameters ?? []) as never,
          category: t.category,
          isBuiltin: true,
        },
      })
      updated++
    } else {
      await prisma.bulkActionTemplate.create({
        data: {
          name: t.name,
          description: t.description,
          actionType: t.actionType,
          channel: t.channel ?? null,
          actionPayload: t.actionPayload as never,
          defaultFilters: (t.defaultFilters ?? null) as never,
          parameters: (t.parameters ?? []) as never,
          category: t.category,
          userId: SEED_USER_ID,
          isBuiltin: true,
          createdBy: 'seed',
        },
      })
      created++
    }
  }
  logger.info(
    `[bulk-action-template seeds] applied — created=${created} updated=${updated} retired=${retired}`,
  )
  return { created, updated, retired }
}
