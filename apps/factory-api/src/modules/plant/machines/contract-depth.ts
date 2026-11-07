import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MACHINE_STATUSES } from '@nexus/factory-domain/plant/rules'
import { DOCUMENT_GROUPS } from '@nexus/factory-domain/plant/machines/documents'
import { HISTORY_MAX_DAYS } from '@nexus/factory-domain/plant/machines/history'
import { SETTABLE_STATUSES } from '@nexus/factory-domain/plant/machines/status'
import { MAX_TAG_COPIES, MAX_TAGS_AT_ONCE } from '@nexus/factory-domain/plant/machines/tag'
import { DUE_STATES } from '@nexus/factory-domain/plant/statutory/rules'
import { FILE_SCAN_STATUSES, FILE_STATUSES } from '../../../platform/files/rules'
import { presignedView } from '../../../platform/files/contract'
import { PRINT_JOB_STATUSES } from '../../../platform/print/rules'
import { machineOut } from '../contract'

/**
 * The routes of machines in depth (B-W2b-136; QHS-164, QHS-165, QHS-167; design plant.machines "Status wall", tiles "Checks
 * overdue" and "No CE declaration on file", columns "Next check", "CE on file", "Tag printed", record tabs "Documents & CE",
 * "Status & downtime", "Tag", pop-ups "Print QR tags" and "Change status"). No money anywhere here; no person in a status, a
 * history or a list (a print job and a file name nobody). A rule's refusal is a 409 with the issues `refusal/<CODE>`
 * (factory-domain plant/machines/status MACHINE_DEPTH_REFUSALS) and `fix`.
 */

const version = () => z.number().int().min(1)
const machineParams = input({ machineId: id() })
const words = z.record(z.string(), z.string())
const place = output({ id: id(), code: z.string(), name: z.string() })
const classOut = output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable() })
const csvIds = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.uuid()).max(200))

// ---- the register's depth: tiles and columns ----------------------------------------------------------------------------------

const tagOut = output({
  /** The newest label-printer job of the tag, if any. */
  state: z.enum(PRINT_JOB_STATUSES),
  jobId: id(),
  at: instant(),
  printedAt: instant().nullable(),
})

export const depthOut = output({
  id: id(),
  /** An available CE declaration of the machine (Documents & CE). */
  ceOnFile: z.boolean(),
  /** Available manuals. */
  manuals: z.number().int(),
  /** The soonest active statutory check plan of the machine (B-W2b-124), or null. */
  nextCheck: output({ planId: id(), nextDueOn: businessDate(), state: z.enum(DUE_STATES), days: z.number().int(), checkType: output({ code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words }) }).nullable(),
  /** The newest tag sent to a label printer; null: never (a sheet printed from the browser is not recorded). */
  tag: tagOut.nullable(),
})

export const depthContract = defineContract({
  querystring: input({ siteId: id().optional(), ids: csvIds.optional() }),
  response: {
    200: output({
      /** Over the caller's machines in use (one site when asked). */
      tiles: output({ checksOverdue: z.number().int(), noCe: z.number().int() }),
      machines: z.array(depthOut),
      today: businessDate(),
    }),
  },
})

export const NEEDS = ['CE', 'CHECKS'] as const

export const attentionContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    /** CE: no CE declaration on file; CHECKS: a statutory check overdue. */
    need: z.enum(NEEDS),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ machines: z.array(machineOut), nextCursor: id().nullable() }) },
})

// ---- the status wall -------------------------------------------------------------------------------------------------------

const wallMachine = output({
  id: id(),
  assetNumber: z.string(),
  siteCode: z.string(),
  class: classOut,
  station: place.nullable(),
  status: z.enum(MACHINE_STATUSES),
  statusSince: instant(),
  locked: z.boolean(),
})

export const wallContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      /** Lines in code order, then the machines that stand on no line; machines in asset number order. */
      lines: z.array(output({ line: place.nullable(), siteCode: z.string(), machines: z.array(wallMachine) })),
      counts: output({ RUNNING: z.number().int(), DOWN: z.number().int(), UNDER_MAINTENANCE: z.number().int(), DO_NOT_USE: z.number().int(), locked: z.number().int() }),
      truncated: z.boolean(),
      at: instant(),
    }),
  },
})

// ---- Change status --------------------------------------------------------------------------------------------------------

export const changeStatusContract = defineContract({
  params: machineParams,
  body: input({ version: version(), to: z.enum(SETTABLE_STATUSES), reason: z.string().max(500) }),
  response: { 200: output({ machine: machineOut, replayed: z.boolean() }) },
})

// ---- the status history ---------------------------------------------------------------------------------------------------

const eventOut = output({ id: id(), at: instant(), from: z.enum(MACHINE_STATUSES).nullable(), to: z.enum(MACHINE_STATUSES), reason: z.string().nullable() })

export const historyContract = defineContract({
  params: machineParams,
  querystring: input({ from: businessDate(), days: z.coerce.number().int().min(1).max(HISTORY_MAX_DAYS).default(7) }),
  response: {
    200: output({
      from: instant(),
      to: instant(),
      now: instant(),
      registeredAt: instant(),
      /** The status the machine had when the window starts (the last change before it), or null. */
      before: output({ status: z.enum(MACHINE_STATUSES), reason: z.string().nullable() }).nullable(),
      current: output({ status: z.enum(MACHINE_STATUSES), reason: z.string().nullable(), since: instant() }),
      /** The changes inside the window, oldest first. No person. */
      events: z.array(eventOut),
      /** The newest changes of the machine (at most 20), newest first: the reasons list. */
      latest: z.array(eventOut),
    }),
  },
})

// ---- Documents & CE --------------------------------------------------------------------------------------------------------

const documentOut = output({
  id: id(),
  group: z.enum(DOCUMENT_GROUPS),
  kind: z.string(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(FILE_STATUSES),
  scanStatus: z.enum(FILE_SCAN_STATUSES),
  /** Shared with the machine's site's tablets (art. 71: at hand where it works). */
  onTablets: z.boolean(),
  createdAt: instant(),
  availableAt: instant().nullable(),
  version: z.number().int(),
})

export const documentsContract = defineContract({
  params: machineParams,
  response: { 200: output({ documents: z.array(documentOut), ceOnFile: z.boolean(), canManage: z.boolean() }) },
})

export const announceDocumentContract = defineContract({
  params: machineParams,
  body: input({
    group: z.enum(DOCUMENT_GROUPS),
    kind: z.enum(['DOCUMENT', 'CERTIFICATE', 'PHOTO']),
    originalName: z.string().trim().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    sha256: z.string(),
    /** Share it with the machine's site's tablets (default yes). */
    onTablets: z.boolean().optional(),
  }),
  response: { 201: output({ document: documentOut, upload: presignedView }), 200: output({ document: documentOut, upload: presignedView }) },
})

const documentParams = machineParams.extend({ fileId: id() })

export const completeDocumentContract = defineContract({ params: documentParams, response: { 200: output({ document: documentOut }) } })

export const downloadDocumentContract = defineContract({ params: documentParams, response: { 200: output({ download: presignedView, fileName: z.string(), contentType: z.string() }) } })

export const removeDocumentContract = defineContract({
  params: documentParams,
  body: input({ version: version(), reason: z.string().trim().min(3).max(500) }),
  response: { 200: output({ removed: id() }) },
})

// ---- QR tags --------------------------------------------------------------------------------------------------------------

const printerOut = output({ id: id(), code: z.string(), name: z.string(), siteId: id(), siteCode: z.string(), labelWidthMm: z.number().int(), labelHeightMm: z.number().int(), dpi: z.number().int() })

export const tagPrintersContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ printers: z.array(printerOut) }) },
})

const jobOut = output({ machineId: id(), jobId: id(), printerId: id(), printerCode: z.string(), state: z.enum(PRINT_JOB_STATUSES), copies: z.number().int(), lastError: z.string().nullable(), at: instant(), printedAt: instant().nullable(), version: z.number().int() })

export const printTagsContract = defineContract({
  body: input({ printerId: id(), machineIds: z.array(z.uuid()).min(1).max(MAX_TAGS_AT_ONCE), copies: z.number().int().min(1).max(MAX_TAG_COPIES).default(1), language: z.enum(['it', 'en']).default('it') }),
  response: { 200: output({ jobs: z.array(jobOut), refused: z.array(output({ machineId: id(), assetNumber: z.string(), code: z.string(), message: z.string() })) }) },
})

export const tagJobsContract = defineContract({
  querystring: input({ ids: csvIds }),
  response: { 200: output({ jobs: z.array(jobOut) }) },
})
