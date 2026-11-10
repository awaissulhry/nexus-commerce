import { z } from 'zod'
import { PLAN_ITEM_KINDS, PLAN_STATUSES, RECORDED_TESTS, RESULT_EVIDENCE, TEST_FREQUENCIES } from '@nexus/factory-domain/compliance/test-plans/rules'
import { SUBSTANCE_TESTS } from '@nexus/factory-domain/compliance/substances/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * Test plan rules and the substance tests' results (B-W2b-256; PRD-309; design compliance.tests "Test plan rules (W2b)",
 * Record test result). Materials and kinds, tests, frequencies, markets, rules by key with their limits, lots by code,
 * values against their limits; people by their name where they switched a rule. No price, no lab price.
 */

const version = () => z.number().int().min(1)
const marketCode = z.string().trim().max(40)

const planView = output({
  id: id(),
  companyId: id().nullable(),
  itemKind: z.string().nullable(),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }).nullable(),
  test: z.enum(SUBSTANCE_TESTS),
  frequency: z.enum(TEST_FREQUENCIES),
  /** "every lot", "once a year". */
  frequencyWords: z.string(),
  marketCode: z.string().nullable(),
  substanceRule: output({ id: id(), key: z.string(), code: z.string(), name: z.string(), limit: z.string(), switchedOn: z.boolean(), status: z.string() }).nullable(),
  method: z.string().nullable(),
  switchedOn: z.boolean(),
  offReason: z.string().nullable(),
  switchedAt: instant().nullable(),
  switchedBy: output({ id: id(), name: z.string() }).nullable(),
  note: z.string().nullable(),
  status: z.enum(PLAN_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})

export const listPlansContract = defineContract({
  querystring: input({
    test: z.enum(SUBSTANCE_TESTS).optional(),
    itemKind: z.enum(PLAN_ITEM_KINDS).optional(),
    itemId: id().optional(),
    switchedOn: z.enum(['true', 'false']).optional(),
    status: z.enum([...PLAN_STATUSES, 'ALL']).optional(),
  }),
  response: { 200: output({ plans: z.array(planView), mayManage: z.boolean(), asOf: instant() }) },
})

export const createPlanContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    itemKind: z.enum(PLAN_ITEM_KINDS).nullable().optional(),
    itemId: id().nullable().optional(),
    test: z.enum(SUBSTANCE_TESTS),
    frequency: z.enum(TEST_FREQUENCIES),
    marketCode: marketCode.nullable().optional(),
    substanceRuleId: id().nullable().optional(),
    method: z.string().max(200).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    switchedOn: z.boolean().optional(),
    offReason: z.string().max(500).nullable().optional(),
  }),
  response: { 200: output({ plan: planView }) },
})

const planParams = input({ planId: id() })

export const editPlanContract = defineContract({
  params: planParams,
  body: input({
    version: version(),
    itemKind: z.enum(PLAN_ITEM_KINDS).nullable().optional(),
    itemId: id().nullable().optional(),
    test: z.enum(SUBSTANCE_TESTS).optional(),
    frequency: z.enum(TEST_FREQUENCIES).optional(),
    marketCode: marketCode.nullable().optional(),
    substanceRuleId: id().nullable().optional(),
    method: z.string().max(200).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    status: z.enum(PLAN_STATUSES).optional(),
  }),
  response: { 200: output({ plan: planView }) },
})

export const switchPlanContract = defineContract({ params: planParams, body: input({ version: version(), on: z.boolean(), reason: z.string().max(600).nullable().optional() }), response: { 200: output({ plan: planView }) } })

const resultFact = output({ resultId: id(), lotId: id(), test: z.enum(SUBSTANCE_TESTS), verdict: z.enum(['PASS', 'FAIL']), testedOn: businessDate(), recordedAt: z.string(), lotCode: z.string() })

const dueTest = output({
  planId: id(),
  test: z.enum(SUBSTANCE_TESTS),
  frequency: z.enum(TEST_FREQUENCIES),
  method: z.string().nullable(),
  marketCode: z.string().nullable(),
  substanceRuleId: id().nullable(),
  /** DUE: no result covers it; MET: a passing result covers it; FAILED: the covering result failed. */
  status: z.enum(['DUE', 'MET', 'FAILED']),
  result: resultFact.nullable(),
  coveredByOtherLot: z.boolean(),
  words: z.string(),
})

const lotParams = input({ lotId: id() })

export const lotDueContract = defineContract({
  params: lotParams,
  response: {
    200: output({
      lot: output({
        id: id(),
        code: z.string(),
        companyId: id(),
        siteId: id(),
        item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }),
        supplier: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
        arrivedOn: businessDate(),
        qualityStatus: z.string(),
      }),
      markets: z.array(z.string()),
      due: z.array(dueTest),
      results: z.array(
        output({
          resultId: id(),
          test: z.enum(SUBSTANCE_TESTS),
          verdict: z.enum(['PASS', 'FAIL']),
          value: z.string().nullable(),
          belowDetectionLimit: z.boolean(),
          detectionLimit: z.string().nullable(),
          unit: z.string(),
          limit: z.string(),
          method: z.string(),
          lab: z.string(),
          reportNumber: z.string().nullable(),
          testedOn: businessDate(),
          evidence: z.string(),
          fileId: id(),
          current: z.boolean(),
        }),
      ),
      mayRecord: z.boolean(),
      asOf: instant(),
    }),
  },
})

export const dueLotsContract = defineContract({
  querystring: input({ test: z.enum(SUBSTANCE_TESTS).optional(), siteId: id().optional() }),
  response: {
    200: output({
      lots: z.array(
        output({
          lot: output({ id: id(), code: z.string(), companyId: id(), siteId: id(), arrivedOn: businessDate(), qualityStatus: z.string() }),
          item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }),
          tests: z.array(output({ planId: id(), test: z.enum(SUBSTANCE_TESTS), frequency: z.enum(TEST_FREQUENCIES), status: z.enum(['DUE', 'MET', 'FAILED']), words: z.string() })),
        }),
      ),
      more: z.boolean(),
      counts: output({ lots: z.number().int(), due: z.number().int(), failed: z.number().int() }),
      asOf: instant(),
    }),
  },
})

export const announceReportContract = defineContract({
  params: lotParams,
  body: input({ originalName: z.string().min(1).max(500), contentType: z.string().min(1).max(200), sizeBytes: z.number().int().min(1), sha256: z.string() }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

export const recordResultContract = defineContract({
  params: lotParams,
  body: input({
    test: z.enum(RECORDED_TESTS),
    ruleId: id().nullable().optional(),
    method: z.string().max(200),
    /** The measured value in the rule's unit, up to 3 decimals ("8.5"). */
    valueMgKg: z.string().trim().max(12).nullable().optional(),
    belowDetectionLimit: z.boolean().optional(),
    detectionLimitMgKg: z.string().trim().max(12).nullable().optional(),
    lab: z.string().max(200),
    reportNumber: z.string().max(200).nullable().optional(),
    testedOn: businessDate(),
    evidence: z.enum(RESULT_EVIDENCE),
    article: z.string().max(200).nullable().optional(),
    periodFrom: businessDate().nullable().optional(),
    periodTo: businessDate().nullable().optional(),
    fileId: id(),
    note: z.string().max(500).nullable().optional(),
  }),
  response: {
    201: output({
      resultId: id(),
      verdict: z.enum(['PASS', 'FAIL']),
      /** "8.5 mg/kg against at most 30 mg/kg (rule REACH-XVII-43): pass." */
      words: z.string(),
      rule: output({ id: id(), key: z.string(), limit: z.string() }),
      /** The material's profile as the evaluator wrote it in the same command. */
      profile: output({ state: z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED']), stateReason: z.string().nullable() }).nullable(),
      at: instant(),
    }),
  },
})
