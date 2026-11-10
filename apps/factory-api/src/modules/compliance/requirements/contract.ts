import { z } from 'zod'
import { PPE_CATEGORIES } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { OPERATOR_ROLES } from '@nexus/factory-domain/compliance/operators/rules'
import {
  COMPLIANCE_GATES,
  FIX_PLACES,
  LEGAL_MAX,
  NAME_MAX,
  NOTE_MAX,
  OVERRIDE_DAYS_MAX,
  PRODUCT_TYPES,
  REASON_MAX,
  REQUIREMENT_KINDS,
  ROLES_MAX,
  WHO,
} from '@nexus/factory-domain/compliance/requirements/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Requirements (B-W2b-254; PRD-271, PRD-272; design compliance.settings › rm-gates, the gate matrix with its padlocks).
 * Codes, words, the law, scope, gates, who may override and for how long, the switch. No price, no cost, no person's figure.
 */

const version = () => z.number().int().min(1)
const person = output({ id: id(), name: z.string() }).nullable()
const words = z.record(z.string().min(2).max(12), z.string().trim().min(1).max(2000))
const gate = z.enum(COMPLIANCE_GATES)

export const requirementView = output({
  /** null: the built-in W1 requirement, before the gate first writes it. */
  id: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  /** null: every company's requirement. */
  companyId: id().nullable(),
  kind: z.enum(REQUIREMENT_KINDS),
  checkKey: z.string().nullable(),
  /** The check that computes it ('MANUAL': a person checks it). */
  check: z.string(),
  operatorRole: z.enum(OPERATOR_ROLES).nullable(),
  productTypes: z.array(z.enum(PRODUCT_TYPES)),
  productTypeProfileId: id().nullable(),
  ppeCategories: z.array(z.enum(PPE_CATEGORIES)),
  marketCode: z.string().nullable(),
  blocks: z.array(gate),
  /** The gates the law locks (a padlock: never unblocked, never overridden there). */
  lockedBlocks: z.array(gate),
  overrideRoleKeys: z.array(z.string()),
  overrideMaxDays: z.number().int(),
  legalReference: z.string(),
  regulation: output({ id: id(), label: z.string(), link: z.string().nullable() }).nullable(),
  explanationI18n: z.record(z.string(), z.string()),
  appliesFrom: businessDate().nullable(),
  appliesUntil: businessDate().nullable(),
  seq: z.number().int(),
  switchedOn: z.boolean(),
  offReason: z.string().nullable(),
  switchedAt: instant().nullable(),
  switchedBy: person,
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  who: z.enum(WHO),
  fixPlace: z.enum(FIX_PLACES),
  version: z.number().int(),
  updatedAt: instant().nullable(),
  builtIn: z.boolean(),
})

export const listRequirementsContract = defineContract({
  querystring: input({
    status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(),
    market: z.string().trim().min(2).max(40).optional(),
    gate: gate.optional(),
  }),
  response: { 200: output({ requirements: z.array(requirementView), asOf: instant(), mayManage: z.boolean() }) },
})

const cell = output({ gate, blocks: z.boolean(), locked: z.boolean() })
export const gateMatrixContract = defineContract({
  response: {
    200: output({
      gates: z.array(gate),
      rows: z.array(output({ requirement: requirementView, cells: z.array(cell), overrideRoleKeys: z.array(z.string()), overrideMaxDays: z.number().int(), mayLoosen: z.boolean() })),
      asOf: instant(),
      mayManage: z.boolean(),
    }),
  },
})

const codeParams = input({ code: z.string().trim().min(1).max(60) })
export const getRequirementContract = defineContract({ params: codeParams, response: { 200: output({ requirement: requirementView }) } })

const fields = {
  name: z.string().trim().min(1).max(NAME_MAX),
  nameI18n: words.nullable(),
  checkKey: z.string().trim().min(3).max(80).nullable(),
  operatorRole: z.enum(OPERATOR_ROLES).nullable(),
  productTypes: z.array(z.enum(PRODUCT_TYPES)).max(PRODUCT_TYPES.length),
  productTypeProfileId: id().nullable(),
  ppeCategories: z.array(z.enum(PPE_CATEGORIES)).max(PPE_CATEGORIES.length),
  marketCode: z.string().trim().min(2).max(40).nullable(),
  blocks: z.array(gate).max(COMPLIANCE_GATES.length),
  lockedBlocks: z.array(gate).max(COMPLIANCE_GATES.length),
  overrideRoleKeys: z.array(z.string().trim().min(2).max(60)).max(ROLES_MAX),
  overrideMaxDays: z.number().int().min(1).max(OVERRIDE_DAYS_MAX),
  legalReference: z.string().trim().min(1).max(LEGAL_MAX),
  regulationId: id().nullable(),
  explanationI18n: words.nullable(),
  appliesFrom: businessDate().nullable(),
  appliesUntil: businessDate().nullable(),
  seq: z.number().int().min(0).max(100000),
  note: z.string().trim().max(NOTE_MAX).nullable(),
}

export const createRequirementContract = defineContract({
  body: input({
    code: z.string().trim().min(1).max(60),
    companyId: id().nullable().optional(),
    kind: z.enum(REQUIREMENT_KINDS),
    name: fields.name,
    legalReference: fields.legalReference,
    nameI18n: fields.nameI18n.optional(),
    checkKey: fields.checkKey.optional(),
    operatorRole: fields.operatorRole.optional(),
    productTypes: fields.productTypes.optional(),
    productTypeProfileId: fields.productTypeProfileId.optional(),
    ppeCategories: fields.ppeCategories.optional(),
    marketCode: fields.marketCode.optional(),
    blocks: fields.blocks.optional(),
    lockedBlocks: fields.lockedBlocks.optional(),
    overrideRoleKeys: fields.overrideRoleKeys.optional(),
    overrideMaxDays: fields.overrideMaxDays.optional(),
    regulationId: fields.regulationId.optional(),
    explanationI18n: fields.explanationI18n.optional(),
    appliesFrom: fields.appliesFrom.optional(),
    appliesUntil: fields.appliesUntil.optional(),
    seq: fields.seq.optional(),
    note: fields.note.optional(),
    switchedOn: z.boolean().optional(),
    offReason: z.string().trim().min(3).max(REASON_MAX).optional(),
  }),
  response: { 201: output({ requirement: requirementView }) },
})

export const editRequirementContract = defineContract({
  params: codeParams,
  body: input({
    version: version(),
    kind: z.enum(REQUIREMENT_KINDS).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    name: fields.name.optional(),
    nameI18n: fields.nameI18n.optional(),
    checkKey: fields.checkKey.optional(),
    operatorRole: fields.operatorRole.optional(),
    productTypes: fields.productTypes.optional(),
    productTypeProfileId: fields.productTypeProfileId.optional(),
    ppeCategories: fields.ppeCategories.optional(),
    marketCode: fields.marketCode.optional(),
    blocks: fields.blocks.optional(),
    lockedBlocks: fields.lockedBlocks.optional(),
    overrideRoleKeys: fields.overrideRoleKeys.optional(),
    overrideMaxDays: fields.overrideMaxDays.optional(),
    legalReference: fields.legalReference.optional(),
    regulationId: fields.regulationId.optional(),
    explanationI18n: fields.explanationI18n.optional(),
    appliesFrom: fields.appliesFrom.optional(),
    appliesUntil: fields.appliesUntil.optional(),
    seq: fields.seq.optional(),
    note: fields.note.optional(),
  }),
  response: {
    200: output({
      requirement: requirementView,
      /** What the change made looser (each needed the step-up). */
      loosened: z.array(output({ code: z.string(), message: z.string() })),
    }),
  },
})

export const switchRequirementContract = defineContract({
  params: codeParams,
  body: input({ version: version(), on: z.boolean(), reason: z.string().trim().max(REASON_MAX).optional() }),
  response: { 200: output({ requirement: requirementView }) },
})

export const writeW1Contract = defineContract({
  response: { 200: output({ requirement: requirementView, created: z.boolean() }) },
})
