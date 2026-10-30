import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { DEFECT_CLASSES, DEFECT_LIMITS, DISPOSITION_FOLLOW_UPS, DISPOSITION_MOVES, DISPOSITION_OUTCOMES, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'

/**
 * The defect library and the disposition codes (B-W2a-26; QHS-001, QHS-005; design quality.defects SCR-079): the
 * library as a tree (category › defect) with how often each code is used, the pickers' read (office and floor), and the
 * writes, each with the version read and an Idempotency-Key. Words are checked in factory-domain quality/defects/rules
 * (answers in words at `body/<field>`); the lengths here only stop oversized bodies. An approval amount is the cost grain.
 */

const version = z.number().int().min(1)
const words = () => z.string().max(DEFECT_LIMITS.label * 2)
const labels = () => z.record(z.string().max(8), words().nullable())
const klass = z.enum(DEFECT_CLASSES)
const stage = z.enum(QUALITY_STAGES)

export const defectView = output({
  id: id(),
  parentId: id().nullable(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  pictureFileId: id().nullable(),
  /** A defect's default class; a category has none. */
  severity: klass.nullable(),
  zone: z.string().nullable(),
  stages: z.array(stage),
  needsDetail: z.boolean(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  /** How many inspection defects and NCRs name it (a category: its defects). A used code is retired, never deleted. */
  usedCount: z.number().int().min(0),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type DefectView = z.infer<typeof defectView>

export const categoryView = defectView.extend({ defects: z.array(defectView) })

export const libraryContract = defineContract({
  querystring: input({ active: z.enum(['true', 'false']).optional() }),
  response: {
    200: output({
      categories: z.array(categoryView),
      zones: z.array(output({ id: z.string(), it: z.string(), en: z.string() })),
      stages: z.array(stage),
      /** The starter set's codes the library does not have yet ("Start from the leather-apparel starter set"). */
      starterMissing: z.array(z.string()),
      canManage: z.boolean(),
    }),
  },
})

export const pickerContract = defineContract({
  querystring: input({ stage: stage.optional() }),
  response: {
    200: output({
      defects: z.array(
        output({
          id: id(),
          code: z.string(),
          category: output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string() }),
          labelIt: z.string(),
          labelEn: z.string(),
          labelI18n: z.record(z.string(), z.string()),
          icon: z.string().nullable(),
          colour: z.string().nullable(),
          pictureFileId: id().nullable(),
          severity: klass,
          zone: z.string().nullable(),
          needsDetail: z.boolean(),
        }),
      ),
    }),
  },
})

export const createDefectContract = defineContract({
  body: input({
    code: z.string().max(80),
    parentId: id().nullable().optional(),
    labelIt: words(),
    labelEn: words(),
    labelI18n: labels().optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(10).nullable().optional(),
    severity: klass.nullable().optional(),
    zone: z.string().max(40).nullable().optional(),
    stages: z.array(z.string().max(20)).max(10).optional(),
    needsDetail: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }),
  response: { 201: output({ defect: defectView }) },
})

export const editDefectContract = defineContract({
  params: input({ defectId: id() }),
  body: input({
    version,
    labelIt: words().optional(),
    labelEn: words().optional(),
    labelI18n: labels().optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(10).nullable().optional(),
    pictureFileId: id().nullable().optional(),
    severity: klass.nullable().optional(),
    zone: z.string().max(40).nullable().optional(),
    stages: z.array(z.string().max(20)).max(10).optional(),
    needsDetail: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
  }),
  response: { 200: output({ defect: defectView, retireWords: z.string().nullable() }) },
})

export const deleteDefectContract = defineContract({
  params: input({ defectId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: id(), code: z.string() }) },
})

export const starterContract = defineContract({
  body: input({}),
  response: { 200: output({ added: z.array(z.string()) }) },
})

// ---- disposition codes ---------------------------------------------------------------------------------------------

const outcome = z.enum(DISPOSITION_OUTCOMES)
const move = z.enum(DISPOSITION_MOVES)
const followUp = z.enum(DISPOSITION_FOLLOW_UPS)

export const dispositionView = output({
  id: id(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  outcome,
  /** The stock move a decision with it posts (null: none). */
  stockMoveReason: move.nullable(),
  /** The record it opens (null: none). */
  followUp: followUp.nullable(),
  reinspection: z.boolean(),
  /** The stock action in words (design: "Each outcome and the stock action it causes"). */
  stockAction: z.string(),
  approvalSeverity: klass.nullable(),
  /** Minor units of the company's currency: the cost grain (left out without money.cost). */
  approvalAmount: money.cost(z.number().int().nullable()),
  sortOrder: z.number().int(),
  active: z.boolean(),
  /** How many NCR decisions name it (a used code is set inactive, never deleted). */
  usedCount: z.number().int().min(0),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type DispositionView = z.infer<typeof dispositionView>

export const dispositionsContract = defineContract({
  response: {
    200: output({
      dispositions: z.array(dispositionView),
      /** What a new code of each outcome may move and open (the first is the default; null: none). */
      outcomes: z.array(output({ outcome, words: z.string(), moves: z.array(move.nullable()), followUps: z.array(followUp.nullable()), reinspection: z.boolean() })),
      standardMissing: z.array(z.string()),
      canManage: z.boolean(),
    }),
  },
})

export const createDispositionContract = defineContract({
  body: input({
    code: z.string().max(80),
    labelIt: words(),
    labelEn: words(),
    labelI18n: labels().optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(10).nullable().optional(),
    outcome,
    stockMoveReason: move.nullable().optional(),
    followUp: followUp.nullable().optional(),
    reinspection: z.boolean().optional(),
    approvalSeverity: klass.nullable().optional(),
    approvalAmount: money.cost(z.number().int().nullable()),
    sortOrder: z.number().int().optional(),
  }),
  response: { 201: output({ disposition: dispositionView }) },
})

export const editDispositionContract = defineContract({
  params: input({ dispositionId: id() }),
  body: input({
    version,
    labelIt: words().optional(),
    labelEn: words().optional(),
    labelI18n: labels().optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(10).nullable().optional(),
    reinspection: z.boolean().optional(),
    approvalSeverity: klass.nullable().optional(),
    approvalAmount: money.cost(z.number().int().nullable()),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
  }),
  response: { 200: output({ disposition: dispositionView }) },
})

export const standardDispositionsContract = defineContract({
  body: input({}),
  response: { 200: output({ added: z.array(z.string()) }) },
})
