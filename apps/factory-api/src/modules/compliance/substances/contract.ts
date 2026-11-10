import { z } from 'zod'
import { NOT_APPLICABLE_WHY } from '@nexus/factory-domain/compliance/substances/evaluate'
import {
  DECLARATION_KINDS,
  EVIDENCE_KINDS,
  GROUP_CODE,
  LIMIT_BOUNDS,
  RULE_CODES,
  RULE_KEY,
  RULE_MATERIAL_KINDS,
  RULE_PRODUCT_TYPES,
  RULE_SOURCES,
  SUBSTANCE_LIMITS,
  SUBSTANCE_LISTS,
  SUBSTANCE_STATUSES,
  SUBSTANCE_TESTS,
  SUBSTANCE_UNITS,
} from '@nexus/factory-domain/compliance/substances/rules'
import { MARKET_CODE } from '@nexus/factory-domain/compliance/markets/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Restricted substances and their rules (B-W2b-250; PRD-318, PRD-320 … PRD-326, PRD-329; design compliance.tests ›
 * Substance list, Material profiles). CAS and EC numbers, names, lists, limits with their units, keys, codes, states and
 * counts; people by their name only where they switched a rule. No price, no cost, no lab price.
 */

const version = () => z.number().int().min(1)
const person = output({ id: id(), name: z.string() }).nullable()
const words = z.record(z.string().min(2).max(12), z.string().trim().min(1).max(SUBSTANCE_LIMITS.name))
const text = (max: number) => z.string().trim().min(1).max(max)
const statusFilter = z.enum([...SUBSTANCE_STATUSES, 'ALL'])
const marketCode = z.string().trim().max(40).regex(MARKET_CODE)

// ---- substances -------------------------------------------------------------------------------------------------------

const ruleRef = output({
  id: id(),
  key: z.string(),
  code: z.enum(RULE_CODES),
  name: z.string(),
  limitValue: z.string().nullable(),
  limitUnit: z.enum(SUBSTANCE_UNITS).nullable(),
  /** "mg/kg", "µg/cm²/week". */
  unitWords: z.string().nullable(),
  limitBound: z.enum(LIMIT_BOUNDS).nullable(),
  /** "at most 30 mg/kg". */
  limit: z.string(),
  materialKinds: z.array(z.string()),
  testMethod: z.string().nullable(),
  source: z.enum(RULE_SOURCES),
  /** "REACH Annex XVII entry 43", "Brand RSL: …". */
  sourceWords: z.string(),
  switchedOn: z.boolean(),
  status: z.enum(SUBSTANCE_STATUSES),
})

export const substanceView = output({
  id: id(),
  companyId: id().nullable(),
  casNumber: z.string().nullable(),
  ecNumber: z.string().nullable(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  groupCode: z.string().nullable(),
  lists: z.array(z.enum(SUBSTANCE_LISTS)),
  annexXviiEntries: z.array(z.string()),
  svhcListVersion: output({ id: id(), publishedOn: businessDate() }).nullable(),
  note: z.string().nullable(),
  status: z.enum(SUBSTANCE_STATUSES),
  /** The ACTIVE rules that restrict it (by its id or its group): the list's Limit, Unit, Material scope, Test method and Source. */
  rules: z.array(ruleRef),
  version: z.number().int(),
  updatedAt: instant(),
})

export const listSubstancesContract = defineContract({
  querystring: input({
    list: z.enum(SUBSTANCE_LISTS).optional(),
    group: z.string().trim().regex(GROUP_CODE).optional(),
    status: statusFilter.optional(),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  response: { 200: output({ substances: z.array(substanceView), more: z.boolean(), asOf: instant(), mayManage: z.boolean() }) },
})

const substanceParams = input({ substanceId: id() })
export const getSubstanceContract = defineContract({
  params: substanceParams,
  response: { 200: output({ substance: substanceView, declarationLines: z.number().int(), asOf: instant() }) },
})

const substanceFields = {
  casNumber: z.string().trim().max(20).nullable(),
  ecNumber: z.string().trim().max(20).nullable(),
  nameI18n: words.nullable(),
  groupCode: z.string().trim().max(40).nullable(),
  annexXviiEntries: z.array(z.string().trim().min(1).max(4)).max(20),
  svhcListVersionId: id().nullable(),
  note: text(SUBSTANCE_LIMITS.note).nullable(),
}

export const createSubstanceContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    name: text(SUBSTANCE_LIMITS.name),
    lists: z.array(z.enum(SUBSTANCE_LISTS)).min(1).max(SUBSTANCE_LISTS.length),
    casNumber: substanceFields.casNumber.optional(),
    ecNumber: substanceFields.ecNumber.optional(),
    nameI18n: substanceFields.nameI18n.optional(),
    groupCode: substanceFields.groupCode.optional(),
    annexXviiEntries: substanceFields.annexXviiEntries.optional(),
    svhcListVersionId: substanceFields.svhcListVersionId.optional(),
    note: substanceFields.note.optional(),
  }),
  response: { 200: output({ substance: substanceView }) },
})

export const editSubstanceContract = defineContract({
  params: substanceParams,
  body: input({
    version: version(),
    name: text(SUBSTANCE_LIMITS.name).optional(),
    lists: z.array(z.enum(SUBSTANCE_LISTS)).min(1).max(SUBSTANCE_LISTS.length).optional(),
    casNumber: substanceFields.casNumber.optional(),
    ecNumber: substanceFields.ecNumber.optional(),
    nameI18n: substanceFields.nameI18n.optional(),
    groupCode: substanceFields.groupCode.optional(),
    annexXviiEntries: substanceFields.annexXviiEntries.optional(),
    svhcListVersionId: substanceFields.svhcListVersionId.optional(),
    note: substanceFields.note.optional(),
    status: z.enum(SUBSTANCE_STATUSES).optional(),
  }),
  response: { 200: output({ substance: substanceView }) },
})

const added = output({ added: z.number().int(), kept: z.number().int() })
export const loadStarterContract = defineContract({
  body: input({}).optional(),
  response: { 200: output({ substances: added, rules: added, addedSubstances: z.array(z.string()), addedRules: z.array(z.string()) }) },
})

// ---- rules ------------------------------------------------------------------------------------------------------------

export const ruleView = ruleRef.extend({
  companyId: id().nullable(),
  nameI18n: z.record(z.string(), z.string()),
  substance: output({ id: id(), casNumber: z.string().nullable(), name: z.string(), status: z.enum(SUBSTANCE_STATUSES) }).nullable(),
  substanceGroup: z.string().nullable(),
  members: z.number().int(),
  productTypes: z.array(z.string()),
  marketCodes: z.array(z.string()),
  scopeNote: z.string().nullable(),
  evidence: z.enum(EVIDENCE_KINDS),
  exemptPpe: z.boolean(),
  exemptNaturalLeather: z.boolean(),
  customer: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  legalReference: z.string(),
  legalUrl: z.string().nullable(),
  offReason: z.string().nullable(),
  switchedAt: instant().nullable(),
  switchedBy: person,
  note: z.string().nullable(),
  test: z.enum(SUBSTANCE_TESTS).nullable(),
  declaration: z.enum(DECLARATION_KINDS),
  version: z.number().int(),
  updatedAt: instant(),
})

export const listRulesContract = defineContract({
  querystring: input({
    code: z.enum(RULE_CODES).optional(),
    source: z.enum(RULE_SOURCES).optional(),
    switchedOn: z.enum(['true', 'false']).optional(),
    status: statusFilter.optional(),
    customerPartyId: id().optional(),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  response: { 200: output({ rules: z.array(ruleView), asOf: instant(), mayManage: z.boolean() }) },
})

const ruleParams = input({ ruleId: id() })
export const getRuleContract = defineContract({
  params: ruleParams,
  response: {
    200: output({
      rule: ruleView,
      substances: z.array(output({ id: id(), casNumber: z.string().nullable(), ecNumber: z.string().nullable(), name: z.string(), status: z.enum(SUBSTANCE_STATUSES) })),
      testPlans: z.array(output({ id: id(), test: z.string(), frequency: z.string(), itemKind: z.string().nullable(), itemId: id().nullable(), marketCode: z.string().nullable(), switchedOn: z.boolean(), status: z.enum(SUBSTANCE_STATUSES) })),
      asOf: instant(),
    }),
  },
})

const ruleFields = {
  nameI18n: words.nullable(),
  substanceId: id().nullable(),
  substanceGroup: z.string().trim().max(40).nullable(),
  materialKinds: z.array(z.enum(RULE_MATERIAL_KINDS)).max(RULE_MATERIAL_KINDS.length),
  productTypes: z.array(z.enum(RULE_PRODUCT_TYPES)).max(RULE_PRODUCT_TYPES.length),
  marketCodes: z.array(marketCode).max(50),
  scopeNote: text(SUBSTANCE_LIMITS.scopeNote).nullable(),
  limitValue: z.string().trim().regex(/^\d{1,12}(\.\d{1,6})?$/).nullable(),
  limitUnit: z.enum(SUBSTANCE_UNITS).nullable(),
  limitBound: z.enum(LIMIT_BOUNDS).nullable(),
  testMethod: text(SUBSTANCE_LIMITS.testMethod).nullable(),
  exemptPpe: z.boolean(),
  exemptNaturalLeather: z.boolean(),
  source: z.enum(RULE_SOURCES),
  customerPartyId: id().nullable(),
  legalUrl: z.string().trim().max(SUBSTANCE_LIMITS.url).nullable(),
  note: text(SUBSTANCE_LIMITS.note).nullable(),
}
const optional = <T extends Record<string, z.ZodType>>(shape: T) => Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> }

export const createRuleContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    key: z.string().trim().regex(RULE_KEY),
    code: z.enum(RULE_CODES),
    name: text(SUBSTANCE_LIMITS.name),
    evidence: z.enum(EVIDENCE_KINDS),
    legalReference: text(SUBSTANCE_LIMITS.legalReference),
    switchedOn: z.boolean().optional(),
    offReason: text(SUBSTANCE_LIMITS.offReason).nullable().optional(),
    ...optional(ruleFields),
  }),
  response: { 200: output({ rule: ruleView }) },
})

export const editRuleContract = defineContract({
  params: ruleParams,
  body: input({
    version: version(),
    code: z.enum(RULE_CODES).optional(),
    name: text(SUBSTANCE_LIMITS.name).optional(),
    evidence: z.enum(EVIDENCE_KINDS).optional(),
    legalReference: text(SUBSTANCE_LIMITS.legalReference).optional(),
    status: z.enum(SUBSTANCE_STATUSES).optional(),
    ...optional(ruleFields),
  }),
  response: { 200: output({ rule: ruleView }) },
})

export const switchRuleContract = defineContract({
  params: ruleParams,
  body: input({ version: version(), on: z.boolean(), reason: z.string().trim().max(SUBSTANCE_LIMITS.offReason).nullable().optional() }),
  response: { 200: output({ rule: ruleView }) },
})

// ---- Candidate List versions ------------------------------------------------------------------------------------------

const listVersion = output({ id: id(), publishedOn: businessDate(), entryCount: z.number().int() })

export const versionView = output({
  id: id(),
  publishedOn: businessDate(),
  entryCount: z.number().int(),
  source: z.string(),
  sourceUrl: z.string().nullable(),
  note: z.string().nullable(),
  substancesAdded: z.number().int(),
  grewBy: z.number().int().nullable(),
  newest: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
})

export const listVersionsContract = defineContract({
  response: { 200: output({ versions: z.array(versionView), asOf: instant(), mayManage: z.boolean() }) },
})

export const createVersionContract = defineContract({
  body: input({
    publishedOn: businessDate(),
    entryCount: z.number().int().min(1).max(100_000),
    source: text(300),
    sourceUrl: z.string().trim().max(SUBSTANCE_LIMITS.url).nullable().optional(),
    note: text(SUBSTANCE_LIMITS.note).nullable().optional(),
  }),
  response: { 200: output({ version: versionView }) },
})

export const editVersionContract = defineContract({
  params: input({ versionId: id() }),
  body: input({ version: version(), note: text(SUBSTANCE_LIMITS.note).nullable() }),
  response: { 200: output({ version: versionView }) },
})

// ---- the evaluator ----------------------------------------------------------------------------------------------------

const asked = output({ requestId: id(), number: z.string(), dueOn: businessDate(), status: z.string() }).nullable()
const proof = z
  .discriminatedUnion('kind', [
    output({ kind: z.literal('TEST'), resultId: id(), lotId: id(), test: z.enum(SUBSTANCE_TESTS), verdict: z.enum(['PASS', 'FAIL']), testedOn: businessDate() }),
    output({ kind: z.literal('DECLARATION'), requestId: id(), number: z.string(), declaration: z.enum(DECLARATION_KINDS), validTo: businessDate().nullable() }),
  ])
  .nullable()

const verdict = output({
  ruleId: id(),
  key: z.string(),
  code: z.enum(RULE_CODES),
  name: z.string(),
  legalReference: z.string(),
  limit: z.string(),
  status: z.enum(['MET', 'FAILED', 'MISSING', 'NOT_APPLICABLE']),
  why: z.enum(NOT_APPLICABLE_WHY).nullable(),
  styleIds: z.array(id()),
  evidence: z.enum(EVIDENCE_KINDS),
  needs: output({ test: z.enum(SUBSTANCE_TESTS).nullable(), declaration: z.enum(DECLARATION_KINDS).nullable() }),
  metBy: z.enum(['TEST', 'DECLARATION']).nullable(),
  proof,
  asked,
  words: z.string(),
})

const substanceRef = output({ id: id(), casNumber: z.string().nullable(), name: z.string() })
const svhc = output({
  aboveThreshold: z.boolean().nullable(),
  substances: z.array(substanceRef),
  unnamed: z.array(z.string()),
  listVersion: listVersion.nullable(),
  newestVersion: listVersion.nullable(),
  current: z.boolean(),
  grewBy: z.number().int().nullable(),
  source: z.enum(['DECLARATION', 'PROFILE', 'NONE']),
  request: output({ requestId: id(), number: z.string() }).nullable(),
  asked,
})
const state = z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED'])
const use = output({ styleId: id(), code: z.string(), productType: z.string(), ppeCategory: z.string(), brandPartyId: id().nullable(), companyId: id().nullable() })

export const materialEvaluationContract = defineContract({
  params: input({ materialId: id() }),
  querystring: input({ marketCode: marketCode.optional() }),
  response: {
    200: output({
      material: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), companyId: id().nullable() }),
      uses: z.array(use),
      markets: z.array(z.string()),
      rules: z.array(verdict),
      applicableRuleIds: z.array(id()),
      testsNeeded: z.array(z.enum(SUBSTANCE_TESTS)),
      declarationsNeeded: z.array(z.enum(DECLARATION_KINDS)),
      svhc,
      state,
      stateReason: z.string().nullable(),
      profile: output({
        state,
        stateReason: z.string().nullable(),
        evaluatedAt: instant().nullable(),
        applicableRuleIds: z.array(id()),
        testsNeeded: z.array(z.enum(SUBSTANCE_TESTS)),
        declarationsNeeded: z.array(z.enum(DECLARATION_KINDS)),
        svhcAboveThreshold: z.boolean().nullable(),
        svhcListVersionId: id().nullable(),
        svhcSubstanceIds: z.array(id()),
        version: z.number().int(),
      }).nullable(),
      mayEvaluate: z.boolean(),
      asOf: instant(),
    }),
  },
})

export const evaluateMaterialsContract = defineContract({
  body: input({ itemIds: z.array(id()).min(1).max(100) }),
  response: {
    200: output({
      profiles: z.array(
        output({
          itemId: id(),
          code: z.string(),
          name: z.string(),
          state,
          previousState: state.nullable(),
          stateReason: z.string().nullable(),
          applicableRules: z.number().int(),
          testsNeeded: z.array(z.enum(SUBSTANCE_TESTS)),
          declarationsNeeded: z.array(z.enum(DECLARATION_KINDS)),
          svhcAboveThreshold: z.boolean().nullable(),
          changed: z.boolean(),
          version: z.number().int(),
        }),
      ),
      evaluatedAt: instant(),
    }),
  },
})

export const styleEvaluationContract = defineContract({
  params: input({ styleId: id() }),
  querystring: input({ revisionId: id().optional(), marketCode: marketCode.optional() }),
  response: {
    200: output({
      style: output({ id: id(), code: z.string(), name: z.string(), productType: z.string(), ppeCategory: z.string(), brandPartyId: id().nullable(), companyId: id().nullable() }),
      revision: output({ id: id(), revision: z.number().int(), status: z.string() }),
      markets: z.array(z.string()),
      components: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          placement: z.string().nullable(),
          role: z.enum(['LINE', 'ALTERNATE']),
          priority: z.number().int().nullable(),
          material: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }),
          rules: z.array(verdict),
          notApplicable: z.array(output({ ruleId: id(), key: z.string(), why: z.enum(NOT_APPLICABLE_WHY), words: z.string() })),
          testsNeeded: z.array(z.enum(SUBSTANCE_TESTS)),
          declarationsNeeded: z.array(z.enum(DECLARATION_KINDS)),
          state,
          stateReason: z.string().nullable(),
          svhc,
        }),
      ),
      summary: output({ materials: z.number().int(), blocked: z.number().int(), incomplete: z.number().int(), complete: z.number().int() }),
      svhc: output({
        article33: z.enum(['YES', 'NO', 'UNKNOWN']),
        substances: z.array(substanceRef),
        above: z.number().int(),
        none: z.number().int(),
        unknown: z.number().int(),
        stale: z.number().int(),
        newestVersion: listVersion.nullable(),
      }),
      asOf: instant(),
    }),
  },
})
