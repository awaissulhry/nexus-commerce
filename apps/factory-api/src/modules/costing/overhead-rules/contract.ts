import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  archiveOverheadRuleBody,
  createOverheadRuleBody,
  inForceQuery,
  inForceView,
  overheadRuleAnswer,
  overheadRulesAnswer,
  overheadRulesQuery,
  overheadRuleView,
  updateOverheadRuleBody,
} from '@nexus/factory-domain/costing/overhead-rules/contracts'
import { z } from 'zod'

/** The route contracts of the overhead absorption rules: the shapes are factory-domain's costing/overhead-rules/contracts (values money.cost). */

const rule = input({ ruleId: id() })

export const listOverheadRulesContract = defineContract({ querystring: overheadRulesQuery, response: { 200: overheadRulesAnswer } })
export const inForceContract = defineContract({ querystring: inForceQuery, response: { 200: inForceView } })
export const overheadRuleContract = defineContract({ params: rule, response: { 200: output({ rule: overheadRuleView, unverified: z.string() }) } })
export const createOverheadRuleContract = defineContract({ body: createOverheadRuleBody, response: { 201: overheadRuleAnswer } })
export const updateOverheadRuleContract = defineContract({ params: rule, body: updateOverheadRuleBody, response: { 200: overheadRuleAnswer } })
export const archiveOverheadRuleContract = defineContract({ params: rule, body: archiveOverheadRuleBody, response: { 200: overheadRuleAnswer } })
