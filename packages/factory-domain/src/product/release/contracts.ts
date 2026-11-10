import { z } from 'zod'
import { businessDate, id, input, output } from '../../core/contracts'
import { BOM_CHECK_COLUMNS, BOM_CHECK_SEVERITIES } from '../bom-structure/check'
import { MASTER_STATUSES } from '../sizes/rules'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { GATE_FINDING_CODES, GATE_FIXES, GATE_ITEMS, GATE_STATES } from './gate'
import { SCOPE_LIMIT } from './scope'

/**
 * The release gate's contracts (B-W2b-231; PRD-190, PRD-191, PRD-197, PRD-232; design products.styles `styles.release`
 * "Release revision N": the GateChecklist with "Fix" per item, "Release only some colourways or sizes", "What happens, in
 * words"; the styles list's completeness column and the side panel's compact check): what apps/factory-api's
 * modules/product/release accepts and answers. No money (a material's standard cost is only said to exist or not). The
 * completeness score is a decimal string ("87.5"). Every write sends the revision's `version` (COL-078).
 */

const version = () => z.number().int().min(1)

/** Comma-separated ids or size codes in a query string ("a,b"); empty: none. */
const list = (max: number) =>
  z
    .string()
    .max(8000)
    .transform((value) => [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))])
    .refine((values) => values.length <= max, { message: `At most ${max}.` })

/**
 * The gate of one revision. A draft: for the scope asked (`colourwayIds`, `sizes`: a preview of "Release only some colourways
 * or sizes"; left out: the scope planned on the draft). A released revision: the cells a later release would add (left out:
 * as released). Empty = all.
 */
export const gateQuery = input({
  colourwayIds: list(SCOPE_LIMIT)
    .refine((values) => values.every((value) => z.uuid().safeParse(value).success), { message: 'Colourways are ids.' })
    .optional(),
  sizes: list(SCOPE_LIMIT).optional(),
})
export type GateQuery = z.output<typeof gateQuery>

/**
 * What the revision is released for (PRD-191). On a DRAFT: planned (the release takes it as it is). On a RELEASED revision:
 * a later release of the same revision that adds colourways or sizes (never takes one out). Empty = every one.
 */
export const setScopeBody = input({
  version: version(),
  colourwayIds: z.array(id()).max(SCOPE_LIMIT),
  sizes: z.array(z.string().trim().min(1).max(40)).max(SCOPE_LIMIT),
})
export type SetScopeBody = z.output<typeof setScopeBody>

/** The styles list's completeness column and the side panel (at most 25 styles per call). */
export const summaryQuery = input({
  styleIds: list(25).refine((values) => values.length > 0 && values.every((value) => z.uuid().safeParse(value).success), { message: 'One to 25 style ids.' }),
})
export type SummaryQuery = z.output<typeof summaryQuery>

// ---- answers ------------------------------------------------------------------------------------------------------------------

const revisionRef = output({ id: id(), styleId: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES), version: z.number().int() })
const styleRef = output({ id: id(), code: z.string(), name: z.string(), status: z.enum(STYLE_STATUSES), companyId: id().nullable() })

export const scopeView = output({
  colourwayIds: z.array(id()),
  sizes: z.array(z.string()),
  /** Every colourway and every size. */
  whole: z.boolean(),
  /** "BLK, RED in 50–54" / "every colourway and size". */
  words: z.string(),
})

export const gateFindingView = output({
  code: z.enum(GATE_FINDING_CODES),
  severity: z.enum(BOM_CHECK_SEVERITIES),
  message: z.string(),
  /** Where "Show me" lands: a BOM line and its column, a size, a colourway, a routing step, a record or a style field. */
  cell: output({
    lineId: id().nullable(),
    column: z.enum(BOM_CHECK_COLUMNS).nullable(),
    size: z.string().nullable(),
    colourwayId: id().nullable(),
    alternateId: id().nullable(),
    stepId: id().nullable(),
    recordId: id().nullable(),
    field: z.string().nullable(),
  }),
})

export const gateItemView = output({
  code: z.enum(GATE_ITEMS),
  state: z.enum(GATE_STATES),
  /** It counts in the completeness score when it applies (SCOPE and DRIFT never do). */
  scored: z.boolean(),
  /** Where its "Fix" goes. */
  fix: z.enum(GATE_FIXES),
  message: z.string(),
  findings: z.array(gateFindingView),
})

/**
 * THE release gate of a revision. A draft is checked (`checked`): every item, the completeness score of the list, whether the
 * release would pass (`releasable`) and the first blocking reason (`heldBy`). A released revision is frozen: only what it is
 * released for and the certificate coverage of the cells asked, with the score stored at its release.
 */
export const gateView = output({
  revision: revisionRef,
  style: styleRef,
  date: businessDate(),
  checked: z.boolean(),
  items: z.array(gateItemView),
  blockers: z.array(gateFindingView),
  warnings: z.array(gateFindingView),
  completenessPct: z.string().nullable(),
  releasable: z.boolean(),
  heldBy: z.string().nullable(),
  scope: output({
    /** What the revision holds now: planned on a draft, released on a frozen revision. */
    planned: scopeView,
    /** What this gate was asked about (= planned when the query names none). */
    asked: scopeView,
    /** The scope that leaves out the cells no certificate covers; null: none needed or none possible. */
    suggested: scopeView.nullable(),
    /** What waits for a later release of the revision ("RED and sizes 56–60"); null: nothing. */
    waiting: z.string().nullable(),
    colourways: z.array(output({ id: id(), code: z.string(), name: z.string(), status: z.enum(MASTER_STATUSES), planned: z.boolean(), asked: z.boolean() })),
    sizes: z.array(output({ code: z.string(), label: z.string(), planned: z.boolean(), asked: z.boolean() })),
  }),
  /** What happens, in words (the design's "Revision 4 becomes the one every new work order uses…"). */
  effects: z.array(z.string()),
  /** The reader may plan or release (product.bom.release over the style's company), and the revision may take it now. */
  mayRelease: z.boolean(),
})
export type GateView = z.infer<typeof gateView>

export const summaryRowView = output({
  styleId: id(),
  code: z.string(),
  /** The revision summed up: the newest draft (checked now), else the released one (its score at release), else none. */
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }).nullable(),
  checked: z.boolean(),
  completenessPct: z.string().nullable(),
  blockers: z.number().int(),
  warnings: z.number().int(),
  /** The first item still open ("3 things before release" with the first one linked). */
  first: output({ code: z.enum(GATE_ITEMS), state: z.enum(GATE_STATES), message: z.string(), fix: z.enum(GATE_FIXES) }).nullable(),
  /** Items still open (BLOCKED or WARNING). */
  open: z.number().int(),
})
export const summaryView = output({ date: businessDate(), styles: z.array(summaryRowView) })
export type SummaryView = z.infer<typeof summaryView>

/** What a style's current revision is released for: the readers' answer (planning, quotes, the tech pack). */
export const releasedScopeView = output({
  style: output({ id: id(), code: z.string() }),
  revision: output({ id: id(), revision: z.number().int(), completenessPct: z.string().nullable() }).nullable(),
  scope: scopeView.nullable(),
  /** The active colourways × sizes of the range it releases. */
  cells: z.array(output({ colourwayId: id(), colourway: z.string(), size: z.string() })),
  waiting: z.string().nullable(),
})
export type ReleasedScopeView = z.infer<typeof releasedScopeView>
