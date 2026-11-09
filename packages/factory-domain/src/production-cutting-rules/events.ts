import { z } from 'zod'
import { defineEvent } from '../events/define'
import { AREA_UOMS } from '../inventory/hides/area'
import { SHADE_RULES } from '../inventory/reservations/shade'
import { CUTTING_RULE_FIELDS } from '../production/settings/cutting-rules'

/**
 * The cutting follow-ups' settings (B-W2b-219): apps/factory-api's modules/production/settings/cutting-rules (a site's cutting
 * rules) and modules/inventory/hides/tolerance (a company's, or every company's, leather area tolerance) emit them in the
 * command that makes the change. In a module folder of its own (as production-cutissue).
 *
 *   production.cutting_rules_changed                 a site's shade rule, photo before cutting or smallest remnant changed
 *   purchasing_settings.leather_tolerance_changed    the area tolerance for leather lots whose order line names none changed
 *
 * They reach Floor rules & codes (production.settings.view; the site's tablets: floor.work, the cutting table reads the rule)
 * and the screens of purchasing settings (purchasing.view). Ids, rules and numbers only: no person, no reason text.
 */

export const events = [
  defineEvent({
    type: 'production.cutting_rules_changed',
    context: 'production-cutting-rules',
    description: "A site's cutting rules changed: the shade rule (one shade lot per order, per garment or none), the photo of the hide before cutting, or the smallest remnant kept.",
    payload: z.strictObject({
      siteId: z.uuid(),
      fields: z.array(z.enum(CUTTING_RULE_FIELDS)).min(1),
      shadeRule: z.enum(SHADE_RULES),
      hidePhotoRequired: z.boolean(),
      minimumRemnantArea: z.string(),
      minimumRemnantUom: z.enum(AREA_UOMS),
    }),
    live: { permission: 'production.settings.view', floor: 'floor.work', fields: ['siteId', 'fields'] },
  }),
  defineEvent({
    type: 'purchasing_settings.leather_tolerance_changed',
    context: 'production-cutting-rules',
    description: "A company's (or every company's) area tolerance for leather lots whose purchase order line names none changed: the incoming area check and the re-measure read it from now on.",
    payload: z.strictObject({ settingsId: z.uuid(), companyId: z.uuid().nullable(), leatherAreaTolerancePct: z.string().nullable() }),
    live: { permission: 'purchasing.view', fields: ['settingsId', 'companyId', 'leatherAreaTolerancePct'] },
  }),
] as const
