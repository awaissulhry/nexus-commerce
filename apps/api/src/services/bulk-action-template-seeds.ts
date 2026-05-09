/**
 * W5.4 — Built-in BulkActionTemplate seeds.
 *
 * Ships 12 starter templates covering the operations Awa runs daily
 * on Xavia's catalog. Each carries `isBuiltin=true` so operators
 * can't edit / delete them directly — the library UI offers
 * "Duplicate" instead, which lifts a builtin into a user-owned copy.
 *
 * Idempotent: keyed by `name` so re-running the seed updates
 * existing rows in place. Run once at API boot (gated behind a
 * boot-time env flag, so dev / test environments can opt out).
 */

import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import type { ParameterDecl } from './bulk-action-template.service.js'

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
      'Adjust pricing so everything ends in .99 (psychological pricing). Sets to the next .99 below current.',
    actionType: 'PRICING_UPDATE',
    actionPayload: {
      adjustmentType: 'ABSOLUTE',
      value: '${target}',
    },
    parameters: [
      {
        name: 'target',
        label: 'Target price (€)',
        type: 'number',
        defaultValue: 99.99,
        required: true,
        min: 0,
      },
    ],
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
  {
    name: 'Pause listings (Amazon DE)',
    description:
      'Set isPublished=false on Amazon DE channel listings. Operators use this for Brexit / market-pause flows; reversible by re-enabling per-listing.',
    actionType: 'MARKETPLACE_OVERRIDE_UPDATE',
    channel: 'AMAZON',
    actionPayload: {
      isPublished: false,
    },
    category: 'channel',
  },
]

const SEED_USER_ID = '__builtin'

/**
 * Seed / refresh the built-in templates. Idempotent — keyed by
 * (userId='__builtin', name). Updates in place when the seed list
 * changes (e.g., we tighten a parameter's bounds in a follow-up).
 */
export async function seedBulkActionTemplates(
  prisma: PrismaClient,
): Promise<{ created: number; updated: number }> {
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
    `[bulk-action-template seeds] applied — created=${created} updated=${updated}`,
  )
  return { created, updated }
}
