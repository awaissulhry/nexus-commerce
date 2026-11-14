import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { OPTION_EFFECT_KINDS } from '../../product/options/rules'
import { REVISION_STATUSES } from '../../product/styles/revisions'
import { PART_SOURCES } from './rules'

/**
 * The contracts of an option's own cost (B-W2b-423; FIN-018, KS4:01; design products.options › Price & BOM effects "Cost
 * delta (cost)"): the cost each offered value adds to one garment of a style (per size, against the garment without
 * options), the library's view of a group's values (what can be costed without a style), and a value's typed material and
 * minutes delta. Every cost is money.cost (dropped without the cost grain); minutes, sources and words stay.
 */

const words = () => output({ it: z.string(), en: z.string() })

export const styleOptionCostsQuery = input({
  /** The company costed: the style's own; for a tenant-wide style, required. */
  companyId: id().optional(),
  /** The colourway costed (left out: the style's first active colourway). */
  colourwayId: id().optional(),
  /** The revision (left out: the released one, else the newest draft). */
  revisionId: id().optional(),
})
export type StyleOptionCostsQuery = z.output<typeof styleOptionCostsQuery>

export const optionSizeCostView = output({
  size: z.string(),
  material: money.cost(z.string().nullable()),
  making: money.cost(z.string().nullable()),
  /** What the option adds to one garment of the size (below 0: it takes cost off); null: not known. */
  total: money.cost(z.string().nullable()),
})

export const optionCostView = output({
  valueId: id(),
  groupId: id(),
  groupCode: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  material: output({ source: z.enum(PART_SOURCES), typed: money.cost(z.string().nullable()), currency: z.string().nullable() }),
  making: output({ source: z.enum(PART_SOURCES), minutesTyped: z.string().nullable(), garmentMinutes: z.string() }),
  bySize: z.array(optionSizeCostView),
  /** At the style's base size (the Effects tab's one figure). */
  atBaseSize: money.cost(z.string().nullable()),
  complete: z.boolean(),
  missing: z.array(z.string()),
})

export const styleOptionCostsView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), baseSize: z.string().nullable() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
  companyId: id(),
  currency: z.string(),
  on: businessDate(),
  colourway: output({ id: id(), code: z.string(), name: z.string() }),
  sizes: z.array(z.string()),
  values: z.array(optionCostView),
  words: words(),
  computedAt: instant(),
})
export type StyleOptionCostsView = z.infer<typeof styleOptionCostsView>

// ---- the library's view of a group -----------------------------------------------------------------------------------------

export const groupCostsQuery = input({
  /** Whose labour rates and currency price the operations (left out: the group's company; a tenant-wide group: every company's). */
  companyId: id().optional(),
})
export type GroupCostsQuery = z.output<typeof groupCostsQuery>

export const effectCostView = output({
  effectId: id(),
  kind: z.enum(OPTION_EFFECT_KINDS),
  /** Its cost per garment where it can be known without a style; null: it depends on the style (see `onStyle`). */
  amount: money.cost(z.string().nullable()),
  minutes: z.string().nullable(),
  onStyle: z.boolean(),
  words: words(),
})

export const groupValueCostView = output({
  valueId: id(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  typed: output({ materialDelta: money.cost(z.string().nullable()), materialDeltaCurrency: z.string().nullable(), minutesDelta: z.string().nullable() }),
  effects: z.array(effectCostView),
  /** What can be costed here: the typed material delta, else the materials added; the operations and minutes at an operation. */
  known: money.cost(z.string().nullable()),
  /** A part is costed only on a style (replaced or removed lines, minutes on the garment, the typed minutes). */
  dependsOnStyle: z.boolean(),
  words: words(),
})

export const groupCostsView = output({
  group: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable() }),
  companyId: id().nullable(),
  currency: z.string(),
  on: businessDate(),
  values: z.array(groupValueCostView),
})
export type GroupCostsView = z.infer<typeof groupCostsView>

// ---- a value's typed delta ---------------------------------------------------------------------------------------------------

export const setValueDeltaBody = input({
  /** The value's version (its effects, price and cost are its parts). */
  version: z.number().int().min(1),
  /** What choosing it adds (above 0) or takes off (below 0) a garment's material cost; null: none. */
  materialDelta: money.cost(z.string().nullable()),
  materialDeltaCurrency: z.string().nullable(),
  /** The standard minutes it adds or takes off; null: none. */
  minutesDelta: z.string().nullable(),
})
export type SetValueDeltaBody = z.output<typeof setValueDeltaBody>

export const valueDeltaView = output({
  value: output({
    id: id(),
    groupId: id(),
    code: z.string(),
    version: z.number().int(),
    materialDelta: money.cost(z.string().nullable()),
    materialDeltaCurrency: z.string().nullable(),
    minutesDelta: z.string().nullable(),
  }),
})
export type ValueDeltaView = z.infer<typeof valueDeltaView>
