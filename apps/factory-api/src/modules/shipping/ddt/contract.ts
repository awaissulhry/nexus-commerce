import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DDT_FREIGHT, DDT_REASONS, DOCUMENT_LANGUAGES, REFERENCE_KINDS } from '@nexus/factory-domain/documents/model'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { DDT_SOURCE_TYPES, MAX_OTHER_GOODS } from '@nexus/factory-domain/shipping/ddt/sources'
import { fileView, presignedView } from '../../../platform/files/contract'
import { oneShipment, statusSchema, transportBySchema } from '../views'

/**
 * The DDT routes (B-W1-47; LOG-054; DPR 472/1996; A2 SCR-067 Documents tab). A version is the SHIPMENT's version as
 * read (COL-078): the DDT itself never changes. No money anywhere: a DDT shows no price.
 *
 * B-W2a-17 (LOG-056): a DDT for another reason (no shipment: a source record's goods) has its own preview and issue
 * routes under /shipping/ddt-sources/:sourceType/:sourceId; the record, list, PDF and cancel routes take any DDT (a
 * source's has `shipmentId` null and its `source`; its version is the source's, checked and never bumped).
 */

const version = z.number().int().min(1).optional()
const shipmentParams = input({ shipmentId: id() })
const ddtParams = input({ ddtId: id() })
const sourceParams = input({ sourceType: z.enum(DDT_SOURCE_TYPES), sourceId: id() })

const addressInput = input({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  postalCode: z.string().trim().min(1).max(16),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().max(8).nullish(),
  country: z.string().regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 country code.'),
})

/**
 * What the office says on a DDT; everything else comes from the shipment (who carries the goods: its transportBy), its
 * order, its parcels and the company.
 */
const ddtRequest = input({
  version,
  /** Causale; default SALE. */
  reason: z.enum(DDT_REASONS).optional(),
  reasonText: z.string().trim().max(200).nullish(),
  /** The carrier's identity (the shipment's transportBy is CARRIER); default the shipment's carrier name. */
  carrier: input({ name: z.string().trim().max(200), address: addressInput.nullish(), vatNumber: z.string().trim().max(32).nullish() }).nullish(),
  /** When the transport starts, ISO 8601 with a zone; default now (a replacement: when the goods left). */
  startAt: z.string().trim().max(40).nullish(),
  /** Default: the site's default appearance (shipping settings). */
  appearance: z.string().trim().max(200).nullish(),
  netWeightKg: z.string().trim().max(24).nullish(),
  freight: z.enum(DDT_FREIGHT).nullish(),
  remarks: z.string().trim().max(1000).nullish(),
  /** For the office only; never printed. */
  internalNote: z.string().trim().max(2000).nullish(),
  /** The goods leave now: the shipment moves PACKED → SHIPPED in the same command (needs shipping.manage too). */
  ship: z.boolean().optional(),
})

const address = output({ line1: z.string(), line2: z.string().nullable().optional(), postalCode: z.string(), city: z.string(), province: z.string().nullable().optional(), country: z.string() })
const party = output({ name: z.string(), address: address.nullable(), vatNumber: z.string().nullable().optional(), fiscalCode: z.string().nullable().optional() })

/** What a DDT says (the frozen row's printed columns), without its number. */
const printed = {
  documentDate: businessDate(),
  reason: z.enum(DDT_REASONS),
  reasonText: z.string().nullable(),
  transportBy: transportBySchema,
  carrier: output({ name: z.string(), address: address.nullable().optional(), vatNumber: z.string().nullable().optional() }).nullable(),
  startAt: instant(),
  appearance: z.string(),
  packages: z.number().int(),
  grossWeightKg: z.string(),
  netWeightKg: z.string().nullable(),
  freight: z.enum(DDT_FREIGHT).nullable(),
  sender: party,
  recipient: party,
  destination: address.extend({ name: z.string().nullable().optional() }).nullable(),
  lines: z.array(
    output({
      seq: z.number().int(),
      code: z.string().nullable(),
      description: z.string(),
      quantity: z.string(),
      uom: z.string(),
      // A shipment's line names its work order cell, order line and size; a source's line (B-W2a-17) none of them.
      workOrderSizeId: z.string().nullable(),
      salesOrderLineId: z.string().nullable(),
      size: z.string().nullable(),
      batchNumber: z.string().nullable(),
      serials: z.array(z.string()),
      /** B-W2a-17: the source's line it carries (kit, claim or return line; the repair for its garment); null: typed. */
      sourceLineId: id().nullable().optional(),
    }),
  ),
  documentRefs: z.array(output({ kind: z.enum(REFERENCE_KINDS), number: z.string(), date: z.string().nullable().optional() })),
  remarks: z.string().nullable(),
}

/** B-W2a-17: the source record of a DDT for another reason. */
const sourceOf = output({ type: z.enum(DDT_SOURCE_TYPES), id: id(), number: z.string() })
/** The source as it is now: its status (a repair's stage) and version (checked, never bumped by a DDT). */
const sourceState = sourceOf.extend({ state: z.string(), version: z.number().int() })

export const ddtSchema = output({
  id: id(),
  number: z.string(),
  /** LIVE, or CANCELLED (it keeps its number). */
  status: z.enum(['LIVE', 'CANCELLED']),
  ...printed,
  companyId: id(),
  siteId: id(),
  partyId: id(),
  /** Null for a DDT for another reason (B-W2a-17), which names its `source` instead. */
  shipmentId: id().nullable(),
  shipmentNumber: z.string().nullable(),
  source: sourceOf.nullable(),
  numberSeriesId: id(),
  internalNote: z.string().nullable(),
  issuedAt: instant(),
  createdById: id().nullable(),
  cancellation: output({ id: id(), reason: z.string(), cancelledAt: instant(), createdById: id().nullable() }).nullable(),
  /** The stored PDF (FISCAL_ARCHIVE); null while it is not stored. */
  fileId: id().nullable(),
})

const shipmentState = output({ id: id(), number: z.string(), status: statusSchema, version: z.number().int() })

export const previewContract = defineContract({
  params: shipmentParams,
  body: ddtRequest,
  response: {
    200: output({
      draft: output(printed),
      /** Every reason it cannot be issued as it stands (state, fields, company, numbering); empty: it can. */
      problems: z.array(output({ path: z.string(), message: z.string() })),
      /** The number the company's DDT series would give it now: not reserved. */
      expectedNumber: z.string().nullable(),
      language: z.enum(DOCUMENT_LANGUAGES),
    }),
  },
})

export const previewPdfContract = defineContract({ params: shipmentParams, body: ddtRequest, response: {} })

export const issueContract = defineContract({
  params: shipmentParams,
  body: ddtRequest,
  response: {
    201: output({
      ddt: ddtSchema,
      shipment: shipmentState,
      /** The stored PDF; null when the file store failed after the DDT was issued (then pdfProblem says so). */
      file: fileView.nullable(),
      pdfProblem: z.string().nullable(),
    }),
  },
})

export const shipContract = defineContract({ params: shipmentParams, body: input({ version }), response: { 200: oneShipment } })

export const listDdtsContract = defineContract({
  querystring: input({
    shipmentId: id().optional(),
    /** B-W2a-17: one source record's DDTs; SHIPMENT or SOURCE: only shipments' or only sources' DDTs. */
    sourceType: z.enum(DDT_SOURCE_TYPES).optional(),
    sourceId: id().optional(),
    kind: z.enum(['SHIPMENT', 'SOURCE']).optional(),
    siteId: id().optional(),
    partyId: id().optional(),
    status: z.enum(['LIVE', 'CANCELLED']).optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      ddts: z.array(
        output({
          id: id(),
          number: z.string(),
          documentDate: businessDate(),
          status: z.enum(['LIVE', 'CANCELLED']),
          companyId: id(),
          siteId: id(),
          partyId: id(),
          recipientName: z.string(),
          shipmentId: id().nullable(),
          shipmentNumber: z.string().nullable(),
          source: sourceOf.nullable(),
          reason: z.enum(DDT_REASONS),
          transportBy: transportBySchema,
          packages: z.number().int(),
          grossWeightKg: z.string(),
          startAt: instant(),
          issuedAt: instant(),
          cancelledAt: instant().nullable(),
          fileId: id().nullable(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const getDdtContract = defineContract({ params: ddtParams, response: { 200: output({ ddt: ddtSchema }) } })

export const downloadPdfContract = defineContract({ params: ddtParams, response: { 200: output({ file: fileView, download: presignedView }) } })

export const printPdfContract = defineContract({ params: ddtParams, response: { 200: output({ file: fileView }), 201: output({ file: fileView }) } })

export const cancelDdtContract = defineContract({
  params: ddtParams,
  body: input({ version, reason: z.string().trim().min(1).max(500) }),
  response: {
    200: output({
      ddt: ddtSchema,
      /** needsDdt: a SHIPPED shipment travels without a live DDT until its replacement is issued. Null: a source's DDT. */
      shipment: shipmentState.extend({ needsDdt: z.boolean() }).nullable(),
      /** B-W2a-17, a source's DDT: the source now; needsDdt when its goods left (a replacement keeps their start). */
      source: sourceState.extend({ needsDdt: z.boolean() }).nullable(),
      /** DRAFT invoices whose lines still name the cancelled DDT (the money guards never issue them so), and the warning. */
      draftInvoiceIds: z.array(id()),
      warning: z.string().nullable(),
    }),
  },
})

// ---- B-W2a-17: a DDT for another reason ---------------------------------------------------------------------------------

/** What the office says on a source's DDT; the goods, the recipient and the place come from the source and its party. */
export const sourceRequest = input({
  /** The SOURCE's version as read: checked under its lock, never bumped. */
  version,
  /** Causale; default the source's first (WORK_ON_ACCOUNT, RETURN, REPAIR). */
  reason: z.enum(DDT_REASONS).optional(),
  reasonText: z.string().trim().max(200).nullish(),
  /** The source's lines that travel; default every one that may travel now (a repair: its garment, always). */
  lineIds: z.array(id()).max(500).optional(),
  /** Goods the source has no line for (cut pieces sent with a kit, accessories), as the office describes them. */
  otherGoods: z
    .array(input({ code: z.string().trim().max(64).nullish(), description: z.string().trim().max(300), quantity: z.string().trim().max(24), uom: z.enum(UOMS) }))
    .max(MAX_OTHER_GOODS)
    .optional(),
  /** Who carries the goods (required to issue). */
  transportBy: transportBySchema.optional(),
  carrier: input({ name: z.string().trim().max(200), address: addressInput.nullish(), vatNumber: z.string().trim().max(32).nullish() }).nullish(),
  /** ISO 8601 with a zone; default now (a replacement: when the cancelled DDT's goods left). */
  startAt: z.string().trim().max(40).nullish(),
  appearance: z.string().trim().max(200).nullish(),
  /** Numero colli, from 1, and the gross weight in kilograms (required to issue): typed, a source has no parcels. */
  packages: z.number().int().min(1).max(99_999).optional(),
  grossWeightKg: z.string().trim().max(24).optional(),
  netWeightKg: z.string().trim().max(24).nullish(),
  freight: z.enum(DDT_FREIGHT).nullish(),
  /** The place of delivery; default the party's pickup or delivery address; null: the recipient's own address. */
  destination: addressInput.extend({ name: z.string().trim().max(200).nullish() }).nullish(),
  remarks: z.string().trim().max(1000).nullish(),
  /** For the office only; never printed. */
  internalNote: z.string().trim().max(2000).nullish(),
})

const sourceLine = output({
  seq: z.number().int(),
  code: z.string().nullable(),
  description: z.string(),
  quantity: z.string(),
  uom: z.string(),
  sourceLineId: id().nullable(),
  batchNumber: z.string().nullable(),
  serials: z.array(z.string()),
})

/** What a source's DDT would say (the preview). */
const sourcePrinted = output({
  ...printed,
  lines: z.array(sourceLine),
  /** It replaces a cancelled DDT whose goods left: it keeps their start. */
  replacement: z.boolean(),
})

export const sourcePreviewContract = defineContract({
  params: sourceParams,
  body: sourceRequest,
  response: {
    200: output({
      draft: sourcePrinted,
      /** Every reason it cannot be issued as it stands (state, fields, company, numbering); empty: it can. */
      problems: z.array(output({ path: z.string(), message: z.string() })),
      expectedNumber: z.string().nullable(),
      language: z.enum(DOCUMENT_LANGUAGES),
      source: sourceState,
      /** The reasons this source's goods may travel for, the default first. */
      reasons: z.array(z.enum(DDT_REASONS)),
      /** Each of the source's goods: why it cannot travel now (held; null: it can) and the live DDT it travels with. */
      goods: z.array(
        output({
          sourceLineId: id(),
          seq: z.number().int(),
          code: z.string().nullable(),
          description: z.string(),
          quantity: z.string(),
          uom: z.string(),
          batchNumber: z.string().nullable(),
          serials: z.array(z.string()),
          held: z.string().nullable(),
          liveDdt: output({ id: id(), number: z.string() }).nullable(),
        }),
      ),
    }),
  },
})

export const sourcePreviewPdfContract = defineContract({ params: sourceParams, body: sourceRequest, response: {} })

export const sourceIssueContract = defineContract({
  params: sourceParams,
  body: sourceRequest,
  response: {
    201: output({
      ddt: ddtSchema,
      source: sourceState,
      /** Supplier claim lines that keep a cancelled DDT (their ddtId is set once); this DDT's lines name them. */
      claimLinesKeepingOldDdt: z.array(id()),
      file: fileView.nullable(),
      pdfProblem: z.string().nullable(),
    }),
  },
})
