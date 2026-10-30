import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BUCKET_KINDS } from '@nexus/factory-domain/planning/settings/buckets'
import { ITEM_PLANNING_LIMITS, ITEM_PLANNING_METHODS, ITEM_PLANNING_SOURCES } from '@nexus/factory-domain/planning/settings/items'
import { SETTINGS_LIMITS } from '@nexus/factory-domain/planning/settings/settings'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Planning settings (B-W2a-16; PLN-003, PLN-005, PLN-014, PLN-099; design planning.settings, SCR-124, SCR-127): a site's
 * horizon and buckets, default efficiency and nightly run time; how the site plans each item and colour (and its
 * reorder rules); the planned efficiency and people of its lines and work centres. Quantities are decimal strings in
 * the item's base unit; percents decimal strings with two decimals; days whole numbers. Nothing here carries money or
 * names a person. Every write carries the version it read (none for a row not made yet).
 */

const version = z.number().int().min(1)
const named = output({ id: id(), code: z.string(), name: z.string() })
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')
const percent = () => z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Expected a percent with at most two decimals (85 or 92.5).')
const decimalText = () => z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Expected a quantity with at most 14 digits before and 4 after the dot.')
const days = () => z.number().int().min(ITEM_PLANNING_LIMITS.days.min).max(ITEM_PLANNING_LIMITS.days.max)
const note = () => z.string().trim().max(ITEM_PLANNING_LIMITS.note)

const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string(), kind: z.string(), timeZone: z.string() })

// ---- the site's settings (PLN-003) ------------------------------------------------------------------------------------

export const settingsView = output({
  horizonWeeks: z.number().int(),
  dayBucketWeeks: z.number().int(),
  weekBucketWeeks: z.number().int(),
  defaultEfficiencyPct: z.string(),
  scheduledRunTime: z.string().nullable(),
  /** No row yet: the defaults (26 / 2 / 13 weeks, 100 %, runs on demand). */
  isDefault: z.boolean(),
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
})
export type SettingsView = z.infer<typeof settingsView>

const bucketView = output({ key: z.string(), kind: z.enum(BUCKET_KINDS), from: businessDate(), to: businessDate() })
export type BucketView = z.infer<typeof bucketView>

export const listSettingsContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ sites: z.array(output({ site: siteView, settings: settingsView })) }) },
})

const siteSettings = output({
  site: siteView,
  settings: settingsView,
  /** The plan's buckets from today (the site's day): days, weeks, then months to the horizon. */
  horizon: output({ from: businessDate(), to: businessDate(), buckets: z.array(bucketView) }),
})

export const getSettingsContract = defineContract({
  params: input({ siteId: id() }),
  response: { 200: siteSettings },
})

export const editSettingsContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    version: version.optional(),
    horizonWeeks: z.number().int().min(SETTINGS_LIMITS.horizonWeeks.min).max(SETTINGS_LIMITS.horizonWeeks.max).optional(),
    dayBucketWeeks: z.number().int().min(0).max(SETTINGS_LIMITS.horizonWeeks.max).optional(),
    weekBucketWeeks: z.number().int().min(0).max(SETTINGS_LIMITS.horizonWeeks.max).optional(),
    defaultEfficiencyPct: percent().optional(),
    /** HH:MM; null: runs on demand only. */
    scheduledRunTime: z.string().trim().nullable().optional(),
  }),
  response: { 200: output({ ...siteSettings.shape, changed: z.array(z.string()) }) },
})
export type EditSettingsBody = z.infer<typeof editSettingsContract.body>

// ---- item parameters (PLN-005) and reorder rules (PLN-099) ------------------------------------------------------------

const quantities = {
  safetyStock: decimalText().nullable(),
  reorderPoint: decimalText().nullable(),
  lotSize: decimalText().nullable(),
  minStock: decimalText().nullable(),
  maxStock: decimalText().nullable(),
  minOrderQty: decimalText().nullable(),
  orderMultiple: decimalText().nullable(),
  maxOrderQty: decimalText().nullable(),
}

export const itemParametersView = output({
  id: id(),
  siteId: id(),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
  /** The colour it is for; null: every colour of the item. */
  colour: named.nullable(),
  method: z.enum(ITEM_PLANNING_METHODS),
  /** null: the item's own sourcing. */
  source: z.enum(ITEM_PLANNING_SOURCES).nullable(),
  supplier: named.nullable(),
  makeSite: named.nullable(),
  buyLeadTimeDays: z.number().int().nullable(),
  makeLeadTimeDays: z.number().int().nullable(),
  safetyLeadTimeDays: z.number().int().nullable(),
  ...Object.fromEntries(Object.keys(quantities).map((key) => [key, z.string().nullable()])) as { [Key in keyof typeof quantities]: z.ZodNullable<z.ZodString> },
  note: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type ItemParametersView = z.infer<typeof itemParametersView>

const itemDefaults = output({
  /** The item's own sourcing. */
  sourcing: z.string(),
  supplier: named.nullable(),
  /** The item's terms as stored (its default supplier's): lead days; minimum and step in its PURCHASE unit. */
  leadTimeDays: z.number().int().nullable(),
  purchaseUom: z.enum(UOMS),
  minOrderQty: z.string().nullable(),
  orderMultiple: z.string().nullable(),
})

export const listItemParametersContract = defineContract({
  querystring: input({
    siteId: id(),
    /** Code or name. */
    q: z.string().trim().min(1).max(80).optional(),
    kind: z.enum([...ITEM_KINDS, 'FINISHED']).optional(),
    /** Items with a row of this method at the site. */
    method: z.enum(ITEM_PLANNING_METHODS).optional(),
    /** true: items with parameters at the site; false: items planned by their defaults only. */
    configured: flag().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      site: siteView,
      items: z.array(
        output({
          item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.string(), baseUom: z.enum(UOMS), colours: z.array(named) }),
          defaults: itemDefaults,
          /** The site's rows for the item: the one for every colour first, then per colour. */
          parameters: z.array(itemParametersView),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const getItemParametersContract = defineContract({
  params: input({ itemPlanningId: id() }),
  response: { 200: output({ parameters: itemParametersView, defaults: itemDefaults }) },
})

const writable = {
  method: z.enum(ITEM_PLANNING_METHODS),
  source: z.enum(ITEM_PLANNING_SOURCES).nullable(),
  supplierId: id().nullable(),
  makeSiteId: id().nullable(),
  buyLeadTimeDays: days().nullable(),
  makeLeadTimeDays: days().nullable(),
  safetyLeadTimeDays: days().nullable(),
  ...quantities,
  note: note().nullable(),
}

const partial = <Shape extends Record<string, z.ZodType>>(shape: Shape) =>
  Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.optional()])) as { [Key in keyof Shape]: z.ZodOptional<Shape[Key]> }

const writeAnswer = output({
  parameters: itemParametersView,
  /** Fields the change cleared because the method or source changed. */
  cleared: z.array(z.string()),
})

export const createItemParametersContract = defineContract({
  body: input({ siteId: id(), itemId: id(), itemColourId: id().nullable().optional(), ...partial(writable) }),
  response: { 201: writeAnswer },
})
export type CreateItemParametersBody = z.infer<typeof createItemParametersContract.body>

export const editItemParametersContract = defineContract({
  params: input({ itemPlanningId: id() }),
  body: input({ version, ...partial(writable) }),
  response: { 200: writeAnswer },
})
export type EditItemParametersBody = z.infer<typeof editItemParametersContract.body>

export const deleteItemParametersContract = defineContract({
  params: input({ itemPlanningId: id() }),
  body: input({ version }),
  response: { 200: output({ deleted: id(), siteId: id(), itemId: id() }) },
})

export const reorderRulesContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      /** Rows planned by a reorder point or min/max at the site, by item code: the warehouse is the site. */
      rules: z.array(itemParametersView),
    }),
  },
})

// ---- lanes: line efficiency and people (PLN-014), work-centre units (PLN-115) ------------------------------------------

const effective = output({
  efficiencyPct: z.string(),
  /** LANE: the lane's own; SITE: the site's default efficiency; DEFAULT: 100 % (no settings). */
  efficiencySource: z.enum(['LANE', 'SITE', 'DEFAULT']),
  /** People per shift (a line) or units at once (a work centre). */
  people: z.number().int(),
  /** CAPACITY: as planned on the lane; STATIONS: its active stations. */
  peopleSource: z.enum(['CAPACITY', 'STATIONS']),
})

const capacityRow = output({ plannedEfficiencyPct: z.string(), people: z.number().int().nullable(), note: z.string().nullable(), version: z.number().int(), updatedAt: instant() })

const actualWeek = output({
  week: z.string(),
  from: businessDate(),
  to: businessDate(),
  /** Standard minutes of the good whole garments the line's stations reported that week. */
  earnedMinutes: z.string(),
  /** People × the line's working minutes (at 100 %). */
  availableMinutes: z.string(),
  /** earned / available; null when nothing was available. */
  pct: z.string().nullable(),
})

export const laneView = output({
  kind: z.enum(['LINE', 'WORK_CENTRE']),
  id: id(),
  code: z.string(),
  name: z.string(),
  /** A work centre's kind (CUTTING, SEWING …); null for a line. */
  workCentreKind: z.string().nullable(),
  /** Its active stations. */
  stations: z.number().int(),
  capacity: capacityRow.nullable(),
  effective,
  /** A line's actual efficiency in the last four whole weeks (oldest first); null for a work centre. */
  actual: z.array(actualWeek).nullable(),
})
export type LaneView = z.infer<typeof laneView>

export const lanesContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      defaultEfficiencyPct: z.string(),
      defaultEfficiencySource: z.enum(['SITE', 'DEFAULT']),
      lines: z.array(laneView),
      workCentres: z.array(laneView),
    }),
  },
})

const laneBody = {
  version: version.optional(),
  plannedEfficiencyPct: percent().optional(),
  note: note().nullable().optional(),
}

export const editLineCapacityContract = defineContract({
  params: input({ lineId: id() }),
  /** operators: people per shift (a headcount, never who); null: one per active station. */
  body: input({ ...laneBody, operators: z.number().int().min(1).max(500).nullable().optional() }),
  response: { 200: output({ lane: laneView, changed: z.array(z.string()) }) },
})
export type EditLineCapacityBody = z.infer<typeof editLineCapacityContract.body>

export const editWorkCentreCapacityContract = defineContract({
  params: input({ workCentreId: id() }),
  /** units: stations (or people) at once; null: its active stations. */
  body: input({ ...laneBody, units: z.number().int().min(1).max(500).nullable().optional() }),
  response: { 200: output({ lane: laneView, changed: z.array(z.string()) }) },
})
export type EditWorkCentreCapacityBody = z.infer<typeof editWorkCentreCapacityContract.body>
