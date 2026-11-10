import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { EDIT_RULES, RULE_SOURCES, STYLE_LIFECYCLES } from '../lifecycle/rules'
import { ITEM_KINDS } from '../materials/rules'
import { CONSUMPTION_TOLERANCES } from './rules'

/**
 * The product settings' contracts (B-W2b-221; PRD-105, PRD-182; design products.settings psettings.lifecycle and
 * psettings.tolerance): what apps/factory-api's modules/product/settings accepts and answers. One row per company, and one
 * for the whole tenant (companyId null); a field the row leaves empty follows the tenant-wide row, then the default. Each
 * value is shown with what this row says (`own`) and what is in force (with its `source`). No money.
 */

const percent = () => z.string().trim().regex(/^\d{1,3}(\.\d{1,4})?$/, 'A percent above 0 and at most 100, at most four decimals.')

export const settingsQuery = input({
  /** The company's settings; left out: the tenant-wide row. */
  companyId: id().optional(),
})
export type SettingsQuery = z.output<typeof settingsQuery>

const kindTolerance = input({ rule: z.enum(CONSUMPTION_TOLERANCES), percent: percent().nullish() })

/** A change: only the parts sent change; null clears a value (it then follows the tenant-wide row, then the default). */
export const updateSettingsBody = input({
  /** null: the tenant-wide row (a grant over every company). */
  companyId: id().nullable(),
  /** The row's version; left out while the row does not exist yet. */
  version: z.number().int().min(1).optional(),
  editRules: z.partialRecord(z.enum(STYLE_LIFECYCLES), z.enum(EDIT_RULES).nullable()).optional(),
  consumptionTolerance: z.enum(CONSUMPTION_TOLERANCES).nullable().optional(),
  consumptionTolerancePct: percent().nullable().optional(),
  /** The whole per-kind map (null or {}: none). */
  consumptionToleranceByKind: z.record(z.string(), kindTolerance).nullable().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
})
export type UpdateSettingsBody = z.output<typeof updateSettingsBody>

const toleranceRule = { rule: z.enum(CONSUMPTION_TOLERANCES), percent: z.string().nullable() }

export const settingsView = output({
  /** null: the tenant-wide row. */
  companyId: id().nullable(),
  /** The row exists (else every value is inherited or the default, and the next change makes it). */
  exists: z.boolean(),
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
  /** B-W2b-239: the caller may change this row (product.settings.manage over its company; the tenant-wide row: over every company). */
  mayChange: z.boolean(),
  editRules: z.array(output({ state: z.enum(STYLE_LIFECYCLES), own: z.enum(EDIT_RULES).nullable(), rule: z.enum(EDIT_RULES), source: z.enum(RULE_SOURCES) })),
  tolerance: output({
    own: output({ rule: z.enum(CONSUMPTION_TOLERANCES).nullable(), percent: z.string().nullable() }),
    ...toleranceRule,
    source: z.enum(RULE_SOURCES),
    byKind: z.array(
      output({
        kind: z.enum(ITEM_KINDS),
        own: output(toleranceRule).nullable(),
        ...toleranceRule,
        source: z.enum(RULE_SOURCES),
        /** The value in force is a per-kind one (else the general rule). */
        byKind: z.boolean(),
      }),
    ),
  }),
})
export type SettingsView = z.infer<typeof settingsView>
