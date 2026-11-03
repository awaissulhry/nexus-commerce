import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LOCK_BY, SIGN_SAFE_BY } from '@nexus/factory-domain/plant/requests/lock'
import { ROUTING_LIMITS } from '@nexus/factory-domain/plant/requests/routing'
import { PLANT_LIMITS } from '@nexus/factory-domain/plant/rules'
import { fileView, presignedView } from '../../../platform/files/contract'
import { jobOut, machineOut, mediaOut, requestOut } from '../contract'

/**
 * The routes of the requests and jobs in depth (B-W2b-96; QHS-179, QHS-180, QHS-181, QHS-183, QHS-189, QHS-190). People:
 * `{ kind, id, name }` as every plant answer (a floor answer names nobody). A plant rule's refusal is a 409 with the issues
 * `refusal/<CODE>` (factory-domain plant/rules PLANT_REFUSALS or plant/requests/refusals DEPTH_REFUSALS) and `fix`.
 */

const version = () => z.number().int().min(1)
const requestParams = input({ requestId: id() })
const jobParams = input({ jobId: id() })
const minutes = () => z.number().int().min(ROUTING_LIMITS.minMinutes).max(ROUTING_LIMITS.maxMinutes)

// ---- progress (QHS-180) ----------------------------------------------------------------------------------------------------

/** The version read, optional: a step queued on a tablet is applied as it stands when it arrives (each is set once). */
const stepBody = input({ version: version().optional() })
const stepAnswer = output({ request: requestOut, machine: machineOut, replayed: z.boolean() })

export const onTheWayContract = defineContract({ params: requestParams, body: stepBody, response: { 200: stepAnswer } })
export const worksAgainContract = defineContract({ params: requestParams, body: stepBody, response: { 200: stepAnswer } })
export const floorAcknowledgeContract = defineContract({ params: requestParams, body: stepBody, response: { 200: stepAnswer } })

/** floor-sync kind plant.request.progress: the step and its request (the envelope's client event id keys it). */
export const queuedProgressBody = input({ requestId: id(), step: z.enum(['ACKNOWLEDGE', 'ON_THE_WAY', 'WORKS_AGAIN']), version: version().optional() })

// ---- the lock (QHS-183) ------------------------------------------------------------------------------------------------------

export const lockFromRequestContract = defineContract({
  params: requestParams,
  body: input({ version: version(), note: z.string().trim().min(1).max(PLANT_LIMITS.note).optional() }),
  response: { 201: output({ lock: requestOut, from: requestOut, joined: z.boolean(), machine: machineOut, replayed: z.boolean() }), 200: output({ lock: requestOut, from: requestOut, joined: z.boolean(), machine: machineOut, replayed: z.boolean() }) },
})

export const locksContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ locks: z.array(output({ machine: machineOut, request: requestOut, canSignSafe: z.boolean() })) }) },
})

// ---- duplicates and merge (QHS-181) --------------------------------------------------------------------------------------------

export const duplicatesContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      groups: z.array(
        output({
          machine: requestOut.shape.machine,
          /** Oldest first. */
          requests: z.array(requestOut),
          withinMinutes: z.number().int(),
          /** "3 requests on Lockstitch L2-07 in 20 min" (English; the screens have their own words). */
          words: z.string(),
          /** The machine's open job, else the request that locks the machine, else the oldest. */
          suggested: output({ kind: z.enum(['JOB', 'REQUEST']), job: output({ id: id(), number: z.string(), status: z.string() }).nullable(), requestId: id().nullable() }),
        }),
      ),
    }),
  },
})

export const mergeManyContract = defineContract({
  body: input({
    requests: z.array(input({ id: id(), version: version() })).min(1).max(50),
    /** Into this request (each becomes MERGED) … */
    intoId: id().optional(),
    /** … or into this open job of the machine (each becomes JOB_MADE). */
    intoJobId: id().optional(),
  }),
  response: { 200: output({ requests: z.array(requestOut), target: requestOut.nullable(), job: jobOut.nullable(), replayed: z.boolean() }) },
})

// ---- photos and voice notes (QHS-189) -------------------------------------------------------------------------------------------

const announceBody = {
  kind: z.enum(['PHOTO', 'AUDIO']),
  originalName: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  /** SHA-256 of the content, 64 lower-case hex digits. */
  sha256: z.string(),
}
const presigned = presignedView
const fileAnswer = fileView

export const announceRequestFileContract = defineContract({ params: requestParams, body: input(announceBody), response: { 201: output({ file: fileAnswer, upload: presigned }) } })
export const completeRequestFileContract = defineContract({ params: requestParams.extend({ fileId: id() }), response: { 200: output({ file: fileAnswer }) } })
export const announceJobFileContract = defineContract({
  params: jobParams,
  body: input({ ...announceBody, /** A photo before or after the work. */ category: z.enum(['BEFORE_WORK', 'AFTER_WORK']).nullable().optional() }),
  response: { 201: output({ file: fileAnswer, upload: presigned }) },
})
export const completeJobFileContract = defineContract({ params: jobParams.extend({ fileId: id() }), response: { 200: output({ file: fileAnswer }) } })
export const floorDownloadContract = defineContract({ params: input({ fileId: id() }), response: { 200: output({ download: presigned }) } })

// ---- the line lead confirms (QHS-180) -------------------------------------------------------------------------------------------

export const confirmJobContract = defineContract({ params: jobParams, body: input({ version: version().optional() }), response: { 200: output({ job: jobOut, machine: machineOut, replayed: z.boolean() }) } })

// ---- the floor's reads (QHS-180, QHS-179) ---------------------------------------------------------------------------------------

export const stationRequestsContract = defineContract({ response: { 200: output({ stationId: id().nullable(), requests: z.array(requestOut) }) } })

export const floorRequestContract = defineContract({
  params: requestParams,
  response: { 200: output({ request: requestOut, files: z.array(mediaOut), canAcknowledge: z.boolean(), canGo: z.boolean(), canConfirm: z.boolean() }) },
})

export const technicianQueueContract = defineContract({
  response: { 200: output({ requests: z.array(output({ request: requestOut, toMe: z.boolean(), canAcknowledge: z.boolean(), canGo: z.boolean() })) }) },
})

// ---- plant settings (QHS-179, QHS-183) -----------------------------------------------------------------------------------------

const named = output({ id: id(), name: z.string(), active: z.boolean() })
const ruleOut = output({
  id: id(),
  siteId: id(),
  seq: z.number().int(),
  machineClass: output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable(),
  target: output({ kind: z.enum(['TEAM', 'TECHNICIAN']), id: id(), name: z.string(), active: z.boolean() }),
  push: z.boolean(),
  escalateAfterMinutes: z.number().int().nullable(),
  escalateTo: named.nullable(),
  escalateAgainAfterMinutes: z.number().int().nullable(),
  escalateAgainTo: named.nullable(),
  active: z.boolean(),
  /** How many requests it routed (a rule that routed any is switched off, never deleted). */
  requests: z.number().int(),
  /** The worked example in words (English; the screens have their own words). */
  words: z.string(),
  version: z.number().int(),
  updatedAt: instant(),
})

export const listRoutingContract = defineContract({ querystring: input({ siteId: id() }), response: { 200: output({ siteId: id(), rules: z.array(ruleOut), canManage: z.boolean() }) } })

export const previewRoutingContract = defineContract({
  querystring: input({ siteId: id(), machineId: id().optional(), machineClassId: id().optional(), symptomId: id().optional() }),
  response: {
    200: output({
      rule: output({ id: id(), target: ruleOut.shape.target, escalateAfterMinutes: z.number().int().nullable(), escalateTo: named.nullable(), escalateAgainAfterMinutes: z.number().int().nullable(), escalateAgainTo: named.nullable() }).nullable(),
      words: z.string(),
    }),
  },
})

const ruleFields = {
  /** The class it is for; null: every class (the fallback). */
  machineClassId: id().nullable().optional(),
  /** Exactly one of a team of the site and a technician (an employee of the company). */
  teamId: id().nullable().optional(),
  technicianId: id().nullable().optional(),
  push: z.boolean().optional(),
  escalateAfterMinutes: minutes().nullable().optional(),
  escalateToId: id().nullable().optional(),
  escalateAgainAfterMinutes: minutes().nullable().optional(),
  escalateAgainToId: id().nullable().optional(),
  active: z.boolean().optional(),
  seq: z.number().int().min(0).max(ROUTING_LIMITS.seq).optional(),
}
const rulesAnswer = output({ rules: z.array(ruleOut), replayed: z.boolean() })

export const addRuleContract = defineContract({ body: input({ siteId: id(), ...ruleFields }), response: { 201: rulesAnswer, 200: rulesAnswer } })
export const changeRuleContract = defineContract({ params: input({ ruleId: id() }), body: input({ version: version(), ...ruleFields }), response: { 200: rulesAnswer } })
export const removeRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ outcome: z.enum(['DELETED', 'SWITCHED_OFF']), rules: z.array(ruleOut), replayed: z.boolean() }) },
})
export const orderRulesContract = defineContract({ body: input({ siteId: id(), rules: z.array(input({ id: id(), version: version() })).min(1).max(ROUTING_LIMITS.rules) }), response: { 200: rulesAnswer } })

const lockOut = output({
  siteId: id(),
  lockBy: z.enum(LOCK_BY),
  signSafeBy: z.enum(SIGN_SAFE_BY),
  hazardReportOnLock: z.boolean(),
  /** null: the site has no row yet (Owner answer H1's defaults). */
  version: z.number().int().nullable(),
  canManage: z.boolean(),
})

export const readLockContract = defineContract({ querystring: input({ siteId: id() }), response: { 200: lockOut } })
export const setLockContract = defineContract({
  body: input({
    siteId: id(),
    /** The version read; null when the site had no row (it is made). */
    version: z.number().int().min(1).nullable(),
    lockBy: z.enum(LOCK_BY).optional(),
    signSafeBy: z.enum(SIGN_SAFE_BY).optional(),
    hazardReportOnLock: z.boolean().optional(),
  }),
  response: { 200: lockOut.extend({ replayed: z.boolean() }) },
})
