import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { CLIENT_SCAN_ID } from '@nexus/factory-domain/production/scans/rules'
import { ACK_DUE, INSTRUCTION_ICONS, INSTRUCTION_LIMITS, MEDIA_KINDS, VERSION_STATUSES } from '@nexus/factory-domain/production/instructions/rules'
import { STEP_CODE } from '@nexus/factory-domain/production/checklists/rules'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * Work instructions (B-W2b-214; PRD-117, PRD-258, MES-110, MES-119). No field carries money. A person is named only where
 * the contract says so: an office user who wrote or approved a version; a worker only in the acknowledgements' `people`
 * (production.instructions.people, and the site's legal gate open: else `workerHidden`) and in the worker's own list. A
 * refusal by a rule is a 409 whose issues start with `refusal/<CODE>` (the message in words).
 */

const words = z.record(z.string(), z.string())
const status = z.enum(VERSION_STATUSES)
const mediaKind = z.enum(MEDIA_KINDS)
const person = output({ id: id(), name: z.string() })
const operationRef = output({ id: id(), code: z.string(), name: z.string() })
const styleRef = output({ id: id(), code: z.string(), name: z.string(), revisionId: id(), revision: z.number().int(), revisionStatus: z.string() })
const setting = output({
  seq: z.number().int(),
  machineClass: output({ code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable(),
  stitchType: z.string().nullable(),
  needle: z.string().nullable(),
  thread: z.string().nullable(),
  stitchesPerCm: z.string().nullable(),
  tension: z.string().nullable(),
  foot: z.string().nullable(),
  notes: z.string().nullable(),
})
const instructionParams = input({ instructionId: id() })
const versionParams = input({ instructionId: id(), versionId: id() })
const bundleQuery = { code: z.string().trim().min(1).max(64).optional(), bundleId: id().optional(), workOrderOperationId: id().optional() }

// ---- the office ------------------------------------------------------------------------------------------------------------

const listRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  status: z.string(),
  operation: operationRef,
  style: styleRef.nullable(),
  /** The version in force: its steps, media and languages (missing: the floor languages a step lacks), how many saw it (a count). */
  current: output({ versionId: id(), number: z.number().int(), publishedAt: instant().nullable(), steps: z.number().int(), media: z.number().int(), languages: z.array(z.string()), missingLanguages: z.array(z.string()), seen: z.number().int() }).nullable(),
  draft: output({ versionId: id(), number: z.number().int() }).nullable(),
  /** The released style revisions it is used on (1 for a revision's own). */
  usedIn: z.number().int(),
  updatedAt: instant(),
})

export const listContract = defineContract({
  querystring: input({ companyId: id().optional(), operationId: id().optional(), styleRevisionId: id().optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional(), q: z.string().max(80).optional() }),
  response: { 200: output({ instructions: z.array(listRow), truncated: z.boolean(), counts: output({ active: z.number().int(), archived: z.number().int(), drafts: z.number().int() }), canManage: z.boolean() }) },
})

const versionView = output({
  id: id(),
  number: z.number().int(),
  status,
  changeNote: z.string().nullable(),
  acknowledgementRequired: z.boolean(),
  author: person,
  approvedBy: person.nullable(),
  publishedAt: instant().nullable(),
  supersededAt: instant().nullable(),
  createdAt: instant(),
  steps: z.number().int(),
  media: z.number().int(),
  /** How many workers saw it: a count, never a name. */
  seen: z.number().int(),
  /** The row's version (edit-conflict guard of the version's writes). */
  version: z.number().int(),
})

const record = output({
  instruction: output({ id: id(), number: z.string(), companyId: id(), status: z.string(), version: z.number().int(), operation: operationRef, style: styleRef.nullable(), createdAt: instant(), updatedAt: instant() }),
  versions: z.array(versionView),
  currentVersionId: id().nullable(),
  draftVersionId: id().nullable(),
  /** The library operation's machine and stitch settings. */
  settings: z.array(setting),
  floorLanguages: z.array(z.string()),
  usedIn: z.array(output({ revisionId: id(), styleId: id(), styleCode: z.string(), styleName: z.string(), revision: z.number().int(), status: z.string() })),
  rights: output({ canManage: z.boolean(), canApprove: z.boolean(), canSeePeople: z.boolean(), approveHeld: z.string().nullable() }),
})

export const recordContract = defineContract({ params: instructionParams, response: { 200: record } })

export const createContract = defineContract({
  body: input({ companyId: id(), operationId: id(), styleRevisionId: id().nullable().optional(), copyVersionId: id().nullable().optional() }),
  response: { 201: record },
})

export const statusContract = defineContract({
  params: instructionParams,
  body: input({ version: z.number().int().min(1), reason: z.string().max(INSTRUCTION_LIMITS.reason).nullable().optional() }),
  response: { 200: record },
})

const stepView = output({
  id: id(),
  code: z.string(),
  sortOrder: z.number().int(),
  text: words,
  critical: z.boolean(),
  safety: words.nullable(),
  icon: z.string().nullable(),
  requiredTick: z.boolean(),
  missingLanguages: z.array(z.string()),
  media: z.array(output({ id: id(), fileId: id(), kind: mediaKind, sortOrder: z.number().int(), caption: words.nullable(), file: output({ originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string() }).nullable() })),
})

const versionAnswer = output({
  version: versionView,
  steps: z.array(stepView),
  /** What changed from the version compared with (the one before it, or ?compare=), step codes added, removed and changed. */
  comparedWith: output({ id: id(), number: z.number().int(), added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) }).nullable(),
})

export const versionContract = defineContract({ params: versionParams, querystring: input({ compare: id().optional() }), response: { 200: versionAnswer } })

export const draftContract = defineContract({
  params: instructionParams,
  body: input({ version: z.number().int().min(1), fromVersionId: id().nullable().optional(), changeNote: z.string().max(INSTRUCTION_LIMITS.changeNote).nullable().optional() }),
  response: { 201: versionAnswer },
})

const stepBody = input({
  code: z.string().regex(STEP_CODE, 'A step code is 1 to 40 capitals, digits, underscores or hyphens.'),
  text: words,
  critical: z.boolean().optional(),
  safety: words.nullable().optional(),
  icon: z.enum(INSTRUCTION_ICONS).nullable().optional(),
  requiredTick: z.boolean().optional(),
  media: z.array(input({ fileId: id(), kind: mediaKind, caption: words.nullable().optional() })).max(INSTRUCTION_LIMITS.mediaPerStep).optional(),
})

export const saveContract = defineContract({
  params: versionParams,
  body: input({ version: z.number().int().min(1), changeNote: z.string().max(INSTRUCTION_LIMITS.changeNote).nullable().optional(), acknowledgementRequired: z.boolean().optional(), steps: z.array(stepBody).max(INSTRUCTION_LIMITS.steps).optional() }),
  response: { 200: versionAnswer },
})

export const publishContract = defineContract({
  params: versionParams,
  body: input({ version: z.number().int().min(1) }),
  response: { 200: versionAnswer.extend({ superseded: output({ id: id(), number: z.number().int() }).nullable() }) },
})

export const discardContract = defineContract({
  params: versionParams,
  body: input({ version: z.number().int().min(1), reason: z.string().min(1).max(INSTRUCTION_LIMITS.reason) }),
  response: { 200: versionAnswer },
})

export const sheetContract = defineContract({ params: versionParams, querystring: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }), response: {} })


export const announceContract = defineContract({
  params: instructionParams,
  body: input({ kind: mediaKind, originalName: z.string().min(1).max(200), contentType: z.string().min(1).max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

export const completeContract = defineContract({ params: input({ instructionId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })

export const acknowledgementsContract = defineContract({
  params: instructionParams,
  response: {
    200: output({
      versions: z.array(output({ versionId: id(), number: z.number().int(), status, seen: z.number().int() })),
      /** The version in force: how many saw it per site, of how many hold the operation's skill there (counts, never names). */
      current: output({ versionId: id(), number: z.number().int(), acknowledgementRequired: z.boolean(), perSite: z.array(output({ siteId: id(), code: z.string(), name: z.string(), seen: z.number().int(), of: z.number().int() })) }).nullable(),
      /** A training record by name: production.instructions.people only (else null); a worker named only where the site's legal gate lets an office read name one. */
      people: output({
        rows: z.array(
          output({
            worker: person.nullable(),
            workerHidden: z.boolean(),
            site: output({ id: id(), code: z.string() }),
            holdsSkill: z.boolean(),
            lastSeen: output({ versionNumber: z.number().int(), at: instant(), locale: z.string(), way: z.enum(['FLOOR', 'PAPER']) }).nullable(),
            seenCurrent: z.boolean(),
          }),
        ),
      }).nullable(),
      canSeePeople: z.boolean(),
    }),
  },
})

export const paperContract = defineContract({
  params: versionParams,
  body: input({ workerId: id(), locale: z.string().regex(/^[a-z]{2}$/), acknowledgedAt: instant().optional() }),
  response: { 201: acknowledgementsContract.response[200] },
})

const typedRow = output({
  routingOperationId: id(),
  style: output({ id: id(), code: z.string(), name: z.string() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.string() }),
  step: output({ seq: z.number().int(), code: z.string(), operationId: id() }),
  steps: z.array(output({ code: z.string(), words: z.string(), requiredTick: z.boolean() })),
  /** The instruction this operation and revision has already (made by an earlier run, or by hand): left alone. */
  existing: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
})

export const typedContract = defineContract({
  querystring: input({ companyId: id(), language: z.string().max(12).optional() }),
  response: { 200: output({ rows: z.array(typedRow), toMake: z.number().int(), made: z.number().int() }) },
})

export const bringTypedContract = defineContract({
  body: input({ companyId: id(), language: z.string().max(12).optional() }),
  response: { 200: output({ made: z.array(output({ instructionId: id(), number: z.string(), versionId: id(), routingOperationId: id() })) }) },
})

// ---- the floor -------------------------------------------------------------------------------------------------------------

export const floorOperationContract = defineContract({
  querystring: input({ ...bundleQuery, language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional() }),
  response: {
    200: output({
      bundle: output({ id: id(), code: z.string(), quantity: z.number().int() }),
      workOrder: output({ id: id(), number: z.string() }),
      operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
      /** The language the steps are asked in (the worker's, or ?language=). */
      language: z.string(),
      instruction: output({
        id: id(),
        number: z.string(),
        /** For the work order's own style revision (else for every style). */
        forRevision: z.boolean(),
        version: output({ id: id(), number: z.number().int(), publishedAt: instant().nullable(), changeNote: z.string().nullable(), acknowledgementRequired: z.boolean() }),
        steps: z.array(
          output({
            code: z.string(),
            words: z.string(),
            /** The language the words are in: another than asked when the step lacks it. */
            shownIn: z.string().nullable(),
            critical: z.boolean(),
            safety: z.string().nullable(),
            icon: z.string().nullable(),
            requiredTick: z.boolean(),
            media: z.array(output({ id: id(), kind: mediaKind, caption: z.string().nullable() })),
          }),
        ),
      }).nullable(),
      settings: z.array(setting),
      /** `due`: FIRST (never seen) or CHANGED (a newer version than the one seen) opens the instruction before Start (MES-110). */
      acknowledgement: output({ due: z.enum(ACK_DUE).nullable(), seenAt: instant().nullable() }).nullable(),
    }),
  },
})

export const floorSpecContract = defineContract({
  querystring: input(bundleQuery),
  response: {
    200: output({
      bundle: output({ id: id(), code: z.string(), quantity: z.number().int(), part: z.string().nullable() }),
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), releasedAt: instant().nullable() }),
      style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable() }).nullable(),
      revision: output({ id: id(), revision: z.number().int(), status: z.string(), releasedAt: instant().nullable() }).nullable(),
      colourway: output({ code: z.string(), name: z.string() }).nullable(),
      /** The bundle's size and its measures (the size's body measures until graded garment specs come, B-W2b-224). */
      size: output({ code: z.string(), label: z.string().nullable(), measures: z.array(output({ point: z.string(), min: z.string().nullable(), max: z.string().nullable(), unit: z.string().nullable() })) }),
      /** The materials frozen for the bundle's cell, per garment, in BOM order; never a cost. */
      materials: z.array(output({ seq: z.number().int(), placement: z.string().nullable(), item: output({ code: z.string(), name: z.string(), nameI18n: words }), colour: output({ code: z.string(), name: z.string() }).nullable(), perGarment: z.string(), uom: z.string() })),
      label: output({ code: z.string(), name: z.string(), revision: z.number().int(), languages: z.array(z.string()) }).nullable(),
      operations: z.array(output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), current: z.boolean() })),
    }),
  },
})

export const seenBody = input({
  /** The tablet's id for the Seen (A1 §3.8): once, also from the offline queue. */
  clientEventId: z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.'),
  versionId: id(),
  /** The language it was shown in; default the worker's own. */
  locale: z.string().regex(/^[a-z]{2}$/).optional(),
  occurredAt: instant().optional(),
})

const seenAnswer = output({ acknowledgement: output({ id: id(), versionId: id(), versionNumber: z.number().int(), at: instant() }) })

export const seenContract = defineContract({ body: seenBody, response: { 200: seenAnswer, 201: seenAnswer } })

export const mineContract = defineContract({
  response: {
    200: output({
      /** The published versions waiting for this worker's Seen (My work's "New instructions N"). */
      due: z.array(output({ instructionId: id(), number: z.string(), forRevision: z.boolean(), operation: operationRef, versionId: id(), versionNumber: z.number().int(), publishedAt: instant().nullable(), reason: z.enum(ACK_DUE) })),
      /** What they saw, newest first (at most 50): their own training record. */
      seen: z.array(output({ instructionId: id(), number: z.string(), versionId: id(), versionNumber: z.number().int(), at: instant(), locale: z.string() })),
    }),
  },
})

export const floorMediaContract = defineContract({ params: input({ mediaId: id() }), response: { 200: output({ download: presignedView }) } })
