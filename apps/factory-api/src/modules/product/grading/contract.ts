import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { appliedGradeView, applyGradeBody, createRuleBody, gradePreviewBody, gradePreviewView, listRulesQuery, ruleRow, ruleStatusBody, ruleStepsBody, ruleView, updateRuleBody } from '@nexus/factory-domain/product/grading/contracts'

/** The grade rules' routes' contracts: the bodies and answers are factory-domain's product/grading/contracts. No money. */

const rule = input({ ruleId: id() })
const revision = input({ styleId: id(), revisionId: id() })
const one = { 200: output({ rule: ruleView }) }

export const listRulesContract = defineContract({ querystring: listRulesQuery, response: { 200: output({ rules: z.array(ruleRow), nextCursor: z.string().nullable(), count: z.number().int() }) } })
export const createRuleContract = defineContract({ body: createRuleBody, response: { 201: output({ rule: ruleView }) } })
export const getRuleContract = defineContract({ params: rule, response: one })
export const updateRuleContract = defineContract({ params: rule, body: updateRuleBody, response: one })
export const ruleStepsContract = defineContract({ params: rule, body: ruleStepsBody, response: one })
export const ruleStatusContract = defineContract({ body: ruleStatusBody, response: { 200: output({ rules: z.array(ruleRow) }) } })
export const scaleRulesContract = defineContract({ params: input({ scaleId: id() }), response: { 200: output({ rules: z.array(ruleRow) }) } })
export const previewGradeContract = defineContract({ params: revision, body: gradePreviewBody, response: { 200: output({ preview: gradePreviewView }) } })
export const applyGradeContract = defineContract({ params: revision, body: applyGradeBody, response: { 200: appliedGradeView } })
