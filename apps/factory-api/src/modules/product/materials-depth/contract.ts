import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import {
  approvalBody,
  materialApprovalsView,
  materialDepthView,
  materialParams,
  materialWhereUsedView,
  propertiesBody,
  revisionParams,
  whereUsedQuery,
} from '@nexus/factory-domain/product/materials-depth/contracts'

/** The materials-in-depth routes' contracts (B-W2b-238): the bodies and answers are factory-domain's product/materials-depth/contracts. */

const depth = { 200: output({ depth: materialDepthView }) }

export const readDepthContract = defineContract({ params: materialParams, response: depth })
export const setPropertiesContract = defineContract({ params: materialParams, body: propertiesBody, response: depth })
export const decideApprovalContract = defineContract({ params: materialParams, body: approvalBody, response: depth })
export const whereUsedContract = defineContract({ params: materialParams, querystring: whereUsedQuery, response: { 200: output({ whereUsed: materialWhereUsedView }) } })
export const materialApprovalsContract = defineContract({ params: revisionParams, response: { 200: output({ approvals: materialApprovalsView }) } })
