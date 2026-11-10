import { z } from 'zod'
import { ARTWORK_NOTE_MAX, ARTWORK_REASON_MAX, ARTWORK_STATUSES, LINE_ACTIONS, LINE_SECTIONS, LINE_SOURCES, PACKAGING_PER, SPOIL_KINDS, SPOIL_MAX, SPOIL_REASON_MAX } from '@nexus/factory-domain/compliance/label-artwork/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'

/**
 * Label artwork, label lines and the label reconciliation: the contracts (B-W2b-259; PRD-347, PRD-088, MES-140). Codes,
 * numbers, counts and the names of the office people who made or approved a proof (inside one label's record); no price,
 * no cost, never a floor worker.
 */

const person = output({ id: id(), name: z.string() }).nullable()

// ---- artwork (PRD-347) ------------------------------------------------------------------------------------------------

const artworkVersion = output({
  id: id(),
  versionNo: z.number().int(),
  status: z.enum(ARTWORK_STATUSES),
  /** The proof: a file of the label template (null: the file is no longer readable). */
  file: output({ id: id(), name: z.string(), contentType: z.string(), status: z.string() }).nullable(),
  author: person,
  /** The person reading made it (so cannot approve it). */
  byYou: z.boolean(),
  approvedAt: instant().nullable(),
  approvedBy: person,
  retiredAt: instant().nullable(),
  note: z.string().nullable(),
  createdAt: instant(),
  version: z.number().int(),
  /** Why the reader cannot approve it now (null: they may). */
  approveHeld: z.string().nullable(),
})

export const artworkView = output({
  label: output({ id: id(), code: z.string(), revision: z.number().int(), name: z.string(), status: z.string(), kind: z.string(), companyId: id().nullable(), styleId: id().nullable() }),
  versions: z.array(artworkVersion),
  /** The version approved now (null: none: where a requirement asks for approved artwork, the label does not print). */
  approvedId: id().nullable(),
  /** The work orders released with this label revision and the artwork their labels follow (the version in force at their first print). */
  workOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), firstPrintAt: instant().nullable(), artwork: output({ id: id(), versionNo: z.number().int() }).nullable() })),
  mayManage: z.boolean(),
  mayApprove: z.boolean(),
  asOf: businessDate(),
})
export type ArtworkView = z.infer<typeof artworkView>

export const artworkReadContract = defineContract({ params: input({ templateId: id() }), response: { 200: output({ artwork: artworkView }) } })

export const artworkAddContract = defineContract({
  params: input({ templateId: id() }),
  body: input({
    /** The proof, uploaded first as a file of the label template (POST /files with recordType "LabelTemplate"). */
    fileId: id(),
    note: z.string().max(ARTWORK_NOTE_MAX).nullable().optional(),
  }),
  response: { 201: output({ artwork: artworkView }), 200: output({ artwork: artworkView }) },
})

export const artworkActContract = defineContract({
  params: input({ artworkId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().max(ARTWORK_REASON_MAX).optional() }),
  response: { 200: output({ artwork: artworkView }) },
})

export const artworkRemoveContract = defineContract({
  params: input({ artworkId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ artwork: artworkView }) },
})

// B-W2b-270: the DRAFT proofs waiting for a second person (Labels & marking's tile "Artwork waiting approval").
export const artworkWaitingView = output({
  waiting: z.array(output({ templateId: id(), artworkId: id(), versionNo: z.number().int(), byYou: z.boolean(), createdAt: instant() })),
  asOf: businessDate(),
})
export type ArtworkWaitingView = z.infer<typeof artworkWaitingView>

export const artworkWaitingContract = defineContract({ response: { 200: output({ artwork: artworkWaitingView }) } })

// ---- label lines (PRD-088) --------------------------------------------------------------------------------------------

const lineRef = output({ id: id(), seq: z.number().int(), itemId: id(), qty: z.string(), uom: z.enum(UOMS), section: z.string().nullable() })
const material = output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), consumptionUom: z.enum(UOMS) })

export const labelLinesView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), ppe: z.boolean(), brand: output({ id: id(), name: z.string() }).nullable() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.string(), version: z.number().int(), editable: z.boolean() }),
  /** The brand's ACTIVE branding set the packaging rules come from (null: none). */
  brandingSet: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  plan: z.array(
    output({
      action: z.enum(LINE_ACTIONS),
      sourceKey: z.string(),
      source: z.enum(LINE_SOURCES).nullable(),
      words: z.string().nullable(),
      section: z.enum(LINE_SECTIONS).nullable(),
      per: z.enum(PACKAGING_PER).nullable(),
      template: output({ id: id(), code: z.string(), revision: z.number().int(), kind: z.string() }).nullable(),
      line: lineRef.nullable(),
      next: output({ itemId: id(), qty: z.string(), uom: z.enum(UOMS), section: z.enum(LINE_SECTIONS) }).nullable(),
      material: material.nullable(),
      changes: z.array(z.enum(['itemId', 'qty', 'section'])),
      why: z.enum(['RULE_GONE', 'DUPLICATE']).nullable(),
      held: z.string().nullable(),
    }),
  ),
  /** Rules that make no BOM line: in words only, or per pack or carton (packing counts them). */
  inWords: z.array(output({ sourceKey: z.string(), words: z.string(), why: z.enum(['NO_MATERIAL', 'PER_PACK', 'PER_CARTON']) })),
  /** Materials a compliance line may take (LABEL or PACKAGING, counted in pieces, of the style's company or tenant-wide). */
  candidates: z.array(material),
  /** Lines the refresh would add, change or remove now. */
  changes: z.number().int(),
})
export type LabelLinesView = z.infer<typeof labelLinesView>

const linesParams = input({ styleId: id(), revisionId: id() })

export const labelLinesReadContract = defineContract({ params: linesParams, response: { 200: output({ lines: labelLinesView }) } })

export const labelLinesRefreshContract = defineContract({
  params: linesParams,
  body: input({
    version: z.number().int().min(1),
    /** The material a compliance rule's line takes (sourceKey → item id), for a line not made yet or to change it. */
    materials: z.record(z.string().min(1).max(120), id()).optional(),
  }),
  response: { 200: output({ lines: labelLinesView, applied: z.array(output({ action: z.enum(LINE_ACTIONS), sourceKey: z.string(), lineId: id() })) }) },
})

// ---- the label reconciliation (MES-140) -------------------------------------------------------------------------------

const counted = { printed: z.number().int(), used: z.number().int(), spoiled: z.number().int(), returned: z.number().int(), difference: z.number().int() }

export const reconciliationView = output({
  workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status: z.string() }),
  tracking: z.enum(['BATCH', 'SERIAL']),
  cells: z.array(output({ workOrderSizeId: id(), colourwayCode: z.string(), size: z.string(), ...counted, balanced: z.boolean(), words: z.string() })),
  /** Labels counted, never money. */
  total: notMoney(output(counted)),
  balanced: z.boolean(),
  /** The spoiled and returned labels logged, newest first (never who). */
  entries: z.array(output({ id: id(), workOrderSizeId: id(), kind: z.enum(SPOIL_KINDS), quantity: z.number().int(), reason: z.string().nullable(), at: instant() })),
  /** Office only: the label artwork the work order's labels follow (null: none was approved at its first print, or the floor). */
  artwork: output({ id: id(), versionNo: z.number().int(), approvedAt: instant().nullable() }).nullable(),
  /** Whether the company's requirements hold the final release on a difference (a requirement with check label.reconciliation). */
  holdsRelease: z.boolean(),
})
export type ReconciliationView = z.infer<typeof reconciliationView>

export const reconciliationContract = defineContract({ params: input({ workOrderId: id() }), response: { 200: output({ reconciliation: reconciliationView }) } })

export const spoiledContract = defineContract({
  params: input({ workOrderId: id() }),
  body: input({
    workOrderSizeId: id(),
    kind: z.enum(SPOIL_KINDS),
    quantity: z.number().int().min(1).max(SPOIL_MAX),
    /** SPOILED: why, in words (3 to 200 characters); RETURNED: optional. */
    reason: z.string().max(SPOIL_REASON_MAX).nullable().optional(),
  }),
  response: { 201: output({ reconciliation: reconciliationView, replayed: z.boolean() }), 200: output({ reconciliation: reconciliationView, replayed: z.boolean() }) },
})
