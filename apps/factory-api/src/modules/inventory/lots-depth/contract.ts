import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ATTRIBUTE_KEYS } from '@nexus/factory-domain/inventory/lots-depth/attributes'
import { LIFECYCLE_CAUSES, LOT_LIFECYCLES } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import { DOCUMENT_STATES, INCOMING_STATES, SEPARATION_STATES } from '@nexus/factory-domain/inventory/lots-depth/page'
import { SPLIT_LIMITS } from '@nexus/factory-domain/inventory/lots-depth/split'
import { TRACE_REPORT_AUDIENCES, TRACE_REPORT_FORMATS, TRACE_REPORT_LANGUAGES } from '@nexus/factory-domain/inventory/lots-depth/trace-report'
import { TRACE_DIRECTIONS, TRACE_START_KINDS } from '@nexus/factory-domain/inventory/trace/rules'
import { LOT_QUALITY_STATUSES } from '@nexus/factory-domain/inventory/stock/overview'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { lotRow } from '../stock/reads-contract'

/**
 * Lots in depth (B-W2b-313; SCM-185, SCM-236, SCM-237, SCM-238, SCM-242): the contracts of list.ts, page.ts, lifecycle.ts,
 * attributes.ts, split.ts and trace/report.ts. Quantities are decimal strings with four decimals in the item's base unit;
 * a hide's area says its unit. No money (the split values its moves at the lot's cost inside the command, never in an
 * answer); a person only inside one lot's record (who received it, who decided, who made a report).
 */

const version = z.number().int().min(1)
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback)
const lifecycle = z.enum(LOT_LIFECYCLES)
const quality = z.enum(LOT_QUALITY_STATUSES)
const named = output({ id: id(), code: z.string(), name: z.string() })
const person = output({ id: id(), name: z.string() })
const lotParams = input({ lotId: id() })
const lotRef = output({ id: id(), code: z.string(), qualityStatus: quality, lifecycle, shade: z.string().nullable() })
/** A lot's attributes: strings, and the grade mix as grade code → percent. */
const attributes = z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))

// ---- the list (lt-grid: Lifecycle column, Depleted view, attributes; lt-metrics: documents expiring) -----------------------

export const depthRow = lotRow.extend({
  lifecycle,
  parentLot: output({ id: id(), code: z.string() }).nullable(),
  /** Its child lots (shade groups split from it). */
  childLots: z.number().int(),
  attributes,
  /** Its ACTIVE documents (or its parent's, for a child) that end within 30 days or ended. */
  documentsExpiring: z.number().int(),
})
export type DepthRow = z.infer<typeof depthRow>

export const LIST_VIEWS = ['ACTIVE', 'DEPLETED', 'ALL'] as const

export const listContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    supplierId: id().optional(),
    quality: quality.optional(),
    lifecycle: lifecycle.optional(),
    /** ACTIVE (default): every lot but the depleted ones; DEPLETED: only those; ALL. A lifecycle asked wins. */
    view: z.enum(LIST_VIEWS).optional(),
    /** The child lots of this lot. */
    parentLotId: id().optional(),
    /** Only lots with a document ending within 30 days or ended (the tile). */
    documentsExpiring: flag().optional(),
    /** Attributes (SCM-185 "searchable"): the tannage exactly; finish and origin containing the words (letter case kept). */
    tannage: z.enum(['CHROME', 'VEGETABLE', 'CHROME_FREE', 'COMBINATION']).optional(),
    finish: z.string().trim().min(1).max(100).optional(),
    origin: z.string().trim().min(1).max(100).optional(),
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: limit(200, 50),
  }),
  response: {
    200: output({
      lots: z.array(depthRow),
      nextCursor: id().nullable(),
      /** The tiles, over the caller's lots at the site asked (no other filter). */
      counts: output({
        lifecycle: output(Object.fromEntries(LOT_LIFECYCLES.map((value) => [value, z.number().int()])) as Record<(typeof LOT_LIFECYCLES)[number], z.ZodNumber>),
        documentsExpiring: z.number().int(),
      }),
    }),
  },
})

// ---- the lot page's W2b facts (SCM-238) ----------------------------------------------------------------------------------

const historyRow = output({
  at: instant(),
  /** LIFECYCLE: a move of the lifecycle; QUALITY: a quality decision (release, block, reject); SPLIT: hides moved. */
  kind: z.enum(['LIFECYCLE', 'QUALITY', 'SPLIT']),
  from: lifecycle.nullable(),
  to: lifecycle.nullable(),
  cause: z.enum(LIFECYCLE_CAUSES).nullable(),
  action: z.string(),
  audience: z.string(),
  words: z.string(),
})

const documentRow = output({
  id: id(),
  kind: z.string(),
  fileId: id(),
  validTo: businessDate().nullable(),
  state: z.enum(DOCUMENT_STATES),
  /** Days to the last valid day (negative: ended that long ago); null without an end. */
  daysLeft: z.number().int().nullable(),
  /** The lot's own, or its parent's (a child lot carries the documents of the lot it was split from). */
  from: z.enum(['LOT', 'PARENT']),
})

const inspectionRow = output({ id: id(), number: z.string(), status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']), result: z.enum(['PASS', 'FAIL']).nullable(), decidedAt: instant().nullable(), from: z.enum(['LOT', 'PARENT']) })

export const lotView = output({
  lot: output({
    id: id(),
    code: z.string(),
    companyId: id(),
    siteId: id(),
    version,
    item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.string(), baseUom: z.enum(UOMS) }),
    colour: named.nullable(),
    shade: z.string().nullable(),
    qualityStatus: quality,
    lifecycle,
    onHand: z.string(),
    hidesInStock: z.number().int(),
  }),
  lifecycle: output({
    state: lifecycle,
    /** When it took this state (the newest change), else when the lot was made. */
    since: instant(),
    /** When the last unit went out, while DEPLETED. */
    depletedAt: instant().nullable(),
    /** What the ledger says it should be now (the handler moves it; a difference shows a move not yet handled). */
    expected: lifecycle,
    history: z.array(historyRow),
  }),
  attributes: output({
    kind: z.string(),
    /** The attributes a lot of this kind takes, in the form's order. */
    keys: z.array(z.enum(ATTRIBUTE_KEYS)),
    values: attributes,
    canEdit: z.boolean(),
  }),
  family: output({
    parent: lotRef.nullable(),
    children: z.array(lotRef.extend({ onHand: z.string(), hidesInStock: z.number().int() })),
  }),
  incoming: output({ state: z.enum(INCOMING_STATES), number: z.string().nullable(), words: z.string(), inspections: z.array(inspectionRow) }),
  separation: output({ state: z.enum(SEPARATION_STATES), viewerReceived: z.boolean(), words: z.string(), receivedBy: person.nullable(), decidedBy: person.nullable() }),
  documents: output({ rows: z.array(documentRow), expiring: z.number().int(), expired: z.number().int() }),
  may: output({ manage: z.boolean(), split: z.boolean(), report: z.boolean() }),
  /** Why the family cannot be split or regrouped now, in words (null: it can). */
  splitRefusal: z.string().nullable(),
})
export type LotView = z.infer<typeof lotView>

export const lotViewContract = defineContract({ params: lotParams, response: { 200: lotView } })

// ---- lifecycle and attributes --------------------------------------------------------------------------------------------

export const checkLifecycleContract = defineContract({
  params: lotParams,
  response: { 200: output({ changed: z.boolean(), from: lifecycle, to: lifecycle, lot: lotView }) },
})

export const attributesContract = defineContract({
  params: lotParams,
  /** A key with a value sets it, a key with null removes it, a key left out stays. */
  body: input({ version, attributes: z.record(z.string().max(40), z.union([z.string().max(200), z.record(z.string().max(40), z.string().max(20)), z.null()])) }),
  response: { 200: lotView },
})

// ---- split and regroup (SCM-237, LT1:01) ---------------------------------------------------------------------------------

const splitHide = output({
  id: id(),
  code: z.string(),
  supplierCode: z.string().nullable(),
  lot: output({ id: id(), code: z.string() }),
  state: z.string(),
  onHand: z.string(),
  area: z.string(),
  areaUom: z.enum(UOMS),
  location: named.nullable(),
  grade: z.string().nullable(),
  shade: z.string().nullable(),
  shadeGroupId: id().nullable(),
  marks: z.number().int(),
  /** What the incoming inspection said of it (its newest decided or open inspection that sampled it). */
  inspection: output({ number: z.string(), decision: z.string().nullable(), shadeGroupId: id().nullable(), shade: z.string().nullable() }).nullable(),
  /** Why it cannot move to another lot now, in words (null: it can). */
  refusal: z.string().nullable(),
})

const shadeChoice = output({ id: id(), label: z.string(), outOfShade: z.boolean(), lotId: id().nullable(), active: z.boolean() })
const proposedGroup = output({ shadeGroupId: id().nullable(), label: z.string(), hideIds: z.array(id()) })

export const splitReadContract = defineContract({
  params: lotParams,
  response: {
    200: output({
      /** The family: the lot that is no child (its version is the one a split or regroup sends) and every lot split from it. */
      parent: lotRef.extend({ version }),
      lots: z.array(lotRef.extend({ hidesInStock: z.number().int() })),
      hides: z.array(splitHide),
      shadeGroups: z.array(shadeChoice),
      /** The groups the newest incoming inspection of the family sorted the hides into (LT1:01): the dialog's first proposal. */
      proposal: output({ inspection: output({ id: id(), number: z.string(), status: z.string() }).nullable(), groups: z.array(proposedGroup) }),
      refusal: z.string().nullable(),
      may: z.boolean(),
    }),
  },
})

const movedHide = output({
  fromHideId: id(),
  fromCode: z.string(),
  hideId: id(),
  /** The new tag to print (the old one holds nothing now). */
  code: z.string(),
  lot: output({ id: id(), code: z.string() }),
  area: z.string(),
  areaUom: z.enum(UOMS),
  grade: z.string().nullable(),
  shade: z.string().nullable(),
  marks: z.number().int(),
})

const splitAnswer = output({
  parent: output({ id: id(), code: z.string(), version }),
  lots: z.array(lotRef.extend({ made: z.boolean() })),
  hides: z.array(movedHide),
})

export const splitContract = defineContract({
  params: lotParams,
  body: input({
    /** The family parent's version (the split read's `parent.version`). */
    version,
    groups: z
      .array(input({ shadeGroupId: id().nullable().optional(), label: z.string().max(SPLIT_LIMITS.label * 2).nullable().optional(), hideIds: z.array(id()).max(SPLIT_LIMITS.hides) }))
      .max(SPLIT_LIMITS.groups * 2),
    /** The incoming inspection the groups come from (LT1:01), recorded with the split. */
    inspectionId: id().nullable().optional(),
    note: z.string().max(SPLIT_LIMITS.note * 2).nullable().optional(),
  }),
  response: { 201: splitAnswer },
})

export const regroupContract = defineContract({
  params: lotParams,
  body: input({
    version,
    /** Each hide of the family into another lot of the family (a child, or back to the parent). */
    moves: z.array(input({ hideId: id(), toLotId: id() })).min(1).max(SPLIT_LIMITS.hides),
    note: z.string().max(SPLIT_LIMITS.note * 2).nullable().optional(),
  }),
  response: { 200: splitAnswer },
})

// ---- the dated trace report (SCM-242; trace/report.ts) -------------------------------------------------------------------

export const traceReportContract = defineContract({
  body: input({
    kind: z.enum(TRACE_START_KINDS),
    id: id(),
    direction: z.enum(TRACE_DIRECTIONS).default('BOTH'),
    audience: z.enum(TRACE_REPORT_AUDIENCES),
    recipient: z.string().max(400),
    reference: z.string().max(200).nullable().optional(),
    requestedOn: businessDate(),
    asOf: businessDate().nullable().optional(),
    format: z.enum(TRACE_REPORT_FORMATS).default('PDF'),
    language: z.enum(TRACE_REPORT_LANGUAGES).default('it'),
    note: z.string().max(2000).nullable().optional(),
  }),
  response: {
    201: output({
      report: output({
        recordType: z.string(),
        recordId: id(),
        start: output({ kind: z.enum(TRACE_START_KINDS), id: id(), code: z.string() }),
        madeAt: instant(),
        asOf: businessDate(),
        format: z.enum(TRACE_REPORT_FORMATS),
        /** The lots split from the start (or the hides it became) whose trace is in the report too. */
        includes: z.array(output({ kind: z.enum(TRACE_START_KINDS), id: id(), code: z.string() })),
        counts: output({ nodes: z.number().int(), customersExact: z.number().int(), customersPossible: z.number().int(), customersByAsOfExact: z.number().int(), customersByAsOfPossible: z.number().int(), gaps: z.number().int() }),
      }),
      /** The stored file: open it in a new tab with the files route (GET /files/:fileId/download). */
      file: output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int() }),
    }),
  },
})

export const traceReportsContract = defineContract({
  querystring: input({ kind: z.enum(TRACE_START_KINDS), id: id() }),
  response: {
    200: output({
      reports: z.array(
        output({
          at: instant(),
          madeBy: person.nullable(),
          fileId: id().nullable(),
          audience: z.enum(TRACE_REPORT_AUDIENCES),
          recipient: z.string(),
          reference: z.string().nullable(),
          requestedOn: businessDate(),
          asOf: businessDate(),
          direction: z.enum(TRACE_DIRECTIONS),
          format: z.enum(TRACE_REPORT_FORMATS),
        }),
      ),
    }),
  },
})
