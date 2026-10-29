import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DDT_FREIGHT, DDT_REASONS, DOCUMENT_LANGUAGES, REFERENCE_KINDS } from '@nexus/factory-domain/documents/model'
import { fileView, presignedView } from '../../../platform/files/contract'
import { oneShipment, statusSchema, transportBySchema } from '../views'

/**
 * The DDT routes (B-W1-47; LOG-054; DPR 472/1996; A2 SCR-067 Documents tab). A version is the SHIPMENT's version as
 * read (COL-078): the DDT itself never changes. No money anywhere: a DDT shows no price.
 */

const version = z.number().int().min(1).optional()
const shipmentParams = input({ shipmentId: id() })
const ddtParams = input({ ddtId: id() })

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
      workOrderSizeId: z.string(),
      salesOrderLineId: z.string(),
      size: z.string(),
      batchNumber: z.string().nullable(),
      serials: z.array(z.string()),
    }),
  ),
  documentRefs: z.array(output({ kind: z.enum(REFERENCE_KINDS), number: z.string(), date: z.string().nullable().optional() })),
  remarks: z.string().nullable(),
}

export const ddtSchema = output({
  id: id(),
  number: z.string(),
  /** LIVE, or CANCELLED (it keeps its number). */
  status: z.enum(['LIVE', 'CANCELLED']),
  ...printed,
  companyId: id(),
  siteId: id(),
  partyId: id(),
  shipmentId: id(),
  shipmentNumber: z.string(),
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
          shipmentId: id(),
          shipmentNumber: z.string(),
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
      /** needsDdt: a SHIPPED shipment travels without a live DDT until its replacement is issued. */
      shipment: shipmentState.extend({ needsDdt: z.boolean() }),
    }),
  },
})
