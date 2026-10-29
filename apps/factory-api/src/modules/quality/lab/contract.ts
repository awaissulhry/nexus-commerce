import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CR_VI_STATUSES } from '@nexus/factory-domain/planning/usable'
import {
  CHECK_CODES,
  CR_VI_EVIDENCE,
  CR_VI_METHODS,
  EVIDENCE_RULES,
  LAB_LIMITS,
  LAB_TESTS,
  LOT_DOCUMENT_KINDS,
  SETTING_SOURCES,
} from '@nexus/factory-domain/quality/lab/rules'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The lab step (B-W1-34; QHS-029, QHS-030, SCM-117, QHS-073; A2 SCR-054, SCR-075): a lot's chromium VI results with their
 * reports, its supplier documents, the release checklist, the decisions, and the Cr VI evidence rule (Q14). mg/kg values
 * are decimal strings with three decimals. No money here.
 */

const version = z.number().int().min(1)
const text = (max: number = LAB_LIMITS.text) => z.string().trim().max(max)
const mgKg = z.string().trim().max(12)
const lotStatus = z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED'])
const lotParams = input({ lotId: id() })

const upload = input({
  originalName: z.string().min(1).max(500),
  /** A PDF, or a scan (JPEG, PNG): the CERTIFICATE kind's types. */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  sha256: z.string(),
})

const fileRef = output({ id: id(), originalName: z.string(), status: z.string() }).nullable()

const checkView = output({ code: z.enum(CHECK_CODES), state: z.enum(['OK', 'OPEN', 'NOT_NEEDED']), words: z.string(), fix: z.string().nullable() })
const checklistView = output({ mode: z.enum(['RELEASE', 'UNBLOCK']), checks: z.array(checkView), open: z.array(checkView), ready: z.boolean(), words: z.string() })

const lotView = output({
  id: id(),
  code: z.string(),
  companyId: id(),
  siteId: id(),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), isPpeComponent: z.boolean() }),
  itemColourId: id().nullable(),
  supplierId: id().nullable(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
  receivedAt: instant().nullable(),
  /** Who received it (the person who may not release it). */
  receivedById: id().nullable(),
  receipt: output({ id: id(), number: z.string(), status: z.enum(['OPEN', 'POSTED', 'REVERSED', 'CANCELLED']) }).nullable(),
  qualityStatus: lotStatus,
  qualityNote: z.string().nullable(),
  qualityDecidedAt: instant().nullable(),
  qualityDecidedById: id().nullable(),
  /** The receiver's hold while in quarantine (cleared by the quality role). */
  hold: z.string().nullable(),
  crVi: output({
    required: z.boolean(),
    status: z.enum(CR_VI_STATUSES),
    limitMgKg: z.string().nullable(),
    /** null with a PASS: not detected (below the detection limit). */
    valueMgKg: z.string().nullable(),
    evidence: z.enum(CR_VI_EVIDENCE).nullable(),
    testedOn: businessDate().nullable(),
  }),
  words: z.string(),
  version: z.number().int(),
})

const resultView = output({
  id: id(),
  lotId: id(),
  companyId: id(),
  siteId: id(),
  itemId: id(),
  test: z.enum(LAB_TESTS),
  method: z.enum(CR_VI_METHODS),
  valueMgKg: z.string().nullable(),
  belowDetectionLimit: z.boolean(),
  detectionLimitMgKg: z.string().nullable(),
  unit: z.literal('mg/kg'),
  limitMgKg: z.string(),
  verdict: z.enum(['PASS', 'FAIL']),
  lab: z.string(),
  reportNumber: z.string().nullable(),
  testedOn: businessDate(),
  evidence: z.enum(CR_VI_EVIDENCE),
  article: z.string().nullable(),
  periodFrom: businessDate().nullable(),
  periodTo: businessDate().nullable(),
  fileId: id(),
  supersedesId: id().nullable(),
  note: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  /** The verdict in words: "PASS: 1.2 mg/kg is below the limit of 3 mg/kg." */
  words: z.string(),
})
const listedResult = resultView.extend({ file: fileRef, superseded: z.boolean() })

const documentView = output({
  id: id(),
  lotId: id(),
  companyId: id(),
  siteId: id(),
  itemId: id(),
  kind: z.enum(LOT_DOCUMENT_KINDS),
  fileId: id(),
  validTo: businessDate().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  note: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
})
const listedDocument = documentView.extend({ file: fileRef, inForce: z.boolean() })

const workOrderUse = output({
  workOrderId: id(),
  number: z.string().nullable(),
  batchNumber: z.string().nullable(),
  status: z.string().nullable(),
  issued: z.string(),
  returned: z.string(),
  atWorkOrder: z.string(),
  hideIds: z.array(id()),
})

const ruleView = output({ crViEvidenceRule: z.enum(EVIDENCE_RULES), source: z.enum(SETTING_SOURCES), words: z.string() })

export const getLotContract = defineContract({
  params: lotParams,
  response: { 200: output({ lot: lotView, rule: ruleView, results: z.array(listedResult), documents: z.array(listedDocument), checklist: checklistView }) },
})

export const releaseCheckContract = defineContract({
  params: lotParams,
  response: { 200: output({ lot: output({ id: id(), code: z.string(), qualityStatus: lotStatus, version: z.number().int() }), checklist: checklistView }) },
})

export const announceReportContract = defineContract({ params: lotParams, body: upload, response: { 201: output({ file: fileView, upload: presignedView }) } })

export const recordResultContract = defineContract({
  params: lotParams,
  body: input({
    /** The lot's version as read (edit-conflict guard). */
    version,
    test: z.enum(LAB_TESTS),
    method: z.string().trim().max(40),
    /** The measured content, mg/kg (at most three decimals); or belowDetectionLimit with detectionLimitMgKg. */
    valueMgKg: mgKg.nullish(),
    belowDetectionLimit: z.boolean().optional(),
    detectionLimitMgKg: mgKg.nullish(),
    lab: text(),
    reportNumber: text().nullish(),
    testedOn: z.string().trim().max(10),
    evidence: z.enum(CR_VI_EVIDENCE),
    /** A supplier report: the article it covers and its period (both days included). */
    article: text().nullish(),
    periodFrom: z.string().trim().max(10).nullish(),
    periodTo: z.string().trim().max(10).nullish(),
    note: text(LAB_LIMITS.note).nullish(),
    /** The report: announced with …/results/report and sent; or a supplier report already recorded for a lot of the same article. */
    fileId: id(),
  }),
  response: {
    201: output({
      result: resultView,
      effect: z.string(),
      lot: lotView,
      checklist: checklistView,
      /** A later FAIL that blocked a released lot: the work orders it went to. */
      trace: output({
        law: z.string(),
        workOrders: z.array(workOrderUse),
        /** The PPE register entry of the garments made from it (when its stock went to work orders), or why none. */
        register: output({ opened: z.boolean(), entryId: id().nullable(), reference: z.string().nullable(), shippedGoods: z.boolean().nullable(), words: z.string() }).nullable(),
      }).nullable(),
    }),
  },
})

export const listResultsContract = defineContract({ params: lotParams, response: { 200: output({ results: z.array(listedResult) }) } })

export const announceDocumentContract = defineContract({ params: lotParams, body: upload, response: { 201: output({ file: fileView, upload: presignedView }) } })

export const attachDocumentContract = defineContract({
  params: lotParams,
  body: input({ fileId: id(), kind: z.enum(LOT_DOCUMENT_KINDS), validTo: z.string().trim().max(10).nullish(), note: text(LAB_LIMITS.note).nullish() }),
  response: { 201: output({ document: documentView, documents: z.array(listedDocument), checklist: checklistView }) },
})

export const listDocumentsContract = defineContract({ params: lotParams, response: { 200: output({ documents: z.array(listedDocument) }) } })

const decided = output({ lot: lotView, checklist: checklistView })
const reason = z.string().trim().max(LAB_LIMITS.note)

export const releaseContract = defineContract({
  params: lotParams,
  body: input({ version, /** The lot's code, typed to confirm. */ confirmCode: z.string().max(80), note: text(LAB_LIMITS.note).nullish() }),
  response: { 200: decided },
})
export const rejectContract = defineContract({ params: lotParams, body: input({ version, confirmCode: z.string().max(80), reason }), response: { 200: decided } })
export const blockContract = defineContract({ params: lotParams, body: input({ version, reason }), response: { 200: decided.extend({ trace: output({ workOrders: z.array(workOrderUse) }) }) } })
export const unblockContract = defineContract({ params: lotParams, body: input({ version, reason }), response: { 200: decided } })
export const clearHoldContract = defineContract({ params: lotParams, body: input({ version, reason }), response: { 200: decided } })

const settingsView = output({
  companyId: id().nullable(),
  crViEvidenceRule: z.enum(EVIDENCE_RULES),
  source: z.enum(SETTING_SOURCES),
  words: z.string(),
  default: z.enum(EVIDENCE_RULES),
  legalLimitMgKg: z.string(),
  law: z.string(),
  version: z.number().int().min(0),
  updatedAt: instant().nullable(),
  updatedById: id().nullable(),
})

export const getSettingsContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: output({ settings: settingsView }) } })

export const saveSettingsContract = defineContract({
  body: input({
    /** null or left out: the tenant-wide rule. */
    companyId: id().nullable().optional(),
    crViEvidenceRule: z.enum(EVIDENCE_RULES),
    /** The version read (0: never saved). */
    version: z.number().int().min(0),
    /** Required when it loosens the rule. */
    reason: z.string().trim().max(LAB_LIMITS.note).nullish(),
  }),
  response: { 200: output({ settings: settingsView, previousRule: z.enum(EVIDENCE_RULES) }) },
})
