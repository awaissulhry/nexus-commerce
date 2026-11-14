import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { REVISION_STATUSES } from '../../product/styles/revisions'
import { componentLineView, missingComponentView, sizeSplitView } from '../sheet-components/contracts'
import { ROLLUP_PROBLEMS } from './rules'

/**
 * The contracts of the multi-level cost roll-up (B-W2b-423; FIN-019, KS4:02; design products.styles › Materials (BOM) ›
 * "Sub-assemblies" with its cost column, and the Cost tab): a revision's components with every sub-assembly line at its own
 * cost, and the tree of sub-assemblies with each one's cost per output batch. Every cost is money.cost (dropped without the
 * cost grain); the structure, sizes, batches and words stay.
 */

export const rollupQuery = input({
  /** The company costed: the style's own; for a tenant-wide style, required. */
  companyId: id().optional(),
  /** The colourway costed (left out: the style's first active colourway). */
  colourwayId: id().optional(),
  /** The site whose piece rates are read when piece-rate labour is on. */
  siteId: id().optional(),
})
export type RollupQuery = z.output<typeof rollupQuery>

export const rollupSizeView = output({
  /** The parent's size. */
  size: z.string(),
  /** The sub-assembly's size that serves it (null: none). */
  subSize: z.string().nullable(),
  /** The sub-assembly's output batches one garment of the parent takes (null: not known). */
  batches: z.string().nullable(),
  /** One output batch of the sub-assembly, all its levels included. */
  perBatch: money.cost(z.string().nullable()),
  /** What the parent's line costs per base unit of the component. */
  perBaseUnit: money.cost(z.string().nullable()),
  problem: output({ code: z.enum(ROLLUP_PROBLEMS), message: z.string() }).nullable(),
})

export const rollupNodeView = output({
  /** 2: a sub-assembly of the revision costed; 3: one of its own … */
  level: z.number().int().min(2),
  /** The BOM line that takes it (of the revision one level up). */
  lineId: id(),
  seq: z.number().int(),
  /** The sub-assembly lines above it, top first. */
  via: z.array(id()),
  item: output({ id: id(), code: z.string(), name: z.string() }),
  subAssembly: output({ styleId: id(), code: z.string(), revisionId: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
  colourway: output({ id: id(), code: z.string() }).nullable(),
  sizes: z.array(rollupSizeView),
  /** Its own split per its size (one output batch). */
  own: z.array(sizeSplitView),
})

export const rollupView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), baseSize: z.string().nullable() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
  companyId: id(),
  currency: z.string(),
  on: businessDate(),
  colourway: output({ id: id(), code: z.string(), name: z.string() }),
  sizes: z.array(z.string()),
  /** The revision's components (the garment without options), every sub-assembly line at its own cost. */
  lines: z.array(componentLineView),
  split: z.array(sizeSplitView),
  complete: z.boolean(),
  missing: z.array(missingComponentView),
  tree: z.array(rollupNodeView),
  /** The levels walked (1: no sub-assembly). */
  levels: z.number().int().min(1),
  computedAt: instant(),
})
export type RollupView = z.infer<typeof rollupView>
